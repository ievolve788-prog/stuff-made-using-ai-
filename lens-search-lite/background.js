// background.js — the extension's service worker.
// Everything here is plain, readable code on purpose: this is YOUR extension,
// you should be able to read every line and know exactly what it does.
//
// DEBUGGING: every important step calls logEvent(...) which appends to
// chrome.storage.local under the key "debugLog". Open the popup and click
// "Copy debug log" after reproducing a problem, then paste it wherever
// you need to share it.

const LENS_URL = "https://www.google.com/?olud";

// tabId -> full-page screenshot (dataURL) captured just before the
// area-selection overlay was shown, so the overlay itself never ends up
// inside the screenshot.
const pendingCaptures = new Map();

// ---------- debug logging ----------

async function logEvent(msg, data) {
  try {
    const entry = { ts: Date.now(), tag: "background", msg, data: safeStringify(data) };
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    debugLog.push(entry);
    while (debugLog.length > 150) debugLog.shift();
    await chrome.storage.local.set({ debugLog });
  } catch (e) {
    // logging must never break the actual feature
  }
}

function safeStringify(data) {
  if (data === undefined) return undefined;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

// ---------- helpers ----------

function base64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function dataUrlToBase64(dataUrl) {
  const res = await fetch(dataUrl);
  const buf = await res.arrayBuffer();
  return base64FromArrayBuffer(buf);
}

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color: color || "#4285F4" });
  chrome.action.setBadgeText({ text });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// ---------- settings (see options.html) ----------

// searchDestination: where Alt+Shift+L / Alt+Shift+A (and the popup buttons)
// send the screenshot — "aimode" (straight into AI Mode with your prompt)
// or "lens" (the normal Google Lens results page).
// openIn: where AI Mode opens — "sidepanel" (Chrome's side panel, falls back to
// a tab by itself if Google can't be shown there) or "tab" (a new tab).
// autoSend: in AI Mode, press Send for you once image + prompt are in place.
// autoAiMode: (Lens destination only) click "AI Mode" after a Lens search.
const DEFAULT_SETTINGS = {
  defaultPrompt: "",
  searchDestination: "aimode",
  openIn: "sidepanel",
  autoSend: true,
  autoAiMode: false
};

async function getSettings() {
  // Passing an object makes storage fill in the defaults for any missing key.
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

// A copy of the settings kept in memory. Opening the side panel has to happen
// synchronously inside the key press / click (a browser rule), so there is no
// time to wait for storage. Until the copy has loaded (the worker has just
// woken up) the defaults are used; if that guess turns out wrong the panel is
// simply closed again (see closePanel).
let settingsCache = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;
chrome.storage.local.get(DEFAULT_SETTINGS).then(
  (s) => {
    settingsCache = s;
    settingsLoaded = true;
  },
  () => {}
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in changes) settingsCache[k] = changes[k].newValue;
});
const currentSettings = () => (settingsLoaded ? settingsCache : DEFAULT_SETTINGS);

// ---------- letting Google AI Mode be shown inside our side panel ----------
//
// Google normally refuses to be framed (X-Frame-Options / CSP frame-ancestors).
// These two rules remove those headers ONLY for AI Mode pages, and ONLY when the
// frame is started by this extension's own page (rule 1) or is navigating
// inside such a frame (rule 2). Nothing changes for normal browsing.

const RULE_FIRST_LOAD = 9001;
const RULE_INSIDE_FRAME = 9002;
const AI_URL_REGEX = "^https://www\\.google\\.com/(ai|aimode|search\\?[^#]*udm=50)";
const STRIP = [
  { header: "x-frame-options", operation: "remove" },
  { header: "content-security-policy", operation: "remove" },
  { header: "content-security-policy-report-only", operation: "remove" }
];

async function installFrameRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_FIRST_LOAD, RULE_INSIDE_FRAME],
      addRules: [
        {
          id: RULE_FIRST_LOAD,
          priority: 1,
          action: { type: "modifyHeaders", responseHeaders: STRIP },
          condition: { regexFilter: AI_URL_REGEX, resourceTypes: ["sub_frame"], initiatorDomains: [chrome.runtime.id] }
        },
        {
          id: RULE_INSIDE_FRAME,
          priority: 1,
          action: { type: "modifyHeaders", responseHeaders: STRIP },
          condition: { regexFilter: AI_URL_REGEX, resourceTypes: ["sub_frame"], initiatorDomains: ["www.google.com"] }
        }
      ]
    });
  } catch (e) {
    logEvent("could not install the frame rules (side panel may not work)", { message: e.message });
  }
}
installFrameRules(); // session rules vanish when the browser closes, so redo on every worker start

// ---------- the side panel ----------

// chrome.sidePanel.open() only works inside a user action (key press, click,
// the mouse-up that ends an area selection) and only if it is called straight
// away — before any "await". So callers invoke this FIRST and hand the
// resulting promise on.
function tryOpenPanel(tabId) {
  if (!chrome.sidePanel || !chrome.sidePanel.open || tabId == null || tabId < 0) return Promise.resolve(false);
  let p;
  try {
    p = chrome.sidePanel.open({ tabId });
  } catch (e) {
    logEvent("sidePanel.open threw", { message: e.message });
    return Promise.resolve(false);
  }
  return Promise.resolve(p).then(
    () => true,
    (e) => {
      logEvent("sidePanel.open refused", { message: e && e.message });
      return false;
    }
  );
}

// For the screenshot searches: only worth opening if they will end up in AI Mode.
function maybeOpenPanel(tabId) {
  const s = currentSettings();
  return s.openIn === "sidepanel" && s.searchDestination === "aimode" ? tryOpenPanel(tabId) : Promise.resolve(false);
}

async function isPanelOpen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    return ctx.length > 0;
  } catch (e) {
    return false;
  }
}

// We opened the panel on a guess (settings not loaded yet) and it turned out
// the user wants a tab / Lens: close it again.
async function closePanel(tabId) {
  try {
    if (chrome.sidePanel.close) {
      await chrome.sidePanel.close({ tabId });
      return;
    }
  } catch (e) {}
  try {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
    await chrome.sidePanel.setOptions({ tabId, enabled: true, path: "sidepanel.html" });
  } catch (e) {
    logEvent("could not close the side panel again", { message: e.message });
  }
}

// ---------- AI Mode ----------

// Opens Google AI Mode — in the side panel or a new tab (setting "openIn").
// With a default prompt it uses google.com/search?udm=50&q=<prompt> (the prompt
// is sent immediately); without one it opens google.com/ai, Google's own short
// link to AI Mode.
async function openAiMode(tabId) {
  const panelOpen = currentSettings().openIn === "sidepanel" ? tryOpenPanel(tabId) : Promise.resolve(false); // FIRST, no await before it
  const s = await getSettings();
  const prompt = (s.defaultPrompt || "").trim();
  const url = prompt
    ? `https://www.google.com/search?udm=50&q=${encodeURIComponent(prompt)}`
    : "https://www.google.com/ai";
  logEvent("openAiMode", { hasPrompt: !!prompt, url, openIn: s.openIn });

  if (s.openIn === "sidepanel") {
    if ((await panelOpen) || (await isPanelOpen())) {
      await sessionStore.set({
        [DIRECT_TASK_KEY]: { id: newId(), mode: "open", panel: true, tabId: null, claimed: false, stage: "attach", url, ts: Date.now() }
      });
      return;
    }
    logEvent("side panel did not open, using a new tab instead");
  } else if (await panelOpen) {
    closePanel(tabId);
  }
  chrome.tabs.create({ url });
}

// Auto-click flow: after a Lens screenshot is handed to Google, leave a small
// "task" for that tab. ai-mode.js (running on the Lens results page) picks it
// up, clicks Google's "AI Mode" button, and types the default prompt if set.
async function startAiTaskIfEnabled(tabId) {
  const s = await getSettings();
  if (!s.autoAiMode) {
    logEvent("auto AI Mode is OFF in settings, skipping");
    return;
  }
  const prompt = (s.defaultPrompt || "").trim();
  // With a prompt: first type it into the Lens results page's search box (next
  // to your image), THEN click AI Mode. Without one: just click AI Mode.
  const task = { tabId, stage: prompt ? "type" : "click", prompt, ts: Date.now() };
  await chrome.storage.local.set({ aiTask: task });
  logEvent("AI task created", { tabId, startStage: task.stage, hasPrompt: !!prompt });
  // If ai-mode.js is already running in that tab, nudge it. A fresh page load
  // will instead find the task via "getAiTask" below.
  chrome.tabs.sendMessage(tabId, { action: "startAiTask", task }).catch(() => {});
}

// ---------- "direct to AI Mode" (screenshot + your prompt, no Lens page) ----------
//
// The screenshot is held in chrome.storage.session — memory only, never
// written to disk, wiped when the browser closes — because it is big and the
// AI Mode page may reload once (google.com/ai redirects) before ai-mode.js
// can use it. It is deleted as soon as the task finishes, the tab closes, or
// 90 seconds pass.
//
// There is ONE task slot. A task is either for a tab (task.tabId) or for the
// side panel (task.panel === true, no tab id: the page inside the panel isn't a tab).

const AI_MODE_URL = "https://www.google.com/ai";
const DIRECT_TASK_KEY = "aiDirectTask";
const DIRECT_LIFETIME_MS = 90000;
const sessionStore = chrome.storage.session || chrome.storage.local;

async function openAiModeWithImage(base64, panelOpen = Promise.resolve(false), sourceTabId) {
  const s = await getSettings();
  const prompt = (s.defaultPrompt || "").trim();
  logEvent("openAiModeWithImage", { bytes: base64.length, hasPrompt: !!prompt, autoSend: !!s.autoSend, openIn: s.openIn });
  const task = {
    id: newId(),
    mode: "direct",
    tabId: null,
    panel: false,
    claimed: false,
    stage: "attach",
    prompt,
    autoSend: !!s.autoSend && !!prompt, // no prompt -> never auto-send an image with no question
    image: base64,
    ts: Date.now()
  };

  // Side panel: only if it really opened (or is already open from an earlier try).
  if (s.openIn === "sidepanel") {
    if ((await panelOpen) || (await isPanelOpen())) {
      task.panel = true;
      try {
        await sessionStore.set({ [DIRECT_TASK_KEY]: task });
      } catch (e) {
        logEvent("openAiModeWithImage: could not store screenshot (too large?)", { message: e.message, bytes: base64.length });
        flashBadge("!", "#EA4335");
        return;
      }
      logEvent("direct AI task created (side panel)", { id: task.id, autoSend: task.autoSend });
      flashBadge("");
      return;
    }
    logEvent("side panel did not open, using a new tab instead");
  } else if (await panelOpen) {
    closePanel(sourceTabId); // opened on a guess, but the user wants a tab
  }

  chrome.tabs.create({ url: AI_MODE_URL }, async (tab) => {
    if (chrome.runtime.lastError || !tab) {
      logEvent("openAiModeWithImage: tab creation failed", { error: chrome.runtime.lastError?.message });
      flashBadge("!", "#EA4335");
      return;
    }
    task.tabId = tab.id;
    try {
      await sessionStore.set({ [DIRECT_TASK_KEY]: task });
    } catch (e) {
      logEvent("openAiModeWithImage: could not store screenshot (too large?)", { message: e.message, bytes: base64.length });
      flashBadge("!", "#EA4335");
      return;
    }
    logEvent("direct AI task created", { tabId: tab.id, autoSend: task.autoSend });
    flashBadge("");
    // If ai-mode.js is already running in that tab, nudge it; otherwise it
    // finds the task itself via "getAiTask" when the page loads.
    chrome.tabs.sendMessage(tab.id, { action: "startAiTask", task }).catch(() => {});
  });
}

async function readDirectTask() {
  const got = await sessionStore.get(DIRECT_TASK_KEY);
  const task = got[DIRECT_TASK_KEY];
  if (task && Date.now() - task.ts > DIRECT_LIFETIME_MS) {
    await sessionStore.remove(DIRECT_TASK_KEY);
    return null;
  }
  return task || null;
}

// Tab mode: clear the task of that tab (or, with no tab id, whatever is there).
// Panel mode (panelId !== undefined): clear the side-panel task, if it is that one.
async function clearDirectTask(tabId, panelId) {
  const task = await readDirectTask();
  if (!task) return;
  if (panelId !== undefined) {
    if (task.panel && (!panelId || task.id === panelId)) await sessionStore.remove(DIRECT_TASK_KEY);
    return;
  }
  if (tabId == null || task.tabId === tabId) await sessionStore.remove(DIRECT_TASK_KEY);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearDirectTask(tabId);
});

// The side panel could not do it (Google not shown, image not attachable...):
// redo the same thing in a normal new tab.
async function moveTaskToTab(id) {
  const task = await readDirectTask();
  if (!task || !task.panel || (id && task.id !== id)) return { ok: false, reason: "no such side-panel task" };
  logEvent("side panel -> new tab", { mode: task.mode });
  if (task.mode === "open") {
    await sessionStore.remove(DIRECT_TASK_KEY);
    await chrome.tabs.create({ url: task.url });
    return { ok: true };
  }
  if (!task.image) return { ok: false, reason: "no screenshot left" };
  const tab = await chrome.tabs.create({ url: AI_MODE_URL });
  const moved = { ...task, panel: false, tabId: tab.id, claimed: false, ts: Date.now() };
  await sessionStore.set({ [DIRECT_TASK_KEY]: moved });
  chrome.tabs.sendMessage(tab.id, { action: "startAiTask", task: moved }).catch(() => {});
  return { ok: true, tabId: tab.id };
}

// Which destination to use for a finished screenshot.
async function deliverImage(base64, panelOpen = Promise.resolve(false), sourceTabId) {
  const { searchDestination } = await getSettings();
  logEvent("deliverImage", { destination: searchDestination, bytes: base64.length });
  if (searchDestination === "lens") {
    if (await panelOpen) closePanel(sourceTabId); // opened on a guess
    openLensWithScreenshot(base64);
  } else {
    openAiModeWithImage(base64, panelOpen, sourceTabId);
  }
}

// `panel` is true when the question comes from the page inside the side panel.
async function getAiTaskFor(tabId, panel) {
  const direct = await readDirectTask();
  if (direct && (panel ? direct.panel === true : direct.tabId === tabId)) {
    if (panel && !direct.claimed) {
      // Tells the side panel "the page inside is alive and has picked up the task".
      direct.claimed = true;
      await sessionStore.set({ [DIRECT_TASK_KEY]: direct });
    }
    return direct;
  }
  if (panel) return null;

  const { aiTask } = await chrome.storage.local.get("aiTask");
  if (!aiTask || aiTask.tabId !== tabId) return null;
  if (Date.now() - aiTask.ts > 60000) {
    await chrome.storage.local.remove("aiTask");
    return null;
  }
  return aiTask;
}

async function updateAiTaskStage(tabId, stage, panel) {
  const direct = await readDirectTask();
  if (direct && (panel ? direct.panel === true : direct.tabId === tabId)) {
    direct.stage = stage;
    await sessionStore.set({ [DIRECT_TASK_KEY]: direct });
    return;
  }
  if (panel) return;
  const task = await getAiTaskFor(tabId);
  if (task) {
    task.stage = stage;
    await chrome.storage.local.set({ aiTask: task });
  }
}

// ---------- context menus ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "lens-search-image",
      title: "Search image with Google Lens",
      contexts: ["image"]
    });
    chrome.contextMenus.create({
      id: "lens-search-screen",
      title: "Search this page with Google Lens",
      contexts: ["page"]
    });
  });
  logEvent("extension installed/updated");
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  logEvent("context menu clicked", { menuItemId: info.menuItemId });
  if (info.menuItemId === "lens-search-image" && info.srcUrl) {
    searchImageUrl(info.srcUrl);
  } else if (info.menuItemId === "lens-search-screen" && tab?.id) {
    searchFullScreen(tab.id);
  }
});

// ---------- keyboard shortcuts ----------

chrome.commands.onCommand.addListener((command, tab) => {
  logEvent("command received", { command, tabId: tab?.id, url: tab?.url });
  if (command === "open_ai_mode") {
    openAiMode(tab?.id);
    return;
  }
  if (!tab?.id) {
    logEvent("command ignored: no active tab id");
    return;
  }
  if (command === "search_screen") searchFullScreen(tab.id);
  if (command === "search_area") startAreaSelection(tab.id);
});

// ---------- messages from the popup and the on-page overlay ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // getAiTask fires on every google.com page load; logging it would bury the useful lines.
  if (msg.action !== "getAiTask") logEvent("message received", { action: msg.action, fromTab: sender.tab?.id });

  // The mouse-up that ends an area selection is the user action that lets us
  // open the side panel — so do it before anything else.
  const areaPanelOpen = msg.action === "areaSelected" && sender.tab?.id != null ? maybeOpenPanel(sender.tab.id) : null;

  // --- AI Mode ---
  if (msg.action === "openAiMode") {
    openAiMode(msg.tabId);
  }
  if (msg.action === "getAiTask") {
    getAiTaskFor(sender.tab?.id, msg.panel).then(sendResponse);
    return true; // async response
  }
  if (msg.action === "aiTaskUpdate" && (sender.tab?.id != null || msg.panel)) {
    updateAiTaskStage(sender.tab?.id, msg.stage, msg.panel);
  }
  if (msg.action === "aiTaskDone") {
    if (msg.panel) {
      clearDirectTask(undefined, msg.id || null); // only the side-panel task, never a tab's
    } else {
      chrome.storage.local.remove("aiTask");
      clearDirectTask(sender.tab?.id); // also drops the screenshot held for the direct flow
    }
  }
  if (msg.action === "panelFallback") {
    moveTaskToTab(msg.id).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "triggerSearchScreen" && msg.tabId) {
    searchFullScreen(msg.tabId);
  }
  if (msg.action === "triggerSearchArea" && msg.tabId) {
    startAreaSelection(msg.tabId);
  }
  if (msg.action === "areaSelected" && sender.tab?.id != null) {
    const dataUrl = pendingCaptures.get(sender.tab.id);
    pendingCaptures.delete(sender.tab.id);
    if (dataUrl) {
      cropAndSearch(dataUrl, msg.rect, msg.devicePixelRatio, areaPanelOpen, sender.tab.id);
    } else {
      logEvent("areaSelected received but no pending capture found for this tab", { tabId: sender.tab.id });
    }
  }
  if (msg.action === "areaSelectionCancelled" && sender.tab?.id != null) {
    logEvent("area selection cancelled by user");
    pendingCaptures.delete(sender.tab.id);
  }
  return false;
});

// ---------- the three ways to start a search ----------

// 1) We already have a direct image URL (right-click on an <img>) — simplest
// case, Google's own official redirect handles everything.
function searchImageUrl(imageUrl) {
  logEvent("searching by image URL", { imageUrl });
  const url = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  chrome.tabs.create({ url });
}

// 2) Full visible page — screenshot the tab, hand the image to Lens / AI Mode.
async function searchFullScreen(tabId) {
  logEvent("searchFullScreen: starting", { tabId });
  try {
    flashBadge("...");
    // Order matters. The screenshot is requested FIRST; only then is the side
    // panel opened (it narrows the page, which would change what is captured).
    // Both calls happen in the same tick because open() needs the user action.
    const shot = chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    const panelOpen = maybeOpenPanel(tabId);
    const dataUrl = await shot;
    logEvent("searchFullScreen: capture succeeded", { bytes: dataUrl.length });
    const base64 = await dataUrlToBase64(dataUrl);
    deliverImage(base64, panelOpen, tabId);
  } catch (e) {
    logEvent("searchFullScreen: ERROR", { message: e.message, stack: e.stack });
    flashBadge("!", "#EA4335");
  }
}

// 3) A specific area — capture first (before any overlay is drawn), then
// let the user drag out a rectangle, then crop to just that rectangle.
// (The side panel opens only AFTER the drag, so the screenshot is of the page
// exactly as you saw it.)
async function startAreaSelection(tabId) {
  logEvent("startAreaSelection: starting", { tabId });
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    logEvent("startAreaSelection: capture succeeded", { bytes: dataUrl.length });
    pendingCaptures.set(tabId, dataUrl);
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["area-select.css"] });
    logEvent("startAreaSelection: CSS injected");
    await chrome.scripting.executeScript({ target: { tabId }, files: ["area-select.js"] });
    logEvent("startAreaSelection: overlay script injected");
  } catch (e) {
    logEvent("startAreaSelection: ERROR", { message: e.message, stack: e.stack });
    flashBadge("!", "#EA4335");
  }
}

async function cropAndSearch(dataUrl, rect, dpr, panelOpen = Promise.resolve(false), sourceTabId) {
  logEvent("cropAndSearch: starting", { rect, dpr });
  try {
    flashBadge("...");
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);
    logEvent("cropAndSearch: crop region", { sx, sy, sw, sh, bitmapW: bitmap.width, bitmapH: bitmap.height });

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

    const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
    const buf = await croppedBlob.arrayBuffer();
    const base64 = base64FromArrayBuffer(buf);
    logEvent("cropAndSearch: crop succeeded", { bytes: base64.length });
    deliverImage(base64, panelOpen, sourceTabId);
  } catch (e) {
    logEvent("cropAndSearch: ERROR", { message: e.message, stack: e.stack });
    flashBadge("!", "#EA4335");
  }
}

// ---------- getting the image into Google's own Lens page ----------
// This opens the real lens.google.com and simulates dropping the file onto
// its own upload zone — the same thing you'd do by hand. See lens-inject.js.

function openLensWithScreenshot(base64) {
  logEvent("openLensWithScreenshot: opening tab", { bytes: base64.length });
  chrome.tabs.create({ url: LENS_URL }, (newTab) => {
    logEvent("openLensWithScreenshot: tab created", { tabId: newTab.id });
    waitForLensAndSend(newTab.id, base64);
  });
}

function waitForLensAndSend(tabId, base64, attempt = 1, maxAttempts = 25) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      logEvent("waitForLensAndSend: tab disappeared", { error: chrome.runtime.lastError?.message });
      return;
    }
    if (tab.status !== "complete") {
      logEvent("waitForLensAndSend: tab still loading", { attempt, status: tab.status, url: tab.url });
      setTimeout(() => waitForLensAndSend(tabId, base64, attempt, maxAttempts), 300);
      return;
    }
    if (!tab.url || !tab.url.startsWith("https://www.google.com")) {
      logEvent("waitForLensAndSend: tab is NOT on google.com — likely redirected somewhere else", { attempt, url: tab.url });
    }
    chrome.tabs
      .sendMessage(tabId, { action: "checkLensReady" })
      .then((response) => {
        logEvent("waitForLensAndSend: checkLensReady response", { attempt, response });
        if (response?.ready) {
          chrome.tabs.sendMessage(tabId, { action: "searchScreenshot", screenshot: base64 }).then((r) => {
            logEvent("waitForLensAndSend: searchScreenshot sent, response", { response: r });
          });
          flashBadge("");
          startAiTaskIfEnabled(tabId);
        } else {
          throw new Error("not ready yet, ready=" + response?.ready);
        }
      })
      .catch((e) => {
        if (attempt < maxAttempts) {
          setTimeout(() => waitForLensAndSend(tabId, base64, attempt + 1, maxAttempts), 300);
        } else {
          logEvent("waitForLensAndSend: GAVE UP after max attempts", { message: e.message });
          flashBadge("!", "#EA4335");
        }
      });
  });
}
