# Image Text Copier (Google AI)

Hover over any image, click the small blue button in its top-right corner, and the **exact text in the image is copied to your clipboard**. Google AI Mode does the reading; the extension attaches the image, sends a built-in prompt that makes it answer with *only* the text, waits for the answer and copies it.

No account, no tracking, no paywall, no server of mine in between.

## Install

1. Unzip the folder.
2. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
3. **Load unpacked** → pick the `image-text-copy` folder.
4. Needs Chrome 116 or newer.

## Use

- **Hover** an image (at least 64×40 px) → a blue button appears in its top-right corner → **click it**.
- Or **right-click** an image → *Copy text from this image (Google AI)*.
- Google AI Mode opens, the image is attached, the prompt is sent, and a few seconds later the text is on your clipboard (the page you are on shows "Copied N characters ✓").
- If the image has no text you get "No text found" and your clipboard is left alone.

## Side panel or new tab

Settings → **Open Google AI Mode in**:

- **Side panel** (default): AI Mode appears in Chrome's side panel next to the page you are reading, so you never leave it.
- **New tab**: opens next to the current tab; optionally goes back to your page and closes the tab after copying.

Showing Google inside the side panel is a trick (Google normally refuses to be framed), so it can fail on some setups. When it does, the extension **automatically redoes the same task in a new tab** and tells you. You can also just switch the setting to *New tab*.

## Settings

| Setting | What it does |
|---|---|
| Open Google AI Mode in | Side panel / New tab |
| Prompt | What Google is asked together with the image. Keep the sentence about putting the text in **one code block** – that is how the extension grabs exactly the text and nothing else. "Reset" restores the default. |
| Press Send automatically | Off = image + prompt are placed in the box and you press Enter yourself; the text is still copied when the answer appears. |
| After the text is copied | New-tab mode only: stay on the AI Mode tab, or return to your page and close it. |

## Privacy and permissions

- The image leaves your browser **only when you click** the button (or the menu item), and it goes only to Google AI Mode, the same as if you had uploaded it there yourself.
- While the task runs, the image is held in `chrome.storage.session` (browser memory, never written to disk) and deleted as soon as it has been sent, when the tab closes, or after 4 minutes.
- Nothing is sent anywhere else. No analytics.

Why each permission is there:

| Permission | Why |
|---|---|
| Access to all sites (`<all_urls>`) | The hover button has to work on every site, and the extension has to download the image or take a screenshot of it. |
| `storage` | Your settings, the short-lived task, and the debug log. |
| `clipboardWrite` | Copying the text. |
| `contextMenus` | The right-click item. |
| `sidePanel` | The side-panel mode. |
| `declarativeNetRequest` | Removes Google's "don't show me inside a frame" headers, **only** for AI Mode pages and **only** when the frame was started by this extension's own side panel. Normal browsing is untouched. |

## Limits (please read)

- The text comes from an AI model reading the picture. It is usually right, but it is a **transcription, not OCR in the strict sense**: check anything important (numbers, codes, passwords-like strings, small or blurry text).
- Works on `<img>` and `<canvas>` elements. Not on CSS background images, videos, or images inside closed shadow DOMs / PDFs; for those, right-click may still work.
- This automates Google's own AI Mode page, which is not an official API. If Google changes that page, attaching/sending/reading can break. The extension then stops safely instead of guessing: it never sends a question without the image, and if it can't find the answer it tells you instead of copying something random.
- AI Mode must be available in your country and account.

## If something doesn't work

Click the extension icon → **Copy debug log** → paste it to whoever is helping you. The log lists what the extension tried and, when it couldn't find a button or box on Google's page, which ones it saw instead.

## Files

| File | Role |
|---|---|
| `hover.js` | The hover button (shadow DOM so site CSS can't touch it), gets the image |
| `background.js` | Prepares the image, opens the side panel / tab, keeps the task, side-panel→tab fallback |
| `ai-task.js` | Runs inside Google AI Mode: attach image, type prompt, send, read the code block, copy |
| `sidepanel.html/js` | The side panel page that hosts AI Mode and does the clipboard write |
| `options.html/js`, `popup.html/js` | Settings and the icon popup (with the debug log) |
| `defaults.js`, `log.js` | Default settings, debug logger |
