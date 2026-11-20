const api = globalThis.browser ?? globalThis.chrome;

function send(tabId, mode, frameId) {
  const opts = frameId != null ? { frameId } : undefined;
  Promise.resolve(api.tabs.sendMessage(tabId, { type: 'clipboard', mode }, opts)).catch(() => {});
}

// Hotkeys: the content script in whichever frame has focus acts on it.
api.commands.onCommand.addListener(async (cmd, tab) => {
  const mode = cmd === 'paste-clipboard' ? 'paste' : cmd === 'type-clipboard' ? 'type' : null;
  if (!mode) return;
  if (!tab) [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) send(tab.id, mode);
});

api.runtime.onInstalled.addListener(async () => {
  await api.contextMenus.removeAll();
  api.contextMenus.create({ id: 'type-clipboard', title: 'Type clipboard here', contexts: ['editable'] });
  api.contextMenus.create({ id: 'paste-clipboard', title: 'Paste clipboard instantly', contexts: ['editable'] });
});

/* ---------- clipboard reading, out of reach of the page ----------
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
      .createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Read the clipboard to type it into the focused field' })
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
    return r && typeof r.text === 'string' ? r.text : null;
  }
  if (typeof document !== 'undefined') { // Firefox background page
    let t = null;
    try { t = pasteInDocument(); } catch (_) { /* ignore */ }
    if (t === null) { try { t = await navigator.clipboard.readText(); } catch (_) { /* ignore */ } }
    return t;
  }
  return null;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'readClipboard') return;
  readClipboardBg().then((text) => sendResponse({ text }), () => sendResponse({ text: null }));
  return true; // async response
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  send(tab.id, info.menuItemId === 'paste-clipboard' ? 'paste' : 'type', info.frameId);
});
