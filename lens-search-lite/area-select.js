// area-select.js
// Injected on demand (via chrome.scripting + activeTab) only when you start
// an area selection — it is NOT a permanent content script and does not run
// on pages you're just browsing normally.
//
// Draws a full-viewport overlay so you can drag out a rectangle, then reports
// that rectangle back to the background script, which crops the screenshot
// it already captured a moment ago.

(async function () {
  try {
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    debugLog.push({ ts: Date.now(), tag: "area-select", msg: "overlay script running", data: JSON.stringify({ href: location.href }) });
    while (debugLog.length > 150) debugLog.shift();
    await chrome.storage.local.set({ debugLog });
  } catch (e) {}

  if (window.__lensAreaSelectActive) return; // don't double-inject
  window.__lensAreaSelectActive = true;

  const overlay = document.createElement("div");
  overlay.id = "__lens_area_overlay";
  document.documentElement.appendChild(overlay);

  const box = document.createElement("div");
  box.id = "__lens_area_box";
  overlay.appendChild(box);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function cleanup() {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown);
    window.__lensAreaSelectActive = false;
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      chrome.runtime.sendMessage({ action: "areaSelectionCancelled" });
      cleanup();
    }
  }
  document.addEventListener("keydown", onKeyDown);

  overlay.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    Object.assign(box.style, {
      left: startX + "px",
      top: startY + "px",
      width: "0px",
      height: "0px",
      display: "block"
    });
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    Object.assign(box.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  });

  overlay.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    const rect = box.getBoundingClientRect();
    cleanup();

    if (rect.width < 4 || rect.height < 4) {
      chrome.runtime.sendMessage({ action: "areaSelectionCancelled" });
      return;
    }

    chrome.runtime.sendMessage({
      action: "areaSelected",
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      devicePixelRatio: window.devicePixelRatio || 1
    });
  });
})();
