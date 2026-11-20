(async () => {
  const $ = (s) => document.querySelector(s);
  let { settings, snippets } = await teLoad();
  let saveTimer;

  function status(t) { $('#status').textContent = t; }
  function save() {
    status('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await api.storage.local.set({ settings, snippets });
      status('Saved');
    }, 250);
  }
  const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---- settings ---- */
  $('#enabled').checked = settings.enabled;
  $('#mode').value = settings.mode;
  $('#typeDelay').value = settings.typeDelay;
  $('#keyEvents').checked = settings.keyEvents;
  $('#passwordFields').checked = settings.passwordFields;
  $('#excluded').value = (settings.excludedSites || []).join('\n');
  $('#passwordFields').onchange = (e) => { settings.passwordFields = e.target.checked; save(); };

  $('#enabled').onchange = (e) => { settings.enabled = e.target.checked; save(); };
  $('#mode').onchange = (e) => { settings.mode = e.target.value; save(); };
  $('#typeDelay').oninput = (e) => {
    settings.typeDelay = Math.max(0, Math.min(500, parseInt(e.target.value, 10) || 0));
    save();
  };
  $('#keyEvents').onchange = (e) => { settings.keyEvents = e.target.checked; save(); };
  $('#excluded').oninput = (e) => {
    settings.excludedSites = e.target.value.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
    save();
  };

  /* ---- snippets ---- */
  const list = $('#list');
  const tpl = $('#row');

  function markDupes() {
    const count = {};
    snippets.forEach((s) => { if (s.trigger) count[s.trigger] = (count[s.trigger] || 0) + 1; });
    list.querySelectorAll('.row').forEach((row) => {
      const s = snippets.find((x) => x.id === row.dataset.id);
      row.classList.toggle('dup', !!s && (!s.trigger || count[s.trigger] > 1));
      row.title = row.classList.contains('dup') ? 'Empty or duplicate trigger' : '';
    });
  }

  function render() {
    const q = $('#filter').value.trim().toLowerCase();
    list.textContent = '';
    const shown = snippets.filter((s) => !q || s.trigger.toLowerCase().includes(q) || s.replace.toLowerCase().includes(q));
    if (!shown.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = snippets.length ? 'No snippets match.' : 'No snippets yet. Click “Add snippet”.';
      list.appendChild(p);
      return;
    }
    for (const s of shown) {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.id = s.id;
      row.querySelectorAll('[data-f]').forEach((el) => {
        const v = s[el.dataset.f];
        if (el.type === 'checkbox') el.checked = el.dataset.f === 'enabled' ? s.enabled !== false : !!v;
        else el.value = v ?? '';
      });
      list.appendChild(row);
    }
    markDupes();
  }

  function onEdit(e) {
    const el = e.target.closest('[data-f]');
    if (!el) return;
    const s = snippets.find((x) => x.id === el.closest('.row').dataset.id);
    if (!s) return;
    s[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
    markDupes();
    save();
  }
  list.addEventListener('input', onEdit);
  list.addEventListener('change', onEdit);
  list.addEventListener('click', (e) => {
    if (e.target.dataset.act !== 'del') return;
    const id = e.target.closest('.row').dataset.id;
    snippets = snippets.filter((s) => s.id !== id);
    save();
    render();
  });

  $('#filter').oninput = render;
  $('#add').onclick = () => {
    $('#filter').value = '';
    snippets.unshift({ id: newId(), trigger: '', replace: '', mode: '', word: false, enabled: true });
    save();
    render();
    list.querySelector('.trigger')?.focus();
  };

  /* ---- import / export ---- */
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify({ snippets }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'typexpand-snippets.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#import').onclick = () => $('#file').click();
  $('#file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      // Accepts {snippets:[…]}, a bare array, or an espanso-style {matches:[{trigger, replace}]}.
      const arr = Array.isArray(data) ? data : data.snippets || data.matches || [];
      let added = 0;
      for (const m of arr) {
        const trigger = m.trigger || (m.triggers && m.triggers[0]);
        const replace = m.replace ?? '';
        if (!trigger || typeof replace !== 'string') continue;
        if (snippets.some((s) => s.trigger === trigger && s.replace === replace)) continue;
        snippets.push({
          id: newId(), trigger, replace,
          mode: m.mode === 'type' || m.mode === 'paste' ? m.mode : '',
          word: !!m.word, enabled: m.enabled !== false
        });
        added++;
      }
      save();
      render();
      status(`Imported ${added} snippet(s)`);
    } catch (err) {
      status('Import failed: ' + err.message);
    }
  };

  render();
})();
