// Talking to Steady: start it if needed, send it text, links and files, open documents.
import { Toast, getPreferenceValues, open, showHUD, showToast } from "@raycast/api";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface Mark { b: number; w: number; t: string; at: number }
export interface Doc {
  id: string;
  title: string;
  kind: string;
  lang: string;
  words: number;
  progress: number;
  opened: number;
  bookmarks: Mark[];
}
interface Job { job?: string; done?: number; total?: number; result?: Doc; error?: string }

export const READABLE = [".pdf", ".docx", ".html", ".htm", ".md", ".markdown", ".txt", ".text"];

export function base() {
  const { url } = getPreferenceValues<Preferences>();
  return (url || "http://localhost:8765").replace(/\/+$/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(base() + path, init);
  let json: any;
  try {
    json = await r.json();
  } catch {
    throw new Error(`Steady answered with an error (${r.status}).`);
  }
  if (!r.ok) throw new Error(json?.error ?? `Steady answered with an error (${r.status}).`);
  return json as T;
}

async function up() {
  try {
    return (await fetch(base() + "/api/ping", { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** Run Steady.app with these arguments. It's found by its id, so a Safari web app that is
 *  also called Steady isn't started by mistake; -n runs it even if it's already running. */
function launch(args: string[], fresh = false) {
  const { app } = getPreferenceValues<Preferences>();
  const which = !app || app === "Steady" ? ["-b", "local.steady.reader"] : ["-a", app];
  return new Promise<void>((resolve, reject) =>
    execFile("open", [...(fresh ? ["-n"] : []), ...which, "--args", ...args], (err) => (err ? reject(err) : resolve())),
  );
}

/** Start Steady.app (without opening its window) if it isn't running. */
export async function ensureRunning(toast?: Toast) {
  if (await up()) return;
  if (toast) toast.title = "Starting Steady…";
  await launch(["--no-browser"]).catch(() => {
    throw new Error("Couldn't start Steady.app. Open it once from Finder, or set where it is in this extension's preferences.");
  });
  for (let i = 0; i < 360; i++) { // up to 3 minutes: the very first start installs Python packages
    await sleep(500);
    if (await up()) return;
    if (i === 6 && toast) toast.message = "The first start takes a minute or two";
  }
  throw new Error("Steady is taking too long to start. The details are in ~/Library/Logs/Steady.log");
}

async function importForm(form: FormData, toast?: Toast): Promise<Doc> {
  form.append("from", "raycast"); // shown in Steady's library
  let d = await call<Job & Doc>("/api/import", { method: "POST", body: form });
  while (d.job) {
    // Big PDFs are read in the background; wait for them.
    await sleep(300);
    const j = await call<Job>(`/api/import/${d.job}`);
    if (j.error) throw new Error(j.error);
    if (j.result) return j.result;
    if (toast && (j.total ?? 0) > 1) toast.message = `Reading page ${(j.done ?? 0) + 1} of ${j.total}`;
  }
  return d;
}

const isLink = (s: string) => /^(https?:\/\/|www\.)\S+$/i.test(s);

/** Text is read as it is; a single link opens that web page. */
export async function sendText(text: string, toast?: Toast): Promise<Doc> {
  text = text.trim();
  if (!text) throw new Error("There's no text to read.");
  if (isLink(text)) return sendUrl(text);
  const words = text.split("\n")[0].replace(/[^\p{L}\p{N}'’,.!?-]+/gu, " ").trim().split(" ");
  const title = words.slice(0, 8).join(" ").replace(/[,.!?-]+$/, "") + (words.length > 8 ? "…" : "");
  const form = new FormData();
  form.append("title", title || "Text from Raycast");
  form.append("file", new Blob([text], { type: "text/plain" }), "text.txt");
  return importForm(form, toast);
}

export function sendUrl(url: string): Promise<Doc> {
  return call<Doc>("/api/import-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, from: "raycast" }),
  });
}

export async function sendFile(path: string, toast?: Toast): Promise<Doc> {
  if (!READABLE.includes(extname(path).toLowerCase())) {
    throw new Error(`Steady can't read ${extname(path) || "this kind of"} files. It reads PDF, Word, HTML, Markdown and text.`);
  }
  const form = new FormData();
  form.append("file", new Blob([await readFile(path)]), basename(path));
  return importForm(form, toast);
}

/** Show a page in Steady's own window (see Steady.app); "" is the library. */
export async function show(hash: string) {
  try {
    await launch(["--show", hash], true);
  } catch {
    await open(`${base()}/${hash ? "#" + hash : ""}`); // no Steady.app: use the browser
  }
}

export function openDoc(id: string, at?: string) {
  return show(`doc=${id}${at ? `&at=${at}` : ""}`);
}

/** For the quick commands: show progress, start Steady, run the job, open what it returns. */
export async function run(job: (toast: Toast) => Promise<Doc | Doc[]>) {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Sending to Steady…" });
  try {
    await ensureRunning(toast);
    toast.title = "Sending to Steady…";
    const result = await job(toast);
    const docs = Array.isArray(result) ? result : [result];
    await openDoc(docs[0].id);
    await showHUD(docs.length > 1 ? `Added ${docs.length} documents to Steady` : `Opened “${docs[0].title}” in Steady`);
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Steady";
    toast.message = e instanceof Error ? e.message : String(e);
  }
}
