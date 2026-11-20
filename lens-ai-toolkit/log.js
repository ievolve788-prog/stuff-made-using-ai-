// log.js — shared debug logger. Entries end up in chrome.storage.local "debugLog"; the popup's
// "Copy debug log" button hands that to you so you can paste it when something breaks.
//
// Only the service worker writes to storage (one write at a time, so no line is ever lost);
// every other part of the extension (pages, content scripts) sends its lines to it.
// Loaded first in every context (importScripts in the worker, listed first elsewhere).
(function (g) {
  const MAX_ENTRIES = 250;
  const MAX_DATA_CHARS = 4000;
  let queue = Promise.resolve();

  // Used by the service worker (see the "log" message in background.js).
  g.tkLogWrite = function tkLogWrite(entry) {
    queue = queue
      .then(async () => {
        const { debugLog = [] } = await chrome.storage.local.get("debugLog");
        debugLog.push(entry);
        while (debugLog.length > MAX_ENTRIES) debugLog.shift();
        await chrome.storage.local.set({ debugLog });
      })
      .catch(() => {}); // logging must never break a feature
    return queue;
  };

  g.tkLog = function tkLog(tag, msg, data) {
    let d;
    try {
      d = data === undefined ? undefined : JSON.stringify(data);
    } catch (e) {
      d = String(data);
    }
    if (d && d.length > MAX_DATA_CHARS) d = d.slice(0, MAX_DATA_CHARS) + "…(cut)";
    const entry = { ts: Date.now(), tag, msg, data: d };
    if (g.__TK_IS_BACKGROUND) return g.tkLogWrite(entry);
    try {
      return Promise.resolve(chrome.runtime.sendMessage({ action: "log", entry })).then(() => {}, () => {});
    } catch (e) {
      return Promise.resolve();
    }
  };
})(globalThis);
