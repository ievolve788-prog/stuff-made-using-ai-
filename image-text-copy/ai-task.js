// ai-task.js — runs on https://www.google.com/* (top frame only).
//
// It only does something inside the ONE tab that background.js just opened for
// you: on every other Google page it asks "is there a task for this tab?", gets
// "no" and stops.
//
// The task: you clicked the button on an image, so in AI Mode we
//   1. attach that image to the input box (paste -> "+" menu / file input -> drop;
//      the first one that visibly works wins),
//   2. type your prompt (default: "transcribe the text exactly, in one code block"),
//   3. press Send (unless you turned auto-send off),
//   4. watch for the answer's code block, wait until it stops changing, and
//      copy its text to the clipboard,
//   5. optionally take you back to the page you came from.
//
// Safety rules:
//   - It never sends a question without the image: if the image can't be
//     attached it stops, puts the image on your clipboard and lets you paste it.
//   - If it can't confirm that Send worked, it tells you to press Enter and keeps
//     watching, so the text is still copied once the answer shows up.
//   - If the page reloads after sending, the new copy of this script only
//     watches; it never attaches or sends a second time.
//
// This automates Google's own page, which is not an official API. When
// something can't be found it writes a snapshot of the buttons/inputs it saw
// to the debug log (popup -> Show debug log -> Copy debug log).

(function () {
  // In side-panel mode the AI Mode page is an iframe of OUR side-panel page. Any
  // other Google iframe (maps, captcha, ...) is none of our business.
  const IN_FRAME = window !== window.top;
  if (IN_FRAME) {
    const anc = location.ancestorOrigins;
    const ours = "chrome-extension://" + chrome.runtime.id;
    if (!(anc && anc.length === 1 && anc[0] === ours)) return;
  }
  if (window.__itcTask) return;
  window.__itcTask = true;
  const IN_PANEL = IN_FRAME;

  const log = (msg, data) => {
    if (typeof itcLog === "function") itcLog("ai-task", msg, data);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CLICKABLE = 'a, button, [role="tab"], [role="button"], [role="link"], [role="menuitem"]';
  const BANNER_ID = "__itc_banner";
  let running = false;

  // Poll fn() until it returns something truthy, or `timeout` ms of polling pass.
  // Counts loops instead of reading the clock so it behaves the same under test.
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

  // ---------- small DOM helpers ----------

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  function labelOf(el) {
    return (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
  }

  // Page text WITHOUT our own banner, so the banner never counts as "new text".
  function pageText() {
    if (!document.body) return "";
    const b = document.getElementById(BANNER_ID);
    let prev = "";
    if (b) {
      prev = b.style.display;
      b.style.display = "none";
    }
    const t = document.body.innerText || document.body.textContent || "";
    if (b) b.style.display = prev;
    return t;
  }

  function isAiModePage() {
    return /^\/(ai|aimode)\/?$/.test(location.pathname) || location.search.includes("udm=50");
  }

  // The prompt box. Most specific selectors first.
  function findAiInput() {
    const prefs = [
      'textarea[name="q"]',
      'input[name="q"]',
      'textarea[role="combobox"]',
      'input[role="combobox"]',
      '[role="combobox"][contenteditable="true"]',
      "textarea",
      'input[type="search"]',
      'input[type="text"]',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ];
    for (const sel of prefs) {
      const hit = Array.from(document.querySelectorAll(sel)).find(isVisible);
      if (hit) return hit;
    }
    return null;
  }

  function inputText(el) {
    return (el.value !== undefined ? el.value : el.textContent) || "";
  }

  function typeInto(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // Native setter, so frameworks that track the value notice the change.
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
  }

  function snapshotClickables() {
    return Array.from(document.querySelectorAll(CLICKABLE))
      .filter(isVisible)
      .map((el) => ({ tag: el.tagName, text: labelOf(el).slice(0, 40), role: el.getAttribute("role") }))
      .filter((x) => x.text)
      .slice(0, 40);
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

  // ---------- the status banner (bottom-right) ----------

  function makeBanner() {
    let el = null;
    let msg = null;
    let action = null;
    function ensure() {
      if (el && el.isConnected) return;
      el = document.createElement("div");
      el.id = BANNER_ID;
      Object.assign(el.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483647",
        maxWidth: "min(360px, calc(100vw - 32px))",
        padding: "10px 14px",
        borderRadius: "8px",
        font: "13px/1.4 system-ui, sans-serif",
        color: "#fff",
        boxShadow: "0 4px 16px rgba(0,0,0,.3)",
        pointerEvents: "none"
      });
      msg = document.createElement("span");
      action = document.createElement("button");
      Object.assign(action.style, {
        display: "none",
        marginLeft: "10px",
        padding: "3px 10px",
        border: "1px solid #fff",
        borderRadius: "4px",
        background: "transparent",
        color: "#fff",
        font: "inherit",
        cursor: "pointer",
        pointerEvents: "auto"
      });
      el.appendChild(msg);
      el.appendChild(action);
      (document.body || document.documentElement).appendChild(el);
    }
    return {
      set(text, kind, act) {
        ensure();
        msg.textContent = "Image Text Copier: " + text;
        el.style.background = kind === "error" ? "#d93025" : kind === "ok" ? "#188038" : "#1a73e8";
        if (act) {
          action.textContent = act.label;
          action.onclick = act.onClick;
          action.style.display = "inline-block";
        } else {
          action.style.display = "none";
        }
      },
      hide(ms) {
        setTimeout(() => {
          if (el) el.remove();
        }, ms || 0);
      }
    };
  }

  // ---------- attaching the image ----------

  function makeFile(task) {
    const bin = atob(task.image);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], task.name || "image.png", { type: task.mime || "image/png" });
  }

  function newTransfer(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }

  function composerRoot(input) {
    let el = input.closest("form");
    if (el) return el;
    el = input;
    for (let i = 0; i < 4 && el.parentElement && el.parentElement !== document.body; i++) el = el.parentElement;
    return el;
  }

  // Before/after evidence that an image landed in the composer.
  function attachmentSignals(fileName) {
    const input = findAiInput();
    const root = input ? composerRoot(input) : document.body;
    const removeBtns = Array.from(document.querySelectorAll("[aria-label]")).filter((el) => {
      const a = el.getAttribute("aria-label") || "";
      return /remove|delete|dismiss|clear/i.test(a) && /image|photo|picture|file|upload|attach/i.test(a);
    }).length;
    const nameRe = fileName ? new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    return {
      media: root.querySelectorAll('img, canvas, video, [role="img"]').length,
      blobImgs: document.querySelectorAll('img[src^="blob:"], img[src^="data:image"]').length,
      removeBtns,
      named: nameRe ? nameRe.test(pageText()) : false
    };
  }

  function imageAttached(baseline, fileName) {
    const cur = attachmentSignals(fileName);
    return (
      cur.blobImgs > baseline.blobImgs ||
      cur.removeBtns > baseline.removeBtns ||
      (cur.named && !baseline.named) ||
      cur.media > baseline.media
    );
  }

  // 1) Paste, like Ctrl+V with the image on the clipboard.
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

  // Real menu roles first, then anything clickable - but never the "+" button
  // that opened the menu (its tooltip would match too and we'd just re-click it).
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

  // 2) The "+" menu -> "Add images", then give the file to Google's own <input type=file>.
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
      pressEscape();
      throw new Error("no file input found (" + steps.join("; ") + ")");
    }
    fi.files = newTransfer(file).files;
    fi.dispatchEvent(new Event("input", { bubbles: true }));
    fi.dispatchEvent(new Event("change", { bubbles: true }));
    return { steps, accept: fi.getAttribute("accept") };
  }

  // 3) Drop, like dragging the image onto the box.
  function tryDrop(input, file) {
    const dt = newTransfer(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      input.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return {};
  }

  async function copyImageToClipboard(file) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);
      return true;
    } catch (e) {
      log("could not put the image on the clipboard", { message: e.message });
      return false;
    }
  }

  // ---------- sending ----------

  const SEND_RE = /^(send|submit|ask)\b|\b(send|submit)\b/i;
  const NOT_SEND_RE = /feedback|report|share|upload|attach|voice|mic|camera|lens|add\b/i;

  // The Send button: the nearest ancestor of the box that contains a send-like button.
  function findSendButton(box) {
    let scope = box;
    for (let i = 0; i < 8 && scope.parentElement; i++) {
      scope = scope.parentElement;
      const hit = Array.from(scope.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .find((b) => SEND_RE.test(labelOf(b)) && !NOT_SEND_RE.test(labelOf(b)));
      if (hit) return hit;
    }
    return null;
  }

  function composerButtonLabels(box) {
    let scope = box;
    for (let i = 0; i < 5 && scope.parentElement; i++) scope = scope.parentElement;
    return Array.from(scope.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .map((b) => labelOf(b).slice(0, 30) || "(no label)")
      .slice(0, 15);
  }

  const isEnabled = (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true";

  // Try the Send button, then Enter; after each, confirm the box emptied.
  async function sendPrompt(box, prompt) {
    const needle = prompt.trim().slice(0, 40).toLowerCase();
    const boxHasPrompt = () => {
      const b = findAiInput();
      return !!b && inputText(b).toLowerCase().includes(needle);
    };
    log("send: buttons near the box", composerButtonLabels(box));

    const btn = findSendButton(box);
    if (btn && isEnabled(btn)) {
      btn.click();
      log("send: clicked button", { label: labelOf(btn) });
    } else {
      pressEnter(box);
      log("send: no usable Send button, pressed Enter", { foundButNotEnabled: !!btn });
    }
    await sleep(1800);
    if (!boxHasPrompt()) return "sent";

    const again = findAiInput() || box;
    const btn2 = findSendButton(again);
    if (btn && isEnabled(btn)) {
      pressEnter(again);
      log("send: second try, pressed Enter");
    } else if (btn2 && isEnabled(btn2)) {
      btn2.click();
      log("send: second try, clicked button", { label: labelOf(btn2) });
    } else {
      const form = again.closest("form");
      if (form) {
        try {
          form.requestSubmit();
          log("send: second try, form.requestSubmit()");
        } catch (e) {}
      } else {
        pressEnter(again);
      }
    }
    await sleep(1800);
    return boxHasPrompt() ? "unconfirmed" : "sent";
  }

  // ---------- reading the answer ----------

  function cleanText(t) {
    return String(t || "")
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ")
      .replace(/[ \t]+$/gm, "")
      .replace(/^\n+|\n+$/g, "");
  }

  // Text of every code block on the page (<pre>; or multi-line <code> if there are no <pre>).
  function blockTexts() {
    const banner = document.getElementById(BANNER_ID);
    const outside = (el) => !banner || !banner.contains(el);
    let els = Array.from(document.querySelectorAll("pre")).filter(outside);
    if (!els.length) {
      els = Array.from(document.querySelectorAll("code")).filter(
        (el) => outside(el) && !el.closest("pre") && /\n/.test(el.textContent || "")
      );
    }
    return els.map((el) => cleanText(el.innerText || el.textContent)).filter(Boolean);
  }

  const pageLines = () =>
    pageText()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  function takeBaseline() {
    return { pres: new Set(blockTexts()), lines: new Set(pageLines()) };
  }

  const readBlocks = (baseline) => blockTexts().filter((t) => !baseline.pres.has(t));

  // Last resort when the answer has no code block: the new lines on the page,
  // minus the prompt echo and code fences.
  function newPageText(baseline, prompt, fileName) {
    const needle = prompt.trim().slice(0, 40).toLowerCase();
    const fresh = pageLines().filter(
      (l) => !baseline.lines.has(l) && !l.toLowerCase().includes(needle) && !/^```/.test(l) && l !== fileName
    );
    return cleanText(fresh.join("\n"));
  }

  const isGenerating = () =>
    Array.from(document.querySelectorAll('button, [role="button"]')).some(
      (b) => isVisible(b) && /^stop\b/i.test(labelOf(b))
    );

  // Wait for a NEW code block, then until its text stops changing (the answer
  // streams in) and no "Stop" button is showing.
  async function watchForAnswer(baseline, ctx) {
    let last = null;
    let stable = 0;
    for (let i = 0; i < ctx.maxLoops; i++) {
      await sleep(800);
      const blocks = readBlocks(baseline);
      if (!blocks.length) continue;
      const text = blocks.join("\n\n");
      if (text === last) stable++;
      else {
        last = text;
        stable = 0;
      }
      // ~3 seconds without a change (and no "Stop" button): the answer has finished streaming.
      if (stable >= 4 && !isGenerating()) return { text, how: "code block" };
    }
    if (last) return { text: last, how: "code block (never settled)" };
    if (ctx.allowPageText) {
      const t = newPageText(baseline, ctx.prompt, ctx.fileName);
      if (t.length >= 8) return { text: t, how: "page text" };
    }
    return null;
  }

  // ---------- clipboard ----------

  async function copyText(text) {
    if (IN_PANEL) {
      // The side-panel page (an extension page with clipboardWrite) can copy even when this
      // iframe doesn't have keyboard focus, which the browser demands of web pages.
      const r = await send({ action: "copyText", text });
      if (r && r.ok) return "side panel page";
    }
    try {
      await navigator.clipboard.writeText(text);
      return "clipboard API";
    } catch (e) {
      log("clipboard API refused", { message: e && e.message });
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) return "execCommand";
    } catch (e) {
      log("execCommand copy failed", { message: e && e.message });
    }
    return null;
  }

  // ---------- talking to background.js ----------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ ...msg, panel: IN_PANEL }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res === undefined ? null : res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---------- the task ----------

  async function finishWithResult(result, task, banner) {
    if (!result) {
      log("no answer found");
      banner.set(
        "I didn't see an answer appear. If Google is still writing one, wait for it, then select the code block and press Ctrl+C.",
        "error"
      );
      return;
    }
    const text = cleanText(result.text);
    if (/^NO TEXT FOUND\.?$/i.test(text)) {
      log("model reported no text");
      banner.set("Google found no text in that image — your clipboard was left alone.", "error");
      if (IN_PANEL) await send({ action: "notifySource", message: "No text found in that image", kind: "error" });
      return;
    }
    const how = await copyText(text);
    log("copy result", { chars: text.length, copiedVia: how, readFrom: result.how });
    if (how) {
      const note = result.how === "code block" ? "" : " (read from the " + result.how + " — may include extra lines)";
      banner.set("copied " + text.length + " characters ✓" + note, "ok", {
        label: "Copy again",
        onClick: () => copyText(text)
      });
      if (IN_PANEL) {
        // The page you were on is still in front: show "copied ✓" there.
        await send({ action: "notifySource", message: "Copied " + text.length + " characters ✓" });
      } else if (task.afterCopy === "return") {
        await sleep(900);
        await send({ action: "returnToSource", message: "Copied " + text.length + " characters ✓" });
      }
    } else {
      banner.set("the browser blocked the automatic copy — click Copy.", "error", {
        label: "Copy",
        onClick: async () => {
          const ok = await copyText(text);
          banner.set(ok ? "copied ✓" : "copy failed — select the code block and press Ctrl+C", ok ? "ok" : "error");
        }
      });
    }
  }

  // Side panel only: the panel can't do it, so ask background.js to redo the same task in a new tab.
  async function fallbackToTab(task, why, banner) {
    if (!IN_PANEL) return false;
    banner.set("the side panel can't do this here — moving to a new tab…");
    const r = await send({ action: "panelFallback", id: task.id, reason: why });
    log("side panel fallback", { why, result: r });
    return !!(r && r.ok);
  }

  async function runTask(task) {
    if (running || !task) return;
    running = true;
    const banner = makeBanner();
    const prompt = (task.prompt || "").trim();
    const needle = prompt.slice(0, 40).toLowerCase();
    const fileName = task.name || "image.png";

    try {
      log("task started", { href: location.href, stage: task.stage, autoSend: !!task.autoSend, hasImage: !!task.image });

      // After a page reload the image was already sent: only watch, never attach/send again.
      if (task.stage === "sent") {
        banner.set("waiting for Google's answer…");
        const result = await watchForAnswer({ pres: new Set(), lines: new Set() }, { maxLoops: 75, allowPageText: false, prompt, fileName });
        await finishWithResult(result, task, banner);
        return;
      }

      // 1) the input box
      banner.set("opening AI Mode…");
      const input = await waitFor(() => isAiModePage() && findAiInput(), 25000);
      if (!input) {
        log("AI Mode input not found", { href: location.href, inputs: snapshotInputs(), clickables: snapshotClickables() });
        if (await fallbackToTab(task, "input not found", banner)) return;
        banner.set("couldn't find the AI Mode input box (is Google asking you to sign in?). See the debug log.", "error");
        banner.hide(15000);
        return;
      }
      await sleep(600); // let the page finish its own startup

      // 2) attach the image - first strategy that visibly works wins
      const file = makeFile(task);
      const before = attachmentSignals(fileName);
      let attachedBy = null;
      const strategies = [
        ["paste", () => tryPaste(findAiInput() || input, file)],
        ["+ menu / file input", () => tryFileInput(findAiInput() || input, file)],
        ["drop", () => tryDrop(findAiInput() || input, file)]
      ];
      for (const [name, run] of strategies) {
        banner.set("attaching the image (" + name + ")…");
        let detail = {};
        try {
          detail = (await run()) || {};
        } catch (e) {
          detail = { error: e.message };
        }
        const ok = !!(await waitFor(() => imageAttached(before, fileName), 3500));
        log("attach via " + name, { ok, ...detail, signals: attachmentSignals(fileName), before });
        if (ok) {
          attachedBy = name;
          break;
        }
      }

      let box = findAiInput() || input;
      let baseline;
      let sent = false;
      let manual = false; // the user has to finish by hand
      let reason = "";

      if (!attachedBy) {
        log("could NOT attach the image", {
          href: location.href,
          clickables: snapshotClickables(),
          inputs: snapshotInputs(),
          fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((i) => i.getAttribute("accept"))
        });
        // Side panel: a normal tab may manage what the narrow framed page could not.
        if (await fallbackToTab(task, "attach failed", banner)) return;
        // Never send a question without the image. Hand over to the user.
        const copied = await copyImageToClipboard(file);
        if (prompt) typeInto(box, prompt);
        manual = true;
        reason = "attach failed";
        banner.set(
          "couldn't attach the image automatically. Your prompt is typed" +
            (copied ? "; the image is on your clipboard — click the box, press Ctrl+V, then Enter." : "; add the image yourself, then press Enter.") +
            " I'll copy the answer when it appears.",
          "error"
        );
        baseline = takeBaseline();
      } else {
        // 3) type the prompt (after the image, so a re-render can't wipe it)
        await sleep(600);
        box = findAiInput() || box;
        if (prompt) {
          banner.set("typing the prompt…");
          typeInto(box, prompt);
          await sleep(400);
          box = findAiInput() || box;
          if (!inputText(box).toLowerCase().includes(needle)) {
            typeInto(box, prompt); // one retry: the box may have re-rendered after the attach
            await sleep(400);
            box = findAiInput() || box;
          }
        }
        const promptIn = !prompt || inputText(box).toLowerCase().includes(needle);
        const imageStill = imageAttached(before, fileName);
        log("ready to send", { attachedBy, promptIn, imageStill, autoSend: !!task.autoSend });

        baseline = takeBaseline();
        if (task.autoSend && prompt && promptIn && imageStill) {
          // 4) send
          banner.set("sending…");
          const result = await sendPrompt(box, prompt);
          log("send result", { result });
          sent = result === "sent";
          if (!sent) {
            manual = true;
            reason = "send unconfirmed";
            banner.set("couldn't confirm it was sent — press Enter in the AI Mode box. I'll copy the answer when it appears.", "error");
          } else {
            banner.set("waiting for Google's answer…");
          }
        } else {
          manual = true;
          reason = !task.autoSend ? "auto-send is off" : !prompt ? "no prompt" : !imageStill ? "image disappeared" : "prompt didn't land";
          banner.set("ready (" + reason + ") — check it and press Enter. I'll copy the answer when it appears.", "ok");
        }
      }

      // The image has done its job: drop it from memory and remember we're past the send step,
      // so a reload can never trigger a second attach/send.
      await send({ action: "imageTaskUpdate", id: task.id, patch: { stage: "sent", image: null } });

      // 5) watch for the answer and copy it
      const result = await watchForAnswer(baseline, {
        maxLoops: manual ? 225 : 75,
        allowPageText: sent,
        prompt,
        fileName
      });
      await finishWithResult(result, task, banner);
    } catch (e) {
      log("task error", { message: e.message, stack: e.stack });
      banner.set("something went wrong — see the debug log.", "error");
      banner.hide(15000);
    } finally {
      running = false;
      send({ action: "imageTaskDone", id: task.id }); // clears the task (and any image still held)
    }
  }

  // ---------- start ----------

  // Ask background.js whether there is a task for THIS tab. Asked a few times
  // in case the page loaded a moment before the task was saved.
  (async function start() {
    for (const delay of [0, 800, 2500]) {
      if (delay) await sleep(delay);
      const task = await send({ action: "getImageTask" });
      if (task && task.id) {
        runTask(task);
        return;
      }
    }
  })();
})();
