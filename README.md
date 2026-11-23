# Steady

A local reader that guides your eyes: the current paragraph sits in the middle of the
screen, one word at a time is highlighted, and an offline voice reads along **while you
hold the space bar**. Let go and it stops.

## Run it

Requires [uv](https://docs.astral.sh/uv/) (`brew install uv`).

**Steady.app:** drag `Steady.app` from this folder into Applications (or onto the Dock) and
open it like any app. It starts Steady in the background and opens it in Safari, in a window
of its own, with no Terminal window. To stop it, click **Quit** at the top right of the library
page (twice, to confirm); otherwise it stops by itself about 15 minutes after you close its
last window.

**Its own window (recommended, once):** with Steady open in Safari, choose **File › Add to
Dock…** and keep "Steady" in the name. Safari makes a small Steady app: its own window with no
toolbar or tabs, its own icon, and its own place in ⌘-Tab. From then on Steady.app, Obsidian
and Raycast all open Steady there. Keep starting Steady from Steady.app, though: the web app
alone can't start Steady, so it shows "can't connect" if Steady isn't running. (If you'd rather
have one Dock icon, right-click the web app's icon in the Dock and untick **Keep in Dock**.)
Without the web app, Steady.app uses one Safari window of its own and brings it forward; the
first time, macOS asks whether Steady may control Safari: allow it.
If you move this folder, rebuild the app with `mac/make-app.sh`. If macOS won't open it the
first time, right-click it and choose **Open**. The log is in `~/Library/Logs/Steady.log`.

**Or double-click `Steady.command`**, which runs Steady in a Terminal window: keep the window
open while you read, and close it to stop. From a terminal instead:

```bash
cd steady-reader
uv run app.py
```

Your browser opens at <http://localhost:41737>. The first start installs the Python
packages (a minute or two). Each voice downloads once on first use (about 63 MB), and
after that everything runs offline.

**On Windows:** download `Steady-Windows.zip` from the latest release, unzip it anywhere and
double-click `Steady.bat` (if Windows SmartScreen warns, choose **More info › Run anyway**). The
first start installs uv and the packages by itself and adds Steady to the Start menu, so from then
on you can open it from Start search or Raycast like any other app (its window starts minimised). To bring your library, voices and bookmarks,
copy the `data` folder from your Mac into the unzipped folder. Keep its window open while you read; close it to stop. For OCR, install Tesseract
with `winget install UB-Mannheim.TesseractOCR` (tick the extra languages you need in the installer).

For scanned PDFs (OCR), also install Tesseract with its language packs:

```bash
brew install tesseract tesseract-lang
```

## Use it

Drop a file onto the page, paste a link, or paste any text (⌘V on the library page) to read it.

| Key | Action |
| --- | --- |
| hold **Space** | read (release to stop) |
| double-tap **Space** | lock: keep reading hands-free (tap to stop) |
| hold **Space** while locked | pause: scroll, click or select while you hold; let go to carry on reading hands-free |
| ← / → | previous / next sentence |
| ↑ / ↓ | previous / next paragraph |
| left / right **Shift** | slower / faster (0.5× – 4×); hold to keep changing |
| M | mute (the highlight keeps its pace) |
| play / pause on headphones or the keyboard | start / stop hands-free reading |
| O, or click the title | contents and bookmarks: jump to a heading or a bookmark |
| B | bookmark the sentence you're on |
| hold **B** | bookmark from the word being read until you let go, like selecting the passage |
| ⌘F / Ctrl+F | search (Enter / Shift+Enter for next / previous, Esc to close and read from there) |
| Option-click a word | teach the voice how to say it |
| click a word | start from there |
| select text | **Copy** or **Bookmark** it |
| Esc | stop hands-free reading; otherwise back to the library |

**Bookmarks:** select some text and choose **Bookmark**, press B for the current
sentence, or hold B while it reads to bookmark the passage until you let go. In the text a bookmark is only a faint mark in the margin. Find them under
contents (O) for this document, or under **Bookmarks** on the library page for all of them.

**Pronunciations:** if the voice says a name or term wrong, Option-click (Alt-click) it,
write how it sounds ("Vay-bair-ian"), press ▶ to listen and **Add**. This applies to every
document in that language. Manage the list under **Aa → Pronunciations**.

The sentence under the cursor is prepared while you look, so reading starts the moment
you press Space. Hover over the speed at the top to see how much reading time is left at that speed.
Your position in every document is saved. Scroll with the mouse to look around; holding
Space brings you back to where you were. While reading goes on, the page comes back by itself
a moment after you stop scrolling. While you select text the page stays still, so the Copy and
Bookmark buttons stay under the mouse; it catches up once the selection is gone.

**Formats:** PDF (bold, italic, highlight annotations, headings, lists; running headers
and page numbers removed), Word `.docx` (bold, italic, underline, highlights), HTML files
and web links (main article text only), Markdown (`==text==` for highlights), and plain text.

**Languages:** English, Hungarian, French, German and Dutch, detected automatically
and changeable in the **Aa** panel, along with the voice, speed, focus (current line or whole paragraph), guide style (reveal or highlight), theme, font, size and column width.

## Obsidian and Raycast

Plugins in `integrations/` send a note, selected text, a web page or a file straight to
Steady, starting it if needed. See [integrations/README.md](integrations/README.md).

## How it works

- **Voices:** [Piper](https://github.com/OHF-Voice/piper1-gpl), neural text-to-speech that
  runs on your CPU. Piper reports how long each speech sound lasts. Steady lines those
  sounds up with the words on screen, so the highlight follows the voice exactly. That
  includes numbers and abbreviations that are spoken as several words.
- **Speed:** the voice itself speaks faster up to 3×, keeping the ends of words a little
  longer so they aren't clipped. 3.5× and 4× speed up the 3× voice further, keeping the pitch.
- **Documents:** PyMuPDF (PDF and OCR), mammoth (Word), trafilatura (web pages).
- **Server:** Flask. The front end is plain HTML, CSS and JavaScript, with no build step.

Your library and voices are stored in `data/`. Delete that folder to start fresh.
