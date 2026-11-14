// ai-mode.js
// Optional helper. It only does anything inside the ONE tab the extension just
// opened itself (background.js hands that tab a short-lived "task" by tab ID).
// On every other Google page it asks background.js "is there a task for me?",
// gets "no", and stops.
//
// Two kinds of task:
//   DIRECT (mode "direct", the default destination): the tab is AI Mode. Attach
//     your screenshot, type your default prompt, press Send. See the big
//     "DIRECT MODE" block near the bottom.
//   LENS follow-up (only if "Auto-click AI Mode" is ON and the destination is
//     Google Lens):
//       stage "type"   -> type the prompt into the Lens results page's search box
//       stage "click"  -> click Google's own "AI Mode" tab
//       stage "prompt" -> on the AI Mode page, send the prompt if it didn't carry over
//
// This is automating clicks on Google's page, so it can break if Google
// renames things. If it can't find the button it logs a snapshot of every
// clickable element it saw — use "Copy debug log" in the popup and share it.

(function () {
  // Side-panel mode: the AI Mode page is an iframe of OUR side-panel page. Any
  // other Google iframe (maps, captcha, ...) is none of our business.
  const IN_FRAME = window !== window.top;
  if (IN_FRAME) {
    const anc = location.ancestorOrigins;
    const ours = "chrome-extension://" + chrome.runtime.id;
    if (!(anc && anc.length === 1 && anc[0] === ours)) return;
  }
  if (window.__lensAiModeLoaded) return;
  window.__lensAiModeLoaded = true;
  const IN_PANEL = IN_FRAME;
  // Every message says whether it comes from the side panel (it is not a tab,
  // so background.js can't tell which task is ours from the tab id).
  const sendMsg = (msg, ...rest) => chrome.runtime.sendMessage({ ...msg, panel: IN_PANEL }, ...rest);

  const CLICKABLE = 'a, button, [role="tab"], [role="button"], [role="link"], [role="menuitem"]';
  const TASK_LIFETIME_MS = 60000;

  // ---------- debug logging (same shape as the other scripts) ----------

  async function logEvent(msg, data) {
    try {
      let d;
      try {
        d = data === undefined ? undefined : JSON.stringify(data);
      } catch {
        d = String(data);
      }
      const entry = { ts: Date.now(), tag: "ai-mode", msg, data: d };
      const { debugLog = [] } = await chrome.storage.local.get("debugLog");
      debugLog.push(entry);
      while (debugLog.length > 150) debugLog.shift();
      await chrome.storage.local.set({ debugLog });
    } catch (e) {}
  }

  // ---------- small DOM helpers ----------

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  function labelOf(el) {
    return (el.getAttribute("aria-label") || el.innerText || el.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  // The Lens upload modal sits on top of the Google homepage, and the homepage
  // ALSO has an "AI Mode" button behind it. So we must not click anything
  // until the upload has gone through and the page has moved on.
  function pageText() {
    if (!document.body) return "";
    return document.body.innerText || document.body.textContent || "";
  }

  function stillOnUploadPage() {
    if (location.pathname === "/") return true;
    return /drag an image here/i.test(pageText());
  }

  function findAiModeButton() {
    const els = Array.from(document.querySelectorAll(CLICKABLE)).filter(isVisible);
    // 1) exact label "AI Mode"
    let hit = els.find((el) => /^ai mode$/i.test(labelOf(el)));
    // 2) short label that contains it
    if (!hit) hit = els.find((el) => labelOf(el).length <= 24 && /\bai mode\b/i.test(labelOf(el)));
    return hit || null;
  }

  function snapshotClickables() {
    return Array.from(document.querySelectorAll(CLICKABLE))
      .filter(isVisible)
      .map((el) => ({ tag: el.tagName, text: labelOf(el).slice(0, 40), role: el.getAttribute("role") }))
      .filter((x) => x.text)
      .slice(0, 50);
  }

  function findPromptInput() {
    const sel = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"], input[type="search"]';
    const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
    return (
      els.find((e) => e.tagName === "TEXTAREA") ||
      els.find((e) => e.isContentEditable) ||
      els[0] ||
      null
    );
  }

  // The search box on the Lens results page (the one showing your image
  // thumbnail). Try the most specific selectors first.
  function findSearchBox() {
    const prefs = [
      'textarea[name="q"]',
      'input[name="q"]',
      'textarea[role="combobox"]',
      'input[role="combobox"]',
      '[role="combobox"][contenteditable="true"]',
      "textarea",
      'input[type="search"]',
      'input[type="text"]',
      '[contenteditable="true"]'
    ];
    for (const sel of prefs) {
      const hit = Array.from(document.querySelectorAll(sel)).find(isVisible);
      if (hit) return hit;
    }
    return null;
  }

  function snapshotInputs() {
    return Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"], [role="combobox"], [role="textbox"]'))
      .filter(isVisible)
      .map((el) => ({
        tag: el.tagName,
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        role: el.getAttribute("role"),
        placeholder: el.getAttribute("placeholder"),
        aria: el.getAttribute("aria-label")
      }))
      .slice(0, 20);
  }

  function inputText(el) {
    return (el.value !== undefined ? el.value : el.textContent) || "";
  }

  // On the AI Mode page: did our prompt already arrive on its own (carried
  // over from the Lens search box)? Then we must NOT type it a second time.
  function promptAlreadySent(needle) {
    try {
      const q = decodeURIComponent(location.search.replace(/\+/g, " ")).toLowerCase();
      if (q.includes(needle)) return "in the page URL";
    } catch (e) {}
    const body = pageText().toLowerCase();
    if (body.includes(needle)) return "visible on the page";
    return null;
  }

  function typeInto(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // Use the native setter so frameworks that track the value notice the change.
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
    const scope =
      input.closest("form") ||
      (input.parentElement && input.parentElement.parentElement && input.parentElement.parentElement.parentElement) ||
      document;
    const buttons = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisible);
    const send = buttons.find((b) => /^(send|submit|search|ask)\b/i.test(labelOf(b)));
    if (send) {
      send.click();
      return "clicked button: " + labelOf(send);
    }

    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
    // Synthetic Enter doesn't always submit a <form>. If the text is still sitting there, submit the form.
    setTimeout(() => {
      const current = (input.value !== undefined ? input.value : input.textContent) || "";
      const form = input.closest("form");
      if (current.trim() === text.trim() && form) {
        try {
          form.requestSubmit();
          logEvent("fallback: form.requestSubmit()");
        } catch (e) {}
      }
    }, 500);
    return "Enter key";
  }

  // ---------- the task runner ----------

  let running = false;

  function runTask(task) {
    if (running || !task) return;
    running = true;

    let stage = task.stage;
    let tries = 0;
    let busy = false;
    let stageStart = Date.now();
    logEvent("task started", { stage, hasPrompt: !!task.prompt, href: location.href });

    function finish(reason) {
      clearInterval(timer);
      running = false;
      logEvent("task finished", { reason });
      sendMsg({ action: "aiTaskDone" }).catch(() => {});
    }

    function step() {
      tries++;
      if (Date.now() - task.ts > TASK_LIFETIME_MS) return finish("timed out");

      if (stillOnUploadPage()) {
        if (tries % 20 === 0) logEvent("waiting: upload hasn't gone through yet", { href: location.href });
        return;
      }

      // Stage 1 (only when a default prompt is set): put the prompt into the
      // Lens results page's own search box, next to your image, BEFORE we
      // switch to AI Mode.
      if (stage === "type") {
        const box = findSearchBox();
        if (!box) {
          if (tries === 30) logEvent("search box NOT found — inputs seen", snapshotInputs());
          return;
        }
        typeInto(box, task.prompt);
        logEvent("prompt typed into the Lens search box", { tag: box.tagName, name: box.getAttribute("name") });
        stage = "click"; // next tick (~0.6s later) clicks AI Mode
        sendMsg({ action: "aiTaskUpdate", stage }).catch(() => {});
        return;
      }

      if (stage === "click") {
        const btn = findAiModeButton();
        if (!btn) {
          if (tries === 30) logEvent("AI Mode button NOT found — clickable elements seen", snapshotClickables());
          return;
        }
        const target = btn.closest(CLICKABLE) || btn;
        stage = task.prompt ? "prompt" : "done";
        stageStart = Date.now();
        // Save the new stage BEFORE clicking: the click may reload the page,
        // and the fresh page must know where to pick up.
        sendMsg({ action: "aiTaskUpdate", stage }).catch(() => {});
        logEvent("clicking AI Mode", { tag: target.tagName, label: labelOf(target), href: target.getAttribute("href") });
        target.click();
        if (stage === "done") finish("clicked AI Mode (no prompt set)");
        return;
      }

      if (stage === "prompt") {
        if (!location.search.includes("udm=50")) {
          if (tries % 15 === 0) logEvent("waiting for the AI Mode page (udm=50)", { href: location.href });
          return;
        }
        // Give a carried-over prompt a moment to show up before deciding it didn't.
        if (Date.now() - stageStart < 3000) return;

        const needle = task.prompt.trim().slice(0, 40).toLowerCase();
        const input = findPromptInput();
        const draftInBox = !!input && inputText(input).toLowerCase().includes(needle);

        if (!draftInBox) {
          const where = promptAlreadySent(needle);
          if (where) return finish("prompt already carried over into AI Mode (" + where + ")");
        }
        if (!input) {
          if (tries % 15 === 0) logEvent("on AI Mode page but no input box found yet");
          return;
        }
        if (draftInBox) logEvent("prompt already sitting in the AI Mode box — just sending it");
        else typeInto(input, task.prompt);
        logEvent("prompt ready in AI Mode box", { tag: input.tagName, typedByUs: !draftInBox });
        setTimeout(() => logEvent("prompt submitted", { how: submitPrompt(input, task.prompt) }), 300);
        finish("prompt sent");
      }
    }

    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      try {
        step();
      } catch (e) {
        logEvent("task step error", { message: e.message });
      }
      busy = false;
    }, 600);
  }

  // ======================================================================
  // DIRECT MODE — screenshot + your default prompt straight into AI Mode.
  //
  // background.js opened google.com/ai in a fresh tab and left a task with the
  // screenshot (base64) for it. Here we:
  //   1. wait for the AI Mode input box,
  //   2. attach the image (paste -> "+" menu/file input -> drop; first one
  //      that visibly works wins, so it is never attached twice on purpose),
  //   3. type the prompt,
  //   4. press Send (if "auto-send" is on, and only if the image is attached).
  // If the image can't be attached, it does NOT send a text-only question:
  // it types the prompt, copies the image to your clipboard and tells you to
  // press Ctrl+V. A small banner (bottom-right) says what it is doing.
  // ======================================================================

  const DIRECT_LIFETIME_MS = 90000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Poll fn() until it returns something truthy or `timeout` ms of polling
  // pass. Counts loops (not the clock) so it behaves the same under test.
  async function waitFor(fn, timeout, interval = 300) {
    const loops = Math.max(1, Math.ceil(timeout / interval));
    for (let i = 0; i < loops; i++) {
      let v = null;
      try {
        v = fn();
      } catch (e) {}
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function isAiModePage() {
    return /^\/(ai|aimode)\/?$/.test(location.pathname) || location.search.includes("udm=50");
  }

  function findAiInput() {
    return findSearchBox() || findPromptInput();
  }

  function makeFile(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], "screenshot.png", { type: "image/png" });
  }

  function makeToast() {
    let el = null;
    function ensure() {
      if (el && el.isConnected) return el;
      el = document.createElement("div");
      el.id = "__lens_toast";
      Object.assign(el.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483647",
        maxWidth: "min(340px, calc(100vw - 32px))",
        padding: "10px 14px",
        borderRadius: "8px",
        font: "13px/1.4 system-ui, sans-serif",
        color: "#fff",
        boxShadow: "0 4px 16px rgba(0,0,0,.3)",
        pointerEvents: "none"
      });
      (document.body || document.documentElement).appendChild(el);
      return el;
    }
    return {
      set(text, kind) {
        const e = ensure();
        e.textContent = "Lens Search Lite: " + text;
        e.style.background = kind === "error" ? "#d93025" : kind === "ok" ? "#188038" : "#1a73e8";
      },
      hide(ms) {
        setTimeout(() => {
          if (el) el.remove();
        }, ms || 0);
      }
    };
  }

  // ---- "is an image attached yet?" — compare before/after signals ----

  function composerRoot(input) {
    let el = input.closest("form");
    if (el) return el;
    el = input;
    for (let i = 0; i < 4 && el.parentElement && el.parentElement !== document.body; i++) el = el.parentElement;
    return el;
  }

  function attachmentSignals() {
    const input = findAiInput();
    const root = input ? composerRoot(input) : document.body;
    const removeBtns = Array.from(document.querySelectorAll("[aria-label]")).filter((el) => {
      const a = el.getAttribute("aria-label") || "";
      return /remove|delete|dismiss|clear/i.test(a) && /image|photo|picture|file|upload|attach|screenshot/i.test(a);
    }).length;
    return {
      media: root.querySelectorAll('img, canvas, video, [role="img"]').length,
      blobImgs: document.querySelectorAll('img[src^="blob:"], img[src^="data:image"]').length,
      removeBtns,
      named: /screenshot\.png/i.test(pageText())
    };
  }

  function imageAttached(baseline) {
    const cur = attachmentSignals();
    return (
      cur.blobImgs > baseline.blobImgs ||
      cur.removeBtns > baseline.removeBtns ||
      (cur.named && !baseline.named) ||
      cur.media > baseline.media
    );
  }

  // ---- the three attach strategies ----

  function newTransfer(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }

  // 1) Paste, as if you pressed Ctrl+V with the image on the clipboard.
  function tryPaste(input, file) {
    input.focus();
    const ev = new ClipboardEvent("paste", { clipboardData: newTransfer(file), bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return { handledByPage: ev.defaultPrevented };
  }

  function findFileInput() {
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    return (
      all.find((i) => {
        const a = (i.getAttribute("accept") || "").toLowerCase();
        return !a || a.includes("image") || a.includes("*/*");
      }) ||
      all[0] ||
      null
    );
  }

  function findPlusButton(input) {
    const re = /upload|add (images?|files?|photos?|attachments?)|attach|^\+$|^add$/i;
    const near = input ? composerRoot(input).parentElement : null;
    for (const scope of [near, document]) {
      if (!scope) continue;
      const hit = Array.from(scope.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .find((b) => labelOf(b).length < 60 && re.test(labelOf(b)));
      if (hit) return hit;
    }
    return null;
  }

  // Look for a menu entry matching `re`. Real menu roles first, then anything
  // clickable — but never the "+" button that opened the menu (its tooltip,
  // "Upload files or images", would match too and we'd just re-click it).
  function findMenuItem(re, exclude) {
    const pick = (selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .filter((el) => !exclude || (el !== exclude && !exclude.contains(el) && !el.contains(exclude)))
        .find((el) => labelOf(el).length < 50 && re.test(labelOf(el))) || null;
    return (
      pick('[role="menuitem"], [role="option"], [role="menuitemradio"]') ||
      pick('li, button, a, [role="button"], div[tabindex]')
    );
  }

  function pressEscape() {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
  }

  // 2) The "+" menu -> "Add images", then hand the file to its <input type=file>.
  //    (We never call input.click(): that would pop the OS file dialog.)
  async function tryFileInput(input, file) {
    const steps = [];
    let fi = findFileInput();
    if (!fi) {
      const plus = findPlusButton(input);
      steps.push(plus ? "clicked + button: " + labelOf(plus) : "no + button found");
      if (plus) {
        plus.click();
        await sleep(700);
        fi = findFileInput();
        if (!fi) {
          const item = findMenuItem(/add images?|upload (an )?images?|upload photos?|add photos?|upload files? or images?/i, plus);
          steps.push(item ? "clicked menu item: " + labelOf(item) : "no 'add images' menu item found");
          if (item) {
            item.click();
            await sleep(700);
            fi = findFileInput();
          }
        }
      }
    }
    if (!fi) {
      pressEscape(); // close any menu we opened
      throw new Error("no file input found (" + steps.join("; ") + ")");
    }
    fi.files = newTransfer(file).files;
    fi.dispatchEvent(new Event("input", { bubbles: true }));
    fi.dispatchEvent(new Event("change", { bubbles: true }));
    return { steps, accept: fi.getAttribute("accept") };
  }

  // 3) Drop, as if you dragged the image onto the box.
  function tryDrop(input, file) {
    const dt = newTransfer(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      input.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return {};
  }

  function snapshotPage() {
    return {
      href: location.href,
      clickables: snapshotClickables().slice(0, 40),
      inputs: snapshotInputs(),
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((i) => ({
        accept: i.getAttribute("accept"),
        multiple: i.multiple
      })),
      signals: attachmentSignals()
    };
  }

  async function copyImageToClipboard(file) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);
      return true;
    } catch (e) {
      logEvent("clipboard write failed", { message: e.message });
      return false;
    }
  }

  // Submit, then confirm the box emptied; if the text is still there, press Enter once more.
  async function sendPrompt(box, prompt) {
    const needle = prompt.trim().slice(0, 40).toLowerCase();
    const stillThere = () => {
      const b = findAiInput();
      return !!b && inputText(b).toLowerCase().includes(needle);
    };
    logEvent("direct: submit attempt 1", { how: submitPrompt(box, prompt) });
    await sleep(2500);
    if (!stillThere()) return "sent";
    const b = findAiInput() || box;
    for (const type of ["keydown", "keypress", "keyup"]) {
      b.dispatchEvent(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
    logEvent("direct: submit attempt 2 (Enter key)");
    await sleep(1500);
    return stillThere() ? "unconfirmed" : "sent";
  }

  // Side panel only: the panel can't do it, so ask background.js to redo the same
  // task in a normal new tab.
  async function fallbackToTab(task, why, toast) {
    if (!IN_PANEL) return false;
    toast.set("the side panel can't do this here — moving to a new tab…");
    const r = await new Promise((resolve) => {
      try {
        sendMsg({ action: "panelFallback", id: task.id, reason: why }, (res) => resolve(chrome.runtime.lastError ? null : res));
      } catch (e) {
        resolve(null);
      }
    });
    logEvent("side panel fallback", { why, result: r });
    return !!(r && r.ok);
  }

  async function runDirectTask(task) {
    if (running || !task) return;
    running = true;
    const toast = makeToast();
    const prompt = (task.prompt || "").trim();
    const needle = prompt.slice(0, 40).toLowerCase();
    logEvent("direct task started", { href: location.href, hasPrompt: !!prompt, autoSend: !!task.autoSend });

    try {
      if (Date.now() - task.ts > DIRECT_LIFETIME_MS) {
        logEvent("direct task expired before it started");
        return;
      }

      // 1) wait for the AI Mode page and its input box
      toast.set("opening AI Mode…");
      let input = await waitFor(() => isAiModePage() && findAiInput(), 25000);
      if (!input) {
        logEvent("direct: AI Mode input not found", snapshotPage());
        if (await fallbackToTab(task, "input not found", toast)) return;
        toast.set("couldn't find the AI Mode input box (see debug log)", "error");
        toast.hide(12000);
        return;
      }
      await sleep(600); // let the page finish its own startup

      // 2) attach the image — first strategy that visibly works wins
      const file = makeFile(task.image);
      const baseline = attachmentSignals();
      let attachedBy = null;
      const strategies = [
        ["paste", () => tryPaste(findAiInput() || input, file)],
        ["+ menu / file input", () => tryFileInput(findAiInput() || input, file)],
        ["drop", () => tryDrop(findAiInput() || input, file)]
      ];
      for (const [name, run] of strategies) {
        toast.set("attaching the screenshot (" + name + ")…");
        let detail = {};
        try {
          detail = (await run()) || {};
        } catch (e) {
          detail = { error: e.message };
        }
        const ok = !!(await waitFor(() => imageAttached(baseline), 3500));
        logEvent("direct: attach via " + name, { ok, ...detail, signals: attachmentSignals(), baseline });
        if (ok) {
          attachedBy = name;
          break;
        }
      }

      // 2b) nothing worked -> don't send a text-only question
      if (!attachedBy) {
        logEvent("direct: could NOT attach the image — page snapshot follows", snapshotPage());
        // Side panel: a normal tab may manage what the narrow framed page could not.
        if (await fallbackToTab(task, "attach failed", toast)) return;
        const copied = await copyImageToClipboard(file);
        const box = findAiInput() || input;
        if (prompt) typeInto(box, prompt);
        toast.set(
          "couldn't attach the screenshot automatically. Your prompt is typed" +
            (copied ? "; the screenshot is on your clipboard — click the box, press Ctrl+V, then Enter." : "; attach the image yourself."),
          "error"
        );
        toast.hide(20000);
        return;
      }

      // 3) type the prompt
      await sleep(600);
      let box = findAiInput() || input;
      if (prompt) {
        toast.set("typing your prompt…");
        typeInto(box, prompt);
        await sleep(400);
        box = findAiInput() || box;
        if (!inputText(box).toLowerCase().includes(needle)) {
          typeInto(box, prompt); // one retry: the box may have re-rendered after the attach
          await sleep(400);
          box = findAiInput() || box;
        }
        logEvent("direct: prompt typed", { present: inputText(box).toLowerCase().includes(needle) });
      }

      // 4) send — only with the image still attached and the prompt in place
      const imageStill = imageAttached(baseline);
      const promptIn = !prompt || inputText(box).toLowerCase().includes(needle);
      if (task.autoSend && imageStill && promptIn) {
        toast.set("sending…");
        const result = await sendPrompt(box, prompt);
        logEvent("direct: send result", { result });
        toast.set(result === "sent" ? "sent — the answer will appear here." : "pressed Send, but couldn't confirm it went through.", result === "sent" ? "ok" : "error");
        toast.hide(5000);
      } else {
        const why = !task.autoSend ? (prompt ? "auto-send is off" : "no default prompt is set") : !imageStill ? "the image disappeared" : "the prompt didn't land in the box";
        logEvent("direct: NOT auto-sending", { why });
        toast.set("ready (" + why + ") — press Enter to send.", "ok");
        toast.hide(10000);
      }
    } catch (e) {
      logEvent("direct task error", { message: e.message, stack: e.stack });
      toast.set("something went wrong — see the debug log.", "error");
      toast.hide(12000);
    } finally {
      running = false;
      sendMsg({ action: "aiTaskDone", id: task.id }).catch(() => {}); // also drops the stored screenshot
    }
  }

  // ---------- entry points ----------

  function startTask(task) {
    if (!task) return;
    if (task.mode === "open") return; // plain "open AI Mode": nothing to automate (asking for the task was the check-in)
    if (task.mode === "direct") runDirectTask(task);
    else runTask(task);
  }

  // Path A: background tells us right after it opens the tab / hands over the screenshot.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "startAiTask") startTask(msg.task);
  });

  // Path B: this is a fresh page load (or a redirect reload). Ask background
  // whether a task is waiting for this tab.
  sendMsg({ action: "getAiTask" }, (task) => {
    if (chrome.runtime.lastError) return;
    if (task) startTask(task);
  });
})();
