/* Shared defaults (loaded by background, content script and options page). Uses `var` so re-injection is safe. */
var GS_DEFAULT_TEMPLATES = [
  { label: "Explain this error", prompt: "Explain this error in simple terms, tell me the most likely root cause, and give step-by-step fixes." },
  { label: "Summarize this chart", prompt: "Summarize this chart: what it shows, the key trends and outliers, and the main takeaway. Mention any axis or unit caveats." },
  { label: "Convert to markdown table", prompt: "Extract the data in this image and convert it into a clean Markdown table. Keep the original headers and values exactly." },
  { label: "Extract text (OCR)", prompt: "Transcribe all the text in this image exactly as written, preserving the structure." },
  { label: "Explain this code", prompt: "Explain what this code does, point out any bugs or bad practices, and suggest improvements." },
  { label: "Review this UI/UX", prompt: "Review this UI. List usability, accessibility and visual-design problems, ordered by severity, with concrete fixes." },
  { label: "Translate to English", prompt: "Translate all text in this image to English and keep the original layout where possible." }
];
var GS_DEFAULT_SETTINGS = {
  templates: GS_DEFAULT_TEMPLATES,
  target: 'sidepanel', // 'sidepanel' (embedded Gemini) or 'tab' (new tab each time)
  autoSubmit: false,   // press send automatically in Gemini
  quickPrompt: "Explain what is in this screenshot and point out anything important or wrong.", // used by Quick send
  autoSaveLog: true    // overwrite Downloads/GeminiSnap/debug-log.txt after every run
};
