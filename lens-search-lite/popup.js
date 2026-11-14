document.getElementById("btn-screen").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ action: "triggerSearchScreen", tabId: tab.id });
  window.close();
});

document.getElementById("btn-area").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ action: "triggerSearchArea", tabId: tab.id });
  window.close();
});

document.getElementById("btn-ai").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ action: "openAiMode", tabId: tab && tab.id });
  window.close();
});

document.getElementById("settings-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById("shortcuts-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// ---------- debug log panel ----------

function formatLog(entries) {
  if (!entries || entries.length === 0) return "(log is empty — try reproducing the issue first)";
  return entries
    .map((e) => {
      const time = new Date(e.ts).toLocaleTimeString();
      const dataStr = e.data !== undefined ? " " + e.data : "";
      return `[${time}] (${e.tag}) ${e.msg}${dataStr}`;
    })
    .join("\n");
}

async function refreshLog() {
  const { debugLog = [] } = await chrome.storage.local.get("debugLog");
  document.getElementById("debug-log").value = formatLog(debugLog);
}

document.getElementById("toggle-debug").addEventListener("click", async (e) => {
  e.preventDefault();
  const panel = document.getElementById("debug-panel");
  const isHidden = panel.style.display === "none" || !panel.style.display;
  panel.style.display = isHidden ? "block" : "none";
  e.target.textContent = isHidden ? "Hide debug log" : "Show debug log";
  if (isHidden) await refreshLog();
});

document.getElementById("refresh-log").addEventListener("click", refreshLog);

document.getElementById("clear-log").addEventListener("click", async () => {
  await chrome.storage.local.set({ debugLog: [] });
  await refreshLog();
});

document.getElementById("copy-log").addEventListener("click", async () => {
  const text = document.getElementById("debug-log").value;
  try {
    await navigator.clipboard.writeText(text);
    const status = document.getElementById("copy-status");
    status.textContent = "Copied!";
    setTimeout(() => (status.textContent = ""), 2000);
  } catch (e) {
    // Fallback: select the text so the user can Ctrl+C manually.
    const el = document.getElementById("debug-log");
    el.select();
  }
});

// ---------- which destination are the screenshot buttons using? ----------

chrome.storage.local.get({ searchDestination: "aimode" }).then(({ searchDestination }) => {
  document.getElementById("dest-name").textContent =
    searchDestination === "lens" ? "Google Lens" : "AI Mode (with your prompt)";
});
