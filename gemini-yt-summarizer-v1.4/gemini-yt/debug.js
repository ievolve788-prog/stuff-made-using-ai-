// Shared debug logger (content scripts + service worker).
// Logs go to chrome.storage.local ("dbgLog") only while the Debug toggle is on.
var DEBUG = false;
var dbgQueue = Promise.resolve();

chrome.storage.local.get("debug").then((r) => {
  DEBUG = !!r.debug;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debug) DEBUG = !!changes.debug.newValue;
});

function dbgSafe(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function dbg(src, msg, data) {
  if (!DEBUG) return dbgQueue;
  const line =
    `[${new Date().toISOString()}] ${src}: ${msg}` +
    (data !== undefined ? " " + dbgSafe(data) : "");
  try { console.log("[GeminiYT]", line); } catch {}
  dbgQueue = dbgQueue.then(async () => {
    const { dbgLog = [] } = await chrome.storage.local.get("dbgLog");
    dbgLog.push(line);
    await chrome.storage.local.set({ dbgLog: dbgLog.slice(-300) });
  }).catch(() => {});
  return dbgQueue;
}

async function dbgCopyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Copy the whole log to the clipboard (only when Debug is on).
async function dbgCopy() {
  if (!DEBUG) return false;
  await dbgQueue;
  const { dbgLog = [] } = await chrome.storage.local.get("dbgLog");
  const ok = await dbgCopyText(dbgLog.join("\n"));
  if (!ok) console.log("[GeminiYT] clipboard copy failed (page not focused?). Use the popup's 'Copy log now'.");
  return ok;
}
