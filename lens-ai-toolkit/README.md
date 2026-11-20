# Lens AI Toolkit 2.0

One Chrome extension that puts **Google AI Mode** (and optionally Google Lens) one click away from any
image or any part of any page — in a **side panel** or a normal tab. Every feature has its own
on/off switch. No account, no paywall, no tracking, no server of mine: everything is stored on your computer.

> **This replaces "Lens Search Lite" and "Image Text Copier".** Remove those two before loading this
> one, otherwise both will react to the same click.

## Install

1. Unzip the folder.
2. Chrome → `chrome://extensions` → switch on **Developer mode** → **Load unpacked** → pick the folder
   that contains `manifest.json`.
3. Pin the extension (puzzle icon → pin) so the popup is one click away.
4. Open the extension's **Settings** (popup → **All settings…**, or right-click the icon → Options) to switch features.

## What you asked for (all ON by default)

| Feature | How you use it |
|---|---|
| **Prompt history** | Every prompt that is sent (presets, your own, default prompt, selections, and what you type in AI Mode yourself) is saved. Side panel → 🕘 History: search it, **Ask** again, **Copy**, **Use as default**, delete one or clear all. Also viewable / exportable in Settings. Last 300, repeats are merged and counted. |
| **Add screenshots to the same open chat** | New screenshots go into the AI Mode chat that is already open in the side panel instead of starting a new one. Switch: Settings, or the "add to this chat" checkbox in the side panel header. If the open chat can't take the image, a fresh chat is started automatically. |
| **Select an area → only its text → copied** | Right-click → *Select an area and copy its text*, **Alt+Shift+K**, popup button, or **✂ Text** in the side panel. Drag a rectangle; AI Mode is asked to return *only the text in that rectangle* and the text lands on your clipboard (toast tells you). If there's no text, your clipboard is left alone. |

## Extra features (each has its own switch)

| Feature | Default | Notes |
|---|---|---|
| Hover button on images | on | A small blue button on images → copy their text. |
| …only while Alt is held | off | Keeps pages clean. |
| Site block-list for the hover button | empty | One site per line. |
| Ask which prompt to use every time (picker) | off | Side panel shows presets (keys 1–9) + a box for your own question. Not shown when the offline reader handles plain "Copy exact text". |
| Preview before copying | off | Shows the text in a small box on the page; copied only when you press **Copy**. |
| Tidy the text / join lines | off | Removes trailing spaces, zero-width characters, fixes hyphenated line breaks; optionally one paragraph. |
| Copied-text history | on | Last 50 copied texts (Settings). |
| Offline text reader | off | Tesseract OCR inside your browser. **English only**, adds ~7 MB, instant, works without Google. Choose "offline", or "offline first, Google AI if unsure" (that fallback may open a tab). |
| Whole-page scroll capture | menu/popup only | Scrolls, screenshots (Chrome allows ~2/second) and stitches; up to 14 screens. Long captures show a "Send" button on the page (the side panel needs a fresh click). |
| Search destination | AI Mode | Or **Google Lens** for screenshot/area searches. |
| Default prompt | empty | Sent with screenshot / area searches. |
| Selection prefix | empty | e.g. `Explain: ` before text you send from the right-click menu. |
| Presets | 7 built in | Edit, add, delete, reorder in Settings. "Copy…" presets copy the answer; "Ask…" presets just send it. |
| Gemini instead of AI Mode | off | **Experimental, untested against the real site.** |
| Each right-click menu item | on | 7 items, each hideable. |

## Shortcuts

| Key | Action |
|---|---|
| Alt+Shift+L | Search the visible page |
| Alt+Shift+S | Select an area and search it |
| Alt+Shift+K | Select an area and copy its text |
| Alt+Shift+M | Open AI Mode |
| *(none)* | Whole-page scroll capture — set one at `chrome://extensions/shortcuts` |

(Alt+Shift+A / C and a few other letters are not assignable in Chromium, so I avoided them. If a key is taken by
another extension, Chrome leaves it unassigned — set your own at `chrome://extensions/shortcuts`.)

## Why these permissions

* **`<all_urls>` (host access)** — the hover button and the area-selection overlay have to appear on any page,
  and the screenshot has to work on any page. Nothing is read or sent unless *you* trigger an action.
* **`sidePanel`** — the side panel itself.
* **`declarativeNetRequest`** — Google normally refuses to be shown inside another page. Two rules remove the
  "don't frame me" headers **only** for AI Mode / Gemini pages, **only** when loaded by this extension's own
  panel. Nothing changes for normal browsing.
* **`scripting`** — draws the area-selection overlay and reads page size for scroll capture.
* **`contextMenus`, `storage`, `clipboardWrite`** — menu items, your settings/histories (local only), copying.
* **`offscreen`** — a hidden page that runs the offline reader and copies to the clipboard.
* The extension's own pages may use WebAssembly (`wasm-unsafe-eval`) — needed only by the offline reader.

## Privacy

Settings, prompt history and copied-text history are in `chrome.storage.local` on this computer only.
Screenshots are held in browser memory (`storage.session`) for a few minutes and never written to disk.
The only network traffic is to Google (AI Mode / Lens / Gemini) when you start an action. "Clear all" in the
history deletes it; removing the extension deletes everything.

## Honest limits

* **Not yet verified against the real Google AI Mode page.** I tested in real Chromium against a stand-in page
  that behaves like AI Mode, and with mocked Chrome APIs. Google can change its page at any time; the
  extension looks for the text box, the "+" menu / file input, the Send button and the code block, and tries
  several ways to attach the image. If one stops working: popup → **Self-test**, then **Copy debug log** and send it to me.
* **The side panel shows Google in an iframe.** That depends on the header rules above and on you being signed
  in / allowing third-party cookies for Google. If the panel stays empty, the extension moves the job to a normal
  tab by itself after ~15 s (6 s when reusing a chat). Setting "Open in: new tab" avoids the panel completely.
* **Right-click menu clicks and keyboard shortcuts** are written to Chrome's documentation and tested with
  mocked APIs, but could not be pressed by a real keyboard/mouse in my test setup.
* "Same chat" uses the chat's own page; if you changed to a different Google page inside the panel it starts a new chat.
* The offline reader is English only and weaker than AI on handwriting, stylised fonts and tiny text.
* Scroll capture uses the page's own scrolling only (not scrolling boxes inside web apps); sticky headers repeat;
  lazy-loaded parts may be blank.
* AI answers can contain mistakes — for important text, check the result.
* It reads text through a Google AI product, so the same Google terms and privacy rules apply to what you send it.

## Something broke?

Popup → **Copy debug log** and paste it to me. It contains the steps taken, your switch settings, and can include
web addresses of images and the beginning of a search text (it is part of the link). No screenshots, no page
content, no AI answers. Read it before sharing if you used private text.

## Files

`manifest.json` · `background.js` + `bg-*.js` (service worker) · `ai-task.js` (runs inside the Google page) ·
`page-ui.js` (hover button, toasts, preview) · `area-select.js/.css` · `sidepanel.*` · `options.*` · `popup.*` ·
`offscreen.*` + `vendor/` (Tesseract.js, Apache-2.0 licences included).
