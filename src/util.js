// Shared helpers: ids, math, time formatting, events and small DOM utilities.

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const EPS = 1e-6;

/** Snap a time in seconds to the nearest frame boundary. */
export function snapFrame(t, fps) {
  return Math.round(t * fps) / fps;
}

/** Format seconds as SMPTE-style timecode HH:MM:SS:FF. */
export function formatTimecode(t, fps) {
  if (!Number.isFinite(t)) return '--:--:--:--';
  const neg = t < 0;
  const totalFrames = Math.round(Math.abs(t) * fps);
  const f = totalFrames % Math.round(fps);
  const totalSec = Math.floor(totalFrames / Math.round(fps));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

/** Parse "HH:MM:SS:FF", "MM:SS:FF", "SS:FF" or plain frame count into seconds. */
export function parseTimecode(str, fps) {
  const s = String(str).trim();
  if (!s) return null;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10) / fps;
  const parts = s.split(/[:;.]/).map((x) => parseInt(x, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  while (parts.length < 4) parts.unshift(0);
  const [h, m, sec, f] = parts;
  return h * 3600 + m * 60 + sec + f / fps;
}

/** Short human duration such as 0:12 or 1:02:03. */
export function formatShort(t) {
  if (!Number.isFinite(t)) return '—';
  const s = Math.floor(t % 60);
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
    return () => this.handlers.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    const set = this.handlers.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (err) { console.error(`[${evt}] handler failed`, err); }
    }
  }
}

/** Create an element: h('div.cls#id', {attrs}, ...children). */
export function h(tag, attrs, ...children) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m?.[1] || 'div');
  for (const part of (m?.[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = () => { clearTimeout(timer); fn(); };
  return wrapped;
}

let downloadsCap;
/** The hosted viewer's save capability, when the editor runs as a published artifact. */
function hostDownloads() {
  if (downloadsCap === undefined) {
    downloadsCap = typeof window !== 'undefined' && window.claude?.use
      ? window.claude.use('downloads').catch(() => null)
      : Promise.resolve(null);
  }
  return downloadsCap;
}

/**
 * Save a generated file. Uses the host's save prompt when available, otherwise a download link.
 * Resolves true when the file was handed over; failures are reported through a 'montage:toast' event.
 */
export async function downloadBlob(blob, filename) {
  const host = await hostDownloads();
  if (host) {
    try {
      await host.save({ filename, data: blob });
      return true;
    } catch (err) {
      const msg = {
        declined: '저장을 취소했습니다',
        rejected_extension: `이 보기 화면에서는 .${filename.split('.').pop()} 파일을 저장할 수 없습니다`,
        extension_not_enabled: `이 보기 화면에서는 .${filename.split('.').pop()} 파일을 저장할 수 없습니다`,
        rate_limited: '저장 확인 창이 이미 열려 있습니다',
      }[err?.code] || `${filename} 파일을 저장하지 못했습니다`;
      window.dispatchEvent(new CustomEvent('montage:toast', { detail: msg }));
      return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Wait for an event once, with optional timeout (resolves false on timeout). */
export function once(target, evt, timeoutMs = 0) {
  return new Promise((resolve) => {
    let timer = null;
    const done = (v) => {
      target.removeEventListener(evt, handler);
      clearTimeout(timer);
      resolve(v);
    };
    const handler = () => done(true);
    target.addEventListener(evt, handler);
    if (timeoutMs) timer = setTimeout(() => done(false), timeoutMs);
  });
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** dB <-> linear gain. */
export const dbToGain = (db) => (db <= -96 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
