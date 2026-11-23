"""Steady: a local, voice-guided reader.  Run with:  uv run app.py"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
import threading
import time
import webbrowser
from pathlib import Path

from flask import Flask, Response, abort, jsonify, request, send_from_directory

from reader import extract, langdetect
from reader.tts import ALL_KEYS, VOICES, VoiceStore

ROOT = Path(__file__).parent
DATA = Path(os.environ.get("STEADY_DATA", ROOT / "data"))
LIBRARY = DATA / "library"
FILES = DATA / "files"  # a copy of every imported file, so it can be re-read when the parser improves
LIBRARY.mkdir(parents=True, exist_ok=True)
FILES.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # the browser checks for a newer page each time
STARTED = int(time.time())  # Steady.app restarts the server if the code is newer than this
app.json.sort_keys = False
voices = VoiceStore(DATA / "voices")
save_lock = threading.RLock()  # held while a document is read, changed and saved
jobs: dict[str, dict] = {}  # import jobs: id -> {done, total, ocr, result | error}
PRON_FILE = DATA / "pronunciations.json"  # {lang: {word in lower case: {"word", "say"}}}


def load_pron() -> dict:
    try:
        return json.loads(PRON_FILE.read_text("utf8"))
    except (FileNotFoundError, ValueError):
        return {}


def apply_pron(words: list[str], lang: str) -> list[str]:
    """Swap words for how they should be said; punctuation around them is kept,
    and so is a possessive ending ("Weber's" uses the entry for "Weber")."""
    table = load_pron().get(lang) or {}
    if not table:
        return words
    out = []
    for w in words:
        lead, core, trail = re.match(r"^([\W_]*)(.*?)([\W_]*)$", w).groups()
        entry = table.get(core.lower())
        poss = re.match(r"(.+)(['’]s)$", core)
        if not entry and poss and (entry := table.get(poss.group(1).lower())):
            trail = poss.group(2) + trail
        out.append(lead + entry["say"] + trail if entry else w)
    return out


# ---------------------------------------------------------------- library

def doc_path(doc_id: str) -> Path:
    if not doc_id.isalnum():
        abort(404)
    return LIBRARY / f"{doc_id}.json"


def load_doc(doc_id: str) -> dict:
    p = doc_path(doc_id)
    if not p.exists():
        abort(404)
    return json.loads(p.read_text("utf8"))


def save_doc(doc: dict):
    with save_lock:
        p = doc_path(doc["id"])
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), "utf8")
        tmp.replace(p)


def summary(doc: dict) -> dict:
    total = sum(len(b["w"]) for b in doc["blocks"])
    b, w = doc.get("pos", [0, 0])
    done = sum(len(x["w"]) for x in doc["blocks"][:b]) + w
    return {
        "id": doc["id"], "title": doc["title"], "kind": doc["kind"], "lang": doc["lang"],
        "words": total, "progress": round(done / total, 4) if total else 0,
        "opened": doc.get("opened", doc["created"]),
        "bookmarks": doc.get("bookmarks", []),
        "via": doc.get("via") or "upload",
    }


def store(result: dict, doc_id: str, file_name: str | None = None) -> dict:
    """Save a freshly parsed document. If it was already in the library, keep the
    reading position, chosen language and dates."""
    with save_lock:  # the old copy must not change between reading it and saving over it
        p = LIBRARY / f"{doc_id}.json"
        old = json.loads(p.read_text("utf8")) if p.exists() else None
        text = " ".join(extract.word_text(w) for b in result["blocks"][:400] for w in b["w"])
        doc = {
            "id": doc_id, "title": result["title"], "kind": result["kind"],
            "source": result.get("source"), "lang": langdetect.detect(text),
            "blocks": result["blocks"], "notes": result.get("notes", []),
            "pos": [0, 0], "created": time.time(), "opened": time.time(),
            "parser": extract.PARSER_VERSION, "file": file_name, "hash": result.get("hash"),
            "named": bool(result.get("named")),
            "via": result.get("via") or "upload",  # where it was added from: upload, obsidian, raycast
        }
        if old:
            doc["hash"] = doc["hash"] or old.get("hash")
            doc["via"] = old.get("via") or doc["via"]  # it stays where it first came from
            if old.get("named") and not result.get("named"):  # re-read by a newer parser
                doc["title"], doc["named"] = old["title"], True
            doc["lang"] = old.get("lang", doc["lang"])
            doc["created"] = old.get("created", doc["created"])
            doc["file"] = file_name or old.get("file")
            b, w = old.get("pos", [0, 0])
            if b < len(doc["blocks"]):
                doc["pos"] = [b, min(w, len(doc["blocks"][b]["w"]) - 1)]
            doc["bookmarks"] = [m for m in old.get("bookmarks", []) if m["b"] < len(doc["blocks"])]
        save_doc(doc)
    return doc


def reparse(doc: dict) -> dict:
    """Re-read a document's original file if it was parsed by an older parser."""
    name = doc.get("file")
    if doc.get("parser", 1) >= extract.PARSER_VERSION or not name or not (FILES / name).exists():
        return doc
    try:
        result = extract.extract_file(FILES / name, name)
    except Exception:
        app.logger.exception("re-reading %s failed", name)
        return doc
    if not result["blocks"]:
        return doc
    return store(result, doc["id"], name)


# Started from Steady.app: stop by ourselves once no Steady tab has been open for this long.
IDLE_EXIT_MIN = float(os.environ.get("STEADY_IDLE_EXIT") or 0)
last_seen = time.time()


@app.before_request
def seen():
    global last_seen
    last_seen = time.time()


@app.get("/api/ping")  # open pages call this every minute
def ping():
    return jsonify(ok=True, started=STARTED)


@app.post("/api/quit")
def quit_app():
    """Stop the server (the Quit button). Answer first, then exit."""
    def stop():
        with save_lock:  # let any save in progress finish
            print("  Quit from the page: stopping.", flush=True)
            os._exit(0)
    threading.Timer(0.3, stop).start()
    return jsonify(ok=True)


# Steady's own window (the Safari web app) can't be sent a link, so Steady.app leaves the
# page to show here and the window picks it up when it comes to the front.
shown = {"hash": None, "at": 0.0}
shown_lock = threading.Lock()


@app.post("/api/show")
def show_later():
    h = str((request.get_json(silent=True) or {}).get("hash", "")).lstrip("#")
    if not re.fullmatch(r"(doc=[A-Za-z0-9]+(&at=\d+\.\d+)?)?", h):
        return jsonify(error="Not a Steady page."), 400
    with shown_lock:
        shown.update(hash=h, at=time.time())
    return jsonify(ok=True)


@app.post("/api/show/claim")
def show_claim():
    """The page to show ("" is the library), or null. Each request is given out once."""
    with shown_lock:
        h = shown["hash"] if time.time() - shown["at"] < 60 else None
        shown.update(hash=None, at=0.0)
    return jsonify(hash=h)


def exit_when_idle():
    while True:
        time.sleep(30)
        if time.time() - last_seen > IDLE_EXIT_MIN * 60:
            print("  No Steady page open for a while: stopping.", flush=True)
            os._exit(0)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/manifest.webmanifest")  # name, icon and window style for Safari's "Add to Dock"
def manifest():
    return send_from_directory(app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json")


summaries: dict[Path, tuple[float, dict]] = {}  # file -> (mtime, summary), so the library opens fast


def sender(name) -> str:
    """Which app added a document: the plugins say so; anything else was added in Steady."""
    return name if name in ("obsidian", "raycast") else "upload"


@app.get("/api/library")
def library():
    docs = []
    for p in LIBRARY.glob("*.json"):
        try:
            mtime = p.stat().st_mtime
            if summaries.get(p, (None,))[0] != mtime:
                summaries[p] = (mtime, summary(json.loads(p.read_text("utf8"))))
            docs.append(summaries[p][1])
        except Exception:
            continue
    docs.sort(key=lambda d: d["opened"], reverse=True)
    return jsonify(docs)


@app.post("/api/import")
def import_file():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file received."), 400
    data = f.read()
    content_hash = hashlib.sha1(data).hexdigest()[:16]
    # Optional, from the Obsidian and Raycast plugins: "key" keeps one library entry (and its
    # reading position) for a note that changes, and "title" names it.
    key = (request.form.get("key") or "").strip()
    title = (request.form.get("title") or "").strip()[:200]
    via = sender(request.form.get("from"))
    doc_id = hashlib.sha1(("key:" + key).encode()).hexdigest()[:16] if key else content_hash
    p = LIBRARY / f"{doc_id}.json"
    with save_lock:
        old = json.loads(p.read_text("utf8")) if p.exists() else None
        if (old and old.get("parser", 1) >= extract.PARSER_VERSION
                and (old.get("hash") or old["id"]) == content_hash):  # already up to date
            old["opened"] = time.time()
            if title:
                old["title"] = title
            save_doc(old)
            return jsonify(summary(old))
    filename = f.filename
    suffix = Path(filename).suffix.lower()
    tmp_path = FILES / f"{doc_id}.part{suffix}"
    tmp_path.write_bytes(data)
    job_id = uuid.uuid4().hex[:12]
    job = jobs[job_id] = {"done": 0, "total": 0, "ocr": False}

    def progress(done, total, ocr):
        job.update(done=done, total=total, ocr=ocr)

    def run():
        try:
            result = extract.extract_file(tmp_path, filename, progress)
            if not result["blocks"]:
                msg = "No text found in this file."
                if result.get("notes"):
                    msg += " " + " ".join(result["notes"])
                raise ValueError(msg)
            if title:
                result["title"], result["named"] = title, True
            result["hash"], result["via"] = content_hash, via
            name = f"{doc_id}{suffix}"
            tmp_path.replace(FILES / name)
            job["result"] = summary(store(result, doc_id, name))
        except ValueError as e:
            job["error"] = str(e)
        except Exception as e:
            app.logger.exception("import failed")
            job["error"] = f"Couldn't read this file ({type(e).__name__}: {e})."
        finally:
            tmp_path.unlink(missing_ok=True)

    threading.Thread(target=run, daemon=True).start()
    return jsonify(job=job_id)


@app.get("/api/import/<job_id>")
def import_status(job_id):
    job = jobs.get(job_id)
    if not job:
        abort(404)
    if "result" in job or "error" in job:
        jobs.pop(job_id, None)
    return jsonify(job)


@app.post("/api/import-url")
def import_url():
    body = request.json or {}
    url = body.get("url", "").strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        result = extract.extract_url(url)
    except Exception as e:
        return jsonify(error=f"Couldn't load that page ({e})."), 400
    if not result["blocks"]:
        return jsonify(error="No readable text found on that page."), 400
    result["via"] = sender(body.get("from"))
    doc_id = hashlib.sha1(url.encode()).hexdigest()[:16]
    return jsonify(summary(store(result, doc_id)))


@app.get("/api/doc/<doc_id>")
def get_doc(doc_id):
    with save_lock:
        doc = reparse(load_doc(doc_id))
        doc["opened"] = time.time()
        save_doc(doc)
    return jsonify(doc)


@app.post("/api/doc/<doc_id>/state")
def set_state(doc_id):
    body = request.json or {}
    with save_lock:
        doc = load_doc(doc_id)
        if "pos" in body:
            b, w = int(body["pos"][0]), int(body["pos"][1])
            if 0 <= b < len(doc["blocks"]):
                doc["pos"] = [b, max(0, min(w, len(doc["blocks"][b]["w"]) - 1))]
        if body.get("lang") in VOICES:
            doc["lang"] = body["lang"]
        save_doc(doc)
    return jsonify(ok=True)


@app.post("/api/doc/<doc_id>/bookmarks")
def bookmarks(doc_id):
    """{"add": {"b", "w", "t"}} or {"remove": at}. Returns the bookmarks, in reading order."""
    body = request.json or {}
    with save_lock:
        doc = load_doc(doc_id)
        marks = doc.setdefault("bookmarks", [])
        if "add" in body:
            b, w = int(body["add"]["b"]), int(body["add"]["w"])
            if not 0 <= b < len(doc["blocks"]):
                return jsonify(error="No such paragraph."), 400
            w = max(0, min(w, len(doc["blocks"][b]["w"]) - 1))
            if not any(m["b"] == b and m["w"] == w for m in marks):
                text = re.sub(r"\s+", " ", str(body["add"].get("t", ""))).strip()
                marks.append({"b": b, "w": w, "t": text[:2000], "at": int(time.time() * 1000)})
                marks.sort(key=lambda m: (m["b"], m["w"]))
        if "remove" in body:
            doc["bookmarks"] = marks = [m for m in marks if m["at"] != body["remove"]]
        save_doc(doc)
    return jsonify(marks)


@app.delete("/api/doc/<doc_id>")
def delete_doc(doc_id):
    p = doc_path(doc_id)
    if p.exists():
        name = json.loads(p.read_text("utf8")).get("file")
        if name:
            (FILES / name).unlink(missing_ok=True)
        p.unlink()
    return jsonify(ok=True)


# ---------------------------------------------------------------- voices

@app.get("/api/voices")
def list_voices():
    return jsonify(
        langs={k: langdetect.NAMES[k] for k in VOICES},
        voices=voices.status(),
        ocr=bool(extract.ocr_languages()),
    )


@app.post("/api/voices/<key>/install")
def install_voice(key):
    try:
        voices.install(key)
    except ValueError:
        abort(404)
    return jsonify(ok=True)


@app.post("/api/speak")
def speak():
    body = request.json or {}
    key = body.get("voice")
    words = [str(w) for w in body.get("words", [])][:400]
    if key not in ALL_KEYS:
        return jsonify(error="unknown voice"), 400
    if not words:
        return jsonify(error="nothing to say"), 400
    if not voices.installed(key):
        voices.install(key)
        return jsonify(error="voice-missing"), 409
    words = apply_pron(words, key.split("_")[0])
    r = voices.speak(key, words, float(body.get("rate", 1.0)))
    # plain WAV; the word timings travel in headers
    return Response(r["wav"], mimetype="audio/wav", headers={
        "X-Starts": json.dumps(r["starts"]), "X-Duration": str(r["duration"])})


@app.get("/api/pronunciations")
def get_pron():
    return jsonify(load_pron())


@app.post("/api/pronunciations")
def set_pron():
    body = request.json or {}
    lang = body.get("lang")
    word = re.sub(r"^[\W_]+|[\W_]+$", "", str(body.get("word", "")).strip())
    say = str(body.get("say", "")).strip()
    if lang not in VOICES or not word or " " in word:
        return jsonify(error="Enter a single word."), 400
    with save_lock:
        table = load_pron()
        entries = table.setdefault(lang, {})
        if say:
            entries[word.lower()] = {"word": word, "say": say}
        else:
            entries.pop(word.lower(), None)
        PRON_FILE.write_text(json.dumps(table, ensure_ascii=False, indent=1), "utf8")
    return jsonify(table)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "41737"))
    url = f"http://localhost:{port}"
    print(f"\n  Steady is running at {url}\n  (Ctrl+C to stop)\n")
    if IDLE_EXIT_MIN:
        threading.Thread(target=exit_when_idle, daemon=True).start()
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=host, port=port, threaded=True, debug=False)
