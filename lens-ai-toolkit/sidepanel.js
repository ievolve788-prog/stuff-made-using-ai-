// sidepanel.js — the side panel page. It hosts Google AI Mode in an iframe (background.js strips
// the "don't frame me" headers for that), keeps the chat open so new screenshots can be added to it,
// shows the prompt picker, the prompt history, and does the clipboard write for the page inside.

(function () {
  const $ = (id) => document.getElementById(id);
  const PANEL_KEY = "tk:panel";
  const FRESH_MS = 20000; // a task older than this is leftover, not meant for a panel that just opened
  const REUSE_WAIT_MS = 6000; // the open chat must pick up a new screenshot within this time
  const LOAD_WAIT_MS = 15000; // a freshly loaded page must check in within this time
  const AI_HOME = "https://www.google.com/ai";
  const GEMINI_HOME = "https://gemini.google.com/app";
  const store = chrome.storage.session || chrome.storage.local;

  let S = { ...TK.DEFAULTS };
  let winId = null;
  let frame = null;
  let frameReady = false; // the page inside said hello (it can take a new screenshot)
  let curId = null; // the task we are handling
  let phase = null; // "choose" | "run"
  let claimTimer = null;
  let idleTimer = null;
  let statusTimer = null;

  const log = (msg, data) => tkLog("side-panel", msg, data);
  const home = () => (S.useGemini ? GEMINI_HOME : AI_HOME);
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch (e) {
      return "https://www.google.com";
    }
  };
  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res === undefined ? null : res));
      } catch (e) {
        resolve(null);
      }
    });

  function setStatus(text, ms) {
    $("status").textContent = text || "";
    $("status").title = text || "";
    clearTimeout(statusTimer);
    if (text && ms) statusTimer = setTimeout(() => ($("status").textContent = ""), ms);
  }

  // ---------- the frame ----------

  function loadFrame(url) {
    clearTimeout(idleTimer);
    if (frame) frame.remove();
    frameReady = false;
    frame = document.createElement("iframe");
    frame.allow = "clipboard-write; clipboard-read";
    frame.src = url;
    $("frameWrap").appendChild(frame);
    $("idle").style.display = "none";
    log("frame loading", { url: url.slice(0, 200) });
  }

  window.addEventListener("message", (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    if (e.data && e.data.tk === "hello") {
      frameReady = true;
      log("page inside the panel is ready for new screenshots");
    } else if (e.data && e.data.tk === "fresh" && e.data.id === curId) {
      // The open chat could not take the image: start a fresh chat and let the page there do the job.
      store.get(PANEL_KEY).then((got) => {
        const t = got[PANEL_KEY];
        if (t && t.id === curId) {
          log("fresh chat requested by the page inside");
          loadTask(t);
        }
      });
    }
  });

  function waitClaim(id, ms, onTimeout) {
    clearTimeout(claimTimer);
    claimTimer = setTimeout(async () => {
      const got = await store.get(PANEL_KEY);
      const t = got[PANEL_KEY];
      if (t && t.id === id && !t.claimed) onTimeout(t);
    }, ms);
  }

  async function fallbackToTab(task) {
    setStatus("Moving to a new tab…");
    const r = await send({ action: "panelFallback", id: task.id, reason: "side panel: the page inside never checked in" });
    log("panel fallback", { result: r });
    if (!r || !r.ok) setStatus("Couldn't load Google here — try the “New chat” button or switch to “New tab” in Settings.");
  }

  function loadTask(task) {
    loadFrame(task.url || home());
    setStatus(task.kind === "open" ? "Opening AI Mode…" : "Opening AI Mode and attaching the image…");
    waitClaim(task.id, LOAD_WAIT_MS, fallbackToTab);
  }

  function begin(task) {
    phase = "run";
    hidePicker();
    const canReuse = S.fReuse && task.kind !== "open" && frame && frameReady;
    if (canReuse) {
      setStatus("Adding it to the open chat…");
      try {
        frame.contentWindow.postMessage({ tk: "newTask" }, originOf(frame.src));
      } catch (e) {
        log("postMessage to the chat failed", { message: e.message });
      }
      log("reusing the open chat", { id: task.id });
      waitClaim(task.id, REUSE_WAIT_MS, (t) => {
        log("open chat did not pick the task up, loading a fresh page");
        loadTask(t);
      });
    } else {
      loadTask(task);
    }
  }

  // ---------- the task in storage ----------

  function apply(task) {
    if (!task) {
      if (curId) {
        curId = null;
        phase = null;
        clearTimeout(claimTimer);
        hidePicker();
        setStatus("");
      }
      return;
    }
    if (task.id === curId) {
      if (task.claimed) clearTimeout(claimTimer);
      if (phase === "choose" && task.stage !== "choose") begin(task);
      else if (task.stage === "sent" && task.kind !== "ask") setStatus("Waiting for Google's answer…");
      else if (task.stage === "sent") setStatus("Sent ✓", 4000);
      return;
    }
    if (Date.now() - task.updated > FRESH_MS) return; // leftover
    curId = task.id;
    if (task.stage === "choose") {
      phase = "choose";
      showPicker(task);
    } else begin(task);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (changes[PANEL_KEY] && (area === "session" || (store === chrome.storage.local && area === "local"))) apply(changes[PANEL_KEY].newValue);
    if (area === "local") {
      for (const k of Object.keys(TK.DEFAULTS)) if (changes[k]) S[k] = changes[k].newValue;
      if (changes.fReuse) $("reuse").checked = !!S.fReuse;
      if (changes.fHistory || changes.fAreaText) refreshSwitches();
      if (changes.promptHistory && $("history").classList.contains("show")) renderHistory();
    }
  });

  // ---------- prompt picker ----------

  let pickerTask = null;
  function hidePicker() {
    $("picker").classList.remove("show");
    pickerTask = null;
  }

  function showPicker(task) {
    pickerTask = task;
    $("history").classList.remove("show");
    $("thumb").src = "data:" + (task.mime || "image/png") + ";base64," + task.image;
    const box = $("presets");
    box.textContent = "";
    TK.presetsOf(S).forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "preset";
      b.innerHTML = '<kbd></kbd><span class="nm"></span><span class="tg"></span>';
      b.querySelector("kbd").textContent = i < 9 ? String(i + 1) : "";
      b.querySelector(".nm").textContent = p.name || p.id;
      b.querySelector(".tg").textContent = p.mode === "extract" ? "copies text" : "asks";
      b.title = p.prompt;
      b.addEventListener("click", () => choose({ presetId: p.id }));
      box.appendChild(b);
    });
    $("custom").value = "";
    $("customExtract").checked = false;
    $("picker").classList.add("show");
    setStatus("Choose what to do with the image");
  }

  async function choose(choice) {
    if (!pickerTask) return;
    const id = pickerTask.id;
    setStatus("Working…");
    const r = await send({ action: "taskChoose", id, choice });
    if (!r || !r.ok) setStatus("Couldn't use that choice" + (r && r.reason ? ": " + r.reason : ""), 6000);
    // on success the task changes in storage and apply() carries on
  }

  $("customSend").addEventListener("click", () => {
    const prompt = $("custom").value.trim();
    if (!prompt) return $("custom").focus();
    choose({ prompt, mode: $("customExtract").checked ? "extract" : "ask" });
  });
  $("pickCancel").addEventListener("click", async () => {
    if (pickerTask) await send({ action: "taskCancel", id: pickerTask.id });
    hidePicker();
    setStatus("");
  });
  document.addEventListener("keydown", (e) => {
    if (!$("picker").classList.contains("show") || e.target.tagName === "TEXTAREA" || e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^[1-9]$/.test(e.key)) {
      const p = TK.presetsOf(S)[Number(e.key) - 1];
      if (p) choose({ presetId: p.id });
    } else if (e.key === "Escape") $("pickCancel").click();
  });

  // ---------- prompt history ----------

  const KIND_LABEL = { preset: "preset", default: "default", custom: "custom", typed: "typed", selection: "selection" };

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    const d = Math.round(h / 24);
    return d === 1 ? "yesterday" : d + " days ago";
  }

  async function renderHistory() {
    const { promptHistory = [] } = await chrome.storage.local.get("promptHistory");
    const q = $("hSearch").value.trim().toLowerCase();
    const mine = $("hFilter").value === "mine";
    const items = promptHistory.filter((e) => (!mine || e.kind === "typed" || e.kind === "custom" || e.kind === "selection") && (!q || e.text.toLowerCase().includes(q)));
    $("hOff").style.display = S.fHistory ? "none" : "block";
    const list = $("hList");
    list.textContent = "";
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = promptHistory.length ? "Nothing matches." : "No prompts yet. Every prompt you send (or type in AI Mode) shows up here.";
      list.appendChild(d);
      return;
    }
    for (const e of items) {
      const card = document.createElement("div");
      card.className = "hItem";
      const text = document.createElement("div");
      text.className = "hText";
      text.textContent = e.text;
      text.title = "Click to expand";
      text.addEventListener("click", () => text.classList.toggle("open"));
      const meta = document.createElement("div");
      meta.className = "hMeta";
      meta.innerHTML = '<span class="tag"></span><span class="w"></span>';
      meta.querySelector(".tag").textContent = KIND_LABEL[e.kind] || e.kind;
      meta.querySelector(".w").textContent = "×" + (e.count || 1) + " · " + ago(e.ts) + (e.via ? " · " + e.via : "");
      const btns = document.createElement("div");
      btns.className = "hBtns";
      const mk = (label, title, fn, cls) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        if (cls) b.className = cls;
        b.addEventListener("click", fn);
        btns.appendChild(b);
      };
      mk("Ask", "Ask this in AI Mode now (no image)", () => askNow(e.text));
      mk("Copy", "Copy this prompt", async () => {
        await copyText(e.text);
        setStatus("Prompt copied ✓", 3000);
      });
      mk("Use as default", "Use as the prompt for screenshot / area searches", async () => {
        await chrome.storage.local.set({ defaultPrompt: e.text });
        setStatus("Set as the default prompt ✓", 3000);
      });
      mk("✕", "Delete this entry", async () => {
        await TK.deleteFromList("promptHistory", e.id);
        renderHistory();
      }, "danger");
      card.append(text, meta, btns);
      list.appendChild(card);
    }
  }

  function askNow(text) {
    $("history").classList.remove("show");
    $("bHistory").classList.remove("on");
    curId = null;
    loadFrame("https://www.google.com/search?udm=50&q=" + encodeURIComponent(text));
    setStatus("Asking AI Mode…", 4000);
    send({ action: "recordPrompt", text, via: "history: ask again" });
  }

  function toggleHistory(show) {
    const on = show === undefined ? !$("history").classList.contains("show") : show;
    $("history").classList.toggle("show", on);
    $("bHistory").classList.toggle("on", on);
    if (on) renderHistory();
  }

  $("bHistory").addEventListener("click", () => toggleHistory());
  $("hClose").addEventListener("click", () => toggleHistory(false));
  $("hSearch").addEventListener("input", renderHistory);
  $("hFilter").addEventListener("change", renderHistory);
  $("hClear").addEventListener("click", async () => {
    if (confirm("Delete the whole prompt history?")) {
      await TK.clearList("promptHistory");
      renderHistory();
    }
  });
  $("hMore").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("hTurnOn").addEventListener("click", () => chrome.storage.local.set({ fHistory: true }));

  // ---------- header buttons ----------

  function refreshSwitches() {
    $("bAreaText").style.display = S.fAreaText ? "" : "none";
  }

  async function capture(purpose, hint) {
    if (winId == null) return setStatus("Not ready yet — try again.", 3000);
    setStatus(hint, 6000);
    const r = await send({ action: "panelCapture", purpose, windowId: winId });
    if (!r || !r.ok) setStatus("Couldn't start: " + ((r && r.error) || "no answer"), 6000);
  }
  $("bAreaText").addEventListener("click", () => capture("areaText", "Drag over the text on your page…"));
  $("bArea").addEventListener("click", () => capture("area", "Drag over the area on your page…"));
  $("bScreen").addEventListener("click", () => capture("screen", "Capturing the page…"));
  $("bPage").addEventListener("click", () => capture("scroll", "Capturing the whole page — don't scroll…"));
  $("bNew").addEventListener("click", () => {
    curId = null;
    hidePicker();
    $("history").classList.remove("show");
    loadFrame(home());
    setStatus("");
  });
  $("bSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("reuse").addEventListener("change", (e) => chrome.storage.local.set({ fReuse: e.target.checked }));

  // ---------- clipboard for the page inside the frame ----------

  async function copyText(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) return true;
    } catch (e) {}
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === "copyText" && typeof msg.text === "string") {
      copyText(msg.text).then((ok) => sendResponse({ ok }));
      return true;
    }
    return false;
  });

  // ---------- start ----------

  (async function init() {
    try {
      S = await TK.getSettings();
    } catch (e) {}
    $("reuse").checked = !!S.fReuse;
    refreshSwitches();
    chrome.windows.getCurrent().then(
      (w) => {
        winId = w.id;
      },
      () => {}
    );
    const got = await store.get(PANEL_KEY);
    const task = got[PANEL_KEY];
    if (task && !task.claimed && Date.now() - task.updated <= FRESH_MS) apply(task);
    // Nothing for us? Then show a normal AI Mode chat (a moment later: a task may be about to arrive).
    idleTimer = setTimeout(() => {
      if (!frame && !curId) {
        loadFrame(home());
        setStatus("");
      }
    }, 1200);
  })();
})();
