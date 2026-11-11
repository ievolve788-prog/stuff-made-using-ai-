// sidepanel.js — the side panel page.
//
// It shows Google AI Mode in an iframe when background.js leaves a task for it,
// and watches that the page inside (ai-task.js) checks in. If nothing checks in
// within FALLBACK_MS (Google refused to be framed, you're on a sign-in page...)
// it asks background.js to redo the task in a normal new tab.
//
// It also does the actual clipboard write for ai-task.js: this page is an
// extension page with the clipboardWrite permission, so unlike the Google page
// it can copy even when it doesn't have keyboard focus.

(function () {
  const AI_MODE_URL = "https://www.google.com/ai";
  const PANEL_KEY = "imgTask:panel";
  const FALLBACK_MS = 15000; // how long to wait for the page inside to check in
  const FRESH_MS = 30000; // a task older than this is stale (e.g. the panel was reopened later)
  const store = chrome.storage.session || chrome.storage.local;

  const $ = (id) => document.getElementById(id);
  let currentId = null;
  let timer = null;
  let frame = null;

  function setStatus(text) {
    $("status").textContent = text || "";
    $("status").title = text || "";
  }

  function showIdle(note) {
    if (frame) {
      frame.remove();
      frame = null;
    }
    $("idle").hidden = false;
    $("why").textContent = note || "";
    $("why").className = note ? "note" : "";
  }

  function loadFrame(id) {
    if (frame) frame.remove();
    $("idle").hidden = true;
    frame = document.createElement("iframe");
    frame.id = "frame";
    frame.allow = "clipboard-write; clipboard-read";
    frame.src = AI_MODE_URL;
    document.body.appendChild(frame);
    setStatus("Opening Google AI Mode…");

    clearTimeout(timer);
    timer = setTimeout(async () => {
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ action: "panelFallback", id, reason: "page did not check in" });
      } catch (e) {}
      if (res && res.ok) {
        setStatus("");
        showIdle("Google AI Mode couldn't be shown here, so it was opened in a new tab instead.");
      } else {
        setStatus("Still loading… (if nothing happens, use “Open in tab”)");
      }
    }, FALLBACK_MS);
  }

  // A task appeared or changed.
  function apply(task) {
    if (!task) return;
    if (task.id !== currentId) {
      if (task.claimed || Date.now() - task.updated > FRESH_MS) return; // stale: never resurrect an old task
      currentId = task.id;
      loadFrame(task.id);
      return;
    }
    if (task.claimed) {
      clearTimeout(timer);
      timer = null;
      setStatus(task.stage === "sent" ? "Waiting for Google's answer…" : "Working…");
    }
  }

  store.get(PANEL_KEY).then((r) => apply(r[PANEL_KEY]), () => {});
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[PANEL_KEY]) apply(changes[PANEL_KEY].newValue);
  });

  // ---------- clipboard, on behalf of ai-task.js ----------

  async function copy(text) {
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
      copy(msg.text).then((ok) => sendResponse({ ok }));
      return true;
    }
    return false;
  });

  // ---------- header buttons ----------

  $("newtab").addEventListener("click", () => chrome.tabs.create({ url: AI_MODE_URL }));
  $("settings").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
