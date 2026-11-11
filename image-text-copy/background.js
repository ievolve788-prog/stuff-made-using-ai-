// background.js — the extension's service worker.
//
// Job: when you click the hover button (or the right-click menu item) this
//   1. gets the image bytes (fetch the URL, or crop a screenshot as a fallback),
//   2. opens Google AI Mode — in Chrome's side panel (default) or in a new tab —
//      and leaves a short-lived "task" for it (the image + your prompt),
//   3. later, when ai-task.js has copied the text, tells the page you came from
//      ("copied ✓") and, in new-tab mode, optionally takes you back to it.
//
// If the side panel cannot show Google AI Mode (Google refuses to be framed, the
// content script never checks in, the image can't be attached...) the task is
// moved to a normal new tab instead, so the feature never just silently dies.
//
// The image is kept in chrome.storage.session: browser memory only, never
// written to disk, wiped when the browser closes. It is deleted as soon as it
// has been sent to AI Mode, when the tab closes, or after 4 minutes.

importScripts("log.js", "defaults.js");
const log = (msg, data) => itcLog("background", msg, data);

const AI_MODE_URL = "https://www.google.com/ai";
const TASK_PREFIX = "imgTask:"; // + tab id  (new-tab mode)
const PANEL_KEY = "imgTask:panel"; // the single side-panel task
const TASK_LIFETIME_MS = 240000;
const MAX_BYTES = 6000000; // bigger images are re-encoded smaller (session storage is capped)
const MAX_SIDE = 3000; // longest side after re-encoding
const MAX_DOWNLOAD = 30000000;
const MENU_ID = "itc-copy-image-text";
const sessionStore = chrome.storage.session || chrome.storage.local;

// ---------- settings (cached, because opening the side panel must happen synchronously) ----------

let settingsCache = { ...ITC_DEFAULTS };
let settingsLoaded = false;
const settingsReady = chrome.storage.local.get(ITC_DEFAULTS).then(
  (s) => {
    settingsCache = s;
    settingsLoaded = true;
  },
  () => {}
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(ITC_DEFAULTS)) if (k in changes) settingsCache[k] = changes[k].newValue;
});

async function getSettings() {
  return chrome.storage.local.get(ITC_DEFAULTS);
}

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
    log("could not install the frame rules (side panel may not work)", { message: e.message });
  }
}
installFrameRules(); // session rules vanish when the browser closes, so redo on every worker start

// ---------- bytes <-> base64 ----------

function b64FromBytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function blobFromB64(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

async function describe(blob, mime, name) {
  return { base64: b64FromBytes(new Uint8Array(await blob.arrayBuffer())), mime, name };
}

// ---------- getting a usable image ----------

// PNG / JPEG / WebP under the size cap go through untouched. Anything else
// (GIF, AVIF, BMP...) or anything huge is redrawn as a PNG (JPEG if still big),
// scaled down so the longest side is at most MAX_SIDE. SVG and unreadable data
// make createImageBitmap throw — the caller then falls back to a screenshot crop.
async function normalizeBlob(blob) {
  const type = (blob.type || "").toLowerCase();
  if (["image/png", "image/jpeg", "image/webp"].includes(type) && blob.size <= MAX_BYTES) {
    return describe(blob, type, "image." + (type === "image/jpeg" ? "jpg" : type.split("/")[1]));
  }
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // transparent areas would otherwise turn black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  let out = await canvas.convertToBlob({ type: "image/png" });
  if (out.size > MAX_BYTES) {
    out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    return describe(out, "image/jpeg", "image.jpg");
  }
  return describe(out, "image/png", "image.png");
}

async function fetchBlob(url) {
  if (!/^(https?|data):/i.test(url)) throw new Error("unsupported image address");
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("download failed (HTTP " + res.status + ")");
  const blob = await res.blob();
  if (blob.size > MAX_DOWNLOAD) throw new Error("image too large");
  return blob;
}

// Fallback for images we cannot download (hotlink-protected, CSS-only, canvas...):
// screenshot the tab and cut out the image's rectangle (CSS px -> device px).
async function captureCrop(tab, { rect, dpr }) {
  if (!tab) throw new Error("no tab to capture");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const sx = Math.min(Math.max(0, Math.round(rect.x * dpr)), bmp.width - 1);
  const sy = Math.min(Math.max(0, Math.round(rect.y * dpr)), bmp.height - 1);
  const sw = Math.max(1, Math.min(Math.round(rect.width * dpr), bmp.width - sx));
  const sh = Math.max(1, Math.min(Math.round(rect.height * dpr), bmp.height - sy));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  return normalizeBlob(await canvas.convertToBlob({ type: "image/png" }));
}

async function prepareImage(source, tab) {
  if (source.capture) return captureCrop(tab, source.capture);
  if (source.base64) return normalizeBlob(blobFromB64(source.base64, source.mime));
  if (source.url) return normalizeBlob(await fetchBlob(source.url));
  throw new Error("no image source");
}

// ---------- the side panel ----------

// chrome.sidePanel.open() only works inside a user action. The message from the
// hover button (and the context-menu click) count as one, but only if open() is
// called straight away - before any "await". So callers invoke this FIRST and
// hand the resulting promise on.
function tryOpenPanel(tab) {
  if (!chrome.sidePanel || !chrome.sidePanel.open || !tab || tab.id == null || tab.id < 0) {
    return Promise.resolve(false);
  }
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

// hint = the content script's cached "openIn" setting (known without waiting).
function maybeOpenPanel(tab, hint) {
  const want = (mode) => (mode === "sidepanel" ? tryOpenPanel(tab) : Promise.resolve(false));
  if (hint === "sidepanel" || hint === "tab") return want(hint);
  if (settingsLoaded) return want(settingsCache.openIn);
  // Settings not read yet (worker just woke up): wait. The click gesture may be gone by
  // then, in which case open() is refused and we simply use a normal tab.
  return settingsReady.then(() => want(settingsCache.openIn));
}

async function isPanelOpen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    return ctx.length > 0;
  } catch (e) {
    return false;
  }
}

// ---------- the AI Mode task ----------

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

async function startImageTask(source, tab, panelOpen = Promise.resolve(false)) {
  const kind = source.capture ? "screenshot-crop" : source.base64 ? "bytes-from-page" : "url";
  log("startImageTask", { kind, url: source.url ? source.url.slice(0, 200) : undefined, fromTab: tab && tab.id });

  let image;
  try {
    image = await prepareImage(source, tab);
  } catch (e) {
    log("could not get the image", { kind, message: e.message });
    return { ok: false, error: e.message, canCapture: !source.capture };
  }

  const s = await getSettings();
  const prompt = (s.prompt || "").trim() || ITC_DEFAULTS.prompt;
  const task = {
    id: newId(),
    tabId: null,
    panel: false,
    stage: "attach",
    claimed: false,
    image: image.base64,
    mime: image.mime,
    name: image.name,
    prompt,
    autoSend: !!s.autoSend,
    afterCopy: s.afterCopy,
    sourceTabId: tab ? tab.id : null,
    sourceWindowId: tab ? tab.windowId : null,
    updated: Date.now()
  };

  // Side panel: only if the panel really opened (or is already open from an earlier click).
  if (s.openIn === "sidepanel") {
    const opened = (await panelOpen) || (await isPanelOpen());
    if (opened) {
      task.panel = true;
      try {
        await sessionStore.set({ [PANEL_KEY]: task });
      } catch (e) {
        log("could not store the image (too large?)", { message: e.message, bytes: image.base64.length });
        return { ok: false, error: "could not hold the image in memory", canCapture: !source.capture };
      }
      log("side-panel task created", { id: task.id, kind, mime: image.mime, bytes: image.base64.length, autoSend: task.autoSend });
      return { ok: true, where: "sidepanel" };
    }
    log("side panel did not open, using a new tab instead");
  }

  const res = await openInTab(task, tab);
  if (!res.ok) return { ...res, canCapture: !source.capture };
  log("new-tab task created", { aiTab: res.tabId, kind, mime: image.mime, bytes: image.base64.length, autoSend: task.autoSend });
  return { ok: true, where: "tab" };
}

// Create the AI Mode tab next to the source tab and leave the task for it.
async function openInTab(task, tab) {
  const props = { url: AI_MODE_URL };
  if (tab && tab.id != null && tab.id >= 0) {
    props.openerTabId = tab.id; // Chrome returns you to the source tab when this one closes
    if (typeof tab.index === "number") props.index = tab.index + 1;
    if (tab.windowId != null) props.windowId = tab.windowId;
  } else if (task.sourceWindowId != null) {
    props.windowId = task.sourceWindowId;
  }
  let aiTab;
  try {
    aiTab = await chrome.tabs.create(props);
  } catch (e) {
    log("tabs.create with position failed, retrying plainly", { message: e.message });
    aiTab = await chrome.tabs.create({ url: AI_MODE_URL });
  }
  const stored = { ...task, tabId: aiTab.id, panel: false, claimed: false, updated: Date.now() };
  try {
    await sessionStore.set({ [TASK_PREFIX + aiTab.id]: stored });
  } catch (e) {
    log("could not store the image (too large?)", { message: e.message, bytes: (task.image || "").length });
    chrome.tabs.remove(aiTab.id).catch(() => {});
    return { ok: false, error: "could not hold the image in memory" };
  }
  return { ok: true, tabId: aiTab.id };
}

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

// `id` (when given) must match the stored task, so a slow old page can never
// change or delete a newer task that replaced it.
async function updateTask(key, patch, id) {
  const task = await getTask(key);
  if (!task || (id && task.id !== id)) return false;
  const allowed = {};
  for (const k of ["stage", "image", "claimed"]) if (k in patch) allowed[k] = patch[k];
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
  removeTask(TASK_PREFIX + tabId);
});

// Which stored task does this message belong to? Pages inside the side panel say so with
// panel:true; everything else is keyed by the tab it came from.
function keyFor(msg, sender) {
  if (msg.panel) return PANEL_KEY;
  const tab = sender.tab;
  return tab && tab.id != null && tab.id >= 0 ? TASK_PREFIX + tab.id : null;
}

function toastTab(tabId, text, kind) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { action: "toast", text, kind: kind || "ok" }, { frameId: 0 }).catch(() => {});
}

// New-tab mode, after the text is copied: go back to the page you started from and
// close the AI Mode tab. If the source tab no longer exists, leave the AI tab open so you can see the result.
async function returnToSource(key, aiTabId, message) {
  const task = await getTask(key);
  if (!task || task.sourceTabId == null) return { ok: false, reason: "no source tab" };
  try {
    await chrome.tabs.update(task.sourceTabId, { active: true });
    if (task.sourceWindowId != null) await chrome.windows.update(task.sourceWindowId, { focused: true });
  } catch (e) {
    log("returnToSource: source tab is gone, staying on the AI Mode tab", { message: e.message });
    return { ok: false, reason: "source tab gone" };
  }
  toastTab(task.sourceTabId, message);
  await chrome.tabs.remove(aiTabId).catch(() => {});
  return { ok: true };
}

// Side-panel mode: the page you are on stays in front, so just show it "copied ✓".
async function notifySource(key, message, kind) {
  const task = await getTask(key);
  if (!task) return { ok: false, reason: "no task" };
  toastTab(task.sourceTabId, message, kind);
  return { ok: true };
}

// The side panel could not do it (Google not shown, image not attachable...):
// redo the same task in a normal new tab.
async function moveTaskToTab(id, reason) {
  const task = await getTask(PANEL_KEY);
  if (!task || (id && task.id !== id)) return { ok: false, reason: "no such side-panel task" };
  if (task.stage !== "attach" || !task.image) return { ok: false, reason: "already sent" };
  log("side panel -> new tab", { reason });
  const res = await openInTab({ ...task, fromPanel: true }, null);
  if (!res.ok) return res;
  await removeTask(PANEL_KEY, task.id);
  toastTab(task.sourceTabId, "Side panel couldn't show Google AI Mode here — opened it in a new tab instead.", "error");
  return { ok: true, tabId: res.tabId };
}

// ---------- entry points ----------

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Copy text from this image (Google AI)",
      contexts: ["image"]
    });
  });
}
chrome.runtime.onInstalled.addListener(() => {
  createMenu();
  log("extension installed/updated");
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;
  const panelOpen = maybeOpenPanel(tab, null); // FIRST, no await before it
  startImageTask({ url: info.srcUrl }, tab, panelOpen).then((res) => {
    if (!res.ok && tab && tab.id != null) toastTab(tab.id, "Couldn't read that image: " + res.error, "error");
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  const fail = (e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });

  if (msg.action === "startImageTask") {
    const panelOpen = maybeOpenPanel(tab, msg.openIn); // FIRST, no await before it
    startImageTask(msg.source, tab, panelOpen).then(sendResponse, fail);
    return true;
  }
  if (msg.action === "getImageTask") {
    const key = keyFor(msg, sender);
    (async () => {
      const task = await getTask(key);
      if (task && msg.panel) await updateTask(key, { claimed: true }, task.id); // tells the side panel "the page is alive"
      return task;
    })().then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.action === "imageTaskUpdate") {
    updateTask(keyFor(msg, sender), msg.patch || {}, msg.id).then(sendResponse, () => sendResponse(false));
    return true;
  }
  if (msg.action === "imageTaskDone") {
    removeTask(keyFor(msg, sender), msg.id).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if (msg.action === "returnToSource") {
    returnToSource(keyFor(msg, sender), tab && tab.id, msg.message || "Text copied ✓").then(sendResponse, fail);
    return true;
  }
  if (msg.action === "notifySource") {
    notifySource(keyFor(msg, sender), msg.message || "Text copied ✓", msg.kind).then(sendResponse, fail);
    return true;
  }
  if (msg.action === "panelFallback") {
    moveTaskToTab(msg.id, msg.reason || "requested").then(sendResponse, fail);
    return true;
  }
  return false; // anything else (e.g. "copyText" for the side panel page) is not ours
});
