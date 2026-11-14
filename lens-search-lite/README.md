# Lens Search Lite

A tiny, fully transparent Chrome extension for searching images, full pages,
or a selected area with Google Lens — built to avoid the issues found in the
"Google Lens AI" extension it was inspired by:

- **No paywall / no usage limits** — there is no subscription code anywhere
  in this project, at all.
- **No hidden data collection** — the only network requests it ever makes go
  to `lens.google.com` (to open Google's own Lens page) and to whatever
  image URL you right-click on. Nothing is uploaded to any third-party server.
- **Minimal permissions** — no `<all_urls>`, no persistent access to every
  site you visit, no Amazon/YouTube integrations you didn't ask for. It only
  gets temporary access to a tab when you actually invoke it (via the
  keyboard shortcut, right-click menu, or the popup), and a permanent content
  script only on `google.com` / `lens.google.com`. (The side-panel option adds
  two permissions, `sidePanel` and `declarativeNetRequest` — see
  "Side panel or new tab" below for exactly what they do.)
- **~250 lines total, no build step** — every file is plain, commented
  JavaScript/HTML/CSS. Read all of it in a few minutes if you want to.

## How it works

1. **Right-click an image → "Search image with Google Lens"** — opens
   Google's own `lens.google.com/uploadbyurl` with that image's URL. Simplest
   and most reliable path.
2. **Full-screen search** (button, right-click menu, or `Alt+Shift+L`) —
   screenshots the visible tab, opens `lens.google.com`, and simulates
   dragging that screenshot onto Google's own upload zone (exactly what
   you'd do by hand).
3. **Area search** (button or `Alt+Shift+A`) — screenshots the tab first,
   then lets you drag out a rectangle, crops to just that region, and sends
   it to Lens the same way.

## Install (load unpacked)

1. Unzip this folder somewhere permanent (don't delete it after installing —
   Chrome reads the files live from wherever it is).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Pin it to the toolbar if you'd like (puzzle-piece icon → pin).

## Setting/changing the keyboard shortcut

Chrome sometimes doesn't auto-apply the suggested shortcuts if they clash
with something else. To set them yourself:

1. Go to `chrome://extensions/shortcuts`.
2. Find **Lens Search Lite**.
3. Click the pencil/input box next to "Search the full visible page" or
   "Select an area" and press your preferred combo.

## Settings: default prompt + AI Mode

Open it from the popup ("Settings") or `chrome://extensions` → Lens Search
Lite → Details → Extension options.

### Screenshot → AI Mode, in one keypress (the default)

Set a **default prompt** (e.g. "Quiz me on this"), keep **"Send it straight to
AI Mode"** selected, then:

- `Alt+Shift+L` — screenshot of the visible area, or
- `Alt+Shift+A` — drag a rectangle, only that area

The extension opens AI Mode (`google.com/ai`) in Chrome's **side panel** (or a
new tab — your choice, see below), attaches the screenshot, types your prompt
and presses Send. A small banner in the bottom-right corner says what it is
doing. The answer appears there.

How the image gets attached (it tries these in order and stops at the first
one that visibly works, so it isn't attached twice on purpose):

1. Paste — like Ctrl+V with the image on the clipboard.
2. The "+" button → "Add images" → hands the file to Google's own upload input.
3. Drop — like dragging the image onto the box.

Safety rules:

- It **never sends a text-only question**. It only presses Send once the image
  is verifiably attached and the prompt is in the box. If it can't attach the
  image, it types your prompt, copies the screenshot to your clipboard and
  tells you to click the box, press Ctrl+V and Enter.
- Untick **"AI Mode: press Send for me"** to have it leave image + prompt in
  the box so you can edit the prompt and press Enter yourself.
- With **no default prompt** it attaches the image and stops (nothing is sent).
- The screenshot is kept in browser memory only (`chrome.storage.session`, never
  written to disk) and deleted when the task finishes, the tab closes, or after
  90 seconds. It is never written to the debug log.

### Side panel or new tab

Settings → **Open AI Mode in**: **Side panel** (the default) or **New tab**. It
applies to the screenshot search and to the AI Mode button / `Alt+Shift+M`.

- With the side panel, AI Mode appears next to the page you were looking at, so
  you keep your page in view while reading the answer.
- For `Alt+Shift+L` the screenshot is requested first and the panel opens a
  moment after, in the same key press. For `Alt+Shift+A` the panel opens only
  after you finish dragging the rectangle, so the screenshot is always of the
  page exactly as you saw it.
- Google normally refuses to be shown inside another page, so the extension
  removes Google's "don't frame me" headers (`X-Frame-Options` and the
  Content-Security-Policy) — **only** for AI Mode pages and **only** when the
  frame was started by this extension's own side panel. Normal browsing is not
  touched. That is what the `declarativeNetRequest` permission is for;
  `sidePanel` is for the panel itself.
- If Google can't be shown in the panel (it refuses, shows a sign-in page, the
  image can't be attached there...), the extension **automatically redoes the
  same thing in a new tab** instead of leaving you with nothing. You can also
  just switch the setting to **New tab**.
- The popup buttons are not a "key press" in Chrome's eyes, so from there the
  panel may open as a tab instead. The shortcuts and the right-click menu open
  the panel.
- If the extension has only just woken up it guesses "side panel" for a moment;
  if your setting is New tab / Lens it closes the panel again right away.
- Needs Chrome 116 or newer.

### Other settings

- **Show Google Lens results** — the original behaviour for `Alt+Shift+L/A`.
- **AI Mode button** (popup) or **`Alt+Shift+M`** — opens AI Mode with your
  default prompt as a text question (no screenshot):
  `google.com/search?udm=50&q=<prompt>`; with no prompt it opens `google.com/ai`.
- **Lens results only: auto-click "AI Mode" afterwards** (off by default) —
  after a Lens search it types your prompt into the search box beside your image,
  clicks Google's "AI Mode" tab, and if the prompt didn't carry over, sends it
  there (never twice). Only applies when the destination is Google Lens.

This all automates Google's own pages, which is not an official API. If Google
changes the AI Mode page the attach step may stop working. When it can't attach,
the debug log gets a snapshot of the buttons, inputs and file inputs it saw
(use popup → "Show debug log" → "Copy debug log").

## If something isn't working

1. First check `chrome://extensions/shortcuts` — if a shortcut field is
   **blank**, Chrome didn't assign it (usually a conflict with something
   else) and pressing the key does nothing at all. Click the field and set
   it manually.
2. Reproduce the problem once.
3. Open the popup (click the toolbar icon) → **Show debug log** → **Copy
   debug log**.
4. Paste that text wherever you need to share it — it has a timestamped
   trace of every step (capture, tab creation, whether a drop-zone or file
   input was found on the Lens page, every error message).

## One more thing that could break it: the side panel

Showing Google inside a side panel is a workaround, not a supported feature, and
whether it works can depend on your Chrome setup (e.g. third-party cookie
settings can keep you signed out inside the panel). The automatic fallback to a
tab, and the **New tab** setting, exist for exactly that reason.

## One thing that could break it

`lens.google.com` actually redirects to `https://www.google.com/?olud`, which
is where the real upload modal lives — so that's the URL this extension now
opens directly. Because of that, it needs permission to run on
`www.google.com` (not just `lens.google.com`), which is broader than before.
The content script only ever acts when it detects the actual Lens upload
modal on the page (checked by looking for `olud` in the URL or the "Search
any image with Google Lens" text) — it does nothing on your normal Google
searches.

Finding the upload target itself is not an official API — it looks for
Google's own drop-zone `<div>` first, and falls back to any `<input
type="file">` on the modal if that specific element isn't found. If Google
redesigns the page, check the debug log's diagnostic snapshot (logged when
neither is found) to see what changed.

## License

It's yours — do whatever you want with it.
