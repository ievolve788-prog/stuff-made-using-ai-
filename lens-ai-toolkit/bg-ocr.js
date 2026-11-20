// bg-ocr.js — the optional offline text reader. A service worker cannot run workers or touch the
// clipboard, so both jobs live in a hidden "offscreen" page (offscreen.html) that is created on
// demand. (Loaded by background.js with importScripts.)

let offscreenCreating = null;

async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) throw new Error("this Chrome has no offscreen documents");
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (ctx && ctx.length) return;
  } catch (e) {}
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS", "CLIPBOARD"],
        justification: "Run the offline text reader (OCR) in a worker and copy the text to the clipboard."
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  try {
    await offscreenCreating;
  } catch (e) {
    if (!/single|already/i.test(e && e.message)) throw e; // "only one offscreen document" = it exists, fine
  }
}

// -> { ok, text, confidence, ms } | { ok:false, error }
async function localOcr(image) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", action: "ocr", base64: image.base64, mime: image.mime });
  return res || { ok: false, error: "the offline reader did not answer" };
}

async function offscreenCopy(text) {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: "offscreen", action: "copy", text });
    return !!(res && res.ok);
  } catch (e) {
    log("offscreen copy failed", { message: e.message });
    return false;
  }
}
