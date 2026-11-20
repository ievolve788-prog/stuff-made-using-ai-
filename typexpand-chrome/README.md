# Typexpand

An Espanso-style text expander for Chrome and Firefox (Manifest V3, one codebase).

Type a trigger such as `:date` in any text field and it is replaced by the snippet.
**Type mode is the default**: the replacement is entered character by character with real
input events, like Espanso's `inject` backend. Paste mode (instant insert) is available
globally or per snippet.

## Install

**Chrome / Edge / Brave:** unzip `typexpand-chrome.zip`, open `chrome://extensions`, enable
*Developer mode*, click *Load unpacked* and select the unzipped folder.

**Firefox:** unzip `typexpand-firefox.zip`, open `about:debugging#/runtime/this-firefox`,
click *Load Temporary Add-on* and select `manifest.json` inside it. Temporary add-ons are removed when Firefox closes. For a permanent
install, either sign it through addons.mozilla.org (unlisted) or use Firefox Developer
Edition / Nightly with `xpinstall.signatures.required` set to `false` and install the zip.

The two builds differ only in `manifest.json` (Chrome needs a `service_worker`, Firefox needs
`scripts`). In the source folder, `manifest.json` is the Chrome one and
`manifest.firefox.json` is the Firefox one.

## Using it

- Click the toolbar icon, then *Edit snippets & settings*.
- **Type clipboard:** `Alt+Shift+V` types whatever is on the clipboard into the focused field.
  `Alt+Shift+B` pastes it instantly. Both are also in the right-click menu on text fields.
  Rebind at `chrome://extensions/shortcuts` or `about:addons` > gear > *Manage Extension Shortcuts*.
- **Snippet that types the clipboard:** the default `:clip` snippet is just `{{clipboard}}`.
- **Per snippet:** choose Default / Type / Paste, and "word" to expand only at the start of a word.

### Variables

`{{date}}` `{{time}}` `{{datetime}}`, with formats such as `{{date:DD/MM/YYYY}}`
(tokens: YYYY YY MMMM MMM MM DD dddd ddd HH hh mm ss A), `{{clipboard}}`, `{{uuid}}`,
`{{cursor}}` (where the caret lands after expansion).

### Import / export

JSON only: `{ "snippets": [ { "trigger": ":x", "replace": "..." } ] }`. A bare array or an
object with a `matches` array of `{trigger, replace}` also works. Espanso's YAML is not parsed.

## Sites that block pasting

Typing the clipboard (`Alt+Shift+V`, `:clip`, any snippet) works on sites that block paste,
because it never uses the page's paste event: the clipboard is read in the extension's own
background and the text is then entered as ordinary keystrokes. Paste mode is also not a
paste event. Sites that actively detect synthetic or machine-speed typing can still object;
raise the typing delay in settings if that happens.

## Limits

- Works in every `<input>` type that takes text (text, search, url, tel, email, number,
  password), `<textarea>`, and `contenteditable` editors, including inside iframes and
  shadow DOM. Where the caret position can't be read (email/number inputs, unusual editors)
  it falls back to a small in-memory keystroke buffer and removes the trigger by
  backspacing it. Password-field expansion can be switched off in settings.
- Number inputs only accept digits and a few symbols, so triggers there must be made of
  those characters (a trigger like `:x` can't even be typed into them).
- Not guaranteed: editors that handle keys themselves and bypass normal input events
  (Google Docs and other canvas editors, some web terminals / remote desktops). Use the
  clipboard hotkeys there, or exclude the site. Untested by me in real browsers.
- Browsers do not let any extension run on their own pages (`chrome://`, `about:`, the
  Chrome Web Store, addons.mozilla.org), the built-in PDF viewer, or the OS/browser
  password prompts and address bar. This cannot be changed from an extension.
- Trigger matching is case-sensitive and happens within a single text node.
- Settings are stored locally (`storage.local`), not synced.
