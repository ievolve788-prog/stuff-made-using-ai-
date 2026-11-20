// ai-task.js — runs on Google AI Mode (https://www.google.com/*) and, if you switch it on, Gemini.
//
// It only automates something inside the tab / side-panel frame that background.js prepared for
// you: it asks "is there a task for me?", and on every other Google page the answer is "no".
// (The one exception: it quietly notes the prompts you TYPE yourself in AI Mode, for the history.)
//
// A task has a kind:
//   extract  attach the image, send the prompt, wait for the ONE code block in the answer, copy it
//   ask      attach the image, send the prompt, done (you read the answer yourself)
//   open     nothing to automate (the page was opened with a prompt already in its address)
//
// Safety rules:
//   - It never sends a question without the image: if the image can't be attached it stops, puts
//     the image on your clipboard and lets you paste it.
//   - If it can't confirm that Send worked, it tells you to press Enter and keeps watching.
//   - If the page reloads after sending, the new copy of this script only watches; it never
//     attaches or sends a second time.
//
// This automates Google's own pages, which is not an official API. When something can't be found
// it writes a snapshot of the buttons/inputs it saw to the debug log (popup -> Copy debug log).

(function () {
  // In side-panel mode the AI Mode page is an iframe of OUR side-panel page. Any other Google
  // iframe (maps, captcha, ...) is none of our business.
  const IN_FRAME = window !== window.top;
  const OURS = "chrome-extension://" + chrome.runtime.id;
  if (IN_FRAME) {
    const anc = location.ancestorOrigins;
    if (!(anc && anc.length === 1 && anc[0] === OURS)) return;
  }
  if (window.__tkTask) return;
  window.__tkTask = true;
  const IN_PANEL = IN_FRAME;

  const log = (msg, data) => {
    if (typeof tkLog === "function") tkLog("ai-task", msg, data);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CLICKABLE = 'a, button, [role="tab"], [role="button"], [role="link"], [role="menuitem"]';
  const BANNER_ID = "__tk_banner";
  const IS_GEMINI = location.hostname === "gemini.google.com";
  let running = false;
  let current = null; // { id, cancelled } of the run in progress
  let lastTaskId = null;

  // Poll fn() until it returns something truthy, or `timeout` ms of polling pass. Counts loops
  // instead of reading the clock so it behaves the same under test.
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

  const labelOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");

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
    if (IS_GEMINI) return true;
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
      ".ql-editor[contenteditable=\"true\"]",
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

  const inputText = (el) => (el.value !== undefined ? el.value : el.textContent) || "";

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
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
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
      .map((el) => ({ tag: el.tagName, type: el.getAttribute("type"), name: el.getAttribute("name"), role: el.getAttribute("role"), placeholder: el.getAttribute("placeholder"), aria: el.getAttribute("aria-label") }))
      .slice(0, 20);
  }

  // ---------- the status banner (bottom-right) ----------

  function makeBanner() {
    let el = null;
    let msg = null;
    let action = null;
    function ensure() {
      if (el && el.isConnected) return;
      // A banner left over from an earlier task in this chat (reused chat): replace it, never stack.
      document.querySelectorAll("#" + BANNER_ID).forEach((old) => old.remove());
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
      Object.assign(action.style, { display: "none", marginLeft: "10px", padding: "3px 10px", border: "1px solid #fff", borderRadius: "4px", background: "transparent", color: "#fff", font: "inherit", cursor: "pointer", pointerEvents: "auto" });
      el.appendChild(msg);
      el.appendChild(action);
      (document.body || document.documentElement).appendChild(el);
    }
    return {
      set(text, kind, act) {
        ensure();
        msg.textContent = "Lens AI Toolkit: " + text;
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
    // Which uploaded-looking pictures (blob:/data: thumbnails) are on the page. A NEW one is the best
    // evidence that our image arrived - even in a chat that already shows an older image or chip.
    const blobKeys = Array.from(document.querySelectorAll('img[src^="blob:"], img[src^="data:image"]')).map((i) => i.src.length + ":" + i.src.slice(-40));
    return {
      media: root.querySelectorAll('img, canvas, video, [role="img"]').length,
      blobImgs: blobKeys.length,
      blobKeys,
      removeBtns,
      named: nameRe ? nameRe.test(pageText()) : false
    };
  }

  function imageAttached(baseline, fileName) {
    const cur = attachmentSignals(fileName);
    return (
      cur.blobKeys.some((k) => !baseline.blobKeys.includes(k)) ||
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
      const hit = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisible).find((b) => labelOf(b).length < 60 && re.test(labelOf(b)));
      if (hit) return hit;
    }
    return null;
  }

  // Real menu roles first, then anything clickable - but never the "+" button that opened the menu
  // (its tooltip would match too and we'd just re-click it).
  function findMenuItem(re, exclude) {
    const pick = (selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .filter((el) => !exclude || (el !== exclude && !exclude.contains(el) && !el.contains(exclude)))
        .find((el) => labelOf(el).length < 50 && re.test(labelOf(el))) || null;
    return pick('[role="menuitem"], [role="option"], [role="menuitemradio"]') || pick('li, button, a, [role="button"], div[tabindex]');
  }

  function pressEscape() {
    for (const type of ["keydown", "keyup"]) document.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
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
          const item = findMenuItem(/add images?|upload (an )?images?|upload photos?|add photos?|upload files?( or images?)?|add files?|from (my )?computer/i, plus);
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
    for (const type of ["dragenter", "dragover", "drop"]) input.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
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
      const hit = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisible).find((b) => SEND_RE.test(labelOf(b)) && !NOT_SEND_RE.test(labelOf(b)));
      if (hit) return hit;
    }
    return null;
  }

  function composerButtonLabels(box) {
    let scope = box;
    for (let i = 0; i < 5 && scope.parentElement; i++) scope = scope.parentElement;
    return Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisible).map((b) => labelOf(b).slice(0, 30) || "(no label)").slice(0, 15);
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
    return typeof TK !== "undefined" && TK.baseClean ? TK.baseClean(t) : String(t || "").replace(/\r\n?/g, "\n").replace(/ /g, " ").replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
  }

  // Text of every code block on the page (<pre>; or multi-line <code> if there are no <pre>).
  function blockTexts() {
    const banner = document.getElementById(BANNER_ID);
    const outside = (el) => !banner || !banner.contains(el);
    let els = Array.from(document.querySelectorAll("pre")).filter(outside);
    if (!els.length) {
      els = Array.from(document.querySelectorAll("code")).filter((el) => outside(el) && !el.closest("pre") && /\n/.test(el.textContent || ""));
    }
    return els.map((el) => cleanText(el.innerText || el.textContent)).filter(Boolean);
  }

  const pageLines = () =>
    pageText()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  // `count` matters when a new screenshot goes into a chat that already has answers: a new code
  // block counts as new even if its text equals an older one (same image, same text).
  function takeBaseline() {
    const b = blockTexts();
    return { count: b.length, pres: new Set(b), lines: new Set(pageLines()) };
  }

  const readBlocks = (baseline) => blockTexts().filter((t, i) => i >= baseline.count || !baseline.pres.has(t));

  // Last resort when the answer has no code block: the new lines on the page, minus the prompt echo and code fences.
  function newPageText(baseline, prompt, fileName) {
    const needle = prompt.trim().slice(0, 40).toLowerCase();
    const fresh = pageLines().filter((l) => !baseline.lines.has(l) && !l.toLowerCase().includes(needle) && !/^```/.test(l) && l !== fileName);
    return cleanText(fresh.join("\n"));
  }

  const isGenerating = () => Array.from(document.querySelectorAll('button, [role="button"]')).some((b) => isVisible(b) && /^stop\b/i.test(labelOf(b)));

  // Wait for a NEW code block, then until its text stops changing (the answer streams in) and no
  // "Stop" button is showing.
  async function watchForAnswer(baseline, ctx) {
    let last = null;
    let stable = 0;
    for (let i = 0; i < ctx.maxLoops; i++) {
      await sleep(800);
      if (ctx.run && ctx.run.cancelled) return { cancelled: true };
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
      // The side-panel page (an extension page with clipboardWrite) can copy even when this iframe
      // doesn't have keyboard focus, which the browser demands of web pages.
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
      banner.set("I didn't see an answer appear. If Google is still writing one, wait for it, then select the code block and press Ctrl+C.", "error");
      return;
    }
    const raw = cleanText(result.text);
    if (/^NO TEXT FOUND\.?$/i.test(raw)) {
      log("model reported no text");
      banner.set("Google found no text in that image — your clipboard was left alone.", "error");
      if (IN_PANEL) await send({ action: "notifySource", message: "No text found in that image", kind: "error" });
      return;
    }
    // background.js tidies the text (if you switched that on), keeps the copy history, and says
    // whether to copy now or show a preview first.
    const r = await send({ action: "taskResult", id: task.id, text: raw });
    const text = r && typeof r.text === "string" && r.text ? r.text : raw;
    if (r && r.selfTest) {
      log("self-test answer delivered", { chars: text.length });
      banner.set("self-test finished — open the extension popup to see the result.", "ok");
      return;
    }
    if (r && r.copy === false) {
      log("preview shown on the page instead of copying");
      banner.set("text ready — check it on your page, then press Copy there.", "ok");
      return;
    }
    const how = await copyText(text);
    log("copy result", { chars: text.length, copiedVia: how, readFrom: result.how });
    if (how) {
      const note = result.how === "code block" ? "" : " (read from the " + result.how + " — may include extra lines)";
      banner.set("copied " + text.length + " characters ✓" + note, "ok", { label: "Copy again", onClick: () => copyText(text) });
      if (IN_PANEL) {
        await send({ action: "notifySource", message: "Copied " + text.length + " characters ✓" }); // the page you were on is still in front
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

  async function runTask(task, reused) {
    if (running || !task) return;
    running = true;
    const run = (current = { id: task.id, cancelled: false });
    const banner = makeBanner();
    const prompt = (task.prompt || "").trim();
    const needle = prompt.slice(0, 40).toLowerCase();
    const fileName = task.name || "image.png";
    const isExtract = task.kind !== "ask";

    try {
      log("task started", { href: location.href, kind: task.kind, stage: task.stage, autoSend: !!task.autoSend, hasImage: !!task.image, panel: IN_PANEL });

      // After a page reload the image was already sent: only watch, never attach/send again.
      if (task.stage === "sent") {
        if (!isExtract) return;
        banner.set("waiting for Google's answer…");
        const result = await watchForAnswer({ count: 0, pres: new Set(), lines: new Set() }, { maxLoops: 75, allowPageText: false, prompt, fileName, run });
        if (result && result.cancelled) return;
        await finishWithResult(result, task, banner);
        return;
      }

      // 1) the input box
      banner.set("opening " + (IS_GEMINI ? "Gemini" : "AI Mode") + "…");
      const input = await waitFor(() => isAiModePage() && findAiInput(), 25000);
      if (!input) {
        log("input not found", { href: location.href, inputs: snapshotInputs(), clickables: snapshotClickables() });
        if (await fallbackToTab(task, "input not found", banner)) return;
        banner.set("couldn't find the input box (is Google asking you to sign in?). See the debug log.", "error");
        banner.hide(15000);
        return;
      }
      await sleep(600); // let the page finish its own startup
      if (run.cancelled) return;

      // 2) attach the image - first strategy that visibly works wins
      const file = makeFile(task);
      const before = attachmentSignals(fileName);
      let attachedBy = null;
      const strategies = [
        ["paste", () => tryPaste(findAiInput() || input, file)],
        ["+ menu / file input", () => tryFileInput(findAiInput() || input, file)],
        ["drop", () => tryDrop(findAiInput() || input, file)]
      ];
      for (const [name, runStrategy] of strategies) {
        banner.set("attaching the image (" + name + ")…");
        let detail = {};
        try {
          detail = (await runStrategy()) || {};
        } catch (e) {
          detail = { error: e.message };
        }
        const ok = !!(await waitFor(() => imageAttached(before, fileName), 3500));
        log("attach via " + name, { ok, ...detail, signals: { ...attachmentSignals(fileName), blobKeys: undefined }, before: { ...before, blobKeys: undefined } });
        if (ok) {
          attachedBy = name;
          break;
        }
      }
      if (run.cancelled) return;

      let box = findAiInput() || input;
      let baseline;
      let sent = false;
      let manual = false; // the user has to finish by hand

      if (!attachedBy) {
        log("could NOT attach the image", {
          href: location.href,
          clickables: snapshotClickables(),
          inputs: snapshotInputs(),
          fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((i) => i.getAttribute("accept"))
        });
        // A reused chat that won't take the image: let the panel start a fresh chat and try there.
        if (reused && IN_PANEL) {
          banner.set("couldn't add it to this chat — starting a fresh one…");
          log("reused chat failed, asking the panel for a fresh chat");
          try {
            window.parent.postMessage({ tk: "fresh", id: task.id }, OURS);
          } catch (e) {}
          return;
        }
        // Side panel: a normal tab may manage what the narrow framed page could not.
        if (await fallbackToTab(task, "attach failed", banner)) return;
        // Never send a question without the image. Hand over to the user.
        const copied = await copyImageToClipboard(file);
        if (prompt) typeInto(box, prompt);
        manual = true;
        banner.set(
          "couldn't attach the image automatically. Your prompt is typed" +
            (copied ? "; the image is on your clipboard — click the box, press Ctrl+V, then Enter." : "; add the image yourself, then press Enter.") +
            (isExtract ? " I'll copy the answer when it appears." : ""),
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
            banner.set("couldn't confirm it was sent — press Enter in the box." + (isExtract ? " I'll copy the answer when it appears." : ""), "error");
          } else {
            banner.set(isExtract ? "waiting for Google's answer…" : "sent ✓", isExtract ? undefined : "ok");
          }
        } else {
          manual = true;
          const reason = !task.autoSend ? (prompt ? "auto-send is off" : "no prompt is set") : !prompt ? "no prompt" : !imageStill ? "image disappeared" : "prompt didn't land";
          banner.set(
            prompt ? "ready (" + reason + ") — check it and press Enter." + (isExtract ? " I'll copy the answer when it appears." : "") : "image attached — type your question and press Enter.",
            "ok"
          );
        }
      }

      // The image has done its job: drop it from memory and remember we're past the send step, so
      // a reload can never trigger a second attach/send.
      await send({ action: "taskUpdate", id: task.id, patch: { stage: "sent", image: null } });

      if (!isExtract) {
        banner.hide(manual ? 12000 : 4000);
        return;
      }

      // 5) watch for the answer and copy it
      const result = await watchForAnswer(baseline, { maxLoops: manual ? 225 : 75, allowPageText: sent, prompt, fileName, run });
      if (result && result.cancelled) return;
      await finishWithResult(result, task, banner);
    } catch (e) {
      log("task error", { message: e.message, stack: e.stack });
      banner.set("something went wrong — see the debug log.", "error");
      banner.hide(15000);
    } finally {
      running = false;
      if (current === run) current = null;
      send({ action: "taskDone", id: task.id }); // clears the task (and any image still held)
    }
  }

  async function startTask(task, reused) {
    if (!task || !task.id) return;
    if (task.kind === "open") {
      // Plain AI Mode page: asking for the task was the check-in; nothing to automate.
      send({ action: "taskDone", id: task.id });
      return;
    }
    if (running && current) {
      // A new screenshot arrived while the last one is still being watched (reused chat): stop the old run.
      current.cancelled = true;
      for (let i = 0; i < 25 && running; i++) await sleep(160);
    }
    runTask(task, reused);
  }

  // Ask background.js whether there is a task for THIS tab / panel frame.
  async function fetchAndRun(reused) {
    const task = await send({ action: "getTask" });
    if (task && task.id && task.id !== lastTaskId) {
      lastTaskId = task.id;
      await startTask(task, !!reused);
      return true;
    }
    return false;
  }

  // ---------- side panel: "same chat" protocol ----------
  // The panel page says {tk:"newTask"} when a new screenshot should go into the chat that is
  // already open in this frame; we say {tk:"hello"} when this page is ready for that.
  if (IN_PANEL) {
    window.addEventListener("message", (e) => {
      if (e.origin !== OURS || !e.data || e.data.tk !== "newTask") return;
      fetchAndRun(true);
    });
    // Only an AI page can take a new screenshot into "the open chat" (not, say, a search result you clicked).
    if (isAiModePage()) {
      try {
        window.parent.postMessage({ tk: "hello" }, OURS);
      } catch (e) {}
    }
  }

  // ---------- the prompts you type yourself (for the history) ----------
  // Only real key presses and clicks count (isTrusted); our own automatic typing never does.

  (function recordTypedPrompts() {
    let last = { text: "", t: 0 };
    const record = (text) => {
      text = String(text || "").trim();
      if (!text) return;
      const now = Date.now();
      if (text === last.text && now - last.t < 4000) return;
      last = { text, t: now };
      send({ action: "recordPrompt", text, via: "typed in " + (IS_GEMINI ? "Gemini" : "AI Mode") });
    };
    const isBox = (el) => el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
    document.addEventListener(
      "keydown",
      (e) => {
        if (!e.isTrusted || e.key !== "Enter" || e.shiftKey || e.isComposing || !isAiModePage() || !isBox(e.target)) return;
        record(inputText(e.target)); // capture phase: runs before the page empties the box
      },
      true
    );
    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted || !isAiModePage()) return;
        const b = e.target && e.target.closest ? e.target.closest('button, [role="button"]') : null;
        if (!b || !SEND_RE.test(labelOf(b)) || NOT_SEND_RE.test(labelOf(b))) return;
        const box = findAiInput();
        if (box) record(inputText(box));
      },
      true
    );
  })();

  // ---------- start ----------

  // Asked a few times in case the page loaded a moment before the task was saved.
  (async function start() {
    for (const delay of [0, 800, 2500]) {
      if (delay) await sleep(delay);
      if (await fetchAndRun()) return;
    }
  })();
})();
