// Photoshop's selection tools and commands: single row / column marquee, magnetic lasso, quick
// selection, object selection, select subject / sky, colour range, grow / similar / border / smooth,
// quick mask, save / load selection, alpha channels and the channel view, plus the mask target
// shared by the painting tools (layer mask, quick mask or an alpha channel).

import { h, clamp } from '../util.js';
import { toast, promptDialog, openModal, loadPref, savePref } from '../ui/common.js';
import { makeCanvas, cloneCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, SEL_MODE_OPT, selMode, tinyOutline, deselectByClick } from './tools.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- tools

function singleMarquee(id, name, icon, row) {
  return {
    id, name, key: null, icon, group: 'select', cursor: 'crosshair',
    options: [SEL_MODE_OPT],
    down(E, p, e) {
      this.d = { p, mode: selMode(E, e, id) };
      E.overlay();
    },
    move(E, p) {
      if (!this.d) return;
      this.d.p = p;
      E.overlay();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      const doc = E.doc;
      const before = doc.capture();
      const shape = row
        ? SEL.rectPath(0, clamp(Math.floor(d.p.y), 0, doc.height - 1), doc.width, 1)
        : SEL.rectPath(clamp(Math.floor(d.p.x), 0, doc.width - 1), 0, 1, doc.height);
      doc.selection = SEL.combine(doc, SEL.shapeMask(doc, shape, 0, false), d.mode);
      E.commit(name, before);
    },
    overlay(E, g) {
      if (!this.d) return;
      const doc = E.doc;
      const [x0, y0] = E.toScreen(0, 0);
      const [x1, y1] = E.toScreen(doc.width, doc.height);
      const [px, py] = E.toScreen(Math.floor(this.d.p.x) + 0.5, Math.floor(this.d.p.y) + 0.5);
      g.save();
      g.strokeStyle = '#4aa3ff';
      g.beginPath();
      if (row) {
        g.moveTo(x0, py);
        g.lineTo(x1, py);
      } else {
        g.moveTo(px, y0);
        g.lineTo(px, y1);
      }
      g.stroke();
      g.restore();
    },
  };
}

/** Pixels the selection tools look at: the visible picture or the active layer. */
function sampleCanvas(E, all) {
  return all ? E.composite() : E.layerAsDocCanvas(E.doc.active);
}

const magLasso = {
  id: 'magLasso', name: '자석 올가미', key: 'L', icon: 'magLasso', group: 'select', cursor: 'crosshair',
  options: [SEL_MODE_OPT, ['feather', '페더 (px)', 'range', 0, 200, 0], ['width', '폭 (px)', 'range', 1, 40, 10], ['contrast', '대비', 'range', 1, 100, 10, '%'], ['frequency', '빈도', 'range', 0, 100, 57]],
  wire(E) {
    const o = E.opts('magLasso');
    const key = `${E.doc.id}:${E.doc.rev}:${o.contrast}`;
    if (this.lw?.key !== key) {
      const c = E.composite();
      this.lw = new SX.LiveWire(SX.pixelsOf(c), c.width, c.height, { contrast: o.contrast });
      this.lw.key = key;
    }
    return this.lw;
  },
  anchorAt(E, pt) {
    this.d.anchors.push(this.d.pts.length - 1);
    this.lwAnchor = pt;
    this.lw.setAnchor(pt[0], pt[1], 200);
  },
  /** Fix the live segment into the outline and start a new one at its end. */
  commitLive(E) {
    const d = this.d;
    if (!d.live || d.live.length < 2) return;
    for (const q of d.live.slice(1)) d.pts.push(q);
    d.live = null;
    this.anchorAt(E, d.pts[d.pts.length - 1]);
  },
  down(E, p, e) {
    const o = E.opts('magLasso');
    if (!this.d) {
      const lw = this.wire(E);
      this.lwUsed = lw;
      const s = lw.snap(p.x, p.y, o.width);
      this.d = { pts: [s], anchors: [], live: null, mode: selMode(E, e, 'magLasso') };
      this.anchorAt(E, s);
      E.overlay();
      return;
    }
    const first = this.d.pts[0];
    if (this.d.pts.length > 2 && Math.hypot(p.x - first[0], p.y - first[1]) * E.view.zoom < 10) {
      this.finish(E);
      return;
    }
    // a click adds an anchor where the live segment ends
    this.track(E, p);
    this.commitLive(E);
    E.overlay();
  },
  track(E, p) {
    const d = this.d;
    const o = E.opts('magLasso');
    const lw = this.wire(E);
    if (lw !== this.lwUsed) {
      // the picture changed under us: restart the wire at the last anchor
      this.lwUsed = lw;
      lw.setAnchor(this.lwAnchor[0], this.lwAnchor[1], 200);
    }
    const s = lw.snap(p.x, p.y, o.width);
    let path = lw.path(s[0], s[1]);
    if (!path) {
      // too far from the anchor: fix what we have and continue from its end
      if (d.live?.length > 1) {
        this.commitLive(E);
        path = lw.path(s[0], s[1]);
      }
      if (!path) path = [d.pts[d.pts.length - 1], s];
    }
    d.live = path;
    // automatic anchors: every so many pixels along the edge (Photoshop's "frequency")
    const spacing = 12 + (100 - (o.frequency ?? 57)) * 1.4;
    if (SX.polyLength(path) > spacing) this.commitLive(E);
  },
  move(E, p) {
    if (!this.d) return;
    this.track(E, p);
    E.overlay();
  },
  hover(E, p) {
    this.move(E, p);
  },
  up() {},
  dblclick(E) {
    if (this.d) this.finish(E);
  },
  onKey(E, e) {
    if (!this.d) return false;
    if (e.key === 'Enter') this.finish(E);
    else if (e.key === 'Escape') this.cancel(E);
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      const d = this.d;
      d.anchors.pop();
      if (!d.anchors.length) return this.cancel(E), true;
      const last = d.anchors[d.anchors.length - 1];
      d.pts.length = last + 1;
      d.live = null;
      this.lwAnchor = d.pts[last];
      this.lw.setAnchor(d.pts[last][0], d.pts[last][1], 200);
      E.overlay();
    } else return false;
    return true;
  },
  cancel(E) {
    this.d = null;
    E.overlay();
  },
  deactivate(E) {
    this.d = null;
    this.lw = null;
    E.overlay?.();
  },
  finish(E) {
    const d = this.d;
    if (!d) return;
    // close along the edges when the start is in reach, else straight
    const first = d.pts[0];
    const back = this.lw?.path(first[0], first[1]);
    if (d.live) for (const q of d.live.slice(1)) d.pts.push(q);
    if (back && Math.hypot(first[0] - d.pts[d.pts.length - 1][0], first[1] - d.pts[d.pts.length - 1][1]) > 2) {
      const lw = this.lw;
      lw.setAnchor(d.pts[d.pts.length - 1][0], d.pts[d.pts.length - 1][1], 200);
      const p2 = lw.path(first[0], first[1]);
      if (p2) for (const q of p2.slice(1)) d.pts.push(q);
    }
    this.d = null;
    if (d.pts.length < 3 || tinyOutline(d.pts, E.view.zoom)) {
      deselectByClick(E, d.mode);
      return;
    }
    const before = E.doc.capture();
    E.doc.selection = SEL.combine(E.doc, SEL.shapeMask(E.doc, SEL.polyPath(d.pts.map(([x, y]) => [x + 0.5, y + 0.5])), E.opts('magLasso').feather || 0), d.mode);
    E.commit('자석 올가미', before);
  },
  overlay(E, g) {
    const d = this.d;
    if (!d) return;
    const line = (pts, color, dash) => {
      g.strokeStyle = color;
      g.setLineDash(dash);
      g.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = E.toScreen(x + 0.5, y + 0.5);
        if (i) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
      });
      g.stroke();
    };
    g.save();
    const all = d.live ? [...d.pts, ...d.live.slice(1)] : d.pts;
    line(all, '#000', []);
    line(all, '#fff', [4, 4]);
    g.setLineDash([]);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    for (const i of d.anchors) {
      const [sx, sy] = E.toScreen(d.pts[i][0] + 0.5, d.pts[i][1] + 0.5);
      g.fillRect(sx - 2.5, sy - 2.5, 5, 5);
      g.strokeRect(sx - 2.5, sy - 2.5, 5, 5);
    }
    g.restore();
  },
};

const quickSel = {
  id: 'quickSel', name: '빠른 선택', key: 'W', icon: 'quickSel', group: 'select', cursor: 'brush',
  options: [['mode', '선택 방식', 'select', null, null, 'new', [['new', '새 선택'], ['add', '더하기 (Shift)'], ['sub', '빼기 (Alt)']]], ['size', '크기', 'range', 1, 400, 30], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false], ['enhance', '가장자리 향상', 'bool', null, null, false]],
  source(E) {
    const o = E.opts('quickSel');
    const key = `${E.doc.id}:${E.doc.rev}:${o.sampleAll}:${E.doc.activeId}`;
    if (this.src?.key !== key) {
      const c = sampleCanvas(E, o.sampleAll);
      this.src = { key, px: SX.pixelsOf(c), w: c.width, h: c.height };
    }
    return this.src;
  },
  down(E, p, e) {
    const doc = E.doc;
    const o = E.opts('quickSel');
    let mode = e.altKey ? 'sub' : e.shiftKey ? 'add' : o.mode;
    if (mode === 'sub' && !doc.selection) return;
    if (mode === 'add' && !doc.selection) mode = 'new';
    const src = this.source(E);
    const base = doc.selection?.canvas || null;
    const live = makeCanvas(doc.width, doc.height);
    if (mode !== 'new' && base) live.getContext('2d').drawImage(base, 0, 0);
    this.d = { before: doc.capture(), base: doc.selection, mode, qs: new SX.QuickSelector(src.px, src.w, src.h), live, last: p };
    doc.selection = { canvas: live };
    this.dab(E, p);
  },
  dab(E, p) {
    const d = this.d;
    const box = d.qs.dab(p.x, p.y, E.opts('quickSel').size / 2);
    if (!box) return;
    // paint the dab's area of the stroke onto the live selection
    const img = new ImageData(box.w, box.h);
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) if (d.qs.mask[(y + box.y) * d.qs.w + x + box.x]) img.data[(y * box.w + x) * 4 + 3] = 255;
    }
    const t = makeCanvas(box.w, box.h);
    t.getContext('2d').putImageData(img, 0, 0);
    const g = d.live.getContext('2d');
    g.globalCompositeOperation = d.mode === 'sub' ? 'destination-out' : 'source-over';
    g.drawImage(t, box.x, box.y);
    g.globalCompositeOperation = 'source-over';
    E.doc.selection._ants = null;
    E.redraw();
  },
  move(E, p) {
    const d = this.d;
    if (!d) return;
    const step = Math.max(2, E.opts('quickSel').size / 4);
    const len = dist(d.last, p);
    for (let t = step; t <= len; t += step) this.dab(E, { x: d.last.x + ((p.x - d.last.x) * t) / len, y: d.last.y + ((p.y - d.last.y) * t) / len });
    if (len >= step) d.last = p;
  },
  up(E) {
    const d = this.d;
    this.d = null;
    if (!d) return;
    const doc = E.doc;
    const o = E.opts('quickSel');
    doc.selection = d.base;
    const stroke = d.qs.canvas(o.enhance);
    doc.selection = SEL.combine(doc, stroke, d.mode === 'sub' ? 'sub' : d.mode === 'add' ? 'add' : 'new');
    E.commit('빠른 선택', d.before);
    // like Photoshop: after the first stroke the brush adds
    if (o.mode === 'new') E.setOpt('quickSel', 'mode', 'add');
  },
  cancel(E) {
    if (!this.d) return;
    E.doc.selection = this.d.base;
    this.d = null;
    E.redraw();
  },
};

const objSel = {
  id: 'objSel', name: '개체 선택', key: 'W', icon: 'objSel', group: 'select', cursor: 'crosshair',
  options: [SEL_MODE_OPT, ['shape', '모드', 'select', null, null, 'rect', [['rect', '사각형'], ['lasso', '올가미']]], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, true]],
  down(E, p, e) {
    this.d = { a: p, b: p, pts: [p], mode: selMode(E, e, 'objSel') };
  },
  move(E, p) {
    if (!this.d) return;
    this.d.b = p;
    this.d.pts.push(p);
    E.overlay();
  },
  up(E) {
    const d = this.d;
    this.d = null;
    E.overlay();
    if (!d) return;
    const o = E.opts('objSel');
    const lasso = o.shape === 'lasso';
    let r;
    if (lasso) {
      const xs = d.pts.map((q) => q.x);
      const ys = d.pts.map((q) => q.y);
      r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    } else r = { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.b.x - d.a.x), h: Math.abs(d.b.y - d.a.y) };
    if (r.w < 4 || r.h < 4) {
      E.toast('개체 둘레로 사각형(또는 올가미)을 끌어 그리세요');
      return;
    }
    E.toast('개체를 찾는 중…');
    setTimeout(() => {
      const m = SX.objectSelect(sampleCanvas(E, o.sampleAll), r, { poly: lasso ? d.pts.map((q) => [q.x, q.y]) : null });
      if (!m) {
        E.toast('개체를 찾지 못했습니다 (배경과 색이 비슷하면 어렵습니다)');
        return;
      }
      const before = E.doc.capture();
      E.doc.selection = SEL.combine(E.doc, m, d.mode);
      E.commit('개체 선택', before);
    }, 30);
  },
  overlay(E, g) {
    const d = this.d;
    if (!d) return;
    g.save();
    g.strokeStyle = '#4aa3ff';
    g.setLineDash([5, 4]);
    g.beginPath();
    if (E.opts('objSel').shape === 'lasso') {
      d.pts.forEach((q, i) => {
        const [x, y] = E.toScreen(q.x, q.y);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
    } else {
      const [x0, y0] = E.toScreen(Math.min(d.a.x, d.b.x), Math.min(d.a.y, d.b.y));
      const [x1, y1] = E.toScreen(Math.max(d.a.x, d.b.x), Math.max(d.a.y, d.b.y));
      g.rect(x0, y0, x1 - x0, y1 - y0);
    }
    g.stroke();
    g.restore();
  },
};

// ---------------------------------------------------------------- install

export function installSelectionTools(P) {
  const C = P.cmd;
  for (const t of [singleMarquee('row', '단일 행 선택 윤곽', 'selRow', true), singleMarquee('col', '단일 열 선택 윤곽', 'selCol', false), magLasso, quickSel, objSel]) {
    TOOLS.push(t);
    TOOL_BY_ID[t.id] = t;
  }
  const grp = (id) => TOOL_GROUPS.find((g) => g.includes(id));
  grp('rect').push('row', 'col');
  grp('lasso').push('magLasso');
  if (!grp('lasso').includes('polyLasso')) grp('lasso').splice(1, 0, 'polyLasso');
  const wand = grp('wand');
  wand.splice(0, wand.length, 'objSel', 'quickSel', 'wand');

  // option bar extras for the selection tools
  const samBtn = () => h('button.small', { onclick: () => C.selectAndMask(), title: '선택 및 마스크 (Alt+Ctrl+R)' }, '선택 및 마스크…');
  const subjBtn = () => h('button.small', { onclick: () => C.selectSubject() }, '피사체 선택');
  // also stops an outline being drawn (phones have no Ctrl+D or Esc)
  const deselectBtn = (t) => h('button.small', {
    title: '선택 해제 (Ctrl+D)',
    onclick: () => {
      if (t.cancel) t.cancel(P);
      else t.d = null;
      C.deselect();
      P.overlay();
    },
  }, '선택 해제');
  for (const id of ['rect', 'ellipse', 'row', 'col', 'lasso', 'polyLasso', 'magLasso', 'quickSel', 'objSel', 'wand']) {
    const t = TOOL_BY_ID[id];
    t.optionButtons = () => [
      deselectBtn(t),
      id === 'polyLasso' ? h('button.small', { onclick: () => t.finish?.(P) }, '다각형 닫기') : null,
      id === 'magLasso' ? h('button.small', { onclick: () => t.finish?.(P) }, '닫기') : null,
      ['quickSel', 'objSel', 'wand'].includes(id) ? subjBtn() : null,
      samBtn(),
    ];
  }

  // ---------------------------------------------------------------- quick mask & mask targets

  P.qmOpts = loadPref('photo.qm', { color: '#ff0000', opacity: 50, selected: false });
  /** Channel view state of the current document (not part of the history). */
  P.chState = () => {
    const doc = P.doc;
    if (!doc) return { comps: new Set(['r', 'g', 'b']), alpha: new Set(), active: null };
    if (!doc._ch) doc._ch = { comps: new Set(['r', 'g', 'b']), alpha: new Set(), active: null };
    if (doc._ch.active && !doc.channels.some((c) => c.id === doc._ch.active)) doc._ch.active = null;
    for (const id of doc._ch.alpha) if (!doc.channels.some((c) => c.id === id)) doc._ch.alpha.delete(id);
    if (!doc._ch.comps.size && !doc._ch.alpha.size) doc._ch.comps = new Set(['r', 'g', 'b']);
    return doc._ch;
  };
  /**
   * Where painting tools paint when not on layer pixels: the quick mask, a selected alpha channel or
   * the active layer's mask. {kind, canvas, x, y, invert, edit() → 2d context of a fresh copy}.
   */
  P.maskTarget = () => {
    const doc = P.doc;
    if (!doc) return null;
    if (doc.quickMask) {
      return {
        kind: 'quick', canvas: doc.quickMask.canvas, x: 0, y: 0, invert: !!P.qmOpts.selected,
        edit() {
          doc.quickMask = { canvas: cloneCanvas(doc.quickMask.canvas) };
          doc.rev++;
          return doc.quickMask.canvas.getContext('2d');
        },
      };
    }
    const st = P.chState();
    const ch = st.active && doc.channels.find((c) => c.id === st.active);
    if (ch) {
      return {
        kind: 'channel', canvas: ch.canvas, x: 0, y: 0, invert: false,
        edit() {
          const nc = { ...ch, canvas: cloneCanvas(ch.canvas) };
          doc.channels = doc.channels.map((c) => (c.id === ch.id ? nc : c));
          doc.rev++;
          return nc.canvas.getContext('2d');
        },
      };
    }
    const l = doc.active;
    if (P.editMask && l?.mask) return { kind: 'layer', canvas: l.mask.canvas, x: l.mask.x, y: l.mask.y, invert: false, edit: () => doc.editMask(l) };
    return null;
  };

  C.quickMask = (on = !P.doc?.quickMask) => {
    const doc = P.doc;
    if (!doc) return;
    if (P.transform) P.applyTransform();
    if (on && !doc.quickMask) {
      P.run('빠른 마스크', () => {
        const c = makeCanvas(doc.width, doc.height);
        const g = c.getContext('2d');
        // nothing selected: everything is selected (no colour), paint to mask areas out
        if (doc.selection) g.drawImage(doc.selection.canvas, 0, 0);
        else g.fillRect(0, 0, c.width, c.height);
        doc.quickMask = { canvas: c };
        doc.selection = null;
        doc.rev++;
      });
      toast('빠른 마스크: 검정으로 칠하면 선택에서 빠지고 흰색은 더해집니다. Q를 다시 누르면 선택 영역이 됩니다.');
    } else if (!on && doc.quickMask) {
      P.run('빠른 마스크 끝', () => {
        const c = cloneCanvas(doc.quickMask.canvas);
        doc.quickMask = null;
        doc.selection = SEL.combine(doc, c, 'new');
        doc.rev++;
      });
    }
    P.emit('quickmask');
    P.emit('channels');
  };
  C.quickMaskOptions = () => {
    const o = { ...P.qmOpts };
    const col = h('input', { type: 'color', value: o.color });
    const op = h('input', { type: 'number', min: 0, max: 100, value: o.opacity, style: { width: '70px' } });
    const which = h('select', h('option', { value: 'masked' }, '마스크 영역'), h('option', { value: 'selected' }, '선택 영역'));
    which.value = o.selected ? 'selected' : 'masked';
    openModal({
      title: '빠른 마스크 옵션',
      body: h('div', h('div.form-row', h('label', '색상 표시 대상'), which), h('div.form-row', h('label', '색상'), h('div.inline', col, op, h('small', '% 불투명도')))),
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          P.qmOpts = { color: col.value, opacity: clamp(+op.value || 0, 0, 100), selected: which.value === 'selected' };
          savePref('photo.qm', P.qmOpts);
          P.redraw();
        },
      }],
    });
  };

  // ---------------------------------------------------------------- what the canvas shows

  let disp = { key: null, canvas: null };
  /** The composite as the Channels panel wants it shown (single channels, alpha overlays, quick mask). */
  P.displayCanvas = (comp) => {
    const doc = P.doc;
    const st = P.chState();
    const all = st.comps.size === 3;
    const alphas = doc.channels.filter((c) => st.alpha.has(c.id));
    if (all && !alphas.length && !doc.quickMask) return comp;
    const qm = P.qmOpts;
    const key = `${doc.id}|${doc.rev}|${[...st.comps].sort().join('')}|${alphas.map((c) => c.id).join(',')}|${!!doc.quickMask}|${qm.color}${qm.opacity}${qm.selected}|${comp.width}x${comp.height}`;
    if (disp.key === key) return disp.canvas;
    const W = comp.width;
    const H = comp.height;
    const out = makeCanvas(W, H);
    const g = out.getContext('2d');
    if (all) g.drawImage(comp, 0, 0);
    else if (st.comps.size) {
      const img = comp.getContext('2d').getImageData(0, 0, W, H);
      const d = img.data;
      const on = ['r', 'g', 'b'].map((c) => st.comps.has(c));
      const one = st.comps.size === 1 ? on.indexOf(true) : -1;
      for (let i = 0; i < d.length; i += 4) {
        if (one >= 0) d[i] = d[i + 1] = d[i + 2] = d[i + one];
        else for (let c = 0; c < 3; c++) if (!on[c]) d[i + c] = 0;
      }
      g.putImageData(img, 0, 0);
    } else {
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
    }
    const tint = (mask, color, opacity, selectedAreas) => {
      const t = makeCanvas(W, H);
      const tg = t.getContext('2d');
      tg.fillStyle = color;
      tg.fillRect(0, 0, W, H);
      tg.globalCompositeOperation = selectedAreas ? 'destination-in' : 'destination-out';
      tg.drawImage(mask, 0, 0);
      g.globalAlpha = opacity;
      g.drawImage(t, 0, 0);
      g.globalAlpha = 1;
    };
    for (const ch of alphas) {
      if (st.comps.size) tint(ch.canvas, '#ff0000', 0.5, false);
      else {
        // an alpha channel on its own: white = selected
        const t = makeCanvas(W, H);
        const tg = t.getContext('2d');
        tg.drawImage(ch.canvas, 0, 0);
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = '#fff';
        tg.fillRect(0, 0, W, H);
        g.drawImage(t, 0, 0);
      }
    }
    if (doc.quickMask) tint(doc.quickMask.canvas, qm.color, qm.opacity / 100, qm.selected);
    disp = { key, canvas: out };
    return out;
  };

  // ---------------------------------------------------------------- selection commands

  const need = () => {
    if (!P.doc) return false;
    return true;
  };
  const needSel = () => {
    if (!P.doc?.selection) {
      toast('먼저 선택 영역을 만드세요');
      return false;
    }
    return true;
  };
  const docAlpha = () => SX.alphaOf(P.doc.selection.canvas);
  const setAlpha = (label, a) => {
    const doc = P.doc;
    P.run(label, () => { doc.selection = SEL.combine(doc, SX.alphaCanvas(a, doc.width, doc.height), 'new'); });
  };
  const busy = (fn) => {
    toast('처리 중…');
    setTimeout(fn, 30);
  };

  C.selectSubject = () => {
    if (!need()) return;
    busy(() => {
      const m = SX.selectSubject(P.composite());
      if (!m) return toast('피사체를 찾지 못했습니다 (배경이 단순할수록 잘 됩니다)');
      P.run('피사체 선택', () => { P.doc.selection = SEL.combine(P.doc, m, 'new'); });
      return undefined;
    });
  };
  C.selectSky = () => {
    if (!need()) return;
    busy(() => {
      const m = SX.selectSky(P.composite());
      if (!m) return toast('하늘을 찾지 못했습니다 (위쪽 가장자리에 닿은 밝은 하늘만 찾습니다)');
      P.run('하늘 선택', () => { P.doc.selection = SEL.combine(P.doc, m, 'new'); });
      return undefined;
    });
  };
  const wandTol = () => P.opts('wand').tolerance ?? 32;
  C.grow = () => {
    if (!needSel()) return;
    const c = P.composite();
    const a = SX.similarSelect(SX.pixelsOf(c), c.width, c.height, docAlpha(), wandTol(), true);
    if (a) setAlpha('선택 영역 확장', a);
  };
  C.similar = () => {
    if (!needSel()) return;
    const c = P.composite();
    const a = SX.similarSelect(SX.pixelsOf(c), c.width, c.height, docAlpha(), wandTol(), false);
    if (a) setAlpha('유사 영역 선택', a);
  };
  const modify = async (label, def, max, fn) => {
    if (!needSel()) return;
    const v = await promptDialog(label, `픽셀 (1~${max})`, String(def));
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) return;
    const doc = P.doc;
    setAlpha(label, fn(docAlpha(), doc.width, doc.height, Math.min(max, n)));
  };
  C.border = () => modify('테두리', 10, 200, (a, w, hh, n) => SX.borderAlpha(a, w, hh, n));
  C.smooth = () => modify('매끄럽게', 5, 500, (a, w, hh, n) => SX.smoothAlpha(a, w, hh, n));
  C.expand = () => modify('확대', 5, 500, (a, w, hh, n) => SX.expandAlpha(a, w, hh, n));
  C.contract = () => modify('축소', 5, 500, (a, w, hh, n) => SX.expandAlpha(a, w, hh, -n));

  // ---------------------------------------------------------------- channels

  const chName = () => {
    const used = new Set(P.doc.channels.map((c) => c.name));
    let i = 1;
    while (used.has(`알파 ${i}`)) i++;
    return `알파 ${i}`;
  };
  const newId = () => `ch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  C.newChannel = (canvas = null, name = null) => {
    const doc = P.doc;
    if (!doc) return null;
    const id = newId();
    P.run('새 채널', () => {
      doc.channels = [...doc.channels, { id, name: name || chName(), canvas: canvas || makeCanvas(doc.width, doc.height) }];
    });
    P.emit('channels');
    return id;
  };
  C.selectionToChannel = () => {
    if (!needSel()) return null;
    const id = newId();
    const doc = P.doc;
    P.run('선택 영역 저장', () => {
      doc.channels = [...doc.channels, { id, name: chName(), canvas: cloneCanvas(doc.selection.canvas) }];
    });
    P.emit('channels');
    return id;
  };
  /** Load a channel (alpha id, 'r' | 'g' | 'b' | 'rgb', 'layer', 'mask') as the selection. */
  C.channelToSelection = (which, mode = 'new', invert = false) => {
    const doc = P.doc;
    if (!doc) return;
    let c;
    const alpha = doc.channels.find((x) => x.id === which);
    if (alpha) c = cloneCanvas(alpha.canvas);
    else if (['r', 'g', 'b', 'rgb'].includes(which)) c = SX.channelAlpha(P.composite(), which);
    else if (which === 'layer') c = SEL.fromLayer(doc, doc.active)?.canvas || makeCanvas(doc.width, doc.height);
    else if (which === 'mask' && doc.active?.mask) {
      c = makeCanvas(doc.width, doc.height);
      c.getContext('2d').drawImage(doc.active.mask.canvas, doc.active.mask.x, doc.active.mask.y);
    } else if (which === 'quick' && doc.quickMask) c = cloneCanvas(doc.quickMask.canvas);
    if (!c) return;
    if (invert) {
      const t = makeCanvas(doc.width, doc.height);
      const tg = t.getContext('2d');
      tg.fillRect(0, 0, t.width, t.height);
      tg.globalCompositeOperation = 'destination-out';
      tg.drawImage(c, 0, 0);
      c = t;
    }
    P.run('선택 영역 불러오기', () => { doc.selection = SEL.combine(doc, c, mode); });
  };
  C.deleteChannel = (id = P.chState().active) => {
    const doc = P.doc;
    if (!doc || !id) return;
    P.run('채널 삭제', () => { doc.channels = doc.channels.filter((c) => c.id !== id); });
    P.emit('channels');
  };
  C.duplicateChannel = (id = P.chState().active) => {
    const doc = P.doc;
    const ch = doc?.channels.find((c) => c.id === id);
    if (!ch) return;
    P.run('채널 복제', () => { doc.channels = [...doc.channels, { id: newId(), name: `${ch.name} 복사`, canvas: cloneCanvas(ch.canvas) }]; });
    P.emit('channels');
  };
  C.renameChannel = async (id = P.chState().active) => {
    const doc = P.doc;
    const ch = doc?.channels.find((c) => c.id === id);
    if (!ch) return;
    const n = await promptDialog('채널 이름', '이름', ch.name);
    if (!n) return;
    P.run('채널 이름 바꾸기', () => { doc.channels = doc.channels.map((c) => (c.id === id ? { ...c, name: n } : c)); });
    P.emit('channels');
  };
  C.invertChannel = (id = P.chState().active) => {
    const doc = P.doc;
    const ch = doc?.channels.find((c) => c.id === id);
    if (!ch) return;
    P.run('채널 반전', () => {
      const t = makeCanvas(doc.width, doc.height);
      const tg = t.getContext('2d');
      tg.fillRect(0, 0, t.width, t.height);
      tg.globalCompositeOperation = 'destination-out';
      tg.drawImage(ch.canvas, 0, 0);
      doc.channels = doc.channels.map((c) => (c.id === id ? { ...c, canvas: t } : c));
    });
    P.emit('channels');
  };
  /** Show one or more colour channels, or select an alpha channel for painting. */
  C.viewChannel = (which, { toggle = false } = {}) => {
    const st = P.chState();
    if (which === 'rgb') {
      st.comps = new Set(['r', 'g', 'b']);
      st.active = null;
      st.alpha.clear();
    } else if (['r', 'g', 'b'].includes(which)) {
      if (toggle) {
        if (st.comps.has(which) && st.comps.size > 1) st.comps.delete(which);
        else st.comps.add(which);
      } else st.comps = new Set([which]);
      st.active = null;
    } else {
      st.active = which;
      st.alpha.add(which);
      if (!toggle) st.comps = new Set();
    }
    P.emit('channels');
    P.redraw();
  };
  C.toggleChannelEye = (which) => {
    const st = P.chState();
    if (which === 'rgb') st.comps = st.comps.size === 3 && st.alpha.size ? new Set() : new Set(['r', 'g', 'b']);
    else if (['r', 'g', 'b'].includes(which)) {
      if (st.comps.has(which)) st.comps.delete(which);
      else st.comps.add(which);
    } else if (st.alpha.has(which)) st.alpha.delete(which);
    else st.alpha.add(which);
    P.chState();
    P.emit('channels');
    P.redraw();
  };

  // ---------------------------------------------------------------- dialogs

  C.saveSelection = () => {
    if (!needSel()) return;
    const doc = P.doc;
    const target = h('select', h('option', { value: '' }, '새로 만들기'), ...doc.channels.map((c) => h('option', { value: c.id }, c.name)));
    const name = h('input', { type: 'text', value: chName() });
    const op = h('select', ...[['replace', '채널 대체'], ['add', '채널에 추가'], ['sub', '채널에서 빼기'], ['inter', '채널과 교차']].map(([v, t]) => h('option', { value: v }, t)));
    const sync = () => {
      name.disabled = !!target.value;
      op.disabled = !target.value;
    };
    target.addEventListener('change', sync);
    sync();
    openModal({
      title: '선택 영역 저장',
      body: h('div', h('div.form-row', h('label', '채널'), target), h('div.form-row', h('label', '이름'), name), h('div.form-row', h('label', '작업'), op)),
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          if (!target.value) {
            const id = newId();
            P.run('선택 영역 저장', () => { doc.channels = [...doc.channels, { id, name: name.value || chName(), canvas: cloneCanvas(doc.selection.canvas) }]; });
          } else {
            const ch = doc.channels.find((c) => c.id === target.value);
            P.run('선택 영역 저장', () => {
              const t = makeCanvas(doc.width, doc.height);
              const tg = t.getContext('2d');
              if (op.value !== 'replace') tg.drawImage(ch.canvas, 0, 0);
              tg.globalCompositeOperation = op.value === 'add' ? 'source-over' : op.value === 'sub' ? 'destination-out' : op.value === 'inter' ? 'destination-in' : 'source-over';
              tg.drawImage(doc.selection.canvas, 0, 0);
              doc.channels = doc.channels.map((c) => (c.id === ch.id ? { ...c, canvas: t } : c));
            });
          }
          P.emit('channels');
        },
      }],
    });
  };
  C.loadSelection = () => {
    const doc = P.doc;
    if (!doc) return;
    const l = doc.active;
    const src = h('select',
      ...doc.channels.map((c) => h('option', { value: c.id }, c.name)),
      l ? h('option', { value: 'layer' }, `${l.name} 투명도`) : null,
      l?.mask ? h('option', { value: 'mask' }, `${l.name} 마스크`) : null,
      h('option', { value: 'rgb' }, 'RGB 광도'), h('option', { value: 'r' }, '빨강'), h('option', { value: 'g' }, '녹색'), h('option', { value: 'b' }, '파랑'));
    const inv = h('input', { type: 'checkbox' });
    const op = h('select', ...[['new', '새 선택 영역'], ['add', '선택 영역에 추가'], ['sub', '선택 영역에서 빼기'], ['inter', '선택 영역과 교차']].map(([v, t]) => h('option', { value: v }, t)));
    if (!doc.selection) op.disabled = true;
    openModal({
      title: '선택 영역 불러오기',
      body: h('div', h('div.form-row', h('label', '채널'), src), h('div.form-row', h('label', '반전'), inv), h('div.form-row', h('label', '작업'), op)),
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => C.channelToSelection(src.value, op.value, inv.checked) }],
    });
  };

  C.colorRange = () => colorRangeDialog(P);
  C.selectAndMask = () => import('./selmask.js').then((m) => m.selectAndMaskDialog(P));
}

// ---------------------------------------------------------------- colour range dialog

function colorRangeDialog(P) {
  const doc = P.doc;
  if (!doc) return;
  const comp = P.composite();
  const W = comp.width;
  const H = comp.height;
  const s = Math.min(1, 300 / Math.max(W, H));
  const pw = Math.max(1, Math.round(W * s));
  const ph = Math.max(1, Math.round(H * s));
  const small = makeCanvas(pw, ph);
  const sg = small.getContext('2d');
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(comp, 0, 0, pw, ph);
  const spx = sg.getImageData(0, 0, pw, ph).data;
  const n = parseInt(P.fg.slice(1), 16);
  const st = loadPref('photo.colorRange', { select: 'sampled', fuzziness: 40, localized: false, range: 100, invert: false, toneFuzz: 20 });
  const o = { ...st, samples: [[(n >> 16) & 255, (n >> 8) & 255, n & 255]], subtract: [], points: [] };
  const view = h('canvas.ph-crprev', { width: pw, height: ph });
  const sel = h('select', ...SX.COLOR_RANGE_PRESETS.map(([v, t]) => h('option', { value: v }, t)));
  sel.value = o.select;
  const fuzz = h('input', { type: 'range', min: 0, max: 200, value: o.fuzziness });
  const fuzzN = h('span.ph-val', String(o.fuzziness));
  const local = h('input', { type: 'checkbox', checked: o.localized });
  const range = h('input', { type: 'range', min: 1, max: 100, value: o.range });
  const inv = h('input', { type: 'checkbox', checked: o.invert });
  let pick = 'set';
  const pickBtns = [['set', '스포이드'], ['add', '+ 추가 (Shift)'], ['sub', '− 빼기 (Alt)']].map(([v, t]) => {
    const b = h('button.small.ph-tog', { onclick: () => { pick = v; pickBtns.forEach((x) => x.classList.toggle('on', x === b)); } }, t);
    if (v === pick) b.classList.add('on');
    return b;
  });
  const showSel = h('input', { type: 'radio', name: 'crview', checked: true });
  const showImg = h('input', { type: 'radio', name: 'crview' });
  const draw = () => {
    o.select = sel.value;
    o.fuzziness = +fuzz.value;
    o.toneFuzz = Math.round(+fuzz.value / 2);
    fuzzN.textContent = o.select === 'sampled' ? String(o.fuzziness) : `${o.toneFuzz}%`;
    o.localized = local.checked;
    o.range = +range.value;
    o.invert = inv.checked;
    range.disabled = !o.localized;
    const g = view.getContext('2d');
    if (showImg.checked) {
      g.drawImage(small, 0, 0);
      return;
    }
    const a = SX.colorRange(spx, pw, ph, { ...o, points: o.points.map(([x, y]) => [x * s, y * s]), range: o.range });
    const img = g.createImageData(pw, ph);
    for (let i = 0; i < a.length; i++) {
      const v = Math.round(a[i] * 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  };
  view.addEventListener('pointerdown', (e) => {
    if (sel.value !== 'sampled') {
      sel.value = 'sampled';
    }
    const r = view.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * pw);
    const y = Math.floor(((e.clientY - r.top) / r.height) * ph);
    const i = (clamp(y, 0, ph - 1) * pw + clamp(x, 0, pw - 1)) * 4;
    const c = [spx[i], spx[i + 1], spx[i + 2]];
    const mode = e.shiftKey ? 'add' : e.altKey ? 'sub' : pick;
    const docPt = [x / s, y / s];
    if (mode === 'add') {
      o.samples.push(c);
      o.points.push(docPt);
    } else if (mode === 'sub') o.subtract.push(c);
    else {
      o.samples = [c];
      o.subtract = [];
      o.points = [docPt];
    }
    draw();
  });
  for (const el of [sel, fuzz, local, range, inv, showSel, showImg]) el.addEventListener('input', draw);
  const body = h('div.ph-crdlg',
    h('div.form-row', h('label', '선택'), sel),
    h('div.form-row', h('label', '지역화된 색상 클러스터'), local),
    h('div.form-row', h('label', '허용량'), h('div.inline', fuzz, fuzzN)),
    h('div.form-row', h('label', '범위'), range),
    h('div.ph-crwrap', view),
    h('div.inline', h('label', showSel, ' 선택 영역'), h('label', showImg, ' 이미지')),
    h('div.inline', ...pickBtns),
    h('div.form-row', h('label', '반전'), inv),
    h('div.note', '미리 보기를 눌러 색을 고르세요 (Shift+클릭 더하기, Alt+클릭 빼기). 처음 샘플은 전경색입니다. 포토샵의 색상 범위와 같은 방식(Lab 색 거리)을 흉내 낸 근사치입니다.'));
  openModal({
    title: '색상 범위',
    width: 'min(420px, 96vw)',
    body,
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        savePref('photo.colorRange', { select: o.select, fuzziness: o.fuzziness, localized: o.localized, range: o.range, invert: o.invert, toneFuzz: o.toneFuzz });
        const a = SX.colorRange(SX.pixelsOf(comp), W, H, o);
        P.run('색상 범위', () => { doc.selection = SEL.combine(doc, SX.alphaCanvas(a, W, H), 'new'); });
        if (!doc.selection) toast('선택된 픽셀이 없습니다');
      },
    }],
  });
  draw();
}

// ---------------------------------------------------------------- Channels panel

export function buildChannelsPanel(P) {
  const list = h('div.ph-layers', { role: 'listbox', 'aria-label': '채널' });
  const foot = h('div.ph-lfoot',
    h('button.small', { title: '채널을 선택 영역으로 불러오기 (Ctrl+클릭과 같음)', 'aria-label': '채널을 선택 영역으로', onclick: () => { const a = P.chState?.().active; if (a) P.cmd.channelToSelection(a); else P.cmd.loadSelection(); } }, '⬚'),
    h('button.small', { title: '선택 영역을 채널로 저장', 'aria-label': '선택 영역 저장', onclick: () => P.cmd.selectionToChannel() }, '◘'),
    h('button.small', { title: '새 채널', 'aria-label': '새 채널', onclick: () => P.cmd.newChannel() }, '+'),
    h('button.small', { title: '채널 삭제', 'aria-label': '채널 삭제', onclick: () => P.cmd.deleteChannel() }, '🗑'));
  const el = h('div.ph-panel.layers.channels', list, foot);
  const thumbs = new Map();
  const thumbOf = (key, make) => {
    const doc = P.doc;
    const k = `${doc.id}:${doc.rev}:${key}`;
    let t = thumbs.get(key);
    if (t?.k !== k) {
      const c = h('canvas.ph-thumb', { width: 40, height: 40 });
      const g = c.getContext('2d');
      const s = Math.min(40 / doc.width, 40 / doc.height);
      g.fillStyle = '#000';
      g.fillRect(0, 0, 40, 40);
      g.translate((40 - doc.width * s) / 2, (40 - doc.height * s) / 2);
      g.scale(s, s);
      make(g);
      t = { k, c };
      thumbs.set(key, t);
    }
    const out = h('canvas.ph-thumb', { width: 40, height: 40 });
    out.getContext('2d').drawImage(t.c, 0, 0);
    return out;
  };
  const colorThumb = (which) => (g) => {
    g.drawImage(P.composite(), 0, 0);
    if (which === 'rgb') return;
    // one channel, shown grey
    const c = { r: 0, g: 1, b: 2 }[which];
    const img = g.getImageData(0, 0, 40, 40);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i + c];
    g.putImageData(img, 0, 0);
  };
  const alphaThumb = (canvas) => (g) => {
    const doc = P.doc;
    const t = makeCanvas(doc.width, doc.height);
    const tg = t.getContext('2d');
    tg.drawImage(canvas, 0, 0);
    tg.globalCompositeOperation = 'source-in';
    tg.fillStyle = '#fff';
    tg.fillRect(0, 0, t.width, t.height);
    g.drawImage(t, 0, 0);
  };
  const loadMode = (e) => (e.shiftKey && e.altKey ? 'inter' : e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new');
  const render = () => {
    const doc = P.doc;
    list.replaceChildren();
    if (!doc || !P.chState) return;
    const st = P.chState();
    const row = (key, label, thumb, { visible, on, eye, click, menu, dbl, italic, shortcut }) => {
      const eyeBtn = h(`button.ph-eye${visible ? '.on' : ''}`, { 'aria-label': `${label} 보이기`, title: '보기 켜기/끄기', onclick: (e) => { e.stopPropagation(); eye(); } }, visible ? '👁' : '');
      const r = h(`div.ph-layer${on ? '.on.active' : ''}`, { role: 'option', 'aria-selected': String(!!on) }, eyeBtn, thumb, h('span.ph-lname', italic ? h('i', label) : label), shortcut ? h('small.ph-lkey', shortcut) : null);
      r.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          P.cmd.channelToSelection(key, loadMode(e));
          return;
        }
        click(e);
      });
      if (dbl) r.addEventListener('dblclick', dbl);
      if (menu) {
        r.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          import('../ui/common.js').then(({ showMenu }) => showMenu(menu(), e.clientX, e.clientY));
        });
      }
      list.append(r);
    };
    const allOn = st.comps.size === 3;
    row('rgb', 'RGB', thumbOf('rgb', colorThumb('rgb')), { visible: allOn, on: allOn && !st.active, eye: () => P.cmd.toggleChannelEye('rgb'), click: () => P.cmd.viewChannel('rgb') });
    for (const [k, name] of [['r', '빨강'], ['g', '녹색'], ['b', '파랑']]) {
      row(k, name, thumbOf(k, colorThumb(k)), {
        visible: st.comps.has(k), on: st.comps.has(k) && !st.active, eye: () => P.cmd.toggleChannelEye(k), click: (e) => P.cmd.viewChannel(k, { toggle: e.shiftKey }),
        menu: () => [{ label: '선택 영역으로 불러오기', action: () => P.cmd.channelToSelection(k) }],
      });
    }
    for (const ch of doc.channels) {
      row(ch.id, ch.name, thumbOf(`a:${ch.id}`, alphaThumb(ch.canvas)), {
        visible: st.alpha.has(ch.id), on: st.active === ch.id, eye: () => P.cmd.toggleChannelEye(ch.id), click: (e) => P.cmd.viewChannel(ch.id, { toggle: e.shiftKey }),
        dbl: () => P.cmd.renameChannel(ch.id),
        menu: () => [
          { label: '선택 영역으로 불러오기', action: () => P.cmd.channelToSelection(ch.id) },
          { label: '이름 바꾸기…', action: () => P.cmd.renameChannel(ch.id) },
          { label: '채널 복제', action: () => P.cmd.duplicateChannel(ch.id) },
          { label: '반전', action: () => P.cmd.invertChannel(ch.id) },
          '-',
          { label: '채널 삭제', action: () => P.cmd.deleteChannel(ch.id) },
        ],
      });
    }
    if (doc.quickMask) {
      row('quick', '빠른 마스크', thumbOf('quick', alphaThumb(doc.quickMask.canvas)), {
        visible: true, on: true, italic: true, eye: () => {}, click: () => {},
        menu: () => [{ label: '빠른 마스크 모드 끝 (Q)', action: () => P.cmd.quickMask(false) }, { label: '빠른 마스크 옵션…', action: () => P.cmd.quickMaskOptions() }],
      });
    }
    if (!doc.channels.length && !doc.quickMask) list.append(h('div.note', '선택 영역 ▸ 선택 영역 저장으로 알파 채널을 만들 수 있습니다. 채널을 Ctrl+클릭하면 선택 영역으로 불러옵니다.'));
  };
  for (const ev of ['channels', 'history', 'layers', 'quickmask']) P.on(ev, render);
  render();
  return el;
}
