// hover.js — the button that appears on an image while you hover over it.
//
// - One floating button (inside a closed shadow root, so page CSS can't touch
//   it) is moved onto whichever <img> / <canvas> is under the pointer and
//   hidden again shortly after the pointer leaves.
// - It uses document.elementsFromPoint, so it still works when the site puts a
//   transparent layer over its pictures.
// - Clicking it gets the image bytes (from the page for data:/blob:/canvas, from
//   the background script for normal URLs, or a cropped screenshot as a last
//   resort) and hands them to background.js, which opens Google AI Mode.
// - Nothing happens until you click. No data leaves your browser before that.

(function () {
  if (window.__itcHover) return;
  window.__itcHover = true;

  // Not inside the AI Mode tab the extension itself opens.
  if (location.hostname === "www.google.com" && (/^\/(ai|aimode)\/?$/.test(location.pathname) || location.search.includes("udm=50"))) {
    return;
  }

  const MIN_W = 64;
  const MIN_H = 40;
  const BTN = 30;
  const MARGIN = 6;

  const ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 9h6M12 9v7"/></svg>';

  let host = null;
  let btn = null;
  let toastEl = null;
  let target = null;
  let hideTimer = null;
  let toastTimer = null;
  let busy = false;
  let rafPending = false;
  let lastEvt = null;

  const log = (msg, data) => {
    if (typeof itcLog === "function") itcLog("hover", msg, data);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The "open in side panel / new tab" setting, cached here so a click can tell
  // background.js at once (the side panel can only be opened inside the click's user gesture).
  let openIn = null;
  try {
    chrome.storage.local.get({ openIn: "sidepanel" }).then(
      (r) => {
        openIn = r.openIn;
      },
      () => {}
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.openIn) openIn = changes.openIn.newValue;
    });
  } catch (e) {}

  // ---------- the button (built on first use) ----------

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-itc", "1");
    host.style.cssText =
      "all:initial !important; position:fixed !important; left:0 !important; top:0 !important; " +
      "width:0 !important; height:0 !important; z-index:2147483647 !important;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML =
      "<style>" +
      "#b{position:fixed;display:none;width:" + BTN + "px;height:" + BTN + "px;padding:0;border:0;border-radius:50%;" +
      "background:#1a73e8;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);" +
      "align-items:center;justify-content:center;font:inherit}" +
      "#b:hover{background:#1557b0}" +
      "#b.working{background:#5f6368;cursor:progress}" +
      "#b.done{background:#188038}" +
      "#b.error{background:#d93025}" +
      "#b svg{display:block}" +
      "#t{position:fixed;right:16px;bottom:16px;display:none;max-width:320px;padding:9px 13px;border-radius:8px;" +
      "background:#1a73e8;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)}" +
      "#t.ok{background:#188038}#t.error{background:#d93025}" +
      "</style>" +
      '<button id="b" type="button" title="Copy the text in this image (Google AI)" ' +
      'aria-label="Copy the text in this image (Google AI)">' + ICON + "</button><div id=\"t\"></div>";
    btn = root.getElementById("b");
    toastEl = root.getElementById("t");
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup"]) {
      btn.addEventListener(type, (e) => e.stopPropagation());
    }
    btn.addEventListener("click", onClick);
    document.documentElement.appendChild(host);
  }

  function setState(state, title) {
    if (!btn) return;
    btn.className = state === "idle" ? "" : state;
    btn.title = title || "Copy the text in this image (Google AI)";
  }

  function toast(text, kind) {
    build();
    toastEl.textContent = text;
    toastEl.className = kind || "";
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = "none"), 4500);
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
    const left = Math.min(Math.max(0, r.x + r.width - BTN - MARGIN), vw - BTN);
    const top = Math.min(Math.max(0, r.y + MARGIN), vh - BTN);
    btn.style.left = left + "px";
    btn.style.top = top + "px";
    btn.style.display = "flex";
  }

  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    target = null;
    if (btn) btn.style.display = "none";
  }

  function onMove(e) {
    if (!e) return;
    if (host && e.target === host) {
      // pointer is on our own button: keep it
      clearTimeout(hideTimer);
      hideTimer = null;
      return;
    }
    const img = pickImage(e.clientX, e.clientY);
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

  // ---------- click ----------

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (busy || !target) return;
    busy = true;
    const el = target;
    const isTop = window === window.top;
    setState("working", "Sending to Google AI Mode…");
    log("button clicked", { tag: el.tagName, src: (el.currentSrc || el.src || "").slice(0, 200), topFrame: isTop });

    let res = { ok: false, canCapture: true, error: "unreadable image" };
    try {
      const source = await sourceFromPage(el);
      if (source) res = await send({ action: "startImageTask", source, openIn });

      if (!res.ok && res.canCapture !== false && isTop) {
        const rect = visibleRect(el);
        if (rect) {
          // Hide our button so it isn't in the screenshot, then crop the image out of the tab.
          btn.style.display = "none";
          await sleep(180);
          res = await send({ action: "startImageTask", source: { capture: { rect, dpr: window.devicePixelRatio || 1 } }, openIn });
          if (target) place();
        }
      }
    } catch (err) {
      res = { ok: false, error: err.message };
    }

    if (res.ok) {
      setState("done", "Sent to Google AI Mode");
      toast(
        res.where === "sidepanel"
          ? "Sent to Google AI Mode (side panel) — the text is copied when the answer is ready."
          : "Sent to Google AI Mode — the text is copied when the answer is ready.",
        "ok"
      );
    } else {
      log("click failed", { error: res.error });
      setState("error", "Couldn't read this image");
      toast("Couldn't read this image: " + (res.error || "unknown error"), "error");
    }
    setTimeout(() => {
      busy = false;
      setState("idle");
    }, 2500);
  }

  // The background script asks us to show a message (e.g. "copied ✓" after returning to this tab).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "toast" && window === window.top) toast(msg.text, msg.kind);
  });
})();
