// options.js — the settings page. The switches are described in the SECTIONS table below, so every
// feature has its own toggle; the preset editor and the two history viewers are built by hand.

(function () {
  const $ = (id) => document.getElementById(id);
  const root = $("root");
  let S = { ...TK.DEFAULTS };
  const bound = []; // { key, el, get, set } so storage changes can refresh the controls
  let savedTimer = null;

  const TOGGLE = "toggle";
  const SELECT = "select";
  const TEXT = "text";
  const AREA = "textarea";

  const SECTIONS = [
    {
      id: "main",
      title: "Your main features",
      desc: "The three things you asked for. Each can be switched off.",
      opts: [
        { k: "fHistory", t: TOGGLE, l: "Prompt history", h: "Remember every prompt that is sent (built-in, custom, and prompts you type yourself in AI Mode). Browse them below or in the side panel (🕘 History), ask them again, or use one as your default prompt. Stored only in this browser." },
        { k: "fReuse", t: TOGGLE, l: "Add new screenshots to the chat that is already open in the side panel", h: "On: a new screenshot / area goes into the AI Mode chat you already have open in the side panel, so you can keep talking about it. Off: every screenshot starts a fresh chat. (Side-panel mode only.)" },
        { k: "fAreaText", t: TOGGLE, l: "Select an area → exact text → copied", h: "Right-click → “Select an area and copy its text”, the shortcut Alt+Shift+K, or the ✂ Text button in the side panel. You drag a rectangle; Google AI Mode reads only the text in it and the text is copied for you." }
      ]
    },
    {
      id: "open",
      title: "Where and how AI Mode opens",
      opts: [
        { k: "openIn", t: SELECT, l: "Open Google AI Mode in", options: [["sidepanel", "Side panel (next to your page)"], ["tab", "New tab"]], h: "Showing Google inside the side panel is a trick that can fail on some setups; the extension then redoes the job in a new tab by itself." },
        { k: "autoSend", t: TOGGLE, l: "Press Send automatically", h: "Off: the image and prompt are placed in the box and you press Enter yourself (a copy task still copies the answer when it appears)." },
        { k: "afterCopy", t: SELECT, l: "New-tab mode: after the text is copied", options: [["stay", "Stay on the AI Mode tab"], ["return", "Go back to my page and close the tab"]] },
        { k: "useGemini", t: TOGGLE, l: "Use Gemini instead of AI Mode", exp: true, h: "Experimental and untested against the real Gemini page. Needs you to be signed in to Gemini. Plain-text questions (selection, history “Ask”) still go to AI Mode." }
      ]
    },
    {
      id: "search",
      title: "Screenshot and area search",
      desc: "Alt+Shift+L (whole page), Alt+Shift+S (an area), the right-click menu, or the side-panel buttons.",
      opts: [
        { k: "searchDestination", t: SELECT, l: "Send the picture to", options: [["aimode", "Google AI Mode (with your prompt)"], ["lens", "Google Lens"]] },
        { k: "autoAiMode", t: TOGGLE, l: "Lens: click “AI Mode” automatically afterwards", h: "Only when the picture goes to Google Lens." },
        { k: "defaultPrompt", t: AREA, l: "Default prompt", col: true, h: "Sent together with the picture. Leave empty to send only the picture and type your own question. Example: “Explain what is shown here, in simple Hinglish.”" }
      ]
    },
    {
      id: "copy",
      title: "Copying text from images",
      opts: [
        { k: "textPresetId", t: SELECT, l: "Prompt used by “copy text” (hover button, area text, image menu)", options: "presets", h: "“Copy exact text” is the default. Pick another preset (e.g. translate to English) to change what all copy-text actions do." },
        { k: "ocrEngine", t: SELECT, l: "Who reads the text?", options: [["ai", "Google AI (best, any language)"], ["local", "Offline reader (instant, English only)"], ["auto", "Offline first, Google AI if unsure"]], h: "The offline reader runs fully inside your browser (Tesseract) and is only used for the plain “Copy exact text” preset. With “Offline first”, a fallback to Google opens a new tab (the side panel can only open on a click)." },
        { k: "fPicker", t: TOGGLE, l: "Ask which prompt to use every time", h: "Before an image is sent, the side panel shows your presets (press 1–9) and a box for your own question. Needs the side-panel mode. (Not shown when the offline reader is set to read plain “Copy exact text” — that one needs no Google.)" },
        { k: "fPreview", t: TOGGLE, l: "Show the text first, copy when I press Copy", h: "A small box appears on your page with the text (you can edit it) instead of copying at once." },
        { k: "fCleanup", t: TOGGLE, l: "Tidy the copied text", h: "Removes zero-width characters and extra blank lines, and joins words that were split by a hyphen at a line end. Off = text copied exactly as read." },
        { k: "fJoinLines", t: TOGGLE, l: "Join all lines into one line", h: "Handy for copying a sentence that wrapped over several lines." },
        { k: "fCopyHistory", t: TOGGLE, l: "Keep a history of copied texts", h: "The last 50 copied texts, viewable below. Stored only in this browser." }
      ]
    },
    {
      id: "hover",
      title: "Hover button on images",
      opts: [
        { k: "fHover", t: TOGGLE, l: "Show the button when I hover over an image" },
        { k: "fHoverAltOnly", t: TOGGLE, l: "Only while I hold Alt", h: "Keeps the button out of your way until you want it." },
        { k: "hoverBlocklist", t: AREA, l: "Never show the button on these sites", col: true, h: "One site per line, e.g. youtube.com" }
      ]
    },
    {
      id: "menu",
      title: "Right-click menu items",
      desc: "Switch off the ones you don't use. (Chrome groups several items under “Lens AI Toolkit”.)",
      opts: [
        { k: "mImageText", t: TOGGLE, l: "On an image: Copy text from this image" },
        { k: "mImageLens", t: TOGGLE, l: "On an image: Search this image with Google Lens" },
        { k: "mAreaText", t: TOGGLE, l: "Select an area and copy its text", h: "Also needs “Select an area → exact text → copied” switched on above." },
        { k: "mPageArea", t: TOGGLE, l: "Select an area and search it" },
        { k: "mPageSearch", t: TOGGLE, l: "Search this page (screenshot)" },
        { k: "mScroll", t: TOGGLE, l: "Capture the whole page (scrolling) → AI Mode", h: "Scrolls the page and stitches screenshots. Sticky headers repeat, lazy-loaded parts may be blank, very tall pages are shrunk." },
        { k: "mSelection", t: TOGGLE, l: "On selected text: Ask Google AI Mode about it" },
        { k: "selectionPrefix", t: TEXT, l: "Text put before the selection", h: "e.g. “Explain simply: ”. Empty = ask the selected text as it is." }
      ]
    }
  ];

  // ---------- small helpers ----------

  function flashSaved() {
    $("saved").classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $("saved").classList.remove("show"), 1100);
  }

  function save(patch) {
    Object.assign(S, patch);
    return chrome.storage.local.set(patch).then(flashSaved);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) e.append(kid);
    return e;
  }

  function section(id, title, desc) {
    const s = el("section", { id }, el("h2", { text: title }));
    if (desc) s.append(el("p", { class: "d", text: desc }));
    root.append(s);
    $("nav").append(el("a", { href: "#" + id, text: title.split(" ").slice(0, 3).join(" ") }));
    return s;
  }

  // ---------- the switch table ----------

  function control(o) {
    let c;
    if (o.t === TOGGLE) {
      const input = el("input", { type: "checkbox" });
      c = el("label", { class: "sw" }, input, el("i"));
      input.addEventListener("change", () => save({ [o.k]: input.checked }));
      bound.push({ key: o.k, el: input, set: (v) => (input.checked = !!v) });
    } else if (o.t === SELECT) {
      const sel = el("select");
      sel.addEventListener("change", () => save({ [o.k]: sel.value }));
      c = sel;
      bound.push({ key: o.k, el: sel, set: (v) => (sel.value = v), fill: o.options === "presets" ? fillPresetSelect : null, sel });
      if (o.options !== "presets") for (const [v, label] of o.options) sel.append(el("option", { value: v, text: label }));
    } else {
      const input = o.t === AREA ? el("textarea", { spellcheck: "false" }) : el("input", { type: "text", spellcheck: "false" });
      input.addEventListener("input", debounce(() => save({ [o.k]: input.value }), 400));
      c = input;
      bound.push({ key: o.k, el: input, set: (v) => (input.value = v == null ? "" : v) });
    }
    return c;
  }

  function fillPresetSelect(sel) {
    const cur = S.textPresetId;
    sel.textContent = "";
    for (const p of TK.presetsOf(S)) sel.append(el("option", { value: p.id, text: p.name || p.id }));
    sel.value = cur;
    if (sel.value !== cur && sel.options.length) sel.value = sel.options[0].value;
  }

  function renderSwitches() {
    for (const sec of SECTIONS) {
      const s = section(sec.id, sec.title, sec.desc);
      for (const o of sec.opts) {
        const txt = el("div", { class: "txt" }, el("div", { class: "lb", text: o.l }));
        if (o.exp) txt.firstChild.append(el("span", { class: "exp", text: "experimental" }));
        if (o.h) txt.append(el("div", { class: "ht", text: o.h }));
        const row = el("div", { class: "opt" + (o.col ? " col" : "") });
        const c = control(o);
        if (o.col) row.append(txt, el("div", { class: "ctl" }, c));
        else row.append(txt, el("div", { class: "ctl" }, c));
        s.append(row);
      }
    }
  }

  function syncControls() {
    for (const b of bound) {
      if (document.activeElement === b.el) continue; // don't fight the user while typing
      if (b.fill) b.fill(b.sel);
      else b.set(S[b.key]);
    }
  }

  // ---------- prompt presets ----------

  let presetBox;
  function renderPresets() {
    const s = section("presets", "Prompt presets", "The prompts offered by the picker and used by “copy text”. “Copies text” presets must make Google answer inside ONE code block — the extension adds that sentence for you if you leave it out. “Asks” presets just send the prompt and leave the answer to read.");
    presetBox = el("div");
    s.append(presetBox);
    const bar = el("div", { class: "bar" });
    bar.append(
      el("button", {
        text: "+ Add a preset",
        onclick: () => {
          const list = TK.presetsOf(S).slice();
          list.push({ id: "p" + Date.now().toString(36), name: "My preset", mode: "ask", prompt: "" });
          save({ presets: list }).then(drawPresets);
        }
      }),
      el("button", {
        class: "danger",
        text: "Reset to the built-in presets",
        onclick: () => {
          if (confirm("Replace all presets with the built-in ones?")) save({ presets: TK.BUILTIN_PRESETS.map((p) => ({ ...p })), textPresetId: "copy" }).then(() => {
            drawPresets();
            syncControls();
          });
        }
      })
    );
    s.append(bar);
    drawPresets();
  }

  function drawPresets() {
    presetBox.textContent = "";
    const list = TK.presetsOf(S);
    const persist = debounce(() => save({ presets: list }).then(syncControls), 400);
    list.forEach((p, i) => {
      const name = el("input", { type: "text", value: p.name || "" });
      name.addEventListener("input", () => {
        p.name = name.value;
        persist();
      });
      const mode = el("select");
      mode.append(el("option", { value: "extract", text: "Copies text" }), el("option", { value: "ask", text: "Asks" }));
      mode.value = p.mode === "ask" ? "ask" : "extract";
      mode.addEventListener("change", () => {
        p.mode = mode.value;
        persist();
      });
      const del = el("button", {
        class: "danger",
        text: "Delete",
        onclick: () => {
          if (p.id === "copy") return alert("“Copy exact text” is needed by the hover button and area copy, so it stays. You can edit its prompt.");
          list.splice(i, 1);
          save({ presets: list }).then(() => {
            drawPresets();
            syncControls();
          });
        }
      });
      const prompt = el("textarea", { spellcheck: "false" });
      prompt.value = p.prompt || "";
      prompt.addEventListener("input", () => {
        p.prompt = prompt.value;
        persist();
      });
      presetBox.append(el("div", { class: "preset" }, el("div", { class: "top" }, name, mode, del), prompt));
    });
  }

  // ---------- history viewers ----------

  function fmt(ts) {
    return new Date(ts).toLocaleString();
  }

  function itemCard(textValue, metaParts, buttons) {
    const card = el("div", { class: "item" }, el("div", { class: "t", text: textValue }));
    const meta = el("div", { class: "m" });
    for (const [kind, v] of metaParts) meta.append(kind === "tag" ? el("span", { class: "tag", text: v }) : document.createTextNode(v));
    card.append(meta, el("div", { class: "bar", style: "margin:0" }, ...buttons));
    return card;
  }

  async function copyPlain(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    flashSaved();
  }

  let pBox, pSearch, pFilter, cBox;

  function renderHistorySections() {
    const sp = section("history", "Prompt history", "Every prompt that was sent (or that you typed in AI Mode). Newest first; repeated prompts are counted.");
    pSearch = el("input", { type: "search", placeholder: "Search…" });
    pFilter = el("select");
    pFilter.append(el("option", { value: "all", text: "All prompts" }), el("option", { value: "mine", text: "Mine (typed / custom / selection)" }));
    pSearch.addEventListener("input", drawPromptHistory);
    pFilter.addEventListener("change", drawPromptHistory);
    pBox = el("div");
    sp.append(
      el("div", { class: "bar" }, pSearch, pFilter,
        el("button", { text: "Export as text", onclick: exportHistory }),
        el("button", { class: "danger", text: "Clear all", onclick: async () => { if (confirm("Delete the whole prompt history?")) { await TK.clearList("promptHistory"); drawPromptHistory(); } } })),
      pBox
    );

    const sc = section("copies", "Copied texts", "The last 50 texts the extension copied for you.");
    cBox = el("div");
    sc.append(
      el("div", { class: "bar" }, el("button", { class: "danger", text: "Clear all", onclick: async () => { if (confirm("Delete the copy history?")) { await TK.clearList("copyHistory"); drawCopyHistory(); } } })),
      cBox
    );
    drawPromptHistory();
    drawCopyHistory();
  }

  async function drawPromptHistory() {
    const { promptHistory = [] } = await chrome.storage.local.get("promptHistory");
    const q = pSearch.value.trim().toLowerCase();
    const mine = pFilter.value === "mine";
    const items = promptHistory.filter((e) => (!mine || ["typed", "custom", "selection"].includes(e.kind)) && (!q || e.text.toLowerCase().includes(q)));
    pBox.textContent = "";
    if (!items.length) return pBox.append(el("div", { class: "empty", text: promptHistory.length ? "Nothing matches." : "Nothing here yet." }));
    for (const e of items) {
      pBox.append(
        itemCard(e.text, [["tag", e.kind], ["t", "×" + (e.count || 1) + " · last " + fmt(e.ts) + (e.via ? " · " + e.via : "")]], [
          el("button", { text: "Copy", onclick: () => copyPlain(e.text) }),
          el("button", { text: "Use as default prompt", onclick: () => save({ defaultPrompt: e.text }).then(syncControls) }),
          el("button", { class: "danger", text: "Delete", onclick: async () => { await TK.deleteFromList("promptHistory", e.id); drawPromptHistory(); } })
        ])
      );
    }
  }

  async function drawCopyHistory() {
    const { copyHistory = [] } = await chrome.storage.local.get("copyHistory");
    cBox.textContent = "";
    if (!copyHistory.length) return cBox.append(el("div", { class: "empty", text: "Nothing here yet." }));
    for (const e of copyHistory) {
      cBox.append(
        itemCard(e.text, [["t", e.chars + " characters · " + fmt(e.ts) + (e.engine ? " · " + e.engine : "") + (e.via ? " · " + e.via : "")]], [
          el("button", { text: "Copy again", onclick: () => copyPlain(e.text) }),
          el("button", { class: "danger", text: "Delete", onclick: async () => { await TK.deleteFromList("copyHistory", e.id); drawCopyHistory(); } })
        ])
      );
    }
  }

  async function exportHistory() {
    const { promptHistory = [] } = await chrome.storage.local.get("promptHistory");
    const text = promptHistory.map((e) => "[" + fmt(e.ts) + "] (" + e.kind + ", ×" + (e.count || 1) + (e.via ? ", " + e.via : "") + ")\n" + e.text).join("\n\n----------\n\n");
    const url = URL.createObjectURL(new Blob([text || "(empty)"], { type: "text/plain" }));
    const a = el("a", { href: url, download: "lens-ai-toolkit-prompt-history.txt" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- shortcuts and reset ----------

  async function renderShortcuts() {
    const s = section("keys", "Keyboard shortcuts", "Chrome lets an extension suggest only four keys; change or add any of them on Chrome's own page.");
    const box = el("div");
    s.append(box);
    try {
      const cmds = await chrome.commands.getAll();
      for (const c of cmds) {
        if (c.name === "_execute_action") continue;
        box.append(el("div", { class: "opt" }, el("div", { class: "txt" }, el("div", { class: "lb", text: c.description || c.name })), el("div", { class: "ctl" }, c.shortcut ? el("kbd", { text: c.shortcut }) : el("span", { class: "ht", text: "not set" }))));
      }
    } catch (e) {}
    s.append(el("div", { class: "bar" }, el("button", { text: "Change shortcuts…", onclick: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) })));
  }

  function renderReset() {
    const s = section("reset", "Reset", "Puts every switch and preset back to its default. Your histories are kept.");
    s.append(
      el("div", { class: "bar" }, el("button", { class: "danger", text: "Reset all settings", onclick: () => {
        if (!confirm("Reset all settings to the defaults?")) return;
        chrome.storage.local.set(JSON.parse(JSON.stringify(TK.DEFAULTS))).then(async () => {
          S = await TK.getSettings();
          syncControls();
          drawPresets();
          flashSaved();
        });
      } }))
    );
  }

  // ---------- start ----------

  (async function init() {
    S = await TK.getSettings();
    renderSwitches();
    renderPresets();
    renderHistorySections();
    renderShortcuts();
    renderReset();
    syncControls();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let touched = false;
      for (const k of Object.keys(TK.DEFAULTS)) if (changes[k]) { S[k] = changes[k].newValue; touched = true; }
      if (touched) syncControls();
      if (changes.promptHistory) drawPromptHistory();
      if (changes.copyHistory) drawCopyHistory();
    });
  })();
})();
