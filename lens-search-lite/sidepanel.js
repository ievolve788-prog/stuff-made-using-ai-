// sidepanel.js — the side panel page.
//
// It shows Google AI Mode in an iframe when background.js leaves a task for it
// (a screenshot + prompt, or just "open AI Mode"), and watches that the page
// inside (ai-mode.js) checks in. If nothing checks in within FALLBACK_MS
// (Google refused to be framed, you're on a sign-in page...) it asks
// background.js to redo the task in a normal new tab.

(function () {
  const AI_MODE_URL = "https://www.google.com/ai";
  const TASK_KEY = "aiDirectTask";
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

  // Only ever show Google's own AI Mode.
  function safeUrl(url) {
    return typeof url === "string" && /^https:\/\/www\.google\.com\/(ai|aimode|search\?)/.test(url) ? url : AI_MODE_URL;
  }

  function loadFrame(id, url) {
    if (frame) frame.remove();
    $("idle").hidden = true;
    frame = document.createElement("iframe");
    frame.id = "frame";
    frame.allow = "clipboard-write; clipboard-read";
    frame.src = safeUrl(url);
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

  // A task appeared or changed. Tasks meant for a tab are none of our business.
  function apply(task) {
    if (!task || !task.panel) return;
    if (task.id !== currentId) {
      if (task.claimed || Date.now() - task.ts > FRESH_MS) return; // stale: never resurrect an old task
      currentId = task.id;
      loadFrame(task.id, task.mode === "open" ? task.url : AI_MODE_URL);
      return;
    }
    if (task.claimed) {
      clearTimeout(timer);
      timer = null;
      setStatus(task.mode === "open" ? "" : "Working…");
    }
  }

  store.get(TASK_KEY).then((r) => apply(r[TASK_KEY]), () => {});
  chrome.storage.onChanged.addListener((changes) => {
    // A removed task (finished) leaves the page as it is: you want to read the answer.
    if (changes[TASK_KEY]) apply(changes[TASK_KEY].newValue);
  });

  // ---------- header buttons ----------

  $("newtab").addEventListener("click", () => chrome.tabs.create({ url: AI_MODE_URL }));
  $("settings").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
