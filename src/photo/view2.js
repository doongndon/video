// View extras: rulers, guides (drag from a ruler, move, delete, lock, new guide / layout), grid,
// snapping (guides, grid, canvas edges and centre) and the Navigator, Info and Histogram panels.

import { h, clamp } from '../util.js';
import { toast, openModal, formRow, loadPref, savePref } from '../ui/common.js';
import { makeCanvas } from './doc.js';

const RULER = 18;
const SNAP_TOOLS = new Set(['rect', 'ellipse', 'singleRow', 'singleCol', 'crop', 'perspCrop', 'shape', 'text', 'verticalText', 'textMask', 'verticalTextMask', 'gradient', 'ruler', 'pen', 'polyLasso', 'objSel', 'redEye', 'count', 'note', 'sampler']);

export function installViewExtras(P, { stage }) {
  const vx = loadPref('photo.viewx', { rulers: false, guides: true, grid: false, snap: true, lock: false, gridStep: 100, gridSub: 4, guideColor: '#00c8ff' });
  const save = () => savePref('photo.viewx', vx);
  P.viewx = vx;

  // ---------------------------------------------------------------- drawing
  const niceStep = (zoom) => {
    for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]) if (s * zoom >= 60) return s;
    return 20000;
  };
  P.drawViewExtras = (g) => {
    const doc = P.doc;
    if (!doc) return;
    drawSmart(g);
    const v = doc.view;
    const W = g.canvas.width / (window.devicePixelRatio || 1);
    const H = g.canvas.height / (window.devicePixelRatio || 1);
    g.save();
    const extras = P.extrasOn !== false;
    // pixel grid: very close up, a line between pixels (like Photoshop above 800%)
    if (vx.pixelGrid !== false && extras && v.zoom * (window.devicePixelRatio || 1) >= 8) {
      const x0 = Math.max(0, Math.floor(-v.x / v.zoom));
      const y0 = Math.max(0, Math.floor(-v.y / v.zoom));
      const x1 = Math.min(doc.width, Math.ceil((W - v.x) / v.zoom));
      const y1 = Math.min(doc.height, Math.ceil((H - v.y) / v.zoom));
      if ((x1 - x0) + (y1 - y0) < 1200) {
        g.strokeStyle = 'rgba(128,128,128,.35)';
        g.lineWidth = 1;
        g.beginPath();
        for (let x = x0; x <= x1; x++) {
          const sx = Math.round(v.x + x * v.zoom) + 0.5;
          g.moveTo(sx, v.y + y0 * v.zoom);
          g.lineTo(sx, v.y + y1 * v.zoom);
        }
        for (let y = y0; y <= y1; y++) {
          const sy = Math.round(v.y + y * v.zoom) + 0.5;
          g.moveTo(v.x + x0 * v.zoom, sy);
          g.lineTo(v.x + x1 * v.zoom, sy);
        }
        g.stroke();
      }
    }
    if (vx.grid && extras) {
      const step = vx.gridStep;
      const sub = step / Math.max(1, vx.gridSub);
      const [x0, y0] = P.toScreen(0, 0);
      const [x1, y1] = P.toScreen(doc.width, doc.height);
      const lines = (s, a) => {
        if (s * v.zoom < 4) return;
        g.strokeStyle = a;
        g.beginPath();
        for (let x = 0; x <= doc.width; x += s) {
          const sx = Math.round(x0 + x * v.zoom) + 0.5;
          g.moveTo(sx, y0);
          g.lineTo(sx, y1);
        }
        for (let y = 0; y <= doc.height; y += s) {
          const sy = Math.round(y0 + y * v.zoom) + 0.5;
          g.moveTo(x0, sy);
          g.lineTo(x1, sy);
        }
        g.stroke();
      };
      g.lineWidth = 1;
      lines(sub, 'rgba(120,120,120,.25)');
      lines(step, 'rgba(120,120,120,.6)');
    }
    if (vx.guides && extras) {
      g.strokeStyle = vx.guideColor;
      g.lineWidth = 1;
      for (const gd of [...doc.guides, ...(drag?.kind === 'guide' && drag.live ? [drag.live] : [])]) {
        g.beginPath();
        if (gd.axis === 'x') {
          const sx = Math.round(P.toScreen(gd.pos, 0)[0]) + 0.5;
          g.moveTo(sx, 0);
          g.lineTo(sx, H);
        } else {
          const sy = Math.round(P.toScreen(0, gd.pos)[1]) + 0.5;
          g.moveTo(0, sy);
          g.lineTo(W, sy);
        }
        g.stroke();
      }
    }
    if (snapMark) {
      g.strokeStyle = '#ff3fb4';
      g.setLineDash([3, 3]);
      g.beginPath();
      if (snapMark.x != null) {
        const sx = Math.round(P.toScreen(snapMark.x, 0)[0]) + 0.5;
        g.moveTo(sx, 0);
        g.lineTo(sx, H);
      }
      if (snapMark.y != null) {
        const sy = Math.round(P.toScreen(0, snapMark.y)[1]) + 0.5;
        g.moveTo(0, sy);
        g.lineTo(W, sy);
      }
      g.stroke();
      g.setLineDash([]);
    }
    if (vx.rulers) {
      const step = niceStep(v.zoom);
      const minor = step / (String(step).startsWith('25') ? 5 : step % 5 === 0 ? 5 : 2);
      g.fillStyle = 'rgba(32,34,38,.94)';
      g.fillRect(0, 0, W, RULER);
      g.fillRect(0, 0, RULER, H);
      g.strokeStyle = 'rgba(200,205,214,.55)';
      g.fillStyle = 'rgba(220,224,230,.9)';
      g.font = '10px system-ui, sans-serif';
      g.textBaseline = 'top';
      g.beginPath();
      const startX = Math.floor(-v.x / v.zoom / minor) * minor;
      for (let d = startX; d * v.zoom + v.x < W; d += minor) {
        const sx = Math.round(d * v.zoom + v.x) + 0.5;
        if (sx < RULER) continue;
        const major = Math.abs(d % step) < 1e-6;
        g.moveTo(sx, RULER);
        g.lineTo(sx, major ? 2 : RULER - 5);
        if (major) g.fillText(String(Math.round(d)), sx + 2, 2);
      }
      const startY = Math.floor(-v.y / v.zoom / minor) * minor;
      for (let d = startY; d * v.zoom + v.y < H; d += minor) {
        const sy = Math.round(d * v.zoom + v.y) + 0.5;
        if (sy < RULER) continue;
        const major = Math.abs(d % step) < 1e-6;
        g.moveTo(RULER, sy);
        g.lineTo(major ? 2 : RULER - 5, sy);
        if (major) {
          g.save();
          g.translate(2, sy + 2);
          g.rotate(Math.PI / 2);
          g.fillText(String(Math.round(d)), 0, -10);
          g.restore();
        }
      }
      g.stroke();
      // cursor position marks
      if (P.hoverPoint) {
        const [hx, hy] = P.toScreen(P.hoverPoint.x, P.hoverPoint.y);
        g.strokeStyle = '#4aa3ff';
        g.beginPath();
        g.moveTo(hx + 0.5, 0);
        g.lineTo(hx + 0.5, RULER);
        g.moveTo(0, hy + 0.5);
        g.lineTo(RULER, hy + 0.5);
        g.stroke();
      }
      g.fillStyle = 'rgba(32,34,38,1)';
      g.fillRect(0, 0, RULER, RULER);
    }
    g.restore();
  };

  // ---------------------------------------------------------------- snapping
  let snapMark = null;
  P.snapPoint = (p, toolId) => {
    snapMark = null;
    const doc = P.doc;
    if (!vx.snap || !doc || !SNAP_TOOLS.has(toolId)) return p;
    const tol = 8 / doc.view.zoom;
    const xs = [0, doc.width / 2, doc.width];
    const ys = [0, doc.height / 2, doc.height];
    if (vx.guides) for (const gd of doc.guides) (gd.axis === 'x' ? xs : ys).push(gd.pos);
    let best = (list, v) => {
      let b = null;
      let bd = tol;
      for (const c of list) {
        const d = Math.abs(c - v);
        if (d <= bd) {
          bd = d;
          b = c;
        }
      }
      return b;
    };
    let sx = best(xs, p.x);
    let sy = best(ys, p.y);
    if (vx.grid) {
      const s = vx.gridStep / Math.max(1, vx.gridSub);
      const gx = Math.round(p.x / s) * s;
      const gy = Math.round(p.y / s) * s;
      if (sx == null && Math.abs(gx - p.x) <= tol) sx = gx;
      if (sy == null && Math.abs(gy - p.y) <= tol) sy = gy;
    }
    best = null;
    if (sx == null && sy == null) return p;
    snapMark = { x: sx, y: sy };
    return { x: sx ?? p.x, y: sy ?? p.y };
  };
  P.clearSnapMark = () => {
    snapMark = null;
    smart = null;
  };

  // ---------------------------------------------------------------- smart guides (moving layers)
  // Like Canva and Photoshop's smart guides: while layers are dragged, their edges and centre stick
  // to the canvas edges and centre, to other layers' edges and centres and to guides, and pink
  // lines show what lines up. Ctrl (⌘) while dragging turns it off for the moment.
  let smart = null;
  const SMART_TOL = 6;
  const buildSmart = (moving) => {
    const doc = P.doc;
    const ids = new Set();
    for (const l of moving) {
      ids.add(l.id);
      if (l.kind === 'group') for (const d of doc.descendants(l.id)) ids.add(d.id);
    }
    let box = null;
    for (const l of moving) {
      const f = P.layerFrame(l);
      if (!f) continue;
      const b = f.box;
      box = box ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), x1: Math.max(box.x1, b.x + b.w), y1: Math.max(box.y1, b.y + b.h) } : { x: b.x, y: b.y, x1: b.x + b.w, y1: b.y + b.h };
    }
    const W = doc.width;
    const H = doc.height;
    const xs = [{ v: 0, a: 0, b: H, page: true }, { v: W / 2, a: 0, b: H, page: true }, { v: W, a: 0, b: H, page: true }];
    const ys = [{ v: 0, a: 0, b: W, page: true }, { v: H / 2, a: 0, b: W, page: true }, { v: H, a: 0, b: W, page: true }];
    if (vx.guides && vx.snap) for (const gd of doc.guides) (gd.axis === 'x' ? xs : ys).push({ v: gd.pos, a: 0, b: gd.axis === 'x' ? H : W, page: true });
    let n = 0;
    for (const l of [...doc.layers].reverse()) {
      if (n > 150) break;
      if (ids.has(l.id) || l.kind === 'adjust' || l.kind === 'group' || !doc.shown(l)) continue;
      const f = P.layerFrame(l);
      if (!f) continue;
      const b = f.box;
      // a layer that fills the canvas adds nothing the canvas edges don't
      if (b.x <= 0 && b.y <= 0 && b.x + b.w >= W && b.y + b.h >= H) continue;
      n++;
      for (const v of [b.x, b.x + b.w / 2, b.x + b.w]) xs.push({ v, a: b.y, b: b.y + b.h });
      for (const v of [b.y, b.y + b.h / 2, b.y + b.h]) ys.push({ v, a: b.x, b: b.x + b.w });
    }
    return { moving, box, xs, ys, marks: [] };
  };
  P.snapMove = (moving, dx, dy, e) => {
    const doc = P.doc;
    if (!doc) return { dx, dy };
    if (!smart || smart.moving !== moving) smart = buildSmart(moving);
    smart.marks = [];
    const b = smart.box;
    if (vx.smart === false || !b || e?.ctrlKey || e?.metaKey) return { dx, dy };
    const tol = SMART_TOL / doc.view.zoom;
    const axis = (d, lo, hi, targets) => {
      const cands = [lo + d, (lo + hi) / 2 + d, hi + d];
      let best = null;
      for (const c of cands) {
        for (const t of targets) {
          const off = t.v - c;
          if (Math.abs(off) <= tol && (!best || Math.abs(off) < Math.abs(best))) best = off;
        }
      }
      return best == null ? d : d + best;
    };
    const sdx = Math.round(axis(dx, b.x, b.x1, smart.xs));
    const sdy = Math.round(axis(dy, b.y, b.y1, smart.ys));
    // lines for everything that now lines up (within half a pixel)
    const mx = [b.x + sdx, (b.x + b.x1) / 2 + sdx, b.x1 + sdx];
    const my = [b.y + sdy, (b.y + b.y1) / 2 + sdy, b.y1 + sdy];
    const [top, bottom, left, right] = [b.y + sdy, b.y1 + sdy, b.x + sdx, b.x1 + sdx];
    for (const t of smart.xs) if (mx.some((c) => Math.abs(c - t.v) < 0.75)) smart.marks.push({ axis: 'x', v: t.v, a: t.page ? t.a : Math.min(t.a, top), b: t.page ? t.b : Math.max(t.b, bottom) });
    for (const t of smart.ys) if (my.some((c) => Math.abs(c - t.v) < 0.75)) smart.marks.push({ axis: 'y', v: t.v, a: t.page ? t.a : Math.min(t.a, left), b: t.page ? t.b : Math.max(t.b, right) });
    return { dx: sdx, dy: sdy };
  };
  /** The lines shown right now (for tests and the status bar). */
  P.smartGuideMarks = () => smart?.marks || [];
  const drawSmart = (g) => {
    if (!smart?.marks.length) return;
    g.save();
    g.strokeStyle = '#ff3d9a';
    g.lineWidth = 1;
    g.beginPath();
    for (const m of smart.marks) {
      if (m.axis === 'x') {
        const [x, y0] = P.toScreen(m.v, m.a);
        const [, y1] = P.toScreen(m.v, m.b);
        g.moveTo(Math.round(x) + 0.5, y0);
        g.lineTo(Math.round(x) + 0.5, y1);
      } else {
        const [x0, y] = P.toScreen(m.a, m.v);
        const [x1] = P.toScreen(m.b, m.v);
        g.moveTo(x0, Math.round(y) + 0.5);
        g.lineTo(x1, Math.round(y) + 0.5);
      }
    }
    g.stroke();
    g.restore();
  };

  // ---------------------------------------------------------------- guide dragging
  let drag = null;
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const guideAt = (e) => {
    const doc = P.doc;
    if (!vx.guides || vx.lock || !doc) return -1;
    const q = local(e);
    let best = -1;
    let bd = 4;
    doc.guides.forEach((gd, i) => {
      const s = gd.axis === 'x' ? P.toScreen(gd.pos, 0)[0] : P.toScreen(0, gd.pos)[1];
      const d = Math.abs(s - (gd.axis === 'x' ? q.x : q.y));
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  /** Pointer down on the stage: start a guide drag (from a ruler, or on a guide with the move tool). */
  P.viewExtrasDown = (e) => {
    const doc = P.doc;
    if (!doc) return false;
    const q = local(e);
    if (vx.rulers && (q.y < RULER || q.x < RULER)) {
      if (q.y < RULER && q.x < RULER) return true;
      if (!vx.guides) {
        vx.guides = true;
        save();
      }
      drag = { kind: 'guide', axis: q.y < RULER ? 'y' : 'x', index: -1, before: doc.capture() };
      drag.live = { axis: drag.axis, pos: 0 };
      return true;
    }
    if (P.tool === 'move' || e.ctrlKey || e.metaKey) {
      const i = guideAt(e);
      if (i >= 0) {
        const gd = doc.guides[i];
        drag = { kind: 'guide', axis: gd.axis, index: i, before: doc.capture() };
        doc.guides.splice(i, 1);
        drag.live = { ...gd };
        return true;
      }
    }
    return false;
  };
  P.viewExtrasMove = (e, p) => {
    if (!drag) return;
    let pos = drag.axis === 'x' ? p.x : p.y;
    if (vx.snap) {
      const tol = 8 / P.doc.view.zoom;
      const lim = drag.axis === 'x' ? P.doc.width : P.doc.height;
      for (const c of [0, lim / 2, lim]) if (Math.abs(pos - c) <= tol) pos = c;
    }
    drag.live = { axis: drag.axis, pos: e.shiftKey ? pos : Math.round(pos) };
    stage.style.cursor = drag.axis === 'x' ? 'col-resize' : 'row-resize';
    P.redraw();
  };
  P.viewExtrasUp = (e) => {
    if (!drag) return;
    const doc = P.doc;
    const q = local(e);
    const r = stage.getBoundingClientRect();
    // dropped back on a ruler or outside the view: the guide goes away
    const gone = (drag.axis === 'x' ? q.x < (vx.rulers ? RULER : 0) || q.x > r.width : q.y < (vx.rulers ? RULER : 0) || q.y > r.height);
    if (!gone) doc.guides.push(drag.live);
    if (gone && drag.index < 0) doc.restore(drag.before);
    else P.commit(gone ? '안내선 삭제' : drag.index < 0 ? '새 안내선' : '안내선 이동', drag.before);
    drag = null;
    P.redraw();
  };
  P.viewExtrasHover = (e) => {
    if (drag) return false;
    const q = local(e);
    if (vx.rulers && (q.y < RULER || q.x < RULER)) {
      stage.style.cursor = q.y < RULER && q.x < RULER ? 'default' : q.y < RULER ? 'row-resize' : 'col-resize';
      return true;
    }
    if (P.tool === 'move' || e.ctrlKey || e.metaKey) {
      const i = guideAt(e);
      if (i >= 0) {
        stage.style.cursor = P.doc.guides[i].axis === 'x' ? 'col-resize' : 'row-resize';
        return true;
      }
    }
    return false;
  };

  // ---------------------------------------------------------------- commands
  const C = P.cmd;
  const toggle = (k, label) => {
    vx[k] = !vx[k];
    save();
    toast(`${label} ${vx[k] ? '켬' : '끔'}`);
    P.redraw();
  };
  C.toggleRulers = () => toggle('rulers', '눈금자');
  C.toggleGuides = () => toggle('guides', '안내선 보기');
  C.toggleGrid = () => toggle('grid', '격자');
  C.toggleSnap = () => toggle('snap', '스냅 (자석)');
  C.toggleSmartGuides = () => {
    vx.smart = vx.smart === false;
    save();
    toast(vx.smart ? '스마트 안내선을 켰습니다 (레이어를 끌면 가장자리·가운데에 맞춰 붙습니다)' : '스마트 안내선을 껐습니다');
  };
  C.toggleGuideLock = () => toggle('lock', '안내선 잠그기');
  C.clearGuides = () => {
    if (!P.doc?.guides.length) return toast('안내선이 없습니다');
    P.run('안내선 지우기', () => { P.doc.guides = []; });
    return undefined;
  };
  C.newGuide = () => {
    const doc = P.doc;
    if (!doc) return;
    const axis = h('select', h('option', { value: 'y' }, '가로 (수평선)'), h('option', { value: 'x' }, '세로 (수직선)'));
    const pos = h('input', { type: 'number', value: Math.round(doc.height / 2), style: { width: '100px' } });
    const unit = h('select', h('option', { value: 'px' }, '픽셀'), h('option', { value: '%' }, '%'));
    openModal({
      title: '새 안내선',
      width: '360px',
      body: [formRow('방향', axis), formRow('위치', pos, unit)],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const lim = axis.value === 'x' ? doc.width : doc.height;
          const v = unit.value === '%' ? (+pos.value / 100) * lim : +pos.value;
          P.run('새 안내선', () => doc.guides.push({ axis: axis.value, pos: v }));
          if (!vx.guides) C.toggleGuides();
        },
      }],
    });
  };
  C.guideLayout = () => {
    const doc = P.doc;
    if (!doc) return;
    const n = (v, w = '70px') => h('input', { type: 'number', value: v, min: 0, style: { width: w } });
    const cols = n(3);
    const rows = n(0);
    const gutter = n(0);
    const margin = n(0);
    const clear = h('input', { type: 'checkbox', checked: true });
    openModal({
      title: '새 안내선 레이아웃',
      width: '400px',
      body: [formRow('열 (세로 칸)', cols), formRow('행 (가로 칸)', rows), formRow('칸 사이 간격 (px)', gutter), formRow('바깥 여백 (px)', margin), h('label.inline', clear, ' 기존 안내선 지우기')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const m = +margin.value;
          const gt = +gutter.value;
          const list = clear.checked ? [] : [...doc.guides];
          const make = (count, total, axis) => {
            if (count <= 0) return;
            if (m > 0) list.push({ axis, pos: m }, { axis, pos: total - m });
            const inner = total - 2 * m;
            const cell = (inner - gt * (count - 1)) / count;
            for (let i = 1; i < count; i++) {
              const x = m + i * cell + (i - 1) * gt;
              list.push({ axis, pos: x });
              if (gt > 0) list.push({ axis, pos: x + gt });
            }
          };
          make(+cols.value, doc.width, 'x');
          make(+rows.value, doc.height, 'y');
          P.run('새 안내선 레이아웃', () => { doc.guides = list; });
          if (!vx.guides) C.toggleGuides();
        },
      }],
    });
  };
  C.guideFromShape = () => {
    const doc = P.doc;
    const l = doc?.active;
    const b = doc?.selection ? null : l && doc.bounds?.(l);
    const r = doc?.selection ? (() => { const c = doc.selection.canvas; return P.selBounds?.(c); })() : b;
    if (!r) return toast('선택 영역이나 레이어가 있어야 합니다');
    P.run('모양에서 안내선', () => doc.guides.push({ axis: 'x', pos: r.x }, { axis: 'x', pos: r.x + r.w / 2 }, { axis: 'x', pos: r.x + r.w }, { axis: 'y', pos: r.y }, { axis: 'y', pos: r.y + r.h / 2 }, { axis: 'y', pos: r.y + r.h }));
    return undefined;
  };
  C.gridSettings = () => {
    const step = h('input', { type: 'number', value: vx.gridStep, min: 2, style: { width: '90px' } });
    const sub = h('input', { type: 'number', value: vx.gridSub, min: 1, max: 20, style: { width: '70px' } });
    const col = h('input', { type: 'color', value: vx.guideColor });
    openModal({
      title: '안내선 · 격자 설정',
      width: '380px',
      body: [formRow('격자 간격 (px)', step), formRow('세분', sub), formRow('안내선 색', col)],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { vx.gridStep = Math.max(2, +step.value); vx.gridSub = clamp(+sub.value, 1, 20); vx.guideColor = col.value; save(); P.redraw(); } }],
    });
  };

  C.togglePixelGrid = () => {
    vx.pixelGrid = vx.pixelGrid === false;
    save();
    P.redraw();
    toast(vx.pixelGrid ? '픽셀 격자 켬 (800% 이상에서 보임)' : '픽셀 격자 끔');
  };
  /** View ▸ Extras (Ctrl+H): hide selection edges, guides, grids and frame outlines while looking. */
  C.toggleExtras = () => {
    P.extrasOn = P.extrasOn === false;
    P.redraw();
    toast(P.extrasOn ? '표시 요소 보임' : '표시 요소 숨김 (Ctrl+H로 다시 보기)');
  };
  P.viewMenuItems = (mod, no) => [
    '-',
    { label: '눈금자', key: `${mod}R`, checked: vx.rulers, disabled: no(), action: () => C.toggleRulers() },
    { label: '표시', disabled: no(), submenu: [
      { label: '안내선', key: `${mod};`, checked: vx.guides, action: () => C.toggleGuides() },
      { label: '격자', key: `${mod}'`, checked: vx.grid, action: () => C.toggleGrid() },
      { label: '스마트 안내선 (레이어 맞춰 붙기)', checked: vx.smart !== false, action: () => C.toggleSmartGuides() },
      { label: '픽셀 격자 (800% 이상 확대했을 때)', checked: vx.pixelGrid !== false, action: () => C.togglePixelGrid() },
      '-',
      { label: '표시 요소 모두 (선택 테두리·안내선·격자)', key: `${mod}H`, checked: P.extrasOn !== false, action: () => C.toggleExtras() },
    ] },
    { label: '스냅 (자석처럼 붙기)', key: `${mod}Shift+;`, checked: vx.snap, disabled: no(), action: () => C.toggleSnap() },
    '-',
    { label: '새 안내선…', disabled: no(), action: () => C.newGuide() },
    { label: '새 안내선 레이아웃… (칸 나누기)', disabled: no(), action: () => C.guideLayout() },
    { label: '선택 영역·레이어에서 안내선', disabled: no(), action: () => C.guideFromShape() },
    { label: '안내선 잠그기', key: `${mod}Alt+;`, checked: vx.lock, disabled: no(), action: () => C.toggleGuideLock() },
    { label: '안내선 지우기', disabled: no() || !P.doc?.guides.length, action: () => C.clearGuides() },
    { label: '안내선 · 격자 설정…', action: () => C.gridSettings() },
  ];
  /** Keys handled here: Ctrl+R, Ctrl+; Ctrl+' Ctrl+Shift+; Ctrl+Alt+; */
  P.viewKeys = (e, mod) => {
    if (!mod) return false;
    if (e.code === 'KeyR' && !e.shiftKey && !e.altKey) return C.toggleRulers(), true;
    if (e.code === 'Semicolon') return (e.altKey ? C.toggleGuideLock() : e.shiftKey ? C.toggleSnap() : C.toggleGuides()), true;
    if (e.code === 'Quote' && !e.shiftKey) return C.toggleGrid(), true;
    if (e.code === 'KeyH' && !e.shiftKey && !e.altKey) return C.toggleExtras(), true;
    return false;
  };
}

// ---------------------------------------------------------------- panels

/** Navigator: a thumbnail with the visible area; click or drag to move, slider to zoom. */
export function buildNavigatorPanel(P, stage) {
  const cv = h('canvas.ph-nav', { width: 240, height: 160 });
  const zoom = h('input', { type: 'range', min: -400, max: 500, step: 1 });
  const pct = h('span.ph-nav-pct');
  let thumb = null;
  let thumbRev = -1;
  let raf = 0;
  const geom = () => {
    const doc = P.doc;
    const k = Math.min(cv.width / doc.width, cv.height / doc.height);
    return { k, ox: (cv.width - doc.width * k) / 2, oy: (cv.height - doc.height * k) / 2 };
  };
  const render = () => {
    raf = 0;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    const doc = P.doc;
    if (!doc || !cv.isConnected) return;
    const { k, ox, oy } = geom();
    if (thumbRev !== doc.rev || !thumb) {
      thumb = makeCanvas(Math.max(1, Math.round(doc.width * k)), Math.max(1, Math.round(doc.height * k)));
      const tg = thumb.getContext('2d');
      tg.imageSmoothingQuality = 'high';
      tg.drawImage(P.viewSource ? P.viewSource(k) : P.composite(), 0, 0, thumb.width, thumb.height);
      thumbRev = doc.rev;
    }
    g.drawImage(thumb, ox, oy);
    const r = stage.getBoundingClientRect();
    const v = doc.view;
    g.strokeStyle = '#ff3b3b';
    g.lineWidth = 2;
    g.strokeRect(ox + (-v.x / v.zoom) * k, oy + (-v.y / v.zoom) * k, (r.width / v.zoom) * k, (r.height / v.zoom) * k);
    zoom.value = Math.round(Math.log2(v.zoom) * 100);
    pct.textContent = `${Math.round(v.zoom * 1000) / 10}%`;
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(render);
  };
  let down = false;
  const moveTo = (e) => {
    const doc = P.doc;
    if (!doc) return;
    const b = cv.getBoundingClientRect();
    const { k, ox, oy } = geom();
    const dx = (((e.clientX - b.left) / b.width) * cv.width - ox) / k;
    const dy = (((e.clientY - b.top) / b.height) * cv.height - oy) / k;
    const r = stage.getBoundingClientRect();
    doc.view.auto = false;
    doc.view.x = r.width / 2 - dx * doc.view.zoom;
    doc.view.y = r.height / 2 - dy * doc.view.zoom;
    P.viewChanged();
  };
  cv.addEventListener('pointerdown', (e) => {
    down = true;
    cv.setPointerCapture(e.pointerId);
    moveTo(e);
  });
  cv.addEventListener('pointermove', (e) => down && moveTo(e));
  cv.addEventListener('pointerup', () => { down = false; });
  zoom.addEventListener('input', () => {
    const r = stage.getBoundingClientRect();
    P.setZoom(2 ** (+zoom.value / 100), r.left + r.width / 2, r.top + r.height / 2);
  });
  P.on('redraw', schedule);
  P.on('doc', schedule);
  return h('div.ph-panel.ph-navp', cv, h('div.ph-nav-zoom', zoom, pct));
}

/** Info: colour and position under the cursor, selection and document size. */
export function buildInfoPanel(P) {
  const el = h('div.ph-panel.ph-info');
  let raf = 0;
  let cache = { rev: -1, g: null };
  const render = () => {
    raf = 0;
    const doc = P.doc;
    if (!doc || !el.isConnected) return;
    const p = P.hoverPoint;
    let rgb = null;
    if (p && p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height) {
      if (cache.rev !== doc.rev || cache.doc !== doc) cache = { rev: doc.rev, doc, g: P.composite().getContext('2d', { willReadFrequently: true }) };
      rgb = cache.g.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    }
    const hex = rgb ? `#${[rgb[0], rgb[1], rgb[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}` : '';
    const k = rgb ? 1 - Math.max(rgb[0], rgb[1], rgb[2]) / 255 : 0;
    const cmyk = rgb ? [0, 1, 2].map((i) => (k >= 1 ? 0 : Math.round(((1 - rgb[i] / 255 - k) / (1 - k)) * 100))).concat(Math.round(k * 100)) : null;
    const sb = doc.selection ? P.selBounds?.(doc.selection.canvas) : null;
    const row = (a, b) => h('div.ph-info-row', h('span', a), h('b', b));
    el.replaceChildren(
      h('div.ph-info-grid',
        row('R G B', rgb ? `${rgb[0]}  ${rgb[1]}  ${rgb[2]}` : '—'),
        h('div.ph-info-row', h('span', '16진수'), h('b', rgb ? h('i.ph-info-swatch', { style: { background: hex } }) : null, hex || '—')),
        row('C M Y K', cmyk ? `${cmyk.join('  ')} %` : '—'),
        row('불투명도', rgb ? `${Math.round((rgb[3] / 255) * 100)}%` : '—'),
        row('X, Y', p ? `${Math.floor(p.x)}, ${Math.floor(p.y)} px` : '—'),
        row('선택 영역', sb ? `${sb.w} × ${sb.h} px` : '없음'),
        row('문서', `${doc.width} × ${doc.height} px`),
        row('레이어', doc.active?.name || '—')));
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(render);
  };
  P.on('pointer', schedule);
  P.on('doc', schedule);
  P.on('history', schedule);
  return el;
}

/** Histogram of the visible picture (or the selection): RGB and luminance, with mean and spread. */
export function buildHistogramPanel(P) {
  const cv = h('canvas.ph-histo', { width: 256, height: 110 });
  const mode = h('select', ...[['rgb', 'RGB 색상'], ['lum', '광도'], ['r', '빨강'], ['g', '녹색'], ['b', '파랑']].map(([v, t]) => h('option', { value: v }, t)));
  const stats = h('div.ph-histo-stats');
  let timer = 0;
  let lastRev = -1;
  const render = () => {
    timer = 0;
    const doc = P.doc;
    if (!doc || !cv.isConnected) return;
    lastRev = doc.rev;
    const k = Math.min(1, 512 / Math.max(doc.width, doc.height));
    const w = Math.max(1, Math.round(doc.width * k));
    const hh = Math.max(1, Math.round(doc.height * k));
    const t = makeCanvas(w, hh);
    const tg = t.getContext('2d', { willReadFrequently: true });
    tg.drawImage(P.viewSource ? P.viewSource(k) : P.composite(), 0, 0, w, hh);
    const d = tg.getImageData(0, 0, w, hh).data;
    let sel = null;
    if (doc.selection) {
      const s = makeCanvas(w, hh);
      const sg = s.getContext('2d', { willReadFrequently: true });
      sg.drawImage(doc.selection.canvas, 0, 0, w, hh);
      sel = sg.getImageData(0, 0, w, hh).data;
    }
    const H = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    let n = 0;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8 || (sel && sel[i + 3] < 128)) continue;
      H[0][d[i]]++;
      H[1][d[i + 1]]++;
      H[2][d[i + 2]]++;
      const L = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      H[3][L]++;
      sum += L;
      sq += L * L;
      n++;
    }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 256, 110);
    const m = mode.value;
    const sets = m === 'rgb' ? [[0, 'rgba(255,60,60,.6)'], [1, 'rgba(60,220,60,.6)'], [2, 'rgba(70,120,255,.6)']] : [[{ lum: 3, r: 0, g: 1, b: 2 }[m], m === 'lum' ? 'rgba(220,224,230,.9)' : ['rgba(255,60,60,.9)', 'rgba(60,220,60,.9)', 'rgba(70,120,255,.9)'][{ r: 0, g: 1, b: 2 }[m]]]];
    const peak = Math.max(1, ...sets.flatMap(([c]) => [...H[c]].slice(1, 255)));
    g.globalCompositeOperation = m === 'rgb' ? 'lighter' : 'source-over';
    for (const [c, col] of sets) {
      g.fillStyle = col;
      for (let x = 0; x < 256; x++) {
        const v = Math.min(1, H[c][x] / peak) * 108;
        g.fillRect(x, 110 - v, 1, v);
      }
    }
    g.globalCompositeOperation = 'source-over';
    const mean = n ? sum / n : 0;
    const sd = n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0;
    let med = 0;
    for (let acc = 0; med < 256 && acc + H[3][med] < n / 2; med++) acc += H[3][med];
    stats.textContent = n ? `평균 ${mean.toFixed(1)} · 표준 편차 ${sd.toFixed(1)} · 중간값 ${med} · 픽셀 ${Math.round(n / (k * k)).toLocaleString()}${sel ? ' (선택 영역)' : ''}` : '픽셀이 없습니다';
  };
  // throttle, not debounce: the marching ants redraw several times a second and would keep
  // pushing a debounced update away forever
  const schedule = () => {
    if ((P.doc && P.doc.rev === lastRev) || timer) return;
    timer = setTimeout(render, 250);
  };
  mode.addEventListener('change', () => {
    lastRev = -1;
    render();
  });
  P.on('history', schedule);
  P.on('doc', () => {
    lastRev = -1;
    schedule();
  });
  P.on('redraw', schedule);
  return h('div.ph-panel.ph-histop', h('label.ph-histo-mode', h('span', '채널'), mode), cv, stats);
}
