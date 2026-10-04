// Type engine for text layers: point and paragraph (box) text with word wrap and justification,
// vertical text, tracking, horizontal/vertical scale, baseline shift, underline/strike, caps,
// indents and paragraph spacing, text warp (arc, flag…) and text on a path.
// Plugs into doc.js through setTextEngine().

import { setTextEngine, makeCanvas } from './doc.js';
import { meshWarp, warpGrid } from './transform.js';
import { flatten, translatePath } from './paths.js';

const mctx = () => (mctx.c ||= makeCanvas(1, 1).getContext('2d'));
const CJK = /[ᄀ-ᇿ　-鿿가-힯豈-﫿＀-￯]/;

export function fontString(t, size = t.size) {
  const caps = t.caps === 'small' ? 'small-caps ' : '';
  return `${t.italic ? 'italic ' : ''}${caps}${t.bold ? '700' : '400'} ${size}px "${t.font}", "Noto Sans KR", sans-serif`;
}
const content = (t) => {
  const s = String(t.content ?? '');
  return t.caps === 'all' ? s.toUpperCase() : s;
};
/** Tracking in px (stored as px; the panel shows Photoshop's 1/1000 em). */
const track = (t) => t.letterSpacing || 0;
const hs = (t) => (t.hScale ?? 100) / 100;

function charW(g, ch, t) {
  return g.measureText(ch).width * hs(t) + track(t);
}
/** Plain runs (no tracking or scaling) are measured and drawn whole, keeping the font's kerning. */
const plain = (t) => !track(t) && hs(t) === 1;
function textW(g, s, t) {
  if (!s) return 0;
  if (plain(t)) return g.measureText(s).width;
  let w = 0;
  for (const ch of s) w += charW(g, ch, t);
  return w;
}

/** Split a paragraph into wrap tokens: words, single CJK characters and runs of spaces. */
function tokens(s) {
  const out = [];
  let cur = '';
  let kind = '';
  for (const ch of s) {
    const k = ch === ' ' || ch === '\t' ? 's' : CJK.test(ch) ? 'c' : 'w';
    if (k === 'c') {
      if (cur) out.push(cur);
      out.push(ch);
      cur = '';
      kind = '';
      continue;
    }
    if (k !== kind && cur) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
    kind = k;
  }
  if (cur) out.push(cur);
  return out;
}

/** Lines of a text layer in its unrotated, unwarped box. */
export function layoutText(t) {
  const g = mctx();
  g.font = fontString(t);
  const lh = t.leading ? t.leading : t.size * (t.lineHeight || 1.2);
  const ind = t.indent || {};
  const paras = content(t).split('\n');
  const lines = [];
  if (t.vertical) {
    // columns right → left, characters top → bottom
    const adv = t.size * ((t.vScale ?? 100) / 100) + track(t);
    let maxN = 1;
    const cols = [];
    for (const p of paras) {
      const chars = [...p];
      if (t.box) {
        const per = Math.max(1, Math.floor(t.box.h / adv));
        for (let i = 0; i < Math.max(1, chars.length); i += per) cols.push(chars.slice(i, i + per));
      } else cols.push(chars);
    }
    for (const c of cols) maxN = Math.max(maxN, c.length);
    const w = t.box ? t.box.w : Math.max(1, cols.length) * lh;
    const h = t.box ? t.box.h : maxN * adv;
    return { vertical: true, cols, adv, lh, w: Math.ceil(w + 2), h: Math.ceil(h + 2), lines: cols.map((c) => c.join('')) };
  }
  const boxW = t.box ? t.box.w : null;
  let y = 0;
  paras.forEach((p, pi) => {
    if (pi > 0 || t.spaceBefore) y += pi > 0 ? t.spaceBefore || 0 : 0;
    const startY = y;
    const first = ind.first || 0;
    if (boxW == null) {
      lines.push({ s: p, w: textW(g, p, t), y, para: pi, last: true, left: ind.left || 0, first });
      y += lh;
    } else {
      const avail = (i) => boxW - (ind.left || 0) - (ind.right || 0) - (i === 0 ? first : 0);
      let line = '';
      let lw = 0;
      let li = 0;
      const push = (last) => {
        const s = line.replace(/\s+$/, '');
        lines.push({ s, w: textW(g, s, t), y, para: pi, last, left: (ind.left || 0) + (li === 0 ? first : 0), avail: avail(li) });
        y += lh;
        li++;
        line = '';
        lw = 0;
      };
      for (const tok of tokens(p)) {
        const tw = textW(g, tok, t);
        if (lw + tw > avail(li) && line.trim()) {
          push(false);
          if (/^\s+$/.test(tok)) continue;
        }
        if (tw > avail(li)) {
          // a word longer than the box: break it
          for (const ch of tok) {
            const cw = charW(g, ch, t);
            if (lw + cw > avail(li) && line) push(false);
            line += ch;
            lw += cw;
          }
          continue;
        }
        line += tok;
        lw += tw;
      }
      push(true);
    }
    if (t.spaceAfter) y += t.spaceAfter;
    void startY;
  });
  const w = boxW ?? Math.max(1, ...lines.map((l) => l.w + (l.left || 0) + (l.first || 0)));
  const h = t.box ? t.box.h : Math.max(lh, y);
  return { lines, lh, w: Math.ceil(w + 2), h: Math.ceil(h), vertical: false };
}

/** Draw the laid-out text into g (origin = box top-left). */
function drawText(g, t, L) {
  g.font = fontString(t);
  g.fillStyle = t.color || '#000000';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  const asc = t.size * 0.88;
  const thick = Math.max(1, t.size / 15);
  const vs = (t.vScale ?? 100) / 100;
  if (L.vertical) {
    const colX = (i) => L.w - (i + 0.5) * L.lh;
    L.cols.forEach((col, ci) => {
      const total = col.length * L.adv;
      const off = t.align === 'center' ? (L.h - total) / 2 : t.align === 'right' ? L.h - total : 0;
      col.forEach((ch, k) => {
        const cw = g.measureText(ch).width;
        g.save();
        g.translate(colX(ci) - (cw * hs(t)) / 2, off + k * L.adv + asc * vs - (t.baseline || 0));
        g.scale(hs(t), vs);
        g.fillText(ch, 0, 0);
        g.restore();
      });
    });
    return;
  }
  for (const ln of L.lines) {
    const avail = ln.avail ?? L.w;
    let x0 = ln.left || 0;
    const align = t.align || 'left';
    const justify = (align === 'justify' && !ln.last) || align === 'justifyAll';
    if (!justify) {
      if (align === 'center') x0 += (avail - ln.w) / 2;
      else if (align === 'right') x0 += avail - ln.w;
    }
    const y = ln.y + (L.lh - t.size) / 2 + asc - (t.baseline || 0);
    const chars = [...ln.s];
    let extra = 0;
    let gaps = 0;
    if (justify && chars.length > 1) {
      gaps = chars.filter((c) => c === ' ').length;
      extra = (avail - ln.w) / (gaps || chars.length - 1);
    }
    let x = x0;
    if (!justify && plain(t) && vs === 1) {
      g.fillText(ln.s, x0, y);
      x = x0 + g.measureText(ln.s).width;
    } else for (const ch of chars) {
      g.save();
      g.translate(x, y);
      g.scale(hs(t), vs);
      g.fillText(ch, 0, 0);
      g.restore();
      x += charW(g, ch, t);
      if (justify && (gaps ? ch === ' ' : true)) x += extra;
    }
    const lineEnd = x;
    if (t.underline || t.strike) {
      g.fillStyle = t.color || '#000000';
      if (t.underline) g.fillRect(x0, y + thick * 1.6, lineEnd - x0 - track(t), thick);
      if (t.strike) g.fillRect(x0, y - t.size * 0.3, lineEnd - x0 - track(t), thick);
    }
  }
}

/** Text placed along a path (the path is stored in layer coordinates). */
function renderOnPath(layer) {
  const t = layer.text;
  const sp = translatePath([t.path.subpath], layer.x, layer.y)[0];
  const pts = flatten(sp, 1);
  const g0 = mctx();
  g0.font = fontString(t);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1] || 1;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = t.size * 1.5;
  const x0 = Math.floor(Math.min(...xs) - pad);
  const y0 = Math.floor(Math.min(...ys) - pad);
  const c = makeCanvas(Math.max(...xs) - x0 + pad, Math.max(...ys) - y0 + pad);
  const g = c.getContext('2d');
  g.font = fontString(t);
  g.fillStyle = t.color || '#000';
  g.textBaseline = 'alphabetic';
  const s = [...content(t).replace(/\n/g, ' ')];
  const width = textW(g0, s.join(''), t);
  let d = (t.path.offset || 0) * total;
  if (t.align === 'center') d += (total - width) / 2;
  else if (t.align === 'right') d += total - width;
  const at = (dist) => {
    let i = cum.findIndex((v) => v >= dist);
    if (i <= 0) i = 1;
    const k = (dist - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    const p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
    return { p, a: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) };
  };
  for (const ch of s) {
    const cw = charW(g0, ch, t);
    const mid = d + cw / 2;
    if (mid > total) break;
    if (mid >= 0) {
      const { p, a } = at(mid);
      g.save();
      g.translate(p[0] - x0, p[1] - y0);
      g.rotate(a);
      g.scale(hs(t), (t.vScale ?? 100) / 100);
      g.fillText(ch, -cw / 2 / hs(t), -(t.baseline || 0));
      g.restore();
    }
    d += cw;
  }
  return { canvas: c, x: x0, y: y0 };
}

function measure(layer) {
  const t = layer.text;
  if (t.path) {
    const sp = t.path.subpath;
    const pts = flatten(sp, 4);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(t.size, Math.max(...ys) - Math.min(...ys)), lh: t.size, lines: [content(t)] };
  }
  const L = layoutText(t);
  return { w: L.w, h: L.h, lh: L.lh, lines: L.lines.map((l) => (typeof l === 'string' ? l : l.s)), layout: L };
}

function render(layer, rotatedBox) {
  const t = layer.text;
  if (t.path) return renderOnPath(layer);
  const L = layoutText(t);
  if (t.warp && t.warp.style && t.warp.style !== 'none') {
    const src = makeCanvas(L.w, L.h);
    drawText(src.getContext('2d'), t, L);
    const wr = meshWarp(src, warpGrid(t.warp, L.w, L.h), 16, 16);
    const pad = Math.ceil(Math.max(0, -wr.x, -wr.y, wr.x + wr.canvas.width - L.w, wr.y + wr.canvas.height - L.h));
    return rotatedBox(layer, L.w, L.h, (g) => g.drawImage(wr.canvas, wr.x, wr.y), pad);
  }
  return rotatedBox(layer, L.w, L.h, (g) => drawText(g, t, L), Math.ceil(t.size * 0.3));
}

setTextEngine(render, measure);

/** Default text properties for a new text layer. */
export function newText(o, color, extra = {}) {
  return {
    content: '', font: o.font || 'Noto Sans KR', size: o.size || 72, color, bold: !!o.bold, italic: !!o.italic, align: o.align || 'left',
    lineHeight: 1.2, letterSpacing: 0, underline: false, strike: false, caps: 'none', hScale: 100, vScale: 100, baseline: 0,
    vertical: false, box: null, indent: { left: 0, right: 0, first: 0 }, spaceBefore: 0, spaceAfter: 0, warp: null, path: null, ...extra,
  };
}
