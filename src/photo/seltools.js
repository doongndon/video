// Photoshop's selection tools and commands: single row / column marquee, magnetic lasso, quick
// selection, object selection (with Object Finder), select subject / sky, colour range (with its
// selection previews), luminosity selections and masks, grow / similar and the Modify dialogs,
// quick mask, save / load selection, alpha channels and the Channels panel, plus the mask target
// shared by the painting tools (layer mask, quick mask or an alpha channel). The marquees, the magic
// wand and arrow-key nudging live in selmarquee.js, adjustments on alpha channels in selchan.js.

import { h, clamp } from '../util.js';
import { toast, promptDialog, openModal, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { makeCanvas, cloneCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, SEL_MODE_OPT, selMode, tinyOutline, deselectByClick } from './tools.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';
import { installMarquee } from './selmarquee.js';
import { installChannelEdit } from './selchan.js';

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
  options: [['mode', '선택 방식', 'select', null, null, 'new', [['new', '새 선택'], ['add', '더하기 (Shift)'], ['sub', '빼기 (Alt)']]], ['size', '크기', 'range', 1, 400, 30], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false], ['enhance', '자동 향상', 'bool', null, null, false]],
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
  options: [['finder', '개체 찾기', 'bool', null, null, true], SEL_MODE_OPT, ['shape', '모드', 'select', null, null, 'rect', [['rect', '사각형'], ['lasso', '올가미']]], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, true], ['hard', '하드 가장자리', 'bool', null, null, false], ['objSub', '개체 빼기', 'bool', null, null, true]],
  down(E, p, e) {
    this.d = { a: p, b: p, pts: [p], mode: selMode(E, e, 'objSel') };
    this.found = null;
    clearTimeout(this.ht);
  },
  move(E, p) {
    if (!this.d) return;
    this.d.b = p;
    this.d.pts.push(p);
    E.overlay();
  },
  /** Object Finder: after the pointer rests a moment, the object under it is highlighted. */
  hover(E, p) {
    if (this.d || !E.opts('objSel').finder) return;
    clearTimeout(this.ht);
    const f = this.found;
    if (f && f.key === this.finderKey(E) && f.label[this.cell(f, p)]) return;
    if (f) {
      this.found = null;
      E.overlay();
    }
    this.ht = setTimeout(() => {
      if (this.d || E.tool !== 'objSel') return;
      this.find(E, p);
      E.overlay();
    }, 250);
  },
  finderKey(E) {
    return `${E.doc.id}:${E.doc.rev}:${!!E.opts('objSel').sampleAll}`;
  },
  cell(f, p) {
    const x = Math.max(0, Math.min(f.sw - 1, Math.floor(p.x * f.s)));
    const y = Math.max(0, Math.min(f.sh - 1, Math.floor(p.y * f.s)));
    return y * f.sw + x;
  },
  /** The object under p (cached per picture; null on open background). */
  find(E, p) {
    const doc = E.doc;
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return null;
    const key = this.finderKey(E);
    if (this.cache?.key !== key) this.cache = { key };
    if (!this.cache.src) this.cache.src = sampleCanvas(E, E.opts('objSel').sampleAll);
    const f = SX.findObjectAt(this.cache.src, p.x, p.y, this.cache);
    this.found = f ? { ...f, key, tint: null } : null;
    return this.found;
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
    if (Math.max(r.w, r.h) * E.view.zoom < 6) {
      // a click: with Object Finder, the object under the pointer
      if (o.finder) {
        E.toast('개체를 찾는 중…');
        setTimeout(() => {
          const f = this.find(E, d.a);
          if (!f) {
            E.toast('여기에서는 개체를 찾지 못했습니다');
            return;
          }
          const m = SX.foundToSelection(this.cache.src, f, { hard: !!o.hard });
          const before = E.doc.capture();
          E.doc.selection = SEL.combine(E.doc, m, d.mode);
          this.found = null;
          E.commit('개체 선택', before);
        }, 30);
        return;
      }
      E.toast('개체 둘레로 사각형(또는 올가미)을 끌어 그리세요');
      return;
    }
    if (r.w < 4 || r.h < 4) return;
    // Object Subtract off: subtracting takes away the whole drawn area, not the object in it
    if (d.mode === 'sub' && !o.objSub) {
      const doc = E.doc;
      const before = doc.capture();
      const area = lasso ? SEL.polyPath(d.pts.map((q) => [q.x, q.y])) : SEL.rectPath(r.x, r.y, r.w, r.h);
      doc.selection = SEL.combine(doc, SEL.shapeMask(doc, area), 'sub');
      E.commit('개체 선택', before);
      return;
    }
    E.toast('개체를 찾는 중…');
    setTimeout(() => {
      const src = sampleCanvas(E, o.sampleAll);
      let m = SX.objectSelect(src, r, { poly: lasso ? d.pts.map((q) => [q.x, q.y]) : null, hard: !!o.hard });
      if (!m) {
        // a box drawn inside one object (all one colour): the object is the like-coloured area around it
        const w = SEL.magicWand(E.doc, src, r.x + r.w / 2, r.y + r.h / 2, { tolerance: 40, contiguous: true });
        const b = w && SEL.alphaBounds(w);
        if (b && b.x <= r.x && b.y <= r.y && b.x + b.w >= r.x + r.w && b.y + b.h >= r.y + r.h && b.w * b.h < E.doc.width * E.doc.height * 0.9) m = w;
      }
      if (!m) {
        E.toast('개체를 찾지 못했습니다 (배경과 색이 비슷하면 어렵습니다)');
        return;
      }
      const before = E.doc.capture();
      E.doc.selection = SEL.combine(E.doc, m, d.mode);
      E.commit('개체 선택', before);
    }, 30);
  },
  deactivate(E) {
    clearTimeout(this.ht);
    this.d = null;
    this.found = null;
    this.cache = null;
    E.overlay?.();
  },
  cancel(E) {
    this.d = null;
    E.overlay();
  },
  overlay(E, g) {
    const d = this.d;
    const f = this.found;
    if (!d && f && f.key === this.finderKey(E)) {
      // the found object, tinted blue like Photoshop's Object Finder
      if (!f.tint) {
        const c = makeCanvas(f.sw, f.sh);
        const cg = c.getContext('2d');
        const img = cg.createImageData(f.sw, f.sh);
        for (let i = 0; i < f.label.length; i++) {
          if (!f.label[i]) continue;
          img.data[i * 4] = 40;
          img.data[i * 4 + 1] = 120;
          img.data[i * 4 + 2] = 255;
          img.data[i * 4 + 3] = 110;
        }
        cg.putImageData(img, 0, 0);
        f.tint = c;
      }
      const [x0, y0] = E.toScreen(0, 0);
      const [x1, y1] = E.toScreen(E.doc.width, E.doc.height);
      g.save();
      g.imageSmoothingEnabled = true;
      g.drawImage(f.tint, x0, y0, x1 - x0, y1 - y0);
      g.restore();
    }
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
  installMarquee(P);
  installChannelEdit(P);

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
      ...(t.styleFields ? t.styleFields(P) : []),
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
  let crDisp = { key: null, canvas: null };
  P.displayCanvas = (comp) => {
    const doc = P.doc;
    const pv = P._crPreview;
    if (pv && pv.doc === doc && pv.mode !== 'none') {
      const key = `${pv.ver}|${pv.mode}|${comp.width}x${comp.height}|${doc.rev}`;
      if (crDisp.key !== key) crDisp = { key, canvas: colorRangePreview(P, comp, pv) };
      return crDisp.canvas;
    }
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
  // Select ▸ Modify: Photoshop's dialogs (amount in pixels, "Apply effect at canvas bounds"),
  // remembering the last values
  const modPrefs = loadPref('photo.selmod', {});
  const modifyDialog = (title, field, key, def, max, bounds) => new Promise((resolve) => {
    const num = h('input', { type: 'number', min: key === 'feather' ? 0.1 : 1, max, step: key === 'feather' ? 0.1 : 1, value: modPrefs[key] ?? def, style: { width: '90px' } });
    const atB = h('input', { type: 'checkbox', checked: !!modPrefs[`${key}Bounds`] });
    openModal({
      title,
      body: h('div',
        h('div.form-row', h('label', field), h('div.inline', num, h('small', '픽셀'))),
        bounds ? h('label.ph-samchk', atB, ' 캔버스 경계에 효과 적용') : null),
      onClose: () => resolve(null),
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const n = Math.min(max, parseFloat(num.value));
          if (!Number.isFinite(n) || n <= 0) return false;
          modPrefs[key] = n;
          modPrefs[`${key}Bounds`] = atB.checked;
          savePref('photo.selmod', modPrefs);
          resolve({ n, atBounds: bounds && atB.checked });
        },
      }],
    });
    setTimeout(() => num.select(), 0);
  });
  /** Run fn on the selection alpha; atBounds pads the picture with unselected pixels first. */
  const modifyAlpha = (a, w, hh, atBounds, pad, fn) => {
    if (!atBounds) return fn(a, w, hh);
    const W2 = w + 2 * pad;
    const H2 = hh + 2 * pad;
    const big = new Float32Array(W2 * H2);
    for (let y = 0; y < hh; y++) big.set(a.subarray(y * w, y * w + w), (y + pad) * W2 + pad);
    const r = fn(big, W2, H2);
    const out = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) out.set(r.subarray((y + pad) * W2 + pad, (y + pad) * W2 + pad + w), y * w);
    return out;
  };
  /**
   * A Modify command: asks for the amount when not given, then runs again through P.cmd with the
   * values, so an action being recorded keeps them (like the core's feather used to).
   */
  const modify = async (name, label, title, field, key, def, max, bounds, fn, value, atBounds) => {
    if (!needSel()) return undefined;
    if (value === undefined) {
      const r = await modifyDialog(title, field, key, def, max, bounds);
      if (!r || !P.doc?.selection) return undefined;
      return P.cmd[name](r.n, r.atBounds);
    }
    const n = Math.min(max, +value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const doc = P.doc;
    const pad = Math.ceil(n) + 2;
    setAlpha(label, modifyAlpha(docAlpha(), doc.width, doc.height, bounds && !!atBounds, pad, (a, w, hh) => fn(a, w, hh, n)));
    if (!doc.selection) toast('선택된 픽셀이 없습니다');
    return undefined;
  };
  C.border = (v, b) => modify('border', '테두리', '테두리 선택 영역', '폭', 'border', 10, 200, false, (a, w, hh, n) => SX.borderAlpha(a, w, hh, n), v, b);
  C.smooth = (v, b) => modify('smooth', '매끄럽게', '선택 영역 매끄럽게', '샘플 반경', 'smooth', 5, 500, true, (a, w, hh, n) => SX.smoothAlpha(a, w, hh, n), v, b);
  C.expand = (v, b) => modify('expand', '확대', '선택 영역 확대', '확대량', 'expand', 5, 500, true, (a, w, hh, n) => SX.expandAlpha(a, w, hh, n), v, b);
  C.contract = (v, b) => modify('contract', '축소', '선택 영역 축소', '축소량', 'contract', 5, 500, true, (a, w, hh, n) => SX.expandAlpha(a, w, hh, -n), v, b);
  // Select ▸ Modify ▸ Feather (Shift+F6): Photoshop's dialog with "Apply effect at canvas bounds"
  C.feather = async (value, atBounds = false) => {
    if (!needSel()) return undefined;
    if (value === undefined) {
      const r = await modifyDialog('선택 영역 페더', '페더 반경', 'feather', 10, 1000, true);
      if (!r || !P.doc?.selection) return undefined;
      return P.cmd.feather(r.n, r.atBounds);
    }
    const n = +value;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    P.run('페더', () => { P.doc.selection = SEL.feather(P.doc, n, !!atBounds); });
    if (!P.doc.selection) toast('선택된 픽셀이 없습니다');
    return undefined;
  };

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
  C.channelToSelection = (which, mode = 'new', invert = false, label = '선택 영역 불러오기') => {
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
    P.run(label, () => { doc.selection = SEL.combine(doc, c, mode); });
    if (!doc.selection && mode === 'new') toast('선택된 픽셀이 없습니다 (채널이 모두 검정입니다)');
  };
  C.deleteChannel = (id = P.chState().active) => {
    const doc = P.doc;
    if (!doc || !id) return;
    P.run('채널 삭제', () => { doc.channels = doc.channels.filter((c) => c.id !== id); });
    P.emit('channels');
  };
  const COLOR_NAMES = { rgb: 'RGB', r: '빨강', g: '녹색', b: '파랑' };
  /** A channel's picture as alpha: an alpha channel's own, or a colour channel's brightness. */
  const channelCanvas = (id) => {
    const doc = P.doc;
    const ch = doc?.channels.find((c) => c.id === id);
    if (ch) return cloneCanvas(ch.canvas);
    if (COLOR_NAMES[id]) return SX.channelAlpha(P.composite(), id);
    return null;
  };
  const channelName = (id) => P.doc?.channels.find((c) => c.id === id)?.name || COLOR_NAMES[id] || '';
  const inverted = (c) => {
    const t = makeCanvas(c.width, c.height);
    const tg = t.getContext('2d');
    tg.fillRect(0, 0, t.width, t.height);
    tg.globalCompositeOperation = 'destination-out';
    tg.drawImage(c, 0, 0);
    return t;
  };
  /**
   * Duplicate a channel as a new alpha channel; a colour channel (빨강 / 녹색 / 파랑, or RGB for the
   * brightness) gives a greyscale copy to make a mask from, as in the classic channel-mask workflow.
   */
  C.duplicateChannel = (id = P.chState().active, { name = null, invert = false, show = false } = {}) => {
    const doc = P.doc;
    let c = channelCanvas(id);
    if (!doc || !c) return null;
    if (invert) c = inverted(c);
    const nid = newId();
    P.run('채널 복제', () => { doc.channels = [...doc.channels, { id: nid, name: name || `${channelName(id)} 복사`, canvas: c }]; });
    // Photoshop shows a duplicated colour channel on its own, ready for Levels and painting
    if (show) C.viewChannel(nid);
    else P.emit('channels');
    return nid;
  };
  C.duplicateChannelDialog = (id = P.chState().active || 'rgb') => {
    if (!P.doc) return;
    const name = h('input', { type: 'text', value: `${channelName(id)} 복사` });
    const inv = h('input', { type: 'checkbox' });
    openModal({
      title: '채널 복제',
      body: h('div', h('div.form-row', h('label', '복제'), h('b', channelName(id))), h('div.form-row', h('label', '대상'), name), h('div.form-row', h('label', '반전'), inv)),
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { C.duplicateChannel(id, { name: name.value.trim() || null, invert: inv.checked, show: !!COLOR_NAMES[id] }); } }],
    });
  };
  C.newChannelDialog = async () => {
    if (!P.doc) return;
    const n = await promptDialog('새 채널', '이름', chName());
    if (n == null) return;
    const id = C.newChannel(null, n.trim() || null);
    if (id) C.viewChannel(id);
  };
  /** Select ▸ Luminosity: the picture's brightness as a selection (Ctrl+Alt+2). */
  C.selectLuminosity = (mode = 'new') => {
    if (!P.doc) return;
    C.channelToSelection('rgb', mode, false, '광도 선택');
  };
  /**
   * Luminosity masks: lights k = L^k, darks k = (1 − L)^k, midtones k = (1 − L^k)(1 − (1 − L)^k), the
   * selections Photoshop users build by intersecting the luminosity with itself. toChannel saves
   * the whole set as alpha channels instead.
   */
  const lumaMask = (kind, k) => {
    const L = SX.alphaOf(SX.channelAlpha(P.composite(), 'rgb'));
    const a = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      a[i] = kind === 'lights' ? l ** k : kind === 'darks' ? (1 - l) ** k : (1 - l ** k) * (1 - (1 - l) ** k);
    }
    return SX.alphaCanvas(a, P.doc.width, P.doc.height);
  };
  const LUMA_NAMES = { lights: '밝은 영역', darks: '어두운 영역', mids: '중간 영역' };
  C.luminosityMask = (kind = 'lights', k = 1, mode = 'new') => {
    const doc = P.doc;
    if (!doc) return;
    const c = lumaMask(kind, k);
    P.run(`광도 마스크 (${LUMA_NAMES[kind]} ${k})`, () => { doc.selection = SEL.combine(doc, c, mode); });
    if (!doc.selection) toast('선택된 픽셀이 없습니다');
  };
  C.luminosityChannels = () => {
    const doc = P.doc;
    if (!doc) return;
    const set = [['lights', 1], ['lights', 2], ['lights', 3], ['lights', 4], ['mids', 1], ['mids', 2], ['darks', 1], ['darks', 2], ['darks', 3], ['darks', 4]];
    P.run('광도 마스크 채널 만들기', () => {
      doc.channels = [...doc.channels, ...set.map(([kind, k]) => ({ id: newId(), name: `${LUMA_NAMES[kind]} ${k}`, canvas: lumaMask(kind, k) }))];
    });
    P.emit('channels');
    toast('광도 마스크 10개를 채널로 만들었습니다. 채널을 Ctrl+클릭하면 선택 영역이 됩니다.');
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

  // ---------------------------------------------------------------- Select menu additions
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['선택'];
    if (!orig) return;
    P.menus['선택'] = () => {
      const items = orig();
      const no = !P.doc;
      const at = (start) => items.findIndex((x) => typeof x === 'object' && x?.label?.startsWith(start));
      // the subject and sky commands now work like Photoshop's
      const subj = at('피사체');
      if (subj >= 0) items[subj] = { ...items[subj], label: '피사체' };
      const sky = at('하늘');
      if (sky >= 0) items[sky] = { ...items[sky], label: '하늘' };
      // Luminosity next to Color Range (the core menu may list it at the end: moved, not doubled)
      const old = at('광도');
      if (old >= 0) items.splice(old, 1);
      const cr = at('색상 범위');
      const lum = (kind, label) => ({ label, submenu: [1, 2, 3, 4].filter((k) => kind !== 'mids' || k < 4).map((k) => ({ label: `${label} ${k}`, action: () => C.luminosityMask(kind, k) })) });
      items.splice(cr >= 0 ? cr + 1 : items.length, 0,
        { label: '광도 선택', key: `${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}Alt+2`, disabled: no, action: () => C.selectLuminosity() },
        { label: '광도 마스크', disabled: no, submenu: [
          lum('lights', '밝은 영역'), lum('mids', '중간 영역'), lum('darks', '어두운 영역'),
          '-',
          { label: '모두 채널로 만들기', action: () => C.luminosityChannels() },
        ] });
      return items;
    };
  }];
}

// ---------------------------------------------------------------- colour range dialog

const CR_PREVIEWS = [['none', '없음'], ['gray', '회색 음영'], ['black', '검정 매트'], ['white', '흰색 매트'], ['quick', '빠른 마스크']];
const CR_DEFAULTS = { select: 'sampled', fuzziness: 40, localized: false, range: 100, invert: false, toneFuzz: 20, shadowsHi: 65, highlightsLo: 190, midLo: 105, midHi: 150, preview: 'none' };

/** What the document shows while Colour Range is open (선택 영역 미리 보기), see P.displayCanvas. */
export function colorRangePreview(P, comp, pv) {
  const W = comp.width;
  const H = comp.height;
  const out = makeCanvas(W, H);
  const g = out.getContext('2d');
  // the selection at full size
  const a = makeCanvas(W, H);
  const ag = a.getContext('2d');
  ag.imageSmoothingEnabled = true;
  ag.imageSmoothingQuality = 'high';
  ag.drawImage(pv.alpha, 0, 0, W, H);
  if (pv.mode === 'gray') {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    ag.globalCompositeOperation = 'source-in';
    ag.fillStyle = '#fff';
    ag.fillRect(0, 0, W, H);
    g.drawImage(a, 0, 0);
  } else if (pv.mode === 'black' || pv.mode === 'white') {
    g.fillStyle = pv.mode === 'black' ? '#000' : '#fff';
    g.fillRect(0, 0, W, H);
    ag.globalCompositeOperation = 'source-in';
    ag.drawImage(comp, 0, 0);
    g.drawImage(a, 0, 0);
  } else {
    // quick mask: the colour over the unselected areas
    const qm = P.qmOpts || { color: '#ff0000', opacity: 50 };
    g.drawImage(comp, 0, 0);
    const t = makeCanvas(W, H);
    const tg = t.getContext('2d');
    tg.fillStyle = qm.color;
    tg.fillRect(0, 0, W, H);
    tg.globalCompositeOperation = 'destination-out';
    tg.drawImage(a, 0, 0);
    g.globalAlpha = qm.opacity / 100;
    g.drawImage(t, 0, 0);
  }
  return out;
}

function colorRangeDialog(P) {
  const doc = P.doc;
  if (!doc) return;
  if (P.transform) P.applyTransform();
  const comp = P.composite();
  const W = comp.width;
  const H = comp.height;
  // like Photoshop, an existing selection limits the command to it
  const within = doc.selection ? SX.alphaOf(doc.selection.canvas) : null;
  const shrunk = (k) => {
    const w = Math.max(1, Math.round(W * k));
    const hh = Math.max(1, Math.round(H * k));
    const c = makeCanvas(w, hh);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(comp, 0, 0, w, hh);
    const lim = within ? SX.alphaOf((() => { const m = makeCanvas(w, hh); const mg = m.getContext('2d'); mg.imageSmoothingQuality = 'high'; mg.drawImage(doc.selection.canvas, 0, 0, w, hh); return m; })()) : null;
    return { c, w, h: hh, px: g.getImageData(0, 0, w, hh).data, lim, k };
  };
  // the dialog's own preview (≤ 300 px) and the document preview (≤ about a megapixel)
  const S = shrunk(Math.min(1, 300 / Math.max(W, H)));
  const M = shrunk(Math.min(1, Math.sqrt(1e6 / (W * H))));
  const n = parseInt(P.fg.slice(1), 16);
  const o = { ...CR_DEFAULTS, ...loadPref('photo.colorRange', {}), samples: [[(n >> 16) & 255, (n >> 8) & 255, n & 255]], subtract: [], points: [] };
  const opts = (sz) => {
    const tones = o.select === 'shadows' ? { low: 0, high: o.shadowsHi } : o.select === 'highlights' ? { low: o.highlightsLo, high: 255 } : { low: Math.min(o.midLo, o.midHi), high: Math.max(o.midLo, o.midHi) };
    return { ...o, tones, points: o.points.map(([x, y]) => [x * sz.k, y * sz.k]) };
  };
  const alphaFor = (sz) => {
    const a = SX.colorRange(sz.px, sz.w, sz.h, opts(sz));
    if (sz.lim) for (let i = 0; i < a.length; i++) a[i] *= sz.lim[i];
    return a;
  };
  const view = h('canvas.ph-crprev', { width: S.w, height: S.h, title: '눌러서 색 고르기 (Shift+클릭 더하기, Alt+클릭 빼기)' });
  const sel = h('select', ...SX.COLOR_RANGE_PRESETS.map(([v, t]) => h('option', { value: v }, t)));
  sel.value = o.select;
  const slider = (min, max, value, label) => {
    const r = h('input', { type: 'range', min, max, value, 'aria-label': label });
    const num = h('input.ph-num', { type: 'number', min, max, value, 'aria-label': label, style: { width: '64px' } });
    r.addEventListener('input', () => { num.value = r.value; });
    num.addEventListener('change', () => {
      r.value = clamp(+num.value || 0, min, max);
      num.value = r.value;
      r.dispatchEvent(new Event('input'));
    });
    return { r, num, row: (text, unit) => h('div.form-row', h('label', text), h('div.inline', r, num, unit ? h('small', unit) : null)) };
  };
  const fuzz = slider(0, 200, o.select === 'sampled' ? o.fuzziness : o.toneFuzz, '허용량');
  const range = slider(1, 100, o.range, '범위');
  const toneA = slider(0, 255, 0, '범위');
  const toneB = slider(0, 255, 0, '범위 끝');
  const local = h('input', { type: 'checkbox', checked: o.localized });
  const inv = h('input', { type: 'checkbox', checked: o.invert });
  const pvSel = h('select', { 'aria-label': '선택 영역 미리 보기' }, ...CR_PREVIEWS.map(([v, t]) => h('option', { value: v }, t)));
  pvSel.value = o.preview;
  const fuzzRow = fuzz.row('허용량');
  const fuzzUnit = h('small');
  fuzzRow.querySelector('.inline').append(fuzzUnit);
  const localRow = h('div.form-row', h('label', '지역화된 색상 클러스터'), local);
  const rangeRow = range.row('범위', '%');
  const toneRow = h('div.form-row', h('label', '범위'), h('div.inline', toneA.r, toneA.num));
  const toneRow2 = h('div.form-row', h('label', '범위 끝'), h('div.inline', toneB.r, toneB.num));
  let pick = 'set';
  const pickBtns = [['set', 'eyedropper', '스포이드'], ['add', 'plus', '샘플에 추가 (Shift)'], ['sub', 'minus', '샘플에서 빼기 (Alt)']].map(([v, ic, t]) => {
    const b = h('button.small.ph-tog', { title: t, 'aria-label': t, onclick: () => { pick = v; pickBtns.forEach((x) => x.classList.toggle('on', x === b)); } }, icon('eyedropper'), v === 'set' ? null : icon(ic));
    if (v === pick) b.classList.add('on');
    return b;
  });
  const showSel = h('input', { type: 'radio', name: 'crview', checked: true });
  const showImg = h('input', { type: 'radio', name: 'crview' });
  const tone = () => ['highlights', 'shadows', 'midtones'].includes(o.select);
  /** Show the controls the chosen kind uses (like Photoshop's dialog). */
  const layout = () => {
    const sampled = o.select === 'sampled';
    localRow.hidden = !sampled;
    rangeRow.hidden = !sampled;
    range.r.disabled = range.num.disabled = !o.localized;
    fuzzRow.hidden = !sampled && !tone();
    fuzz.r.max = fuzz.num.max = sampled ? 200 : 100;
    fuzz.r.value = fuzz.num.value = sampled ? o.fuzziness : o.toneFuzz;
    fuzzUnit.textContent = sampled ? '' : '%';
    toneRow.hidden = !tone();
    toneRow2.hidden = o.select !== 'midtones';
    const [va, vb] = o.select === 'shadows' ? [o.shadowsHi, 0] : o.select === 'highlights' ? [o.highlightsLo, 0] : [o.midLo, o.midHi];
    toneA.r.value = toneA.num.value = va;
    toneB.r.value = toneB.num.value = vb;
    for (const b of pickBtns) b.disabled = !sampled;
  };
  let docTimer = 0;
  const pushDoc = () => {
    // the document preview (선택 영역 미리 보기) follows a moment later
    cancelAnimationFrame(docTimer);
    docTimer = requestAnimationFrame(() => {
      if (o.preview === 'none') {
        P._crPreview = null;
      } else {
        const a = alphaFor(M);
        P._crPreview = { doc, mode: o.preview, alpha: SX.alphaCanvas(a, M.w, M.h), ver: (P._crPreview?.ver || 0) + 1 };
      }
      P.redraw();
    });
  };
  const draw = () => {
    const g = view.getContext('2d');
    if (showImg.checked) g.drawImage(S.c, 0, 0);
    else {
      const a = alphaFor(S);
      const img = g.createImageData(S.w, S.h);
      for (let i = 0; i < a.length; i++) {
        const v = Math.round(a[i] * 255);
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    pushDoc();
  };
  sel.addEventListener('change', () => {
    o.select = sel.value;
    layout();
    draw();
  });
  fuzz.r.addEventListener('input', () => {
    if (o.select === 'sampled') o.fuzziness = +fuzz.r.value;
    else o.toneFuzz = +fuzz.r.value;
    draw();
  });
  range.r.addEventListener('input', () => { o.range = +range.r.value; draw(); });
  toneA.r.addEventListener('input', () => {
    const v = +toneA.r.value;
    if (o.select === 'shadows') o.shadowsHi = v;
    else if (o.select === 'highlights') o.highlightsLo = v;
    else o.midLo = v;
    draw();
  });
  toneB.r.addEventListener('input', () => { o.midHi = +toneB.r.value; draw(); });
  local.addEventListener('change', () => { o.localized = local.checked; layout(); draw(); });
  inv.addEventListener('change', () => { o.invert = inv.checked; draw(); });
  pvSel.addEventListener('change', () => { o.preview = pvSel.value; pushDoc(); });
  for (const el of [showSel, showImg]) el.addEventListener('change', draw);
  view.addEventListener('pointerdown', (e) => {
    const r = view.getBoundingClientRect();
    const x = clamp(Math.floor(((e.clientX - r.left) / r.width) * S.w), 0, S.w - 1);
    const y = clamp(Math.floor(((e.clientY - r.top) / r.height) * S.h), 0, S.h - 1);
    const i = (y * S.w + x) * 4;
    const c = [S.px[i], S.px[i + 1], S.px[i + 2]];
    const mode = e.shiftKey ? 'add' : e.altKey ? 'sub' : pick;
    const docPt = [x / S.k, y / S.k];
    if (o.select !== 'sampled') {
      // clicking the picture switches to sampled colours, as in Photoshop
      o.select = 'sampled';
      sel.value = 'sampled';
      o.samples = [c];
      o.subtract = [];
      o.points = [docPt];
      layout();
    } else if (mode === 'add') {
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
  const body = h('div.ph-crdlg',
    h('div.form-row', h('label', '선택'), sel),
    localRow,
    fuzzRow,
    rangeRow,
    toneRow,
    toneRow2,
    h('div.ph-crwrap', view),
    h('div.inline', h('label', showSel, ' 선택 영역'), h('label', showImg, ' 이미지')),
    h('div.inline', ...pickBtns),
    h('div.form-row', h('label', '선택 영역 미리 보기'), pvSel),
    h('div.form-row', h('label', '반전'), inv),
    h('div.note', within
      ? '지금 선택 영역 안에서만 고릅니다. 미리 보기를 눌러 색을 고르세요 (Shift+클릭 더하기, Alt+클릭 빼기).'
      : '미리 보기를 눌러 색을 고르세요 (Shift+클릭 더하기, Alt+클릭 빼기). 처음 샘플은 전경색입니다. 창 숨기기(H)로 그림 전체의 미리 보기를 볼 수 있습니다.'));
  const save = () => {
    const keep = {};
    for (const k of Object.keys(CR_DEFAULTS)) keep[k] = o[k];
    savePref('photo.colorRange', keep);
  };
  openModal({
    title: '색상 범위',
    width: 'min(440px, 96vw)',
    body,
    onClose: () => {
      cancelAnimationFrame(docTimer);
      P._crPreview = null;
      P.redraw();
    },
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        save();
        const a = SX.colorRange(SX.pixelsOf(comp), W, H, opts({ k: 1 }));
        if (within) for (let i = 0; i < a.length; i++) a[i] *= within[i];
        P.run('색상 범위', () => { doc.selection = SEL.combine(doc, SX.alphaCanvas(a, W, H), 'new'); });
        if (!doc.selection) toast('선택된 픽셀이 없습니다');
      },
    }],
  });
  layout();
  draw();
}

// ---------------------------------------------------------------- Channels panel

export function buildChannelsPanel(P) {
  const list = h('div.ph-layers', { role: 'listbox', 'aria-label': '채널' });
  const btn = (ic, title, onclick) => h('button.small', { title, 'aria-label': title, onclick }, icon(ic));
  const panelMenu = () => {
    const st = P.chState?.();
    const a = st?.active || null;
    return [
      { label: '새 채널…', disabled: !P.doc, action: () => P.cmd.newChannelDialog() },
      { label: '채널 복제…', disabled: !P.doc, action: () => P.cmd.duplicateChannelDialog(a || (st && st.comps.size === 1 ? [...st.comps][0] : 'rgb')) },
      { label: '채널 삭제', disabled: !a, action: () => P.cmd.deleteChannel(a) },
      '-',
      { label: '채널 옵션…', disabled: !a, action: () => P.cmd.renameChannel(a) },
      { label: '선택 영역을 채널로 저장', disabled: !P.doc?.selection, action: () => P.cmd.selectionToChannel() },
      { label: '채널을 선택 영역으로 불러오기', disabled: !P.doc, action: () => (a ? P.cmd.channelToSelection(a) : P.cmd.loadSelection()) },
      { label: '광도 마스크를 채널로 만들기', disabled: !P.doc, action: () => P.cmd.luminosityChannels() },
      '-',
      { label: '빠른 마스크 옵션…', action: () => P.cmd.quickMaskOptions() },
    ];
  };
  const menuBtn = h('button.small', {
    title: '채널 패널 메뉴', 'aria-label': '채널 패널 메뉴',
    onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      import('../ui/common.js').then(({ showMenu }) => showMenu(panelMenu(), r.left, r.bottom));
    },
  }, icon('menu'));
  const foot = h('div.ph-lfoot',
    btn('selEllipse', '채널을 선택 영역으로 불러오기 (채널을 Ctrl+클릭해도 됩니다)', () => { const a = P.chState?.().active; if (a) P.cmd.channelToSelection(a); else P.cmd.loadSelection(); }),
    btn('mask', '선택 영역을 채널로 저장', () => P.cmd.selectionToChannel()),
    btn('plus', '새 채널', () => P.cmd.newChannelDialog()),
    btn('trash', '채널 삭제', () => P.cmd.deleteChannel()),
    menuBtn);
  const el = h('div.ph-panel.layers.channels', list, foot);
  // thumbnails: the colour ones follow the picture, an alpha channel's its own canvas
  let colorKey = '';
  let colorPx = null;
  const alphaThumbs = new WeakMap();
  const T = 40;
  const fit = () => {
    const doc = P.doc;
    const s = Math.min(T / doc.width, T / doc.height);
    return { s, ox: (T - doc.width * s) / 2, oy: (T - doc.height * s) / 2 };
  };
  const colorThumb = (which) => {
    const doc = P.doc;
    const k = `${doc.id}:${doc.rev}:${doc.width}x${doc.height}`;
    if (colorKey !== k) {
      const c = makeCanvas(T, T);
      const g = c.getContext('2d');
      const { s, ox, oy } = fit();
      g.fillStyle = '#000';
      g.fillRect(0, 0, T, T);
      g.drawImage(P.composite(), ox, oy, doc.width * s, doc.height * s);
      colorPx = g.getImageData(0, 0, T, T);
      colorKey = k;
    }
    const out = h('canvas.ph-thumb', { width: T, height: T });
    const img = new ImageData(new Uint8ClampedArray(colorPx.data), T, T);
    const c = { r: 0, g: 1, b: 2 }[which];
    if (c !== undefined) for (let i = 0; i < img.data.length; i += 4) img.data[i] = img.data[i + 1] = img.data[i + 2] = img.data[i + c];
    out.getContext('2d').putImageData(img, 0, 0);
    return out;
  };
  const alphaThumb = (canvas) => {
    let t = alphaThumbs.get(canvas);
    if (!t || t.w !== P.doc.width || t.h !== P.doc.height) {
      const c = makeCanvas(T, T);
      const g = c.getContext('2d');
      const { s, ox, oy } = fit();
      // white where selected, on black
      g.drawImage(canvas, ox, oy, P.doc.width * s, P.doc.height * s);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, T, T);
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = '#000';
      g.fillRect(0, 0, T, T);
      t = { c, w: P.doc.width, h: P.doc.height };
      alphaThumbs.set(canvas, t);
    }
    const out = h('canvas.ph-thumb', { width: T, height: T });
    out.getContext('2d').drawImage(t.c, 0, 0);
    return out;
  };
  const loadMode = (e) => (e.shiftKey && e.altKey ? 'inter' : e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new');
  const render = () => {
    const doc = P.doc;
    list.replaceChildren();
    if (!doc || !P.chState) return;
    const st = P.chState();
    const row = (key, label, thumb, { visible, on, eye, click, menu, dbl, italic }) => {
      const eyeBtn = h(`button.ph-eye${visible ? '.on' : ''}`, { 'aria-label': `${label} 보이기`, 'aria-pressed': String(!!visible), title: '보기 켜기/끄기', onclick: (e) => { e.stopPropagation(); eye(); } }, visible ? icon('eye') : '');
      thumb.title = 'Ctrl+클릭: 선택 영역으로 불러오기 (Shift 더하기, Alt 빼기, Shift+Alt 교차)';
      const r = h(`div.ph-layer${on ? '.on.active' : ''}`, { role: 'option', 'aria-selected': String(!!on) }, eyeBtn, thumb, h('span.ph-lname', italic ? h('i', label) : label));
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
    const colorMenu = (k) => () => [
      { label: '선택 영역으로 불러오기', action: () => P.cmd.channelToSelection(k) },
      { label: '채널 복제…', action: () => P.cmd.duplicateChannelDialog(k) },
    ];
    row('rgb', 'RGB', colorThumb('rgb'), { visible: allOn, on: allOn && !st.active, eye: () => P.cmd.toggleChannelEye('rgb'), click: () => P.cmd.viewChannel('rgb'), menu: colorMenu('rgb') });
    for (const [k, name] of [['r', '빨강'], ['g', '녹색'], ['b', '파랑']]) {
      row(k, name, colorThumb(k), {
        visible: st.comps.has(k), on: st.comps.has(k) && !st.active, eye: () => P.cmd.toggleChannelEye(k), click: (e) => P.cmd.viewChannel(k, { toggle: e.shiftKey }),
        menu: colorMenu(k),
      });
    }
    for (const ch of doc.channels) {
      row(ch.id, ch.name, alphaThumb(ch.canvas), {
        visible: st.alpha.has(ch.id), on: st.active === ch.id, eye: () => P.cmd.toggleChannelEye(ch.id), click: (e) => P.cmd.viewChannel(ch.id, { toggle: e.shiftKey }),
        dbl: () => P.cmd.renameChannel(ch.id),
        menu: () => [
          { label: '선택 영역으로 불러오기', action: () => P.cmd.channelToSelection(ch.id) },
          { label: '채널 옵션…', action: () => P.cmd.renameChannel(ch.id) },
          { label: '채널 복제…', action: () => P.cmd.duplicateChannelDialog(ch.id) },
          { label: '반전', action: () => P.cmd.invertChannel(ch.id) },
          '-',
          { label: '채널 삭제', action: () => P.cmd.deleteChannel(ch.id) },
        ],
      });
    }
    if (doc.quickMask) {
      row('quick', '빠른 마스크', alphaThumb(doc.quickMask.canvas), {
        visible: true, on: true, italic: true, eye: () => {}, click: () => {},
        menu: () => [{ label: '빠른 마스크 모드 끝 (Q)', action: () => P.cmd.quickMask(false) }, { label: '빠른 마스크 옵션…', action: () => P.cmd.quickMaskOptions() }],
      });
    }
    if (!doc.channels.length && !doc.quickMask) list.append(h('div.note', '선택 영역 ▸ 선택 영역 저장으로 알파 채널을 만들 수 있습니다. 채널을 Ctrl+클릭하면 선택 영역으로 불러오고, 빨강·녹색·파랑 채널을 복제하면 마스크를 만들 수 있습니다.'));
  };
  for (const ev of ['channels', 'history', 'layers', 'quickmask']) P.on(ev, render);
  render();
  return el;
}
