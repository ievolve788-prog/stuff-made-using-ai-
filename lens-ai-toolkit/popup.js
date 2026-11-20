// popup.js — quick actions, a few quick switches, the self-test and the debug log.
//
// chrome.sidePanel.open() only works if it is called straight away inside the click (nothing
// awaited before it), so the window id and the settings are fetched as soon as the popup opens.

(function () {
  const $ = (id) => document.getElementById(id);
  let S = { ...TK.DEFAULTS };
  let winId = null;
  let msgTimer = null;

  function say(text) {
    $("msg").textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => ($("msg").textContent = ""), 3500);
  }

  const pad = (n) => String(n).padStart(2, "0");

  // ---------- prefetch (so clicks can open the panel at once) ----------

  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  chrome.windows.getCurrent().then(
    (w) => {
      winId = w.id;
    },
    () => {}
  );
  TK.getSettings().then((s) => {
    S = s;
    $("qHistory").checked = !!s.fHistory;
    $("qReuse").checked = !!s.fReuse;
    $("qAreaText").checked = !!s.fAreaText;
    $("qHover").checked = !!s.fHover;
  });

  // ---------- quick switches ----------

  for (const [id, key] of [["qHistory", "fHistory"], ["qReuse", "fReuse"], ["qAreaText", "fAreaText"], ["qHover", "fHover"]]) {
    $(id).addEventListener("change", (e) => {
      S[key] = e.target.checked;
      chrome.storage.local.set({ [key]: e.target.checked });
    });
  }
  $("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // ---------- actions ----------

  // Does this action end in the side panel? (Same rules as wantsPanel() in the service worker.)
  const needsPanel = {
    screen: () => S.openIn === "sidepanel" && S.searchDestination !== "lens",
    openAi: () => S.openIn === "sidepanel",
    selfTest: () => S.openIn === "sidepanel" && S.ocrEngine === "ai"
  };

  function run(purpose, closeAfter) {
    let expectPanel = false;
    // FIRST, no await before it: this is what lets Chrome accept the open as "a user action".
    if (needsPanel[purpose] && needsPanel[purpose]() && winId != null) {
      expectPanel = true;
      chrome.sidePanel.open({ windowId: winId }).catch((e) => say("Couldn't open the side panel: " + e.message));
    }
    chrome.runtime.sendMessage({ action: "popupAction", purpose, expectPanel }, (res) => {
      if (chrome.runtime.lastError) return say("Couldn't start: " + chrome.runtime.lastError.message);
      if (res && res.ok === false) return say("Couldn't start: " + res.error);
      if (closeAfter) window.close();
    });
  }

  $("areaText").addEventListener("click", () => run("areaText", true));
  $("area").addEventListener("click", () => run("area", true));
  $("screen").addEventListener("click", () => run("screen", !needsPanel.screen()));
  $("scroll").addEventListener("click", () => run("scroll", true));
  $("openAi").addEventListener("click", () => run("openAi", !needsPanel.openAi()));
  $("selfTest").addEventListener("click", () => {
    $("st").className = "";
    $("st").textContent = "Self-test running… (it sends a small test picture through your current setup)";
    run("selfTest", false);
  });
  $("panel").addEventListener("click", () => {
    if (winId == null) return say("Not ready yet — click again.");
    chrome.sidePanel.open({ windowId: winId }).then(
      () => window.close(),
      (e) => say("Couldn't open the side panel: " + e.message)
    );
  });

  // ---------- self-test result ----------

  function showSelfTest(r) {
    if (!r) return;
    $("st").className = r.ok ? "ok" : "bad";
    $("st").textContent =
      (r.ok ? "Self-test passed ✓" : "Self-test FAILED ✗") + " (" + r.engine + ", " + r.similarity + "% match). Expected “" + r.expected + "”, got “" + r.got + "”. " + new Date(r.ts).toLocaleTimeString();
  }
  chrome.storage.local.get("selfTestResult").then((g) => showSelfTest(g.selfTestResult));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.selfTestResult) showSelfTest(changes.selfTestResult.newValue);
  });

  // ---------- debug log ----------

  async function logText() {
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    if (!debugLog.length) return "(the debug log is empty)";
    const keep = {};
    for (const [k, v] of Object.entries(S)) if (typeof v === "boolean" || (typeof v === "string" && v.length < 20 && !/prompt|prefix|blocklist/i.test(k))) keep[k] = v;
    const header = "Lens AI Toolkit " + chrome.runtime.getManifest().version + " — " + navigator.userAgent + "\nsettings: " + JSON.stringify(keep) + "\n";
    return (
      header +
      debugLog
        .map((e) => {
          const d = new Date(e.ts);
          return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + " [" + e.tag + "] " + e.msg + (e.data ? " " + e.data : "");
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

  $("copyLog").addEventListener("click", async () => say((await copy(await logText())) ? "Debug log copied — paste it in the chat ✓" : "Copy failed — use Show and copy by hand"));
  $("showLog").addEventListener("click", showLog);
  $("clearLog").addEventListener("click", async () => {
    await chrome.storage.local.set({ debugLog: [] });
    if ($("log").style.display === "block") await showLog();
    say("Debug log cleared");
  });
})();
