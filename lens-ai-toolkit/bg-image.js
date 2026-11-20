// bg-image.js — getting a usable image: download / re-encode, crop a screenshot, scroll-capture a
// whole page, make the self-test picture. (Loaded by background.js with importScripts.)

const MAX_BYTES = 6000000; // bigger images are re-encoded smaller (session storage is capped at ~10 MB)
const MAX_SIDE = 3000; // longest side after re-encoding
const MAX_SIDE_SCROLL = 6000; // scroll captures are tall; allow more
const MAX_DOWNLOAD = 30000000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- bytes <-> base64 ----------

function b64FromBytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function blobFromB64(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

async function describeBlob(blob, mime, name) {
  return { base64: b64FromBytes(new Uint8Array(await blob.arrayBuffer())), mime, name };
}

// ---------- normalising ----------

// PNG / JPEG / WebP under the size cap go through untouched. Anything else (GIF, AVIF, BMP...)
// or anything huge is redrawn as a PNG (JPEG if still big), scaled down so the longest side is
// at most `maxSide`, and squeezed further until it fits. SVG / unreadable data make
// createImageBitmap throw — the caller then falls back to a screenshot crop.
async function normalizeBlob(blob, maxSide = MAX_SIDE) {
  const type = (blob.type || "").toLowerCase();
  if (["image/png", "image/jpeg", "image/webp"].includes(type) && blob.size <= MAX_BYTES) {
    const bmp0 = await createImageBitmap(blob).catch(() => null);
    const fits = !bmp0 || Math.max(bmp0.width, bmp0.height) <= maxSide;
    if (bmp0 && bmp0.close) bmp0.close();
    if (fits) return describeBlob(blob, type, "image." + (type === "image/jpeg" ? "jpg" : type.split("/")[1]));
  }
  const bmp = await createImageBitmap(blob);
  let scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 4; attempt++) {
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // transparent areas would otherwise turn black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    let out = await canvas.convertToBlob({ type: "image/png" });
    if (out.size <= MAX_BYTES) return describeBlob(out, "image/png", "image.png");
    out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    if (out.size <= MAX_BYTES) return describeBlob(out, "image/jpeg", "image.jpg");
    scale *= 0.75; // still too big: shrink and try again
  }
  throw new Error("image too large to handle");
}

async function fetchBlob(url) {
  if (!/^(https?|data):/i.test(url)) throw new Error("unsupported image address");
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("download failed (HTTP " + res.status + ")");
  const blob = await res.blob();
  if (blob.size > MAX_DOWNLOAD) throw new Error("image too large");
  return blob;
}

// ---------- cropping a screenshot ----------

// rect is in CSS px, the screenshot in device px.
async function cropDataUrl(dataUrl, rect, dpr) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const sx = Math.min(Math.max(0, Math.round(rect.x * dpr)), bmp.width - 1);
  const sy = Math.min(Math.max(0, Math.round(rect.y * dpr)), bmp.height - 1);
  const sw = Math.max(1, Math.min(Math.round(rect.width * dpr), bmp.width - sx));
  const sh = Math.max(1, Math.min(Math.round(rect.height * dpr), bmp.height - sy));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  return normalizeBlob(await canvas.convertToBlob({ type: "image/png" }));
}

// Fallback for images we cannot download (hotlink-protected, CSS-only, canvas...).
async function captureCrop(tab, { rect, dpr }) {
  if (!tab) throw new Error("no tab to capture");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return cropDataUrl(dataUrl, rect, dpr);
}

async function dataUrlToImage(dataUrl) {
  return normalizeBlob(await (await fetch(dataUrl)).blob());
}

async function prepareImage(source, tab) {
  if (source.capture) return captureCrop(tab, source.capture);
  if (source.base64) return normalizeBlob(blobFromB64(source.base64, source.mime));
  if (source.url) return normalizeBlob(await fetchBlob(source.url));
  throw new Error("no image source");
}

// ---------- scrolling capture ----------
//
// Scrolls the page one screen at a time, takes a screenshot each time (Chrome allows about 2
// per second) and stitches them. Limits: only the page's own scrolling is used (not scrolling
// boxes inside web apps), sticky headers repeat, lazy-loaded parts may be blank, and at most
// MAX_SHOTS screens are taken.

const MAX_SHOTS = 14;

function pageMetrics() {
  return {
    h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    vh: window.innerHeight,
    y: window.scrollY,
    dpr: window.devicePixelRatio || 1
  };
}

function scrollToAndSettle(y) {
  return new Promise((resolve) => {
    window.scrollTo(0, y);
    setTimeout(() => resolve(window.scrollY), 320);
  });
}

async function scrollCapture(tab, onProgress) {
  const target = { tabId: tab.id };
  const [m] = await chrome.scripting.executeScript({ target, func: pageMetrics });
  const info = m && m.result;
  if (!info) throw new Error("could not read the page size");
  const maxY = Math.max(0, info.h - info.vh);
  const step = Math.max(120, info.vh - 48); // a little overlap
  const ys = [];
  for (let y = 0; ; y += step) {
    ys.push(Math.min(y, maxY));
    if (y >= maxY || ys.length >= MAX_SHOTS) break;
  }
  const shots = [];
  let lastCapture = 0;
  await pageUi(tab.id, false);
  try {
    for (let i = 0; i < ys.length; i++) {
      const [r] = await chrome.scripting.executeScript({ target, func: scrollToAndSettle, args: [ys[i]] });
      const actualY = r && typeof r.result === "number" ? r.result : ys[i];
      const wait = 560 - (Date.now() - lastCapture);
      if (wait > 0) await sleep(wait);
      lastCapture = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      shots.push({ dataUrl, y: actualY });
      if (onProgress) onProgress(i + 1, ys.length);
    }
  } finally {
    chrome.scripting.executeScript({ target, func: (y) => window.scrollTo(0, y), args: [info.y] }).catch(() => {});
    pageUi(tab.id, true);
  }
  return stitch(shots, info);
}

async function stitch(shots, info) {
  const bmps = [];
  for (const s of shots) bmps.push({ bmp: await createImageBitmap(await (await fetch(s.dataUrl)).blob()), y: s.y });
  const dpr = bmps[0].bmp.height / info.vh || info.dpr; // exact ratio of device px to CSS px
  const lastY = Math.max(...bmps.map((b) => b.y));
  const fullW = bmps[0].bmp.width;
  const fullH = Math.round((lastY + info.vh) * dpr);
  const scale = Math.min(1, MAX_SIDE_SCROLL / Math.max(fullW, fullH));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(fullW * scale)), Math.max(1, Math.round(fullH * scale)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const { bmp, y } of bmps) {
    ctx.drawImage(bmp, 0, Math.round(y * dpr * scale), Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  }
  return normalizeBlob(await canvas.convertToBlob({ type: "image/png" }), MAX_SIDE_SCROLL);
}

// ---------- the self-test picture ----------

async function makeTestImage(text) {
  const w = 980;
  const h = 220;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#111111";
  ctx.font = "bold 64px Arial, Helvetica, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 40, h / 2);
  return describeBlob(await canvas.convertToBlob({ type: "image/png" }), "image/png", "selftest.png");
}
