// area-select.js
// Injected on demand (chrome.scripting) only when you start an area selection — it is NOT a
// permanent content script. Draws a full-viewport overlay so you can drag out a rectangle, then
// reports that rectangle (plus what the selection is for) to background.js, which crops the
// screenshot it took a moment before the overlay appeared.

(function () {
  if (window.__lensAreaSelectActive) return; // don't double-inject
  window.__lensAreaSelectActive = true;

  const intent = window.__tkAreaIntent || { type: "search", via: "area" };

  const overlay = document.createElement("div");
  overlay.id = "__lens_area_overlay";
  const hint = document.createElement("div");
  hint.id = "__lens_area_hint";
  hint.textContent =
    (intent.type === "text" ? "Drag over the text you want to copy" : "Drag over the area you want to search") + "  ·  Esc to cancel";
  overlay.appendChild(hint);
  const box = document.createElement("div");
  box.id = "__lens_area_box";
  overlay.appendChild(box);
  document.documentElement.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function cleanup() {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown, true);
    window.__lensAreaSelectActive = false;
  }

  function cancel() {
    cleanup();
    chrome.runtime.sendMessage({ action: "areaSelectionCancelled" });
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  document.addEventListener("keydown", onKeyDown, true);

  overlay.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancel();
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    hint.style.display = "none";
    Object.assign(box.style, { left: startX + "px", top: startY + "px", width: "0px", height: "0px", display: "block" });
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    Object.assign(box.style, { left: x + "px", top: y + "px", width: Math.abs(e.clientX - startX) + "px", height: Math.abs(e.clientY - startY) + "px" });
  });

  overlay.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    const rect = box.getBoundingClientRect();
    cleanup(); // the overlay must be gone BEFORE background.js might need a fresh screenshot
    if (rect.width < 4 || rect.height < 4) {
      chrome.runtime.sendMessage({ action: "areaSelectionCancelled" });
      return;
    }
    // This message is sent inside the mouse-up: background.js uses it as the "user action" that lets
    // it open the side panel.
    chrome.runtime.sendMessage({
      action: "areaSelected",
      intent,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      devicePixelRatio: window.devicePixelRatio || 1
    });
  });
})();
