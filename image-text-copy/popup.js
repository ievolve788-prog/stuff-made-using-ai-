// popup.js — how-to blurb, shortcut to Settings / the side panel, and the debug log.

(function () {
  const $ = (id) => document.getElementById(id);
  let msgTimer = null;

  function say(text) {
    $("msg").textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => ($("msg").textContent = ""), 3000);
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  async function logText() {
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    if (!debugLog.length) return "(the debug log is empty)";
    const header = "Image Text Copier " + chrome.runtime.getManifest().version + " — " + navigator.userAgent + "\n";
    return (
      header +
      debugLog
        .map((e) => {
          const d = new Date(e.ts);
          const t = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
          return t + " [" + e.tag + "] " + e.msg + (e.data ? " " + e.data : "");
        })
        .join("\n")
    );
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  async function showLog() {
    const box = $("log");
    box.value = await logText();
    box.style.display = "block";
    box.scrollTop = box.scrollHeight;
  }

  $("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $("panel").addEventListener("click", async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    } catch (e) {
      say("Couldn't open the side panel: " + e.message);
    }
  });

  $("copyLog").addEventListener("click", async () => {
    say((await copy(await logText())) ? "Debug log copied — paste it in the chat ✓" : "Copy failed — use Show and copy by hand");
  });
  $("showLog").addEventListener("click", showLog);
  $("clearLog").addEventListener("click", async () => {
    await chrome.storage.local.set({ debugLog: [] });
    if ($("log").style.display === "block") await showLog();
    say("Debug log cleared");
  });
})();
