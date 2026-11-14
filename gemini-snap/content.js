/* Injected into the page you are capturing: drag-crop overlay, full-page helpers, preview + prompt panel. */
(() => {
  if (window.__gsContentLoaded) return;
  window.__gsContentLoaded = true;

  const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});
  const log = (level, text, data) => send({ type: 'LOG', src: 'content', level, text, data });
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    switch (msg.type) {
      case 'START_SELECT': startSelect(); sendResponse({ ok: true }); break;
      case 'SHOW_PREVIEW': showPanel(msg.image, msg.mode); sendResponse({ ok: true }); break;
      case 'FULL_PREPARE': sendResponse(fullPrepare()); break;
      case 'FULL_SCROLL': fullScroll(msg).then(sendResponse); return true;
      case 'FULL_RESTORE': fullRestore(); sendResponse({ ok: true }); break;
    }
  });

  /* ---------------------- drag-and-crop selection ---------------------- */
  let selRoot = null, selCleanup = null;

  function removeSelect() {
    if (selCleanup) selCleanup();
    selCleanup = null;
    if (selRoot) selRoot.remove();
    selRoot = null;
  }

  function startSelect() {
    removePanel();
    removeSelect();
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.35);user-select:none;-webkit-user-select:none;';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;display:none;border:2px solid #4c8bf5;background:rgba(76,139,245,.10);box-shadow:0 0 0 99999px rgba(0,0,0,.45);pointer-events:none;box-sizing:border-box;';
    const tip = document.createElement('div');
    tip.textContent = 'Drag to select the area for Gemini  •  Esc to cancel';
    tip.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#1f2430;color:#fff;font:13px system-ui,sans-serif;padding:7px 14px;border-radius:999px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.35);';
    const dim = document.createElement('div');
    dim.style.cssText = 'position:fixed;background:#4c8bf5;color:#fff;font:11px system-ui,sans-serif;padding:2px 6px;border-radius:4px;display:none;pointer-events:none;';
    root.append(box, tip, dim);
    document.documentElement.appendChild(root);
    selRoot = root;

    let sx = 0, sy = 0, dragging = false, rect = null;

    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true; sx = e.clientX; sy = e.clientY;
      root.style.background = 'transparent';
      tip.style.display = 'none';
      box.style.display = 'block';
      update(e);
    };
    const update = (e) => {
      const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
      const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
      rect = { x, y, w, h };
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      dim.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      dim.style.display = 'block';
      dim.style.left = x + 'px';
      dim.style.top = Math.max(0, y - 22) + 'px';
    };
    const onMove = (e) => { if (dragging) { e.preventDefault(); update(e); } };
    const onUp = async (e) => {
      if (!dragging) return;
      dragging = false;
      update(e);
      if (rect.w < 8 || rect.h < 8) { box.style.display = 'none'; dim.style.display = 'none'; return; }
      const final = { ...rect, vw: window.innerWidth };
      removeSelect();
      await raf2();
      await sleep(120); // make sure the overlay is really gone before the screenshot
      log('INFO', 'region selected', final);
      send({ type: 'REGION_SELECTED', rect: final });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); removeSelect(); send({ type: 'SELECT_CANCELLED' }); }
    };
    root.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    selCleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }

  /* ---------------------- full-page scroll helpers ---------------------- */
  let fp = null;

  function fullPrepare() {
    const de = document.documentElement, b = document.body;
    const total = Math.max(de.scrollHeight, b ? b.scrollHeight : 0, de.offsetHeight);
    fp = { origX: window.scrollX, origY: window.scrollY, behavior: de.style.scrollBehavior, hidden: [], fixedHidden: false };
    de.style.scrollBehavior = 'auto';
    return { total, vh: window.innerHeight, vw: window.innerWidth, origY: window.scrollY };
  }

  async function fullScroll({ y, hideFixed }) {
    if (hideFixed && fp && !fp.fixedHidden) {
      fp.fixedHidden = true;
      // hide fixed/sticky bars after the first tile so they don't repeat on every slice
      for (const el of document.body.querySelectorAll('*')) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          fp.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
      log('DEBUG', 'hid fixed/sticky elements', { count: fp.hidden.length });
    }
    window.scrollTo(0, y);
    await sleep(200); // let lazy content / sticky layout settle
    return { y: Math.round(window.scrollY) };
  }

  function fullRestore() {
    if (!fp) return;
    for (const [el, val, prio] of fp.hidden) {
      if (val) el.style.setProperty('visibility', val, prio); else el.style.removeProperty('visibility');
    }
    document.documentElement.style.scrollBehavior = fp.behavior;
    window.scrollTo(fp.origX, fp.origY);
    fp = null;
  }

  /* ---------------------- preview + prompt panel ---------------------- */
  let host = null, panelCleanup = null;

  function removePanel() {
    if (panelCleanup) panelCleanup();
    panelCleanup = null;
    if (host) host.remove();
    host = null;
  }

  const CSS = `
    *{box-sizing:border-box}
    .backdrop{position:fixed;inset:0;background:rgba(15,18,30,.55);display:flex;align-items:center;justify-content:center;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .card{width:min(580px,92vw);max-height:94vh;overflow:auto;background:#fff;color:#1f2430;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.45);padding:16px;display:flex;flex-direction:column;gap:10px}
    header{display:flex;align-items:center;justify-content:space-between}
    h1{font-size:15px;margin:0;font-weight:600}
    .x{border:0;background:transparent;font-size:20px;cursor:pointer;color:inherit;line-height:1;padding:2px 8px;border-radius:6px}
    .x:hover{background:rgba(127,127,127,.2)}
    .shot{background:repeating-conic-gradient(#e9ecf2 0% 25%,#f7f8fb 0% 50%) 50%/16px 16px;border-radius:8px;padding:6px;display:flex;justify-content:center;border:1px solid rgba(127,127,127,.3)}
    .shot img{max-width:100%;max-height:240px;object-fit:contain;display:block}
    .meta{font-size:12px;opacity:.65;margin-top:-4px}
    label{font-size:12px;font-weight:600;opacity:.75}
    select,textarea{width:100%;font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.5);border-radius:8px;padding:8px}
    select:focus,textarea:focus{outline:2px solid #4c8bf5;outline-offset:-1px}
    textarea{resize:vertical;min-height:88px}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .chk{display:flex;align-items:center;gap:6px;font-size:13px}
    button.b{font:inherit;border:1px solid rgba(127,127,127,.5);background:transparent;color:inherit;padding:7px 12px;border-radius:8px;cursor:pointer}
    button.b:hover{background:rgba(127,127,127,.15)}
    button.primary{background:#4c8bf5;border-color:#4c8bf5;color:#fff;font-weight:600}
    button.primary:hover{background:#3b78e0}
    .spacer{flex:1}
    .status{font-size:12px;min-height:16px;opacity:.75}
    @media (prefers-color-scheme:dark){.card{background:#22262f;color:#eceff5}}
  `;

  async function showPanel(image, mode) {
    removePanel();
    const stored = await chrome.storage.local.get('gsSettings');
    const settings = { ...GS_DEFAULT_SETTINGS, ...(stored.gsSettings || {}) };
    const templates = Array.isArray(settings.templates) ? settings.templates : GS_DEFAULT_TEMPLATES;

    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="backdrop">
        <div class="card" role="dialog" aria-label="Send screenshot to Gemini">
          <header><h1>✨ Send to Gemini</h1><button class="x" id="close" title="Close (Esc)">×</button></header>
          <div class="shot"><img id="img" alt="screenshot preview"></div>
          <div class="meta" id="meta"></div>
          <div>
            <label for="tpl">Quick prompt <span style="opacity:.6;font-weight:400">(press 1–9 to pick)</span></label>
            <select id="tpl"></select>
          </div>
          <div>
            <label for="prompt">Prompt (editable)</label>
            <textarea id="prompt" placeholder="Type your own prompt, or choose a preset above…"></textarea>
          </div>
          <div class="row">
            <label class="chk"><input type="checkbox" id="auto"> Auto-send in Gemini</label>
            <span class="spacer"></span>
            <button class="b" id="retake">Retake</button>
            <button class="b" id="copy">Copy image</button>
            <button class="b" id="save">Save PNG</button>
            <button class="b primary" id="send">Send to Gemini ⌘/Ctrl+↵</button>
          </div>
          <div class="status" id="status"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const img = $('img'), tpl = $('tpl'), prompt = $('prompt'), auto = $('auto'), status = $('status');
    img.src = image;
    img.onload = () => { $('meta').textContent = `${img.naturalWidth} × ${img.naturalHeight}px • ${mode} capture`; };
    auto.checked = !!settings.autoSubmit;

    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = '— choose a preset —';
    tpl.appendChild(ph);
    templates.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = (i < 9 ? `${i + 1}. ` : '') + t.label;
      tpl.appendChild(o);
    });

    const pick = (i) => {
      if (!templates[i]) return;
      tpl.value = String(i);
      prompt.value = templates[i].prompt;
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    };
    tpl.addEventListener('change', () => { if (tpl.value !== '') pick(+tpl.value); else prompt.value = ''; });

    const doSend = () => {
      log('INFO', 'send clicked', { mode, promptLen: prompt.value.length, auto: auto.checked });
      send({ type: 'SEND_TO_GEMINI', image, prompt: prompt.value.trim(), autoSubmit: auto.checked });
      removePanel();
    };
    $('send').onclick = doSend;
    $('close').onclick = removePanel;
    $('retake').onclick = () => { removePanel(); send({ type: 'RETAKE', mode }); };
    $('save').onclick = () => {
      const a = document.createElement('a');
      a.href = image; a.download = `screenshot-${Date.now()}.png`; a.click();
    };
    $('copy').onclick = async () => {
      try {
        const blob = await (await fetch(image)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        status.textContent = 'Image copied to clipboard ✓';
      } catch (e) {
        status.textContent = 'Copy failed: ' + e.message;
        log('ERROR', 'copy image failed', String(e));
      }
    };

    host.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doSend(); return; }
      const inText = e.composedPath()[0] === prompt;
      if (!inText && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); pick(+e.key - 1); }
    });
    host.addEventListener('keyup', (e) => e.stopPropagation());
    host.addEventListener('keypress', (e) => e.stopPropagation());
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); removePanel(); } };
    window.addEventListener('keydown', onEsc, true);
    panelCleanup = () => window.removeEventListener('keydown', onEsc, true);

    tpl.focus(); // ready for ↑/↓ or 1–9 right away
    log('INFO', 'panel shown', { mode, templates: templates.length });
  }
})();
