// settings.js — defaults, built-in prompts, and the two histories. Shared by every
// part of the extension (importScripts in the service worker, <script> in the pages,
// listed first in content_scripts). Everything lives in chrome.storage.local, on this
// computer only.
(function (g) {
  const TK = (g.TK = g.TK || {});

  // The prompt that makes Google answer with ONLY the text of the picture, inside one code
  // block. The extension finds the text by that code block, so keep that sentence if you edit it.
  TK.EXACT_PROMPT =
    "Transcribe all the text in this image exactly as it is written: same language and script, " +
    "same spelling, punctuation, numbering, symbols and line breaks. Do not translate, correct, " +
    "summarize, explain or add anything. Put the transcription inside one plain-text code block " +
    "and write nothing else. If the image contains no text, put NO TEXT FOUND in the code block.";

  // "extract" presets: the answer is a code block that gets copied to the clipboard.
  // "ask" presets: the prompt is just sent with the image; you read the answer yourself.
  TK.BUILTIN_PRESETS = [
    { id: "copy", name: "Copy exact text", mode: "extract", prompt: TK.EXACT_PROMPT },
    {
      id: "translate",
      name: "Translate to English",
      mode: "extract",
      prompt:
        "Translate all the text in this image into English. Put only the translation inside one " +
        "plain-text code block and write nothing else. If the image contains no text, put NO TEXT FOUND in the code block."
    },
    {
      id: "code",
      name: "Copy code",
      mode: "extract",
      prompt:
        "Transcribe the source code in this image exactly, keeping indentation, symbols and line breaks. " +
        "Put it inside one plain-text code block and write nothing else. If there is no code, put NO TEXT FOUND in the code block."
    },
    {
      id: "table",
      name: "Table → Markdown",
      mode: "extract",
      prompt:
        "Convert the table in this image into a Markdown table, keeping every cell exactly as written. " +
        "Put it inside one plain-text code block and write nothing else. If there is no table, put NO TEXT FOUND in the code block."
    },
    { id: "solve", name: "Solve and explain", mode: "ask", prompt: "Solve the problem shown in this image and explain the steps briefly." },
    { id: "quiz", name: "Quiz me", mode: "ask", prompt: "Make 5 quiz questions with answers based on what is shown in this image." },
    { id: "summary", name: "Summarize", mode: "ask", prompt: "Summarize what is shown in this image in a few short bullet points." }
  ];

  TK.CODEBLOCK_SUFFIX = "Put your whole answer inside one plain-text code block and write nothing else.";

  TK.DEFAULTS = {
    // ----- where and how Google AI Mode opens -----
    openIn: "sidepanel", // "sidepanel" | "tab"
    autoSend: true, // press Send for you
    afterCopy: "stay", // tab mode only: "stay" | "return"
    searchDestination: "aimode", // screenshot / area SEARCH: "aimode" | "lens"
    autoAiMode: false, // Lens destination only: click "AI Mode" after the Lens search
    defaultPrompt: "", // prompt sent with a screenshot / area SEARCH (empty = image only, you type)
    textPresetId: "copy", // the preset used by "copy text" (hover, area text, image menu)
    presets: TK.BUILTIN_PRESETS,
    backend: "google", // "google" (AI Mode) | "gemini" (experimental)

    // ----- the features you asked for (each has its own switch) -----
    fHistory: true, // remember every prompt that is sent
    fReuse: true, // new screenshots go into the chat that is already open in the side panel
    fAreaText: true, // select an area -> exact text -> clipboard (menu, shortcut, panel button)

    // ----- extra features -----
    fHover: true, // the hover button on images
    fHoverAltOnly: false, // ...only while Alt is held
    hoverBlocklist: "", // one site per line: no hover button there
    fPicker: false, // ask which prompt to use before each image is sent (side panel)
    fPreview: false, // show the text first and copy only when you press Copy
    fCleanup: false, // tidy the text: no trailing spaces, no zero-width chars, fix hyphenated line breaks
    fJoinLines: false, // ...and join all lines into one paragraph
    fCopyHistory: true, // keep the last copied texts
    ocrEngine: "ai", // "ai" | "local" (offline, English) | "auto" (local first, AI if unsure)
    useGemini: false, // experimental: Gemini instead of AI Mode (backend)
    selectionPrefix: "", // text put before a selection sent to AI Mode, e.g. "Explain: "

    // ----- right-click menu items (each can be hidden) -----
    mImageText: true,
    mImageLens: true,
    mPageSearch: true,
    mPageArea: true,
    mAreaText: true,
    mSelection: true,
    mScroll: true
  };

  TK.getSettings = () => chrome.storage.local.get(TK.DEFAULTS);

  // The preset list with built-ins guaranteed (an old/empty list never leaves you without "copy").
  TK.presetsOf = function (s) {
    const list = Array.isArray(s && s.presets) && s.presets.length ? s.presets : TK.BUILTIN_PRESETS;
    return list.filter((p) => p && p.id && typeof p.prompt === "string");
  };

  TK.presetById = function (s, id) {
    const list = TK.presetsOf(s);
    return list.find((p) => p.id === id) || TK.BUILTIN_PRESETS.find((p) => p.id === id) || TK.BUILTIN_PRESETS[0];
  };

  // An "extract" prompt must tell Google to use a code block — add the sentence if it is missing.
  TK.finalizePrompt = function (preset) {
    const p = String(preset.prompt || "").trim();
    if (preset.mode === "extract" && !/code block/i.test(p)) return (p + "\n\n" + TK.CODEBLOCK_SUFFIX).trim();
    return p;
  };

  TK.hostBlocked = function (host, listText) {
    const h = String(host || "").toLowerCase();
    return String(listText || "")
      .split(/[\s,]+/)
      .map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, ""))
      .filter(Boolean)
      .some((d) => h === d || h.endsWith("." + d));
  };

  // ---------- histories (chrome.storage.local) ----------

  TK.HISTORY_MAX = 300;
  TK.COPY_HISTORY_MAX = 50;
  TK.COPY_TEXT_MAX = 20000;

  // One write at a time, so two quick entries can't overwrite each other.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  };

  // kind: "preset" | "default" | "custom" | "typed" | "selection"; via: free text ("hover", "area text"...)
  TK.recordPrompt = (text, kind, via) =>
    serial(async () => {
      const t = String(text || "").trim();
      if (!t) return null;
      const { promptHistory = [] } = await chrome.storage.local.get("promptHistory");
      const i = promptHistory.findIndex((e) => e.text === t);
      const e = i >= 0 ? promptHistory.splice(i, 1)[0] : { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: t, kind: kind || "custom", first: Date.now(), count: 0 };
      e.count = (e.count || 0) + 1;
      e.ts = Date.now();
      e.via = via || e.via || "";
      promptHistory.unshift(e);
      while (promptHistory.length > TK.HISTORY_MAX) promptHistory.pop();
      await chrome.storage.local.set({ promptHistory });
      return e;
    });

  TK.recordCopy = (text, meta) =>
    serial(async () => {
      const t = String(text || "");
      if (!t) return null;
      const { copyHistory = [] } = await chrome.storage.local.get("copyHistory");
      const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), text: t.slice(0, TK.COPY_TEXT_MAX), chars: t.length, ...(meta || {}) };
      copyHistory.unshift(e);
      while (copyHistory.length > TK.COPY_HISTORY_MAX) copyHistory.pop();
      await chrome.storage.local.set({ copyHistory });
      return e;
    });

  TK.deleteFromList = (key, id) =>
    serial(async () => {
      const got = await chrome.storage.local.get(key);
      const list = (got[key] || []).filter((e) => e.id !== id);
      await chrome.storage.local.set({ [key]: list });
      return list;
    });

  TK.clearList = (key) => serial(() => chrome.storage.local.set({ [key]: [] }));
})(globalThis);
