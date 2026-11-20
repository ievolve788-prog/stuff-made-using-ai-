// page-ui.js — everything the extension shows ON the web page you are reading:
//   - the hover button that appears on an image (copies the exact text in it)
//   - small "copied ✓" / error notes
//   - the preview bubble (text first, copy when you press Copy)
//   - the "page captured — send it?" button after a scrolling capture
// It lives inside a closed shadow root, so the site's own CSS can't touch it. Nothing leaves your
// browser until you click: the hover button only sends an image to Google AI Mode when pressed.

(function () {
  if (window.__tkPageUi) return;
  window.__tkPageUi = true;

  // Not inside the AI Mode tab / Gemini the extension itself opens, nor in a side-panel frame.
  const h = location.hostname;
  if (h === "gemini.google.com") return;
  if (h === "www.google.com" && (/^\/(ai|aimode)\/?$/.test(location.pathname) || location.search.includes("udm=50"))) return;

  const IS_TOP = window === window.top;
  const MIN_W = 64;
  const MIN_H = 40;
  const BTN = 30;
  const MARGIN = 6;
  const ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 9h6M12 9v7"/></svg>';

  const log = (msg, data) => {
    if (typeof tkLog === "function") tkLog("page-ui", msg, data);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- settings (cached) ----------

  let S = typeof TK !== "undefined" ? { ...TK.DEFAULTS } : { fHover: true, fHoverAltOnly: false, hoverBlocklist: "", openIn: "sidepanel", ocrEngine: "ai" };
  try {
    chrome.storage.local.get(S).then(
      (r) => {
        S = r;
        applyGate();
      },
      () => {}
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const k of Object.keys(S)) if (k in changes) S[k] = changes[k].newValue;
      applyGate();
    });
  } catch (e) {}

  const hoverAllowed = () => !!S.fHover && !(typeof TK !== "undefined" && TK.hostBlocked(location.hostname, S.hoverBlocklist));
  // Tell background.js at once whether this click will end in the side panel (it can only be
  // opened inside the click's user action, before anything is awaited).
  const wantPanel = () => S.openIn === "sidepanel" && S.ocrEngine === "ai";

  // ---------- the shadow-DOM UI (built on first use) ----------

  let host = null;
  let root = null;
  let btn = null;
  let toastEl = null;
  let toastTextEl = null;
  let toastBtn = null;
  let bubble = null;
  let target = null;
  let hideTimer = null;
  let toastTimer = null;
  let busy = false;
  let rafPending = false;
  let lastEvt = null;
  let altDown = false;
  let uiHidden = false; // true while the extension takes a screenshot of this page (our own UI must not be in it)

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-tk", "1");
    host.style.cssText = "all:initial !important; position:fixed !important; left:0 !important; top:0 !important; width:0 !important; height:0 !important; z-index:2147483647 !important;";
    if (uiHidden) host.style.setProperty("visibility", "hidden", "important");
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML =
      "<style>" +
      "#b{position:fixed;display:none;width:" + BTN + "px;height:" + BTN + "px;padding:0;border:0;border-radius:50%;background:#1a73e8;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);align-items:center;justify-content:center;font:inherit}" +
      "#b:hover{background:#1557b0}#b.working{background:#5f6368;cursor:progress}#b.done{background:#188038}#b.error{background:#d93025}#b svg{display:block}" +
      "#t{position:fixed;right:16px;bottom:16px;display:none;max-width:340px;padding:9px 13px;border-radius:8px;background:#1a73e8;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)}" +
      "#t.ok{background:#188038}#t.error{background:#d93025}#t button{margin-left:10px;padding:3px 10px;border:1px solid #fff;border-radius:4px;background:transparent;color:#fff;font:inherit;cursor:pointer}" +
      "#u{position:fixed;right:16px;bottom:16px;display:none;width:min(420px,calc(100vw - 32px));padding:12px;border-radius:10px;background:#fff;color:#202124;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 28px rgba(0,0,0,.4);border:1px solid #dadce0}" +
      "#u .hd{font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px}#u .nt{color:#5f6368;font-weight:400;font-size:12px}" +
      "#u textarea{width:100%;height:150px;box-sizing:border-box;padding:8px;border:1px solid #dadce0;border-radius:6px;font:12.5px/1.45 ui-monospace,Consolas,monospace;color:#202124;background:#f8f9fa;resize:vertical}" +
      "#u .ft{display:flex;gap:8px;align-items:center;margin-top:8px}#u .ft span{flex:1;color:#188038}" +
      "#u button{padding:5px 12px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#202124;font:inherit;cursor:pointer}#u button.p{background:#1a73e8;border-color:#1a73e8;color:#fff}" +
      "</style>" +
      '<button id="b" type="button" title="Copy the text in this image (Google AI)" aria-label="Copy the text in this image (Google AI)">' + ICON + "</button>" +
      '<div id="t"><span id="tt"></span><button id="tb" type="button" style="display:none"></button></div>' +
      '<div id="u"><div class="hd"><span id="uh">Text from the image</span><span class="nt" id="un"></span></div><textarea id="ux" spellcheck="false"></textarea>' +
      '<div class="ft"><span id="us"></span><button id="uc" class="p" type="button">Copy</button><button id="ux2" type="button">Close</button></div></div>';
    btn = root.getElementById("b");
    toastEl = root.getElementById("t");
    toastTextEl = root.getElementById("tt");
    toastBtn = root.getElementById("tb");
    bubble = root.getElementById("u");
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup"]) btn.addEventListener(type, (e) => e.stopPropagation());
    btn.addEventListener("click", onClick);
    root.getElementById("ux2").addEventListener("click", () => (bubble.style.display = "none"));
    (document.documentElement || document.body).appendChild(host);
  }

  function setState(state, title) {
    if (!btn) return;
    btn.className = state === "idle" ? "" : state;
    btn.title = title || "Copy the text in this image (Google AI)";
  }

  function toast(text, kind, action, ms) {
    build();
    toastTextEl.textContent = text;
    toastEl.className = kind === "info" ? "" : kind || "";
    if (action) {
      toastBtn.textContent = action.label;
      toastBtn.onclick = () => {
        toastEl.style.display = "none";
        action.onClick();
      };
      toastBtn.style.display = "inline-block";
    } else {
      toastBtn.style.display = "none";
    }
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = "none"), ms || (action ? 20000 : 4500));
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // The preview bubble: you see (and can edit) the text, then press Copy.
  function showBubble(msg) {
    build();
    const ta = root.getElementById("ux");
    ta.value = msg.text || "";
    root.getElementById("un").textContent = msg.note || (msg.engine === "local" ? "offline reader — check it" : "");
    const status = root.getElementById("us");
    status.textContent = msg.copied ? "Copied ✓" : "";
    const copyBtn = root.getElementById("uc");
    copyBtn.onclick = async () => {
      const ok = await copyToClipboard(ta.value);
      status.textContent = ok ? "Copied ✓" : "Copy failed — select the text and press Ctrl+C";
      status.style.color = ok ? "#188038" : "#d93025";
      if (ok) {
        try {
          chrome.runtime.sendMessage({ action: "bubbleCopied", text: ta.value, engine: msg.engine });
        } catch (e) {}
      }
    };
    bubble.style.display = "block";
    ta.focus();
  }

  // ---------- finding the image under the pointer ----------

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const right = Math.min(vw, r.right);
    const bottom = Math.min(vh, r.bottom);
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }

  function isCandidate(el) {
    if (!el || (el.tagName !== "IMG" && el.tagName !== "CANVAS")) return false;
    const r = el.getBoundingClientRect();
    return r.width >= MIN_W && r.height >= MIN_H;
  }

  function pickImage(x, y) {
    const els = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    return els.find(isCandidate) || null;
  }

  function place() {
    if (!target || !target.isConnected) return hide();
    const r = visibleRect(target);
    if (!r) return hide();
    build();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    btn.style.left = Math.min(Math.max(0, r.x + r.width - BTN - MARGIN), vw - BTN) + "px";
    btn.style.top = Math.min(Math.max(0, r.y + MARGIN), vh - BTN) + "px";
    btn.style.display = "flex";
  }

  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    target = null;
    if (btn) btn.style.display = "none";
  }

  function applyGate() {
    if (!hoverAllowed()) hide();
  }

  function onMove(e) {
    if (!e || !hoverAllowed()) return;
    if (host && e.target === host) {
      clearTimeout(hideTimer);
      hideTimer = null;
      return;
    }
    const needAlt = !!S.fHoverAltOnly;
    const img = !needAlt || e.altKey || altDown ? pickImage(e.clientX, e.clientY) : null;
    if (img) {
      clearTimeout(hideTimer);
      hideTimer = null;
      target = img;
      place();
    } else if (target && !hideTimer) {
      hideTimer = setTimeout(hide, 250);
    }
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      lastEvt = e;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        onMove(lastEvt);
      });
    },
    { capture: true, passive: true }
  );
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt") {
      altDown = true;
      if (lastEvt && S.fHoverAltOnly) onMove(lastEvt);
    }
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") {
      altDown = false;
      if (S.fHoverAltOnly) hide();
    }
  }, true);
  window.addEventListener("blur", () => (altDown = false));
  const reposition = () => {
    if (target) place();
  };
  window.addEventListener("scroll", reposition, { capture: true, passive: true });
  window.addEventListener("resize", reposition, { passive: true });

  // ---------- talking to background.js ----------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, error: "The extension was reloaded - refresh this page." });
      }
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // What we can read straight from the page: canvas pixels, data: and blob: images.
  async function sourceFromPage(el) {
    if (el.tagName === "CANVAS") {
      try {
        return { base64: el.toDataURL("image/png").split(",")[1], mime: "image/png" };
      } catch (e) {
        return null; // tainted canvas
      }
    }
    const src = el.currentSrc || el.src || "";
    if (/^(data|blob):/i.test(src)) {
      try {
        const blob = await (await fetch(src)).blob();
        return { base64: await blobToBase64(blob), mime: blob.type };
      } catch (e) {
        return null;
      }
    }
    if (/^https?:/i.test(src)) return { url: src };
    return null;
  }

  // ---------- the hover button click ----------

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (busy || !target) return;
    busy = true;
    const el = target;
    const isTop = window === window.top;
    const panelHint = wantPanel();
    setState("working", "Working…");
    log("hover button clicked", { tag: el.tagName, src: (el.currentSrc || el.src || "").slice(0, 200), topFrame: isTop });

    let res = { ok: false, canCapture: true, error: "unreadable image" };
    try {
      const source = await sourceFromPage(el);
      if (source) res = await send({ action: "startImageTask", source, wantPanel: panelHint });

      if (!res.ok && res.canCapture !== false && isTop && visibleRect(el)) {
        // Hide our button so it isn't in the screenshot, then crop the image out of the tab. With
        // the side panel the page has just been narrowed: wait for it to settle, THEN measure.
        btn.style.display = "none";
        await sleep(panelHint ? 600 : 180);
        const rect = visibleRect(el);
        if (rect) res = await send({ action: "startImageTask", source: { capture: { rect, dpr: window.devicePixelRatio || 1 } }, wantPanel: panelHint });
        if (target) place();
      }
    } catch (err) {
      res = { ok: false, error: err.message };
    }

    if (res.ok) {
      setState("done", "Sent");
      const msgs = {
        sidepanel: res.choose ? "Pick what to do with the image in the side panel." : "Sent to Google AI Mode (side panel) — the text is copied when the answer is ready.",
        tab: "Sent to Google AI Mode — the text is copied when the answer is ready.",
        local: "Reading the text offline…"
      };
      toast(msgs[res.where] || "Sent.", "ok");
    } else {
      log("hover click failed", { error: res.error });
      setState("error", "Couldn't read this image");
      toast("Couldn't read this image: " + (res.error || "unknown error"), "error");
    }
    setTimeout(() => {
      busy = false;
      setState("idle");
    }, 2500);
  }

  // ---------- messages from background.js ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !IS_TOP) return;
    if (msg.action === "hideUi" || msg.action === "showUi") {
      uiHidden = msg.action === "hideUi";
      if (host) {
        if (uiHidden) host.style.setProperty("visibility", "hidden", "important");
        else host.style.removeProperty("visibility");
      }
    } else if (msg.action === "toast") toast(msg.text, msg.kind);
    else if (msg.action === "bubble") showBubble(msg);
    else if (msg.action === "offer") {
      toast(msg.text, "info", {
        label: msg.button || "OK",
        onClick: () => {
          send({ action: "offerAccepted", token: msg.token }).then((res) => {
            if (!res || !res.ok) toast("Couldn't send it: " + ((res && res.error) || "unknown error"), "error");
          });
        }
      });
    }
  });
})();
