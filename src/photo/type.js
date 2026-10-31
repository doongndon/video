// Type engine for text layers, like Photoshop's four kinds of text:
//  - point text (box null): one line per paragraph, grows as you type
//  - paragraph text (box {w, h}): word wrap inside a box
//  - area text (area {subpaths, w0, h0}): word wrap inside a closed path
//  - type on a path (path {subpath, start, end, flip, w0, h0}): one line along a path
// Character runs (runs: [{ n, ...overrides }]) give part of the text its own font, size, colour and
// style; paras: [overrides | null] give paragraphs their own alignment, indents and spacing.
// Also vertical text, kerning (metrics / optical / manual), tracking, scales, baseline shift, faux
// bold / italic, caps, super / subscript, underline / strike, anti-aliasing and text warp.
// Plugs into doc.js through setTextEngine(); type2.js builds the editing on the geometry exported here.

import { setTextEngine, makeCanvas } from './doc.js';
import { meshWarp, warpGrid } from './transform.js';
import { flatten, mapPath, pathBounds } from './paths.js';
import { loadFontFor, isWebFont } from '../fonts.js';

const mctx = () => (mctx.c ||= makeCanvas(1, 1).getContext('2d'));
const CJK = /[ᄀ-ᇿ　-鿿가-힯豈-﫿＀-￯]/;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : [...s]);

/** Character settings a run can override (sizeK: size relative to the layer's size; tracking and kern in 1/1000 em). */
export const CHAR_KEYS = ['font', 'bold', 'italic', 'sizeK', 'color', 'tracking', 'kerning', 'kern', 'hScale', 'vScale', 'baseline', 'fauxBold', 'fauxItalic', 'caps', 'script', 'underline', 'strike'];
/** Paragraph settings a paragraph can override. */
export const PARA_KEYS = ['align', 'indent', 'spaceBefore', 'spaceAfter'];
export const AA_MODES = [['none', '없음'], ['sharp', '선명하게'], ['crisp', '뚜렷하게'], ['strong', '강하게'], ['smooth', '매끄럽게']];
export const ALIGNS = [['left', '왼쪽 정렬'], ['center', '가운데 정렬'], ['right', '오른쪽 정렬'], ['justify', '마지막 줄 왼쪽 정렬 균등 배치'], ['justifyCenter', '마지막 줄 가운데 정렬 균등 배치'], ['justifyRight', '마지막 줄 오른쪽 정렬 균등 배치'], ['justifyAll', '모두 균등 배치']];

const fontStr = (font, bold, italic, px) => `${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${Math.round(px * 100) / 100}px "${font}", "Noto Sans KR", sans-serif`;
export function fontString(t, size = t.size) {
  return fontStr(t.font, t.bold, t.italic, size);
}

// ---------------------------------------------------------------- character and paragraph styles

/** The layer's own character settings (what characters without a run override use). */
export function baseChar(t) {
  return {
    font: t.font || 'Noto Sans KR', bold: !!t.bold, italic: !!t.italic, sizeK: 1, color: t.color || '#000000',
    tracking: null, kerning: t.kerning ?? 'metrics', kern: 0, hScale: t.hScale ?? 100, vScale: t.vScale ?? 100,
    baseline: t.baseline || 0, fauxBold: !!t.fauxBold, fauxItalic: !!t.fauxItalic, caps: t.caps || 'none',
    script: t.script || 'none', underline: !!t.underline, strike: !!t.strike,
  };
}

/** Tracking of the layer's own characters in 1/1000 em (stored as px in letterSpacing). */
export const baseTracking = (t) => ((t.letterSpacing || 0) / Math.max(0.01, t.size || 1)) * 1000;

const okey = (o) => (o ? CHAR_KEYS.map((k) => (o[k] === undefined ? '' : JSON.stringify(o[k]))).join('|') : '');

/** Per-character override objects (null: the layer's settings) for content of length n (UTF-16). */
export function expandRuns(t, n = String(t.content ?? '').length) {
  const out = new Array(n).fill(null);
  let i = 0;
  for (const r of t.runs || []) {
    const { n: len, ...o } = r;
    const has = Object.keys(o).length ? o : null;
    for (let k = 0; k < len && i < n; k++) out[i++] = has;
  }
  return out;
}

/** Overrides per character → runs (null when nothing is overridden). */
export function compressRuns(arr) {
  const runs = [];
  let cur = null;
  let curKey = null;
  for (const o of arr) {
    const key = okey(o && Object.keys(o).length ? o : null);
    if (cur && key === curKey) cur.n++;
    else {
      cur = { n: 1, ...(key ? o : {}) };
      curKey = key;
      runs.push(cur);
    }
  }
  while (runs.length && Object.keys(runs[runs.length - 1]).length === 1) runs.pop();
  return runs.length ? runs : null;
}

/** Settings of the character at index i (the layer's settings merged with its override). */
export function charStyleAt(t, i) {
  const ov = expandRuns(t);
  const o = ov[clamp(i, 0, Math.max(0, ov.length - 1))];
  return { ...baseChar(t), ...(o || {}) };
}

/** A copy of the text with `patch` (run keys) set on characters a..b (UTF-16). Values equal to the layer's own are dropped. */
export function withCharRange(t, a, b, patch) {
  const n = String(t.content ?? '').length;
  const arr = expandRuns(t, n);
  const base = baseChar(t);
  const bt = baseTracking(t);
  const same = (k, v) => (k === 'tracking' ? Math.abs((v ?? bt) - bt) < 1e-6 : k === 'sizeK' ? Math.abs(v - 1) < 1e-6 : JSON.stringify(base[k]) === JSON.stringify(v));
  const memo = new Map();
  for (let i = Math.max(0, a); i < Math.min(n, b); i++) {
    const src = arr[i];
    let o = memo.get(src);
    if (!o) {
      o = { ...(src || {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || same(k, v)) delete o[k];
        else o[k] = v;
      }
      if (!Object.keys(o).length) o = null;
      memo.set(src, o);
    }
    arr[i] = o;
  }
  return { ...t, runs: compressRuns(arr) };
}

/** A copy of the text with run keys `keys` removed from every character (the layer's setting shows through). */
export function clearRunKeys(t, keys) {
  if (!t.runs) return t;
  const runs = t.runs.map((r) => {
    const o = { ...r };
    for (const k of keys) delete o[k];
    return o;
  });
  const arr = expandRuns({ ...t, runs });
  return { ...t, runs: compressRuns(arr) };
}

/** Paragraph boundaries: [{ start, end }] in UTF-16 (end excludes the newline). */
export function paragraphs(content) {
  const s = String(content ?? '');
  const out = [];
  let a = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s[i] === '\n') {
      out.push({ start: a, end: i });
      a = i + 1;
    }
  }
  return out;
}
export const paraIndexAt = (content, i) => {
  const s = String(content ?? '');
  let n = 0;
  for (let k = 0; k < Math.min(i, s.length); k++) if (s[k] === '\n') n++;
  return n;
};

/** Paragraph settings of paragraph pi. */
export function paraStyle(t, pi) {
  const o = t.paras?.[pi] || {};
  return {
    align: o.align ?? t.align ?? 'left',
    indent: { left: 0, right: 0, first: 0, ...(t.indent || {}), ...(o.indent || {}) },
    spaceBefore: o.spaceBefore ?? t.spaceBefore ?? 0,
    spaceAfter: o.spaceAfter ?? t.spaceAfter ?? 0,
  };
}

/** A copy of the text with `patch` set on paragraphs p0..p1 (inclusive). */
export function withParaRange(t, p0, p1, patch) {
  const count = paragraphs(t.content).length;
  const paras = Array.from({ length: count }, (_, i) => (t.paras?.[i] ? { ...t.paras[i] } : null));
  for (let i = Math.max(0, p0); i <= Math.min(count - 1, p1); i++) {
    const o = { ...(paras[i] || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete o[k];
      else o[k] = k === 'indent' ? { ...(o.indent || {}), ...v } : v;
    }
    paras[i] = Object.keys(o).length ? o : null;
  }
  return { ...t, paras: paras.some(Boolean) ? paras : null };
}

/**
 * Keep runs and paragraph settings in step with an edit of the content from `prev` to `next`:
 * inserted characters take the style of the character before them (or `insertStyle`), new
 * paragraphs take the settings of the paragraph they split.
 */
export function syncEdit(t, prev, next, insertStyle = null) {
  prev = String(prev ?? '');
  next = String(next ?? '');
  if (prev === next) return t;
  let p = 0;
  const maxP = Math.min(prev.length, next.length);
  while (p < maxP && prev[p] === next[p]) p++;
  let s = 0;
  while (s < Math.min(prev.length, next.length) - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const removed = prev.slice(p, prev.length - s);
  const inserted = next.slice(p, next.length - s);
  let out = t;
  if (t.runs || insertStyle) {
    const arr = expandRuns(t, prev.length);
    const like = insertStyle ? { ...(arr[Math.max(0, p - 1)] || {}), ...insertStyle } : (p > 0 ? arr[p - 1] : arr[p + removed.length] ?? arr[0] ?? null);
    arr.splice(p, removed.length, ...new Array(inserted.length).fill(like && Object.keys(like).length ? like : null));
    out = { ...out, runs: compressRuns(arr) };
  }
  if (t.paras) {
    const nlRemoved = (removed.match(/\n/g) || []).length;
    const nlInserted = (inserted.match(/\n/g) || []).length;
    if (nlRemoved || nlInserted) {
      const pi = paraIndexAt(prev, p);
      const paras = [...t.paras];
      while (paras.length < paragraphs(prev).length) paras.push(null);
      paras.splice(pi + 1, nlRemoved, ...new Array(nlInserted).fill(paras[pi] || null));
      out = { ...out, paras: paras.some(Boolean) ? paras : null };
    }
  }
  return out;
}

// ---------------------------------------------------------------- measuring

let lastFont = '';
const setFont = (g, f) => {
  if (lastFont !== f || g.font === '10px sans-serif') {
    g.font = f;
    lastFont = f;
  }
};
const wCache = new Map();
function advance(font, ch) {
  const k = `${font}\u0001${ch}`;
  let v = wCache.get(k);
  if (v === undefined) {
    const g = mctx();
    setFont(g, font);
    v = g.measureText(ch).width;
    if (wCache.size > 80000) wCache.clear();
    wCache.set(k, v);
  }
  return v;
}
/** The font's own kerning between a and b (canvas text kerns pairs; the difference is the kern). */
function pairKern(font, a, b) {
  const k = `${font}\u0002${a}${b}`;
  let v = wCache.get(k);
  if (v === undefined) {
    const g = mctx();
    setFont(g, font);
    v = g.measureText(a + b).width - advance(font, a) - advance(font, b);
    if (Math.abs(v) < 0.01) v = 0;
    wCache.set(k, v);
  }
  return v;
}

// optical kerning: glyph outlines as per-row ink extents, pairs spaced to an even closest gap
const REF = 48;
const ROWS = 24;
const profCache = new Map();
function profile(font, ch) {
  const k = `${font}\u0003${ch}`;
  let pr = profCache.get(k);
  if (pr) return pr;
  const W = REF * 3;
  const H = Math.round(REF * 1.6);
  const c = profile.c || (profile.c = makeCanvas(W, H));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, W, H);
  g.font = font;
  g.fillStyle = '#000';
  g.textBaseline = 'alphabetic';
  const ox = REF;
  const base = Math.round(REF * 1.15);
  g.fillText(ch, ox, base);
  lastFont = '';
  const d = g.getImageData(0, 0, W, H).data;
  const left = new Float32Array(ROWS).fill(NaN);
  const right = new Float32Array(ROWS).fill(NaN);
  const y0 = base - REF * 1.05;
  const y1 = base + REF * 0.35;
  for (let r = 0; r < ROWS; r++) {
    const ya = Math.round(y0 + ((y1 - y0) * r) / ROWS);
    const yb = Math.round(y0 + ((y1 - y0) * (r + 1)) / ROWS);
    for (let y = Math.max(0, ya); y < Math.min(H, yb); y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 60) {
          const lx = x - ox;
          if (!(left[r] <= lx)) left[r] = lx;
          break;
        }
      }
      for (let x = W - 1; x >= 0; x--) {
        if (d[(y * W + x) * 4 + 3] > 60) {
          const rx = x + 1 - ox;
          if (!(right[r] >= rx)) right[r] = rx;
          break;
        }
      }
    }
  }
  pr = { left, right };
  if (profCache.size > 4000) profCache.clear();
  profCache.set(k, pr);
  return pr;
}
function closestGap(fa, a, fb, b) {
  const pa = profile(fa, a);
  const pb = profile(fb, b);
  const wa = advance(fa, a);
  let gap = Infinity;
  for (let r = 0; r < ROWS; r++) {
    if (Number.isNaN(pa.right[r]) || Number.isNaN(pb.left[r])) continue;
    gap = Math.min(gap, wa + pb.left[r] - pa.right[r]);
  }
  return gap;
}
function opticalKern(a, b) {
  const fa = fontStr(a.st.font, a.st.bold, a.st.italic, REF);
  const fb = fontStr(b.st.font, b.st.bold, b.st.italic, REF);
  const k = `${fa}\u0004${fb}\u0004${a.d}${b.d}`;
  let v = wCache.get(k);
  if (v === undefined) {
    const gap = closestGap(fa, a.d, fb, b.d);
    const ref = a.cjk && b.cjk ? closestGap(fa, '가', fa, '가') : closestGap(fa, 'n', fa, 'n');
    v = Number.isFinite(gap) && Number.isFinite(ref) ? clamp((ref - gap) * 0.9, -REF * 0.25, REF * 0.12) : 0;
    wCache.set(k, v);
  }
  return (v * a.px) / REF;
}

// ---------------------------------------------------------------- glyphs

function resolveStyle(t, base, o) {
  const s = o ? { ...base, ...o } : { ...base };
  s.size = Math.max(0.5, (t.size || 72) * (s.sizeK || 1));
  const trackEm = s.tracking != null ? s.tracking : baseTracking(t);
  s.trackPx = (trackEm / 1000) * s.size;
  s.kernPx = ((s.kern || 0) / 1000) * s.size;
  const sc = s.script === 'super' || s.script === 'sub';
  s.gs = s.size * (sc ? 0.583 : 1);
  s.shift = (s.baseline || 0) + (s.script === 'super' ? s.size * 0.333 : s.script === 'sub' ? -s.size * 0.333 : 0);
  s.hs = (s.hScale ?? 100) / 100;
  s.vs = (s.vScale ?? 100) / 100;
  return s;
}

/** One glyph per grapheme: { i, len, ch, d (drawn), st, px, font, nl, sp, cjk } */
function buildGlyphs(t) {
  const s = String(t.content ?? '');
  const ov = expandRuns(t, s.length);
  const base = baseChar(t);
  const cache = new Map();
  const styleOf = (o) => {
    let st = cache.get(o);
    if (!st) {
      st = resolveStyle(t, base, o);
      cache.set(o, st);
    }
    return st;
  };
  const G = [];
  let i = 0;
  for (const ch of graphemes(s)) {
    const st = styleOf(ov[i] || null);
    let d = ch;
    let px = st.gs;
    if (st.caps === 'all') d = ch.toUpperCase();
    else if (st.caps === 'small' && ch !== ch.toUpperCase()) {
      d = ch.toUpperCase();
      px = st.gs * 0.7;
    }
    G.push({ i, len: ch.length, ch, d, st, px, font: fontStr(st.font, st.bold, st.italic, px), nl: ch === '\n', sp: ch === ' ' || ch === '\t' || ch === '　', cjk: CJK.test(ch), w: 0, x: 0, y: 0, line: 0 });
    i += ch.length;
  }
  return G;
}

/** Horizontal advances (with kerning, tracking and manual kerning) in g.w; g.track is the part after the ink. */
function measureH(G) {
  for (let k = 0; k < G.length; k++) {
    const g = G[k];
    if (g.nl) {
      g.w = 0;
      g.track = 0;
      continue;
    }
    let w = (g.ch === '\t' ? advance(g.font, ' ') * 4 : advance(g.font, g.d)) * g.st.hs;
    const nx = G[k + 1];
    if (nx && !nx.nl) {
      const mode = g.st.kerning;
      if (mode === 'metrics' && nx.font === g.font && !g.cjk && !nx.cjk && !g.sp && !nx.sp) w += pairKern(g.font, g.d, nx.d) * g.st.hs;
      else if (mode === 'optical' && !g.sp && !nx.sp) w += opticalKern(g, nx);
    }
    g.track = g.st.trackPx + g.st.kernPx;
    g.ink = w;
    g.w = w + g.track;
  }
}

const lineHeight = (t, list, fallback) => {
  if (t.leading > 0) return t.leading;
  let m = 0;
  for (const g of list) if (!g.nl || list.length === 1) m = Math.max(m, g.st.size);
  return (m || fallback) * (t.lineHeight || 1.2);
};
const maxSize = (list, fallback) => {
  let m = 0;
  for (const g of list) if (!g.nl || list.length === 1) m = Math.max(m, g.st.size);
  return m || fallback;
};

/** Words, single CJK characters and runs of spaces: [[k0, k1)…] glyph index ranges. */
function tokens(G, a, b) {
  const out = [];
  let s = a;
  let kind = '';
  for (let k = a; k < b; k++) {
    const g = G[k];
    const kd = g.sp ? 's' : g.cjk ? 'c' : 'w';
    if (kd === 'c') {
      if (k > s) out.push([s, k, kind]);
      out.push([k, k + 1, 'c']);
      s = k + 1;
      kind = '';
      continue;
    }
    if (kd !== kind && k > s) {
      out.push([s, k, kind]);
      s = k;
    }
    kind = kd;
  }
  if (b > s) out.push([s, b, kind]);
  return out;
}

// ---------------------------------------------------------------- area shapes

/** x spans inside polygons (even-odd) for every sample row of the band [y0, y1]. */
function bandSpans(polys, y0, y1) {
  let acc = null;
  for (const y of [y0 + 0.01, (y0 + y1) / 2, y1 - 0.01]) {
    const xs = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        if ((ay <= y) !== (by <= y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    if (!acc) acc = spans;
    else {
      const out = [];
      for (const [a0, a1] of acc) for (const [b0, b1] of spans) {
        const l = Math.max(a0, b0);
        const r = Math.min(a1, b1);
        if (r > l) out.push([l, r]);
      }
      acc = out;
    }
  }
  return acc || [];
}

/** Area text's shape in the current box (it scales with the box after transforms). */
export function areaPaths(t) {
  const a = t.area;
  if (!a?.subpaths?.length) return [];
  const kx = (t.box?.w || a.w0 || 1) / (a.w0 || t.box?.w || 1);
  const ky = (t.box?.h || a.h0 || 1) / (a.h0 || t.box?.h || 1);
  return kx === 1 && ky === 1 ? a.subpaths : mapPath(a.subpaths, ([x, y]) => [x * kx, y * ky]);
}

/** The path of type on a path in box coordinates (legacy layers keep theirs in layer coordinates). */
export function pathOfText(t) {
  const p = t.path;
  if (!p?.subpath) return null;
  if (!p.w0) return p.subpath;
  const kx = (t.box?.w || p.w0) / p.w0;
  const ky = (t.box?.h || p.h0) / p.h0;
  return kx === 1 && ky === 1 ? p.subpath : mapPath([p.subpath], ([x, y]) => [x * kx, y * ky])[0];
}

// ---------------------------------------------------------------- layout

function layoutHorizontal(t, G) {
  measureH(G);
  const kind = t.area ? 'area' : t.box ? 'box' : 'point';
  const content = String(t.content ?? '');
  const paras = paragraphs(content);
  const lines = [];
  const polys = kind === 'area' ? areaPaths(t).map((sp) => flatten(sp, 2)) : null;
  const boxW = t.box?.w ?? 0;
  const boxH = t.box?.h ?? 0;
  const bottom = kind === 'point' ? Infinity : boxH;
  let gk = 0;
  let top = 0;
  let overflow = false;
  const spanFor = (P, firstLine, y0, lh) => {
    const ind = P.indent;
    const x0Ind = (ind.left || 0) + (firstLine ? ind.first || 0 : 0);
    if (kind === 'point') return { x0: x0Ind, x1: Infinity };
    if (kind === 'box') return { x0: x0Ind, x1: boxW - (ind.right || 0) };
    const minW = lh * 0.6;
    for (const [a, b] of bandSpans(polys, y0, y0 + lh)) {
      const s = { x0: a + x0Ind, x1: b - (ind.right || 0) };
      if (s.x1 - s.x0 >= minW) return s;
    }
    return null;
  };
  paras.forEach((pr, pi) => {
    const P = paraStyle(t, pi);
    const ga = gk;
    while (gk < G.length && !G[gk].nl) gk++;
    const gb = gk;
    const nlGlyph = gk < G.length ? G[gk] : null;
    if (nlGlyph) gk++;
    if (overflow) {
      for (let k = ga; k < gk; k++) G[k].hidden = true;
      return;
    }
    if (pi > 0) top += P.spaceBefore || 0;
    const toks = tokens(G, ga, gb);
    let ti = 0;
    let lineNo = 0;
    const fallback = (G[ga] || nlGlyph || { st: { size: t.size } }).st.size;
    for (;;) {
      const rest = ti < toks.length ? [G[toks[ti][0]]] : nlGlyph ? [nlGlyph] : [];
      let lh = lineHeight(t, rest, fallback);
      let span = spanFor(P, lineNo === 0, top, lh);
      if (!span) {
        top += Math.max(2, lh / 4);
        if (top + lh > bottom) {
          overflow = true;
          for (let k = ga; k < gk; k++) if (!G[k].placed) G[k].hidden = true;
          return;
        }
        continue;
      }
      if (top + lh > bottom + 0.5 && kind === 'area') {
        overflow = true;
        for (let k = ga; k < gk; k++) if (!G[k].placed) G[k].hidden = true;
        return;
      }
      let fill = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const avail = span.x1 - span.x0;
        const ln = [];
        let lw = 0;
        let t2 = ti;
        let splitAt = null;
        while (t2 < toks.length) {
          const [a, b, kd] = toks[t2];
          let tw = 0;
          for (let k = a; k < b; k++) tw += G[k].w;
          if (kd === 's') {
            for (let k = a; k < b; k++) ln.push(k);
            lw += tw;
            t2++;
            continue;
          }
          const vis = tw - G[b - 1].track;
          if (ln.some((k) => !G[k].sp) && lw + vis > avail) break;
          if (!ln.some((k) => !G[k].sp) && lw + vis > avail && b - a > 1) {
            // a word longer than the line: break it
            let k = a;
            while (k < b && (k === a || lw + G[k].ink <= avail)) {
              ln.push(k);
              lw += G[k].w;
              k++;
            }
            if (k < b) splitAt = { t2, k };
            break;
          }
          for (let k = a; k < b; k++) ln.push(k);
          lw += tw;
          t2++;
        }
        const list = ln.map((k) => G[k]);
        const lh2 = lineHeight(t, list.length ? list : rest, fallback);
        fill = { ln, t2, splitAt, lh: lh2 };
        if (kind !== 'area' || lh2 <= lh + 0.5) break;
        const span2 = spanFor(P, lineNo === 0, top, lh2);
        lh = lh2;
        if (!span2) break;
        if (span2.x1 - span2.x0 >= span.x1 - span.x0 - 0.5) {
          span = span2;
          break;
        }
        span = span2;
      }
      if (kind === 'area' && top + fill.lh > bottom + 0.5) {
        overflow = true;
        for (let k = ga; k < gk; k++) if (!G[k].placed) G[k].hidden = true;
        return;
      }
      if (fill.splitAt) {
        const tk = toks[fill.splitAt.t2];
        toks[fill.splitAt.t2] = [fill.splitAt.k, tk[1], tk[2]];
        ti = fill.splitAt.t2;
      } else ti = fill.t2;
      const last = ti >= toks.length;
      const glyphs = [...fill.ln];
      if (last && nlGlyph) glyphs.push(gk - 1);
      for (const k of glyphs) G[k].placed = true;
      lines.push({ top, h: fill.lh, glyphs, span, para: pi, P, last, first: lineNo === 0 });
      top += fill.lh;
      lineNo++;
      if (last) break;
      if (kind !== 'point' && top >= bottom) {
        overflow = true;
        for (let k = ga; k < gk; k++) if (!G[k].placed) G[k].hidden = true;
        return;
      }
    }
    top += P.spaceAfter || 0;
  });
  // point text: the box is as wide as the longest line
  let W = boxW;
  if (kind === 'point') {
    W = 1;
    for (const ln of lines) {
      const vis = visibleWidth(G, ln.glyphs);
      W = Math.max(W, ln.span.x0 + vis + (ln.P.indent.right || 0));
    }
    for (const ln of lines) ln.span = { x0: ln.span.x0, x1: W - (ln.P.indent.right || 0) };
  }
  // positions
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const list = ln.glyphs.map((k) => G[k]);
    const ms = maxSize(list, t.size);
    ln.base = ln.top + (ln.h - ms) / 2 + ms * 0.88;
    const vis = visibleWidth(G, ln.glyphs);
    const avail = ln.span.x1 - ln.span.x0;
    const al = ln.P.align || 'left';
    const justify = al === 'justifyAll' || (al.startsWith('justify') && !ln.last);
    const lastAl = al === 'justify' ? 'left' : al === 'justifyCenter' ? 'center' : al === 'justifyRight' ? 'right' : al === 'justifyAll' ? 'left' : al;
    let x = ln.span.x0;
    let extra = 0;
    let byChar = false;
    const inner = trimmed(G, ln.glyphs);
    if (justify && Number.isFinite(avail) && inner.length > 1) {
      const gaps = inner.slice(0, -1).filter((k) => G[k].sp).length;
      byChar = !gaps;
      extra = (avail - vis) / (gaps || inner.length - 1);
      if (extra < 0 && !byChar) extra = Math.max(extra, -G[inner[0]].st.size * 0.2);
    } else if (Number.isFinite(avail)) {
      if (lastAl === 'center') x += (avail - vis) / 2;
      else if (lastAl === 'right') x += avail - vis;
    }
    ln.x0 = x;
    const lastInner = inner[inner.length - 1];
    const innerSet = extra ? new Set(inner) : null;
    for (const k of ln.glyphs) {
      const g = G[k];
      g.x = x;
      g.y = ln.base;
      g.line = li;
      x += g.w;
      if (extra && k !== lastInner && innerSet.has(k) && (byChar || g.sp)) x += extra;
      g.adv = x - g.x;
    }
    ln.x1 = x;
    if (kind === 'box' && ln.base > boxH + 0.5 && li > 0) {
      overflow = true;
      for (const k of ln.glyphs) G[k].hidden = true;
      ln.hidden = true;
    }
  }
  const H = kind === 'point' ? Math.max(lineHeight(t, [], t.size), top) : boxH;
  return { kind, lines, glyphs: G, w: Math.ceil(kind === 'point' ? W + 2 : boxW), h: Math.ceil(H), overflow, lh: lines[0]?.h || lineHeight(t, [], t.size) };
}

/** Glyph indices of a line without trailing spaces and newline. */
function trimmed(G, list) {
  let e = list.length;
  while (e > 0 && (G[list[e - 1]].sp || G[list[e - 1]].nl)) e--;
  return list.slice(0, e);
}
function visibleWidth(G, list) {
  const tr = trimmed(G, list);
  let w = 0;
  for (const k of tr) w += G[k].w;
  if (tr.length) w -= G[tr[tr.length - 1]].track;
  return Math.max(0, w);
}

/** Vertical text: columns right → left, characters top → bottom. */
function layoutVertical(t, G) {
  for (const g of G) {
    g.track = g.st.trackPx + g.st.kernPx;
    g.w = g.nl ? 0 : g.px * g.st.vs + g.track;
    g.cw = g.nl ? 0 : advance(g.font, g.d) * g.st.hs;
  }
  const paras = paragraphs(t.content);
  const cols = [];
  let gk = 0;
  const limit = t.box ? t.box.h : Infinity;
  paras.forEach((pr, pi) => {
    const P = paraStyle(t, pi);
    let col = [];
    let y = (P.indent.left || 0) + (P.indent.first || 0);
    const lim = limit - (P.indent.right || 0);
    while (gk < G.length && !G[gk].nl) {
      const g = G[gk];
      if (col.length && y + g.w - g.track > lim) {
        cols.push({ glyphs: col, P, para: pi, last: false });
        col = [];
        y = P.indent.left || 0;
      }
      col.push(gk);
      y += g.w;
      gk++;
    }
    if (gk < G.length) col.push(gk++);
    cols.push({ glyphs: col, P, para: pi, last: true });
  });
  let x = 0;
  const widths = cols.map((c) => lineHeight(t, c.glyphs.map((k) => G[k]), t.size));
  const total = widths.reduce((a, b) => a + b, 0);
  const W = t.box ? t.box.w : Math.max(1, total);
  let maxH = 0;
  for (const c of cols) {
    let s = 0;
    for (const k of c.glyphs) s += G[k].w;
    c.len = s;
    maxH = Math.max(maxH, s);
  }
  const H = t.box ? t.box.h : Math.max(1, maxH);
  cols.forEach((c, ci) => {
    const cw = widths[ci];
    const cx = W - x - cw / 2;
    x += cw;
    const al = c.P.align || 'left';
    const len = c.len - (c.glyphs.length ? G[c.glyphs[c.glyphs.length - 1]].track : 0);
    let y = c.P.indent.left || 0;
    if (al === 'center' || al === 'justifyCenter') y += (H - y - (c.P.indent.right || 0) - len) / 2;
    else if (al === 'right' || al === 'justifyRight') y = H - (c.P.indent.right || 0) - len;
    c.top = y;
    c.cx = cx;
    c.w = cw;
    for (const k of c.glyphs) {
      const g = G[k];
      g.x = cx;
      g.y = y;
      g.line = ci;
      y += g.w;
    }
    c.bottom = y;
  });
  return { kind: 'vertical', vertical: true, lines: cols, glyphs: G, w: Math.ceil(W + 2), h: Math.ceil(H + 2), lh: widths[0] || t.size };
}

/** Type on a path: glyph centres and angles along the (scaled) path. */
function layoutPath(t, G) {
  measureH(G);
  const sp = pathOfText(t);
  let pts = flatten(sp, 1);
  if (pts.length < 2) pts = [[0, 0], [1, 0]];
  const p = t.path;
  const flip = !!p.flip;
  if (flip) pts = [...pts].reverse();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1] || 1;
  let s0 = clamp(p.start ?? p.offset ?? 0, 0, 1);
  let s1 = clamp(p.end ?? 1, 0, 1);
  if (flip) [s0, s1] = [1 - s1, 1 - s0];
  let a = s0 * total;
  let b = s1 * total;
  const closed = !!sp.closed;
  if (b <= a) b += closed ? total : 0;
  if (b <= a) b = a;
  const visible = G.filter((g) => !g.nl);
  let width = 0;
  for (const g of visible) width += g.w;
  if (visible.length) width -= visible[visible.length - 1].track;
  const al = paraStyle(t, 0).align || 'left';
  let d = a;
  let extra = 0;
  if (al === 'center' || al === 'justifyCenter') d = a + (b - a - width) / 2;
  else if (al === 'right' || al === 'justifyRight') d = b - width;
  else if (al === 'justifyAll' && visible.length > 1) extra = (b - a - width) / (visible.length - 1);
  const at = (dist) => {
    if (closed) dist = ((dist % total) + total) % total;
    let lo = 1;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < dist) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const k = (dist - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k, ang: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) };
  };
  let overflow = false;
  for (const g of G) {
    g.line = 0;
    if (g.nl) {
      g.w = 0;
      g.hidden = true;
      g.d0 = d;
      continue;
    }
    const mid = d + (g.w - g.track) / 2;
    g.d0 = d;
    if (mid > b + 0.01 || mid < a - 0.01 || (!closed && (mid > total || mid < 0))) {
      g.hidden = true;
      if (mid > b) overflow = true;
    } else {
      const q = at(mid);
      g.x = q.x;
      g.y = q.y;
      g.ang = q.ang;
    }
    d += g.w + extra;
  }
  const W = t.box?.w ?? 0;
  const H = t.box?.h ?? 0;
  return { kind: 'path', path: true, glyphs: G, lines: [], w: Math.ceil(W), h: Math.ceil(H), overflow, total, a, b, flip, at, pts, lh: t.size };
}

const layoutCache = new WeakMap();
/** The laid-out text of a layer (cached while the text is unchanged). */
export function textLayout(layerOrText) {
  const t = layerOrText.text || layerOrText;
  const key = JSON.stringify(t);
  const hit = layoutCache.get(t);
  if (hit && hit.key === key) return hit.L;
  const G = buildGlyphs(t);
  let L;
  if (t.path?.subpath) {
    L = layoutPath(t, G);
    if (!t.path.w0) {
      // older type on a path: the path in layer coordinates, no box
      const b = pathBounds([t.path.subpath]) || { x: 0, y: 0, w: 1, h: 1 };
      const pad = (t.size || 72) * 1.3;
      L.w = Math.ceil(Math.max(1, b.x + b.w + pad));
      L.h = Math.ceil(Math.max(1, b.y + b.h + pad));
    }
  } else if (t.vertical) L = layoutVertical(t, G);
  else L = layoutHorizontal(t, G);
  layoutCache.set(t, { key, L });
  return L;
}
/** Kept for older callers: the lines of a text layer in its unrotated, unwarped box. */
export const layoutText = (t) => textLayout(t);

// ---------------------------------------------------------------- drawing

function drawGlyph(g, G, color) {
  const st = G.st;
  const plain = st.hs === 1 && st.vs === 1 && !st.fauxItalic && !st.fauxBold;
  if (plain && G.ang == null) {
    g.fillText(G.d, G.x, G.y - st.shift);
    return;
  }
  g.save();
  if (G.ang != null) {
    g.translate(G.x, G.y);
    g.rotate(G.ang);
    g.translate(-(G.ink ?? G.w) / 2, -st.shift);
  } else g.translate(G.x, G.y - st.shift);
  if (st.hs !== 1 || st.vs !== 1) g.scale(st.hs, st.vs);
  if (st.fauxItalic) g.transform(1, 0, -0.21, 1, 0, 0);
  g.fillText(G.d, 0, 0);
  if (st.fauxBold) {
    g.strokeStyle = color;
    g.lineJoin = 'round';
    g.lineWidth = G.px * 0.045;
    g.strokeText(G.d, 0, 0);
  }
  g.restore();
}

function drawLayout(g, t, L) {
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  if ('fontKerning' in g) g.fontKerning = 'normal';
  let font = '';
  let fill = '';
  const setStyle = (G) => {
    if (G.font !== font) {
      g.font = G.font;
      font = G.font;
    }
    if (G.st.color !== fill) {
      g.fillStyle = G.st.color;
      fill = G.st.color;
    }
  };
  if (L.vertical) {
    for (const G of L.glyphs) {
      if (G.nl || G.hidden || G.sp) continue;
      setStyle(G);
      const st = G.st;
      g.save();
      g.translate(G.x - G.cw / 2 + (st.baseline || 0), G.y + G.px * 0.88 * st.vs);
      g.scale(st.hs, st.vs);
      if (st.fauxItalic) g.transform(1, 0, -0.21, 1, 0, 0);
      g.fillText(G.d, 0, 0);
      if (st.fauxBold) {
        g.strokeStyle = st.color;
        g.lineJoin = 'round';
        g.lineWidth = G.px * 0.045;
        g.strokeText(G.d, 0, 0);
      }
      g.restore();
      if (st.underline || st.strike) {
        const th = Math.max(1, st.size / 15);
        const col = L.lines[G.line];
        if (st.underline) g.fillRect(col.cx + col.w / 2 - th * 1.5, G.y, th, G.w);
        if (st.strike) g.fillRect(col.cx - th / 2, G.y, th, G.w);
      }
    }
    return;
  }
  for (const G of L.glyphs) {
    if (G.nl || G.hidden) continue;
    setStyle(G);
    if (!G.sp) drawGlyph(g, G, G.st.color);
  }
  // underline and strikethrough under each run, trailing spaces left out
  if (L.path) {
    for (const G of L.glyphs) {
      if (G.hidden || G.nl || !(G.st.underline || G.st.strike)) continue;
      const th = Math.max(1, G.st.size / 15);
      g.save();
      g.fillStyle = G.st.color;
      g.translate(G.x, G.y);
      g.rotate(G.ang);
      if (G.st.underline) g.fillRect(-G.w / 2, th * 1.6, G.w, th);
      if (G.st.strike) g.fillRect(-G.w / 2, -G.st.shift - G.px * 0.3, G.w, th);
      g.restore();
    }
    return;
  }
  for (const ln of L.lines) {
    if (ln.hidden) continue;
    const vis = trimmed(L.glyphs, ln.glyphs);
    vis.forEach((k, j) => {
      const G = L.glyphs[k];
      if (!G.st.underline && !G.st.strike) return;
      const th = Math.max(1, G.st.size / 15);
      const w = j === vis.length - 1 ? G.adv - G.track : G.adv;
      g.fillStyle = G.st.color;
      if (G.st.underline) g.fillRect(G.x, ln.base + th * 1.6, w, th);
      if (G.st.strike) g.fillRect(G.x, G.y - G.st.shift - G.px * 0.3, w, th);
    });
  }
}

/** Photoshop's anti-aliasing methods as an alpha curve on the drawn text. */
function antiAlias(out, mode) {
  if (!out || !mode || mode === 'sharp') return out;
  const c = out.canvas;
  if (mode === 'smooth') {
    const s = makeCanvas(c.width, c.height);
    const sg = s.getContext('2d');
    sg.filter = 'blur(0.45px)';
    sg.drawImage(c, 0, 0);
    return { ...out, canvas: s };
  }
  const g = c.getContext('2d');
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const lut = new Uint8ClampedArray(256);
  for (let a = 0; a < 256; a++) lut[a] = mode === 'none' ? (a >= 128 ? 255 : 0) : mode === 'crisp' ? (a - 128) * 1.45 + 128 : a * 1.6;
  for (let i = 3; i < d.length; i += 4) if (d[i]) d[i] = lut[d[i]];
  g.putImageData(img, 0, 0);
  return out;
}

// ---------------------------------------------------------------- fonts used by runs

const fontWaits = new Set();
let fontReady = null;
/** Called with the layer when a font used by its runs has loaded (type2.js redraws it). */
export function onTextFontReady(fn) {
  fontReady = fn;
}
function loadRunFonts(layer, L) {
  const t = layer.text;
  if (!t.runs || typeof document === 'undefined') return;
  const need = new Map();
  for (const G of L.glyphs) {
    const st = G.st;
    if (st.font === t.font && st.bold === !!t.bold && st.italic === !!t.italic) continue;
    const k = `${st.font}|${st.bold}|${st.italic}`;
    need.set(k, (need.get(k) || '') + G.ch);
  }
  for (const [k, text] of need) {
    const key = `${k}|${text}`;
    if (fontWaits.has(key)) continue;
    if (fontWaits.size > 2000) fontWaits.clear();
    fontWaits.add(key);
    const [font, bold, italic] = k.split('|');
    let ready = false;
    try {
      const faces = [...document.fonts].some((f) => f.family.replace(/^["']|["']$/g, '') === font);
      ready = faces ? document.fonts.check(`${italic === 'true' ? 'italic ' : ''}${bold === 'true' ? 700 : 400} 16px "${font}"`, text) : !isWebFont(font);
    } catch { /* load it */ }
    if (!ready) loadFontFor(font, text, { bold: bold === 'true', italic: italic === 'true' }).then(() => fontReady?.(layer)).catch(() => {});
  }
}

// ---------------------------------------------------------------- doc.js hooks

function measure(layer) {
  const L = textLayout(layer);
  const lines = L.path ? [String(layer.text.content ?? '')] : L.lines.map((ln) => ln.glyphs.map((k) => L.glyphs[k].ch).join('').replace(/\n$/, ''));
  return { w: Math.max(1, L.w), h: Math.max(1, L.h), lh: L.lh, lines, layout: L };
}

function render(layer, rotatedBox) {
  const t = layer.text;
  const L = textLayout(layer);
  loadRunFonts(layer, L);
  let big = t.size || 72;
  let shift = 0;
  for (const G of L.glyphs) {
    if (G.st.size > big) big = G.st.size;
    shift = Math.max(shift, Math.abs(G.st.shift));
  }
  if (L.path && !t.path.w0) {
    // older type on a path: drawn in place, without a box to turn
    const c = makeCanvas(L.w + big, L.h + big);
    drawLayout(c.getContext('2d'), t, L);
    return antiAlias({ canvas: c, x: Math.round(layer.x), y: Math.round(layer.y) }, t.aa);
  }
  if (L.path) return antiAlias(rotatedBox(layer, L.w, L.h, (g) => drawLayout(g, t, L), Math.ceil(big * 1.5 + shift)), t.aa);
  if (t.warp && t.warp.style && t.warp.style !== 'none') {
    const src = makeCanvas(L.w, L.h);
    drawLayout(src.getContext('2d'), t, L);
    const wr = meshWarp(src, warpGrid(t.warp, L.w, L.h), 16, 16);
    const pad = Math.ceil(Math.max(0, -wr.x, -wr.y, wr.x + wr.canvas.width - L.w, wr.y + wr.canvas.height - L.h));
    return antiAlias(rotatedBox(layer, L.w, L.h, (g) => g.drawImage(wr.canvas, wr.x, wr.y), pad), t.aa);
  }
  return antiAlias(rotatedBox(layer, L.w, L.h, (g) => drawLayout(g, t, L), Math.ceil(big * 0.5 + shift)), t.aa);
}

setTextEngine(render, measure);

// ---------------------------------------------------------------- geometry for editing

/** Doc point → the layer's unrotated box coordinates (and back), for a box of w×h. */
export function toLocal(layer, w, h, x, y) {
  const rot = ((layer.rotation || 0) * Math.PI) / 180;
  const cx = layer.x + w / 2;
  const cy = layer.y + h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const ux = dx * Math.cos(rot) + dy * Math.sin(rot);
  const uy = -dx * Math.sin(rot) + dy * Math.cos(rot);
  const tk = layer.skewX ? Math.tan((layer.skewX * Math.PI) / 180) : 0;
  return [ux - tk * uy + w / 2, uy + h / 2];
}
export function toDoc(layer, w, h, x, y) {
  const rot = ((layer.rotation || 0) * Math.PI) / 180;
  const tk = layer.skewX ? Math.tan((layer.skewX * Math.PI) / 180) : 0;
  const dx = x - w / 2 + tk * (y - h / 2);
  const dy = y - h / 2;
  return [layer.x + w / 2 + dx * Math.cos(rot) - dy * Math.sin(rot), layer.y + h / 2 + dx * Math.sin(rot) + dy * Math.cos(rot)];
}

const glyphAt = (L, i) => {
  for (const G of L.glyphs) if (i >= G.i && i < G.i + G.len) return G;
  return null;
};

/** The caret at index i as a segment [[x, y], [x, y]] in box coordinates. */
export function caretSegment(L, t, i) {
  const G = L.glyphs;
  const n = String(t.content ?? '').length;
  if (L.path) {
    const g = glyphAt(L, i) || G[G.length - 1];
    let d;
    if (!g) d = L.a;
    else if (i >= n) d = g.d0 + (g.nl ? 0 : g.w - g.track);
    else d = g.d0;
    const q = L.at(Math.max(L.a, Math.min(L.b, d)));
    const s = (g?.st.size || t.size) * 0.9;
    const nx = Math.sin(q.ang);
    const ny = -Math.cos(q.ang);
    return [[q.x, q.y], [q.x + nx * s, q.y + ny * s]];
  }
  if (L.vertical) {
    const g = glyphAt(L, i);
    if (g) {
      const c = L.lines[g.line];
      return [[c.cx - c.w / 2, g.y], [c.cx + c.w / 2, g.y]];
    }
    const c = L.lines[L.lines.length - 1];
    if (!c) return [[0, 0], [t.size, 0]];
    return [[c.cx - c.w / 2, c.bottom], [c.cx + c.w / 2, c.bottom]];
  }
  const g = glyphAt(L, i);
  let ln;
  let x;
  if (g && !g.hidden) {
    ln = L.lines[g.line];
    x = g.x;
  } else {
    ln = L.lines[L.lines.length - 1];
    if (!ln) return [[0, 0], [0, t.size]];
    const vis = ln.glyphs.filter((k) => !G[k].nl);
    const lg = vis.length ? G[vis[vis.length - 1]] : null;
    x = lg ? lg.x + lg.w - lg.track : ln.x0;
  }
  return [[x, ln.top], [x, ln.top + ln.h]];
}

/** Selection of characters a..b as polygons (box coordinates). */
export function selectionPolys(L, t, a, b) {
  const out = [];
  if (b <= a) return out;
  const G = L.glyphs;
  if (L.path) {
    for (const g of G) {
      if (g.hidden || g.nl || g.i + g.len <= a || g.i >= b) continue;
      const s = g.st.size;
      const cos = Math.cos(g.ang);
      const sin = Math.sin(g.ang);
      const hw = g.w / 2;
      const pt = (u, v) => [g.x + u * cos - v * sin, g.y + u * sin + v * cos];
      out.push([pt(-hw, s * 0.25), pt(hw, s * 0.25), pt(hw, -s * 0.9), pt(-hw, -s * 0.9)]);
    }
    return out;
  }
  if (L.vertical) {
    for (const c of L.lines) {
      const ks = c.glyphs.filter((k) => G[k].i + G[k].len > a && G[k].i < b);
      if (!ks.length) continue;
      const y0 = G[ks[0]].y;
      const last = G[ks[ks.length - 1]];
      const y1 = last.y + (last.nl ? c.w * 0.3 : last.w);
      out.push([[c.cx - c.w / 2, y0], [c.cx + c.w / 2, y0], [c.cx + c.w / 2, y1], [c.cx - c.w / 2, y1]]);
    }
    return out;
  }
  for (const ln of L.lines) {
    if (ln.hidden) continue;
    const ks = ln.glyphs.filter((k) => G[k].i + G[k].len > a && G[k].i < b);
    if (!ks.length) continue;
    const x0 = G[ks[0]].x;
    const last = G[ks[ks.length - 1]];
    const x1 = last.nl ? last.x + ln.h * 0.25 : last.x + last.adv;
    out.push([[x0, ln.top], [x1, ln.top], [x1, ln.top + ln.h], [x0, ln.top + ln.h]]);
  }
  return out;
}

/** The caret index nearest a point in box coordinates. */
export function indexAtPoint(L, t, x, y) {
  const G = L.glyphs;
  const n = String(t.content ?? '').length;
  if (!G.length) return 0;
  if (L.path) {
    let best = null;
    for (const g of G) {
      if (g.hidden || g.nl) continue;
      const d = Math.hypot(g.x - x, g.y - y);
      if (!best || d < best.d) best = { g, d };
    }
    if (!best) return n;
    const g = best.g;
    const along = (x - g.x) * Math.cos(g.ang) + (y - g.y) * Math.sin(g.ang);
    return along > 0 ? g.i + g.len : g.i;
  }
  if (L.vertical) {
    let ci = 0;
    let bd = Infinity;
    L.lines.forEach((c, i) => {
      const d = Math.abs(c.cx - x);
      if (d < bd) {
        bd = d;
        ci = i;
      }
    });
    const c = L.lines[ci];
    for (const k of c.glyphs) {
      const g = G[k];
      if (g.nl) return g.i;
      if (y < g.y + g.w / 2) return g.i;
    }
    const last = G[c.glyphs[c.glyphs.length - 1]];
    return last ? last.i + (last.nl ? 0 : last.len) : n;
  }
  const lines = L.lines.filter((ln) => !ln.hidden);
  if (!lines.length) return n;
  let ln = lines.find((l) => y >= l.top && y < l.top + l.h);
  if (!ln) ln = y < lines[0].top ? lines[0] : lines[lines.length - 1];
  for (const k of ln.glyphs) {
    const g = G[k];
    if (g.nl) return g.i;
    if (x < g.x + g.adv / 2) return g.i;
  }
  const last = G[ln.glyphs[ln.glyphs.length - 1]];
  if (!last) {
    // an empty last line: the end of the text
    return n;
  }
  const end = last.i + last.len;
  // a soft-wrapped line ends before its trailing space so the caret stays on this line
  return ln === lines[lines.length - 1] || last.nl ? end : Math.max(last.i, end - (last.sp ? last.len : 0));
}

/** Word (or run of spaces) around index i: [a, b]. */
export function wordAt(content, i) {
  const s = String(content ?? '');
  if (!s) return [0, 0];
  const kind = (c) => (c === undefined || c === '\n' ? 'n' : /\s/.test(c) ? 's' : CJK.test(c) ? 'w' : /[\p{L}\p{N}_]/u.test(c) ? 'w' : 'p');
  let k = kind(s[i]);
  if (k === 'n' && i > 0) {
    i--;
    k = kind(s[i]);
  }
  let a = i;
  let b = i;
  while (a > 0 && kind(s[a - 1]) === k) a--;
  while (b < s.length && kind(s[b]) === k) b++;
  return [a, b];
}

// ---------------------------------------------------------------- new text

/** Default text properties for a new text layer. */
export function newText(o, color, extra = {}) {
  return {
    content: '', font: o.font || 'Noto Sans KR', size: o.size || 72, color, bold: !!o.bold, italic: !!o.italic, align: o.align || 'left',
    lineHeight: 1.2, letterSpacing: 0, underline: false, strike: false, caps: 'none', hScale: 100, vScale: 100, baseline: 0,
    vertical: false, box: null, indent: { left: 0, right: 0, first: 0 }, spaceBefore: 0, spaceAfter: 0, warp: null, path: null,
    kerning: 'metrics', aa: o.aa || 'sharp', fauxBold: false, fauxItalic: false, script: 'none', runs: null, paras: null, area: null, ...extra,
  };
}
