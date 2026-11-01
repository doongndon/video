// Pen tools (펜, 자유 형태 펜 with 자석, 곡률 펜, anchor tools), path selection tools, path commands
// (패스 칠 / 패스 획 / 선택 영역 만들기 / 작업 패스 만들기 with Photoshop's dialogs) and the vector-mask
// hooks. Paths are edited on a "target": the work path, a saved path, the active layer's vector
// mask, or a path shape layer.

import { h, clamp } from '../util.js';
import { newLayer, makeCanvas, BLEND_MODES } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import * as PT from './paths.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';
import { compositeOnto } from './blend.js';
import { listPatterns, patternCanvas } from './resources.js';
import { toast, promptDialog, openModal } from '../ui/common.js';
import { installShapes2 } from './shapes2.js';

const near = (a, b, tol) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
const reverseSub = (sp) => ({ ...sp, knots: [...sp.knots].reverse().map((k) => ({ ...k, in: k.out, out: k.in })) });

// ---------------------------------------------------------------- targets

/** Bring a shape layer to an unrotated path shape whose local coords map 1:1 to the document. */
function normaliseShape(doc, l) {
  const s = l.shape;
  let sps = PT.shapeToSubpaths(s.type === 'path' ? { ...s, subpaths: PT.mapPath(s.subpaths, ([x, y]) => [x * (s.w / (s.pw || s.w || 1)), y * (s.h / (s.ph || s.h || 1))]) } : s);
  const rot = ((l.rotation || 0) * Math.PI) / 180;
  const cx = s.w / 2;
  const cy = s.h / 2;
  sps = PT.mapPath(sps, ([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [l.x + cx + dx * Math.cos(rot) - dy * Math.sin(rot), l.y + cy + dx * Math.sin(rot) + dy * Math.cos(rot)];
  });
  return sps;
}

function writeShape(doc, l, sps) {
  const b = PT.pathBounds(sps) || { x: l.x, y: l.y, w: 1, h: 1 };
  const w = Math.max(1, b.w);
  const h2 = Math.max(1, b.h);
  // a line keeps its stroke as a path; live properties (corners, arrowheads…) end here, like Photoshop
  const s = { ...l.shape };
  for (const k of ['radii', 'radius', 'sides', 'starRatio', 'smooth', 'smoothIndents', 'indent', 'custom', 'arrowStart', 'arrowEnd', 'arrowW', 'arrowL', 'arrowC']) delete s[k];
  l.shape = { ...s, type: 'path', subpaths: PT.translatePath(sps, -b.x, -b.y), w, h: h2, pw: w, ph: h2 };
  l.x = b.x;
  l.y = b.y;
  l.rotation = 0;
  l._shape = null;
  doc.touch(l);
}

export function installPathTools(P) {
  P.pathTarget = null;
  P.pathSel = { subs: new Set(), knots: new Set() };

  P.resolvePathTarget = () => {
    const doc = P.doc;
    if (!doc) return null;
    const t = P.pathTarget;
    if (t?.kind === 'saved' && doc.paths.some((p) => p.id === t.id)) return t;
    if (t?.kind === 'vmask' && doc.layer(t.layerId)?.vmask) return t;
    if (t?.kind === 'shape' && doc.layer(t.layerId)?.kind === 'shape') return t;
    if (t?.kind === 'work' && doc.workPath) return t;
    return null;
  };
  const targetKey = () => JSON.stringify(P.resolvePathTarget());
  /** The edited path in doc coordinates (empty array when there is none). */
  P.getPath = () => {
    const doc = P.doc;
    const t = P.resolvePathTarget();
    if (!t) return [];
    if (t.kind === 'work') return doc.workPath.subpaths;
    if (t.kind === 'saved') return doc.paths.find((p) => p.id === t.id).subpaths;
    if (t.kind === 'vmask') {
      const vm = doc.layer(t.layerId).vmask;
      return PT.translatePath(vm.subpaths, vm.dx || 0, vm.dy || 0);
    }
    return normaliseShape(doc, doc.layer(t.layerId));
  };
  /** Write the edited path back (no history: callers wrap it). */
  P.setPath = (sps) => {
    const doc = P.doc;
    let t = P.resolvePathTarget();
    if (!t) {
      doc.workPath = { subpaths: [] };
      t = P.pathTarget = { kind: 'work' };
    }
    if (t.kind === 'work') doc.workPath = { subpaths: sps };
    else if (t.kind === 'saved') doc.paths = doc.paths.map((p) => (p.id === t.id ? { ...p, subpaths: sps } : p));
    else if (t.kind === 'vmask') {
      const l = doc.layer(t.layerId);
      l.vmask = { ...l.vmask, subpaths: sps, dx: 0, dy: 0 };
      l._styled = null;
      doc.touch(l);
    } else writeShape(doc, doc.layer(t.layerId), sps);
    doc.rev++;
    P.emit('paths');
    P.redraw();
  };
  /** Pick the target for the active layer when the user starts editing paths. */
  P.autoPathTarget = () => {
    const doc = P.doc;
    const l = doc?.active;
    const t = P.resolvePathTarget();
    if (t) return t;
    if (l?.kind === 'shape') return (P.pathTarget = { kind: 'shape', layerId: l.id });
    if (doc?.workPath) return (P.pathTarget = { kind: 'work' });
    return null;
  };
  P.on('layers', () => {
    // a shape or vector-mask target follows the active layer
    const t = P.pathTarget;
    const l = P.doc?.active;
    if ((t?.kind === 'shape' || t?.kind === 'vmask') && t.layerId !== l?.id) {
      P.pathTarget = l?.kind === 'shape' ? { kind: 'shape', layerId: l.id } : P.doc?.workPath ? { kind: 'work' } : null;
      P.pathSel = { subs: new Set(), knots: new Set() };
      P.penDraw = null;
      P.emit('paths');
    }
  });

  P.shapePathDoc = (l) => normaliseShape(P.doc, l);
  P.setShapePathDoc = (l, sps) => writeShape(P.doc, l, sps);
  P.editVectorMask = (l) => {
    P.pathTarget = { kind: 'vmask', layerId: l.id };
    P.setTool('directSelect');
    P.emit('paths');
  };
  P.vectorMaskCanvas = (l) => {
    if (!l?.vmask) return null;
    return PT.rasterizePath(P.doc.width, P.doc.height, l.vmask.subpaths, { dx: l.vmask.dx || 0, dy: l.vmask.dy || 0, invert: !!l.vmask.invert });
  };

  // ---------------------------------------------------------------- overlay

  const PEN_TOOLS = ['pen', 'freePen', 'curvaturePen', 'addAnchor', 'deleteAnchor', 'convertPoint', 'directSelect'];
  P.drawPathOverlay = (g, { showAll = false, outlineOnly = false } = {}) => {
    const sps = P.getPath();
    if (!sps.length) return;
    const z = P.view.zoom;
    const [ox, oy] = P.toScreen(0, 0);
    g.save();
    g.translate(ox, oy);
    g.scale(z, z);
    g.lineWidth = 1 / z;
    g.strokeStyle = outlineOnly ? 'rgba(61,139,255,.8)' : '#3d8bff';
    g.stroke(PT.toPath2D(sps));
    g.restore();
    if (outlineOnly) return;
    const sel = P.pathSel;
    const box = (x, y, filled) => {
      const [sx, sy] = P.toScreen(x, y);
      g.fillStyle = filled ? '#3d8bff' : '#ffffff';
      g.strokeStyle = '#3d8bff';
      g.fillRect(sx - 3.5, sy - 3.5, 7, 7);
      g.strokeRect(sx - 3.5, sy - 3.5, 7, 7);
    };
    const drawing = P.penDraw || P.curvDraw;
    sps.forEach((sp, si) => {
      const subOn = showAll || sel.subs.has(si);
      sp.knots.forEach((k, ki) => {
        const on = sel.knots.has(`${si}:${ki}`);
        if (on || (P.tool === 'pen' && drawing?.si === si && ki === sp.knots.length - 1)) {
          for (const hnd of [k.in, k.out]) {
            if (near(hnd, k.p, 0.01)) continue;
            const [a, b] = P.toScreen(k.p[0], k.p[1]);
            const [c, d] = P.toScreen(hnd[0], hnd[1]);
            g.strokeStyle = '#3d8bff';
            g.beginPath();
            g.moveTo(a, b);
            g.lineTo(c, d);
            g.stroke();
            g.fillStyle = '#3d8bff';
            g.beginPath();
            g.arc(c, d, 3, 0, Math.PI * 2);
            g.fill();
          }
        }
        if (subOn || on || PEN_TOOLS.includes(P.tool)) {
          if (P.tool === 'curvaturePen' && !k.corner) {
            // the curvature pen shows smooth points as circles, corners as squares
            const [sx, sy] = P.toScreen(k.p[0], k.p[1]);
            g.fillStyle = on ? '#3d8bff' : '#ffffff';
            g.strokeStyle = '#3d8bff';
            g.beginPath();
            g.arc(sx, sy, 4, 0, Math.PI * 2);
            g.fill();
            g.stroke();
          } else box(k.p[0], k.p[1], on || (subOn && P.tool === 'pathSelect'));
        }
      });
    });
  };

  // ---------------------------------------------------------------- hit tests

  const tol = () => 7 / P.view.zoom;
  const hitKnot = (sps, p) => {
    for (let si = sps.length - 1; si >= 0; si--) {
      const ks = sps[si].knots;
      for (let ki = ks.length - 1; ki >= 0; ki--) if (near(ks[ki].p, [p.x, p.y], tol())) return { si, ki };
    }
    return null;
  };
  const hitHandle = (sps, p, any = false) => {
    const keys = any ? sps.flatMap((sp, si) => sp.knots.map((_, ki) => `${si}:${ki}`)) : [...P.pathSel.knots];
    for (const key of keys) {
      const [si, ki] = key.split(':').map(Number);
      const k = sps[si]?.knots[ki];
      if (!k) continue;
      if (near(k.out, [p.x, p.y], tol()) && !near(k.out, k.p, 0.01)) return { si, ki, which: 'out' };
      if (near(k.in, [p.x, p.y], tol()) && !near(k.in, k.p, 0.01)) return { si, ki, which: 'in' };
    }
    return null;
  };
  const hitCtx = makeCanvas(1, 1).getContext('2d');
  const hitSub = (sps, p) => {
    const n = PT.nearestOnPath(sps, p.x, p.y);
    if (n && n.d <= tol()) return n.si;
    // inside a closed subpath counts too (path selection tool)
    for (let si = sps.length - 1; si >= 0; si--) if (sps[si].closed && hitCtx.isPointInPath(PT.toPath2D([sps[si]]), p.x, p.y)) return si;
    return -1;
  };
  const isEnd = (sp, ki) => !sp.closed && (ki === 0 || ki === sp.knots.length - 1);
  /** Shift: the point at a multiple of 45° from an anchor. */
  const constrain = (from, p) => {
    const ang = Math.round(Math.atan2(p.y - from[1], p.x - from[0]) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(p.x - from[0], p.y - from[1]);
    return { x: from[0] + Math.cos(ang) * len, y: from[1] + Math.sin(ang) * len };
  };

  // ---------------------------------------------------------------- tools

  const begin = (label) => ({ before: P.doc.capture(), label });
  const finish = (hh) => {
    if (hh) P.commit(hh.label, hh.before);
  };
  const ensureTargetForDrawing = (mode) => {
    const doc = P.doc;
    if (mode === 'shape') {
      // a new path shape layer, filled with the foreground colour
      const l = newLayer('shape', { name: '모양', shape: { type: 'path', subpaths: [], w: 1, h: 1, pw: 1, ph: 1, fill: P.fg, stroke: null, strokeWidth: 0 } });
      P.addLayer(l);
      P.pathTarget = { kind: 'shape', layerId: l.id, fresh: true };
      return;
    }
    if (!P.resolvePathTarget() || P.pathTarget?.kind === 'shape') {
      if (!doc.workPath) doc.workPath = { subpaths: [] };
      P.pathTarget = { kind: 'work' };
    }
  };
  /** Shift+P cycles the pen tools (Photoshop's order). */
  const PEN_CYCLE = ['pen', 'freePen', 'curvaturePen'];
  const cycleKey = (id, e) => {
    if (e.code === 'KeyP' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      P.setTool(PEN_CYCLE[(PEN_CYCLE.indexOf(id) + 1) % PEN_CYCLE.length]);
      return true;
    }
    return false;
  };
  /** The rubber band: where the next segment would go (dashed). */
  const rubber = (g, from, out, p) => {
    if (!p) return;
    const [a, b] = P.toScreen(from[0], from[1]);
    const [c, d] = P.toScreen(out[0], out[1]);
    const [e, f] = P.toScreen(p.x, p.y);
    g.save();
    g.strokeStyle = 'rgba(61,139,255,.85)';
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(a, b);
    g.bezierCurveTo(c, d, e, f, e, f);
    g.stroke();
    g.restore();
  };

  let directSelect = null;
  const pen = {
    id: 'pen', name: '펜', key: 'P', icon: 'pen', group: 'pen', cursor: 'crosshair',
    options: [['mode', '모드', 'select', null, null, 'path', [['path', '패스'], ['shape', '모양 (레이어)']]], ['op', '패스 작업', 'select', null, null, 'combine', PT.PATH_OPS], ['newLayer', '모양마다 새 레이어', 'bool', null, null, true], ['autoAdd', '자동 추가/삭제', 'bool', null, null, true], ['rubber', '고무 밴드', 'bool', null, null, true]],
    activate() {
      P.autoPathTarget();
    },
    down(E, p, e) {
      // Ctrl: the direct selection tool for as long as it is held (Photoshop)
      if ((e.ctrlKey || e.metaKey) && directSelect) {
        this.temp = directSelect;
        directSelect.down(E, p, e);
        return;
      }
      this.temp = null;
      const o = E.opts('pen');
      let sps = PT.clonePath(P.getPath());
      let d = P.penDraw;
      if (d && (d.key !== targetKey() || !sps[d.si] || sps[d.si].closed)) d = P.penDraw = null;
      if (d) {
        const sp = sps[d.si];
        const last = sp.knots[sp.knots.length - 1];
        // close on the first anchor
        if (sp.knots.length > 1 && near(sp.knots[0].p, [p.x, p.y], tol())) {
          this.h = begin('패스 닫기');
          sp.closed = true;
          P.setPath(sps);
          this.drag = { si: d.si, ki: 0, closing: true, start: p };
          P.penDraw = null;
          return;
        }
        // on the last anchor: a corner from here on (its outgoing handle goes; drag for a new one)
        if (near(last.p, [p.x, p.y], tol())) {
          this.h = begin('기준점 변환');
          last.out = [...last.p];
          last.smooth = false;
          P.setPath(sps);
          this.drag = { si: d.si, ki: sp.knots.length - 1, start: p, outOnly: true };
          return;
        }
        // on the end of another open subpath: join them
        const hk = hitKnot(sps, p);
        if (hk && hk.si !== d.si && isEnd(sps[hk.si], hk.ki)) {
          this.h = begin('패스 연결');
          const other = hk.ki === 0 ? sps[hk.si] : reverseSub(sps[hk.si]);
          sp.knots.push(...other.knots);
          sps.splice(hk.si, 1);
          P.setPath(sps);
          P.penDraw = null;
          finish(this.h);
          this.h = null;
          return;
        }
        const q = e.shiftKey ? constrain(last.p, p) : p;
        this.h = begin('기준점 추가');
        sp.knots.push(PT.knot(q.x, q.y));
        P.setPath(sps);
        this.drag = { si: d.si, ki: sp.knots.length - 1, start: q, alt: e.altKey };
        return;
      }
      if (sps.length && !e.shiftKey) {
        const hk = hitKnot(sps, p);
        // an end of an open subpath: carry on drawing from it
        if (hk && isEnd(sps[hk.si], hk.ki)) {
          if (hk.ki === 0 && sps[hk.si].knots.length > 1) {
            sps[hk.si] = reverseSub(sps[hk.si]);
            P.setPath(sps);
          }
          P.penDraw = { si: hk.si, key: targetKey() };
          P.redraw();
          return;
        }
        // add / delete anchors on an existing path
        if (o.autoAdd && hk) {
          this.h = begin('기준점 삭제');
          sps[hk.si].knots.splice(hk.ki, 1);
          if (sps[hk.si].knots.length < 2) sps.splice(hk.si, 1);
          P.setPath(sps);
          finish(this.h);
          this.h = null;
          return;
        }
        const n = o.autoAdd && PT.nearestOnPath(sps, p.x, p.y);
        if (n && n.d <= tol()) {
          this.h = begin('기준점 추가');
          sps[n.si] = PT.splitSegment(sps[n.si], n.i, n.t);
          P.setPath(sps);
          finish(this.h);
          this.h = null;
          return;
        }
      }
      // a new subpath
      this.h = begin('펜');
      if (o.mode === 'shape' && (P.pathTarget?.kind !== 'shape' || o.newLayer)) ensureTargetForDrawing('shape');
      else if (o.mode !== 'shape') ensureTargetForDrawing('path');
      sps = PT.clonePath(P.getPath());
      if (P.pathTarget?.fresh) sps = [];
      sps.push({ closed: false, op: sps.length ? o.op : 'combine', knots: [PT.knot(p.x, p.y)] });
      P.setPath(sps);
      P.penDraw = { si: sps.length - 1, key: targetKey() };
      this.drag = { si: sps.length - 1, ki: 0, start: p };
    },
    move(E, p, e) {
      if (this.temp) return this.temp.move(E, p, e);
      const dr = this.drag;
      if (!dr) return undefined;
      const sps = PT.clonePath(P.getPath());
      const k = sps[dr.si]?.knots[dr.ki];
      if (!k) return undefined;
      if (Math.hypot(p.x - dr.start.x, p.y - dr.start.y) < 2 / P.view.zoom) return undefined;
      // drag: symmetric handles (Alt: only the outgoing one; Shift: 45° steps)
      const q = e.shiftKey ? constrain(k.p, p) : p;
      const one = e.altKey || dr.alt || dr.outOnly;
      k.out = [q.x, q.y];
      if (!one) k.in = [2 * k.p[0] - q.x, 2 * k.p[1] - q.y];
      k.smooth = !one;
      if (dr.closing) [k.in, k.out] = [k.out, k.in];
      P.setPath(sps);
      return undefined;
    },
    up(E, p, e) {
      if (this.temp) {
        const t = this.temp;
        this.temp = null;
        return t.up(E, p, e);
      }
      this.drag = null;
      if (this.h) finish(this.h);
      this.h = null;
      return undefined;
    },
    hover() {
      if (P.penDraw) P.overlay();
    },
    onKey(E, e) {
      if (cycleKey('pen', e)) return true;
      if ((e.key === 'Backspace' || e.key === 'Delete') && P.penDraw && P.penDraw.key === targetKey()) {
        // while drawing: take back the last anchor
        const sps = PT.clonePath(P.getPath());
        const sp = sps[P.penDraw.si];
        if (!sp) return false;
        const hh = begin('기준점 삭제');
        sp.knots.pop();
        if (!sp.knots.length) {
          sps.splice(P.penDraw.si, 1);
          P.penDraw = null;
        }
        P.setPath(sps);
        finish(hh);
        return true;
      }
      if ((e.key === 'Enter' || e.key === 'Escape') && P.penDraw) {
        P.penDraw = null;
        if (P.pathTarget?.fresh) delete P.pathTarget.fresh;
        P.redraw();
        return true;
      }
      return false;
    },
    deactivate() {
      P.penDraw = null;
    },
    overlay(E, g) {
      P.drawPathOverlay(g);
      const d = P.penDraw;
      if (!d || !E.opts('pen').rubber || this.drag || d.key !== targetKey()) return;
      const sp = P.getPath()[d.si];
      const last = sp?.knots[sp.knots.length - 1];
      if (last && !sp.closed) rubber(g, last.p, last.out, P.hoverPoint);
    },
  };

  // ---- freeform pen (with 자석: snaps to edges like the magnetic lasso)
  const addSubpath = (sp, mode, op, label, before) => {
    ensureTargetForDrawing(mode === 'shape' ? 'shape' : 'path');
    const sps = P.pathTarget?.fresh ? [] : PT.clonePath(P.getPath());
    sp.op = sps.length ? op : 'combine';
    sps.push(sp);
    P.setPath(sps);
    if (P.pathTarget?.fresh) delete P.pathTarget.fresh;
    P.commit(label, before);
  };
  const freePen = {
    id: 'freePen', name: '자유 형태 펜', key: 'P', icon: 'freePen', group: 'pen', cursor: 'crosshair',
    options: [['mode', '모드', 'select', null, null, 'path', [['path', '패스'], ['shape', '모양 (새 레이어)']]], ['op', '패스 작업', 'select', null, null, 'combine', PT.PATH_OPS], ['fit', '곡선 맞춤 (px)', 'range', 1, 10, 2], ['magnetic', '자석', 'bool', null, null, false], ['width', '폭 (px)', 'range', 1, 40, 10], ['contrast', '대비 (%)', 'range', 1, 100, 10], ['frequency', '빈도', 'range', 0, 100, 57]],
    wire() {
      const o = P.opts('freePen');
      const key = `${P.doc.id}:${P.doc.rev}:${o.contrast}`;
      if (this.lw?.key !== key) {
        const c = P.composite();
        this.lw = new SX.LiveWire(SX.pixelsOf(c), c.width, c.height, { contrast: o.contrast });
        this.lw.key = key;
      }
      return this.lw;
    },
    down(E, p) {
      const o = E.opts('freePen');
      if (o.magnetic) {
        const m = this.m;
        if (!m) {
          const lw = this.wire();
          const s = lw.snap(p.x, p.y, o.width);
          lw.setAnchor(s[0], s[1], 200);
          this.m = { pts: [s], anchors: [0], live: null, lw, before: P.doc.capture() };
          P.overlay();
          return;
        }
        const first = m.pts[0];
        if (m.pts.length > 2 && Math.hypot(p.x - first[0], p.y - first[1]) * P.view.zoom < 10) {
          this.finishMagnetic(true);
          return;
        }
        this.track(p);
        this.commitLive();
        P.overlay();
        return;
      }
      this.pts = [[p.x, p.y]];
      this.before = P.doc.capture();
    },
    track(p) {
      const m = this.m;
      const o = P.opts('freePen');
      const s = m.lw.snap(p.x, p.y, o.width);
      let path = m.lw.path(s[0], s[1]);
      if (!path) {
        if (m.live?.length > 1) {
          this.commitLive();
          path = m.lw.path(s[0], s[1]);
        }
        if (!path) path = [m.pts[m.pts.length - 1], s];
      }
      m.live = path;
      const spacing = 12 + (100 - (o.frequency ?? 57)) * 1.4;
      if (SX.polyLength(path) > spacing) this.commitLive();
    },
    commitLive() {
      const m = this.m;
      if (!m.live || m.live.length < 2) return;
      for (const q of m.live.slice(1)) m.pts.push(q);
      m.live = null;
      m.anchors.push(m.pts.length - 1);
      const a = m.pts[m.pts.length - 1];
      m.lw.setAnchor(a[0], a[1], 200);
    },
    finishMagnetic(close) {
      const m = this.m;
      this.m = null;
      if (!m) return;
      if (m.live) for (const q of m.live.slice(1)) m.pts.push(q);
      if (m.pts.length < 3) {
        P.overlay();
        return;
      }
      const o = P.opts('freePen');
      const sp = PT.fitFreehand(m.pts.map(([x, y]) => [x + 0.5, y + 0.5]), o.fit, close);
      if (!sp) return;
      addSubpath(sp, o.mode, o.op, '자유 형태 펜 (자석)', m.before);
    },
    move(E, p) {
      if (this.m) {
        this.track(p);
        P.overlay();
        return;
      }
      if (!this.pts) return;
      this.pts.push([p.x, p.y]);
      P.redraw();
    },
    hover(E, p) {
      if (this.m) {
        this.track(p);
        P.overlay();
      }
    },
    dblclick() {
      if (this.m) this.finishMagnetic(false);
    },
    up(E) {
      if (this.m) return;
      const pts = this.pts;
      this.pts = null;
      if (!pts || pts.length < 3) return;
      const o = E.opts('freePen');
      const closed = Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 12 / P.view.zoom;
      const sp = PT.fitFreehand(pts, o.fit, closed);
      if (!sp) return;
      addSubpath(sp, o.mode, o.op, '자유 형태 펜', this.before);
    },
    onKey(E, e) {
      if (cycleKey('freePen', e)) return true;
      if (!this.m) return false;
      if (e.key === 'Enter') this.finishMagnetic(false);
      else if (e.key === 'Escape') {
        this.m = null;
        P.overlay();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        const m = this.m;
        m.anchors.pop();
        if (!m.anchors.length) {
          this.m = null;
        } else {
          const last = m.anchors[m.anchors.length - 1];
          m.pts.length = last + 1;
          m.live = null;
          m.lw.setAnchor(m.pts[last][0], m.pts[last][1], 200);
        }
        P.overlay();
      } else return false;
      return true;
    },
    deactivate() {
      this.m = null;
      this.lw = null;
    },
    overlay(E, g) {
      P.drawPathOverlay(g);
      const line = (pts, color, dash = []) => {
        if (!pts || pts.length < 2) return;
        g.save();
        g.strokeStyle = color;
        g.setLineDash(dash);
        g.beginPath();
        pts.forEach(([x, y], i) => {
          const [sx, sy] = P.toScreen(x, y);
          if (i) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        g.stroke();
        g.restore();
      };
      if (this.m) {
        line(this.m.pts, '#3d8bff');
        line(this.m.live, '#3d8bff', [4, 3]);
        for (const i of this.m.anchors) {
          const [sx, sy] = P.toScreen(this.m.pts[i][0], this.m.pts[i][1]);
          g.fillStyle = '#fff';
          g.strokeStyle = '#3d8bff';
          g.fillRect(sx - 3, sy - 3, 6, 6);
          g.strokeRect(sx - 3, sy - 3, 6, 6);
        }
        return;
      }
      line(this.pts, '#3d8bff');
    },
  };

  // ---- curvature pen: click points, the curve bends smoothly through them
  /** Smooth handles through the curvature pen's points (corners stay straight). */
  const smoothCurv = (sp) => {
    const ks = sp.knots;
    const n = ks.length;
    for (let i = 0; i < n; i++) {
      const k = ks[i];
      if (!k.curv) continue;
      if (k.corner) {
        k.in = [...k.p];
        k.out = [...k.p];
        k.smooth = false;
        continue;
      }
      const prev = i > 0 ? ks[i - 1] : sp.closed ? ks[n - 1] : null;
      const next = i < n - 1 ? ks[i + 1] : sp.closed ? ks[0] : null;
      if (!prev || !next) {
        // an end: the handle points along the curve towards its neighbour
        const o = prev || next;
        if (!o) {
          k.in = [...k.p];
          k.out = [...k.p];
          continue;
        }
        const far = prev ? (i > 1 ? ks[i - 2] : null) : (i + 2 < n ? ks[i + 2] : null);
        const tx = o.p[0] - k.p[0] + (far ? (o.p[0] - far.p[0]) * 0.25 : 0);
        const ty = o.p[1] - k.p[1] + (far ? (o.p[1] - far.p[1]) * 0.25 : 0);
        const L = Math.hypot(tx, ty) || 1;
        const d = Math.hypot(o.p[0] - k.p[0], o.p[1] - k.p[1]) * 0.38;
        const hnd = [k.p[0] + (tx / L) * d, k.p[1] + (ty / L) * d];
        if (prev) {
          k.in = hnd;
          k.out = [...k.p];
        } else {
          k.out = hnd;
          k.in = [...k.p];
        }
        k.smooth = false;
        continue;
      }
      const dx = next.p[0] - prev.p[0];
      const dy = next.p[1] - prev.p[1];
      const L = Math.hypot(dx, dy) || 1;
      const dp = Math.hypot(k.p[0] - prev.p[0], k.p[1] - prev.p[1]) * 0.38;
      const dn = Math.hypot(next.p[0] - k.p[0], next.p[1] - k.p[1]) * 0.38;
      k.in = [k.p[0] - (dx / L) * dp, k.p[1] - (dy / L) * dp];
      k.out = [k.p[0] + (dx / L) * dn, k.p[1] + (dy / L) * dn];
      k.smooth = true;
    }
    return sp;
  };
  const curvKnot = (x, y) => ({ p: [x, y], in: [x, y], out: [x, y], smooth: true, curv: true });
  const curvaturePen = {
    id: 'curvaturePen', name: '곡률 펜', key: 'P', icon: 'curvaturePen', group: 'pen', cursor: 'crosshair',
    options: [['mode', '모드', 'select', null, null, 'path', [['path', '패스'], ['shape', '모양 (레이어)']]], ['op', '패스 작업', 'select', null, null, 'combine', PT.PATH_OPS]],
    activate() {
      P.autoPathTarget();
    },
    down(E, p, e) {
      const o = E.opts('curvaturePen');
      let sps = PT.clonePath(P.getPath());
      let d = P.curvDraw;
      if (d && (d.key !== targetKey() || !sps[d.si] || sps[d.si].closed)) d = P.curvDraw = null;
      const hk = sps.length ? hitKnot(sps, p) : null;
      if (d) {
        const sp = sps[d.si];
        if (sp.knots.length > 2 && hk?.si === d.si && hk.ki === 0) {
          this.h = begin('패스 닫기');
          sp.closed = true;
          smoothCurv(sp);
          P.setPath(sps);
          finish(this.h);
          this.h = null;
          P.curvDraw = null;
          return;
        }
        if (hk) {
          this.drag = { si: hk.si, ki: hk.ki, start: p, h: begin('기준점 이동') };
          P.pathSel = { subs: new Set(), knots: new Set([`${hk.si}:${hk.ki}`]) };
          return;
        }
        const k = curvKnot(p.x, p.y);
        if (e.altKey) k.corner = true;
        const hh = begin('기준점 추가');
        sp.knots.push(k);
        smoothCurv(sp);
        P.setPath(sps);
        this.drag = { si: d.si, ki: sp.knots.length - 1, start: p, h: hh, add: true };
        P.pathSel = { subs: new Set(), knots: new Set([`${d.si}:${sp.knots.length - 1}`]) };
        return;
      }
      if (hk) {
        // an end of an open subpath: carry on from it; any other point: drag it
        if (isEnd(sps[hk.si], hk.ki) && sps[hk.si].knots.length > 1 && !(e.ctrlKey || e.metaKey)) {
          if (hk.ki === 0) {
            sps[hk.si] = reverseSub(sps[hk.si]);
            P.setPath(sps);
          }
          P.curvDraw = { si: hk.si, key: targetKey() };
          this.drag = { si: hk.si, ki: sps[hk.si].knots.length - 1, start: p, h: begin('기준점 이동') };
          return;
        }
        this.drag = { si: hk.si, ki: hk.ki, start: p, h: begin('기준점 이동') };
        P.pathSel = { subs: new Set(), knots: new Set([`${hk.si}:${hk.ki}`]) };
        return;
      }
      const n = sps.length && PT.nearestOnPath(sps, p.x, p.y);
      if (n && n.d <= tol()) {
        // on a segment: a new point there
        const hh = begin('기준점 추가');
        const sp = PT.splitSegment(sps[n.si], n.i, n.t);
        const nk = sp.knots[n.i + 1];
        Object.assign(nk, { curv: true, corner: false });
        sps[n.si] = smoothCurvLocal(sp, n.i + 1);
        P.setPath(sps);
        this.drag = { si: n.si, ki: n.i + 1, start: p, h: hh, add: true };
        return;
      }
      // a new subpath
      const hh = begin('곡률 펜');
      if (o.mode === 'shape') ensureTargetForDrawing('shape');
      else ensureTargetForDrawing('path');
      sps = P.pathTarget?.fresh ? [] : PT.clonePath(P.getPath());
      const k = curvKnot(p.x, p.y);
      sps.push({ closed: false, op: sps.length ? o.op : 'combine', knots: [k] });
      P.setPath(sps);
      if (P.pathTarget?.fresh) delete P.pathTarget.fresh;
      P.curvDraw = { si: sps.length - 1, key: targetKey() };
      this.drag = { si: sps.length - 1, ki: 0, start: p, h: hh, add: true };
    },
    move(E, p) {
      const dr = this.drag;
      if (!dr) return;
      if (!dr.moved && Math.hypot(p.x - dr.start.x, p.y - dr.start.y) < 2 / P.view.zoom) return;
      dr.moved = true;
      const sps = PT.clonePath(P.getPath());
      const sp = sps[dr.si];
      const k = sp?.knots[dr.ki];
      if (!k) return;
      const dx = p.x - k.p[0];
      const dy = p.y - k.p[1];
      k.p = [p.x, p.y];
      k.in = [k.in[0] + dx, k.in[1] + dy];
      k.out = [k.out[0] + dx, k.out[1] + dy];
      if (!k.curv) k.curv = true;
      sps[dr.si] = smoothCurvLocal(sp, dr.ki);
      P.setPath(sps);
    },
    up() {
      const dr = this.drag;
      this.drag = null;
      // a press on a point without moving it changes nothing
      if (dr?.h && (dr.add || dr.moved)) finish(dr.h);
    },
    dblclick(E, p) {
      // a double-click turns a point into a corner (or back)
      const sps = PT.clonePath(P.getPath());
      const hk = hitKnot(sps, p);
      if (!hk) return;
      const hh = begin('기준점 변환');
      const k = sps[hk.si].knots[hk.ki];
      k.curv = true;
      k.corner = !k.corner;
      sps[hk.si] = smoothCurvLocal(sps[hk.si], hk.ki);
      P.setPath(sps);
      finish(hh);
    },
    hover() {
      if (P.curvDraw) P.overlay();
    },
    onKey(E, e) {
      if (cycleKey('curvaturePen', e)) return true;
      if ((e.key === 'Enter' || e.key === 'Escape') && P.curvDraw) {
        P.curvDraw = null;
        P.redraw();
        return true;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const keys = [...P.pathSel.knots];
        if (!keys.length) return false;
        const sps = PT.clonePath(P.getPath());
        const hh = begin('기준점 삭제');
        const rm = new Set(keys);
        const out = sps.map((sp, si) => smoothCurv({ ...sp, knots: sp.knots.filter((_, ki) => !rm.has(`${si}:${ki}`)) })).filter((sp) => sp.knots.length >= 1);
        P.pathSel = { subs: new Set(), knots: new Set() };
        P.curvDraw = null;
        P.setPath(out);
        finish(hh);
        return true;
      }
      return false;
    },
    deactivate() {
      P.curvDraw = null;
    },
    overlay(E, g) {
      P.drawPathOverlay(g);
      const d = P.curvDraw;
      const hp = P.hoverPoint;
      if (!d || !hp || this.drag || d.key !== targetKey()) return;
      const sp = P.getPath()[d.si];
      if (!sp || sp.closed) return;
      // the curve the next click would make
      const tmp = smoothCurv({ ...PT.clonePath([sp])[0], knots: [...PT.clonePath([sp])[0].knots, curvKnot(hp.x, hp.y)] });
      const n = tmp.knots.length;
      const z = P.view.zoom;
      const [ox, oy] = P.toScreen(0, 0);
      g.save();
      g.translate(ox, oy);
      g.scale(z, z);
      g.lineWidth = 1 / z;
      g.setLineDash([4 / z, 3 / z]);
      g.strokeStyle = 'rgba(61,139,255,.85)';
      g.stroke(PT.toPath2D([{ closed: false, knots: tmp.knots.slice(Math.max(0, n - 3)) }]));
      g.restore();
    },
  };
  /** Re-smooth the points around one that changed (only curvature-pen points move their handles). */
  const smoothCurvLocal = (sp, ki) => {
    const n = sp.knots.length;
    const mark = new Set([ki - 1, ki, ki + 1].map((i) => (sp.closed ? (i + n) % n : i)).filter((i) => i >= 0 && i < n));
    const saved = sp.knots.map((k, i) => (mark.has(i) ? null : { in: k.in, out: k.out, smooth: k.smooth }));
    smoothCurv(sp);
    sp.knots.forEach((k, i) => {
      if (saved[i] && !mark.has(i)) Object.assign(k, saved[i]);
    });
    return sp;
  };

  const anchorTool = (id, name, icon, fn) => ({
    id, name, key: null, icon, group: 'pen', cursor: 'crosshair', options: [],
    activate() {
      P.autoPathTarget();
    },
    down(E, p, e) {
      const sps = PT.clonePath(P.getPath());
      if (!sps.length) return;
      const hh = begin(name);
      if (fn(sps, p, e, this) !== false) {
        P.setPath(sps);
        if (!this.drag) finish(hh);
        else this.h = hh;
      }
    },
    move(E, p, e) {
      if (!this.drag) return;
      const sps = PT.clonePath(P.getPath());
      const k = sps[this.drag.si]?.knots[this.drag.ki];
      if (!k) return;
      if (this.drag.which) {
        // one handle on its own (the point becomes a corner)
        k[this.drag.which] = [p.x, p.y];
        k.smooth = false;
      } else {
        k.out = [p.x, p.y];
        if (!e.altKey) k.in = [2 * k.p[0] - p.x, 2 * k.p[1] - p.y];
        k.smooth = !e.altKey;
      }
      k.curv = false;
      P.setPath(sps);
    },
    up() {
      if (this.drag && this.h) finish(this.h);
      this.drag = null;
      this.h = null;
    },
    overlay(E, g) {
      P.drawPathOverlay(g, { showAll: true });
    },
  });
  const addAnchor = anchorTool('addAnchor', '기준점 추가', 'addAnchor', (sps, p, e, self) => {
    const n = PT.nearestOnPath(sps, p.x, p.y);
    if (!n || n.d > tol()) return false;
    sps[n.si] = PT.splitSegment(sps[n.si], n.i, n.t);
    // Photoshop: drag right away to shape the new point's handles
    self.drag = { si: n.si, ki: n.i + 1 };
    P.pathSel = { subs: new Set(), knots: new Set([`${n.si}:${n.i + 1}`]) };
    return true;
  });
  const deleteAnchor = anchorTool('deleteAnchor', '기준점 삭제', 'deleteAnchor', (sps, p) => {
    const hk = hitKnot(sps, p);
    if (!hk) return false;
    sps[hk.si].knots.splice(hk.ki, 1);
    if (sps[hk.si].knots.length < 2) sps.splice(hk.si, 1);
    return true;
  });
  const convertPoint = anchorTool('convertPoint', '기준점 변환', 'convertPoint', (sps, p, e, self) => {
    // a handle: drag it on its own (breaks a smooth point)
    const hh = hitHandle(sps, p, true);
    if (hh) {
      self.drag = { si: hh.si, ki: hh.ki, which: hh.which };
      return true;
    }
    const hk = hitKnot(sps, p);
    if (!hk) return false;
    const k = sps[hk.si].knots[hk.ki];
    P.pathSel = { subs: new Set(), knots: new Set([`${hk.si}:${hk.ki}`]) };
    if (!near(k.in, k.p, 0.01) || !near(k.out, k.p, 0.01)) {
      // smooth → corner
      k.in = [...k.p];
      k.out = [...k.p];
      k.smooth = false;
      k.curv = false;
      return true;
    }
    // corner → smooth: drag out handles
    self.drag = { si: hk.si, ki: hk.ki };
    return true;
  });

  const nudgeKeys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const selectTool = (id, name, icon, direct) => ({
    id, name, key: 'A', icon, group: 'pathSelect', cursor: 'default',
    options: direct ? [] : [['op', '패스 작업 (고른 패스)', 'select', null, null, 'combine', PT.PATH_OPS]],
    activate() {
      P.autoPathTarget();
      P.redraw();
    },
    down(E, p, e) {
      this.corner = !direct && !!P.liveCorners?.down(p, e);
      if (this.corner) return;
      let sps = P.getPath();
      // clicking a path shape layer on the canvas targets it
      if (!sps.length || (hitSub(sps, p) < 0 && !hitKnot(sps, p) && !(direct && hitHandle(sps, p)))) {
        const hit = P.layerAt(p, (l) => l.kind === 'shape');
        if (hit) {
          P.selectLayer(hit.id);
          P.pathTarget = { kind: 'shape', layerId: hit.id };
          sps = P.getPath();
        }
      }
      const sel = P.pathSel;
      if (!sps.length) {
        this.d = { kind: 'marquee', a: p, b: p, add: e.shiftKey };
        return;
      }
      this.h = begin(direct ? '기준점 이동' : '패스 이동');
      if (direct) {
        const hh = hitHandle(sps, p);
        if (hh) {
          this.d = { kind: 'handle', ...hh, a: p, orig: PT.clonePath(sps), alt: e.altKey };
          return;
        }
        const hk = hitKnot(sps, p);
        if (hk) {
          const key = `${hk.si}:${hk.ki}`;
          if (e.shiftKey) {
            if (sel.knots.has(key)) sel.knots.delete(key);
            else sel.knots.add(key);
          } else if (!sel.knots.has(key)) sel.knots = new Set([key]);
          this.d = { kind: 'knots', a: p, orig: PT.clonePath(sps) };
          P.redraw();
          return;
        }
        const n = PT.nearestOnPath(sps, p.x, p.y);
        if (n && n.d <= tol()) {
          // a segment: its two anchors
          const sp = sps[n.si];
          sel.knots = new Set([`${n.si}:${n.i}`, `${n.si}:${(n.i + 1) % sp.knots.length}`]);
          this.d = { kind: 'knots', a: p, orig: PT.clonePath(sps) };
          P.redraw();
          return;
        }
        // empty canvas: drag a box round the anchors to select
        this.h = null;
        if (!e.shiftKey) sel.knots = new Set();
        this.d = { kind: 'marquee', a: p, b: p, add: e.shiftKey };
        P.redraw();
        return;
      }
      const si = hitSub(sps, p);
      if (si < 0) {
        this.h = null;
        if (!e.shiftKey) sel.subs = new Set();
        this.d = { kind: 'marquee', a: p, b: p, add: e.shiftKey };
        P.redraw();
        return;
      }
      if (e.shiftKey) {
        if (sel.subs.has(si)) sel.subs.delete(si);
        else sel.subs.add(si);
      } else if (!sel.subs.has(si)) sel.subs = new Set([si]);
      if (e.altKey) {
        // Alt+drag: a copy of the selected subpaths
        const copies = [...sel.subs].map((i) => PT.clonePath([sps[i]])[0]);
        sps = [...PT.clonePath(sps), ...copies];
        sel.subs = new Set(copies.map((_, i) => sps.length - copies.length + i));
        P.setPath(sps);
        this.h.label = '패스 복제';
      }
      this.d = { kind: 'subs', a: p, orig: PT.clonePath(sps), moved: !!e.altKey };
      P.redraw();
    },
    move(E, p, e) {
      if (this.corner) {
        P.liveCorners.move(p);
        return;
      }
      const d = this.d;
      if (!d) return;
      if (d.kind === 'marquee') {
        d.b = p;
        P.overlay();
        return;
      }
      let dx = p.x - d.a.x;
      let dy = p.y - d.a.y;
      if (e.shiftKey && d.kind !== 'handle') {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      d.moved = d.moved || Math.hypot(dx, dy) > 0;
      const sps = PT.clonePath(d.orig);
      const sel = P.pathSel;
      if (d.kind === 'subs') {
        for (const si of sel.subs) if (sps[si]) sps[si] = PT.translatePath([sps[si]], dx, dy)[0];
      } else if (d.kind === 'knots') {
        for (const key of sel.knots) {
          const [si, ki] = key.split(':').map(Number);
          const k = sps[si]?.knots[ki];
          if (!k) continue;
          k.p = [k.p[0] + dx, k.p[1] + dy];
          k.in = [k.in[0] + dx, k.in[1] + dy];
          k.out = [k.out[0] + dx, k.out[1] + dy];
        }
      } else {
        const k = sps[d.si].knots[d.ki];
        k[d.which] = [p.x, p.y];
        k.curv = false;
        if (k.smooth && !d.alt && !e.altKey) {
          // keep the opposite handle in line (its length stays)
          const other = d.which === 'out' ? 'in' : 'out';
          const len = Math.hypot(k[other][0] - k.p[0], k[other][1] - k.p[1]);
          const vx = k.p[0] - p.x;
          const vy = k.p[1] - p.y;
          const vl = Math.hypot(vx, vy) || 1;
          k[other] = [k.p[0] + (vx / vl) * len, k.p[1] + (vy / vl) * len];
        } else k.smooth = false;
      }
      P.setPath(sps);
    },
    up() {
      if (this.corner) {
        this.corner = false;
        P.liveCorners.up();
        return;
      }
      const d = this.d;
      if (d?.kind === 'marquee') {
        const x0 = Math.min(d.a.x, d.b.x);
        const y0 = Math.min(d.a.y, d.b.y);
        const x1 = Math.max(d.a.x, d.b.x);
        const y1 = Math.max(d.a.y, d.b.y);
        const sps = P.getPath();
        const inside = ([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        if (direct) {
          const keys = d.add ? new Set(P.pathSel.knots) : new Set();
          sps.forEach((sp, si) => sp.knots.forEach((k, ki) => {
            if (inside(k.p)) keys.add(`${si}:${ki}`);
          }));
          P.pathSel.knots = keys;
        } else {
          const subs = d.add ? new Set(P.pathSel.subs) : new Set();
          sps.forEach((sp, si) => {
            if (sp.knots.some((k) => inside(k.p))) subs.add(si);
          });
          P.pathSel.subs = subs;
        }
        this.d = null;
        P.redraw();
        return;
      }
      if (d && this.h && d.moved) finish(this.h);
      this.d = null;
      this.h = null;
    },
    onKey(E, e) {
      const sps = PT.clonePath(P.getPath());
      const sel = P.pathSel;
      const has = direct ? sel.knots.size : sel.subs.size;
      if (nudgeKeys[e.key] && sps.length && has) {
        // arrow keys nudge the selected anchors / paths (Shift: 10 px)
        const [ux, uy] = nudgeKeys[e.key];
        const s = e.shiftKey ? 10 : 1;
        const hh = begin(direct ? '기준점 이동' : '패스 이동');
        if (direct) {
          for (const key of sel.knots) {
            const [si, ki] = key.split(':').map(Number);
            const k = sps[si]?.knots[ki];
            if (!k) continue;
            for (const f of ['p', 'in', 'out']) k[f] = [k[f][0] + ux * s, k[f][1] + uy * s];
          }
        } else for (const si of sel.subs) if (sps[si]) sps[si] = PT.translatePath([sps[si]], ux * s, uy * s)[0];
        P.setPath(sps);
        finish(hh);
        return true;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
      if (!sps.length || (!sel.subs.size && !sel.knots.size)) return false;
      const hh = begin('패스 삭제');
      let out = sps;
      if (direct && sel.knots.size) {
        const rm = new Set(sel.knots);
        out = sps.map((sp, si) => ({ ...sp, knots: sp.knots.filter((_, ki) => !rm.has(`${si}:${ki}`)) })).filter((sp) => sp.knots.length >= 2);
      } else out = sps.filter((_, si) => !sel.subs.has(si));
      P.pathSel = { subs: new Set(), knots: new Set() };
      P.setPath(out);
      finish(hh);
      return true;
    },
    overlay(E, g) {
      P.drawPathOverlay(g);
      if (!direct) P.liveCorners?.draw(g);
      const d = this.d;
      if (d?.kind === 'marquee') {
        const [x1, y1] = P.toScreen(d.a.x, d.a.y);
        const [x2, y2] = P.toScreen(d.b.x, d.b.y);
        g.save();
        g.strokeStyle = '#3d8bff';
        g.fillStyle = 'rgba(61,139,255,.12)';
        g.setLineDash([3, 3]);
        g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        g.strokeRect(Math.min(x1, x2) + 0.5, Math.min(y1, y2) + 0.5, Math.abs(x2 - x1), Math.abs(y2 - y1));
        g.restore();
      }
    },
  });
  const pathSelect = selectTool('pathSelect', '패스 선택', 'pathSelect', false);
  directSelect = selectTool('directSelect', '직접 선택', 'directSelect', true);

  const pathButtons = (PP) => [h('span.ph-opt', '만들기:'),
    h('button.small', { onclick: () => PP.cmd.pathToSelection() }, '선택 영역'),
    h('button.small', { onclick: () => PP.cmd.addVectorMask('path') }, '마스크'),
    h('button.small', { onclick: () => PP.cmd.pathToShape?.() }, '모양'),
    PP.doc?.workPath ? h('button.small', { onclick: () => PP.cmd.savePath() }, '패스 저장') : null];
  curvaturePen.optionButtons = pathButtons;

  for (const t of [pen, freePen, curvaturePen, addAnchor, deleteAnchor, convertPoint, pathSelect, directSelect]) {
    TOOLS.push(t);
    TOOL_BY_ID[t.id] = t;
  }
  const ti = TOOL_GROUPS.findIndex((g) => g.includes('text'));
  TOOL_GROUPS.splice(ti, 0, ['pen', 'freePen', 'curvaturePen', 'addAnchor', 'deleteAnchor', 'convertPoint']);
  TOOL_GROUPS.splice(ti + 2, 0, ['pathSelect', 'directSelect']);

  // ---------------------------------------------------------------- commands

  const C = P.cmd;
  const W = () => P.doc.width;
  const H = () => P.doc.height;
  /** Make Selection (Ctrl+Enter): mode new | add | sub | int, feather in px, anti-aliased. */
  C.pathToSelection = (mode = 'new', feather = 0, antiAlias = true) => {
    const sps = P.getPath();
    if (!sps.length) return toast('선택 영역으로 만들 패스가 없습니다');
    P.run('패스를 선택 영역으로', () => {
      let c = PT.rasterizePath(W(), H(), sps, { feather });
      if (!antiAlias && !feather) c = hardEdge(c);
      const doc = P.doc;
      if (mode === 'new' || !doc.selection) doc.selection = { canvas: c };
      else doc.selection = SEL.combine(doc, c, mode);
    });
    return undefined;
  };
  const hardEdge = (c) => {
    const g = c.getContext('2d');
    const img = g.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    g.putImageData(img, 0, 0);
    return c;
  };
  /**
   * 모양 구성 요소 병합 (Merge Shape Components): the closed components, with their path operations,
   * become one outline (traced at up to 4× so curves stay close). Open subpaths are kept.
   */
  C.mergeShapeComponents = () => {
    const sps = P.getPath();
    const closed = sps.filter((sp) => sp.closed && sp.knots.length > 1);
    if (closed.length < 2) return toast('병합할 모양 구성 요소가 두 개 이상 있어야 합니다');
    const b = PT.pathBounds(closed);
    if (!b || b.w < 1 || b.h < 1) return undefined;
    const k = clamp(Math.sqrt(1.4e6 / (b.w * b.h)), 0.25, 4);
    const pad = 2;
    const scaled = PT.mapPath(closed, ([x, y]) => [(x - b.x) * k + pad, (y - b.y) * k + pad]);
    const mask = PT.rasterizePath(Math.ceil(b.w * k) + pad * 2, Math.ceil(b.h * k) + pad * 2, scaled);
    const merged = PT.mapPath(PT.pathFromMask(mask, 1), ([x, y]) => [(x - pad) / k + b.x, (y - pad) / k + b.y]);
    if (!merged.length) return toast('남는 모양이 없습니다');
    const hh = begin('모양 구성 요소 병합');
    P.pathSel = { subs: new Set(), knots: new Set() };
    P.setPath([...merged, ...sps.filter((sp) => !sp.closed)]);
    finish(hh);
    return undefined;
  };
  C.selectionToPath = (tolerance = 2) => {
    const doc = P.doc;
    if (!doc?.selection) return toast('먼저 선택 영역을 만드세요');
    P.run('작업 패스 만들기', () => {
      doc.workPath = { subpaths: PT.pathFromMask(doc.selection.canvas, tolerance) };
      P.pathTarget = { kind: 'work' };
    });
    P.emit('paths');
    return undefined;
  };
  /**
   * Fill Path: what fills (a colour or a pattern), blend mode, opacity, feather. The path's area
   * on the active image layer.
   */
  C.fillPath = (opt = {}) => {
    if (typeof opt === 'string') opt = { color: opt };
    const sps = P.getPath();
    const l = P.doc?.active;
    if (!sps.length) return toast('칠할 패스가 없습니다');
    if (l?.kind !== 'raster') return toast('이미지 레이어를 고르세요');
    const { color = P.fg, pattern = null, mode = 'normal', opacity = 1, feather = 0, antiAlias = true, preserve = false } = opt;
    P.run('패스 칠하기', () => {
      let m = PT.rasterizePath(W(), H(), sps, { feather });
      if (!antiAlias && !feather) m = hardEdge(m);
      const t = makeCanvas(W(), H());
      const tg = t.getContext('2d');
      tg.drawImage(m, 0, 0);
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = pattern ? tg.createPattern(patternCanvas(pattern), 'repeat') : color;
      tg.fillRect(0, 0, W(), H());
      if (P.doc.selection) {
        tg.globalCompositeOperation = 'destination-in';
        tg.drawImage(P.doc.selection.canvas, 0, 0);
      }
      const g = P.doc.editPixels(l);
      if (preserve) {
        // only where the layer has pixels
        const lt = makeCanvas(W(), H());
        const lg = lt.getContext('2d');
        lg.drawImage(t, 0, 0);
        lg.globalCompositeOperation = 'destination-in';
        lg.drawImage(g.canvas, l.x, l.y);
        compositeOnto(g, lt, -l.x, -l.y, mode, opacity);
      } else compositeOnto(g, t, -l.x, -l.y, mode, opacity);
      l._styled = null;
    });
    return undefined;
  };
  /** Stroke Path with a painting tool's current settings, like Photoshop's "패스 획". */
  C.strokePath = (toolId = 'brush', simulatePressure = false) => {
    const sps = P.getPath();
    const l = P.doc?.active;
    const tool = TOOL_BY_ID[toolId];
    if (!sps.length) return toast('획을 그릴 패스가 없습니다');
    if (!tool?.down) return toast('그 도구로는 획을 그릴 수 없습니다');
    if (!l || (l.kind !== 'raster' && !P.editMask)) return toast('이미지 레이어를 고르세요');
    P.lastStrokeTool = toolId;
    P.lastStrokePressure = simulatePressure;
    const before = P.doc.capture();
    const origCommit = P.commit;
    // the tool records its own steps: they become one "패스 획" step
    P.commit = () => {};
    const ev = (x, y, pressure) => {
      const [cx, cy] = P.toScreen(x, y);
      return { pointerType: simulatePressure ? 'pen' : 'mouse', pressure, button: 0, buttons: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, clientX: cx, clientY: cy, preventDefault() {}, stopPropagation() {} };
    };
    try {
      for (const sp of sps) {
        const pts = PT.flatten(sp, 1);
        if (pts.length < 2) continue;
        const pr = (i) => (simulatePressure ? Math.max(0.05, Math.sin((Math.PI * i) / Math.max(1, pts.length - 1))) : 1);
        tool.down(P, { x: pts[0][0], y: pts[0][1] }, ev(pts[0][0], pts[0][1], pr(0)));
        for (let i = 1; i < pts.length; i++) tool.move?.(P, { x: pts[i][0], y: pts[i][1] }, ev(pts[i][0], pts[i][1], pr(i)));
        tool.up?.(P, { x: pts.at(-1)[0], y: pts.at(-1)[1] }, ev(pts.at(-1)[0], pts.at(-1)[1], 0));
      }
    } finally {
      P.commit = origCommit;
    }
    P.commit('패스 획', before);
    return undefined;
  };
  const STROKE_TOOLS = () => ['brush', 'pencil', 'eraser', 'bgEraser', 'clone', 'patternStamp', 'historyBrush', 'artHistory', 'heal', 'mixer', 'colorReplace', 'blur', 'sharpen', 'smudge', 'dodge', 'burn', 'sponge'].filter((id) => TOOL_BY_ID[id]?.down);
  C.strokePathDialog = () => {
    if (!P.getPath().length) return toast('획을 그릴 패스가 없습니다');
    const sel = h('select', STROKE_TOOLS().map((id) => h('option', { value: id }, TOOL_BY_ID[id].name)));
    sel.value = P.lastStrokeTool && TOOL_BY_ID[P.lastStrokeTool] ? P.lastStrokeTool : 'brush';
    const pr = h('input', { type: 'checkbox', checked: !!P.lastStrokePressure });
    openModal({
      title: '패스 획', width: '320px',
      body: [h('label.ph-prow', h('span', '도구'), sel), h('label.ph-prow', pr, h('span', '압력 시뮬레이트')), h('div.note', '고른 도구의 지금 설정(크기·색·경도)으로 패스를 따라 그립니다.')],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => C.strokePath(sel.value, pr.checked) }],
    });
    return undefined;
  };
  C.fillPathDialog = () => {
    if (!P.getPath().length) return toast('칠할 패스가 없습니다');
    const what = h('select', [['fg', '전경색'], ['bg', '배경색'], ['color', '색상…'], ['pattern', '패턴'], ['black', '검정'], ['gray', '50% 회색'], ['white', '흰색']].map(([v, n]) => h('option', { value: v }, n)));
    const col = h('input', { type: 'color', value: P.fg, hidden: true });
    const pat = h('select', { hidden: true }, listPatterns().map((p) => h('option', { value: p.id }, p.name)));
    what.addEventListener('change', () => {
      col.hidden = what.value !== 'color';
      pat.hidden = what.value !== 'pattern';
    });
    const mode = h('select', BLEND_MODES.map(([v, n]) => h('option', { value: v }, n)));
    mode.value = 'normal';
    const op = h('input.ph-num', { type: 'number', value: 100, min: 0, max: 100 });
    const fe = h('input.ph-num', { type: 'number', value: 0, min: 0, max: 250, step: 0.5 });
    const aa = h('input', { type: 'checkbox', checked: true });
    const keep = h('input', { type: 'checkbox' });
    openModal({
      title: '패스 칠', width: '360px',
      body: [h('label.ph-prow', h('span', '내용'), what, col, pat), h('label.ph-prow', h('span', '모드'), mode), h('label.ph-prow', h('span', '불투명도'), op, h('small', '%')), h('label.ph-prow', keep, h('span', '투명도 유지')), h('label.ph-prow', h('span', '페더 반경'), fe, h('small', 'px')), h('label.ph-prow', aa, h('span', '앤티 앨리어스'))],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => {
        const v = what.value;
        const color = v === 'fg' ? P.fg : v === 'bg' ? P.bg : v === 'black' ? '#000000' : v === 'white' ? '#ffffff' : v === 'gray' ? '#808080' : col.value;
        C.fillPath({ color, pattern: v === 'pattern' ? pat.value : null, mode: mode.value, opacity: clamp(+op.value, 0, 100) / 100, feather: clamp(+fe.value, 0, 250), antiAlias: aa.checked, preserve: keep.checked });
      } }],
    });
    return undefined;
  };
  C.makeSelectionDialog = () => {
    if (!P.getPath().length) return toast('선택 영역으로 만들 패스가 없습니다');
    const fe = h('input.ph-num', { type: 'number', value: 0, min: 0, max: 250, step: 0.5 });
    const aa = h('input', { type: 'checkbox', checked: true });
    const has = !!P.doc.selection;
    const ops = [['new', '새 선택 영역'], ['add', '선택 영역에 추가'], ['sub', '선택 영역에서 빼기'], ['int', '선택 영역과 교차']];
    let mode = 'new';
    const radios = ops.map(([v, n]) => {
      const r = h('input', { type: 'radio', name: 'mksel', value: v, checked: v === 'new', disabled: !has && v !== 'new' });
      r.addEventListener('change', () => { mode = v; });
      return h('label.ph-prow', r, h('span', n));
    });
    openModal({
      title: '선택 영역 만들기', width: '320px',
      body: [h('div.ph-sub', '렌더링'), h('label.ph-prow', h('span', '페더 반경'), fe, h('small', 'px')), h('label.ph-prow', aa, h('span', '앤티 앨리어스')), h('div.ph-sub', '작업'), ...radios],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => C.pathToSelection(mode, clamp(+fe.value, 0, 250), aa.checked) }],
    });
    return undefined;
  };
  C.makeWorkPathDialog = () => {
    if (!P.doc?.selection) return toast('먼저 선택 영역을 만드세요');
    const t = h('input.ph-num', { type: 'number', value: 2, min: 0.5, max: 10, step: 0.5 });
    openModal({
      title: '작업 패스 만들기', width: '300px',
      body: [h('label.ph-prow', h('span', '허용치'), t, h('small', 'px')), h('div.note', '값이 작을수록 선택 영역의 윤곽을 더 촘촘히 따라갑니다 (기준점이 많아짐).')],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => C.selectionToPath(clamp(+t.value, 0.5, 10)) }],
    });
    return undefined;
  };
  C.savePath = async (name) => {
    const doc = P.doc;
    if (!doc?.workPath?.subpaths?.length) return;
    const n = name || (await promptDialog('패스 저장', '패스 이름', `패스 ${doc.paths.length + 1}`));
    if (!n) return;
    P.run('패스 저장', () => {
      const id = `path${Date.now().toString(36)}`;
      doc.paths = [...doc.paths, { id, name: n, subpaths: PT.clonePath(doc.workPath.subpaths) }];
      doc.workPath = null;
      P.pathTarget = { kind: 'saved', id };
    });
    P.emit('paths');
  };
  C.newPath = async () => {
    const doc = P.doc;
    if (!doc) return;
    P.run('새 패스', () => {
      const id = `path${Date.now().toString(36)}`;
      doc.paths = [...doc.paths, { id, name: `패스 ${doc.paths.length + 1}`, subpaths: [] }];
      P.pathTarget = { kind: 'saved', id };
    });
    P.emit('paths');
  };
  C.duplicatePath = () => {
    const doc = P.doc;
    const t = P.resolvePathTarget();
    if (!t) return;
    const sps = PT.clonePath(P.getPath());
    const src = t.kind === 'saved' ? doc.paths.find((p) => p.id === t.id)?.name : '작업 패스';
    P.run('패스 복제', () => {
      const id = `path${Date.now().toString(36)}`;
      doc.paths = [...doc.paths, { id, name: `${src || '패스'} 복사`, subpaths: sps }];
      P.pathTarget = { kind: 'saved', id };
    });
    P.emit('paths');
  };
  C.deletePath = () => {
    const doc = P.doc;
    const t = P.resolvePathTarget();
    if (!t) return;
    P.run('패스 삭제', () => {
      if (t.kind === 'work') doc.workPath = null;
      else if (t.kind === 'saved') doc.paths = doc.paths.filter((p) => p.id !== t.id);
      else if (t.kind === 'vmask') {
        const l = doc.layer(t.layerId);
        l.vmask = null;
        doc.touch(l);
      }
      P.pathTarget = null;
    });
    P.penDraw = null;
    P.curvDraw = null;
    P.emit('paths');
  };
  C.renamePath = async (id) => {
    const doc = P.doc;
    const p = doc.paths.find((x) => x.id === id);
    if (!p) return;
    const n = await promptDialog('패스 이름', '이름', p.name);
    if (n) P.run('패스 이름', () => { doc.paths = doc.paths.map((x) => (x.id === id ? { ...x, name: n } : x)); });
    P.emit('paths');
  };
  C.addVectorMask = (mode = 'path') => {
    const doc = P.doc;
    const l = doc?.active;
    if (!l) return;
    if (l.vmask) return toast('이미 벡터 마스크가 있습니다');
    const sps = mode === 'path' ? PT.clonePath(P.getPath()) : [];
    if (mode === 'path' && !sps.length) return toast('먼저 펜 도구로 패스를 그리세요 (또는 레이어 ▸ 벡터 마스크 ▸ 모두 나타내기)');
    P.run('벡터 마스크', () => {
      l.vmask = { subpaths: sps, enabled: true, invert: mode === 'hide', linked: true, dx: 0, dy: 0 };
      l._styled = null;
      doc.touch(l);
      if (P.pathTarget?.kind === 'work') doc.workPath = null;
      P.pathTarget = { kind: 'vmask', layerId: l.id };
    });
    P.emit('paths');
    return undefined;
  };
  C.rasterizeVectorMask = () => {
    const doc = P.doc;
    const l = doc?.active;
    if (!l?.vmask) return;
    P.run('벡터 마스크 래스터화', () => {
      const vm = P.vectorMaskCanvas(l);
      if (l.mask) {
        const g = doc.editMask(l);
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(vm, -l.mask.x, -l.mask.y);
      } else l.mask = { canvas: vm, x: 0, y: 0, enabled: true, linked: true };
      l.vmask = null;
      l._styled = null;
      doc.touch(l);
    });
  };
  P.customShapeList = () => PT.CUSTOM_SHAPES.map(([id, name]) => [id, name]);
  P.customShapeName = (id) => PT.CUSTOM_SHAPES.find((c) => c[0] === id)?.[1] || '모양';
  P.shapeSubpaths = (shape, x, y) => PT.translatePath(PT.shapeToSubpaths(shape), x, y);
  P.addToWorkPath = (sps, label, before) => {
    const doc = P.doc;
    const op = P.opts('pen').op || 'combine';
    if (!doc.workPath || P.pathTarget?.kind !== 'work') {
      doc.workPath = { subpaths: [] };
      P.pathTarget = { kind: 'work' };
    }
    doc.workPath = { subpaths: [...doc.workPath.subpaths, ...sps.map((sp, i) => ({ ...sp, op: doc.workPath.subpaths.length || i ? (i ? sp.op : op) : 'combine' }))] };
    P.commit(label, before);
    P.emit('paths');
  };
  P.paintShapePixels = (sps, shape, before) => {
    const doc = P.doc;
    const l = doc.active;
    if (l?.kind !== 'raster') {
      toast('픽셀 모드는 이미지 레이어에 그립니다');
      return;
    }
    const g = doc.editPixels(l);
    g.save();
    g.translate(-l.x, -l.y);
    const p2 = PT.toPath2D(sps);
    if (shape.fill && shape.type !== 'line') {
      g.fillStyle = shape.fill;
      g.fill(p2, PT.fillRuleFor(sps));
    }
    if (shape.stroke && shape.strokeWidth) {
      g.strokeStyle = shape.stroke;
      g.lineWidth = shape.strokeWidth;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.stroke(p2);
    }
    g.restore();
    l._styled = null;
    P.commit('모양 (픽셀)', before);
  };
  /** The current path as a new shape layer filled with the foreground colour. */
  C.pathToShape = () => {
    const sps = PT.clonePath(P.getPath());
    if (!sps.length) return toast('먼저 펜 도구로 패스를 그리세요');
    P.run('모양 만들기', () => {
      const l = newLayer('shape', { name: '모양', shape: { type: 'path', subpaths: [], w: 1, h: 1, pw: 1, ph: 1, fill: P.fg, stroke: null, strokeWidth: 0 } });
      P.addLayer(l);
      writeShape(P.doc, l, sps.map((sp) => ({ ...sp, closed: true })));
      if (P.pathTarget?.kind === 'work') P.doc.workPath = null;
      P.pathTarget = { kind: 'shape', layerId: l.id };
    });
    P.emit('paths');
    return undefined;
  };
  P.vectorMaskMenu = () => {
    const l = P.doc?.active;
    return [
      { label: '현재 패스로 벡터 마스크', disabled: !!l?.vmask, action: () => C.addVectorMask('path') },
      { label: '모두 나타내기 (빈 벡터 마스크)', disabled: !!l?.vmask, action: () => C.addVectorMask('reveal') },
      '-',
      { label: '벡터 마스크 편집 (직접 선택 도구)', disabled: !l?.vmask, action: () => P.editVectorMask(l) },
      { label: '벡터 마스크 반전', disabled: !l?.vmask, action: () => P.run('벡터 마스크 반전', () => { l.vmask = { ...l.vmask, invert: !l.vmask.invert }; P.doc.touch(l); }) },
      { label: l?.vmask?.enabled === false ? '벡터 마스크 켜기' : '벡터 마스크 끄기', disabled: !l?.vmask, action: () => P.run('벡터 마스크 켜기/끄기', () => { l.vmask = { ...l.vmask, enabled: l.vmask.enabled === false }; P.doc.touch(l); }) },
      { label: '래스터화 (일반 마스크로)', disabled: !l?.vmask, action: () => C.rasterizeVectorMask() },
      { label: '삭제', disabled: !l?.vmask, action: () => P.run('벡터 마스크 삭제', () => { l.vmask = null; P.doc.touch(l); }) },
    ];
  };

  // Photoshop's shape tools (rectangle … custom shape) and the shape layer renderer
  installShapes2(P);
}
