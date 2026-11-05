// Turn Obsidian-flavoured Markdown into plain Markdown that reads well aloud.
// Bold, italic and ==highlights== are kept: Steady shows them.

const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const QUERY = /^(```|~~~)\s*(dataview|dataviewjs|query|tasks|mermaid)\b/i; // code that isn't text

export function cleanMarkdown(md: string): string {
  let s = md.replace(/\r\n?/g, "\n");
  s = s.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, ""); // front matter (properties)
  s = s.replace(/%%[\s\S]*?%%/g, ""); // Obsidian comments

  // Clean outside code blocks only; drop query blocks, which aren't text.
  const out: string[] = [];
  let last = 0;
  for (const m of s.matchAll(FENCE)) {
    out.push(cleanText(s.slice(last, m.index)));
    if (!QUERY.test(m[0])) out.push(m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(cleanText(s.slice(last)));
  return out.join("").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function cleanText(s: string): string {
  return s
    .replace(/!\[\[[^\]\n]*\]\]/g, "") // embedded notes and images
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "") // images
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2") // [[note|shown text]]
    .replace(/\[\[([^\]\n]+)\]\]/g, (_, t: string) => // [[folder/note#heading]] -> note heading
      (t.replace(/#\^.*$/, "").split("/").pop() ?? t).replace(/#/g, " ").trim(),
    )
    .replace(/^([ \t]*>+[ \t]*)\[![^\]\n]+\][+-]?[ \t]*/gm, "$1") // callout markers: > [!note] Title
    .replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, "") // block ids
    .replace(/^([ \t]*(?:[-*+]|\d+[.)]))[ \t]+\[.\][ \t]+/gm, "$1 ") // task checkboxes
    .replace(/(^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gmu, (_, pre: string, tag: string) => pre + tag.replace(/[/_-]+/g, " ")) // #tags
    .replace(/\$\$[\s\S]*?\$\$/g, ""); // display maths
}
