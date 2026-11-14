const $ = (id) => document.getElementById(id);
for (const mode of ['region', 'visible', 'full', 'quick']) {
  $(mode).onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'START', mode });
    window.close();
  };
}
$('opts').onclick = () => chrome.runtime.openOptionsPage();
$('log').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'SAVE_LOG' });
  $('msg').textContent = r.ok ? 'Saved → ' + r.path : 'Failed: ' + r.error;
};
// show the real (possibly customised) shortcuts
chrome.commands.getAll().then((cmds) => {
  const map = { 'capture-region': 'k1', 'capture-visible': 'k2', 'capture-full': 'k3', 'quick-send': 'k4' };
  for (const c of cmds) if (map[c.name]) $(map[c.name]).textContent = c.shortcut || 'not set';
});
