/* Runs on gemini.google.com: attaches the screenshot, fills the prompt, optionally presses send. */
(() => {
  if (window.__gsGemini) return;
  window.__gsGemini = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (level, text, data) => chrome.runtime.sendMessage({ type: 'LOG', src: 'gemini', level, text, data }).catch(() => {});

  async function waitFor(fn, timeout = 20000, step = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // Gemini's DOM changes now and then; several fallbacks are tried and logged.
  const EDITOR_SELECTORS = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea'
  ];
  const SEND_SELECTORS = [
    'button.send-button',
    'button[aria-label*="Send message" i]',
    'button[aria-label="Send" i]',
    'button[mat-icon-button][aria-label*="Send" i]'
  ];
  const ATTACH_SELECTOR = 'uploader-file-preview, [data-test-id*="file-preview"], [class*="file-preview"], img[src^="blob:"], img[src^="data:image"]';

  const findEditor = () => {
    for (const sel of EDITOR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return { el, sel };
    }
    return null;
  };
  const countAttachments = () => document.querySelectorAll(ATTACH_SELECTOR).length;
  const isEnabled = (b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  const findSendBtn = () => {
    for (const sel of SEND_SELECTORS) {
      const b = document.querySelector(sel);
      if (isEnabled(b)) return { b, sel };
    }
    for (const b of document.querySelectorAll('button')) {
      if (/send|submit/i.test(b.getAttribute('aria-label') || '') && isEnabled(b)) return { b, sel: 'aria-label scan' };
    }
    return null;
  };

  function dataUrlToFile(dataUrl, name) {
    const [head, b64] = dataUrl.split(',');
    const mime = head.match(/:(.*?);/)[1];
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], name, { type: mime });
  }

  function pasteFile(el, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
  }
  function dropFile(el, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
    }
  }

  function insertPrompt(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch {}
    if (!ok || !el.innerText.includes(text.slice(0, Math.min(20, text.length)))) {
      el.innerHTML = '';
      for (const line of text.split('\n')) {
        const p = document.createElement('p');
        p.textContent = line || '\u200b';
        el.appendChild(p);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      log('WARN', 'execCommand failed, used DOM fallback for prompt');
    }
    return true;
  }

  function banner(text, isError) {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:${isError ? '#b3261e' : '#1f2430'};color:#fff;font:13px system-ui,sans-serif;padding:9px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.35);`;
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 7000);
  }

  let runId = null;
  const done = (ok, reason, t0) => chrome.runtime.sendMessage({ type: 'GEMINI_DONE', id: runId, ok, reason, ms: Date.now() - t0 }).catch(() => {});

  async function run({ image, prompt, autoSubmit, id }) {
    const t0 = Date.now();
    runId = id || null;
    try {
      log('INFO', 'run start', { url: location.href, promptLen: prompt.length, autoSubmit, imgLen: image.length });
      const found = await waitFor(findEditor, 30000);
      if (!found) {
        log('ERROR', 'prompt box not found', { title: document.title, url: location.href, signInLink: !!document.querySelector('a[href*="accounts.google.com"]') });
        banner('Gemini Snap: prompt box not found — are you signed in to Gemini?', true);
        return done(false, 'editor not found', t0);
      }
      const { el, sel } = found;
      log('INFO', 'editor found', { sel, tag: el.tagName });

      const before = countAttachments();
      const file = dataUrlToFile(image, `screenshot-${Date.now()}.png`);
      log('INFO', 'file built', { bytes: file.size, type: file.type, attachmentsBefore: before });

      // Background/throttled tabs often swallow the first paste: focus the tab and retry a few times.
      chrome.runtime.sendMessage({ type: 'FOCUS_ME' }).catch(() => {});
      await sleep(400);
      let attached = false;
      for (let attempt = 1; attempt <= 3 && !attached; attempt++) {
        const cur = (findEditor() || found).el;
        pasteFile(cur, file);
        attached = await waitFor(() => countAttachments() > before, 5000, 250);
        log(attached ? 'INFO' : 'WARN', 'paste strategy', { attempt, attached: !!attached, hidden: document.hidden });
        if (!attached) { chrome.runtime.sendMessage({ type: 'FOCUS_ME' }).catch(() => {}); await sleep(600); }
      }

      if (!attached) {
        dropFile(el, file);
        attached = await waitFor(() => countAttachments() > before, 6000, 300);
        log(attached ? 'INFO' : 'WARN', 'drop strategy', { attached: !!attached });
      }
      if (!attached) {
        const input = document.querySelector('input[type="file"]');
        if (input) {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          attached = await waitFor(() => countAttachments() > before, 6000, 300);
        }
        log(attached ? 'INFO' : 'WARN', 'file-input strategy', { attached: !!attached, inputFound: !!input });
      }
      if (!attached) {
        log('ERROR', 'could not attach image automatically');
        banner('Gemini Snap: could not attach the image automatically. Use "Save PNG" in the panel and drag it in.', true);
      }

      insertPrompt(el, prompt);
      log('INFO', 'prompt inserted', { attached: !!attached });

      if (autoSubmit && !attached) {
        log('WARN', 'auto-send skipped: image missing, leaving prompt for manual fix');
        banner('Gemini Snap: image not attached, not sending. Paste it manually (Ctrl+V).', true);
        return done(false, 'image not attached', t0);
      }
      if (autoSubmit) {
        await sleep(1200);
        const btn = await waitFor(findSendBtn, 45000, 400);
        if (btn) {
          btn.b.click();
          log('INFO', 'send clicked', { sel: btn.sel });
        } else {
          log('ERROR', 'send button not found/enabled within 45s');
          banner('Gemini Snap: ready — press Enter to send (send button not detected).', true);
          return done(false, 'send button not found', t0);
        }
      } else {
        banner('Gemini Snap: image + prompt ready — edit if you like, then press Enter.');
      }
      done(!!attached, attached ? 'ok' : 'image not attached', t0);
    } catch (e) {
      log('ERROR', 'run crashed', { message: String(e && e.message || e), stack: e && e.stack });
      done(false, 'exception', t0);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (window.top !== window) return; // ignore helper sub-frames like /_/bscframe
    if (msg.type === 'GEMINI_PING') { sendResponse({ ok: true }); return; }
    if (msg.type === 'GEMINI_PASTE') { sendResponse({ ok: true }); run(msg); return; }
  });

  // Side-panel mode: the extension page embeds this frame and talks to it via postMessage.
  const parentIsPanel = window.top !== window && (location.ancestorOrigins || [])[0] && String(location.ancestorOrigins[0]).startsWith('chrome-extension://');
  if (parentIsPanel) {
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent || !e.data || !e.data.gs) return;
      if (!String(e.origin).startsWith('chrome-extension://')) return;
      if (e.data.gs === 'ping') window.parent.postMessage({ gs: 'pong' }, e.origin);
      else if (e.data.gs === 'paste') run(e.data.payload);
    });
    log('INFO', 'embedded frame ready', { url: location.href });
  }
})();
