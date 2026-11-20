(async () => {
  const { pending } = await chrome.storage.local.get("pending");
  if (!pending || Date.now() - pending.ts > 60000) return;
  await chrome.storage.local.remove("pending");
  dbg("gemini", "page loaded with pending request", pending.url);

  const prompt =
    `Summarise this YouTube video: ${pending.url} ` +
    `Start with a 2-3 sentence TL;DR, then give the key points as bullets, ` +
    `and finish with any important takeaways or timestamps.`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = fn();
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  const editor = await waitFor(
    () =>
      document.querySelector("rich-textarea .ql-editor") ||
      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"]')
  );
  if (!editor) {
    dbg("gemini", "EDITOR NOT FOUND after 20s");
    await dbgCopy();
    return;
  }
  dbg("gemini", "editor found", editor.className);

  editor.focus();
  const inserted = document.execCommand("insertText", false, prompt);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  dbg("gemini", "text inserted", { inserted, length: (editor.textContent || "").length });

  const sendBtn = await waitFor(() => {
    const b = document.querySelector(
      'button.send-button, button[aria-label*="Send" i], button[mat-icon-button][aria-label*="Send" i]'
    );
    return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" ? b : null;
  }, 8000);

  if (sendBtn) {
    sendBtn.click();
    dbg("gemini", "send button clicked", sendBtn.getAttribute("aria-label"));
  } else {
    dbg("gemini", "send button NOT found/enabled, pressing Enter");
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  }

  await sleep(800);
  await dbgCopy();
})();
