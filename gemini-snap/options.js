const $ = (id) => document.getElementById(id);
let templates = [];

function render() {
  const list = $('list');
  list.textContent = '';
  templates.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'tpl';
    const label = document.createElement('input'); label.type = 'text'; label.value = t.label; label.placeholder = 'Label';
    const prompt = document.createElement('textarea'); prompt.value = t.prompt; prompt.placeholder = 'Prompt text';
    const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Delete';
    label.oninput = () => (templates[i].label = label.value);
    prompt.oninput = () => (templates[i].prompt = prompt.value);
    del.onclick = () => { templates.splice(i, 1); render(); };
    row.append(label, prompt, del);
    list.appendChild(row);
  });
}

async function load() {
  const r = await chrome.storage.local.get('gsSettings');
  const s = { ...GS_DEFAULT_SETTINGS, ...(r.gsSettings || {}) };
  templates = JSON.parse(JSON.stringify(s.templates));
  $('quickPrompt').value = s.quickPrompt || '';
  $('target').value = s.target || 'sidepanel';
  $('autoSubmit').checked = !!s.autoSubmit;
  $('autoSaveLog').checked = !!s.autoSaveLog;
  render();
}

$('add').onclick = () => { templates.push({ label: 'New template', prompt: '' }); render(); };
$('reset').onclick = () => { templates = JSON.parse(JSON.stringify(GS_DEFAULT_TEMPLATES)); render(); };
$('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
$('save').onclick = async () => {
  const clean = templates.filter((t) => t.label.trim());
  await chrome.storage.local.set({ gsSettings: { templates: clean, target: $('target').value, quickPrompt: $('quickPrompt').value, autoSubmit: $('autoSubmit').checked, autoSaveLog: $('autoSaveLog').checked } });
  $('saved').textContent = 'Saved ✓';
  setTimeout(() => ($('saved').textContent = ''), 2000);
};
$('logSave').onclick = async () => { const r = await chrome.runtime.sendMessage({ type: 'SAVE_LOG' }); $('logBox').textContent = r.ok ? 'Written to ' + r.path : 'Failed: ' + r.error; };
$('logView').onclick = async () => { const r = await chrome.runtime.sendMessage({ type: 'GET_LOG' }); $('logBox').textContent = r.text || '(empty)'; };
$('logClear').onclick = async () => { await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' }); $('logBox').textContent = '(cleared)'; };
load();
