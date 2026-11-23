# Steady for Obsidian and Raycast

Two small plugins that send things to Steady and open them there. If Steady isn't
running, they start it (in the background, like Steady.app does) and wait for it.

## Obsidian

**Install:** in Terminal, run

```bash
bash ~/ClaudeBox/steady-reader/integrations/StableRead/install.sh
```

It asks about each of your vaults. Or give it one vault: `bash install.sh ~/path/to/vault`.
Then in Obsidian go to **Settings → Community plugins**, turn on community plugins if they
are off, and turn on **Steady**. Reload Obsidian if Steady isn't listed.

**Use:**

- **Read this note:** the book icon in the left ribbon, or the command palette (⌘P):
  *Steady: Read this note*. Steady opens the note at the place you left it, even after
  you've edited the note.
- **Read selected text:** select text, then right-click → *Read selection in Steady*, or
  *Steady: Read selected text* in the command palette.
- **PDFs and Word files in your vault:** right-click the file in the file list →
  *Read in Steady*.
- Give any of these a hotkey under **Settings → Hotkeys** (search "Steady").

Before sending, the plugin tidies Obsidian syntax so it reads well aloud. It removes properties
(front matter), `%%comments%%`, embeds and images, block ids, checkboxes, query blocks
(Dataview, Tasks, Mermaid) and maths blocks. `[[links]]` become their text, and tags and
callouts lose their markers. Bold, italic and `==highlights==` are kept.

## Raycast

**Install** (once; it needs [Node.js](https://nodejs.org) 22.22.2 or newer: `brew install node`):

```bash
cd ~/ClaudeBox/steady-reader/integrations/raycast
npm install
npm run dev
```

Raycast opens with the Steady commands added. Press Ctrl+C in Terminal to stop: the
extension stays in Raycast. Run `npm run dev` again only if you change the extension.

**Commands:**

| Command | What it does |
| --- | --- |
| Read Selection in Steady | the text selected in any app (a selected link opens that page) |
| Read Clipboard in Steady | the copied text, link, or file copied in Finder |
| Read Browser Tab in Steady | the page open in Safari, Chrome, Arc, Brave, Edge, Vivaldi or Opera |
| Read Finder Selection in Steady | the files selected in Finder (PDF, Word, HTML, Markdown, text) |
| Search Steady Library | your documents, with how far you've read; Enter carries on reading |
| Search Steady Bookmarks | every bookmark; Enter reads from there |

Give *Read Selection in Steady* a hotkey in Raycast (Settings → Extensions → Steady) to send
any text to Steady with one key. The first time you use *Read Browser Tab*, macOS asks
whether Raycast may control your browser: allow it. For Firefox, install Raycast's browser extension.

## Both

- They use Steady at `http://localhost:41737` and start **Steady.app** (found by its id, so
  Safari's Steady web app isn't mistaken for it). Change either in the plugin's settings
  (Obsidian) or the extension's preferences (Raycast), for example to
  `/Applications/Steady.app` if you have more than one copy.
- Documents open in Steady's own window: the Safari web app if you've made one (see the main
  README), otherwise a Safari window of its own. Without Steady.app they open in your browser.
- Web pages are downloaded by Steady itself, so pages behind a login can't be read this
  way. Select the text and use *Read Selection* instead.

## Changing the code

Obsidian: edit `StableRead/main.ts` or `StableRead/clean.ts`, then `npm install && npm run build`
in `StableRead/` and run `install.sh` again. Raycast: edit `raycast/src/`, then `npm run dev`.
