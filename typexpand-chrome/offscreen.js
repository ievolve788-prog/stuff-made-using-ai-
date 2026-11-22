// Chrome-only helper page: the service worker has no DOM, so clipboard access happens here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'offscreenRead') {
    let text = null;
    let err = '';
    try {
      const ta = document.createElement('textarea');
      document.body.appendChild(ta);
      ta.focus();
      if (document.execCommand('paste')) text = ta.value;
      ta.remove();
    } catch (e) { err = String(e).slice(0, 80); }
    if (text !== null) { sendResponse({ text, how: 'execCommand' }); return; }
    navigator.clipboard.readText().then(
      (t) => sendResponse({ text: t, how: 'readText' }),
      (e) => sendResponse({ text: null, how: 'failed', err: String((e && e.name) || e) + (err ? ' / ' + err : '') })
    );
    return true;
  }

  if (msg.type === 'offscreenWrite') {
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = msg.text;
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (_) { /* try the async API */ }
    if (ok) { sendResponse({ ok: true }); return; }
    navigator.clipboard.writeText(msg.text).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
});
