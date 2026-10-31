// The marquee tools and the magic wand as in Photoshop: Style (Normal, Fixed Ratio, Fixed Size) with
// width and height, feather and anti-alias, Shift / Alt / Shift+Alt before a drag for add / subtract /
// intersect and during it for a square (circle) / from the centre, Space held to move the marquee
// being drawn, whole-pixel edges; the magic wand's Sample Size and Anti-alias; and arrow keys that
// move the selection outline with any selection tool (Shift: 10 pixels).

import { h } from '../util.js';
import { icon } from '../ui/icons.js';
import { makeCanvas } from './doc.js';
import { TOOL_BY_ID, SEL_MODE_OPT, selMode, deselectByClick } from './tools.js';
import * as SEL from './selection.js';

const STYLES = [['normal', '표준'], ['ratio', '고정 비율'], ['size', '고정 크기']];
const SELECTION_TOOLS = ['rect', 'ellipse', 'row', 'col', 'lasso', 'polyLasso', 'magLasso', 'quickSel', 'objSel', 'wand'];

/** Keys held right now (pointer events carry Shift and Alt, but not Space). */
const held = { space: false, shift: false, alt: false };

function marquee(id, ellipse) {
  return {
    marquee: true,
    options: [
      SEL_MODE_OPT,
      ['feather', '페더', 'range', 0, 250, 0, 'px'],
      ...(ellipse ? [['antialias', '앤티 앨리어스', 'bool', null, null, true]] : []),
      ['style', '스타일', 'select', null, null, 'normal', STYLES],
    ],
    /** Width and height fields for the fixed styles (the options bar shows them after Style). */
    styleFields(E) {
      const o = E.opts(id);
      if (!o.style || o.style === 'normal') return [];
      const ratio = o.style === 'ratio';
      const [kw, kh, def] = ratio ? ['ratioW', 'ratioH', 1] : ['sizeW', 'sizeH', 64];
      const field = (key, label) => {
        const n = h('input.ph-num', { type: 'number', min: ratio ? 0.01 : 1, max: 30000, step: ratio ? 0.1 : 1, value: o[key] ?? def, 'aria-label': label });
        n.addEventListener('change', () => E.setOpt(id, key, Math.max(ratio ? 0.01 : 1, +n.value || def)));
        return h('label.ph-opt', h('span', label), n, ratio ? null : h('small', 'px'));
      };
      const swap = h('button.small', {
        title: '폭과 높이 바꾸기', 'aria-label': '폭과 높이 바꾸기',
        onclick: () => {
          const w = o[kw] ?? def;
          E.setOpt(id, kw, o[kh] ?? def);
          E.setOpt(id, kh, w);
        },
      }, icon('swap'));
      return [field(kw, '폭'), swap, field(kh, '높이')];
    },
    down(E, p, e) {
      const o = E.opts(id);
      const mode = selMode(E, e, id);
      // a plain drag inside the selection moves the outline
      if (E.doc.selection && mode === 'new' && !e.shiftKey && !e.altKey && o.style !== 'size' && E.selAt(p) > 0) {
        this.d = { moveSel: true, a: p, b: p };
        return;
      }
      // a modifier held at the start picks the mode; pressed again later it shapes the marquee.
      // With nothing selected there is nothing to add to or take from: they shape it at once.
      const fresh = !E.doc.selection;
      this.d = { a: { x: p.x, y: p.y }, b: p, last: p, mode: fresh ? 'new' : mode, shift0: !fresh && e.shiftKey, alt0: !fresh && e.altKey, square: fresh && e.shiftKey, center: fresh && e.altKey };
      E.overlay();
    },
    move(E, p, e) {
      const d = this.d;
      if (!d) return;
      if (d.moveSel) {
        d.b = p;
        E.overlay();
        return;
      }
      this.track(E, p, e.shiftKey, e.altKey);
    },
    track(E, p, shift, alt) {
      const d = this.d;
      // Space held: the whole marquee moves with the pointer
      if (held.space) {
        d.a.x += p.x - d.last.x;
        d.a.y += p.y - d.last.y;
      }
      d.last = p;
      d.b = p;
      if (d.shift0 && !shift) d.shift0 = false;
      if (d.alt0 && !alt) d.alt0 = false;
      d.square = shift && !d.shift0;
      d.center = alt && !d.alt0;
      E.overlay();
    },
    /** The marquee in doc pixels, edges on whole pixels. */
    rect(E) {
      const d = this.d;
      const o = E.opts(id);
      const { a, b } = d;
      let r;
      if (o.style === 'size') {
        const w = Math.max(1, Math.round(o.sizeW ?? 64));
        const hh = Math.max(1, Math.round(o.sizeH ?? 64));
        r = d.center ? { x: b.x - w / 2, y: b.y - hh / 2, w, h: hh } : { x: b.x, y: b.y, w, h: hh };
        const x = Math.round(r.x);
        const y = Math.round(r.y);
        return { x, y, w, h: hh };
      }
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const ratio = o.style === 'ratio' ? Math.max(0.01, o.ratioW ?? 1) / Math.max(0.01, o.ratioH ?? 1) : d.square ? 1 : 0;
      if (ratio) {
        const W = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
        dx = Math.sign(dx || 1) * W;
        dy = Math.sign(dy || 1) * (W / ratio);
      }
      if (d.center) r = { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) };
      else r = { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
      const x0 = Math.round(r.x);
      const y0 = Math.round(r.y);
      return { x: x0, y: y0, w: Math.round(r.x + r.w) - x0, h: Math.round(r.y + r.h) - y0 };
    },
    up(E) {
      const d = this.d;
      if (!d) return;
      const doc = E.doc;
      if (d.moveSel) {
        this.d = null;
        if (Math.max(Math.abs(d.b.x - d.a.x), Math.abs(d.b.y - d.a.y)) * E.view.zoom < 3) {
          // a click inside the selection drops it, like anywhere else
          deselectByClick(E, 'new');
          return;
        }
        const dx = Math.round(d.b.x - d.a.x);
        const dy = Math.round(d.b.y - d.a.y);
        if (!dx && !dy) return;
        const before = doc.capture();
        const c = makeCanvas(doc.width, doc.height);
        c.getContext('2d').drawImage(doc.selection.canvas, dx, dy);
        doc.selection = SEL.combine(doc, c, 'new');
        E.commit('선택 영역 이동', before);
        return;
      }
      const o = E.opts(id);
      const r = this.rect(E);
      this.d = null;
      // a click (a drag of a few screen pixels) is not a shape
      const dragged = Math.max(Math.abs(d.b.x - d.a.x), Math.abs(d.b.y - d.a.y)) * E.view.zoom >= 3;
      if (o.style !== 'size' && (!dragged || r.w < 1 || r.h < 1)) {
        deselectByClick(E, d.mode);
        return;
      }
      const before = doc.capture();
      const feather = o.feather || 0;
      const aa = !ellipse || o.antialias !== false;
      let m = SEL.shapeMask(doc, (ellipse ? SEL.ellipsePath : SEL.rectPath)(r.x, r.y, r.w, r.h), feather);
      if (!aa && !feather) m = SEL.hardEdge(m);
      doc.selection = SEL.combine(doc, m, d.mode);
      E.commit(this.name, before);
    },
    cancel(E) {
      this.d = null;
      E.overlay();
    },
    deactivate(E) {
      this.d = null;
      E.overlay?.();
    },
    overlay(E, g) {
      const d = this.d;
      if (!d) return;
      if (d.moveSel) {
        E.drawSelOffset(g, Math.round(d.b.x - d.a.x), Math.round(d.b.y - d.a.y));
        return;
      }
      const r = this.rect(E);
      const [x, y] = E.toScreen(r.x, r.y);
      const w = r.w * E.view.zoom;
      const hh = r.h * E.view.zoom;
      g.save();
      g.setLineDash([4, 4]);
      g.strokeStyle = '#fff';
      g.beginPath();
      if (ellipse) g.ellipse(x + w / 2, y + hh / 2, Math.max(0, w / 2), Math.max(0, hh / 2), 0, 0, Math.PI * 2);
      else g.rect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(hh));
      g.stroke();
      g.lineDashOffset = 4;
      g.strokeStyle = '#000';
      g.stroke();
      // the size while drawing, like Photoshop's info tip
      const label = `W: ${r.w} px  H: ${r.h} px`;
      g.font = '11px system-ui, sans-serif';
      const tw = g.measureText(label).width + 10;
      const [px, py] = E.toScreen(d.b.x, d.b.y);
      g.setLineDash([]);
      g.fillStyle = 'rgba(30,30,30,0.85)';
      g.fillRect(px + 14, py + 14, tw, 18);
      g.fillStyle = '#fff';
      g.fillText(label, px + 19, py + 27);
      g.restore();
    },
  };
}

const wand = {
  options: [
    SEL_MODE_OPT,
    ['sample', '샘플 크기', 'select', null, null, 1, [[1, '지정 픽셀'], [3, '3 x 3 평균'], [5, '5 x 5 평균'], [11, '11 x 11 평균'], [31, '31 x 31 평균'], [51, '51 x 51 평균'], [101, '101 x 101 평균']]],
    ['tolerance', '허용치', 'range', 0, 255, 32],
    ['antialias', '앤티 앨리어스', 'bool', null, null, true],
    ['contiguous', '인접', 'bool', null, null, true],
    ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false],
  ],
  down(E, p, e) {
    const o = E.opts('wand');
    const src = o.sampleAll ? E.composite() : E.layerAsDocCanvas(E.doc.active);
    const m = SEL.magicWand(E.doc, src, p.x, p.y, { tolerance: o.tolerance, contiguous: o.contiguous, sample: +o.sample || 1, antialias: o.antialias !== false });
    if (!m) return;
    const before = E.doc.capture();
    E.doc.selection = SEL.combine(E.doc, m, selMode(E, e, 'wand'));
    E.commit('자동 선택', before);
  },
};

const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Arrow keys with a selection tool: move the selection outline 1 pixel (Shift: 10). */
function nudgeSelection(E, e) {
  const v = NUDGE[e.key];
  const doc = E.doc;
  if (!v || e.altKey || e.ctrlKey || e.metaKey || !doc?.selection || E.transform) return false;
  const k = e.shiftKey ? 10 : 1;
  const before = doc.capture();
  const c = makeCanvas(doc.width, doc.height);
  c.getContext('2d').drawImage(doc.selection.canvas, v[0] * k, v[1] * k);
  doc.selection = SEL.combine(doc, c, 'new');
  E.commit('선택 영역 이동', before);
  return true;
}

export function installMarquee(P) {
  for (const [id, ellipse] of [['rect', false], ['ellipse', true]]) {
    const t = TOOL_BY_ID[id];
    if (t) Object.assign(t, marquee(id, ellipse));
  }
  if (TOOL_BY_ID.wand) Object.assign(TOOL_BY_ID.wand, wand);
  for (const id of SELECTION_TOOLS) {
    const t = TOOL_BY_ID[id];
    if (!t) continue;
    const orig = t.onKey;
    t.onKey = function (E, e) {
      if (orig && orig.call(this, E, e) === true) return true;
      if (this.d) return false; // an outline is being drawn
      return nudgeSelection(E, e);
    };
  }
  const keyChange = (e) => {
    const down = e.type === 'keydown';
    if (e.code === 'Space') held.space = down;
    else if (e.key === 'Shift') held.shift = down;
    else if (e.key === 'Alt') held.alt = down;
    else return;
    // a marquee being drawn follows Shift and Alt at once, without waiting for the pointer to move
    const t = TOOL_BY_ID[P.tool];
    if (t?.marquee && t.d && !t.d.moveSel && document.body.classList.contains('photo-mode')) {
      t.track(P, t.d.last, held.shift, held.alt);
      if (e.key === 'Alt') e.preventDefault();
    }
  };
  window.addEventListener('keydown', keyChange, true);
  window.addEventListener('keyup', keyChange, true);
  window.addEventListener('blur', () => {
    held.space = false;
    held.shift = false;
    held.alt = false;
  });
}
