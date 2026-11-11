// defaults.js — the settings defaults, shared by background.js (importScripts)
// and options.html (<script>). Content scripts never need this file.
globalThis.ITC_DEFAULTS = {
  prompt:
    "Transcribe all the text in this image exactly as it is written: same language and script, " +
    "same spelling, punctuation, numbering, symbols and line breaks. Do not translate, correct, " +
    "summarize, explain or add anything. Put the transcription inside one plain-text code block " +
    "and write nothing else. If the image contains no text, put NO TEXT FOUND in the code block.",
  autoSend: true, // press Send for you in AI Mode
  openIn: "sidepanel", // "sidepanel" (Chrome's side panel) or "tab" (a new tab)
  afterCopy: "stay" // new-tab mode only: "stay" on the AI Mode tab, or "return" to the page and close the AI tab
};
