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

api.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  send(tab.id, info.menuItemId === 'paste-clipboard' ? 'paste' : 'type', info.frameId);
});
