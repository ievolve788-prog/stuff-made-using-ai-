// Chrome runs this as a service worker, so pull in the shared code. Firefox lists
// common.js in the manifest's "scripts" instead (importScripts doesn't exist there).
if (typeof importScripts === 'function') importScripts('common.js');

/* ---------- diagnostic log (lengths and element info only, never text) ---------- */

let logQueue = Promise.resolve();
function appendLog(entry) {
  logQueue = logQueue
    .then(async () => {
      const d = await api.storage.local.get(['debugLog', 'settings']);
      if (d.settings && d.settings.debugLog === false) return;
      const arr = Array.isArray(d.debugLog) ? d.debugLog : [];
      arr.push(entry);
      await api.storage.local.set({ debugLog: arr.slice(-300) });
    })
    .catch(() => {});
}
const bgLog = (ev, data) => appendLog({ t: Date.now(), src: 'bg', ev, ...data });

/* ---------- messaging to the page ---------- */

function send(tabId, msg, frameId) {
  const opts = frameId != null ? { frameId } : undefined;
  return Promise.resolve(api.tabs.sendMessage(tabId, msg, opts)).catch((e) => {
    bgLog('send-fail', { type: msg.type, err: String(e && e.message ? e.message : e).slice(0, 120) });
  });
}

/* ---------- clipboard, out of reach of the page ----------
   Sites that block pasting hook the page's "paste" event. Reading the clipboard
   here (Chrome: offscreen document, Firefox: background page) never touches the
   page, so those blockers can't interfere. */

let creatingOffscreen = null;
async function ensureOffscreen() {
  const url = api.runtime.getURL('offscreen.html');
  if (api.runtime.getContexts) {
    const ctx = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (ctx.length) return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = api.offscreen
      .createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Read and write the clipboard' })
      .catch((e) => { if (!/single offscreen|already exists/i.test(String(e))) throw e; })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function pasteInDocument() {
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.focus();
  const ok = document.execCommand('paste');
  const v = ta.value;
  ta.remove();
  return ok ? v : null;
}

async function readClipboardBg() {
  if (api.offscreen) { // Chrome / Edge / Brave
    await ensureOffscreen();
    const r = await api.runtime.sendMessage({ type: 'offscreenRead' });
    const ok = !!r && typeof r.text === 'string';
    bgLog('bg-read', { via: 'offscreen', ok, len: ok ? r.text.length : -1, how: r && r.how, err: r && r.err });
    return ok ? r.text : null;
  }
  if (typeof document !== 'undefined') { // Firefox background page
    let t = null;
    let how = 'none';
    try { t = pasteInDocument(); if (t !== null) how = 'execCommand'; } catch (_) { /* ignore */ }
    if (t === null) {
      try { t = await navigator.clipboard.readText(); how = 'readText'; } catch (_) { /* ignore */ }
    }
    bgLog('bg-read', { via: 'firefox-bg', ok: t !== null, len: t === null ? -1 : t.length, how });
    return t;
  }
  return null;
}

async function writeClipboardBg(text) {
  if (api.offscreen) {
    await ensureOffscreen();
    const r = await api.runtime.sendMessage({ type: 'offscreenWrite', text });
    return !!(r && r.ok);
  }
  if (typeof document !== 'undefined') {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* try the old way */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
  return false;
}

async function copyLog(tab) {
  let ok = false;
  try { ok = await writeClipboardBg(await teBuildLogText()); } catch (e) { bgLog('copy-log-error', { err: String(e).slice(0, 120) }); }
  if (tab && tab.id != null) {
    send(tab.id, {
      type: 'toast',
      text: ok
        ? 'Typexpand: debug log copied. Paste it into the chat.'
        : 'Typexpand: could not copy the log. Use "Copy debug log" in the toolbar popup.'
    }, 0);
  }
}

/* ---------- commands, menus, messages ---------- */

// Hotkeys: the content script in whichever frame has focus acts on it.
api.commands.onCommand.addListener(async (cmd, tab) => {
  if (!tab) [tab] = await api.tabs.query({ active: true, currentWindow: true });
  bgLog('command', { cmd, hasTab: !!(tab && tab.id != null) });
  if (cmd === 'copy-log') { await copyLog(tab); return; }
  const mode = cmd === 'paste-clipboard' ? 'paste' : cmd === 'type-clipboard' ? 'type' : null;
  if (!mode) return;
  if (tab && tab.id != null) send(tab.id, { type: 'clipboard', mode });
});

api.runtime.onInstalled.addListener(async () => {
  await api.contextMenus.removeAll();
  api.contextMenus.create({ id: 'type-clipboard', title: 'Type clipboard here', contexts: ['editable'] });
  api.contextMenus.create({ id: 'paste-clipboard', title: 'Paste clipboard instantly', contexts: ['editable'] });
});

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'log') {
    try {
      if (msg.entry && typeof msg.entry === 'object' && JSON.stringify(msg.entry).length < 1500) appendLog(msg.entry);
    } catch (_) { /* ignore */ }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type !== 'readClipboard') return;
  readClipboardBg().then(
    (text) => sendResponse({ text }),
    (e) => { bgLog('bg-read-error', { err: String(e).slice(0, 120) }); sendResponse({ text: null }); }
  );
  return true; // async response
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  bgLog('menu', { id: info.menuItemId });
  send(tab.id, { type: 'clipboard', mode: info.menuItemId === 'paste-clipboard' ? 'paste' : 'type' }, info.frameId);
});
