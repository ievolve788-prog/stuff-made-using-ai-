// The blue tabs live in ONE overlay layer attached to <html>, outside every
// YouTube thumbnail. YouTube's hover-preview / re-rendering can't remove,
// cover or intercept them, because they never touch the thumbnail's DOM.

const LINK_SEL = 'a[href*="/watch?v="], a[href*="/shorts/"]';
const THUMB_SEL = "ytd-thumbnail, yt-thumbnail-view-model";
const GAP = 4;          // px between the tab and the thumbnail
const MASTHEAD = 56;    // hide tabs scrolled under YouTube's top bar

const GEMINI_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path fill="#fff" d="M12 0C12 6.6 6.6 12 0 12c6.6 0 12 5.4 12 12 0-6.6 5.4-12 12-12-6.6 0-12-5.4-12-12z"/>
</svg>`;

function findLink(el) {
  let a = el.closest("a[href]");
  if (a && a.matches(LINK_SEL)) return a;
  a = el.querySelector(LINK_SEL);
  if (a) return a;
  let n = el.parentElement;
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
    a = n.querySelector(LINK_SEL);
    if (a) return a;
  }
  return null;
}

function normalise(href) {
  try {
    const u = new URL(href, location.origin);
    if (u.pathname.startsWith("/shorts/")) {
      return `https://www.youtube.com/watch?v=${u.pathname.split("/")[2]}`;
    }
    const v = u.searchParams.get("v");
    return v ? `https://www.youtube.com/watch?v=${v}` : null;
  } catch {
    return null;
  }
}

const layer = document.createElement("div");
layer.id = "gsum-layer";
document.documentElement.appendChild(layer);

const tabs = new Map(); // thumbnail element -> tab element
let created = 0;

function makeTab(thumb) {
  const tab = document.createElement("button");
  tab.className = "gsum-tab";
  tab.type = "button";
  tab.title = "Summarise with Gemini";
  tab.innerHTML = GEMINI_ICON;

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  tab.addEventListener("mousedown", stop, true);
  tab.addEventListener("mouseup", stop, true);
  tab.addEventListener(
    "click",
    (e) => {
      stop(e);
      const l = findLink(thumb);
      const url = l ? normalise(l.getAttribute("href")) : null;
      dbg("youtube", "tab clicked", { url, href: l && l.getAttribute("href") });
      if (url) chrome.runtime.sendMessage({ type: "summarise", url });
      else dbg("youtube", "NO LINK FOUND for clicked thumbnail", thumb.outerHTML.slice(0, 300));
      dbgCopy(); // still inside the click's user gesture
    },
    true
  );
  layer.appendChild(tab);
  created++;
  if (created <= 5 || created % 25 === 0) dbg("youtube", "tab created", { total: created });
  return tab;
}

function update() {
  if (document.fullscreenElement) {
    layer.style.display = "none";
    return;
  }
  layer.style.display = "";

  const cw = document.documentElement.clientWidth;
  const ch = window.innerHeight;
  const seen = new Set();

  document.querySelectorAll(THUMB_SEL).forEach((t) => {
    const r = t.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) return;       // hidden / tiny
    if (r.bottom < 0 || r.top > ch) return;           // off-screen
    const y = r.top + r.height * 0.42;
    if (y < MASTHEAD) return;                         // under the top bar

    let tab = tabs.get(t);
    if (!tab) {
      if (!findLink(t)) return;
      tab = makeTab(t);
      tabs.set(t, tab);
    }
    seen.add(t);
    tab.style.top = y + "px";
    // anchored by its right edge so it grows leftward (away from the video) on hover
    tab.style.right = cw - r.left + GAP + "px";
  });

  for (const [t, tab] of tabs) {
    if (!seen.has(t)) {
      tab.remove();
      tabs.delete(t);
    }
  }
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    update();
  });
}

dbg("youtube", "content script loaded", location.href);
update();
window.addEventListener("scroll", schedule, { capture: true, passive: true });
window.addEventListener("resize", schedule);
document.addEventListener("fullscreenchange", schedule);
document.addEventListener("mouseover", schedule, { capture: true, passive: true });
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
// Safety net: hover-preview can resize a thumbnail without any DOM change we see
setInterval(schedule, 250);
