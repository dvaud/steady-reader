"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SteadyPlugin
});
module.exports = __toCommonJS(main_exports);
var import_child_process = require("child_process");
var import_obsidian = require("obsidian");

// clean.ts
var FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
var QUERY = /^(```|~~~)\s*(dataview|dataviewjs|query|tasks|mermaid)\b/i;
function cleanMarkdown(md) {
  let s = md.replace(/\r\n?/g, "\n");
  s = s.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, "");
  s = s.replace(/%%[\s\S]*?%%/g, "");
  const out = [];
  let last = 0;
  for (const m of s.matchAll(FENCE)) {
    out.push(cleanText(s.slice(last, m.index)));
    if (!QUERY.test(m[0])) out.push(m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(cleanText(s.slice(last)));
  return out.join("").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function cleanText(s) {
  return s.replace(/!\[\[[^\]\n]*\]\]/g, "").replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "").replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2").replace(
    /\[\[([^\]\n]+)\]\]/g,
    (_, t) => (
      // [[folder/note#heading]] -> note heading
      (t.replace(/#\^.*$/, "").split("/").pop() ?? t).replace(/#/g, " ").trim()
    )
  ).replace(/^([ \t]*>+[ \t]*)\[![^\]\n]+\][+-]?[ \t]*/gm, "$1").replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, "").replace(/^([ \t]*(?:[-*+]|\d+[.)]))[ \t]+\[.\][ \t]+/gm, "$1 ").replace(/(^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gmu, (_, pre, tag) => pre + tag.replace(/[/_-]+/g, " ")).replace(/\$\$[\s\S]*?\$\$/g, "");
}

// main.ts
var DEFAULTS = { url: "http://localhost:41737", app: "Steady" };
var TYPES = {
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain"
};
function readable(file) {
  return file.extension.toLowerCase() in TYPES;
}
var SteadyPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULTS };
  }
  async onload() {
    this.settings = { ...DEFAULTS, ...await this.loadData() };
    this.addRibbonIcon("book-open", "Read this note in Steady", () => {
      const file = this.app.workspace.getActiveFile();
      if (file && readable(file)) this.readFile(file);
      else new import_obsidian.Notice("Open a note first, then click this to read it in Steady.");
    });
    this.addCommand({
      id: "read-note",
      name: "Read this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !readable(file)) return false;
        if (!checking) this.readFile(file);
        return true;
      }
    });
    this.addCommand({
      id: "read-selection",
      name: "Read selected text",
      editorCheckCallback: (checking, editor, ctx) => {
        const text = editor.getSelection();
        if (!text.trim()) return false;
        if (!checking) this.readSelection(text, ctx.file);
        return true;
      }
    });
    this.addCommand({
      id: "open-library",
      name: "Open library",
      callback: () => this.run("Opening Steady\u2026", async () => this.open(""))
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof import_obsidian.TFile) || !readable(file)) return;
        menu.addItem(
          (item) => item.setTitle("Read in Steady").setIcon("book-open").onClick(() => this.readFile(file))
        );
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const text = editor.getSelection();
        if (!text.trim()) return;
        menu.addItem(
          (item) => item.setTitle("Read selection in Steady").setIcon("book-open").onClick(() => this.readSelection(text, info.file))
        );
      })
    );
    this.addSettingTab(new SteadySettings(this.app, this));
  }
  // ------------------------------------------------------------ what gets sent
  /** A whole note or file. A note keeps one entry in Steady's library, so your place is kept when you edit it.
   * Other files are matched by their contents, as when they're dropped onto Steady. */
  async readFile(file) {
    if (file.extension.toLowerCase() === "md") {
      const key = `obsidian:${this.app.vault.getName()}/${file.path}`;
      const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
      const text = view?.file === file ? view.editor.getValue() : await this.app.vault.cachedRead(file);
      const md = cleanMarkdown(text);
      if (!md.trim()) return new import_obsidian.Notice("This note has no text to read.");
      return this.send("note.md", md, { key, title: file.basename });
    }
    const data = await this.app.vault.readBinary(file);
    return this.send(file.name, data, {});
  }
  async readSelection(text, file) {
    const md = cleanMarkdown(text);
    if (!md.trim()) return new import_obsidian.Notice("The selection has no text to read.");
    const words = md.replace(/[^\p{L}\p{N}'’,.!?-]+/gu, " ").trim().split(" ");
    const start = words.slice(0, 6).join(" ").replace(/[,.!?-]+$/, "") + (words.length > 6 ? "\u2026" : "");
    return this.send("selection.md", md, { title: file ? `${file.basename}: ${start}` : start });
  }
  // ------------------------------------------------------------ talking to Steady
  async send(name, data, fields) {
    await this.run("Sending to Steady\u2026", async (notice) => {
      const ext = (name.split(".").pop() ?? "").toLowerCase();
      const body = multipart({ ...fields, from: "obsidian" }, name, TYPES[ext] ?? "application/octet-stream", data);
      let d = await this.call("/api/import", {
        method: "POST",
        contentType: `multipart/form-data; boundary=${body.boundary}`,
        body: body.bytes
      });
      while (d.job) {
        await sleep(300);
        const j = await this.call(`/api/import/${d.job}`);
        if (j.error) throw new Error(j.error);
        if (j.result) d = j.result;
        else if ((j.total ?? 0) > 1) notice.setMessage(`Steady is reading page ${(j.done ?? 0) + 1} of ${j.total}\u2026`);
      }
      await this.open(`#doc=${d.id}`);
    });
  }
  /** Make sure Steady is running, then do the job, showing progress and errors in a notice. */
  async run(message, job) {
    const notice = new import_obsidian.Notice(message, 0);
    try {
      await this.start(notice);
      notice.setMessage(message);
      await job(notice);
      notice.hide();
    } catch (e) {
      notice.hide();
      new import_obsidian.Notice(`Steady: ${e instanceof Error ? e.message : e}`, 1e4);
    }
  }
  async up() {
    try {
      await (0, import_obsidian.requestUrl)({ url: this.base() + "/api/ping" });
      return true;
    } catch {
      return false;
    }
  }
  /** Run Steady.app with these arguments. It's found by its id, so a Safari web app that is
   *  also called Steady isn't started by mistake; -n runs it even if it's already running. */
  launch(args, fresh = false) {
    const app = this.settings.app || DEFAULTS.app;
    const which = app === DEFAULTS.app ? ["-b", "local.steady.reader"] : ["-a", app];
    return new Promise(
      (resolve, reject) => (0, import_child_process.execFile)("open", [...fresh ? ["-n"] : [], ...which, "--args", ...args], (err) => err ? reject(err) : resolve())
    );
  }
  /** Start Steady.app (without opening its window) if it isn't running. */
  async start(notice) {
    if (await this.up()) return;
    if (!import_obsidian.Platform.isMacOS) throw new Error(`Steady isn't running at ${this.base()}. Start it, then try again.`);
    notice.setMessage("Starting Steady\u2026");
    await this.launch(["--no-browser"]).catch(() => {
      throw new Error(`Couldn't start Steady.app. Open it once from Finder, or set where it is in the Steady plugin settings.`);
    });
    for (let i = 0; i < 360; i++) {
      await sleep(500);
      if (await this.up()) return;
      if (i === 6) notice.setMessage("Starting Steady\u2026 (the first start takes a minute or two)");
    }
    throw new Error("Steady is taking too long to start. The details are in ~/Library/Logs/Steady.log");
  }
  async call(path, opts = {}) {
    const r = await (0, import_obsidian.requestUrl)({ url: this.base() + path, throw: false, ...opts });
    let json;
    try {
      json = r.json;
    } catch {
      throw new Error(`Steady answered with an error (${r.status}).`);
    }
    if (r.status >= 400) throw new Error(json?.error ?? `Steady answered with an error (${r.status}).`);
    return json;
  }
  /** Show a page in Steady's own window (see Steady.app); "" is the library. */
  async open(hash) {
    if (import_obsidian.Platform.isMacOS) {
      try {
        return await this.launch(["--show", hash.replace(/^#/, "")], true);
      } catch {
      }
    }
    window.open(`${this.base()}/${hash}`);
  }
  base() {
    return (this.settings.url || DEFAULTS.url).replace(/\/+$/, "");
  }
};
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function multipart(fields, name, type, data) {
  const boundary = "----SteadyBoundary" + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r
Content-Disposition: form-data; name="${k}"\r
\r
${v}\r
`));
  }
  parts.push(
    enc.encode(`--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${name.replace(/["\r\n]/g, "_")}"\r
Content-Type: ${type}\r
\r
`),
    typeof data === "string" ? enc.encode(data) : new Uint8Array(data),
    enc.encode(`\r
--${boundary}--\r
`)
  );
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { boundary, bytes: bytes.buffer };
}
var SteadySettings = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Steady address").setDesc("Where Steady runs. You only need to change this if you start Steady on another port.").addText(
      (t) => t.setPlaceholder(DEFAULTS.url).setValue(this.plugin.settings.url).onChange(async (v) => {
        this.plugin.settings.url = v.trim();
        await this.plugin.saveData(this.plugin.settings);
      })
    );
    new import_obsidian.Setting(containerEl).setName("Steady app").setDesc("Started when Steady isn't running. A name (Steady) or a full path, like /Applications/Steady.app.").addText(
      (t) => t.setPlaceholder(DEFAULTS.app).setValue(this.plugin.settings.app).onChange(async (v) => {
        this.plugin.settings.app = v.trim();
        await this.plugin.saveData(this.plugin.settings);
      })
    );
  }
};
