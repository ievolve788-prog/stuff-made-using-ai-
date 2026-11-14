// options.js — loads and saves the settings. Nothing else.
// Stored in chrome.storage.local (this browser only, never sent anywhere).
// Keep DEFAULTS in sync with DEFAULT_SETTINGS in background.js.

const DEFAULTS = {
  defaultPrompt: "",
  searchDestination: "aimode",
  openIn: "sidepanel",
  autoSend: true,
  autoAiMode: false
};

const promptEl = document.getElementById("prompt");
const autoSendEl = document.getElementById("autoSend");
const autoAiEl = document.getElementById("autoAiMode");
const statusEl = document.getElementById("status");

function flash(text) {
  statusEl.textContent = text;
  setTimeout(() => (statusEl.textContent = ""), 2000);
}

function selectedDestination() {
  const picked = document.querySelector('input[name="dest"]:checked');
  return picked ? picked.value : DEFAULTS.searchDestination;
}

function selectedOpenIn() {
  const picked = document.querySelector('input[name="openIn"]:checked');
  return picked ? picked.value : DEFAULTS.openIn;
}

function updateDependentRows() {
  const aiMode = selectedDestination() === "aimode";
  // "press Send for me" only makes sense for AI Mode; "auto-click AI Mode" only for Lens.
  autoSendEl.closest(".toggle").style.opacity = aiMode ? "1" : "0.5";
  autoAiEl.closest(".toggle").style.opacity = aiMode ? "0.5" : "1";
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  promptEl.value = s.defaultPrompt;
  autoSendEl.checked = !!s.autoSend;
  autoAiEl.checked = !!s.autoAiMode;
  const radio = document.querySelector(`input[name="dest"][value="${s.searchDestination}"]`);
  (radio || document.querySelector('input[name="dest"][value="aimode"]')).checked = true;
  const where = document.querySelector(`input[name="openIn"][value="${s.openIn}"]`);
  (where || document.querySelector('input[name="openIn"][value="sidepanel"]')).checked = true;
  updateDependentRows();
}

document.querySelectorAll('input[name="dest"]').forEach((r) => r.addEventListener("change", updateDependentRows));

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    defaultPrompt: promptEl.value.trim(),
    searchDestination: selectedDestination(),
    openIn: selectedOpenIn(),
    autoSend: autoSendEl.checked,
    autoAiMode: autoAiEl.checked
  });
  flash("Saved ✓");
});

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.set(DEFAULTS);
  await load();
  flash("Reset");
});

load();
