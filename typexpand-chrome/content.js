/* Typexpand content script: trigger detection, typing / pasting, clipboard typing. */
(() => {
  if (window.__typexpand) return;
  window.__typexpand = true;

  let settings = { ...TE_DEFAULT_SETTINGS };
  let snippets = [];
  let busy = false; // true while we are inserting text (ignores our own input events)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let insFails = 0; // insertText calls that the page/browser refused during one emit

  // Diagnostic log: sent to the background, which keeps the last 300 entries.
  // Only lengths and element descriptions are logged, never clipboard or typed text.
  function dbg(ev, data) {
    if (settings.debugLog === false) return;
    try {
      Promise.resolve(api.runtime.sendMessage({
        type: 'log',
        entry: { t: Date.now(), src: window === window.top ? 'top' : 'frame', host: location.hostname, ev, ...data }
      })).catch(() => {});
    } catch (_) { /* extension context gone */ }
  }

  function describe(el) {
    if (!el || !el.getAttribute) return null;
    const root = el.getRootNode && el.getRootNode();
    return {
      tag: el.tagName,
      type: el.type || undefined,
      role: el.getAttribute('role') || undefined,
      id: el.id ? String(el.id).slice(0, 40) : undefined,
      editable: !!el.isContentEditable,
      readOnly: !!el.readOnly,
      disabled: !!el.disabled,
      shadow: root instanceof ShadowRoot,
      inDialog: !!(el.closest && el.closest('dialog,[role=dialog],[aria-modal=true]'))
    };
  }
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
        dbg('clip-bg', { ok: true, len: r.text.length });
        if (el && el.focus && !stillFocused(el)) el.focus({ preventScroll: true });
        return r.text.split(CURSOR_MARK).join('');
      }
      dbg('clip-bg', { ok: false, reply: r ? 'null-text' : 'no-reply' });
    } catch (e) {
      dbg('clip-bg', { ok: false, err: String((e && e.message) || e).slice(0, 120) });
    }
    // Fallback 1: read straight from the page context. Does not move focus.
    try {
      text = await navigator.clipboard.readText();
      dbg('clip-page-readText', { ok: true, len: text.length });
    } catch (e) {
      dbg('clip-page-readText', { ok: false, err: String((e && e.name) || e) });
    }
    // Fallback 2 (last resort): execCommand('paste') into a hidden textarea. It moves
    // focus, which can close focus-trapped dialogs such as GitHub's search box.
    if (text === null) {
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
        dbg('clip-page-paste', { ok, len: text === null ? -1 : text.length });
      } catch (e) {
        dbg('clip-page-paste', { ok: false, err: String((e && e.name) || e) });
      }
    }
    if (text === null) toast('Typexpand: could not read the clipboard. Press Alt+Shift+L to copy the debug log.');
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
        if (!insertChunk(el, ch)) insFails++;
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
    const isCtl = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const lenBefore = isCtl ? el.value.length : null;
    insFails = 0;
    let ok = true;
    if (mode === 'paste') insertBlock(el, full);
    else ok = await typeText(el, full);
    if (ok && after) moveCaretBack(el, after);
    dbg('emit', {
      mode, expected: full.length, focusKept: ok, insertFails: insFails,
      valueGrew: isCtl ? el.value.length - lenBefore : 'n/a', el: describe(el)
    });
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
      dbg('expand', { viaBuffer, mode, trigLen: sn.trigger.length, textLen: text.length, el: describe(el) });
      if (!stillFocused(el)) { dbg('expand-abort', { reason: 'focus lost while reading clipboard' }); return; }
      // Re-read: focus juggling may have moved things.
      const ctx = viaBuffer ? bufferCtx(el) : getBefore(el);
      if (!ctx || !ctx.text.endsWith(sn.trigger)) { dbg('expand-abort', { reason: 'trigger no longer before caret' }); return; }
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
      dbg('expand-error', { err: String((e && e.message) || e).slice(0, 120) });
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
    const el = deepActive();
    const here = document.hasFocus(); // only the frame that has focus reports, to keep the log readable
    if (busy) { if (here) dbg('skip', { reason: 'busy' }); return; }
    if (!el || !isEditableTarget(el) || el.readOnly || el.disabled) {
      if (here) dbg('skip', { reason: 'focused element is not an editable field', active: describe(el) });
      return;
    }
    dbg('hotkey', { mode, el: describe(el) });
    busy = true;
    try {
      const text = await readClipboard(el);
      if (text) await emit(el, text, mode === 'paste' ? 'paste' : 'type');
      else dbg('skip', { reason: 'clipboard empty or unreadable' });
    } catch (e) {
      dbg('hotkey-error', { err: String((e && e.message) || e).slice(0, 120) });
      console.warn('[Typexpand]', e);
    } finally {
      busy = false;
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'clipboard') runClipboard(msg.mode);
    else if (msg.type === 'toast') toast(msg.text);
  });
})();
