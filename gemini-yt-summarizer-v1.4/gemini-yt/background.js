importScripts("debug.js");

const WIDTH = 460;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "summarise") openSummary(msg.url);
});

async function openSummary(url) {
  dbg("background", "summarise requested", url);
  await chrome.storage.local.set({ pending: { url, ts: Date.now() } });

  const { geminiWinId } = await chrome.storage.local.get("geminiWinId");
  const geminiUrl = "https://gemini.google.com/app";

  // Reuse the existing Gemini window if it's still open
  if (geminiWinId) {
    try {
      const win = await chrome.windows.get(geminiWinId, { populate: true });
      const tab = win.tabs && win.tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { url: geminiUrl });
        await chrome.windows.update(geminiWinId, { focused: true });
        dbg("background", "reused Gemini window", geminiWinId);
        return;
      }
    } catch (e) {
      dbg("background", "old Gemini window gone, creating new", String(e));
    }
  }

  // Dock a narrow window to the LEFT edge of the current browser window
  const cur = await chrome.windows.getLastFocused();
  const win = await chrome.windows.create({
    url: geminiUrl,
    type: "popup",
    width: WIDTH,
    height: cur.height,
    top: cur.top,
    left: cur.left,
    focused: true,
  });
  await chrome.storage.local.set({ geminiWinId: win.id });
  dbg("background", "created Gemini window", win.id);
}
