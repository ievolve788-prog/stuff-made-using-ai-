// background.js — the extension's service worker: right-click menus, keyboard shortcuts and the
// message router. The real work is in the bg-*.js files.
//
// DEBUGGING: every important step is written to the debug log (popup -> "Copy debug log").

globalThis.__TK_IS_BACKGROUND = true; // log.js: the worker writes the debug log itself
importScripts("settings.js", "log.js", "textutil.js", "bg-core.js", "bg-image.js", "bg-ocr.js", "bg-flows.js");

// ---------- right-click menus (each item has its own switch in the settings) ----------

let menuBuild = Promise.resolve();
function rebuildMenus() {
  menuBuild = menuBuild.then(
    () =>
      new Promise((resolve) => {
        chrome.contextMenus.removeAll(() => {
          const s = currentSettings();
          const add = (id, title, contexts) => chrome.contextMenus.create({ id, title, contexts }, () => void chrome.runtime.lastError);
          const everywhere = ["page", "selection", "image", "frame", "link", "video"];
          if (s.mImageText) add("img-text", "Copy text from this image (Google AI)", ["image"]);
          if (s.mImageLens) add("img-lens", "Search this image with Google Lens", ["image"]);
          if (s.mAreaText && s.fAreaText) add("area-text", "Select an area and copy its text", everywhere);
          if (s.mPageArea) add("page-area", "Select an area and search it", everywhere);
          if (s.mPageSearch) add("page-search", "Search this page (screenshot)", ["page", "frame"]);
          if (s.mScroll) add("page-scroll", "Capture the whole page (scrolling) → AI Mode", ["page", "frame"]);
          if (s.mSelection) add("selection-ai", "Ask Google AI Mode about “%s”", ["selection"]);
          resolve();
        });
      }),
    () => {}
  );
  return menuBuild;
}

const MENU_KEYS = ["mImageText", "mImageLens", "mAreaText", "mPageArea", "mPageSearch", "mScroll", "mSelection", "fAreaText"];
let lastMenuState = "";
settingsListeners.push((s) => {
  const state = MENU_KEYS.map((k) => (s[k] ? 1 : 0)).join("");
  if (state !== lastMenuState) {
    lastMenuState = state;
    rebuildMenus();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await settingsReady;
  lastMenuState = MENU_KEYS.map((k) => (currentSettings()[k] ? 1 : 0)).join("");
  rebuildMenus();
  log("extension installed/updated", { version: chrome.runtime.getManifest().version });
});
chrome.runtime.onStartup.addListener(async () => {
  await settingsReady;
  lastMenuState = MENU_KEYS.map((k) => (currentSettings()[k] ? 1 : 0)).join("");
  rebuildMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = info.menuItemId;
  const s = currentSettings();
  log("context menu clicked", { id });
  if (!tab || tab.id == null) return;

  if (id === "img-text" && info.srcUrl) {
    const panelOpen = openPanelIf(tab, wantsPanel(s, "text")); // FIRST, no await before it
    startImageTask({ url: info.srcUrl }, tab, panelOpen, { type: "text", via: "image menu" }).then((res) => {
      if (!res.ok) toastTab(tab.id, "Couldn't read that image: " + res.error, "error");
    });
  } else if (id === "img-lens" && info.srcUrl) {
    searchImageUrl(info.srcUrl);
  } else if (id === "area-text") {
    startAreaSelection(tab, { type: "text", via: "area text (menu)" });
  } else if (id === "page-area") {
    startAreaSelection(tab, { type: "search", via: "area (menu)" });
  } else if (id === "page-search") {
    searchFullScreen(tab, { type: "search", via: "screenshot (menu)" });
  } else if (id === "page-scroll") {
    startScrollCapture(tab, { type: "search", via: "whole page (menu)" });
  } else if (id === "selection-ai" && info.selectionText) {
    const panelOpen = openPanelIf(tab, wantsPanel(s, "open")); // FIRST
    const text = String(info.selectionText).trim().slice(0, 1800);
    openAiWithPrompt((s.selectionPrefix || "") + text, tab, panelOpen, "selected text", "selection");
  }
});

// ---------- keyboard shortcuts ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

chrome.commands.onCommand.addListener(async (command, tab0) => {
  const s = currentSettings();
  let tab = tab0;
  log("command received", { command, tabId: tab && tab.id });

  // These two must open the side panel inside the key press: FIRST, no await before it.
  if (command === "open_ai_mode") {
    const panelOpen = openPanelIf(tab, wantsPanel(s, "open"));
    openAiWithPrompt(s.defaultPrompt, tab, panelOpen, "shortcut: open AI Mode", "default");
    return;
  }
  if (command === "search_screen" && tab && tab.id != null) {
    searchFullScreen(tab, { type: "search", via: "screenshot (shortcut)" });
    return;
  }
  if (!tab || tab.id == null) tab = await activeTab();
  if (!tab || tab.id == null) {
    log("command ignored: no active tab");
    return;
  }
  if (command === "search_screen") searchFullScreen(tab, { type: "search", via: "screenshot (shortcut)" });
  else if (command === "search_area") startAreaSelection(tab, { type: "search", via: "area (shortcut)" });
  else if (command === "copy_area_text") {
    if (!s.fAreaText) {
      flashBadge("off", "#5f6368");
      toastTab(tab.id, "“Select an area → copy its text” is switched off in the settings.", "error");
      return;
    }
    startAreaSelection(tab, { type: "text", via: "area text (shortcut)" });
  } else if (command === "scroll_capture") startScrollCapture(tab, { type: "search", via: "whole page (shortcut)" });
});

// ---------- messages ----------

function reply(promise, sendResponse) {
  Promise.resolve(promise).then(sendResponse, (e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return false; // for the offscreen page
  const tab = sender.tab;

  switch (msg.action) {
    // ----- debug log lines from every other part of the extension -----
    case "log":
      if (msg.entry && typeof msg.entry.msg === "string") tkLogWrite({ ts: Number(msg.entry.ts) || Date.now(), tag: String(msg.entry.tag || "?").slice(0, 30), msg: msg.entry.msg.slice(0, 300), data: typeof msg.entry.data === "string" ? msg.entry.data.slice(0, 4000) : undefined });
      return false;

    // ----- the hover button -----
    case "startImageTask": {
      const s = currentSettings();
      const want = typeof msg.wantPanel === "boolean" ? msg.wantPanel : wantsPanel(s, "text");
      const panelOpen = openPanelIf(tab, want); // FIRST, no await before it
      return reply(startImageTask(msg.source, tab, panelOpen, { type: "text", via: "hover button" }), sendResponse);
    }

    // ----- the area overlay -----
    case "areaSelected":
      if (tab && tab.id != null) onAreaSelected(msg, sender);
      return false;
    case "areaSelectionCancelled":
      if (tab) pendingCaptures.delete(tab.id);
      log("area selection cancelled");
      return false;

    // ----- the page asked us to do something (scroll-capture offer) -----
    case "offerAccepted":
      return reply(onOfferAccepted(msg, sender), sendResponse);

    // ----- the Google page (ai-task.js) -----
    case "getTask":
      return reply(
        (async () => {
          const key = keyFor(msg, sender);
          const task = await getTask(key);
          if (!task || task.stage === "choose") return null;
          if (msg.panel && !task.claimed) await updateTask(key, { claimed: true }, task.id); // "the page inside is alive"
          return task;
        })(),
        sendResponse
      );
    case "taskUpdate":
      return reply(updateTask(keyFor(msg, sender), msg.patch || {}, msg.id), sendResponse);
    case "taskDone":
      return reply(removeTask(keyFor(msg, sender), msg.id).then(() => true), sendResponse);
    case "taskResult":
      return reply(handleTaskResult(keyFor(msg, sender), msg), sendResponse);
    case "notifySource":
      return reply(
        (async () => {
          const task = await getTask(keyFor(msg, sender));
          if (!task) return { ok: false };
          await toastTab(task.sourceTabId, msg.message || "Done", msg.kind);
          return { ok: true };
        })(),
        sendResponse
      );
    case "returnToSource":
      return reply(returnToSource(keyFor(msg, sender), tab && tab.id, msg.message || "Text copied ✓"), sendResponse);
    case "panelFallback":
      return reply(moveTaskToTab(msg.id, msg.reason || "requested"), sendResponse);
    case "recordPrompt": {
      // A prompt you typed yourself in AI Mode (best effort; only real key presses / clicks count).
      const s = currentSettings();
      if (s.fHistory && msg.text) TK.recordPrompt(String(msg.text).slice(0, 4000), "typed", msg.via || "typed in AI Mode").catch(() => {});
      return false;
    }
    case "bubbleCopied": {
      const s = currentSettings();
      if (s.fCopyHistory && msg.text) TK.recordCopy(String(msg.text), { engine: msg.engine || "", via: "preview" }).catch(() => {});
      return false;
    }

    // ----- the side panel -----
    case "taskChoose":
      return reply(chooseForTask(msg.id, msg.choice), sendResponse);
    case "taskCancel":
      return reply(removeTask(PANEL_KEY, msg.id).then(() => ({ ok: true })), sendResponse);
    case "panelCapture":
      return reply(panelCapture(msg.purpose, msg.windowId), sendResponse);

    // ----- the popup -----
    case "popupAction":
      return reply(popupAction(msg), sendResponse);

    // ----- Lens follow-up (lens-follow.js) -----
    case "lensTaskGet":
      return reply(tab ? getLensTaskFor(tab.id) : null, sendResponse);
    case "lensTaskUpdate":
      if (tab) updateLensTask(tab.id, msg.stage);
      return false;
    case "lensTaskDone":
      chrome.storage.local.remove("lensTask");
      return false;
  }
  return false; // anything else (e.g. "copyText" for the side panel page) is not ours
});

// New-tab mode, after the text is copied: go back to the page you started from and close the AI tab.
async function returnToSource(key, aiTabId, message) {
  const task = await getTask(key);
  if (!task || task.sourceTabId == null) return { ok: false, reason: "no source tab" };
  try {
    await chrome.tabs.update(task.sourceTabId, { active: true });
    if (task.sourceWindowId != null) await chrome.windows.update(task.sourceWindowId, { focused: true });
  } catch (e) {
    log("returnToSource: source tab is gone, staying on the AI tab", { message: e.message });
    return { ok: false, reason: "source tab gone" };
  }
  toastTab(task.sourceTabId, message);
  await chrome.tabs.remove(aiTabId).catch(() => {});
  return { ok: true };
}

// ---------- the popup's buttons ----------
// msg: { purpose, expectPanel }. The popup opens the side panel itself (inside its own click) for
// the actions that need it, and says so with expectPanel.

async function popupAction(msg) {
  const tab = await activeTab();
  if (!tab || tab.id == null) return { ok: false, error: "no active tab" };
  const s = currentSettings();
  const expectPanel = !!msg.expectPanel;
  switch (msg.purpose) {
    case "screen":
      searchFullScreen(tab, { type: "search", via: "screenshot (popup)", expectPanel });
      break;
    case "area":
      await startAreaSelection(tab, { type: "search", via: "area (popup)" });
      break;
    case "areaText":
      if (!s.fAreaText) return { ok: false, error: "switched off in the settings" };
      await startAreaSelection(tab, { type: "text", via: "area text (popup)" });
      break;
    case "scroll":
      startScrollCapture(tab, { type: "search", via: "whole page (popup)" });
      break;
    case "openAi":
      openAiWithPrompt(s.defaultPrompt, tab, Promise.resolve(false), "popup: open AI Mode", "default", expectPanel).catch(() => {});
      break;
    case "selfTest":
      runSelfTest(tab, Promise.resolve(false), expectPanel).catch((e) => log("self-test could not start", { message: e.message }));
      break;
    default:
      return { ok: false, error: "unknown action" };
  }
  return { ok: true };
}
