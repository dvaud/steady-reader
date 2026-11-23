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
  resetPointerHover();
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
  resetPointerHover();
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
  if (hoverWord && !hoverWord.isConnected) setHoverWord(null);
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
/* Bookmarks: a bar in the margin beside every line of bookmarked text. Hover it to see the text,
   click it to read from there. A bookmark keeps its first word and its text; where it ends is
   worked out by walking the words until they've used up the text. */
let bmEnds = new Map(); // bookmark "at" -> {b, w} of its last word
function bookmarkEnd(m) {
  const key = doc.id + "|" + m.at + "|" + m.t;
  if (bmEnds.has(key)) return bmEnds.get(key);
  const need = fold(m.t || "").length;
  let end = { b: m.b, w: m.w }, got = 0;
  for (let b = m.b; b < doc.blocks.length && got < need; b++) {
    const ws = doc.blocks[b].w;
    for (let w = b === m.b ? m.w : 0; w < ws.length && got < need; w++) {
      got += fold(plain(ws[w])).length;
      end = { b, w };
    }
  }
  bmEnds.set(key, end);
  return end;
}
function markBookmarks() {
  document.querySelectorAll(".bm-bar").forEach((el) => el.remove());
  document.querySelectorAll(".blk.bm, .blk.bm-preview").forEach((el) => el.classList.remove("bm", "bm-preview"));
  if (!doc || $("#reader").hidden) return;
  const bars = [];
  for (const m of doc.bookmarks || []) { // measure everything first, then add the bars
    const z = bookmarkEnd(m);
    for (let b = m.b; b <= z.b; b++) {
      const el = blockEl(b);
      if (!el) continue; // not on the page
      const first = wordEl(b, b === m.b ? m.w : 0), last = wordEl(b, b === z.b ? z.w : doc.blocks[b].w.length - 1);
      if (!first || !last) continue;
      const box = el.getBoundingClientRect(), lr = last.getClientRects();
      const inset = parseFloat(getComputedStyle(el).fontSize) * 0.12;
      const top = first.getClientRects()[0].top - box.top + inset;
      const bottom = lr[lr.length - 1].bottom - box.top - inset;
      bars.push({ el, top, height: Math.max(4, bottom - top), m });
    }
  }
  for (const { el, top, height, m } of bars) {
    el.classList.add("bm");
    const bar = document.createElement("i");
    bar.className = "bm-bar";
    bar.dataset.at = m.at;
    bar.style.top = top + "px";
    bar.style.height = height + "px";
    el.append(bar);
  }
}
let shownMark = [];
const markHighlight = window.Highlight && CSS.highlights ? new Highlight() : null; // tints the spaces too
if (markHighlight) CSS.highlights.set("bm-show", markHighlight);
function showMark(at) { // light up the bookmarked words
  shownMark.forEach((el) => el.classList.remove("bm-show"));
  shownMark = [];
  markHighlight?.clear();
  const m = at != null && (doc?.bookmarks || []).find((x) => x.at === at);
  if (!m) return;
  const z = bookmarkEnd(m);
  for (let b = m.b; b <= z.b; b++) {
    if (!blockEl(b)) continue;
    const from = b === m.b ? m.w : 0, to = b === z.b ? z.w : doc.blocks[b].w.length - 1;
    for (let w = from; w <= to; w++) {
      const el = wordEl(b, w);
      if (el) { el.classList.add("bm-show"); shownMark.push(el); }
    }
    const first = wordEl(b, from), last = wordEl(b, to);
    if (markHighlight && first && last) { // one band per paragraph, from the first word to the last
      const r = new Range();
      r.setStartBefore(first);
      r.setEndAfter(last);
      markHighlight.add(r);
    }
  }
}
$("#blocks").addEventListener("mouseover", (e) => {
  const bar = e.target.closest(".bm-bar");
  showMark(bar ? +bar.dataset.at : null);
});
$("#blocks").addEventListener("mouseleave", () => showMark(null));
$("#blocks").addEventListener("click", (e) => {
  const bar = e.target.closest(".bm-bar");
  const m = bar && doc.bookmarks.find((x) => x.at === +bar.dataset.at);
  if (!m) return;
  e.stopPropagation();
  showMark(null);
  leapTo(m.b, m.w);
}, true);
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
  $("#cursor").classList.remove("gone");
  $("#band").classList.remove("gone");
  placeCursor(instant);
  if ((!document.body.classList.contains("browsing") && !viewHeld()) || opts.recenter) centerView(instant);
  if (marking) paintMark();
  updateProgress();
  saveTimer ||= setTimeout(savePos, 3000); // also saves during long hands-free reading
  if (!playing) prepare();
}

/* While you're selecting text, or have some selected, the page stays still (reading carries on), so the
   text and its Copy / Bookmark buttons don't slide away under the mouse. It catches up once the selection
   is gone. */
let pressing = false; // mouse button down on the text
const hasSelection = () => { const s = getSelection(); return !s.isCollapsed && s.rangeCount > 0 && $("#blocks").contains(s.getRangeAt(0).commonAncestorContainer); };
const viewHeld = () => pressing || hasSelection();
$("#stage").addEventListener("pointerdown", (e) => { if (e.button === 0) pressing = true; });
window.addEventListener("pointerup", () => {
  if (!pressing) return;
  pressing = false;
  setTimeout(catchUp, 0); // after the click has had its say (a click on a word jumps there itself)
});
function catchUp() {
  if (!doc || $("#reader").hidden || viewHeld()) return;
  if (document.body.classList.contains("browsing")) armRefocus();
  else if (playing) centerView(false);
}

let lastCursorTop = null, lastBandTop = null;
// The words sharing a line with the current word get .line; those already read get .read too.
let lineEls = [], lineKey = "", bandKey = "";
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
function resetLine() { lineEls.forEach((e) => e.classList.remove("line", "read")); lineEls = []; lineKey = ""; bandKey = ""; lastBandTop = null; }

// Focus band behind #cursor:
// - Reveal: recessed surface wrapping the current line (Line focus) or paragraph (Paragraph focus).
// - Underline (guide="highlight"): quiet vertical margin tick beside the current line in Line focus.
function placeBand(r, docRect, fs, padX, padY, instant) {
  const band = $("#band");
  const isReveal = settings.guide === "reveal";
  const isLine = settings.focus === "line";
  if (!curBlockEl || (!isReveal && !isLine)) { band.classList.remove("on"); bandKey = ""; lastBandTop = null; return; }
  const key = isLine ? `${isReveal ? "rl" : "ul"}:${lineKey}` : `rp:${pos.b}`;
  if (!instant && key === bandKey) return;
  let x, y, w, h;
  if (isLine) {
    const tol = fs * 0.35, midY = (r.top + r.bottom) / 2;
    let minL = r.left, maxR = r.right, minT = r.top, maxB = r.bottom;
    for (const e of lineEls) {
      for (const rect of e.getClientRects()) {
        if (Math.abs((rect.top + rect.bottom) / 2 - midY) < tol) {
          if (rect.left < minL) minL = rect.left;
          if (rect.right > maxR) maxR = rect.right;
          if (rect.top < minT) minT = rect.top;
          if (rect.bottom > maxB) maxB = rect.bottom;
        }
      }
    }
    if (isReveal) {
      const inset = 0.11 * fs;
      const bPadX = padX + inset, bPadY = padY + inset;
      x = minL - docRect.left - bPadX;
      y = minT - docRect.top - bPadY;
      w = maxR - minL + bPadX * 2;
      h = maxB - minT + bPadY * 2;
    } else {
      const tickGap = Math.round(fs * 0.44), tickInset = Math.round(fs * 0.16);
      x = minL - docRect.left - tickGap;
      y = minT - docRect.top + tickInset;
      w = 2.5;
      h = Math.max(8, maxB - minT - tickInset * 2);
    }
  } else {
    const br = curBlockEl.getBoundingClientRect();
    const bPadX = 0.36 * fs, bPadY = 0.24 * fs;
    x = br.left - docRect.left - bPadX;
    y = br.top - docRect.top - bPadY;
    w = br.width + bPadX * 2;
    h = br.height + bPadY * 2;
  }
  const far = lastBandTop === null || Math.abs(y - lastBandTop) >= fs * 5;
  band.classList.toggle("jump", !!instant || far);
  band.style.transform = `translate(${x}px, ${y}px)`;
  band.style.width = w + "px";
  band.style.height = h + "px";
  band.classList.add("on");
  bandKey = key;
  lastBandTop = y;
}

let nowEl = null;
function placeCursor(instant) {
  const el = wordEl(pos.b, pos.w);
  const cur = $("#cursor");
  if (!el) return;
  if (nowEl !== el) { nowEl?.classList.remove("now"); el.classList.add("now"); nowEl = el; }
  markLine(el);
  const docRect = $("#doc").getBoundingClientRect();
  const r = el.getClientRects()[0] || el.getBoundingClientRect();
  const fs = settings.size * (curBlockEl?.classList.contains("k-h1") ? 1.2 : curBlockEl?.classList.contains("k-h2") ? 1.1 : 1);
  const isReveal = settings.guide === "reveal";
  const padX = (isReveal ? 0.16 : 0.04) * fs, padY = 0.05 * fs;
  const x = r.left - docRect.left - padX;
  const y = isReveal ? r.top - docRect.top - padY : r.bottom - docRect.top;
  const h = isReveal ? r.height + padY * 2 : Math.max(2.5, Math.round(fs * 0.13 * 2) / 2);
  const lineChange = lastCursorTop !== null && Math.abs(y - lastCursorTop) > 4;
  cur.classList.toggle("jump", !!instant || lineChange);
  cur.style.transform = `translate(${x}px, ${y}px)`;
  cur.style.width = r.width + padX * 2 + "px";
  cur.style.height = h + "px";
  lastCursorTop = y;
  placeBand(r, docRect, fs, padX, padY, instant);
  syncScoutWithCursor();
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
/* The glide is a cubic curve from where the page is to the target: p(k) = from + m0·(k³−2k²+k) + d·(3k²−2k³),
   ending at rest. From rest, m0 = 3d, which is the usual ease-out. If the target changes mid-glide, the new
   glide starts at the speed the page is already moving, so it never jolts. (Restarting the ease-out on
   every word made the page lurch and brake while it was still moving: the slight shaking.) */
let anim = null; // the glide in progress: {from, target, m0, t0, ms}
const glidePos = (a, k) => a.from + a.m0 * (k * k * k - 2 * k * k + k) + (a.target - a.from) * (3 * k * k - 2 * k * k * k);
function glideSpeed(a, now) { // px per ms
  const k = Math.max(0, (now - a.t0) / a.ms);
  if (k >= 1) return 0;
  return (a.m0 * (3 * k * k - 4 * k + 1) + (a.target - a.from) * (6 * k - 6 * k * k)) / a.ms;
}
/* Safari keeps scrollTop in whole pixels, so a glide moves the text in 1 px hops, and the slow end of
   the ease-out creeps along a pixel at a time with longer and longer gaps: the letters seem to twitch.
   The text is nudged by what the rounding left over, so on screen it follows the curve exactly. */
function setScroll(stage, p) {
  stage.scrollTop = p;
  const off = stage.scrollTop - p; // 0 where fractional scrolling works (Chrome)
  $("#doc").style.transform = Math.abs(off) > 0.01 ? `translateY(${off}px)` : "";
}
function scrollTo(target, ms) {
  const stage = $("#stage");
  if (ms && anim && Math.abs(target - anim.target) < 2) return; // already on its way there: let it finish
  const now = performance.now();
  const speed = anim ? glideSpeed(anim, now) : 0;
  cancelAnimationFrame(scrollAnim);
  anim = null;
  programmaticScroll = true;
  if (!ms) { setScroll(stage, target); requestAnimationFrame(() => (programmaticScroll = false)); return; }
  const from = stage.scrollTop, d = target - from;
  let m0 = speed ? speed * ms : 3 * d;
  if (Math.sign(m0) !== Math.sign(d)) m0 = 0; // was moving the other way: turn round from a standstill
  else if (Math.abs(m0) > Math.abs(3 * d)) m0 = 3 * d; // faster would overshoot and come back
  const a = (anim = { from, target, m0, t0: now, ms });
  const step = (t) => {
    const k = Math.min(1, Math.max(0, (t - a.t0) / a.ms));
    setScroll(stage, k < 1 ? glidePos(a, k) : Math.round(a.target));
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
  updateHere();
}

/* Away from the reading (scrolled by hand, or looking at a search match): a mark on the progress bar shows
   where the text you're looking at is, and clicking the bar (or Esc) takes you back to where you're reading. */
let hereFrame = 0;
function updateHere() {
  hereFrame = 0;
  const away = isAway();
  document.body.classList.toggle("away", away);
  if (!away) return;
  const stage = $("#stage"), y = stage.getBoundingClientRect().top + stage.clientHeight * 0.46;
  let lo = parts[shown.from].start, hi = parts[shown.to].end - 1; // the first block on the page reaching the middle
  while (lo < hi) { const mid = (lo + hi) >> 1; if (blockEl(mid).getBoundingClientRect().bottom < y) lo = mid + 1; else hi = mid; }
  const r = blockEl(lo).getBoundingClientRect();
  const into = Math.min(1, Math.max(0, (y - r.top) / Math.max(1, r.height)));
  const total = wordsBefore[doc.blocks.length] || 1;
  $("#progressHere").style.left = ((wordsBefore[lo] + into * doc.blocks[lo].w.length) / total) * 100 + "%";
}
function isAway() {
  if (!doc || $("#reader").hidden || !document.body.classList.contains("browsing") || shown.to < shown.from) return false;
  const el = curBlockEl?.isConnected && wordEl(pos.b, pos.w);
  if (!el) return true; // not even on the page
  const stage = $("#stage"), sr = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
  return r.bottom < sr.top + stage.clientHeight * 0.16 || r.top > sr.top + stage.clientHeight * 0.8; // outside the clear band
}
$("#stage").addEventListener("scroll", () => { hereFrame ||= requestAnimationFrame(updateHere); }, { passive: true });

/* The progress bar as a scrubber: hover it and it thickens, shows what's at that point, and a click jumps
   there (to the start of that paragraph). Places that matter pull the pointer in when it comes close:
   where you're reading, where you were before the last jump, bookmarks and headings. They fade in as the
   pointer nears them. */
let wasAt = null; // where you were before the last long jump: {b, w}
function leapTo(b, w) {
  if (b !== pos.b) wasAt = { ...pos };
  document.body.classList.remove("browsing");
  jumpTo(b, w);
}
const PULL = { pos: 18, was: 18, bm: 14, ch: 12, sec: 8 }; // how close (px) the pointer must come to be pulled in
let pins = [], outline = null;
/* Chapters and sections: the chapter level is the highest heading level used more than once (a lone top
   heading is the title); sections are one level below. Deeper headings (e.g. "Chunk 3, pages 5 to 7") are left out. */
function docOutline() {
  const heads = [];
  doc.blocks.forEach((blk, b) => { if (/^h\d$/.test(blk.k)) heads.push({ b, lv: +blk.k[1], t: blk.w.map(plain).join(" ") }); });
  const count = {};
  heads.forEach((h) => (count[h.lv] = (count[h.lv] || 0) + 1));
  const lvs = Object.keys(count).map(Number).sort();
  const chLv = lvs.find((l) => count[l] > 1) ?? lvs[0];
  const chapters = heads.filter((h) => h.lv <= chLv), sections = heads.filter((h) => h.lv === chLv + 1);
  return { chapters, sections };
}
function lastAtOrBefore(list, b) { let r = null; for (const h of list) { if (h.b > b) break; r = h; } return r; }
function placeOf(b) { // {chapter, section} names for block b
  const ch = lastAtOrBefore(outline.chapters, b), sec = lastAtOrBefore(outline.sections, b);
  return { chapter: ch?.t || "", section: sec && (!ch || sec.b > ch.b) ? sec.t : "" };
}
// how long the voice takes from where you're reading to (b, w), at the current speed
function timeTo(b, w) {
  const from = wordsBefore[pos.b] + pos.w, to = wordsBefore[b] + w;
  if (Math.abs(to - from) < 3) return "";
  const m = Math.abs(to - from) / wordsPerMinute() + (Math.abs(b - pos.b) * PARAGRAPH_PAUSE) / 60;
  const t = m < 1 ? "under a minute" : formatMinutes(m);
  return to > from ? `in ${t}` : `${t} back`;
}
const join = (...xs) => xs.filter(Boolean).join(" · ");
function progressPins() {
  outline = docOutline();
  const total = wordsBefore[doc.blocks.length] || 1, at = (b, w) => (wordsBefore[b] + w) / total;
  const list = [{ kind: "pos", b: pos.b, w: pos.w, label: document.body.classList.contains("away") ? "Back to where you're reading" : "Where you're reading" }];
  if (wasAt && wasAt.b !== pos.b && wasAt.b < doc.blocks.length) list.push({ kind: "was", ...wasAt, label: "Where you were" });
  for (const m of doc.bookmarks || []) list.push({ kind: "bm", b: m.b, w: m.w, label: "Bookmark" });
  for (const h of outline.chapters) list.push({ kind: "ch", b: h.b, w: 0, label: h.t });
  for (const h of outline.sections) list.push({ kind: "sec", b: h.b, w: 0, label: h.t });
  for (const p of list) p.x = at(p.b, p.w);
  return list;
}
// what the tip says about a place
function describe(t) {
  const { chapter, section } = placeOf(t.b), time = timeTo(t.b, t.w);
  if (t.kind === "pos") return { label: t.label, text: join(chapter, section) };
  if (t.kind === "ch") return { label: t.label, text: time };
  if (t.kind === "sec") return { label: t.label, text: join(chapter, time) };
  if (t.kind) return { label: t.label, text: join(chapter, section, time) };
  const pct = Math.round(((wordsBefore[t.b] + t.w) / (wordsBefore[doc.blocks.length] || 1)) * 100) + "%";
  return { label: chapter || doc.title || "", text: join(section, time, pct) };
}
let scrubTarget = null;
function scrub(e) {
  if (!doc) return;
  const bar = $("#progress"), width = bar.clientWidth, px = e.clientX;
  if (!bar.classList.contains("scrub")) { // just came in: lay out the pins
    bar.classList.add("scrub");
    pins = progressPins();
    $("#progressPins").innerHTML = pins.map((p) => `<i class="pin ${p.kind}" style="left:${(p.x * 100).toFixed(3)}%"></i>`).join("");
  }
  // the nearest pin that pulls hard enough, else the paragraph under the pointer
  let best = null, bestPull = 1;
  pins.forEach((p, i) => { const pull = Math.abs(p.x * width - px) / PULL[p.kind]; if (pull <= bestPull) { best = i; bestPull = pull; } });
  const els = $("#progressPins").children;
  pins.forEach((p, i) => {
    const d = Math.abs(p.x * width - px);
    els[i].style.opacity = p.kind === "pos" ? (i === best ? 1 : 0) : Math.max(0, Math.min(1, 1 - (d - 24) / 160)).toFixed(2);
    els[i].classList.toggle("on", i === best);
  });
  const total = wordsBefore[doc.blocks.length] || 1;
  if (best !== null) scrubTarget = pins[best];
  else {
    const idx = Math.max(0, Math.min(total - 1, (px / width) * total));
    let lo = 0, hi = doc.blocks.length - 1; // the paragraph holding that word
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (wordsBefore[mid] <= idx) lo = mid; else hi = mid - 1; }
    scrubTarget = { kind: "", b: lo, w: 0, x: wordsBefore[lo] / total };
  }
  const x = best !== null ? pins[best].x * width : px;
  $("#scrubLine").style.left = x + "px";
  $("#scrubLine").className = scrubTarget.kind;
  const tip = $("#scrubTip");
  const { label, text } = describe(scrubTarget);
  tip.innerHTML = `<strong>${esc(label)}</strong>${text ? `<span>${esc(text)}</span>` : ""}`;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, x - tw / 2)) + "px";
  tip.style.top = bar.getBoundingClientRect().bottom - 16 - 30 - tip.offsetHeight + "px"; // above the lifted bar
}
function endScrub() {
  $("#progress").classList.remove("scrub");
  $("#scrubTip").hidden = true;
  scrubTarget = null;
}
$("#progress").addEventListener("pointermove", scrub);
$("#progress").addEventListener("pointerleave", endScrub);
$("#progress").addEventListener("wheel", (e) => { startBrowsing(); $("#stage").scrollTop += e.deltaY; }, { passive: true }); // the strip covers the bottom of the text: scroll it anyway
$("#progress").addEventListener("click", (e) => {
  e.stopPropagation();
  const t = scrubTarget;
  if (!t || !doc) return;
  if (t.kind === "pos") endBrowsing(); // already there, unless you'd scrolled away
  else leapTo(t.b, t.w);
  endScrub();
  scrub(e); // the pins have moved
});

// Show a word (a search match) without moving the reading position.
function lookAt(b, w) {
  document.body.classList.add("browsing");
  clearTimeout(browseTimer);
  showAround(b); // may take the reading position's part off the page; endBrowsing() brings it back
  const gone = !curBlockEl?.isConnected;
  $("#cursor").classList.toggle("gone", gone);
  $("#band").classList.toggle("gone", gone);
  const el = wordEl(b, w);
  if (!el) return;
  const stage = $("#stage"), sr = stage.getBoundingClientRect(), wr = el.getBoundingClientRect();
  const target = Math.max(0, Math.round(stage.scrollTop + wr.top - sr.top + wr.height / 2 - stage.clientHeight * 0.44));
  if (Math.abs(target - stage.scrollTop) >= 2) scrollTo(target, 0);
  updateHere();
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

/* manual scrolling: brighten everything until reading resumes. While reading goes on (hands-free, or
   holding space), the page comes back to the reading once you've stopped scrolling for a moment. */
const REFOCUS_MS = 1200; // after the last wheel event (the trackpad's coasting sends them too)
let browseTimer = null;
function startBrowsing() {
  if (programmaticScroll) return;
  document.body.classList.add("browsing");
  armRefocus();
  updateHere();
}
function armRefocus() {
  clearTimeout(browseTimer);
  if (!holding || peeking) return; // not reading, or paused to look around: stay where you scrolled
  browseTimer = setTimeout(() => {
    if (!holding || peeking || $("#reader").hidden) return;
    if (viewHeld()) return; // selecting: catchUp() does it once the selection is gone
    endBrowsing();
  }, REFOCUS_MS);
}
$("#stage").addEventListener("wheel", startBrowsing, { passive: true });
$("#stage").addEventListener("touchmove", startBrowsing, { passive: true });
function endBrowsing() {
  clearTimeout(browseTimer);
  if (!document.body.classList.contains("browsing")) return;
  document.body.classList.remove("browsing");
  setPos(pos.b, pos.w); // back to where you're reading: also trims the parts added while scrolling
  updateHere();
}

// Click a word (or the space right beside it) to read from there. The jump waits a moment, in case
// it's a double-click selecting the word (jumping first would scroll the word away from the second click).
let clickTimer = null;
$("#blocks").addEventListener("click", (e) => {
  clearTimeout(clickTimer);
  const blk = e.target.closest(".blk");
  const w = e.target.closest(".w") || (blk && wordNearPoint(e.clientX, e.clientY, blk));
  if (!w || e.detail > 1 || !getSelection().isCollapsed) return; // selecting text, not a jump
  if (e.altKey) { e.stopPropagation(); addPronFor(w.textContent); return; }
  pulseNib();
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
    if (doc && (!holding || peeking) && voiceFor(doc.lang)?.installed) fetchSeg(pos.b, segAt(pos.b, pos.w)).catch(() => {});
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
  if (!doc || !holding || peeking) return;
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
  if (!n) { setLocked(false); setStatus("The end."); holding = false; document.body.classList.remove("reading"); scheduleRest(); return; }
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
  scheduleRest();
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

/* After you let go, the focus waits a moment and then fades away, leaving only the highlighted
   word: the page reads like a normal page, to scroll around and read on your own. */
const REST_MS = 1000;
let restTimer = null;
function scheduleRest() {
  clearTimeout(restTimer);
  restTimer = setTimeout(() => { if (!holding) document.body.classList.add("rested"); }, REST_MS);
}
function wake() {
  clearTimeout(restTimer);
  document.body.classList.remove("rested");
}

function beginHold() {
  if (!doc || holding) return;
  unlockAudio();
  wake();
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
  scheduleRest();
}

/* Hands-free: double-tap space to lock reading on; tap once to stop.
   Holding space while locked pauses: scroll, click or select while you hold, and when you let go
   the page goes back to where you're reading (or to the word you clicked) and carries on. */
const TAP_MS = 280;        // shorter than this is a tap, longer is a hold
const DOUBLE_TAP_MS = 450; // max gap between the two taps
let locked = false;
let peeking = false;       // hands-free, paused while space is held
let spaceDownAt = 0, spaceIsDown = false, lastTapAt = 0;

function setLocked(on) {
  if (locked === on) return;
  locked = on;
  document.body.classList.toggle("locked", on);
  if (!on) setPeeking(false);
  setStatus(null);
}
function setPeeking(on) {
  if (peeking === on) return;
  peeking = on;
  document.body.classList.toggle("peeking", on);
  if (on) {
    clearTimeout(browseTimer);
    playToken++;
    if (playing) audio.pause();
    playing = false;
    prepare();
  }
  setStatus(null);
}

function spaceDown() {
  spaceIsDown = true;
  spaceDownAt = performance.now();
  if (locked) { setPeeking(true); return; } // pause at once: a tap stops, a hold resumes on release
  beginHold();
}

function spaceUp() {
  spaceIsDown = false;
  const now = performance.now();
  const tap = now - spaceDownAt < TAP_MS;
  if (locked) {
    lastTapAt = 0;
    if (tap) { endHold(); return; } // a tap while locked stops
    setPeeking(false);              // let go after a hold: back to reading hands-free
    if (document.body.classList.contains("browsing")) endBrowsing();
    else if (!viewHeld()) centerView(false);
    startReading();
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
    $("#hintText").innerHTML = peeking
      ? "Paused · scroll or click around · let go of <kbd>space</kbd> to carry on"
      : locked
        ? "Reading hands-free · tap <kbd>space</kbd> to stop · hold to pause"
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
  if (!e.metaKey && !e.ctrlKey && !e.repeat) hideSelPop(); // not on auto-repeat: space held to pause keeps it
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
    case "b": case "B": if (!e.repeat) startMark(e.code); break;
    case "Escape":
      if (locked) { lastTapAt = 0; endHold(); } // first stop hands-free reading, stay on the page
      else if (!$("#outline").hidden) closeOutline();
      else if (!$("#panel").hidden) closePanel();
      else if (document.body.classList.contains("away")) endBrowsing(); // back to where you're reading
      else location.hash = "";
      break;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { e.preventDefault(); if (spaceIsDown) spaceUp(); }
  if (e.code === shiftCode) stopShift();
  if (marking && e.code === marking.code) endMark();
});
// Losing focus ends hold-to-read (we'd never see the key being released),
// but hands-free reading keeps going.
// Paused hands-free (space held) stops too, rather than starting again by itself later.
const focusLost = () => { stopShift(); cancelMark(); spaceIsDown = false; if (!locked || peeking) endHold(); };

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

let pointerTimer = null, lastMouseX = NaN, lastMouseY = NaN;
window.addEventListener("mousemove", (e) => {
  if (e.clientX === lastMouseX && e.clientY === lastMouseY) return; // ignore synthetic events from auto-scroll under a still cursor
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  document.body.classList.add("pointer-active");
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => {
    document.body.classList.remove("pointer-active");
    if (document.body.classList.contains("reading") && !peeking) clearPeekBlock();
  }, 1500);
});

/* ------------------------------------------------------------------ pointer & tactile scout */

const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let customPtr = false;
function syncCustomPointer() {
  customPtr = finePointer.matches && !reducedMotion.matches;
  document.body.classList.toggle("ptr-custom", customPtr);
  if (!customPtr) hideStagePointer();
}
finePointer.addEventListener("change", syncCustomPointer);
reducedMotion.addEventListener("change", syncCustomPointer);

let ptrDown = false, ptrSelecting = false, ptrInStage = false, downX = 0, downY = 0;
let px = 0, py = 0;
let hx = 0, hy = 0, hvx = 0, hvy = 0, hAng = 0, haloReady = false, haloOn = false;
let sx = 0, sy = 0, sw = 0, sh = 0, svx = 0, svy = 0, svw = 0, svh = 0;
let stx = 0, sty = 0, stw = 0, sth = 0, scoutReady = false, scoutOn = false;
let hoverWord = null, hoverBlk = null, pendingBlk = null, hoverBm = false;
let ptrWordVisual = false, ptrSettled = false;
let peekTimer = null, nibGraceTimer = null, nibSettleTimer = null;
let ptrFrame = 0, ptrLastT = 0;
const wakeTimers = new Map();

// 8-segment closed cubic Bézier shapes (50 numbers each) aligned clockwise from top (Seg 0=top, 2=right, 4=bottom, 6=left)
// so #ptrNib liquid-morphs cleanly with zero twisting: dot ↔ right-pointing playhead ↔ vertical caret / bookmark pill.
const NIB_DOT = [-1.15, -2.77, -0.41, -3.08, 0.41, -3.08, 1.15, -2.77, 1.88, -2.47, 2.47, -1.88, 2.77, -1.15, 3.08, -0.41, 3.08, 0.41, 2.77, 1.15, 2.47, 1.88, 1.88, 2.47, 1.15, 2.77, 0.41, 3.08, -0.41, 3.08, -1.15, 2.77, -1.88, 2.47, -2.47, 1.88, -2.77, 1.15, -3.08, 0.41, -3.08, -0.41, -2.77, -1.15, -2.47, -1.88, -1.88, -2.47, -1.15, -2.77];
// Soft-rounded right-pointing playhead (~8.2w × 9.3h): flat back edge sits just behind hotspot (-2.0), pointing forward (+6.2)
const NIB_PLAY = [-2.0, -3.55, -2.0, -4.39, -1.55, -4.65, -0.82, -4.24, 1.36, -3.03, 3.53, -1.82, 5.71, -0.61, 6.38, -0.23, 6.38, 0.23, 5.71, 0.61, 3.53, 1.82, 1.36, 3.03, -0.82, 4.24, -1.55, 4.65, -2.0, 4.39, -2.0, 3.55, -2.0, 2.76, -2.0, 1.97, -2.0, 1.18, -2.0, 0.39, -2.0, -0.39, -2.0, -1.18, -2.0, -1.97, -2.0, -2.76, -2.0, -3.55];
function fillPillPts(out, w, h, bend = 0) {
  const rx = w / 2, ry = Math.min(rx, h / 2), yT = -h / 2 + ry, yB = h / 2 - ry, ha = (4 / 3) * ry;
  const y1 = yT + (yB - yT) / 3, y2 = yT + 2 * (yB - yT) / 3;
  const half = Math.max(1, h / 2);
  const bx = (y) => bend * (y / half) * (y / half);
  const dbx = (y) => (2 * bend * y) / (half * half);
  let k = 0;
  const put = (x, y) => { out[k++] = x; out[k++] = y; };
  const seg = (sx, ya, yb) => {
    const dy = yb - ya;
    const xa = sx + bx(ya), xb = sx + bx(yb);
    put(xa + (dbx(ya) * dy) / 3, ya + dy / 3);
    put(xb - (dbx(yb) * dy) / 3, yb - dy / 3);
    put(xb, yb);
  };
  const bxT = bx(yT), bxB = bx(yB);
  const capT = dbx(yT) * ha, capB = dbx(yB) * ha;
  put(-rx + bxT, yT);
  put(-rx + bxT - capT, yT - ha);
  put(rx + bxT - capT, yT - ha);
  put(rx + bxT, yT);
  seg(rx, yT, y1); seg(rx, y1, y2); seg(rx, y2, yB);
  put(rx + bxB + capB, yB + ha);
  put(-rx + bxB + capB, yB + ha);
  put(-rx + bxB, yB);
  seg(-rx, yB, y2); seg(-rx, y2, y1); seg(-rx, y1, yT);
  return out;
}
const makePillPts = (w, h, bend = 0) => fillPillPts(new Array(50), w, h, bend);
const NIB_BM = makePillPts(3.5, 14);
const caretPts = new Array(50);
let caretBaseH = 0;
const nibCur = NIB_DOT.slice();
const nibVel = new Float32Array(50);
let nibTarget = NIB_DOT;
let nibShapeKey = "dot";
let nibStiff = 520, nibDamp = 38;

function applyNibPath() {
  let d = `M${nibCur[0].toFixed(2)},${nibCur[1].toFixed(2)}`;
  for (let i = 2; i < 50; i += 6) {
    d += `C${nibCur[i].toFixed(2)},${nibCur[i + 1].toFixed(2)} ${nibCur[i + 2].toFixed(2)},${nibCur[i + 3].toFixed(2)} ${nibCur[i + 4].toFixed(2)},${nibCur[i + 5].toFixed(2)}`;
  }
  $("#ptrNibPath").setAttribute("d", d + "Z");
}
function setNibShape(key, pts, stiff = 520, damp = 38) {
  if (key === nibShapeKey && pts === nibTarget) return;
  nibShapeKey = key;
  nibTarget = pts;
  nibStiff = stiff;
  nibDamp = damp;
  if (reducedMotion.matches) {
    for (let i = 0; i < 50; i++) { nibCur[i] = pts[i]; nibVel[i] = 0; }
    applyNibPath();
  } else {
    kickPointerLoop();
  }
}
applyNibPath();

function springStep(cur, vel, target, stiffness, damping, dt) {
  const acc = (target - cur) * stiffness - vel * damping;
  vel += acc * dt;
  cur += vel * dt;
  return [cur, vel];
}

function rectDist(rc, x, y) {
  const dx = x < rc.left ? rc.left - x : x > rc.right ? x - rc.right : 0;
  const dy = y < rc.top ? rc.top - y : y > rc.bottom ? y - rc.bottom : 0;
  return [dx, dy];
}

// Find the closest word inside blk to viewport point (x, y) within a small magnetic radius,
// so gliding across spaces between words never drops out or flickers to an I-beam.
function wordNearPoint(x, y, blk) {
  if (!blk || !blk.isConnected) return null;
  const b = +blk.dataset.b;
  if (Number.isNaN(b)) return null;
  wordEl(b, 0);
  const words = wordElCache.get(b);
  if (!words || !words.length) return null;
  const fs = settings.size * (blk.classList.contains("k-h1") ? 1.2 : blk.classList.contains("k-h2") ? 1.1 : 1);
  const maxDx = fs * 1.15, maxDy = fs * 0.65;

  const scoreWord = (el) => {
    let best = Infinity;
    for (const rc of el.getClientRects()) {
      const [dx, dy] = rectDist(rc, x, y);
      if (dx <= maxDx && dy <= maxDy) {
        const d = dx * dx + (dy * 2.2) * (dy * 2.2);
        if (d < best) best = d;
      }
    }
    return best;
  };

  // Fast path: horizontal sweep between adjacent words on the same line
  if (hoverWord && hoverWord.parentElement === blk) {
    const wi = +hoverWord.dataset.i;
    let bestEl = null, bestD = Infinity;
    for (const idx of [wi, wi - 1, wi + 1]) {
      if (idx < 0 || idx >= words.length) continue;
      const d = scoreWord(words[idx]);
      if (d < bestD) { bestD = d; bestEl = words[idx]; }
    }
    if (bestEl && bestD <= (fs * 0.7) * (fs * 0.7)) return bestEl;
  }

  let bestEl = null, bestD = Infinity;
  for (const el of words) {
    const d = scoreWord(el);
    if (d < bestD) { bestD = d; bestEl = el; }
  }
  return bestEl;
}

function wordBox(el, pyHint, fullPill = false) {
  const docRect = $("#doc").getBoundingClientRect();
  const rects = el.getClientRects();
  let r = rects[0] || el.getBoundingClientRect();
  if (rects.length > 1 && pyHint != null) {
    let bestD = Infinity;
    for (const rc of rects) {
      const d = Math.abs((rc.top + rc.bottom) / 2 - pyHint);
      if (d < bestD) { bestD = d; r = rc; }
    }
  }
  const blk = el.closest(".blk");
  const fs = settings.size * (blk?.classList.contains("k-h1") ? 1.2 : blk?.classList.contains("k-h2") ? 1.1 : 1);
  const isReveal = fullPill || settings.guide === "reveal";
  const padX = (isReveal ? 0.16 : 0.04) * fs;
  const padY = 0.05 * fs;
  const pacerH = Math.max(2.5, Math.round(fs * 0.13 * 2) / 2);
  return {
    x: r.left - docRect.left - padX,
    y: isReveal ? r.top - docRect.top - padY : r.bottom - docRect.top,
    w: r.width + padX * 2,
    h: isReveal ? r.height + padY * 2 : Math.max(1.5, Math.round(pacerH * 0.6 * 2) / 2),
  };
}

function wakeWord(el) {
  if (!el || !el.isConnected || reducedMotion.matches || ptrSelecting || document.body.classList.contains("reading")) return;
  if (Math.hypot(hvx, hvy) < 700) return; // only fill the gap on fast sweeps; never strobe at reading speed
  const prev = wakeTimers.get(el);
  if (prev) clearTimeout(prev);
  el.classList.add("ptr-wake");
  wakeTimers.set(el, setTimeout(() => {
    el.classList.remove("ptr-wake");
    wakeTimers.delete(el);
  }, 110));
}

let nibPulseTimer = null;
function pulseNib() {
  if (!customPtr || reducedMotion.matches) return;
  const nib = $("#ptrNib");
  nib.classList.remove("pulse");
  void nib.offsetWidth; // restart animation cleanly on rapid clicks
  nib.classList.add("pulse");
  clearTimeout(nibPulseTimer);
  nibPulseTimer = setTimeout(() => nib.classList.remove("pulse"), 160);
}

function clearPeekBlock() {
  clearTimeout(peekTimer);
  peekTimer = null;
  pendingBlk = null;
  if (hoverBlk) { hoverBlk.classList.remove("ptr-blk"); hoverBlk = null; }
}

function schedulePeekBlock(blk) {
  if (!blk) { clearPeekBlock(); return; }
  if (blk === hoverBlk) { clearTimeout(peekTimer); peekTimer = null; pendingBlk = null; return; }
  if (blk === pendingBlk) return;
  clearTimeout(peekTimer);
  pendingBlk = blk;
  peekTimer = setTimeout(() => {
    peekTimer = null;
    if (pendingBlk !== blk || !blk.isConnected || !ptrInStage || ptrSelecting) return;
    hoverBlk?.classList.remove("ptr-blk");
    hoverBlk = blk;
    hoverBlk.classList.add("ptr-blk");
    pendingBlk = null;
  }, 220);
}

function clearNibTimers() {
  clearTimeout(nibGraceTimer);
  nibGraceTimer = null;
  clearTimeout(nibSettleTimer);
  nibSettleTimer = null;
  if (ptrSettled) { ptrSettled = false; $("#ptrNib").classList.remove("settled"); }
}

function armNibSettle() {
  clearTimeout(nibSettleTimer);
  nibSettleTimer = null;
  if (ptrSettled) { ptrSettled = false; $("#ptrNib").classList.remove("settled"); }
  if (!customPtr || !hoverWord || hoverWord === nowEl || ptrDown || ptrSelecting || hoverBm) return;
  nibSettleTimer = setTimeout(() => {
    nibSettleTimer = null;
    if (hoverWord && hoverWord !== nowEl && ptrInStage && !ptrDown && !ptrSelecting && !hoverBm) {
      ptrSettled = true;
      $("#ptrNib").classList.add("settled");
    }
  }, 500);
}

function syncScoutWithCursor() {
  const show = !!(hoverWord && hoverWord !== nowEl && !ptrSelecting && !hoverBm);
  scoutOn = show;
  const scout = $("#scout");
  scout.classList.toggle("on", show);
  scout.classList.toggle("press", !!(show && ptrDown && !reducedMotion.matches));
  if (customPtr && ptrWordVisual && !ptrSelecting && !hoverBm) {
    $("#ptrNib").classList.toggle("now-word", hoverWord === nowEl);
  }
}

function applyScoutNow() {
  const el = $("#scout");
  el.style.transform = `translate3d(${sx.toFixed(2)}px, ${sy.toFixed(2)}px, 0)`;
  el.style.width = sw.toFixed(2) + "px";
  el.style.height = sh.toFixed(2) + "px";
}

function refreshScout(snap = false) {
  if (!hoverWord || !hoverWord.isConnected) return;
  const box = wordBox(hoverWord, py);
  stx = box.x; sty = box.y; stw = box.w; sth = box.h;
  if (snap || !scoutReady || !scoutOn || Math.hypot(stx - sx, sty - sy) > 280) {
    sx = stx; sy = sty; sw = stw; sh = sth;
    svx = svy = svw = svh = 0;
    scoutReady = true;
    applyScoutNow();
  } else {
    kickPointerLoop();
  }
}

function setHoverWord(w, pyHint) {
  if (w === hoverWord) {
    if (w && !hoverBlk && !pendingBlk) schedulePeekBlock(w.closest(".blk"));
    syncScoutWithCursor();
    return;
  }
  const prev = hoverWord;
  prev?.classList.remove("ptr-hover");
  if (prev && w) wakeWord(prev); // trailing wake on fast sweeps; never fires on the word where you stop
  hoverWord = w;
  const blk = w ? w.closest(".blk") : null;
  schedulePeekBlock(blk);
  if (w) {
    w.classList.add("ptr-hover");
    const box = wordBox(w, pyHint);
    const wasOff = !scoutOn || !scoutReady;
    stx = box.x; sty = box.y; stw = box.w; sth = box.h;
    if (wasOff || Math.hypot(stx - sx, sty - sy) > 280 || reducedMotion.matches) {
      sx = stx; sy = sty; sw = stw; sh = sth;
      svx = svy = svw = svh = 0;
      scoutReady = true;
      applyScoutNow();
    } else {
      kickPointerLoop();
    }
  }
  syncScoutWithCursor();
}

function setSelecting(on) {
  if (ptrSelecting === on) return;
  ptrSelecting = on;
  document.body.classList.toggle("ptr-selecting", on);
  if (on) {
    clearNibTimers();
    ptrWordVisual = false;
    setHoverWord(null);
    hoverBm = false;
  } else {
    caretBaseH = 0;
  }
}

function hideStagePointer() {
  ptrInStage = false;
  ptrWordVisual = false;
  caretBaseH = 0;
  clearNibTimers();
  clearTimeout(nibPulseTimer);
  document.body.classList.remove("ptr-live");
  $("#ptrNib").classList.remove("on", "word", "down", "caret", "bm", "settled", "now-word", "pulse");
  $("#ptrNibSquash").setAttribute("transform", "");
  $("#ptrHalo").classList.remove("on", "down");
  $("#scout").classList.remove("press");
  nibShapeKey = "dot";
  nibTarget = NIB_DOT;
  for (let i = 0; i < 50; i++) { nibCur[i] = NIB_DOT[i]; nibVel[i] = 0; }
  applyNibPath();
  haloOn = false;
  haloReady = false;
  hoverBm = false;
  setHoverWord(null);
  clearPeekBlock();
}

function resetPointerHover() {
  setSelecting(false);
  ptrDown = false;
  scoutReady = false;
  hideStagePointer();
  for (const [el, t] of wakeTimers) { clearTimeout(t); el.classList.remove("ptr-wake"); }
  wakeTimers.clear();
}

function kickPointerLoop() {
  if (ptrFrame || reducedMotion.matches) return;
  ptrLastT = performance.now();
  ptrFrame = requestAnimationFrame(stepPointer);
}

function stepPointer(now) {
  ptrFrame = 0;
  const dt = Math.min(0.032, Math.max(0.001, (now - ptrLastT) / 1000));
  ptrLastT = now;
  let active = false;

  if (customPtr && haloReady) {
    [hx, hvx] = springStep(hx, hvx, px, 275, 26, dt);
    [hy, hvy] = springStep(hy, hvy, py, 275, 26, dt);
    const spd = Math.hypot(hvx, hvy);
    if (spd > 12) hAng = Math.atan2(hvy, hvx);
    const stretch = Math.min(0.4, Math.max(0, spd - 60) / 1850);
    const base = ptrDown ? 0.84 : 1;
    const scaleX = base * (1 + stretch);
    const scaleY = base * (1 - stretch * 0.44);
    $("#ptrHalo").style.transform = `translate3d(${hx.toFixed(2)}px, ${hy.toFixed(2)}px, 0) rotate(${hAng.toFixed(3)}rad) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
    // Subtle directional squash-and-stretch (±8% max) on the playhead while sweeping across words,
    // keeping ▸ strictly oriented rightward via rotate(a) scale(sx, sy) rotate(-a)
    const squashEl = $("#ptrNibSquash");
    if (ptrWordVisual && !ptrSelecting && !hoverBm && spd > 80) {
      const ns = Math.min(0.08, (spd - 80) / 3000);
      const deg = (hAng * 180) / Math.PI;
      squashEl.setAttribute("transform", `rotate(${deg.toFixed(1)}) scale(${(1 + ns).toFixed(3)}, ${(1 - ns * 0.6).toFixed(3)}) rotate(${(-deg).toFixed(1)})`);
    } else if (squashEl.getAttribute("transform")) {
      squashEl.setAttribute("transform", "");
    }
    if (Math.abs(px - hx) > 0.08 || Math.abs(py - hy) > 0.08 || spd > 0.8) active = true;
  }

  if (customPtr) {
    if (ptrSelecting && nibShapeKey === "caret" && caretBaseH > 0 && !reducedMotion.matches) {
      // Subtle liquid bend & stretch while dragging to select text: center stays pinned on the pointer
      const bend = -Math.tanh(hvx / 460) * 2.55;
      const vStretch = Math.tanh(Math.abs(hvy) / 600) * 0.17;
      const hSquash = Math.tanh(Math.abs(hvx) / 760) * 0.068;
      const eh = Math.min(54, caretBaseH * (1 + vStretch - hSquash));
      const ew = 1.8 * (1 - vStretch * 0.35 + hSquash * 0.45);
      fillPillPts(caretPts, ew, eh, bend);
      nibTarget = caretPts;
    }
    let nibMoving = false;
    for (let i = 0; i < 50; i++) {
      const acc = (nibTarget[i] - nibCur[i]) * nibStiff - nibVel[i] * nibDamp;
      nibVel[i] += acc * dt;
      nibCur[i] += nibVel[i] * dt;
      if (Math.abs(nibTarget[i] - nibCur[i]) > 0.02 || Math.abs(nibVel[i]) > 0.25) nibMoving = true;
    }
    if (nibMoving) { applyNibPath(); active = true; }
    else {
      let dirty = false;
      for (let i = 0; i < 50; i++) {
        if (nibCur[i] !== nibTarget[i]) { nibCur[i] = nibTarget[i]; dirty = true; }
        nibVel[i] = 0;
      }
      if (dirty) applyNibPath();
    }
  }

  if (scoutOn && scoutReady) {
    [sx, svx] = springStep(sx, svx, stx, 460, 38, dt);
    [sy, svy] = springStep(sy, svy, sty, 460, 38, dt);
    [sw, svw] = springStep(sw, svw, stw, 460, 38, dt);
    [sh, svh] = springStep(sh, svh, sth, 460, 38, dt);
    applyScoutNow();
    if (
      Math.abs(stx - sx) > 0.08 || Math.abs(sty - sy) > 0.08 ||
      Math.abs(stw - sw) > 0.08 || Math.abs(sth - sh) > 0.08 ||
      Math.abs(svx) > 0.8 || Math.abs(svy) > 0.8 || Math.abs(svw) > 0.8 || Math.abs(svh) > 0.8
    ) active = true;
  }

  if (active) ptrFrame = requestAnimationFrame(stepPointer);
}

function blockFontSize(blk) {
  return settings.size * (blk?.classList.contains("k-h1") ? 1.2 : blk?.classList.contains("k-h2") ? 1.1 : 1);
}

function applyStageTarget(target, altKey) {
  const inStage = !!(target && target.closest && target.closest("#stage"));
  if (!inStage) { hideStagePointer(); return; }
  ptrInStage = true;

  const activeBlk = target.closest(".blk") || hoverBlk || pendingBlk;
  if (ptrDown && !ptrSelecting && (Math.hypot(px - downX, py - downY) > 4 || hasSelection())) {
    setSelecting(true);
  }

  const nib = $("#ptrNib");
  const halo = $("#ptrHalo");
  if (customPtr) {
    document.body.classList.add("ptr-live");
    nib.style.transform = `translate3d(${px}px, ${py}px, 0)`;
    if (!haloReady) {
      hx = px; hy = py; hvx = hvy = 0; haloReady = true;
      halo.style.transform = `translate3d(${hx}px, ${hy}px, 0)`;
    }
  }

  if (ptrSelecting) {
    setHoverWord(null);
    hoverBm = false;
    if (customPtr) {
      if (activeBlk || !caretBaseH) caretBaseH = Math.min(50, Math.round(blockFontSize(activeBlk) * 1.1));
      if (nibShapeKey !== "caret") {
        fillPillPts(caretPts, 1.8, caretBaseH, 0);
        setNibShape("caret", caretPts, 400, 34);
      }
      nib.className = "ptr-nib on caret";
      halo.classList.remove("on", "down");
      haloOn = false;
    }
  } else if (target.closest(".bm-bar")) {
    clearNibTimers();
    ptrWordVisual = false;
    setHoverWord(null);
    hoverBm = true;
    if (customPtr) {
      setNibShape("bm", NIB_BM, 520, 38);
      nib.className = "ptr-nib on bm";
      halo.classList.remove("on", "down");
      haloOn = false;
    }
  } else {
    hoverBm = false;
    const direct = target.closest(".w");
    const blk = direct ? direct.closest(".blk") : target.closest(".blk");
    const w = direct || (blk && wordNearPoint(px, py, blk));
    setHoverWord(w, py);
    if (altKey != null) $("#scout").classList.toggle("alt", !!altKey);
    if (customPtr) {
      if (w) {
        clearTimeout(nibGraceTimer);
        nibGraceTimer = null;
        ptrWordVisual = true;
        setNibShape("play", NIB_PLAY, 480, 34);
        const pulse = nib.classList.contains("pulse") ? " pulse" : "";
        nib.className = "ptr-nib on word" + (w === nowEl ? " now-word" : "") + (ptrDown ? " down" : "") + pulse;
        haloOn = false;
        halo.classList.remove("on", "down");
        armNibSettle();
      } else {
        clearTimeout(nibSettleTimer);
        nibSettleTimer = null;
        if (ptrSettled) { ptrSettled = false; nib.classList.remove("settled"); }
        // Hold the playhead briefly across paragraph gaps so it doesn't flicker dot→▸→dot
        if (ptrWordVisual && !nibGraceTimer) {
          nibGraceTimer = setTimeout(() => {
            nibGraceTimer = null;
            if (!hoverWord && ptrInStage && !ptrSelecting && !hoverBm) {
              ptrWordVisual = false;
              setNibShape("dot", NIB_DOT, 340, 32);
              nib.className = "ptr-nib on" + (ptrDown ? " down" : "");
              haloOn = true;
              halo.classList.add("on");
              halo.classList.toggle("down", ptrDown);
            }
          }, 120);
        } else if (!ptrWordVisual) {
          setNibShape("dot", NIB_DOT, 340, 32);
        }
        const pulse = nib.classList.contains("pulse") ? " pulse" : "";
        nib.className = "ptr-nib on" + (ptrWordVisual ? " word" : "") + (ptrDown ? " down" : "") + pulse;
        const showHalo = !ptrWordVisual;
        haloOn = showHalo;
        halo.classList.toggle("on", showHalo);
        halo.classList.toggle("down", ptrDown);
      }
    }
  }
  kickPointerLoop();
}

function updateStagePointer(e) {
  if (e.pointerType === "touch") return;
  if (!doc || $("#reader").hidden) { hideStagePointer(); return; }
  // Ignore synthetic pointermove fired when auto-scroll shifts text beneath a stationary pointer
  if (e.type === "pointermove" && e.clientX === px && e.clientY === py &&
      document.body.classList.contains("reading") && !document.body.classList.contains("pointer-active") && !peeking) {
    return;
  }
  px = e.clientX;
  py = e.clientY;
  applyStageTarget(e.target, e.altKey);
}

let ptrScrollFrame = 0;
$("#stage").addEventListener("scroll", () => {
  if (programmaticScroll || !ptrInStage || ptrSelecting || !doc || $("#reader").hidden) return;
  if (document.body.classList.contains("reading") && !document.body.classList.contains("pointer-active") && !peeking) return;
  ptrScrollFrame ||= requestAnimationFrame(() => {
    ptrScrollFrame = 0;
    if (programmaticScroll || !ptrInStage || ptrSelecting || !doc || $("#reader").hidden) return;
    if (document.body.classList.contains("reading") && !document.body.classList.contains("pointer-active") && !peeking) return;
    const hit = document.elementFromPoint(px, py);
    if (hit) applyStageTarget(hit, null);
  });
}, { passive: true });

window.addEventListener("pointermove", updateStagePointer, { passive: true });
$("#stage").addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch" || e.button !== 0) return;
  ptrDown = true;
  downX = e.clientX;
  downY = e.clientY;
  setSelecting(false);
  updateStagePointer(e);
});
window.addEventListener("pointerup", (e) => {
  if (!ptrDown && !ptrSelecting) return;
  ptrDown = false;
  setSelecting(false);
  if (e.pointerType !== "touch") updateStagePointer(e);
});
document.addEventListener("pointerleave", hideStagePointer);
window.addEventListener("blur", () => { ptrDown = false; setSelecting(false); hideStagePointer(); });
window.addEventListener("keydown", (e) => { if (e.key === "Alt") $("#scout").classList.add("alt"); });
window.addEventListener("keyup", (e) => { if (e.key === "Alt") $("#scout").classList.remove("alt"); });
syncCustomPointer();

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
  if (name === "size" || name === "font" || name === "focus" || name === "guide" || name === "width") requestAnimationFrame(() => { resetLine(); placeCursor(true); centerView(true); markBookmarks(); refreshScout(true); });
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
  leapTo(+btn.dataset.b, +(btn.dataset.w || 0));
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

/* Hold B: the bookmark starts at the word being read and grows with the reading until you let go,
   like selecting the passage. A tap bookmarks the sentence. */
let marking = null; // {code, at, b, w, els, timer}
function startMark(code) {
  cancelMark();
  marking = { code, at: performance.now(), b: pos.b, w: pos.w, els: [] };
  marking.timer = setTimeout(() => { // a hold, not a tap: show what's being marked
    if (!marking) return;
    marking.shown = true;
    paintMark();
    flash("Bookmarking · let go of B to save", 60000);
  }, TAP_MS);
}
function markRange(m) { // [first, last] in reading order
  const a = { b: m.b, w: m.w }, z = { b: pos.b, w: pos.w };
  return a.b < z.b || (a.b === z.b && a.w <= z.w) ? [a, z] : [z, a];
}
function paintMark() {
  if (!marking.shown) return;
  marking.els.forEach((el) => el.classList.remove("marking"));
  marking.els = [];
  const [a, z] = markRange(marking);
  for (let b = a.b; b <= z.b; b++) {
    if (!blockEl(b)) continue;
    wordEl(b, 0);
    const words = wordElCache.get(b);
    const to = b === z.b ? z.w : words.length - 1;
    for (let w = b === a.b ? a.w : 0; w <= to; w++) { words[w].classList.add("marking"); marking.els.push(words[w]); }
  }
}
function cancelMark() {
  if (!marking) return;
  clearTimeout(marking.timer);
  marking.els.forEach((el) => el.classList.remove("marking"));
  if (marking.shown) { flashUntil = 0; setStatus(null); }
  marking = null;
}
function endMark() {
  const m = marking, held = m.shown;
  const [a, z] = markRange(m);
  cancelMark();
  if (!held || (a.b === z.b && a.w === z.w)) { bookmarkHere(); return; } // a tap, or nothing was read meanwhile
  const words = [];
  for (let b = a.b; b <= z.b; b++) words.push(...doc.blocks[b].w.slice(b === a.b ? a.w : 0, b === z.b ? z.w + 1 : undefined).map(plain));
  addBookmark(a.b, a.w, words.join(" "))
    .then(() => flash(`Bookmarked ${words.length} words · find it under contents (O)`, 2000))
    .catch((err) => flash(err.message));
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
const selGlide = selPop.querySelector(".sel-glide");
let selAnchor = null; // pointer coordinates when selection finished
let selPlace = null;  // active placement mode, kept stable while scrolling
let selShownAt = 0;   // timestamp when #selPop appeared (brief grace before proximity dimming)
let selLocked = false; // keep full clarity briefly during post-click confirmation
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rectPointDist = (x, y, rx, ry, rw, rh) => {
  const dx = x < rx ? rx - x : x > rx + rw ? x - (rx + rw) : 0;
  const dy = y < ry ? ry - y : y > ry + rh ? y - (ry + rh) : 0;
  return Math.hypot(dx, dy);
};
function selectionEndBlock(s) {
  const endNode = s.range.endContainer;
  const endBlkEl = (endNode.nodeType === 1 ? endNode : endNode.parentElement)?.closest(".blk");
  return endBlkEl && +endBlkEl.dataset.b >= s.b ? +endBlkEl.dataset.b : s.b;
}
function clearSelPreview() {
  document.body.classList.remove("sel-copy-hover");
  document.querySelectorAll(".bm-bar.preview").forEach((el) => el.remove());
  document.querySelectorAll(".blk.bm-preview").forEach((el) => el.classList.remove("bm-preview"));
}
function previewBookmarkSelection() {
  clearSelPreview();
  const s = selectedWords();
  if (!s) return;
  const endB = selectionEndBlock(s);
  const bars = [];
  for (let b = s.b; b <= endB; b++) {
    const el = blockEl(b);
    if (!el) continue;
    wordEl(b, 0);
    const ws = wordElCache.get(b) || [];
    let first = null, last = null;
    for (const w of ws) {
      if (s.range.intersectsNode(w)) { if (!first) first = w; last = w; }
    }
    if (!first || !last) continue;
    const fr = first.getClientRects()[0], lr = last.getClientRects();
    if (!fr || !lr.length) continue;
    const box = el.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(el).fontSize) * 0.12;
    const top = fr.top - box.top + inset;
    const bottom = lr[lr.length - 1].bottom - box.top - inset;
    bars.push({ el, top, height: Math.max(4, bottom - top) });
  }
  for (const { el, top, height } of bars) {
    el.classList.add("bm-preview");
    const bar = document.createElement("i");
    bar.className = "bm-bar preview";
    bar.style.top = top + "px";
    bar.style.height = height + "px";
    el.append(bar);
  }
}
function moveSelGlide(btn) {
  if (!btn) { selGlide.classList.remove("on"); return; }
  const first = !selGlide.classList.contains("on");
  selGlide.classList.toggle("jump", first);
  selGlide.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
  selGlide.style.width = btn.offsetWidth + "px";
  selGlide.style.height = btn.offsetHeight + "px";
  if (first) void selGlide.offsetWidth;
  selGlide.classList.add("on");
}
function updateSelProximity(x, y) {
  if (selPop.hidden || selPop.classList.contains("offscreen")) return;
  if (selLocked || performance.now() - selShownAt < 900) {
    selPop.style.setProperty("--pop-o", "1");
    selPop.style.setProperty("--pop-s", "1");
    return;
  }
  const rc = selPop.getBoundingClientRect();
  const d = rectPointDist(x, y, rc.left, rc.top, rc.width, rc.height);
  const t = clamp((d - 28) / 232, 0, 1);
  selPop.style.setProperty("--pop-o", (1 - t * 0.46).toFixed(3));
  selPop.style.setProperty("--pop-s", (1 - t * 0.025).toFixed(4));
}
function blockInlineBounds(b) {
  const el = blockEl(b);
  if (!el) return null;
  wordEl(b, 0);
  const ws = wordElCache.get(b);
  const first = ws?.[0], last = ws?.[ws.length - 1];
  const fr = first?.getClientRects()[0];
  const lrs = last?.getClientRects(), lr = lrs?.[lrs.length - 1];
  const br = el.getBoundingClientRect();
  return { top: fr ? fr.top : br.top, bottom: lr ? lr.bottom : br.bottom };
}
function collectSelCandidates({ s, r, anchorRect, refX, refY, hw, hh, measureStack, col, padEdge, safeTop, safeBot }) {
  const endB = selectionEndBlock(s);
  const startBounds = blockInlineBounds(s.b);
  const endBounds = blockInlineBounds(endB) || startBounds;
  const prevBounds = s.b > 0 ? blockInlineBounds(s.b - 1) : null;
  const nextBounds = endB + 1 < doc.blocks.length ? blockInlineBounds(endB + 1) : null;

  const candidates = [];
  const add = (mode, x, y, w, h, stack, animX, animY) => {
    candidates.push({ mode, x, y, w, h, stack, over: false, animX, animY, dist: rectPointDist(refX, refY, x, y, w, h) });
  };

  // 1. Inter-paragraph gap above the selection's starting paragraph
  if (startBounds) {
    const bandTop = prevBounds ? prevBounds.bottom + 1 : Math.max(safeTop, startBounds.top - hh - 24);
    const bandBot = startBounds.top - 1;
    const clampedTop = Math.max(safeTop, bandTop);
    const gapH = bandBot - clampedTop;
    if (gapH >= hh && bandBot <= safeBot) {
      const y = prevBounds ? clampedTop + (gapH - hh) / 2 : Math.max(safeTop, bandBot - hh - 8);
      const x = clamp(clamp(refX, r.left, r.right) - hw / 2, padEdge, innerWidth - hw - padEdge);
      add("above", x, y, hw, hh, false, 0, 4);
    }
  }

  // 2. Inter-paragraph gap below the selection's ending paragraph
  if (endBounds) {
    const bandTop = endBounds.bottom + 1;
    const bandBot = nextBounds ? nextBounds.top - 1 : Math.min(safeBot, bandTop + hh + 24);
    const clampedBot = Math.min(safeBot, bandBot);
    const gapH = clampedBot - bandTop;
    if (gapH >= hh && bandTop >= safeTop) {
      const y = nextBounds ? bandTop + (gapH - hh) / 2 : Math.min(safeBot - hh, bandTop + 8);
      const x = clamp(clamp(refX, r.left, r.right) - hw / 2, padEdge, innerWidth - hw - padEdge);
      add("below", x, y, hw, hh, false, 0, -4);
    }
  }

  // 3. Trailing whitespace at the end of a short line (no words to the right on that line, clear of adjacent lines)
  const midY = (anchorRect.top + anchorRect.bottom) / 2;
  let anchorBlk = s.b;
  for (let b = s.b; b <= endB; b++) {
    const bounds = blockInlineBounds(b);
    if (bounds && midY >= bounds.top - 4 && midY <= bounds.bottom + 4) { anchorBlk = b; break; }
  }
  if (blockEl(anchorBlk)) {
    wordEl(anchorBlk, 0);
    const ws = wordElCache.get(anchorBlk) || [];
    const tol = Math.max(8, anchorRect.height * 0.55);
    const aPrev = anchorBlk > 0 ? blockInlineBounds(anchorBlk - 1) : null;
    const aNext = anchorBlk + 1 < doc.blocks.length ? blockInlineBounds(anchorBlk + 1) : null;
    let lineRight = anchorRect.right, aboveBot = aPrev ? aPrev.bottom : -Infinity, belowTop = aNext ? aNext.top : Infinity;
    for (const el of ws) {
      for (const rc of el.getClientRects()) {
        const cy = (rc.top + rc.bottom) / 2;
        if (Math.abs(cy - midY) < tol) {
          if (rc.right > lineRight) lineRight = rc.right;
        } else if (cy < midY && rc.bottom > aboveBot) {
          aboveBot = rc.bottom;
        } else if (cy > midY && rc.top < belowTop) {
          belowTop = rc.top;
        }
      }
    }
    const inlineX = lineRight + 14;
    const inlineY = midY - hh / 2;
    if (inlineX + hw <= innerWidth - padEdge && inlineY >= safeTop && inlineY + hh <= safeBot &&
        inlineY >= aboveBot + 1 && inlineY + hh <= belowTop - 1) {
      add("inline", inlineX, inlineY, hw, hh, false, -4, 0);
    }
  }

  // 4. Right page margin beside the selection
  const rightStart = col.right + 16;
  const rightSpace = innerWidth - padEdge - rightStart;
  if (hw <= rightSpace) {
    add("right", rightStart, clamp(refY - hh / 2, safeTop, safeBot - hh), hw, hh, false, -4, 0);
  } else {
    const { sw, sh } = measureStack();
    if (sw <= rightSpace) add("right", rightStart, clamp(refY - sh / 2, safeTop, safeBot - sh), sw, sh, true, -4, 0);
  }

  // 5. Left page margin beside the selection (clears .bm-bar at -21px)
  const leftEnd = col.left - 24;
  const leftSpace = leftEnd - padEdge;
  if (hw <= leftSpace) {
    add("left", leftEnd - hw, clamp(refY - hh / 2, safeTop, safeBot - hh), hw, hh, false, 4, 0);
  } else {
    const { sw, sh } = measureStack();
    if (sw <= leftSpace) add("left", leftEnd - sw, clamp(refY - sh / 2, safeTop, safeBot - sh), sw, sh, true, 4, 0);
  }

  return candidates;
}
function showSelPop(isScroll = false) {
  const s = selectedWords();
  if (!s || !s.text) return hideSelPop();
  if (!isScroll || selPop.hidden) {
    selPop.querySelector('[data-act="copy"]').textContent = "Copy";
    selPop.querySelector('[data-act="mark"]').textContent = "Bookmark";
  }
  const wasHidden = selPop.hidden;
  selPop.hidden = false;
  selPop.classList.remove("stack", "over");
  const hw = selPop.offsetWidth, hh = selPop.offsetHeight;
  let stacked = null;
  const measureStack = () => {
    if (!stacked) {
      selPop.classList.add("stack");
      stacked = { sw: selPop.offsetWidth, sh: selPop.offsetHeight };
      selPop.classList.remove("stack");
    }
    return stacked;
  };

  const r = s.range.getBoundingClientRect();
  const selRects = Array.from(s.range.getClientRects()).filter((rc) => rc.width > 0 || rc.height > 0);
  const lastSelRect = selRects[selRects.length - 1] || r;
  const padEdge = 10, safeTop = 58, safeBot = innerHeight - 72;

  // Reference point: where the pointer just finished selecting (if still near the selection), else the selection end
  let refX = lastSelRect.left + lastSelRect.width / 2;
  let refY = lastSelRect.top + lastSelRect.height / 2;
  if (!isScroll && selAnchor && rectPointDist(selAnchor.x, selAnchor.y, r.left, r.top, r.width, r.height) < 120) {
    refX = selAnchor.x;
    refY = selAnchor.y;
  }
  let anchorRect = lastSelRect, anchorDist = Infinity;
  for (const rc of selRects) {
    const d = rectPointDist(refX, refY, rc.left, rc.top, rc.width, rc.height);
    if (d < anchorDist) { anchorDist = d; anchorRect = rc; }
  }

  const candidates = collectSelCandidates({
    s, r, anchorRect, refX, refY, hw, hh, measureStack,
    col: $("#blocks").getBoundingClientRect(), padEdge, safeTop, safeBot,
  });

  // Pick the closest non-covering placement (keeping the same side while scrolling so it never jitters)
  let pick = (isScroll && selPlace && candidates.find((c) => c.mode === selPlace)) || null;
  if (!pick && candidates.length) {
    pick = candidates.reduce((best, c) => (c.dist < best.dist ? c : best));
  }
  if (!pick) {
    // Narrow viewport fallback when neither paragraph gaps nor margins have room
    let top = r.top - hh - 8, animY = 4;
    if (top < safeTop) { top = r.bottom + 8; animY = -4; }
    pick = { mode: "over", x: clamp(r.left + r.width / 2 - hw / 2, padEdge, innerWidth - hw - padEdge), y: top, stack: false, over: true, animX: 0, animY };
  }

  selPlace = pick.mode;
  const offscreen = r.bottom < 0 || r.top > innerHeight || (isScroll && (r.bottom < safeTop || r.top > safeBot));
  selPop.dataset.place = pick.mode;
  selPop.classList.toggle("stack", !!pick.stack);
  selPop.classList.toggle("over", !!pick.over);
  selPop.classList.toggle("offscreen", offscreen);
  if (wasHidden) {
    selShownAt = performance.now();
    selLocked = false;
    selGlide.classList.remove("on");
    selPop.style.setProperty("--pop-o", "1");
    selPop.style.setProperty("--pop-s", "1");
    selPop.style.setProperty("--pop-x", pick.animX + "px");
    selPop.style.setProperty("--pop-y", pick.animY + "px");
  }
  selPop.style.left = Math.round(pick.x) + "px";
  selPop.style.top = Math.round(pick.y) + "px";
}
const hideSelPop = () => {
  selPop.hidden = true;
  selPop.classList.remove("offscreen");
  selGlide.classList.remove("on");
  clearSelPreview();
  selPlace = null;
  selAnchor = null;
  selLocked = false;
};

document.addEventListener("mouseup", (e) => {
  if (e.target instanceof Node && selPop.contains(e.target)) return;
  selAnchor = { x: e.clientX, y: e.clientY };
  setTimeout(() => showSelPop(false), 0);
});
window.addEventListener("pointermove", (e) => {
  if (!selPop.hidden && e.pointerType !== "touch") updateSelProximity(e.clientX, e.clientY);
}, { passive: true });
const selHighlight = window.Highlight && CSS.highlights ? new Highlight() : null; // painted in place of the native selection (style.css)
if (selHighlight) CSS.highlights.set("sel", selHighlight);
document.addEventListener("selectionchange", () => {
  const s = getSelection();
  selHighlight?.clear();
  if (selHighlight && s.rangeCount && !s.isCollapsed) selHighlight.add(s.getRangeAt(0).cloneRange());
  if (s.isCollapsed) { hideSelPop(); if (!pressing) catchUp(); }
});
let selScrollFrame = 0;
$("#stage").addEventListener("scroll", () => {
  if (selPop.hidden) return;
  selScrollFrame ||= requestAnimationFrame(() => { selScrollFrame = 0; if (!selPop.hidden) showSelPop(true); });
}, { passive: true }); // follow the text
selPop.addEventListener("pointerover", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("button") : null;
  if (!btn) { moveSelGlide(null); clearSelPreview(); return; }
  moveSelGlide(btn);
  if (btn.dataset.act === "mark") previewBookmarkSelection();
  else {
    clearSelPreview();
    if (btn.dataset.act === "copy") document.body.classList.add("sel-copy-hover");
  }
});
selPop.addEventListener("pointerleave", () => {
  moveSelGlide(null);
  clearSelPreview();
});
selPop.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
selPop.addEventListener("click", async (e) => {
  e.stopPropagation();
  const btn = e.target.closest("button");
  const s = selectedWords();
  if (!btn || !s) return;
  clearSelPreview();
  try {
    if (btn.dataset.act === "copy") await navigator.clipboard.writeText(getSelection().toString());
    else await addBookmark(s.b, s.w, s.text);
  } catch (err) { btn.textContent = "Failed"; return; }
  selLocked = true;
  selPop.style.setProperty("--pop-o", "1");
  selPop.style.setProperty("--pop-s", "1");
  btn.textContent = btn.dataset.act === "copy" ? "Copied" : "Bookmarked";
  showSelPop(true); // re-anchor for the wider confirmation label
  moveSelGlide(btn);
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
  lookAt(m.b, m.w); // the reading position stays: the progress bar shows the way back
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
  markBookmarks();
  refreshScout(true);
  if (!selPop.hidden) showSelPop(true);
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

// Update (Windows installs only): shown when a newer release exists. One click downloads it,
// installs it over the app (data stays), and Steady.bat restarts Steady; then this page reloads.
async function checkUpdate() {
  try {
    const info = await (await fetch("/api/update")).json();
    const btn = $("#update");
    if (!info.available) { btn.hidden = true; return; }
    btn.textContent = `Update to ${info.latest}`;
    btn.title = `You have Steady ${info.current}. Click to update; your library stays as it is.`;
    btn.hidden = false;
  } catch { /* offline: try again later */ }
}
$("#update").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Updating…";
  libStatus("Downloading the new version. Steady restarts by itself in a moment.");
  let started;
  try {
    started = (await (await fetch("/api/ping")).json()).started;
    await post("/api/update", {});
  } catch (err) {
    btn.disabled = false;
    checkUpdate();
    libStatus(err.message || "Update failed. Try again later.", "error");
    return;
  }
  serverGone = true; // the restart below isn't "Steady has stopped"
  const t0 = Date.now();
  const wait = setInterval(async () => {
    try {
      const r = await (await fetch("/api/ping")).json();
      if (r.started !== started) { clearInterval(wait); location.reload(); }
    } catch { /* restarting */ }
    if (Date.now() - t0 > 5 * 60000) {
      clearInterval(wait);
      libStatus("Steady didn't come back after the update. Open Steady from the Start menu.", "error");
    }
  }, 1500);
});
checkUpdate();
setInterval(checkUpdate, 6 * 3600000);

applyLook();
loadPron().catch(() => {});
loadVoices().catch(() => {}).finally(() => { route(); claimShown(); });
