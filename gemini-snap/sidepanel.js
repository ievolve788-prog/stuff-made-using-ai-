const GEMINI = 'https://gemini.google.com/app';
const frame = document.getElementById('f');
const st = document.getElementById('st');
const log = (level, text, data) => chrome.runtime.sendMessage({ type: 'LOG', src: 'panel', level, text, data }).catch(() => {});

frame.src = GEMINI;
let port;
function connect() {
  port = chrome.runtime.connect({ name: 'gs-panel' });
  port.onMessage.addListener((m) => { if (m.type === 'PANEL_SEND') deliver(m.payload); });
  port.onDisconnect.addListener(() => setTimeout(connect, 300)); // service worker was restarted
}
connect();
let pongWaiter = null, geminiOrigin = null;

window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || !e.data || e.data.gs !== 'pong') return;
  if (e.origin !== 'https://gemini.google.com') return;
  geminiOrigin = e.origin;
  if (pongWaiter) pongWaiter();
});

async function deliver(payload) {
  if (showingSettings) showSettings(false);
  st.textContent = 'Sending to Gemini…';
  const t0 = Date.now();
  let ready = false;
  while (!ready && Date.now() - t0 < 25000) {
    ready = await new Promise((res) => {
      pongWaiter = () => res(true);
      try { frame.contentWindow.postMessage({ gs: 'ping' }, '*'); } catch {}
      setTimeout(() => res(false), 700);
    });
  }
  pongWaiter = null;
  if (!ready) {
    log('ERROR', 'frame never answered', { src: frame.src });
    st.textContent = 'Gemini did not load in the panel';
    port.postMessage({ type: 'PANEL_FAILED', id: payload.id, reason: 'frame did not respond (blocked, or not signed in)' });
    return;
  }
  log('INFO', 'frame ready, delivering', { ms: Date.now() - t0 });
  frame.contentWindow.postMessage({ gs: 'paste', payload }, geminiOrigin);
  st.textContent = 'Gemini Snap';
}

document.getElementById('reload').onclick = () => { frame.src = GEMINI; };
document.getElementById('tab').onclick = () => chrome.tabs.create({ url: GEMINI });

// ---- Settings view (the extension's options page, shown inside the panel) ----
const cfgFrame = document.getElementById('s');
const cfgBtn = document.getElementById('cfg');
let showingSettings = false;
function showSettings(on) {
  showingSettings = on;
  if (on && !cfgFrame.src) cfgFrame.src = chrome.runtime.getURL('options.html');
  cfgFrame.style.display = on ? 'block' : 'none';
  frame.style.display = on ? 'none' : 'block';   // hidden, not removed: the Gemini chat keeps its state
  cfgBtn.textContent = on ? '← Back to Gemini' : '⚙ Settings';
}
cfgBtn.onclick = () => showSettings(!showingSettings);
