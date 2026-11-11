// log.js — shared debug logger. Loaded first in every context (importScripts in
// the service worker, listed before the other files in content_scripts).
// Appends to chrome.storage.local "debugLog"; the popup shows it with a Copy button.
(function (g) {
  const MAX_ENTRIES = 200;
  const MAX_DATA_CHARS = 4000;
  g.itcLog = async function itcLog(tag, msg, data) {
    try {
      let d;
      try {
        d = data === undefined ? undefined : JSON.stringify(data);
      } catch (e) {
        d = String(data);
      }
      if (d && d.length > MAX_DATA_CHARS) d = d.slice(0, MAX_DATA_CHARS) + "…(cut)";
      const { debugLog = [] } = await chrome.storage.local.get("debugLog");
      debugLog.push({ ts: Date.now(), tag, msg, data: d });
      while (debugLog.length > MAX_ENTRIES) debugLog.shift();
      await chrome.storage.local.set({ debugLog });
    } catch (e) {
      // logging must never break the feature
    }
  };
})(globalThis);
