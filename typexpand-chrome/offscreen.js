// Chrome-only helper page: the service worker has no DOM, so clipboard reads happen here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'offscreenRead') return;
  let text = null;
  try {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    if (document.execCommand('paste')) text = ta.value;
    ta.remove();
  } catch (_) { /* ignore */ }
  if (text !== null) { sendResponse({ text }); return; }
  navigator.clipboard.readText().then((t) => sendResponse({ text: t }), () => sendResponse({ text: null }));
  return true;
});
