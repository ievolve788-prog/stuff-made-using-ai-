# Typexpand

An Espanso-style text expander for Chrome and Firefox (Manifest V3, one codebase).

Type a trigger such as `:date` in any text field and it is replaced by the snippet.
**Type mode is the default**: the replacement is entered character by character with real
input events, like Espanso's `inject` backend. Paste mode (instant insert) is available
globally or per snippet.

## Install

**Chrome / Edge / Brave:** open `chrome://extensions`, enable *Developer mode*, click
*Load unpacked* and select this folder.

**Firefox:** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on* and
select `manifest.json`. Temporary add-ons are removed when Firefox closes. For a permanent
install, either sign it through addons.mozilla.org (unlisted) or use Firefox Developer
Edition / Nightly with `xpinstall.signatures.required` set to `false` and install the zip.

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

## Limits

- Works in `<input>` (text/search/url/tel), `<textarea>` and `contenteditable` editors.
  Not in password fields (by design), email/number inputs (no caret API), or canvas editors
  such as Google Docs. Add such sites to the exclusion list or use the clipboard hotkeys.
- Extensions cannot run on browser pages (`chrome://`, `about:`, the Chrome Web Store,
  addons.mozilla.org) or in the built-in PDF viewer.
- Trigger matching is case-sensitive and happens within a single text node.
- Settings are stored locally (`storage.local`), not synced.
