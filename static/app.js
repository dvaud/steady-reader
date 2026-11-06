"use strict";

const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
};
const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// Speech comes back as a WAV file, with the word timings in headers.
async function speakReq(voice, words, rate) {
  const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice, words, rate }) });
  if (!res.ok) {
    const err = new Error(((await res.json().catch(() => null)) || {}).error || res.statusText);
    err.status = res.status;
    throw err;
  }
  const starts = res.headers.get("X-Starts");
  if (starts === null) throw new Error("Steady was updated but an older copy is still running. Stop it and open Steady again.");
  return { blob: await res.blob(), starts: JSON.parse(starts), duration: +res.headers.get("X-Duration") };
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plain = (w) => (typeof w === "string" ? w : w.map((s) => s[0]).join(""));

/* ------------------------------------------------------------------ settings */

const WIDTHS = { narrow: "26em", medium: "34em", wide: "42em" };
const DEFAULTS = { theme: "auto", guide: "reveal", focus: "line", width: "medium", font: "serif", size: 22, rate: 1.0, muted: false, voices: {}, libSort: "recent" };
const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("steady.settings") || "{}"));
const saveSettings = () => localStorage.setItem("steady.settings", JSON.stringify(settings));

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyLook() {
  const theme = settings.theme === "auto" ? (darkQuery.matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = theme;
  // The title bar of Steady's own window (Safari web app) takes this colour.
  $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.body.dataset.guide = settings.guide;
  document.body.dataset.focus = settings.focus;
  document.documentElement.style.setProperty("--read-font", settings.font === "sans" ? "var(--sans)" : "var(--serif)");
  document.documentElement.style.setProperty("--read-size", settings.size + "px");
  document.documentElement.style.setProperty("--measure", WIDTHS[settings.width] || WIDTHS.medium);
  document.querySelectorAll(".seg").forEach((seg) => {
    const v = String(settings[seg.dataset.setting]);
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  });
  $("#sizeVal").textContent = settings.size + "px";
  $("#rateVal").textContent = settings.rate.toFixed(2) + "×";
  $("#rateInput").value = settings.rate;
  $("#rateChip").textContent = settings.rate.toFixed(2).replace(/0$/, "") + "×" + (settings.muted ? " · muted" : "");
}
darkQuery.addEventListener("change", applyLook);

/* ------------------------------------------------------------------ voices */

let voiceInfo = null; // {langs, voices, ocr}
async function loadVoices() {
  voiceInfo = await api("/api/voices");
  return voiceInfo;
}
function voiceFor(lang) {
  const list = voiceInfo.voices[lang] || [];
  const chosen = settings.voices[lang];
  return list.find((v) => v.key === chosen) || list[0];
}

let voicePoll = null;
async function ensureVoice() {
  if (!doc) return false;
  await loadVoices();
  const v = voiceFor(doc.lang);
  if (v.installed) { setStatus(null); prepare(); return true; }
  if (!v.progress || v.progress.error) await post(`/api/voices/${v.key}/install`, {});
  clearTimeout(voicePoll);
  const tick = async () => {
    await loadVoices();
    if (!doc) return;
    const cur = voiceFor(doc.lang);
    if (cur.installed) {
      setStatus(null);
      fillPanel();
      if (holding) startReading(); else prepare();
      return;
    }
    const p = cur.progress || {};
    if (p.error) { setStatus(`Couldn't download the voice: ${p.error}`); return; }
    const pct = p.total ? Math.round((p.done / p.total) * 100) + "%" : "";
    setStatus(`Downloading voice “${cur.label}” ${pct} (first time only)`, true);
    voicePoll = setTimeout(tick, 600);
  };
  tick();
  return false;
}

/* ------------------------------------------------------------------ library */

const libStatus = (msg, kind) => {
  const el = $("#libStatus");
  el.className = "lib-status" + (kind === "error" ? " error" : "");
  el.innerHTML = kind === "busy" ? `<span class="spin"></span>${esc(msg)}` : esc(msg || "");
};

// Where a document was sent from, shown as a coloured dot. Documents added in Steady have none.
const VIA = { obsidian: "Sent from Obsidian", raycast: "Sent from Raycast" };
const VIA_ORDER = { obsidian: 0, raycast: 1 }; // sorting by source: Obsidian, Raycast, then uploaded
let libDocs = [];

async function showLibrary() {
  stopReading();
  doc = null;
  $("#reader").hidden = true;
  $("#library").hidden = false;
  document.title = "Steady";
  libDocs = await api("/api/library");
  renderDocs();
  const marks = libDocs.flatMap((d) => d.bookmarks.map((m) => ({ ...m, id: d.id, title: d.title }))).sort((a, b) => b.at - a.at);
  $("#allMarks").hidden = !marks.length;
  $("#allMarksCount").textContent = marks.length || "";
  $("#allMarksList").innerHTML = marks.map((m) => `
    <li data-id="${m.id}" data-at="${m.b}.${m.w}">
      <div class="q">${esc(m.t || "…")}</div>
      <div class="m">${esc(m.title)}</div>
    </li>`).join("");
}

// The documents, most recently opened first, or grouped by where they came from.
function renderDocs() {
  const names = voiceInfo ? voiceInfo.langs : {};
  const sources = new Set(libDocs.map((d) => d.via || "upload"));
  $("#libSort").hidden = sources.size < 2; // only worth offering when there's more than one source
  const bySource = settings.libSort === "source" && sources.size > 1;
  for (const b of $("#libSort").querySelectorAll("button")) b.classList.toggle("on", b.dataset.sort === (bySource ? "source" : "recent"));
  const rank = (d) => VIA_ORDER[d.via] ?? 2;
  const docs = bySource ? [...libDocs].sort((a, b) => rank(a) - rank(b)) : libDocs; // stable: recent first within each
  $("#docs").innerHTML = docs.map((d) => `
    <li data-id="${d.id}">
      <div class="info">
        <div class="t">${esc(d.title)}</div>
        <div class="m"><span>${esc(d.kind)} · ${esc(names[d.lang] || d.lang)} · ${d.words.toLocaleString()} words · ${Math.round(d.progress * 100)}%</span>${VIA[d.via] ? `<span class="via ${d.via}" title="${VIA[d.via]}" aria-label="${VIA[d.via]}"></span>` : ""}</div>
        <div class="bar2"><div style="width:${(d.progress * 100).toFixed(1)}%"></div></div>
      </div>
      <button class="rm" title="Remove from library">Remove</button>
    </li>`).join("");
}
$("#libSort").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  settings.libSort = b.dataset.sort;
  saveSettings();
  renderDocs();
});
$("#allMarksList").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) location.hash = `doc=${li.dataset.id}&at=${li.dataset.at}`;
});

$("#docs").addEventListener("click", async (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const rm = e.target.closest(".rm");
  if (rm) {
    e.stopPropagation();
    if (!rm.classList.contains("confirm")) {
      rm.classList.add("confirm");
      rm.textContent = "Remove?";
      setTimeout(() => { rm.classList.remove("confirm"); rm.textContent = "Remove"; }, 2500);
      return;
    }
    await api(`/api/doc/${li.dataset.id}`, { method: "DELETE" });
    li.remove();
    libDocs = libDocs.filter((d) => d.id !== li.dataset.id);
    $("#libSort").hidden = new Set(libDocs.map((d) => d.via || "upload")).size < 2;
    return;
  }
  location.hash = "doc=" + li.dataset.id;
});

function libProgress(name, done, total, ocr) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#libStatus").className = "lib-status";
  $("#libStatus").innerHTML = `
    <div>Reading “${esc(name)}” · page ${Math.min(done + 1, total)} of ${total}${ocr ? " · scanned pages (OCR) take longer" : ""}</div>
    <div class="lp-bar"><div style="width:${pct}%"></div></div>`;
}

async function waitForImport(jobId, name) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const j = await api(`/api/import/${jobId}`);
    if (j.error) throw new Error(j.error);
    if (j.result) return j.result;
    if (j.total > 1) libProgress(name, j.done, j.total, j.ocr);
  }
}

async function upload(file) {
  libStatus(`Reading “${file.name}”…`, "busy");
  const fd = new FormData();
  fd.append("file", file);
  try {
    let d = await api("/api/import", { method: "POST", body: fd });
    if (d.job) d = await waitForImport(d.job, file.name);
    libStatus("");
    location.hash = "doc=" + d.id;
  } catch (err) {
    libStatus(err.message, "error");
  }
}

$("#fileInput").addEventListener("change", (e) => {
  if (e.target.files[0]) upload(e.target.files[0]);
  e.target.value = "";
});
$("#urlForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#urlInput").value.trim();
  if (!url) return;
  libStatus("Fetching page…", "busy");
  try {
    const d = await post("/api/import-url", { url });
    $("#urlInput").value = "";
    libStatus("");
    location.hash = "doc=" + d.id;
  } catch (err) {
    libStatus(err.message, "error");
  }
});

// Paste on the library page: a link opens that page, any other text is read as it is.
document.addEventListener("paste", (e) => {
  if ($("#library").hidden) return;
  const text = e.clipboardData.getData("text/plain").trim();
  if (!text) return;
  if (/^\S+$/.test(text)) { // a link
    if (e.target === $("#urlInput") || !/^https?:\/\/|^www\./i.test(text)) return;
    e.preventDefault();
    $("#urlInput").value = text;
    $("#urlForm").requestSubmit();
    return;
  }
  e.preventDefault();
  const first = text.split("\n")[0].replace(/[^\p{L}\p{N}'’,.!?-]+/gu, " ").trim().split(" ");
  const title = first.slice(0, 8).join(" ").replace(/[,.!?-]+$/, "") + (first.length > 8 ? "…" : "");
  upload(new File([text], (title || "Pasted text") + ".txt", { type: "text/plain" }));
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const f = e.dataTransfer.files[0];
  if (f) {
    if (!$("#library").hidden) upload(f);
    else { location.hash = ""; setTimeout(() => upload(f), 50); }
  }
});

/* ------------------------------------------------------------------ document view */

let doc = null;
let pos = { b: 0, w: 0 };
let segCache = new Map();   // block index -> [{start, end}]
let wordElCache = new Map(); // block index -> [span]

async function openDoc(id, at) {
  stopReading();
  let d;
  try { d = await api(`/api/doc/${id}`); } catch { location.hash = ""; return; }
  if (!voiceInfo) await loadVoices();
  doc = d;
  countWords();
  segCache = new Map();
  wordElCache = new Map();
  resetLine();
  clearAudioCache();
  searchIndex = null;
  closeSearch();
  document.body.classList.remove("browsing");
  $("#library").hidden = true;
  $("#reader").hidden = false;
  document.title = doc.title + " · Steady";
  $("#docTitle").textContent = doc.title;
  $("#docNotes").textContent = (doc.notes || []).join(" ");
  if (window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: doc.title, artist: "Steady" });
  renderBlocks();
  markBookmarks();
  fillPanel();
  const [b, w] = at || doc.pos || [0, 0];
  if (at) history.replaceState(null, "", "#doc=" + id); // opened from a bookmark
  pos = { b: Math.min(b, doc.blocks.length - 1), w };
  curBlockEl = null;
  requestAnimationFrame(() => {
    setPos(pos.b, pos.w, { instant: true });
    $("#cursor").classList.add("on");
  });
  ensureVoice().then((ok) => {
    if (ok && doc.notes && doc.notes.length) {
      setStatus(doc.notes.join(" "));
      setTimeout(() => !holding && setStatus(null), 6000);
    }
  });
}

/* Large documents: only the part around where you are is on the page (every word is its own
   element, so a whole book would make the page crawl). The document is cut into parts of a few
   thousand words, at a heading where possible. The part you're in and one either side are shown;
   scrolling by hand adds more, and they're trimmed again once you go back to reading. */
const PART_WORDS = 3000, PART_BLOCKS = 200;
let parts = [];   // [{start, end}]: block ranges
let partOf = [];  // block index -> part index
let partEls = []; // part index -> its element, while on the page
let blockEls = []; // block index -> its element, while on the page
let shown = { from: 0, to: -1 }; // the parts on the page: always a continuous run

function renderBlocks() { // a new document: work out the parts; setPos puts them on the page
  parts = [];
  partOf = new Array(doc.blocks.length);
  let start = 0, words = 0;
  doc.blocks.forEach((blk, i) => {
    const n = i - start, heading = /^h[12]$/.test(blk.k);
    if (n && (words >= PART_WORDS || n >= PART_BLOCKS || (heading && words >= PART_WORDS / 3))) {
      parts.push({ start, end: i });
      start = i;
      words = 0;
    }
    words += blk.w.length;
  });
  if (doc.blocks.length) parts.push({ start, end: doc.blocks.length });
  parts.forEach((p, pi) => { for (let b = p.start; b < p.end; b++) partOf[b] = pi; });
  partEls = [];
  blockEls = [];
  shown = { from: 0, to: -1 };
  $("#blocks").textContent = "";
}

function blockHtml(blk, bi) {
  let html = "";
  let prev = null; // last segment of the previous word
  const hl = (seg) => (seg[1].includes("h") ? seg[2] || "default" : null);
  const style = (c) => (c && /^#[0-9a-f]{6}$/.test(c) ? ` style="--hl:${c}"` : "");
  blk.w.forEach((w, wi) => {
    const segs = typeof w === "string" ? [[w, ""]] : w;
    // keep a highlight continuous across the space between two words of the same colour
    if (wi > 0) html += prev && hl(prev) && hl(prev) === hl(segs[0]) ? `<span class="fh"${style(prev[2])}> </span>` : " ";
    html += `<span class="w" data-i="${wi}">`;
    for (const [t, f, c] of segs) {
      html += f ? `<span class="${[...f].map((x) => "f" + x).join(" ")}"${style(c)}>${esc(t)}</span>` : esc(t);
    }
    html += "</span>";
    prev = segs[segs.length - 1];
  });
  return `<div class="blk k-${blk.k}" data-b="${bi}">${html}</div>`;
}

function makePart(pi) {
  const el = document.createElement("section");
  el.className = "part";
  const { start, end } = parts[pi];
  const html = [];
  for (let b = start; b < end; b++) html.push(blockHtml(doc.blocks[b], b));
  el.innerHTML = html.join("");
  for (const child of el.children) blockEls[+child.dataset.b] = child;
  return (partEls[pi] = el);
}
function dropPart(pi) {
  const { start, end } = parts[pi];
  for (let b = start; b < end; b++) { blockEls[b] = undefined; wordElCache.delete(b); }
  if (pos.b >= start && pos.b < end) { curBlockEl = null; resetLine(); }
  partEls[pi]?.remove();
  partEls[pi] = undefined;
}

// Put parts from..to on the page, keeping the text you're looking at where it is.
// Returns false if none of what was on the page stayed (a jump somewhere else).
function showParts(from, to) {
  from = Math.max(0, from);
  to = Math.min(parts.length - 1, to);
  if (from === shown.from && to === shown.to) return true;
  const keepFrom = Math.max(from, shown.from), keepTo = Math.min(to, shown.to);
  const kept = keepFrom <= keepTo;
  const anchor = kept ? partEls[keepFrom] : null;
  const before = anchor?.getBoundingClientRect().top;
  for (let p = shown.from; p <= shown.to; p++) if (p < from || p > to) dropPart(p);
  const above = document.createDocumentFragment(), below = document.createDocumentFragment();
  for (let p = from; p <= to; p++) {
    if (kept && p >= keepFrom && p <= keepTo) continue;
    (kept && p < keepFrom ? above : below).append(makePart(p));
  }
  $("#blocks").prepend(above);
  $("#blocks").append(below);
  shown = { from, to };
  markBookmarks();
  if (anchor) shiftScroll(anchor.getBoundingClientRect().top - before);
  return kept;
}

// The parts around block b. While you're scrolling by hand, parts are only added,
// so the text you're looking at isn't taken away.
function showAround(b) {
  const p = partOf[b];
  if (document.body.classList.contains("browsing") && p >= shown.from - 1 && p <= shown.to + 1) {
    return showParts(Math.min(shown.from, p), Math.max(shown.to, p));
  }
  return showParts(p - 1, p + 1);
}

// Scrolling by hand: add the next part before you reach the end of what's shown.
let edgeFrame = 0;
function fillEdges() {
  edgeFrame = 0;
  if (!doc || $("#reader").hidden || !document.body.classList.contains("browsing")) return;
  const box = $("#blocks");
  if (!box.firstElementChild) return;
  const stage = $("#stage"), view = stage.getBoundingClientRect(), r = box.getBoundingClientRect();
  const margin = stage.clientHeight * 1.5;
  let added = false;
  if (r.top > view.top - margin && shown.from > 0) { showParts(shown.from - 1, shown.to); added = true; }
  else if (r.bottom < view.bottom + margin && shown.to < parts.length - 1) { showParts(shown.from, shown.to + 1); added = true; }
  if (added) edgeFrame = requestAnimationFrame(fillEdges); // a short part may not be enough
}
$("#stage").addEventListener("scroll", () => { edgeFrame ||= requestAnimationFrame(fillEdges); }, { passive: true });

const blockEl = (b) => blockEls[b];
function markBookmarks() {
  document.querySelectorAll(".blk.bm").forEach((el) => el.classList.remove("bm"));
  for (const m of doc.bookmarks || []) blockEl(m.b)?.classList.add("bm");
}
function wordEl(b, w) {
  if (!wordElCache.has(b)) {
    const el = blockEl(b);
    if (!el) return undefined; // not on the page
    wordElCache.set(b, Array.from(el.querySelectorAll(".w")));
  }
  return wordElCache.get(b)[w];
}

/* sentence segments: what we send to the voice in one go */
const ABBR = new Set(("mr. mrs. ms. dr. prof. st. vs. etc. e.g. i.e. no. fig. jr. sr. inc. ltd. co. approx. " +
  "bzw. z.b. usw. ca. nr. vgl. evtl. dh. d.h. u.a. pl. stb. kb. ill. ún. ld. dr mme. mlle. m. p. cf. vol. ch. pp. p.").split(" "));
function isSentenceEnd(t, next) {
  if (!/[.!?…]["'”’»)\]]*$/.test(t)) return false;
  const low = t.toLowerCase().replace(/^["'“‘«(\[]+/, "");
  if (ABBR.has(low)) return false;
  if (/^\p{Lu}\.$/u.test(t)) return false; // initials like "J."
  if (next && /^[\p{Ll}]/u.test(next)) return false;
  return true;
}
function segmentsOf(b) {
  if (segCache.has(b)) return segCache.get(b);
  const words = doc.blocks[b].w.map(plain);
  const segs = [];
  let s = 0;
  for (let j = 0; j < words.length; j++) {
    const len = j - s + 1;
    const end = isSentenceEnd(words[j], words[j + 1]) ||
      len >= 70 || (len >= 32 && /[,;:—–]$/.test(words[j]));
    if (end) { segs.push({ start: s, end: j + 1 }); s = j + 1; }
  }
  if (s < words.length) segs.push({ start: s, end: words.length });
  segCache.set(b, segs);
  return segs;
}
const segAt = (b, w) => segmentsOf(b).find((s) => w >= s.start && w < s.end) || segmentsOf(b)[0];
function nextSeg(b, seg) {
  const segs = segmentsOf(b);
  const i = segs.indexOf(seg);
  if (i + 1 < segs.length) return { b, seg: segs[i + 1] };
  if (b + 1 < doc.blocks.length) return { b: b + 1, seg: segmentsOf(b + 1)[0] };
  return null;
}
function prevSeg(b, seg) {
  const segs = segmentsOf(b);
  const i = segs.indexOf(seg);
  if (i > 0) return { b, seg: segs[i - 1] };
  if (b > 0) { const p = segmentsOf(b - 1); return { b: b - 1, seg: p[p.length - 1] }; }
  return null;
}

/* ------------------------------------------------------------------ position, cursor, centering */

let curBlockEl = null;
let saveTimer = null;

function setPos(b, w, opts = {}) {
  const jumped = !showAround(b); // the text on the page was replaced: no gliding there
  const blockChanged = b !== pos.b || !curBlockEl || !curBlockEl.isConnected;
  pos = { b, w };
  if (blockChanged) {
    document.querySelectorAll(".blk.cur, .blk.near").forEach((el) => el.classList.remove("cur", "near"));
    curBlockEl = blockEl(b);
    curBlockEl.classList.add("cur");
    blockEl(b - 1)?.classList.add("near");
    blockEl(b + 1)?.classList.add("near");
  }
  const instant = opts.instant || jumped;
  placeCursor(instant);
  if (!document.body.classList.contains("browsing") || opts.recenter) centerView(instant);
  updateProgress();
  saveTimer ||= setTimeout(savePos, 3000); // also saves during long hands-free reading
  if (!playing) prepare();
}

let lastCursorTop = null;
// The words sharing a line with the current word get .line; those already read get .read too.
let lineEls = [], lineKey = "";
function markLine(el) {
  const tol = settings.size * 0.3;
  const key = `${pos.b}:${Math.round(el.offsetTop / tol)}`;
  if (key !== lineKey) {
    lineEls.forEach((e) => e.classList.remove("line", "read"));
    const top = el.offsetTop;
    wordEl(pos.b, 0);
    lineEls = wordElCache.get(pos.b).filter((e) => Math.abs(e.offsetTop - top) < tol);
    lineEls.forEach((e) => e.classList.add("line"));
    lineKey = key;
  }
  for (const e of lineEls) e.classList.toggle("read", +e.dataset.i < pos.w);
}
function resetLine() { lineEls.forEach((e) => e.classList.remove("line", "read")); lineEls = []; lineKey = ""; }

let nowEl = null;
function placeCursor(instant) {
  const el = wordEl(pos.b, pos.w);
  const cur = $("#cursor");
  if (!el) return;
  if (nowEl !== el) { nowEl?.classList.remove("now"); el.classList.add("now"); nowEl = el; }
  markLine(el);
  const docRect = $("#doc").getBoundingClientRect();
  const r = el.getClientRects()[0] || el.getBoundingClientRect();
  const padX = 0.16 * settings.size, padY = 0.04 * settings.size;
  const x = r.left - docRect.left - padX, y = r.top - docRect.top - padY;
  const lineChange = lastCursorTop !== null && Math.abs(y - lastCursorTop) > 4;
  cur.classList.toggle("jump", !!instant || lineChange);
  cur.style.transform = `translate(${x}px, ${y}px)`;
  cur.style.width = r.width + padX * 2 + "px";
  cur.style.height = r.height + padY * 2 + "px";
  lastCursorTop = y;
}

let scrollAnim = null;
let programmaticScroll = false;
function centerView(instant) {
  const stage = $("#stage");
  const blk = blockEl(pos.b);
  if (!blk) return;
  const sr = stage.getBoundingClientRect();
  const br = blk.getBoundingClientRect();
  let target;
  if (settings.focus !== "line" && br.height < stage.clientHeight * 0.5) {
    target = stage.scrollTop + br.top - sr.top + br.height / 2 - stage.clientHeight * 0.46;
  } else { // line focus (or a tall paragraph): keep the current line at the same height
    const word = wordEl(pos.b, pos.w);
    if (!word) return;
    const wr = word.getBoundingClientRect();
    target = stage.scrollTop + wr.top - sr.top + wr.height / 2 - stage.clientHeight * 0.44;
  }
  target = Math.max(0, Math.round(target));
  if (Math.abs(target - stage.scrollTop) < 2) return;
  scrollTo(target, instant ? 0 : settings.focus === "line" ? 380 : 520);
}
let anim = null; // the scroll in progress: {from, target}
function scrollTo(target, ms) {
  const stage = $("#stage");
  cancelAnimationFrame(scrollAnim);
  anim = null;
  programmaticScroll = true;
  if (!ms) { stage.scrollTop = target; requestAnimationFrame(() => (programmaticScroll = false)); return; }
  const a = (anim = { from: stage.scrollTop, target }), t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    stage.scrollTop = a.from + (a.target - a.from) * e;
    if (k < 1) scrollAnim = requestAnimationFrame(step);
    else { anim = null; requestAnimationFrame(() => (programmaticScroll = false)); }
  };
  scrollAnim = requestAnimationFrame(step);
}
// Text was added or removed above what you're looking at: scroll by the same amount so nothing moves.
function shiftScroll(d) {
  if (!d) return;
  $("#stage").scrollTop += d;
  if (anim) { anim.from += d; anim.target += d; }
}

let wordsBefore = []; // per block, plus the total at the end
function countWords() {
  wordsBefore = [0];
  for (const b of doc.blocks) wordsBefore.push(wordsBefore[wordsBefore.length - 1] + b.w.length);
}
function updateProgress() {
  const total = wordsBefore[doc.blocks.length];
  $("#progressFill").style.width = (total ? ((wordsBefore[pos.b] + pos.w) / total) * 100 : 0) + "%";
}

/* ---- time left: words remaining ÷ how fast this voice actually speaks at the chosen speed */

const PARAGRAPH_PAUSE = 0.22; // seconds, see the "ended" handler
// The voice doesn't get exactly N times faster at N×, so the pace is measured per speed too.
const paceStats = JSON.parse(localStorage.getItem("steady.pace") || "{}"); // key -> {words, secs}
function addPace(key, words, secs) {
  const s = (paceStats[key] ||= { words: 0, secs: 0 });
  s.words += words;
  s.secs += secs;
  if (s.secs > 3600) { s.words /= 2; s.secs /= 2; } // keep it adapting
}
function recordPace(voice, words, duration, rate) {
  addPace(voice, words, duration * rate); // rough 1× pace, used for speeds not measured yet
  addPace(`${voice}@${rate.toFixed(2)}`, words, duration);
  localStorage.setItem("steady.pace", JSON.stringify(paceStats));
}
function wordsPerMinute() {
  const voice = voiceFor(doc.lang).key;
  const exact = paceStats[`${voice}@${settings.rate.toFixed(2)}`];
  if (exact && exact.secs > 10) return (exact.words / exact.secs) * 60;
  const s = paceStats[voice];
  const base = s && s.secs > 15 ? (s.words / s.secs) * 60 : 165; // typical Piper pace until measured
  return base * settings.rate;
}
function minutesLeft() {
  const words = wordsBefore[doc.blocks.length] - wordsBefore[pos.b] - pos.w;
  const pauses = (doc.blocks.length - pos.b - 1) * PARAGRAPH_PAUSE;
  return words / wordsPerMinute() + pauses / 60;
}
function formatMinutes(m) {
  if (m < 1) return "less than a minute";
  const total = Math.round(m);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60), rest = total % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
const timeLeftText = () => `${formatMinutes(minutesLeft())} left`;

function savePos() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!doc) return;
  const body = JSON.stringify({ pos: [pos.b, pos.w] });
  if (doc.id + body === savedPos) return;
  savedPos = doc.id + body;
  // keepalive: the save still goes through if the tab is closing
  fetch(`/api/doc/${doc.id}/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
}
let savedPos = "";
window.addEventListener("pagehide", savePos);

/* manual scrolling: brighten everything until reading resumes */
let browseTimer = null;
function startBrowsing() {
  if (programmaticScroll) return;
  document.body.classList.add("browsing");
  clearTimeout(browseTimer);
}
$("#stage").addEventListener("wheel", startBrowsing, { passive: true });
$("#stage").addEventListener("touchmove", startBrowsing, { passive: true });
function endBrowsing() {
  if (!document.body.classList.contains("browsing")) return;
  document.body.classList.remove("browsing");
  setPos(pos.b, pos.w); // back to where you're reading: also trims the parts added while scrolling
}

// Click a word to read from there. The jump waits a moment, in case it's a double-click
// selecting the word (jumping first would scroll the word away from the second click).
let clickTimer = null;
$("#blocks").addEventListener("click", (e) => {
  clearTimeout(clickTimer);
  const w = e.target.closest(".w");
  if (!w || e.detail > 1 || !getSelection().isCollapsed) return; // selecting text, not a jump
  if (e.altKey) { e.stopPropagation(); addPronFor(w.textContent); return; }
  clickTimer = setTimeout(() => {
    if (!getSelection().isCollapsed) return;
    document.body.classList.remove("browsing");
    jumpTo(+w.closest(".blk").dataset.b, +w.dataset.i);
  }, 250);
});

/* ------------------------------------------------------------------ audio */

// Two players take turns, one sentence each. Loading a new sentence into a player cuts off
// whatever it still had on the way to the speakers (with Bluetooth that can be the end of
// the last word), so the next sentence goes to the other player and this one plays out.
const players = [new Audio(), new Audio()];
players.forEach((p) => (p.preload = "auto"));
let audio = players[0];
let audioCache = new Map(); // key -> {promise, url}
let holding = false;
let playing = false;
let playToken = 0;
let cur = null; // {b, seg, data}

const audioKey = (b, seg) => `${voiceFor(doc.lang).key}|${settings.rate}|${b}|${seg.start}`;

function clearAudioCache() {
  for (const v of audioCache.values()) if (v.url) URL.revokeObjectURL(v.url);
  audioCache = new Map();
  cur = null;
}

function fetchSeg(b, seg) {
  const key = audioKey(b, seg);
  if (audioCache.has(key)) return audioCache.get(key).promise;
  const entry = {};
  const words = doc.blocks[b].w.slice(seg.start, seg.end).map(plain);
  const rate = settings.rate, voice = voiceFor(doc.lang).key;
  entry.promise = speakReq(voice, words, rate)
    .then((d) => {
      recordPace(voice, d.starts.filter((t) => t != null).length, d.duration, rate);
      entry.url = URL.createObjectURL(d.blob);
      return { url: entry.url, starts: d.starts, duration: d.duration, rate };
    })
    .catch((err) => { audioCache.delete(key); throw err; });
  audioCache.set(key, entry);
  // keep the cache small
  if (audioCache.size > 60) {
    const [oldKey, old] = audioCache.entries().next().value;
    if (!cur || old.url !== cur.data?.url) { if (old.url) URL.revokeObjectURL(old.url); audioCache.delete(oldKey); }
  }
  return entry.promise;
}

// While you're not reading, get the sentence at the cursor ready, so holding space starts at once.
let prepareTimer = null;
function prepare() {
  clearTimeout(prepareTimer);
  prepareTimer = setTimeout(() => {
    if (doc && !holding && voiceFor(doc.lang)?.installed) fetchSeg(pos.b, segAt(pos.b, pos.w)).catch(() => {});
  }, 400);
}

function prefetch(b, seg, n = 3) {
  let p = Promise.resolve();
  let at = { b, seg };
  for (let i = 0; i < n; i++) {
    at = nextSeg(at.b, at.seg);
    if (!at) break;
    const t = at;
    p = p.then(() => fetchSeg(t.b, t.seg)).catch(() => {});
  }
}

const waitMeta = () => new Promise((res) => {
  if (audio.readyState >= 1) return res();
  audio.addEventListener("loadedmetadata", res, { once: true });
});

function startTimeFor(data, seg, w) {
  for (let i = w - seg.start; i < data.starts.length; i++) if (data.starts[i] != null) return data.starts[i];
  return 0;
}

async function startReading() {
  if (!doc || !holding) return;
  const token = ++playToken;
  const seg = segAt(pos.b, pos.w);
  if (pos.w < seg.start) pos.w = seg.start;

  // resume within the sentence we already have
  if (cur && cur.b === pos.b && cur.seg === seg && audio.src === cur.data.url) {
    audio.currentTime = Math.max(0, startTimeFor(cur.data, seg, pos.w) - 0.04);
    return play();
  }

  const v = voiceFor(doc.lang);
  if (!v.installed) { ensureVoice(); return; }

  let data;
  const slow = setTimeout(() => token === playToken && setStatus("Preparing voice…", true), 250);
  try {
    data = await fetchSeg(pos.b, seg);
  } catch (err) {
    clearTimeout(slow);
    if (token !== playToken) return; // stopped or moved on meanwhile
    if (err.status === 409) { await loadVoices(); ensureVoice(); }
    else setStatus("Voice error: " + err.message);
    return;
  }
  clearTimeout(slow);
  if (token !== playToken) return;
  setStatus(null);
  cur = { b: pos.b, seg, data };
  if (!audio.ended) audio.pause(); // only a finished sentence may keep playing out
  audio = players[audio === players[0] ? 1 : 0];
  audio.src = data.url;
  await waitMeta();
  if (token !== playToken) return;
  audio.currentTime = Math.max(0, startTimeFor(data, seg, pos.w) - 0.04);
  if (holding) play();
  prefetch(pos.b, seg);
}

// Speech is generated at the speed set when it was requested. If the speed changes
// mid-sentence, the rest of that sentence is sped up / slowed down in the browser,
// starting at the next word; the following sentences are generated at the new speed.
let pendingRate = false;
function applyRate() {
  pendingRate = false;
  audio.preservesPitch = true;
  audio.playbackRate = cur ? settings.rate / cur.data.rate : 1;
}

let tickFrame = 0;
function play() {
  audio.muted = settings.muted;
  applyRate();
  audio.play().catch(() => {});
  playing = true;
  cancelAnimationFrame(tickFrame); // resuming within a frame of pausing would otherwise run two loops
  tickFrame = requestAnimationFrame(tick);
}

function tick() {
  if (!playing || !cur) return;
  const t = audio.currentTime + 0.03;
  const st = cur.data.starts;
  let k = -1;
  for (let i = 0; i < st.length; i++) {
    if (st[i] == null) continue;
    if (st[i] <= t) k = i; else break;
  }
  if (k >= 0) {
    const w = cur.seg.start + k;
    if (w !== pos.w || cur.b !== pos.b) {
      if (pendingRate) applyRate();
      setPos(cur.b, w);
    }
  }
  tickFrame = requestAnimationFrame(tick);
}

const onEnded = (e) => {
  if (e.target !== audio) return;
  playing = false;
  if (!cur) return;
  const n = nextSeg(cur.b, cur.seg);
  if (!n) { setLocked(false); setStatus("The end."); holding = false; document.body.classList.remove("reading"); return; }
  const pause = n.b !== cur.b ? 220 : 40; // a breath between paragraphs
  setPos(n.b, n.seg.start);
  const token = playToken;
  setTimeout(() => { if (holding && token === playToken) startReading(); }, pause);
};
players.forEach((p) => p.addEventListener("ended", onEnded));

function pauseReading() {
  playToken++;
  if (playing) audio.pause();
  playing = false;
  setStatus(null);
  savePos();
}
function stopReading() {
  setLocked(false);
  holding = false;
  document.body.classList.remove("reading");
  pauseReading();
}

function jumpTo(b, w) {
  const wasHolding = holding;
  if (playing) { audio.pause(); playing = false; }
  playToken++;
  setPos(b, w, { recenter: true });
  if (wasHolding) startReading();
}

// Safari only lets an <audio> element play if it first starts inside a key/click handler.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  players.forEach((p) => { p.src = url; p.play().catch(() => {}); });
}

function beginHold() {
  if (!doc || holding) return;
  unlockAudio();
  holding = true;
  closePanel();
  closeOutline();
  document.body.classList.add("reading");
  endBrowsing();
  startReading();
}
function endHold() {
  setLocked(false);
  if (!holding) return;
  holding = false;
  document.body.classList.remove("reading");
  pauseReading();
}

/* Hands-free: double-tap space to lock reading on; tap once to stop.
   Holding space while locked unlocks it, and reading then runs until you let go. */
const TAP_MS = 280;        // shorter than this is a tap, longer is a hold
const DOUBLE_TAP_MS = 450; // max gap between the two taps
let locked = false;
let spaceDownAt = 0, spaceIsDown = false, lastTapAt = 0, unlockTimer = null;

function setLocked(on) {
  if (locked === on) return;
  locked = on;
  document.body.classList.toggle("locked", on);
  setStatus(null);
}

function spaceDown() {
  spaceIsDown = true;
  spaceDownAt = performance.now();
  if (locked) {
    // keep reading; if this turns into a hold, switch to normal hold-to-read
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => { if (spaceIsDown && locked) setLocked(false); }, TAP_MS);
    return;
  }
  beginHold();
}

function spaceUp() {
  spaceIsDown = false;
  clearTimeout(unlockTimer);
  const now = performance.now();
  const tap = now - spaceDownAt < TAP_MS;
  if (locked) {           // any tap while locked stops (a hold already switched to hold-to-read)
    lastTapAt = 0;
    endHold();
    return;
  }
  const double = tap && now - lastTapAt < DOUBLE_TAP_MS;
  lastTapAt = tap && !double ? now : 0;
  if (double && holding) { setLocked(true); return; } // double-tap: keep reading hands-free
  endHold();
}

/* ------------------------------------------------------------------ status line */

let flashUntil = 0, flashTimer = null; // a short notice (like the new speed) that other updates shouldn't clear
function flash(msg, ms = 1200) {
  flashUntil = 0;
  setStatus(msg);
  flashUntil = performance.now() + ms;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setStatus(null), ms + 50);
}
function setStatus(msg, busy) {
  const hold = $("#hold");
  if (performance.now() < flashUntil) return;
  if (!msg) {
    hold.classList.remove("busy");
    $("#hintText").innerHTML = locked
      ? "Reading hands-free · tap <kbd>space</kbd> or <kbd>esc</kbd> to stop"
      : "Hold <kbd>space</kbd> to read · double-tap to lock";
    return;
  }
  hold.classList.add("busy");
  $("#hintText").innerHTML = (busy ? '<span class="spin"></span>' : "") + esc(msg);
}

/* ------------------------------------------------------------------ keyboard & pointer */

const typing = (e) => e.target.closest && e.target.closest("input, select, textarea");

window.addEventListener("keydown", (e) => {
  if (!$("#reader").hidden && (e.metaKey || e.ctrlKey) && !e.altKey && e.code === "KeyF") {
    e.preventDefault(); // use our search; the browser's own one fights the dimmed, centred view
    openSearch();
    return;
  }
  if ($("#reader").hidden || typing(e)) return;
  if (!e.metaKey && !e.ctrlKey) hideSelPop();
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) spaceDown();
    return;
  }
  // speed: left Shift = slower, right Shift = faster (works on any keyboard layout)
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
    if (!e.repeat) startShift(e.code);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const seg = segAt(pos.b, pos.w);
  switch (e.key) {
    case "ArrowRight": {
      e.preventDefault();
      const n = nextSeg(pos.b, seg);
      if (n) jumpTo(n.b, n.seg.start);
      break;
    }
    case "ArrowLeft": {
      e.preventDefault();
      if (pos.w > seg.start + 1) jumpTo(pos.b, seg.start);
      else { const p = prevSeg(pos.b, seg); if (p) jumpTo(p.b, p.seg.start); }
      break;
    }
    case "ArrowDown":
      e.preventDefault();
      if (pos.b + 1 < doc.blocks.length) jumpTo(pos.b + 1, 0);
      break;
    case "ArrowUp":
      e.preventDefault();
      if (pos.w > 0) jumpTo(pos.b, 0); else if (pos.b > 0) jumpTo(pos.b - 1, 0);
      break;
    case "-": case "_": changeRate(-0.05); break;
    case "=": case "+": changeRate(+0.05); break;
    case "m": case "M": setSetting("muted", !settings.muted); break;
    case "o": case "O": toggleOutline(); break;
    case "b": case "B": bookmarkHere(); break;
    case "Escape":
      if (locked) { lastTapAt = 0; endHold(); } // first stop hands-free reading, stay on the page
      else if (!$("#outline").hidden) closeOutline();
      else if (!$("#panel").hidden) closePanel();
      else location.hash = "";
      break;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { e.preventDefault(); if (spaceIsDown) spaceUp(); }
  if (e.code === shiftCode) stopShift();
});
// Losing focus ends hold-to-read (we'd never see the key being released),
// but hands-free reading keeps going.
const focusLost = () => { stopShift(); spaceIsDown = false; if (!locked) endHold(); };

// Holding Shift keeps changing the speed: one step now, then repeating after a short pause.
// (macOS doesn't auto-repeat modifier keys, so we time it ourselves.)
let shiftTimer = null, shiftCode = null;
function startShift(code) {
  stopShift();
  shiftCode = code;
  const step = () => changeRate(code === "ShiftLeft" ? -0.05 : +0.05);
  step();
  const repeat = () => { step(); shiftTimer = setTimeout(repeat, 120); };
  shiftTimer = setTimeout(repeat, 400);
}
function stopShift() { clearTimeout(shiftTimer); shiftTimer = null; shiftCode = null; }
window.addEventListener("blur", focusLost);
document.addEventListener("visibilitychange", () => document.hidden && focusLost());

const hold = $("#hold");
hold.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (locked) { endHold(); return; } // clicking the pill stops hands-free reading
  hold.setPointerCapture(e.pointerId);
  beginHold();
});
hold.addEventListener("pointerup", () => { if (!locked) endHold(); });
hold.addEventListener("pointercancel", endHold);
hold.addEventListener("keydown", (e) => e.code === "Space" && e.preventDefault());
hold.addEventListener("click", (e) => e.preventDefault());

// Play / pause on headphones or the keyboard: play reads hands-free, pause stops.
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => {
    if (!doc || $("#reader").hidden || holding) return;
    beginHold();
    setLocked(true);
  });
  navigator.mediaSession.setActionHandler("pause", () => { lastTapAt = 0; endHold(); });
}

let pointerTimer = null;
window.addEventListener("mousemove", () => {
  document.body.classList.add("pointer-active");
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.body.classList.remove("pointer-active"), 1500);
});

/* ------------------------------------------------------------------ settings panel */

function fillPanel() {
  if (!doc || !voiceInfo) return;
  renderPron();
  $("#langSelect").innerHTML = Object.entries(voiceInfo.langs)
    .map(([k, name]) => `<option value="${k}" ${k === doc.lang ? "selected" : ""}>${name}</option>`).join("");
  const current = voiceFor(doc.lang);
  $("#voiceSelect").innerHTML = (voiceInfo.voices[doc.lang] || []).map((v) =>
    `<option value="${v.key}" ${v.key === current.key ? "selected" : ""}>${esc(v.label)}${v.installed ? "" : " · download"}</option>`).join("");
  $("#langChip").textContent = `${voiceInfo.langs[doc.lang]} · ${current.label.split(" ·")[0].replace(/ \(.*\)/, "")}`;
  applyLook();
}

function voiceChanged() {
  pauseReading();
  clearAudioCache();
  fillPanel();
  ensureVoice();
}

$("#langSelect").addEventListener("change", (e) => {
  doc.lang = e.target.value;
  post(`/api/doc/${doc.id}/state`, { lang: doc.lang }).catch(() => {});
  voiceChanged();
});
$("#voiceSelect").addEventListener("change", (e) => {
  settings.voices[doc.lang] = e.target.value;
  saveSettings();
  voiceChanged();
});
$("#rateInput").addEventListener("input", (e) => {
  settings.rate = Math.round(parseFloat(e.target.value) * 100) / 100;
  applyLook();
});
$("#rateInput").addEventListener("change", () => changeRate(0));

const MIN_RATE = 0.5, MAX_RATE = 4.0;
function changeRate(delta) {
  // finer steps at normal speeds, bigger ones once it's fast
  if (delta && (settings.rate > 1.5 || (settings.rate === 1.5 && delta > 0))) delta = Math.sign(delta) * 0.1;
  settings.rate = Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round((settings.rate + delta) * 100) / 100));
  saveSettings();
  applyLook();
  if (delta) {
    flash(`Speed ${settings.rate.toFixed(2)}× · ${timeLeftText()}`);
    if (!$("#rateTip").hidden) showRateTip();
  }
  // the current word finishes at the old speed; the new one starts with the next word
  if (playing && cur) pendingRate = true;
  // get the upcoming sentences ready at the new speed (after quick repeated presses settle)
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => { if (doc && cur) prefetch(cur.b, cur.seg); }, 350);
  if (!playing) prepare();
}
let prefetchTimer = null;

function setSetting(name, value) {
  settings[name] = value;
  saveSettings();
  applyLook();
  if (name === "muted") players.forEach((p) => (p.muted = value));
  if (name === "size" || name === "font" || name === "focus" || name === "width") requestAnimationFrame(() => { resetLine(); placeCursor(true); centerView(true); });
}

document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  let v = b.dataset.v;
  if (v === "true" || v === "false") v = v === "true";
  setSetting(seg.dataset.setting, v);
}));
$("#sizeDown").addEventListener("click", () => setSetting("size", Math.max(15, settings.size - 1)));
$("#sizeUp").addEventListener("click", () => setSetting("size", Math.min(36, settings.size + 1)));

function openPanel() { fillPanel(); $("#panel").hidden = false; }
function closePanel() { $("#panel").hidden = true; }
$("#settingsBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#panel").hidden ? openPanel() : closePanel(); });
$("#langChip").addEventListener("click", (e) => { e.stopPropagation(); openPanel(); });
$("#rateChip").addEventListener("click", (e) => { e.stopPropagation(); openPanel(); });

function showRateTip() {
  if (!doc) return;
  const tip = $("#rateTip");
  tip.innerHTML = `<strong>${esc(timeLeftText())}</strong><span>at ${settings.rate.toFixed(2)}× · left / right Shift to change</span>`;
  tip.hidden = false;
  const r = $("#rateChip").getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  tip.style.top = r.bottom + 8 + "px";
}
$("#rateChip").addEventListener("mouseenter", showRateTip);
$("#rateChip").addEventListener("mouseleave", () => ($("#rateTip").hidden = true));
document.addEventListener("click", (e) => { if (!e.target.closest("#panel")) closePanel(); });
$("#back").addEventListener("click", () => (location.hash = ""));

/* ------------------------------------------------------------------ contents (headings) */

function openOutline() {
  closePanel();
  const heads = [];
  doc.blocks.forEach((b, i) => { if (b.k.startsWith("h")) heads.push({ b: i, k: b.k, t: b.w.map(plain).join(" ") }); });
  const here = heads.filter((h) => h.b <= pos.b).pop();
  const marks = doc.bookmarks || [];
  const el = $("#outline");
  el.innerHTML = (marks.length ? '<div class="sec">Bookmarks</div>' + marks.map((m) => `
      <div class="mark"><button data-b="${m.b}" data-w="${m.w}" title="${esc(m.t)}">${esc(m.t || "…")}</button><button class="rm" data-at="${m.at}" title="Remove bookmark">×</button></div>`).join("") +
      (heads.length ? '<div class="sec">Contents</div>' : "") : "") +
    (heads.length
      ? heads.map((h) => `<button data-b="${h.b}" class="l${h.k[1]}${h === here ? " here" : ""}">${esc(h.t)}</button>`).join("")
      : marks.length ? "" : '<p class="empty">No headings or bookmarks yet. Select text to bookmark it, or press B.</p>');
  el.hidden = false;
  el.querySelector(".here")?.scrollIntoView({ block: "center" });
}
const closeOutline = () => ($("#outline").hidden = true);
const toggleOutline = () => ($("#outline").hidden ? openOutline() : closeOutline());
$("#docTitle").addEventListener("click", (e) => { e.stopPropagation(); toggleOutline(); });
$("#outline").addEventListener("click", (e) => {
  e.stopPropagation();
  const rm = e.target.closest("button[data-at]");
  if (rm) { removeBookmark(+rm.dataset.at).then(openOutline); return; }
  const btn = e.target.closest("button[data-b]");
  if (!btn) return;
  closeOutline();
  document.body.classList.remove("browsing");
  jumpTo(+btn.dataset.b, +(btn.dataset.w || 0));
});

/* ------------------------------------------------------------------ bookmarks, selection popup */

async function addBookmark(b, w, text) {
  doc.bookmarks = await post(`/api/doc/${doc.id}/bookmarks`, { add: { b, w, t: text } });
  markBookmarks();
}
async function removeBookmark(at) {
  doc.bookmarks = await post(`/api/doc/${doc.id}/bookmarks`, { remove: at });
  markBookmarks();
}

// B: bookmark the sentence you're on
function bookmarkHere() {
  const seg = segAt(pos.b, pos.w);
  const text = doc.blocks[pos.b].w.slice(seg.start, seg.end).map(plain).join(" ");
  addBookmark(pos.b, seg.start, text).then(() => flash("Bookmarked · find it under contents (O)", 2000)).catch((err) => flash(err.message));
}

// The selected words: {b, w} of the first one, and the text.
function selectedWords() {
  const sel = getSelection();
  if (!doc || $("#reader").hidden || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!$("#blocks").contains(range.commonAncestorContainer)) return null;
  const node = range.startContainer;
  const blk = (node.nodeType === 1 ? node : node.parentElement).closest(".blk") || $("#blocks .blk");
  if (!blk) return null;
  for (let b = +blk.dataset.b; b < doc.blocks.length && blockEl(b); b++) {
    wordEl(b, 0);
    const first = wordElCache.get(b).find((el) => range.intersectsNode(el));
    if (first) return { b, w: +first.dataset.i, text: sel.toString().trim(), range };
    if (range.comparePoint(blockEl(b), 0) > 0) break; // past the selection
  }
  return null;
}

const selPop = $("#selPop");
function showSelPop() {
  const s = selectedWords();
  if (!s || !s.text) return hideSelPop();
  selPop.querySelector('[data-act="copy"]').textContent = "Copy";
  selPop.querySelector('[data-act="mark"]').textContent = "Bookmark";
  selPop.hidden = false;
  const r = s.range.getBoundingClientRect();
  const w = selPop.offsetWidth, h = selPop.offsetHeight;
  let top = r.top - h - 10;
  if (top < 60) top = r.bottom + 10; // no room above (under the top bar): show it below
  selPop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  selPop.style.top = top + "px";
}
const hideSelPop = () => (selPop.hidden = true);

document.addEventListener("mouseup", () => setTimeout(showSelPop, 0));
document.addEventListener("selectionchange", () => { if (getSelection().isCollapsed) hideSelPop(); });
$("#stage").addEventListener("scroll", () => selPop.hidden || showSelPop(), { passive: true }); // follow the text
selPop.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
selPop.addEventListener("click", async (e) => {
  e.stopPropagation();
  const btn = e.target.closest("button");
  const s = selectedWords();
  if (!btn || !s) return;
  try {
    if (btn.dataset.act === "copy") await navigator.clipboard.writeText(getSelection().toString());
    else await addBookmark(s.b, s.w, s.text);
  } catch (err) { btn.textContent = "Failed"; return; }
  btn.textContent = btn.dataset.act === "copy" ? "Copied" : "Bookmarked";
  setTimeout(() => { hideSelPop(); getSelection().removeAllRanges(); }, 650);
});
document.addEventListener("click", (e) => { if (!e.target.closest("#outline")) closeOutline(); });

/* ------------------------------------------------------------------ search */

// Case, accents and punctuation are ignored; phrases may span words (not paragraphs).
const fold = (t) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
let searchIndex = null; // per block: {text, starts: char offset of each word}
let matches = [], matchAt = -1, hitEls = [];

function buildSearchIndex() {
  searchIndex = doc.blocks.map((b) => {
    const starts = [];
    let text = "";
    for (const w of b.w) {
      if (text) text += " ";
      starts.push(text.length);
      text += fold(plain(w));
    }
    return { text, starts };
  });
}

function wordAt(starts, offset) { // last word starting at or before offset
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}

function runSearch() {
  const q = $("#searchInput").value.split(/\s+/).map(fold).filter(Boolean).join(" ");
  matches = [];
  if (q) {
    if (!searchIndex) buildSearchIndex();
    searchIndex.forEach(({ text, starts }, b) => {
      for (let i = text.indexOf(q); i !== -1 && matches.length < 5000; i = text.indexOf(q, i + 1)) {
        matches.push({ b, w: wordAt(starts, i), end: wordAt(starts, i + q.length - 1) });
      }
    });
  }
  // start from the first match at or after where you are
  matchAt = matches.findIndex((m) => m.b > pos.b || (m.b === pos.b && m.w >= pos.w));
  if (matchAt === -1) matchAt = matches.length ? 0 : -1;
  showMatch();
}

function showMatch() {
  hitEls.forEach((el) => el.classList.remove("hit"));
  hitEls = [];
  const q = $("#searchInput").value.trim();
  $("#searchCount").textContent = !q ? "" : matches.length ? `${matchAt + 1} of ${matches.length}` : "No matches";
  if (matchAt < 0) return;
  const m = matches[matchAt];
  document.body.classList.remove("browsing");
  jumpTo(m.b, m.w);
  for (let w = m.w; w <= m.end; w++) { const el = wordEl(m.b, w); el.classList.add("hit"); hitEls.push(el); }
}

function stepMatch(dir) {
  if (!matches.length) return;
  matchAt = (matchAt + dir + matches.length) % matches.length;
  showMatch();
}

function openSearch() {
  if (!doc) return;
  if (holding) endHold();
  closePanel();
  closeOutline();
  $("#search").hidden = false;
  $("#searchInput").focus();
  $("#searchInput").select();
}
function closeSearch() {
  $("#search").hidden = true;
  hitEls.forEach((el) => el.classList.remove("hit"));
  hitEls = [];
  $("#searchInput").blur();
}

let searchTimer = null;
$("#searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); if (!matches.length) runSearch(); else stepMatch(e.shiftKey ? -1 : 1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); stepMatch(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); stepMatch(-1); }
  else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
  else if ((e.metaKey || e.ctrlKey) && e.code === "KeyG") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
});
$("#search").addEventListener("submit", (e) => e.preventDefault());
$("#search").addEventListener("click", (e) => e.stopPropagation());
$("#searchNext").addEventListener("click", () => stepMatch(1));
$("#searchPrev").addEventListener("click", () => stepMatch(-1));
$("#searchClose").addEventListener("click", closeSearch);

/* ------------------------------------------------------------------ pronunciations */

let pron = {}; // {lang: {lower: {word, say}}}
async function loadPron() { pron = await api("/api/pronunciations"); renderPron(); }
function renderPron() {
  if (!doc) return;
  const entries = Object.values(pron[doc.lang] || {}).sort((a, b) => a.word.localeCompare(b.word));
  $("#pronCount").textContent = entries.length ? `(${entries.length})` : "";
  $("#pronList").innerHTML = entries.map((e) => `
    <li data-word="${esc(e.word)}">
      <span class="pw">${esc(e.word)} <span>→ ${esc(e.say)}</span></span>
      <button data-act="try" title="Listen">▶</button><button data-act="rm" title="Remove">×</button>
    </li>`).join("");
}
async function savePron(word, say) {
  try {
    pron = await post("/api/pronunciations", { lang: doc.lang, word, say });
  } catch (err) { setStatus(err.message); return; }
  renderPron();
  pauseReading();
  clearAudioCache(); // regenerate speech with the new pronunciation
  prepare();
}
const tryAudio = new Audio();
async function trySay(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return;
  try {
    const d = await speakReq(voiceFor(doc.lang).key, words, settings.rate);
    if (tryAudio.src) URL.revokeObjectURL(tryAudio.src);
    tryAudio.src = URL.createObjectURL(d.blob);
    tryAudio.play().catch(() => {});
  } catch (err) { if (err.status === 409) ensureVoice(); }
}
$("#pronForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const word = $("#pronWord").value.trim(), say = $("#pronSay").value.trim();
  if (!word || !say) return;
  await savePron(word, say);
  $("#pronWord").value = $("#pronSay").value = "";
});
$("#pronTry").addEventListener("click", () => trySay($("#pronSay").value || $("#pronWord").value));
$("#pronList").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const word = btn.closest("li").dataset.word;
  const entry = (pron[doc.lang] || {})[word.toLowerCase()];
  if (btn.dataset.act === "try") trySay(entry ? entry.say : word);
  else savePron(word, "");
});
function addPronFor(word) {
  openPanel();
  $("#pron").open = true;
  $("#pronWord").value = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const entry = (pron[doc.lang] || {})[$("#pronWord").value.toLowerCase()];
  $("#pronSay").value = entry ? entry.say : "";
  $("#pronSay").focus();
  $("#panel").scrollTop = $("#panel").scrollHeight;
}

window.addEventListener("resize", () => {
  if (!doc) return;
  resetLine();
  placeCursor(true);
  centerView(true);
});

/* ------------------------------------------------------------------ routing */

function route() {
  const m = location.hash.match(/doc=([a-z0-9]+)(?:&at=(\d+)\.(\d+))?/i);
  if (m) openDoc(m[1], m[2] ? [+m[2], +m[3]] : null);
  else showLibrary();
}
window.addEventListener("hashchange", route);

// Steady.app can't hand a link to Steady's own window (the Safari web app), so it leaves the
// page on the server and brings the window forward; the window then goes there.
async function claimShown() {
  try {
    const { hash } = await post("/api/show/claim", {});
    if (hash !== null && hash !== location.hash.slice(1)) location.hash = hash;
  } catch { /* server stopped: the ping below says so */ }
}
window.addEventListener("focus", claimShown);
document.addEventListener("visibilitychange", () => !document.hidden && claimShown());

// Tell the server a page is open (Steady.app stops the server when none is), and say so if it has stopped.
setInterval(() => fetch("/api/ping").then(() => serverGone && location.reload(), () => {
  if (serverGone) return; // already said so
  serverGone = true;
  const msg = "Steady has stopped. Open the Steady app to start it again.";
  if ($("#reader").hidden) libStatus(msg, "error"); else { stopReading(); setStatus(msg); }
}), 60000);
let serverGone = false;

// Quit: stops the server (click twice, like Remove).
$("#quit").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains("confirm")) {
    btn.classList.add("confirm");
    btn.textContent = "Quit?";
    setTimeout(() => { btn.classList.remove("confirm"); btn.textContent = "Quit"; }, 2500);
    return;
  }
  try { await post("/api/quit", {}); } catch {
    libStatus("Couldn't stop Steady from here. Close the Terminal window it runs in.", "error");
    return;
  }
  serverGone = true;
  btn.hidden = true;
  libStatus("Steady has stopped. You can close this window; open the Steady app to read again.");
});

applyLook();
loadPron().catch(() => {});
loadVoices().catch(() => {}).finally(() => { route(); claimShown(); });
