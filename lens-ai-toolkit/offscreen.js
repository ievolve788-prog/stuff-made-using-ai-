// offscreen.js — hidden helper page. Two jobs, both asked for by the service worker:
//   "ocr"  — read the text in an image with Tesseract (English, fully offline, files in ./vendor)
//   "copy" — put text on the clipboard
// Everything stays on this computer.

(function () {
  const IDLE_MS = 60000; // free the reader's memory a minute after the last job
  let workerPromise = null;
  let idleTimer = null;

  function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker("eng", 1, {
        workerPath: chrome.runtime.getURL("vendor/worker.min.js"),
        corePath: chrome.runtime.getURL("vendor/tesseract-core-simd-lstm.wasm.js"),
        langPath: chrome.runtime.getURL("vendor/"),
        gzip: true,
        workerBlobURL: false, // the worker file is ours; no blob: URL (the extension CSP wouldn't allow it)
        cacheMethod: "none",
        logger: () => {}
      }).catch((e) => {
        workerPromise = null;
        throw e;
      });
    }
    return workerPromise;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      if (!workerPromise) return;
      const p = workerPromise;
      workerPromise = null;
      try {
        (await p).terminate();
      } catch (e) {}
    }, IDLE_MS);
  }

  // Draw the picture on a white canvas, bigger if it is small (Tesseract likes ~30px letters).
  async function prepare(base64, mime) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime || "image/png" }));
    const longest = Math.max(bmp.width, bmp.height);
    const scale = longest < 1000 ? 3 : longest < 1800 ? 2 : 1;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  // Tesseract's own `text` adds blank lines between "paragraphs"; build the text line by line instead.
  function linesOf(data) {
    const out = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          const t = String(l.text || "").replace(/\s+$/, "");
          if (t.trim()) out.push(t.trim());
        }
      }
    }
    return out.length ? out.join("\n") : String(data.text || "").split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
  }

  async function ocr(msg) {
    const t0 = Date.now();
    try {
      const worker = await getWorker();
      const canvas = await prepare(msg.base64, msg.mime);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      scheduleIdle();
      return { ok: true, text: linesOf(data), confidence: Math.round(data.confidence || 0), ms: Date.now() - t0 };
    } catch (e) {
      scheduleIdle();
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  async function copy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) return { ok: true };
    } catch (e) {}
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return false;
    if (msg.action === "ocr") {
      ocr(msg).then(sendResponse);
      return true;
    }
    if (msg.action === "copy") {
      copy(String(msg.text || "")).then(sendResponse);
      return true;
    }
    return false;
  });
})();
