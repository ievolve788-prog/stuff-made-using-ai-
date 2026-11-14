# Gemini Snap

Screenshot → Gemini, with an editable prompt and preset templates.

## Install (Chrome / Edge / Brave)
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Sign in to https://gemini.google.com once.

## Use
| Shortcut (Win/Linux · Mac) | Action |
|---|---|
| Alt+Shift+G · Cmd+Shift+G | Drag-to-crop a region |
| Alt+Shift+V · Cmd+Shift+V | Visible screen |
| Alt+Shift+Q · Cmd+Shift+Q | ⚡ Quick send: capture visible screen, send to Gemini and press Enter instantly (prompt set in Settings) |
| Alt+Shift+F · Cmd+Shift+F | Full page (auto-scroll + stitch) |

After capture: pick a preset (or press 1–9), edit the prompt, hit **Send to Gemini** (Ctrl/Cmd+Enter).
Change shortcuts at `chrome://extensions/shortcuts`; edit templates in the extension's Settings.

## Side panel
By default Gemini opens in the browser side panel (Settings → "Where to open Gemini" to switch back to tabs). Sign in to Gemini in a normal tab once. Needs Chrome 116+.

## Debug log
Logged from background, page and Gemini scripts. Written to **Downloads/GeminiSnap/debug-log.txt**
(overwritten after each run, and on any error). Also: popup → "Save debug log", or Settings → preview/clear.

## Known limits
- Cannot run on chrome:// pages, the Web Store, or Chrome's PDF viewer.
- Full page = whole-document scroll only (not inner scrolling panels); capped at ~16,000 device px height.
- Gemini's UI changes; attach/send selectors have fallbacks and every attempt is written to the log.
