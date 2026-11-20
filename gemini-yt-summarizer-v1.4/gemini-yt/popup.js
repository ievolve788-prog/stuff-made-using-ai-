const $ = (id) => document.getElementById(id);
const say = (t) => {
  $("status").textContent = t;
  setTimeout(() => ($("status").textContent = ""), 2000);
};

chrome.storage.local.get("debug").then((r) => {
  $("debug").checked = !!r.debug;
});

$("debug").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ debug: e.target.checked });
  say(e.target.checked ? "Debug on" : "Debug off");
});

$("copy").addEventListener("click", async () => {
  const { dbgLog = [] } = await chrome.storage.local.get("dbgLog");
  if (!dbgLog.length) return say("Log is empty (turn Debug on first)");
  await navigator.clipboard.writeText(dbgLog.join("\n"));
  say(`Copied ${dbgLog.length} lines`);
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ dbgLog: [] });
  say("Log cleared");
});
