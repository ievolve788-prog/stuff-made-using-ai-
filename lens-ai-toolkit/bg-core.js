// bg-core.js — shared plumbing of the service worker: settings copy, the header rules that
// let Google AI Mode show inside the side panel, the side panel itself, and the short-lived
// "task" store. (background.js loads this with importScripts.)

const log = (msg, data) => tkLog("background", msg, data);

const AI_MODE_URL = "https://www.google.com/ai";
const GEMINI_URL = "https://gemini.google.com/app";
const LENS_URL = "https://www.google.com/?olud";
const PANEL_KEY = "tk:panel"; // the single side-panel task
const TAB_PREFIX = "tk:tab:"; // + tab id (new-tab mode)
const TASK_LIFETIME_MS = 240000;
const sessionStore = chrome.storage.session || chrome.storage.local;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// ---------- settings (cached: the side panel must be opened without waiting for storage) ----------

let settingsCache = { ...TK.DEFAULTS };
let settingsLoaded = false;
const settingsReady = chrome.storage.local.get(TK.DEFAULTS).then(
  (s) => {
    settingsCache = s;
    settingsLoaded = true;
  },
  () => {}
);
const settingsListeners = [];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const k of Object.keys(TK.DEFAULTS)) {
    if (k in changes) {
      settingsCache[k] = "newValue" in changes[k] ? changes[k].newValue : TK.DEFAULTS[k];
      touched = true;
    }
  }
  if (touched) settingsListeners.forEach((fn) => fn(settingsCache));
});
const currentSettings = () => settingsCache;
const getSettings = () => TK.getSettings();
const aiHome = (s) => (s.useGemini ? GEMINI_URL : AI_MODE_URL);

// Will this action end in the side panel? (Decided from the cached settings, synchronously.)
//   kind: "text" (copy-text actions) or "search" (screenshot / area / selection / open AI Mode)
function wantsPanel(s, kind) {
  if (s.openIn !== "sidepanel") return false;
  if (kind === "text" && s.ocrEngine !== "ai") return false; // local / auto: no Google needed (auto opens a tab if it must)
  if (kind === "search" && s.searchDestination === "lens") return false;
  return true; // "open" (selection, plain AI Mode) only depends on openIn
}

// ---------- letting Google AI Mode / Gemini be shown inside our side panel ----------
//
// Google normally refuses to be framed (X-Frame-Options / CSP frame-ancestors). These two
// rules remove those headers ONLY for AI Mode / Gemini pages, and ONLY when the frame is
// started by this extension's own page (rule 1) or is navigating inside such a frame
// (rule 2). Nothing changes for normal browsing.

const RULE_FIRST_LOAD = 9001;
const RULE_INSIDE_FRAME = 9002;
const AI_URL_REGEX = "^https://(www\\.google\\.com/(ai|aimode|search\\?[^#]*udm=50)|gemini\\.google\\.com/)";
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
          condition: { regexFilter: AI_URL_REGEX, resourceTypes: ["sub_frame"], initiatorDomains: ["www.google.com", "gemini.google.com"] }
        }
      ]
    });
  } catch (e) {
    log("could not install the frame rules (side panel may not work)", { message: e.message });
  }
}
installFrameRules(); // session rules vanish when the browser closes, so redo on every worker start

// ---------- the side panel ----------

// chrome.sidePanel.open() only works inside a user action (click, key press, menu click, the
// mouse-up that ends an area selection) AND only if it is called straight away, before any
// "await". So callers invoke this FIRST and hand the resulting promise on.
function tryOpenPanel(tab) {
  if (!chrome.sidePanel || !chrome.sidePanel.open || !tab || tab.id == null || tab.id < 0) return Promise.resolve(false);
  let p;
  try {
    p = chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    log("sidePanel.open threw", { message: e.message });
    return Promise.resolve(false);
  }
  return Promise.resolve(p).then(
    () => true,
    (e) => {
      log("sidePanel.open refused", { message: e && e.message });
      return false;
    }
  );
}

const openPanelIf = (tab, want) => (want ? tryOpenPanel(tab) : Promise.resolve(false));

// We opened the panel on a guess (or a stale hint) and it turned out it isn't wanted: close it again.
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
    log("could not close the side panel again", { message: e.message });
  }
}

async function isPanelOpen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    return ctx.length > 0;
  } catch (e) {
    return false;
  }
}

// ---------- the task store (chrome.storage.session: browser memory, never on disk) ----------

async function getTask(key) {
  if (!key) return null;
  const got = await sessionStore.get(key);
  const task = got[key];
  if (!task) return null;
  if (Date.now() - task.updated > TASK_LIFETIME_MS) {
    await sessionStore.remove(key);
    return null;
  }
  return task;
}

const PATCHABLE = ["stage", "image", "claimed", "prompt", "kind", "label", "presetId", "autoSend", "url", "engine", "preview"];

// `id` (when given) must match the stored task, so a slow old page can never change or delete
// a newer task that replaced it.
async function updateTask(key, patch, id) {
  const task = await getTask(key);
  if (!task || (id && task.id !== id)) return false;
  const allowed = {};
  for (const k of PATCHABLE) if (k in patch) allowed[k] = patch[k];
  await sessionStore.set({ [key]: { ...task, ...allowed, updated: Date.now() } });
  return true;
}

async function removeTask(key, id) {
  if (!key) return;
  if (id) {
    const got = await sessionStore.get(key);
    if (got[key] && got[key].id !== id) return;
  }
  await sessionStore.remove(key);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTask(TAB_PREFIX + tabId);
});

// Which stored task does a message belong to? Pages inside the side panel say so with
// panel:true; everything else is keyed by the tab it came from.
function keyFor(msg, sender) {
  if (msg.panel) return PANEL_KEY;
  const tab = sender && sender.tab;
  return tab && tab.id != null && tab.id >= 0 ? TAB_PREFIX + tab.id : null;
}

// ---------- telling the page you came from ----------

function toastTab(tabId, text, kind) {
  if (tabId == null) return Promise.resolve();
  return Promise.resolve(chrome.tabs.sendMessage(tabId, { action: "toast", text, kind: kind || "ok" }, { frameId: 0 })).catch(() => {});
}

function bubbleTab(tabId, payload) {
  if (tabId == null) return Promise.resolve(false);
  return Promise.resolve(chrome.tabs.sendMessage(tabId, { action: "bubble", ...payload }, { frameId: 0 })).then(
    () => true,
    () => false
  );
}

let badgeTimer = null;
function flashBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || "#1a73e8" });
    chrome.action.setBadgeText({ text });
    clearTimeout(badgeTimer);
    if (text) badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
  } catch (e) {}
}

// Hide / show our own on-page UI (hover button, notes) so it can't end up in a screenshot of the page.
async function pageUi(tabId, visible) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: visible ? "showUi" : "hideUi" }, { frameId: 0 });
  } catch (e) {} // no content script on this page (chrome:// ...): nothing to hide
}

async function captureClean(tab) {
  await pageUi(tab.id, false);
  await new Promise((r) => setTimeout(r, 70)); // let the page repaint without it
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } finally {
    pageUi(tab.id, true);
  }
}
