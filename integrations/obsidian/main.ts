// Steady for Obsidian: read the current note, a selection or a file in Steady.
import { execFile } from "child_process";
import { App, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from "obsidian";
import { cleanMarkdown } from "./clean";

interface Settings {
  url: string; // where Steady runs
  app: string; // Steady.app's name or full path, for starting it
}
const DEFAULTS: Settings = { url: "http://localhost:8765", app: "Steady" };

// Files Steady can read, with the type it is sent as.
const TYPES: Record<string, string> = {
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
};

function readable(file: TFile) {
  return file.extension.toLowerCase() in TYPES;
}

interface Summary { id: string; title: string }
interface Job { job?: string; done?: number; total?: number; result?: Summary; error?: string }

export default class SteadyPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };

    this.addRibbonIcon("book-open", "Read this note in Steady", () => {
      const file = this.app.workspace.getActiveFile();
      if (file && readable(file)) this.readFile(file);
      else new Notice("Open a note first, then click this to read it in Steady.");
    });

    this.addCommand({
      id: "read-note",
      name: "Read this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !readable(file)) return false;
        if (!checking) this.readFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "read-selection",
      name: "Read selected text",
      editorCheckCallback: (checking, editor, ctx) => {
        const text = editor.getSelection();
        if (!text.trim()) return false;
        if (!checking) this.readSelection(text, ctx.file);
        return true;
      },
    });

    this.addCommand({
      id: "open-library",
      name: "Open library",
      callback: () => this.run("Opening Steady…", async () => this.open("")),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !readable(file)) return;
        menu.addItem((item) =>
          item.setTitle("Read in Steady").setIcon("book-open").onClick(() => this.readFile(file)),
        );
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const text = editor.getSelection();
        if (!text.trim()) return;
        menu.addItem((item) =>
          item
            .setTitle("Read selection in Steady")
            .setIcon("book-open")
            .onClick(() => this.readSelection(text, info.file)),
        );
      }),
    );

    this.addSettingTab(new SteadySettings(this.app, this));
  }

  // ------------------------------------------------------------ what gets sent

  /** A whole note or file. A note keeps one entry in Steady's library, so your place is kept when you edit it.
   * Other files are matched by their contents, as when they're dropped onto Steady. */
  async readFile(file: TFile) {
    if (file.extension.toLowerCase() === "md") {
      const key = `obsidian:${this.app.vault.getName()}/${file.path}`;
      // Use what's in the editor, which can be a moment ahead of the saved file.
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const text = view?.file === file ? view.editor.getValue() : await this.app.vault.cachedRead(file);
      const md = cleanMarkdown(text);
      if (!md.trim()) return new Notice("This note has no text to read.");
      return this.send("note.md", md, { key, title: file.basename });
    }
    const data = await this.app.vault.readBinary(file);
    return this.send(file.name, data, {});
  }

  async readSelection(text: string, file: TFile | null) {
    const md = cleanMarkdown(text);
    if (!md.trim()) return new Notice("The selection has no text to read.");
    const words = md.replace(/[^\p{L}\p{N}'’,.!?-]+/gu, " ").trim().split(" ");
    const start = words.slice(0, 6).join(" ").replace(/[,.!?-]+$/, "") + (words.length > 6 ? "…" : "");
    return this.send("selection.md", md, { title: file ? `${file.basename}: ${start}` : start });
  }

  // ------------------------------------------------------------ talking to Steady

  async send(name: string, data: string | ArrayBuffer, fields: Record<string, string>) {
    await this.run("Sending to Steady…", async (notice) => {
      const ext = (name.split(".").pop() ?? "").toLowerCase();
      const body = multipart({ ...fields, from: "obsidian" }, name, TYPES[ext] ?? "application/octet-stream", data);
      let d = await this.call<Job & Summary>("/api/import", {
        method: "POST",
        contentType: `multipart/form-data; boundary=${body.boundary}`,
        body: body.bytes,
      });
      while (d.job) {
        // Big PDFs are read in the background; wait for them.
        await sleep(300);
        const j = await this.call<Job>(`/api/import/${d.job}`);
        if (j.error) throw new Error(j.error);
        if (j.result) d = j.result as Job & Summary;
        else if ((j.total ?? 0) > 1) notice.setMessage(`Steady is reading page ${(j.done ?? 0) + 1} of ${j.total}…`);
      }
      await this.open(`#doc=${d.id}`);
    });
  }

  /** Make sure Steady is running, then do the job, showing progress and errors in a notice. */
  async run(message: string, job: (notice: Notice) => Promise<void>) {
    const notice = new Notice(message, 0);
    try {
      await this.start(notice);
      notice.setMessage(message);
      await job(notice);
      notice.hide();
    } catch (e) {
      notice.hide();
      new Notice(`Steady: ${e instanceof Error ? e.message : e}`, 10000);
    }
  }

  async up(): Promise<boolean> {
    try {
      await requestUrl({ url: this.base() + "/api/ping" });
      return true;
    } catch {
      return false;
    }
  }

  /** Run Steady.app with these arguments. It's found by its id, so a Safari web app that is
   *  also called Steady isn't started by mistake; -n runs it even if it's already running. */
  launch(args: string[], fresh = false) {
    const app = this.settings.app || DEFAULTS.app;
    const which = app === DEFAULTS.app ? ["-b", "local.steady.reader"] : ["-a", app];
    return new Promise<void>((resolve, reject) =>
      execFile("open", [...(fresh ? ["-n"] : []), ...which, "--args", ...args], (err) => (err ? reject(err) : resolve())),
    );
  }

  /** Start Steady.app (without opening its window) if it isn't running. */
  async start(notice: Notice) {
    if (await this.up()) return;
    if (!Platform.isMacOS) throw new Error(`Steady isn't running at ${this.base()}. Start it, then try again.`);
    notice.setMessage("Starting Steady…");
    await this.launch(["--no-browser"]).catch(() => {
      throw new Error(`Couldn't start Steady.app. Open it once from Finder, or set where it is in the Steady plugin settings.`);
    });
    for (let i = 0; i < 360; i++) { // up to 3 minutes: the very first start installs Python packages
      await sleep(500);
      if (await this.up()) return;
      if (i === 6) notice.setMessage("Starting Steady… (the first start takes a minute or two)");
    }
    throw new Error("Steady is taking too long to start. The details are in ~/Library/Logs/Steady.log");
  }

  async call<T>(path: string, opts: { method?: string; contentType?: string; body?: ArrayBuffer } = {}): Promise<T> {
    const r = await requestUrl({ url: this.base() + path, throw: false, ...opts });
    let json: any;
    try {
      json = r.json;
    } catch {
      throw new Error(`Steady answered with an error (${r.status}).`);
    }
    if (r.status >= 400) throw new Error(json?.error ?? `Steady answered with an error (${r.status}).`);
    return json as T;
  }

  /** Show a page in Steady's own window (see Steady.app); "" is the library. */
  async open(hash: string) {
    if (Platform.isMacOS) {
      try {
        return await this.launch(["--show", hash.replace(/^#/, "")], true);
      } catch {
        /* no Steady.app: use the browser */
      }
    }
    window.open(`${this.base()}/${hash}`);
  }

  base() {
    return (this.settings.url || DEFAULTS.url).replace(/\/+$/, "");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A multipart/form-data body (Obsidian's requestUrl doesn't take FormData). */
function multipart(fields: Record<string, string>, name: string, type: string, data: string | ArrayBuffer) {
  const boundary = "----SteadyBoundary" + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replace(/["\r\n]/g, "_")}"\r\nContent-Type: ${type}\r\n\r\n`),
    typeof data === "string" ? enc.encode(data) : new Uint8Array(data),
    enc.encode(`\r\n--${boundary}--\r\n`),
  );
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { boundary, bytes: bytes.buffer };
}

class SteadySettings extends PluginSettingTab {
  constructor(app: App, private plugin: SteadyPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Steady address")
      .setDesc("Where Steady runs. You only need to change this if you start Steady on another port.")
      .addText((t) =>
        t.setPlaceholder(DEFAULTS.url).setValue(this.plugin.settings.url).onChange(async (v) => {
          this.plugin.settings.url = v.trim();
          await this.plugin.saveData(this.plugin.settings);
        }),
      );
    new Setting(containerEl)
      .setName("Steady app")
      .setDesc("Started when Steady isn't running. A name (Steady) or a full path, like /Applications/Steady.app.")
      .addText((t) =>
        t.setPlaceholder(DEFAULTS.app).setValue(this.plugin.settings.app).onChange(async (v) => {
          this.plugin.settings.app = v.trim();
          await this.plugin.saveData(this.plugin.settings);
        }),
      );
  }
}
