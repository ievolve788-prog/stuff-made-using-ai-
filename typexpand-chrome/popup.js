(async () => {
  const { settings } = await teLoad();
  const box = document.getElementById('enabled');
  box.checked = settings.enabled;
  box.onchange = async () => {
    const d = await api.storage.local.get('settings');
    await api.storage.local.set({ settings: { ...TE_DEFAULT_SETTINGS, ...(d.settings || {}), enabled: box.checked } });
  };

  document.getElementById('copylog').onclick = async (e) => {
    try {
      await navigator.clipboard.writeText(await teBuildLogText());
      e.target.textContent = 'Copied. Paste it into the chat';
    } catch (_) {
      e.target.textContent = 'Copy failed: use the settings page';
    }
  };

  document.getElementById('open').onclick = () => {
    api.runtime.openOptionsPage();
    window.close();
  };

  try {
    const cmds = await api.commands.getAll();
    const ul = document.getElementById('keys');
    for (const c of cmds) {
      if (!c.shortcut) continue;
      const li = document.createElement('li');
      const k = document.createElement('kbd');
      k.textContent = c.shortcut;
      li.append(k, ' ' + (c.description || c.name));
      ul.appendChild(li);
    }
  } catch (_) { /* ignore */ }
})();
