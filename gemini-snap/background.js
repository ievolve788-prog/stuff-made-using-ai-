importScripts('defaults.js');

const LOG_KEY = 'gsLogs';
const MAX_LOGS = 2000;
const MAX_CANVAS_H = 16000;     // device px; browsers fail on bigger canvases
const MIN_CAPTURE_GAP = 650;    // captureVisibleTab is limited to ~2 calls/sec
const GEMINI_URL = 'https://gemini.google.com/app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastQuick = 0;                 // debounce for accidental double-press
let sendQueue = Promise.resolve(); // Gemini runs are serialized (one tab at a time)
const doneWaiters = new Map();     // run id / tabId -> resolver, fulfilled by GEMINI_DONE
let cachedTarget = 'sidepanel';    // mirrors settings.target so we can decide synchronously (gesture window is tiny)
let panelOpenP = null;             // result of the sidePanel.open() call made inside the user gesture
let quickShot = null;              // screenshot started inside the shortcut gesture
chrome.storage.local.get('gsSettings').then((r) => { cachedTarget = (r.gsSettings && r.gsSettings.target) || 'sidepanel'; }).catch(() => {});
chrome.storage.onChanged.addListener((c) => { if (c.gsSettings) cachedTarget = (c.gsSettings.newValue && c.gsSettings.newValue.target) || 'sidepanel'; });

// MUST be called synchronously from the event listener, before any await, or Chrome refuses it.
function tryOpenPanel(windowId) {
  if (panelPort || cachedTarget === 'tab' || windowId == null) return;
  try {
    panelOpenP = chrome.sidePanel.open({ windowId }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e && e.message || e) }));
  } catch (e) { panelOpenP = Promise.resolve({ ok: false, error: String(e) }); }
}
let panelPort = null;              // connection from the open side panel

/* ------------------------------ logging ------------------------------ */
let logs = [];
const logsReady = chrome.storage.local.get(LOG_KEY).then((r) => {
  logs = (r[LOG_KEY] || []).concat(logs);
});

function stringify(d) {
  try {
    const s = typeof d === 'string' ? d : JSON.stringify(d);
    return s.length > 600 ? s.slice(0, 600) + '…' : s;
  } catch { return String(d); }
}

async function log(level, src, text, data) {
  await logsReady;
  const line = `${new Date().toISOString()} [${level}] [${src}] ${text}` + (data !== undefined ? ' | ' + stringify(data) : '');
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  (level === 'ERROR' ? console.error : console.log)(line);
  chrome.storage.local.set({ [LOG_KEY]: logs }).catch(() => {});
}

async function getSettings() {
  const r = await chrome.storage.local.get('gsSettings');
  return { ...GS_DEFAULT_SETTINGS, ...(r.gsSettings || {}) };
}

/* Writes Downloads/GeminiSnap/debug-log.txt (overwritten each time) */
async function saveLog(reason) {
  await logsReady;
  const header = [
    'Gemini Snap debug log',
    `Version : ${chrome.runtime.getManifest().version}`,
    `Saved   : ${new Date().toISOString()} (${reason})`,
    `Browser : ${self.navigator.userAgent}`,
    `Lines   : ${logs.length}`,
    '='.repeat(70), ''
  ].join('\n');
  const text = header + logs.join('\n') + '\n';
  const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  try {
    const id = await chrome.downloads.download({
      url, filename: 'GeminiSnap/debug-log.txt', conflictAction: 'overwrite', saveAs: false
    });
    console.log('log saved, download id', id);
    return { ok: true, path: 'Downloads/GeminiSnap/debug-log.txt' };
  } catch (e) {
    console.error('saveLog failed', e);
    return { ok: false, error: String(e) };
  }
}

async function maybeAutoSave(reason) {
  const s = await getSettings();
  if (s.autoSaveLog) await saveLog(reason);
}

self.addEventListener('error', (e) => log('ERROR', 'bg', 'uncaught', { msg: e.message }));
self.addEventListener('unhandledrejection', (e) => log('ERROR', 'bg', 'unhandled rejection', String(e.reason)));

/* ------------------------------ helpers ------------------------------ */
let badgeTimer;
function badge(text, color = '#4c8bf5', clearAfter = 0) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  clearTimeout(badgeTimer);
  if (clearAfter) badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), clearAfter);
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return `data:${blob.type || 'image/png'};base64,` + btoa(bin);
}
const dataUrlToBitmap = async (dataUrl) => createImageBitmap(await (await fetch(dataUrl)).blob());

async function fail(where, e) {
  await log('ERROR', 'bg', `${where} failed`, { message: String(e && e.message || e), stack: e && e.stack });
  badge('ERR', '#d93025', 4000);
  await maybeAutoSave('error in ' + where);
}

/* ------------------------------ capture ------------------------------ */
const captureVisible = (tab) => chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

async function cropImage(dataUrl, rect) {
  const bmp = await dataUrlToBitmap(dataUrl);
  const s = bmp.width / rect.vw; // real scale (handles DPR + browser zoom)
  const sx = Math.max(0, Math.round(rect.x * s));
  const sy = Math.max(0, Math.round(rect.y * s));
  const sw = Math.min(Math.round(rect.w * s), bmp.width - sx);
  const sh = Math.min(Math.round(rect.h * s), bmp.height - sy);
  await log('DEBUG', 'bg', 'crop', { rect, scale: s, bmp: [bmp.width, bmp.height], out: [sw, sh] });
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

async function captureFull(tab) {
  const prep = await chrome.tabs.sendMessage(tab.id, { type: 'FULL_PREPARE' });
  await log('INFO', 'bg', 'full-page prepare', prep);
  const { total, vh, vw } = prep;
  const maxY = Math.max(0, total - vh);
  let positions = [];
  for (let y = 0; y < total; y += vh) positions.push(Math.min(y, maxY));
  positions = [...new Set(positions)];

  const tiles = [];
  let lastCall = 0, scale = 1;
  try {
    for (let i = 0; i < positions.length; i++) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'FULL_SCROLL', y: positions[i], hideFixed: i > 0 });
      await sleep(Math.max(0, MIN_CAPTURE_GAP - (Date.now() - lastCall)));
      const dataUrl = await captureVisible(tab);
      lastCall = Date.now();
      const bmp = await dataUrlToBitmap(dataUrl);
      tiles.push({ bmp, y: r.y });
      if (i === 0) {
        scale = bmp.width / vw;
        const before = positions.length;
        positions = positions.filter((p) => p * scale < MAX_CANVAS_H);
        if (positions.length < before) await log('WARN', 'bg', 'page truncated (canvas limit)', { before, after: positions.length });
      }
      badge(`${i + 1}/${positions.length}`);
      await log('DEBUG', 'bg', `tile ${i + 1}/${positions.length}`, { requestedY: positions[i], actualY: r.y });
    }
  } finally {
    await chrome.tabs.sendMessage(tab.id, { type: 'FULL_RESTORE' }).catch(() => {});
  }

  const W = tiles[0].bmp.width;
  const H = Math.min(Math.round(total * scale), MAX_CANVAS_H);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  for (const t of tiles) {
    const dy = Math.round(t.y * scale);
    if (dy < H) ctx.drawImage(t.bmp, 0, dy);
    t.bmp.close();
  }
  await log('INFO', 'bg', 'stitched', { W, H, tiles: tiles.length });
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

/* ------------------------------ main flows ------------------------------ */
async function start(mode, tabHint) {
  let tab = tabHint;
  try {
    if (!tab || !tab.id) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await log('INFO', 'bg', 'start', { mode, tabId: tab && tab.id });
    if (!tab || !tab.id) throw new Error('No active tab');

    if (mode === 'quick') {
      // One-shot: capture visible area -> Gemini -> press send. No panel, no prompt dialog.
      badge('⚡', '#f9ab00');
      const s = await getSettings();
      const image = await (quickShot || captureVisible(tab));
      quickShot = null;
      await log('INFO', 'bg', 'quick-send captured', { promptLen: (s.quickPrompt || '').length });
      badge('✓', '#188038', 2500); // screenshot taken; Gemini tab follows
      sendToGemini({ image, prompt: (s.quickPrompt || '').trim(), autoSubmit: true });
      return;
    }

    // Fails on chrome://, Web Store, PDF viewer etc. -> caught below and logged
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['defaults.js', 'content.js'] });

    if (mode === 'region') {
      await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECT' });
      return;
    }
    badge('…');
    const image = mode === 'full' ? await captureFull(tab) : await captureVisible(tab);
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PREVIEW', image, mode });
    badge('');
    await log('INFO', 'bg', 'preview shown', { mode });
  } catch (e) {
    await fail('start(' + mode + ')', e);
  }
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('Gemini tab load timeout')); }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') listener(tabId, { status: 'complete' }); }).catch(() => {});
  });
}

function sendToGemini(payload) {
  payload = { ...payload, id: Date.now() + '-' + Math.random().toString(36).slice(2, 7) };
  sendQueue = sendQueue.then(() => runSend(payload)).catch(() => {});
  return sendQueue;
}

/* ---- side panel mode: Gemini embedded in sidepanel.html ---- */
async function installFrameRule() {
  // Lets ONLY this extension's own iframe embed gemini.google.com (strips frame-blocking headers).
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1, priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' }
        ] },
        condition: { urlFilter: '||gemini.google.com/', resourceTypes: ['sub_frame'], initiatorDomains: [chrome.runtime.id] }
      }]
    });
    await log('INFO', 'bg', 'frame rule installed');
  } catch (e) { await log('ERROR', 'bg', 'frame rule failed', String(e)); }
}
installFrameRule();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gs-panel') return;
  panelPort = port;
  log('INFO', 'bg', 'side panel connected');
  port.onMessage.addListener((m) => {
    if (m.type === 'PANEL_FAILED') {
      log('WARN', 'panel', 'delivery failed', { reason: m.reason });
      doneWaiters.get(m.id)?.({ panelFailed: true, reason: m.reason });
    }
  });
  port.onDisconnect.addListener(() => { if (panelPort === port) panelPort = null; log('INFO', 'bg', 'side panel closed'); });
});

async function runPanel(payload) {
  try {
    await log('INFO', 'bg', 'sending via side panel', { id: payload.id, alreadyOpen: !!panelPort });
    if (!panelPort) {
      const opened = panelOpenP;
      panelOpenP = null;
      if (!opened) throw new Error('side panel is closed and no user gesture was available to open it');
      const r0 = await opened;
      if (!r0.ok) throw new Error('sidePanel.open failed: ' + r0.error);
      const t0 = Date.now();
      while (!panelPort && Date.now() - t0 < 8000) await sleep(150);
      if (!panelPort) throw new Error('side panel did not connect');
    }
    const result = new Promise((resolve) => {
      doneWaiters.set(payload.id, resolve);
      setTimeout(() => resolve({ timeout: true }), 100000);
    });
    panelPort.postMessage({ type: 'PANEL_SEND', payload });
    const r = await result;
    if (r.panelFailed) throw new Error('panel could not reach Gemini: ' + r.reason);
    if (r.timeout) await log('WARN', 'bg', 'no GEMINI_DONE from panel within 100s');
    return true;
  } catch (e) {
    await log('WARN', 'bg', 'side panel mode failed, falling back to new tab', String(e && e.message || e));
    return false;
  } finally {
    doneWaiters.delete(payload.id);
  }
}

async function runSend(payload) {
  const settings = await getSettings();
  if ((settings.target || 'sidepanel') === 'sidepanel' && await runPanel(payload)) return;
  let tabId;
  try {
    await log('INFO', 'bg', 'opening Gemini', { promptLen: payload.prompt.length, autoSubmit: payload.autoSubmit, imgBytes: payload.image.length });
    const tab = await chrome.tabs.create({ url: GEMINI_URL, active: true });
    tabId = tab.id;
    try { await waitForTabComplete(tabId, 45000); }
    catch (e) { await log('WARN', 'bg', 'load wait failed, trying anyway', String(e)); }

    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { await chrome.tabs.get(tabId); } catch { throw new Error('Gemini tab was closed before it finished loading'); }
      try { ready = !!(await chrome.tabs.sendMessage(tabId, { type: 'GEMINI_PING' }))?.ok; }
      catch { await sleep(500); }
    }
    if (!ready) {
      const t = await chrome.tabs.get(tabId);
      throw new Error('Gemini content script not reachable (redirected? url=' + t.url + ')');
    }
    const finished = new Promise((resolve) => {
      doneWaiters.set(tabId, resolve);
      setTimeout(() => resolve({ timeout: true }), 90000);
    });
    await chrome.tabs.sendMessage(tabId, { type: 'GEMINI_PASTE', ...payload });
    await log('INFO', 'bg', 'payload delivered to Gemini tab', { tabId });
    const r = await finished;
    if (r.timeout) await log('WARN', 'bg', 'no GEMINI_DONE within 90s', { tabId });
  } catch (e) {
    await fail('sendToGemini', e);
  } finally {
    if (tabId !== undefined) doneWaiters.delete(tabId);
  }
}

/* ------------------------------ events ------------------------------ */
chrome.commands.onCommand.addListener((command, tab) => {
  const mode = { 'capture-region': 'region', 'capture-visible': 'visible', 'capture-full': 'full', 'quick-send': 'quick' }[command];
  log('INFO', 'bg', 'shortcut', { command });
  if (mode === 'quick') {
    if (Date.now() - lastQuick < 1500) { log('WARN', 'bg', 'quick-send ignored (double press)'); return; }
    lastQuick = Date.now();
    if (tab && tab.id) {
      // Same tick, inside the gesture: screenshot request goes out first (before the panel resizes the page), then open the panel.
      quickShot = chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      quickShot.catch(() => {});
      tryOpenPanel(tab.windowId);
    }
  }
  if (mode) start(mode, tab);
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'LOG': await log(msg.level || 'INFO', msg.src || '?', msg.text, msg.data); return { ok: true };
    case 'START': await start(msg.mode); return { ok: true };
    case 'RETAKE': await start(msg.mode, sender.tab); return { ok: true };
    case 'SELECT_CANCELLED': await log('INFO', 'content', 'selection cancelled'); return { ok: true };
    case 'REGION_SELECTED': {
      try {
        const full = await captureVisible(sender.tab);
        const cropped = await cropImage(full, msg.rect);
        await chrome.tabs.sendMessage(sender.tab.id, { type: 'SHOW_PREVIEW', image: cropped, mode: 'region' });
        await log('INFO', 'bg', 'region captured', { rect: msg.rect });
      } catch (e) { await fail('region capture', e); }
      return { ok: true };
    }
    case 'SEND_TO_GEMINI': {
      const s = await getSettings();
      await chrome.storage.local.set({ gsSettings: { ...s, autoSubmit: !!msg.autoSubmit } });
      sendToGemini({ image: msg.image, prompt: msg.prompt, autoSubmit: !!msg.autoSubmit });
      return { ok: true };
    }
    case 'FOCUS_ME':
      if (sender.tab) {
        await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => {});
        await chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
      }
      return { ok: true };
    case 'GEMINI_DONE':
      for (const key of [msg.id, sender.tab && sender.tab.id]) if (key != null && doneWaiters.has(key)) doneWaiters.get(key)({ ok: msg.ok });
      await log(msg.ok ? 'INFO' : 'ERROR', 'gemini', 'finished', { ok: msg.ok, reason: msg.reason, ms: msg.ms });
      await maybeAutoSave(msg.ok ? 'run finished' : 'run failed');
      return { ok: true };
    case 'SAVE_LOG': return saveLog('manual');
    case 'CLEAR_LOG': logs = []; await chrome.storage.local.set({ [LOG_KEY]: [] }); return { ok: true };
    case 'GET_LOG': await logsReady; return { ok: true, text: logs.slice(-300).join('\n') };
    default: return { ok: false, error: 'unknown message ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_TO_GEMINI' && sender.tab) tryOpenPanel(sender.tab.windowId); // user clicked Send: gesture is still alive here
  handle(msg, sender).then(sendResponse).catch((e) => { log('ERROR', 'bg', 'handler error', String(e)); sendResponse({ ok: false, error: String(e) }); });
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  installFrameRule();
  const r = await chrome.storage.local.get('gsSettings');
  if (!r.gsSettings) await chrome.storage.local.set({ gsSettings: GS_DEFAULT_SETTINGS });
  await log('INFO', 'bg', 'installed/updated', { version: chrome.runtime.getManifest().version });
});
