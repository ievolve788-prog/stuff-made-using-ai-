/* Typexpand content script: trigger detection, typing / pasting, clipboard typing. */
(() => {
  if (window.__typexpand) return;
  window.__typexpand = true;

  let settings = { ...TE_DEFAULT_SETTINGS };
  let snippets = [];
  let busy = false; // true while we are inserting text (ignores our own input events)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Every text-like input type. Password fields are gated by settings.passwordFields.
  const EXPAND_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'number', 'password']);
  const CLIPBOARD_TYPES = EXPAND_TYPES;

  // Rolling buffer of what was just typed. It is the fallback for places where the
  // text before the caret can't be read (email/number inputs, editors with odd DOM).
  // It lives only in memory, holds at most the longest trigger's length, and is
  // never stored or sent anywhere.
  let buf = '';
  let bufEl = null;
  let maxLen = 0;
  const resetBuf = () => { buf = ''; bufEl = null; };

  function refresh(d) {
    settings = d.settings;
    snippets = d.snippets
      .filter((s) => s.enabled !== false && s.trigger)
      .sort((a, b) => b.trigger.length - a.trigger.length); // longest trigger wins
    maxLen = snippets.length ? snippets[0].trigger.length : 0;
    resetBuf();
  }
  teLoad().then(refresh);
  api.storage.onChanged.addListener((_c, area) => {
    if (area === 'local') teLoad().then(refresh);
  });

  /* ---------- helpers ---------- */

  function excluded() {
    const h = location.hostname;
    return (settings.excludedSites || []).some((s) => s && (h === s || h.endsWith('.' + s)));
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function stillFocused(el) {
    const a = deepActive();
    return !!a && (a === el || (el.contains && el.contains(a)));
  }

  const isTextControl = (el) =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && EXPAND_TYPES.has(el.type));

  const isEditableTarget = (el) =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && CLIPBOARD_TYPES.has(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);

  // Text before the caret plus a function that selects the last `len` characters of it.
  function getBefore(el) {
    if (isTextControl(el)) {
      if (el.readOnly || el.disabled) return null;
      const pos = el.selectionStart;
      if (pos === null || pos !== el.selectionEnd) return null;
      return {
        text: el.value.slice(0, pos),
        select: (len) => el.setSelectionRange(pos - len, pos)
      };
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
      const node = sel.anchorNode;
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      const off = sel.anchorOffset;
      return {
        text: node.data.slice(0, off),
        select: (len) => {
          const r = document.createRange();
          r.setStart(node, off - len);
          r.setEnd(node, off);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      };
    }
    return null;
  }

  function toast(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;bottom:20px;right:20px;background:#222;color:#fff;' +
      'font:13px system-ui,sans-serif;padding:8px 12px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 2500);
  }

  /* ---------- clipboard ---------- */

  async function readClipboard(el) {
    let text = null;
    // Best: ask the extension's background to read it. The page (and any script
    // that blocks pasting on it) never sees a paste event.
    try {
      const r = await api.runtime.sendMessage({ type: 'readClipboard' });
      if (r && typeof r.text === 'string') {
        if (el && el.focus && !stillFocused(el)) el.focus({ preventScroll: true });
        return r.text.split(CURSOR_MARK).join('');
      }
    } catch (_) { /* fall back to reading it from the page */ }
    // Fallback: execCommand('paste') into a hidden textarea. Works with the
    // clipboardRead permission in both Chrome and Firefox without a page prompt.
    try {
      const sel = window.getSelection();
      const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const ta = document.createElement('textarea');
      ta.setAttribute('aria-hidden', 'true');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.documentElement.appendChild(ta);
      ta.focus({ preventScroll: true });
      const ok = document.execCommand('paste');
      text = ok ? ta.value : null;
      ta.remove();
      if (el && el.focus) el.focus({ preventScroll: true });
      if (saved && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        sel.removeAllRanges();
        sel.addRange(saved);
      }
    } catch (_) { /* fall through */ }
    if (text === null) {
      try { text = await navigator.clipboard.readText(); } catch (_) { /* ignore */ }
    }
    if (text === null) toast('Typexpand: could not read the clipboard');
    return (text || '').split(CURSOR_MARK).join('');
  }

  /* ---------- inserting text ---------- */

  function insertChunk(el, s) {
    if (!s) return true;
    if (document.execCommand('insertText', false, s)) return true;
    if (isTextControl(el)) {
      try {
        el.setRangeText(s, el.selectionStart, el.selectionEnd, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: s }));
        return true;
      } catch (_) { /* ignore */ }
    }
    return false;
  }

  function newline(el) {
    if (el instanceof HTMLTextAreaElement) insertChunk(el, '\n');
    else if (el instanceof HTMLInputElement) insertChunk(el, ' ');
    // Shift+Enter-style line break: safe in chat boxes (does not "send").
    else if (!document.execCommand('insertLineBreak')) document.execCommand('insertParagraph');
  }

  function fireKey(el, type, key) {
    if (!settings.keyEvents) return;
    el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, composed: true }));
  }

  // Paste mode: everything in one go.
  function insertBlock(el, s) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      insertChunk(el, s);
      return;
    }
    s.split('\n').forEach((line, i) => {
      if (i > 0) newline(el);
      insertChunk(el, line);
    });
  }

  // Type mode: one character at a time, like real keystrokes.
  async function typeText(el, s) {
    for (const ch of Array.from(s)) {
      if (!stillFocused(el)) return false; // user clicked away: stop
      if (ch === '\n') {
        newline(el);
      } else {
        fireKey(el, 'keydown', ch);
        insertChunk(el, ch);
        fireKey(el, 'keyup', ch);
      }
      if (settings.typeDelay > 0) await sleep(settings.typeDelay);
    }
    return true;
  }

  function moveCaretBack(el, after) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      try {
        const p = Math.max(0, el.selectionEnd - after.length);
        el.setSelectionRange(p, p);
      } catch (_) { /* ignore */ }
      return;
    }
    const sel = window.getSelection();
    const n = Array.from(after).length;
    for (let i = 0; i < n; i++) sel.modify('move', 'backward', 'character');
  }

  async function emit(el, text, mode) {
    text = text.replace(/\r\n?/g, '\n');
    if (el instanceof HTMLInputElement) text = text.replace(/\n/g, ' ');
    const i = text.indexOf(CURSOR_MARK);
    const before = i < 0 ? text : text.slice(0, i);
    const after = i < 0 ? '' : text.slice(i + 1).split(CURSOR_MARK).join('');
    const full = before + after;
    let ok = true;
    if (mode === 'paste') insertBlock(el, full);
    else ok = await typeText(el, full);
    if (ok && after) moveCaretBack(el, after);
  }

  /* ---------- trigger detection ---------- */

  function boundaryOk(text, trigger) {
    const i = text.length - trigger.length;
    return i === 0 || !/[\p{L}\p{N}_]/u.test(text[i - 1]);
  }

  // Context from the keystroke buffer: no caret access, so the trigger is removed
  // by "backspacing" it (execCommand('delete') once per character).
  function bufferCtx(el) {
    if (bufEl !== el) return null;
    return {
      text: buf,
      select: null,
      backspace: (n) => {
        for (let i = 0; i < n; i++) {
          if (!document.execCommand('delete')) return false;
        }
        return true;
      }
    };
  }

  async function expand(el, sn, viaBuffer) {
    busy = true; // set synchronously, before any await
    try {
      const mode = sn.mode || settings.mode;
      const text = await teRender(sn.replace, () => readClipboard(el));
      if (!stillFocused(el)) return;
      // Re-read: focus juggling may have moved things.
      const ctx = viaBuffer ? bufferCtx(el) : getBefore(el);
      if (!ctx || !ctx.text.endsWith(sn.trigger)) return;
      const len = Array.from(sn.trigger).length;
      if (viaBuffer) {
        if (!ctx.backspace(len)) return;
      } else {
        ctx.select(sn.trigger.length);
        if (!document.execCommand('delete') && isTextControl(el)) {
          el.setRangeText('', el.selectionStart, el.selectionEnd, 'end');
        }
      }
      resetBuf();
      await emit(el, text, mode);
    } catch (e) {
      console.warn('[Typexpand]', e);
    } finally {
      busy = false;
      resetBuf();
    }
  }

  function skipEl(el) {
    return el instanceof HTMLInputElement && el.type === 'password' && !settings.passwordFields;
  }

  document.addEventListener(
    'input',
    (e) => {
      if (!e.isTrusted || busy || !settings.enabled || !maxLen) return;
      if (excluded()) return;
      const el = e.composedPath()[0];
      if (!(el instanceof HTMLElement) || skipEl(el)) return;

      // Keep the rolling buffer up to date.
      if (e.inputType === 'insertText' && e.data) {
        if (bufEl !== el) { buf = ''; bufEl = el; }
        buf = (buf + e.data).slice(-maxLen);
      } else if (e.inputType === 'deleteContentBackward' && bufEl === el) {
        buf = buf.slice(0, -1);
      } else {
        resetBuf();
      }
      if (e.inputType !== 'insertText') return;

      // Preferred: read the text before the caret. Fallback: the buffer.
      const ctx = getBefore(el);
      const viaBuffer = !ctx;
      const c = ctx || bufferCtx(el);
      if (!c) return;
      const sn = snippets.find((s) => c.text.endsWith(s.trigger) && (!s.word || boundaryOk(c.text, s.trigger)));
      if (sn) expand(el, sn, viaBuffer);
    },
    true
  );

  // Anything that moves the caret invalidates the buffer.
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && /^(Arrow|Home$|End$|Page|Tab$|Enter$|Escape$|Delete$)/.test(e.key)) resetBuf();
  }, true);
  document.addEventListener('mousedown', resetBuf, true);
  document.addEventListener('focusin', resetBuf, true);

  /* ---------- clipboard commands (hotkey / context menu) ---------- */

  async function runClipboard(mode) {
    if (busy) return;
    const el = deepActive();
    if (!el || !isEditableTarget(el) || el.readOnly || el.disabled) return;
    busy = true;
    try {
      const text = await readClipboard(el);
      if (text) await emit(el, text, mode === 'paste' ? 'paste' : 'type');
    } catch (e) {
      console.warn('[Typexpand]', e);
    } finally {
      busy = false;
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'clipboard') runClipboard(msg.mode);
  });
})();
