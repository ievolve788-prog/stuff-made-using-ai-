// lens-inject.js
// Runs ONLY on https://lens.google.com/ (see manifest.json). It does not run
// anywhere else, and it does not read or send anything except the one
// screenshot our own background script hands it.
//
// It tries two ways to get the image into Google's own upload UI:
//   1. Simulate a manual drag-and-drop onto Google's drop-zone element.
//   2. Fallback: find any <input type="file"> on the page and set its
//      files directly (the same trick browser test tools use).
// If neither works, it logs a diagnostic snapshot of the page so we can
// figure out the right selector.

logEvent("content script loaded", { href: location.href, title: document.title });

async function logEvent(msg, data) {
  try {
    const entry = { ts: Date.now(), tag: "lens-inject", msg, data: safeStringify(data) };
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    debugLog.push(entry);
    while (debugLog.length > 150) debugLog.shift();
    await chrome.storage.local.set({ debugLog });
  } catch (e) {}
}

function safeStringify(data) {
  if (data === undefined) return undefined;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function isLensUploadPage() {
  // Only ever act on the actual "Search any image with Google Lens" modal —
  // never on a normal google.com search page the user might have open.
  if (location.href.includes("olud")) return true;
  const text = document.body ? document.body.innerText : "";
  return /search any image with google lens/i.test(text) || /drag an image here/i.test(text);
}

function findDropZone() {
  if (!isLensUploadPage()) return null;
  return document.querySelector('div[data-ved][jsname="QdEQIc"]');
}

function findFileInput() {
  if (!isLensUploadPage()) return null;
  return document.querySelector('input[type="file"]');
}

function makeFile(base64) {
  const byteString = atob(base64);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
  return new File([bytes], "screenshot.png", { type: "image/png" });
}

function diagnosticSnapshot() {
  const jsnameEls = Array.from(document.querySelectorAll("[jsname]")).slice(0, 40);
  return {
    url: location.href,
    title: document.title,
    fileInputCount: document.querySelectorAll('input[type="file"]').length,
    jsnameElements: jsnameEls.map((el) => ({
      tag: el.tagName,
      jsname: el.getAttribute("jsname"),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label")
    }))
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkLensReady") {
    const zone = findDropZone();
    const input = findFileInput();
    const ready = (!!zone && !!zone.offsetParent) || !!input;
    logEvent("checkLensReady", { dropZoneFound: !!zone, fileInputFound: !!input, ready });
    sendResponse({ ready });
    return true;
  }

  if (request.action === "searchScreenshot") {
    const file = makeFile(request.screenshot);
    const dt = new DataTransfer();
    dt.items.add(file);

    const zone = findDropZone();
    if (zone) {
      logEvent("searchScreenshot: attempting drop-zone simulation");
      for (const type of ["dragenter", "dragover", "drop"]) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      sendResponse({ method: "drop-zone" });
      return true;
    }

    const input = findFileInput();
    if (input) {
      logEvent("searchScreenshot: attempting file-input fallback");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      sendResponse({ method: "file-input" });
      return true;
    }

    logEvent("searchScreenshot: NO drop zone or file input found — diagnostic snapshot follows", diagnosticSnapshot());
    sendResponse({ method: "none-found" });
    return true;
  }
});
