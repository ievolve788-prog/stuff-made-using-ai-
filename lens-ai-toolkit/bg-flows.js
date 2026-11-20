// bg-flows.js — what actually happens when you use a feature: make the image, decide where it
// goes (Lens / side panel / new tab / offline reader), keep the task, deal with the answer, keep
// the histories. (background.js loads this with importScripts.)

// An "intent" says what the user asked for:
//   { type: "text",   via, presetId?, selfTest? }  -> copy the text in the image (preset "copy" by default)
//   { type: "search", via, prompt? }               -> screenshot / area search (default prompt, or Lens)

const pendingCaptures = new Map(); // tabId -> full-page screenshot taken just before the area overlay

function rememberPrompt(s, prompt, kind, via) {
  if (s.fHistory && prompt) TK.recordPrompt(prompt, kind, via).catch(() => {});
}

function resolveIntent(intent, s) {
  if (intent.type === "text") {
    const preset = TK.presetById(s, intent.presetId || s.textPresetId);
    return { kind: preset.mode === "ask" ? "ask" : "extract", prompt: TK.finalizePrompt(preset), presetId: preset.id, label: preset.name, historyKind: "preset" };
  }
  const given = intent.prompt != null;
  return { kind: "ask", prompt: String(given ? intent.prompt : s.defaultPrompt || "").trim(), presetId: null, label: "Search", historyKind: given ? "custom" : "default" };
}

function buildTask(image, tab, r, intent, s) {
  return {
    id: newId(),
    tabId: null,
    panel: false,
    stage: "attach",
    claimed: false,
    kind: r.kind,
    label: r.label,
    presetId: r.presetId,
    prompt: r.prompt,
    autoSend: !!s.autoSend && !!r.prompt, // never auto-send an image with no question
    preview: !!s.fPreview && r.kind === "extract",
    url: aiHome(s),
    backend: s.useGemini ? "gemini" : "google",
    image: image.base64,
    mime: image.mime,
    name: image.name,
    afterCopy: s.afterCopy,
    via: intent.via || "",
    selfTest: intent.selfTest || null,
    sourceTabId: tab ? tab.id : null,
    sourceWindowId: tab ? tab.windowId : null,
    updated: Date.now()
  };
}

async function pollPanelOpen(ms) {
  const loops = Math.max(1, Math.ceil(ms / 150));
  for (let i = 0; i < loops; i++) {
    if (await isPanelOpen()) return true;
    await sleep(150);
  }
  return false;
}

// ---------- the answer comes back ----------

// Decide what to do with finished text. -> { copy, text, preview? }   (copy: the caller puts it on the clipboard)
async function presentResult(task, text, engine) {
  const s = await getSettings();
  if (task && task.preview && task.sourceTabId != null) {
    const shown = await bubbleTab(task.sourceTabId, { text, copied: false, engine });
    if (shown) return { copy: false, text, preview: true };
  }
  if (s.fCopyHistory) TK.recordCopy(text, { engine, via: (task && task.via) || "" }).catch(() => {});
  flashBadge("✓", "#188038");
  return { copy: true, text };
}

async function handleTaskResult(key, msg) {
  const task = await getTask(key);
  const s = await getSettings();
  const text = TK.tidy(msg.text, { cleanup: s.fCleanup, join: s.fJoinLines });
  if (!text) return { copy: false, text: "" };
  if (task && task.selfTest) {
    await finishSelfTest(task, text, "Google AI");
    return { copy: false, text, selfTest: true };
  }
  return presentResult(task, text, "ai");
}

async function finishSelfTest(task, text, engine) {
  const expected = task.selfTest.expected;
  const sim = TK.similarity(TK.norm(text), TK.norm(expected));
  const ok = sim >= 0.85;
  const result = { ts: Date.now(), ok, engine, expected, got: String(text).slice(0, 200), similarity: Math.round(sim * 100) };
  await chrome.storage.local.set({ selfTestResult: result });
  log("self-test " + (ok ? "PASSED" : "FAILED"), result);
  flashBadge(ok ? "OK" : "✗", ok ? "#188038" : "#d93025");
  toastTab(task.sourceTabId, "Self-test " + (ok ? "passed ✓" : "FAILED ✗") + " (" + engine + ") — got “" + TK.shorten(text, 60) + "”", ok ? "ok" : "error");
}

// ---------- offline reader ----------

// -> true when the job is finished (copied / reported), false when the caller should go on with Google.
async function runLocalTask(task, image, s, mayFallBack) {
  flashBadge("…");
  toastTab(task.sourceTabId, "Reading the text offline…", "info");
  let res;
  try {
    res = await localOcr(image);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  log("offline reader", { ok: res.ok, confidence: res.confidence, ms: res.ms, chars: (res.text || "").length, error: res.error });
  const text = TK.tidy(res.text || "", { cleanup: s.fCleanup, join: s.fJoinLines });
  const sure = res.ok && text && (res.confidence >= 75 || !mayFallBack);
  if (!sure && mayFallBack) {
    toastTab(task.sourceTabId, "Not sure about that text — asking Google AI instead…", "info");
    return false;
  }
  if (task.selfTest) {
    await finishSelfTest(task, text, "offline reader");
    return true;
  }
  if (!res.ok) {
    flashBadge("!", "#d93025");
    toastTab(task.sourceTabId, "The offline reader failed: " + (res.error || "unknown error"), "error");
    return true;
  }
  if (!text) {
    toastTab(task.sourceTabId, "No text found in that image", "error");
    return true;
  }
  const out = await presentResult(task, text, "local");
  if (out.copy) {
    if (await offscreenCopy(out.text)) {
      toastTab(task.sourceTabId, "Copied " + out.text.length + " characters ✓ (offline reader, " + res.confidence + "% sure)", "ok");
    } else {
      const shown = await bubbleTab(task.sourceTabId, { text: out.text, copied: false, engine: "local", note: "The browser blocked the automatic copy — press Copy." });
      if (!shown) flashBadge("!", "#d93025");
    }
  }
  return true;
}

// ---------- delivering an image ----------

async function openInTab(task, tab) {
  const props = { url: task.url || AI_MODE_URL };
  if (tab && tab.id != null && tab.id >= 0) {
    props.openerTabId = tab.id; // Chrome returns you to the source tab when this one closes
    if (typeof tab.index === "number") props.index = tab.index + 1;
    if (tab.windowId != null) props.windowId = tab.windowId;
  } else if (task.sourceWindowId != null) {
    props.windowId = task.sourceWindowId;
  }
  let aiTab;
  try {
    aiTab = await chrome.tabs.create(props);
  } catch (e) {
    log("tabs.create with position failed, retrying plainly", { message: e.message });
    aiTab = await chrome.tabs.create({ url: props.url });
  }
  const stored = { ...task, tabId: aiTab.id, panel: false, claimed: false, updated: Date.now() };
  try {
    await sessionStore.set({ [TAB_PREFIX + aiTab.id]: stored });
  } catch (e) {
    log("could not store the image (too large?)", { message: e.message, bytes: (task.image || "").length });
    chrome.tabs.remove(aiTab.id).catch(() => {});
    return { ok: false, error: "could not hold the image in memory" };
  }
  return { ok: true, tabId: aiTab.id };
}

async function deliverImage(image, tab, panelOpen, intent) {
  const s = await getSettings();
  const r = resolveIntent(intent, s);
  log("deliverImage", { type: intent.type, via: intent.via, kind: r.kind, preset: r.presetId, bytes: image.base64.length, engine: s.ocrEngine });

  // 1) Google Lens results page (screenshot / area searches only)
  if (intent.type === "search" && s.searchDestination === "lens") {
    if (await panelOpen) closePanel(tab && tab.id); // opened on a guess
    openLensWithImage(image.base64, s);
    return { ok: true, where: "lens" };
  }

  const task = buildTask(image, tab, r, intent, s);

  // 2) the offline reader (only for plain "copy exact text")
  if (task.kind === "extract" && task.presetId === "copy" && s.ocrEngine !== "ai") {
    if (await panelOpen) closePanel(tab && tab.id);
    if (await runLocalTask(task, image, s, s.ocrEngine === "auto")) return { ok: true, where: "local" };
    // "auto" and the reader was unsure: carry on with Google below
  }

  // 3) the side panel
  if (s.openIn === "sidepanel") {
    const opened = (await panelOpen) || (await isPanelOpen()) || (intent.expectPanel ? await pollPanelOpen(1500) : false);
    if (opened) {
      task.panel = true;
      const choose = s.fPicker && !intent.selfTest;
      if (choose) task.stage = "choose"; // the panel asks which prompt to use
      try {
        await sessionStore.set({ [PANEL_KEY]: task });
      } catch (e) {
        log("could not store the image (too large?)", { message: e.message, bytes: image.base64.length });
        return { ok: false, error: "could not hold the image in memory" };
      }
      if (!choose) rememberPrompt(s, r.prompt, r.historyKind, intent.via);
      log("side-panel task created", { id: task.id, kind: task.kind, stage: task.stage, mime: image.mime, bytes: image.base64.length });
      return { ok: true, where: "sidepanel", choose };
    }
    log("side panel did not open, using a new tab instead");
  } else if (await panelOpen) {
    closePanel(tab && tab.id); // opened on a guess, but the setting says new tab
  }

  // 4) a new tab
  const res = await openInTab(task, tab);
  if (!res.ok) return res;
  rememberPrompt(s, r.prompt, r.historyKind, intent.via);
  log("new-tab task created", { aiTab: res.tabId, kind: task.kind, mime: image.mime, bytes: image.base64.length });
  return { ok: true, where: "tab" };
}

async function startImageTask(source, tab, panelOpen, intent) {
  const kind = source.capture ? "screenshot-crop" : source.base64 ? "bytes-from-page" : "url";
  log("startImageTask", { kind, via: intent.via, url: source.url ? source.url.slice(0, 200) : undefined, fromTab: tab && tab.id });
  let image;
  try {
    image = await prepareImage(source, tab);
  } catch (e) {
    log("could not get the image", { kind, message: e.message });
    return { ok: false, error: e.message, canCapture: !source.capture };
  }
  const res = await deliverImage(image, tab, panelOpen, intent);
  return res.ok ? res : { ...res, canCapture: !source.capture };
}

// ---------- the side panel could not do it -> redo in a normal tab ----------

async function moveTaskToTab(id, reason) {
  const task = await getTask(PANEL_KEY);
  if (!task || (id && task.id !== id)) return { ok: false, reason: "no such side-panel task" };
  if (task.kind === "open") {
    log("side panel -> new tab (plain page)", { reason });
    await removeTask(PANEL_KEY, task.id);
    await chrome.tabs.create({ url: task.url || AI_MODE_URL });
    return { ok: true };
  }
  if (task.stage !== "attach" || !task.image) return { ok: false, reason: "already sent" };
  log("side panel -> new tab", { reason });
  const res = await openInTab({ ...task, fromPanel: true }, null);
  if (!res.ok) return res;
  await removeTask(PANEL_KEY, task.id);
  toastTab(task.sourceTabId, "Side panel couldn't show Google here — opened it in a new tab instead.", "error");
  return { ok: true, tabId: res.tabId };
}

// ---------- the prompt picker (side panel asks, then tells us) ----------

async function chooseForTask(id, choice) {
  const task = await getTask(PANEL_KEY);
  if (!task || task.id !== id || task.stage !== "choose") return { ok: false, reason: "nothing to choose for" };
  const s = await getSettings();
  let patch;
  let histKind = "preset";
  let histText;
  if (choice && choice.presetId) {
    const p = TK.presetById(s, choice.presetId);
    patch = { kind: p.mode === "ask" ? "ask" : "extract", prompt: TK.finalizePrompt(p), presetId: p.id, label: p.name };
    histText = patch.prompt;
  } else {
    const text = String((choice && choice.prompt) || "").trim();
    if (!text) return { ok: false, reason: "empty prompt" };
    const mode = choice && choice.mode === "extract" ? "extract" : "ask";
    patch = { kind: mode, prompt: TK.finalizePrompt({ mode, prompt: text }), presetId: null, label: "Custom" };
    histKind = "custom";
    histText = text;
  }
  patch.autoSend = !!s.autoSend && !!patch.prompt;
  patch.preview = !!s.fPreview && patch.kind === "extract";
  patch.stage = "attach";

  if (patch.kind === "extract" && patch.presetId === "copy" && s.ocrEngine !== "ai") {
    const merged = { ...task, ...patch };
    const done = await runLocalTask(merged, { base64: task.image, mime: task.mime, name: task.name }, s, s.ocrEngine === "auto");
    if (done) {
      await removeTask(PANEL_KEY, id);
      return { ok: true, where: "local" };
    }
  }
  await updateTask(PANEL_KEY, patch, id);
  rememberPrompt(s, histText, histKind, "picker");
  return { ok: true, where: "sidepanel" };
}

// ---------- plain AI Mode (no image): command, selection, history "ask" ----------

async function openAiWithPrompt(prompt, tab, panelOpen, via, histKind, expectPanel) {
  const s = await getSettings();
  const text = String(prompt || "").trim();
  const url = text ? "https://www.google.com/search?udm=50&q=" + encodeURIComponent(text) : aiHome(s);
  log("openAiWithPrompt", { via, hasPrompt: !!text, url: url.slice(0, 200), openIn: s.openIn });
  rememberPrompt(s, text, histKind || "default", via);
  if (s.openIn === "sidepanel") {
    if ((await panelOpen) || (await isPanelOpen()) || (expectPanel ? await pollPanelOpen(1500) : false)) {
      await sessionStore.set({
        [PANEL_KEY]: { id: newId(), kind: "open", panel: true, tabId: null, claimed: false, stage: "attach", url, label: via, sourceTabId: tab ? tab.id : null, sourceWindowId: tab ? tab.windowId : null, updated: Date.now() }
      });
      return { ok: true, where: "sidepanel" };
    }
    log("side panel did not open, using a new tab instead");
  } else if (await panelOpen) {
    closePanel(tab && tab.id);
  }
  const props = { url };
  if (tab && tab.id != null && tab.id >= 0) {
    props.openerTabId = tab.id;
    if (typeof tab.index === "number") props.index = tab.index + 1;
    if (tab.windowId != null) props.windowId = tab.windowId;
  }
  await chrome.tabs.create(props).catch(() => chrome.tabs.create({ url }));
  return { ok: true, where: "tab" };
}

// ---------- screenshots, areas, whole pages ----------

// Order matters: the screenshot is requested FIRST; only then is the side panel opened (it
// narrows the page, which would change what is captured). Both calls happen in the same tick
// because open() needs the user action.
function searchFullScreen(tab, intent) {
  const s = currentSettings();
  const shot = chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const panelOpen = openPanelIf(tab, !intent.expectPanel && wantsPanel(s, intent.type === "text" ? "text" : "search"));
  flashBadge("…");
  return (async () => {
    try {
      const image = await dataUrlToImage(await shot);
      const res = await deliverImage(image, tab, panelOpen, intent);
      if (!res.ok) throw new Error(res.error);
    } catch (e) {
      log("searchFullScreen: ERROR", { message: e.message });
      flashBadge("!", "#d93025");
      toastTab(tab.id, "Couldn't capture the page: " + e.message, "error");
    }
  })();
}

// Capture first (before any overlay is drawn), then let the user drag a rectangle, then crop.
// (The side panel opens only AFTER the drag, so the screenshot is of the page exactly as you saw it.)
async function startAreaSelection(tab, intent) {
  log("startAreaSelection", { tabId: tab.id, type: intent.type, via: intent.via });
  try {
    const dataUrl = await captureClean(tab);
    pendingCaptures.set(tab.id, dataUrl);
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["area-select.css"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (i) => {
        window.__tkAreaIntent = i;
      },
      args: [intent]
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["area-select.js"] });
  } catch (e) {
    log("startAreaSelection: ERROR", { message: e.message });
    pendingCaptures.delete(tab.id);
    flashBadge("!", "#d93025");
  }
}

// The mouse-up that ends the drag is the user action that lets us open the side panel.
function onAreaSelected(msg, sender) {
  const tab = sender.tab;
  const intent = msg.intent && msg.intent.type ? msg.intent : { type: "search", via: "area" };
  const s = currentSettings();
  const kept = pendingCaptures.get(tab.id);
  pendingCaptures.delete(tab.id);
  // The service worker may have been restarted during a long drag and lost the screenshot:
  // take a new one (the overlay is already gone). Requested BEFORE the panel opens.
  const shot = kept ? Promise.resolve(kept) : chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const panelOpen = openPanelIf(tab, wantsPanel(s, intent.type === "text" ? "text" : "search"));
  flashBadge("…");
  return (async () => {
    try {
      const image = await cropDataUrl(await shot, msg.rect, msg.devicePixelRatio || 1);
      const res = await deliverImage(image, tab, panelOpen, intent);
      if (!res.ok) throw new Error(res.error);
    } catch (e) {
      log("area crop/deliver: ERROR", { message: e.message });
      flashBadge("!", "#d93025");
      toastTab(tab.id, "Couldn't use that area: " + e.message, "error");
    }
  })();
}

// The capture takes several seconds, so the "user action" that could open the side panel is long
// gone by the end. If the panel isn't open yet we keep the picture and show a small button on the
// page; pressing it is a fresh user action.
async function startScrollCapture(tab, intent) {
  log("startScrollCapture", { tabId: tab.id });
  try {
    const s = currentSettings();
    // No notes on the page while capturing (they would be in every screenshot): progress goes on the icon.
    flashBadge("…");
    const image = await scrollCapture(tab, (n, total) => flashBadge(n + "/" + total));
    const needsClick = wantsPanel(s, "search") && !(await isPanelOpen());
    if (!needsClick) {
      const res = await deliverImage(image, tab, Promise.resolve(false), intent);
      if (!res.ok) throw new Error(res.error);
      toastTab(tab.id, "Page captured and sent ✓", "ok");
      return;
    }
    const token = newId();
    await sessionStore.set({ ["tk:offer:" + token]: { image, intent, tabId: tab.id, updated: Date.now() } });
    chrome.tabs.sendMessage(tab.id, { action: "offer", token, text: "Whole page captured. Send it to Google AI Mode?", button: "Send" }, { frameId: 0 }).catch(() => {
      log("could not show the offer on the page");
    });
  } catch (e) {
    log("startScrollCapture: ERROR", { message: e.message });
    flashBadge("!", "#d93025");
    toastTab(tab.id, "Couldn't capture the page: " + e.message, "error");
  }
}

// The button on the page was pressed: open the panel FIRST, then deliver.
function onOfferAccepted(msg, sender) {
  const tab = sender.tab;
  const panelOpen = tryOpenPanel(tab);
  return (async () => {
    const key = "tk:offer:" + msg.token;
    const got = await sessionStore.get(key);
    const offer = got[key];
    await sessionStore.remove(key);
    if (!offer) return { ok: false, error: "the capture is gone (too old)" };
    return deliverImage(offer.image, tab, panelOpen, offer.intent);
  })();
}

// ---------- the side panel's own buttons ----------

async function panelCapture(purpose, windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab || tab.id == null) return { ok: false, error: "no active tab" };
  log("panelCapture", { purpose, tabId: tab.id });
  if (purpose === "screen") searchFullScreen(tab, { type: "search", via: "panel: screenshot", expectPanel: true });
  else if (purpose === "area") startAreaSelection(tab, { type: "search", via: "panel: area", expectPanel: true });
  else if (purpose === "areaText") startAreaSelection(tab, { type: "text", via: "panel: area text", expectPanel: true });
  else if (purpose === "scroll") startScrollCapture(tab, { type: "search", via: "panel: whole page", expectPanel: true });
  else return { ok: false, error: "unknown action" };
  return { ok: true };
}

// ---------- the self-test ----------

async function runSelfTest(tab, panelOpen, expectPanel) {
  const expected = "LensKit TEST " + String(Math.floor(10000 + Math.random() * 89999));
  const image = await makeTestImage(expected);
  await chrome.storage.local.remove("selfTestResult");
  return deliverImage(image, tab, panelOpen, { type: "text", via: "self-test", selfTest: { expected }, expectPanel: !!expectPanel });
}

// ---------- Google Lens ----------

function searchImageUrl(imageUrl) {
  log("searching by image URL", { imageUrl });
  chrome.tabs.create({ url: "https://lens.google.com/uploadbyurl?url=" + encodeURIComponent(imageUrl) });
}

// Opens the real lens.google.com and simulates dropping the file onto its own upload zone —
// the same thing you'd do by hand (see lens-inject.js).
function openLensWithImage(base64, s) {
  log("openLensWithImage: opening tab", { bytes: base64.length });
  chrome.tabs.create({ url: LENS_URL }, (newTab) => {
    if (chrome.runtime.lastError || !newTab) {
      log("openLensWithImage: tab creation failed", { error: chrome.runtime.lastError && chrome.runtime.lastError.message });
      return;
    }
    waitForLensAndSend(newTab.id, base64, s);
  });
}

function waitForLensAndSend(tabId, base64, s, attempt = 1, maxAttempts = 25) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      log("waitForLensAndSend: tab disappeared", { error: chrome.runtime.lastError && chrome.runtime.lastError.message });
      return;
    }
    if (tab.status !== "complete") {
      setTimeout(() => waitForLensAndSend(tabId, base64, s, attempt, maxAttempts), 300);
      return;
    }
    chrome.tabs
      .sendMessage(tabId, { action: "checkLensReady" })
      .then((response) => {
        log("waitForLensAndSend: checkLensReady", { attempt, response });
        if (!(response && response.ready)) throw new Error("not ready yet");
        chrome.tabs.sendMessage(tabId, { action: "searchScreenshot", screenshot: base64 }).then((r) => log("searchScreenshot sent", { response: r }));
        startLensFollow(tabId, s);
      })
      .catch((e) => {
        if (attempt < maxAttempts) setTimeout(() => waitForLensAndSend(tabId, base64, s, attempt + 1, maxAttempts), 300);
        else {
          log("waitForLensAndSend: GAVE UP", { message: e.message });
          flashBadge("!", "#d93025");
        }
      });
  });
}

// After a Lens search, leave a task for lens-follow.js: type your prompt into the results page's
// search box, click "AI Mode", send the prompt there.
async function startLensFollow(tabId, s0) {
  const s = await getSettings();
  if (!s.autoAiMode) return;
  const prompt = (s.defaultPrompt || "").trim();
  const task = { tabId, stage: prompt ? "type" : "click", prompt, ts: Date.now() };
  await chrome.storage.local.set({ lensTask: task });
  rememberPrompt(s, prompt, "default", "Lens follow-up");
  log("Lens follow-up task created", { tabId, startStage: task.stage });
  chrome.tabs.sendMessage(tabId, { action: "startLensTask", task }).catch(() => {});
}

async function getLensTaskFor(tabId) {
  const { lensTask } = await chrome.storage.local.get("lensTask");
  if (!lensTask || lensTask.tabId !== tabId) return null;
  if (Date.now() - lensTask.ts > 60000) {
    await chrome.storage.local.remove("lensTask");
    return null;
  }
  return lensTask;
}

async function updateLensTask(tabId, stage) {
  const t = await getLensTaskFor(tabId);
  if (t) await chrome.storage.local.set({ lensTask: { ...t, stage } });
}
