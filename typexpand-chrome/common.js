/* Shared by the content script, options page and popup. */
const api = globalThis.browser ?? globalThis.chrome;

const TE_DEFAULT_SETTINGS = {
  enabled: true,
  mode: 'type',        // 'type' (default) or 'paste'
  typeDelay: 8,        // ms between typed characters
  keyEvents: true,     // fire keydown/keyup around each typed character
  passwordFields: true, // also expand inside password fields
  excludedSites: []    // hostnames where expansion is disabled
};

const TE_DEFAULT_SNIPPETS = [
  { id: 'd1', trigger: ':date',  replace: '{{date}}',                  mode: '', word: false, enabled: true },
  { id: 'd2', trigger: ':now',   replace: '{{datetime}}',              mode: '', word: false, enabled: true },
  { id: 'd3', trigger: ':clip',  replace: '{{clipboard}}',             mode: '', word: false, enabled: true },
  { id: 'd4', trigger: ':shrug', replace: '\u00AF\\_(\u30C4)_/\u00AF', mode: '', word: false, enabled: true },
  { id: 'd5', trigger: ':hi',    replace: 'Hi {{cursor}},\n\nThanks!', mode: '', word: false, enabled: true }
];

// Private-use character that marks where the caret should end up.
const CURSOR_MARK = '\uE000';

async function teLoad() {
  const d = await api.storage.local.get(['settings', 'snippets']);
  return {
    settings: { ...TE_DEFAULT_SETTINGS, ...(d.settings || {}) },
    snippets: Array.isArray(d.snippets) ? d.snippets : JSON.parse(JSON.stringify(TE_DEFAULT_SNIPPETS))
  };
}

const TE_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const TE_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function teFormatDate(fmt, d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|DD|dddd|ddd|HH|hh|mm|ss|A/g, (t) => ({
    YYYY: d.getFullYear(),
    YY: pad(d.getFullYear() % 100),
    MMMM: TE_MONTHS[d.getMonth()],
    MMM: TE_MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    dddd: TE_DAYS[d.getDay()],
    ddd: TE_DAYS[d.getDay()].slice(0, 3),
    HH: pad(d.getHours()),
    hh: pad(d.getHours() % 12 || 12),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    A: d.getHours() < 12 ? 'AM' : 'PM'
  }[t]));
}

function teUuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Expands {{variables}} in a snippet. clipFn is only called if {{clipboard}} is used.
async function teRender(tpl, clipFn) {
  let clip = '';
  if (/\{\{\s*clipboard\s*\}\}/i.test(tpl)) clip = (await clipFn()) || '';
  return tpl.replace(/\{\{\s*([a-z]+)(?::([^}]*))?\s*\}\}/gi, (all, name, arg) => {
    switch (name.toLowerCase()) {
      case 'date': return teFormatDate(arg || 'YYYY-MM-DD');
      case 'time': return teFormatDate(arg || 'HH:mm');
      case 'datetime': return teFormatDate(arg || 'YYYY-MM-DD HH:mm');
      case 'clipboard': return clip;
      case 'uuid': return teUuid();
      case 'cursor': return CURSOR_MARK;
      default: return all;
    }
  });
}
