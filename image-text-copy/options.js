// options.js — the settings page. Values live in chrome.storage.local; the
// defaults come from defaults.js (ITC_DEFAULTS), shared with background.js.

(function () {
  const $ = (id) => document.getElementById(id);
  const radio = (name) => document.querySelector('input[name="' + name + '"]:checked');
  const setRadio = (name, value) => {
    const el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  };

  function show(s) {
    $("prompt").value = s.prompt;
    $("autoSend").checked = !!s.autoSend;
    setRadio("openIn", s.openIn);
    setRadio("afterCopy", s.afterCopy);
    refresh();
  }

  function refresh() {
    const p = $("prompt").value;
    $("warn").textContent = /code block/i.test(p)
      ? ""
      : "Tip: keep a sentence telling Google to put the text inside one code block — that is how the extension finds exactly the text and nothing else.";
    const inTab = (radio("openIn") || {}).value === "tab";
    $("afterBox").disabled = !inTab;
  }

  function flash(text) {
    $("saved").textContent = text;
    setTimeout(() => {
      if ($("saved").textContent === text) $("saved").textContent = "";
    }, 2500);
  }

  async function save() {
    const prompt = $("prompt").value.trim() || ITC_DEFAULTS.prompt;
    await chrome.storage.local.set({
      prompt,
      autoSend: $("autoSend").checked,
      openIn: (radio("openIn") || {}).value || ITC_DEFAULTS.openIn,
      afterCopy: (radio("afterCopy") || {}).value || ITC_DEFAULTS.afterCopy
    });
    $("prompt").value = prompt;
    refresh();
    flash("Saved ✓");
  }

  chrome.storage.local.get(ITC_DEFAULTS).then(show);

  $("save").addEventListener("click", save);
  $("prompt").addEventListener("input", refresh);
  for (const el of document.querySelectorAll('input[name="openIn"]')) el.addEventListener("change", refresh);
  $("resetPrompt").addEventListener("click", () => {
    $("prompt").value = ITC_DEFAULTS.prompt;
    refresh();
  });
  $("reset").addEventListener("click", async () => {
    await chrome.storage.local.set({ ...ITC_DEFAULTS });
    show(ITC_DEFAULTS);
    flash("Reset ✓");
  });
})();
