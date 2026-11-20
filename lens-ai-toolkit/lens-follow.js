// lens-follow.js — only used when the screenshot destination is Google LENS and "Auto-click AI
// Mode" is switched on. After lens-inject.js has handed your picture to Lens, background.js leaves
// a short-lived task for this tab and this script:
//   stage "type"   -> types your default prompt into the Lens results page's search box
//   stage "click"  -> clicks Google's own "AI Mode" tab
//   stage "prompt" -> on the AI Mode page, sends the prompt if it didn't carry over by itself
// It does nothing in any tab that has no task. If Google renames things it can break; it then logs
// a snapshot of what it saw (popup -> "Copy debug log").

(function () {
  if (window.__tkLensFollow) return;
  window.__tkLensFollow = true;

  const CLICKABLE = 'a, button, [role="tab"], [role="button"], [role="link"], [role="menuitem"]';
  const TASK_LIFETIME_MS = 60000;
  const log = (msg, data) => {
    if (typeof tkLog === "function") tkLog("lens-follow", msg, data);
  };
  const sendMsg = (msg) => chrome.runtime.sendMessage(msg);

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  const labelOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
  const pageText = () => (document.body ? document.body.innerText || document.body.textContent || "" : "");

  // The Lens upload modal sits on top of the Google homepage, which ALSO has an "AI Mode" button
  // behind it, so nothing may be clicked until the upload has gone through and the page moved on.
  function stillOnUploadPage() {
    if (location.pathname === "/") return true;
    return /drag an image here/i.test(pageText());
  }

  function findAiModeButton() {
    const els = Array.from(document.querySelectorAll(CLICKABLE)).filter(isVisible);
    return els.find((el) => /^ai mode$/i.test(labelOf(el))) || els.find((el) => labelOf(el).length <= 24 && /\bai mode\b/i.test(labelOf(el))) || null;
  }

  function snapshotClickables() {
    return Array.from(document.querySelectorAll(CLICKABLE))
      .filter(isVisible)
      .map((el) => ({ tag: el.tagName, text: labelOf(el).slice(0, 40), role: el.getAttribute("role") }))
      .filter((x) => x.text)
      .slice(0, 50);
  }

  function findPromptInput() {
    const els = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"], input[type="search"]')).filter(isVisible);
    return els.find((e) => e.tagName === "TEXTAREA") || els.find((e) => e.isContentEditable) || els[0] || null;
  }

  // The search box on the Lens results page (next to your image thumbnail), most specific first.
  function findSearchBox() {
    const prefs = ['textarea[name="q"]', 'input[name="q"]', 'textarea[role="combobox"]', 'input[role="combobox"]', '[role="combobox"][contenteditable="true"]', "textarea", 'input[type="search"]', 'input[type="text"]', '[contenteditable="true"]'];
    for (const sel of prefs) {
      const hit = Array.from(document.querySelectorAll(sel)).find(isVisible);
      if (hit) return hit;
    }
    return null;
  }

  function snapshotInputs() {
    return Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"], [role="combobox"], [role="textbox"]'))
      .filter(isVisible)
      .map((el) => ({ tag: el.tagName, type: el.getAttribute("type"), name: el.getAttribute("name"), role: el.getAttribute("role"), placeholder: el.getAttribute("placeholder"), aria: el.getAttribute("aria-label") }))
      .slice(0, 20);
  }

  const inputText = (el) => (el.value !== undefined ? el.value : el.textContent) || "";

  // Did our prompt already arrive on its own (carried over from the Lens search box)? Then don't type it twice.
  function promptAlreadySent(needle) {
    try {
      if (decodeURIComponent(location.search.replace(/\+/g, " ")).toLowerCase().includes(needle)) return "in the page URL";
    } catch (e) {}
    return pageText().toLowerCase().includes(needle) ? "visible on the page" : null;
  }

  function typeInto(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }
  }

  function submitPrompt(input, text) {
    const scope = input.closest("form") || (input.parentElement && input.parentElement.parentElement && input.parentElement.parentElement.parentElement) || document;
    const send = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisible).find((b) => /^(send|submit|search|ask)\b/i.test(labelOf(b)));
    if (send) {
      send.click();
      return "clicked button: " + labelOf(send);
    }
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    // A synthetic Enter doesn't always submit a <form>. If the text is still there, submit the form.
    setTimeout(() => {
      const form = input.closest("form");
      if (inputText(input).trim() === text.trim() && form) {
        try {
          form.requestSubmit();
          log("fallback: form.requestSubmit()");
        } catch (e) {}
      }
    }, 500);
    return "Enter key";
  }

  let running = false;

  function runTask(task) {
    if (running || !task) return;
    running = true;
    let stage = task.stage;
    let tries = 0;
    let busy = false;
    let stageStart = Date.now();
    log("task started", { stage, hasPrompt: !!task.prompt, href: location.href });

    function finish(reason) {
      clearInterval(timer);
      running = false;
      log("task finished", { reason });
      sendMsg({ action: "lensTaskDone" }).catch(() => {});
    }

    function step() {
      tries++;
      if (Date.now() - task.ts > TASK_LIFETIME_MS) return finish("timed out");
      if (stillOnUploadPage()) {
        if (tries % 20 === 0) log("waiting: upload hasn't gone through yet", { href: location.href });
        return;
      }

      // Stage 1 (only with a default prompt): put it into the Lens results page's own search box,
      // next to your image, BEFORE switching to AI Mode.
      if (stage === "type") {
        const box = findSearchBox();
        if (!box) {
          if (tries === 30) log("search box NOT found — inputs seen", snapshotInputs());
          return;
        }
        typeInto(box, task.prompt);
        log("prompt typed into the Lens search box", { tag: box.tagName, name: box.getAttribute("name") });
        stage = "click";
        sendMsg({ action: "lensTaskUpdate", stage }).catch(() => {});
        return;
      }

      if (stage === "click") {
        const btn = findAiModeButton();
        if (!btn) {
          if (tries === 30) log("AI Mode button NOT found — clickable elements seen", snapshotClickables());
          return;
        }
        const target = btn.closest(CLICKABLE) || btn;
        stage = task.prompt ? "prompt" : "done";
        stageStart = Date.now();
        // Save the new stage BEFORE clicking: the click may reload the page and the fresh page must know where to pick up.
        sendMsg({ action: "lensTaskUpdate", stage }).catch(() => {});
        log("clicking AI Mode", { tag: target.tagName, label: labelOf(target), href: target.getAttribute("href") });
        target.click();
        if (stage === "done") finish("clicked AI Mode (no prompt set)");
        return;
      }

      if (stage === "prompt") {
        if (!location.search.includes("udm=50")) {
          if (tries % 15 === 0) log("waiting for the AI Mode page (udm=50)", { href: location.href });
          return;
        }
        if (Date.now() - stageStart < 3000) return; // give a carried-over prompt a moment to show up

        const needle = task.prompt.trim().slice(0, 40).toLowerCase();
        const input = findPromptInput();
        const draftInBox = !!input && inputText(input).toLowerCase().includes(needle);
        if (!draftInBox) {
          const where = promptAlreadySent(needle);
          if (where) return finish("prompt already carried over into AI Mode (" + where + ")");
        }
        if (!input) {
          if (tries % 15 === 0) log("on AI Mode page but no input box found yet");
          return;
        }
        if (!draftInBox) typeInto(input, task.prompt);
        log("prompt ready in AI Mode box", { typedByUs: !draftInBox });
        setTimeout(() => log("prompt submitted", { how: submitPrompt(input, task.prompt) }), 300);
        finish("prompt sent");
      }
    }

    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      try {
        step();
      } catch (e) {
        log("task step error", { message: e.message });
      }
      busy = false;
    }, 600);
  }

  // Path A: background tells us right after it hands over the screenshot.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "startLensTask") runTask(msg.task);
  });

  // Path B: a fresh page load (or a redirect reload): is a task waiting for this tab?
  sendMsg({ action: "lensTaskGet" }).then(
    (task) => {
      if (task) runTask(task);
    },
    () => {}
  );
})();
