// Pen tools, path selection tools, path commands and the vector-mask hooks. Paths are edited on a
// "target": the work path, a saved path, the active layer's vector mask, or a path shape layer.

import { newLayer, makeCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, Stroke, brushOpts } from './tools.js';
import * as PT from './paths.js';
import * as SEL from './selection.js';
import { toast, promptDialog } from '../ui/common.js';

const near = (a, b, tol) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

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
  const h = Math.max(1, b.h);
  l.shape = { ...l.shape, type: 'path', subpaths: PT.translatePath(sps, -b.x, -b.y), w, h, pw: w, ph: h };
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

  P.drawPathOverlay = (g, { showAll = false, outlineOnly = false } = {}) => {
    const sps = P.getPath();
    if (!sps.length) return;
    if (outlineOnly) {
      const z = P.view.zoom;
      const [ox, oy] = P.toScreen(0, 0);
      g.save();
      g.translate(ox, oy);
      g.scale(z, z);
      g.lineWidth = 1 / z;
      g.strokeStyle = 'rgba(61,139,255,.8)';
      g.stroke(PT.toPath2D(sps));
      g.restore();
      return;
    }
    const z = P.view.zoom;
    const [ox, oy] = P.toScreen(0, 0);
    g.save();
    g.translate(ox, oy);
    g.scale(z, z);
    g.lineWidth = 1 / z;
    g.strokeStyle = '#3d8bff';
    g.stroke(PT.toPath2D(sps));
    g.restore();
    const sel = P.pathSel;
    const box = (x, y, filled) => {
      const [sx, sy] = P.toScreen(x, y);
      g.fillStyle = filled ? '#3d8bff' : '#ffffff';
      g.strokeStyle = '#3d8bff';
      g.fillRect(sx - 3.5, sy - 3.5, 7, 7);
      g.strokeRect(sx - 3.5, sy - 3.5, 7, 7);
    };
    sps.forEach((sp, si) => {
      const subOn = showAll || sel.subs.has(si);
      sp.knots.forEach((k, ki) => {
        const on = sel.knots.has(`${si}:${ki}`);
        if (on || (P.tool === 'pen' && P.penDraw?.si === si && ki === sp.knots.length - 1)) {
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
        if (subOn || on || P.tool === 'directSelect' || P.tool === 'pen' || P.tool === 'addAnchor' || P.tool === 'deleteAnchor' || P.tool === 'convertPoint') box(k.p[0], k.p[1], on || (subOn && P.tool === 'pathSelect'));
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
  const hitHandle = (sps, p) => {
    for (const key of P.pathSel.knots) {
      const [si, ki] = key.split(':').map(Number);
      const k = sps[si]?.knots[ki];
      if (!k) continue;
      if (near(k.out, [p.x, p.y], tol()) && !near(k.out, k.p, 0.01)) return { si, ki, which: 'out' };
      if (near(k.in, [p.x, p.y], tol()) && !near(k.in, k.p, 0.01)) return { si, ki, which: 'in' };
    }
    return null;
  };
  const hitSub = (sps, p) => {
    const n = PT.nearestOnPath(sps, p.x, p.y);
    if (n && n.d <= tol()) return n.si;
    // inside a closed subpath counts too (path selection tool)
    const g = makeCanvas(1, 1).getContext('2d');
    for (let si = sps.length - 1; si >= 0; si--) if (sps[si].closed && g.isPointInPath(PT.toPath2D([sps[si]]), p.x, p.y)) return si;
    return -1;
  };

  // ---------------------------------------------------------------- tools

  const begin = (label) => ({ before: P.doc.capture(), label });
  const finish = (h) => {
    if (h) P.commit(h.label, h.before);
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

  const pen = {
    id: 'pen', name: '펜', key: 'P', icon: 'pen', group: 'pen', cursor: 'crosshair',
    options: [['mode', '모드', 'select', null, null, 'path', [['path', '패스'], ['shape', '모양 (레이어)']]], ['op', '패스 작업', 'select', null, null, 'combine', PT.PATH_OPS], ['newLayer', '모양마다 새 레이어', 'bool', null, null, true], ['autoAdd', '자동 추가/삭제', 'bool', null, null, true]],
    activate() {
      P.autoPathTarget();
    },
    down(E, p, e) {
      const o = E.opts('pen');
      let sps = PT.clonePath(P.getPath());
      const d = P.penDraw;
      // continue an open subpath, or close it on its first anchor
      if (d && sps[d.si] && !sps[d.si].closed) {
        const sp = sps[d.si];
        if (sp.knots.length > 1 && near(sp.knots[0].p, [p.x, p.y], tol())) {
          this.h = begin('패스 닫기');
          sp.closed = true;
          P.setPath(sps);
          this.drag = { si: d.si, ki: 0, closing: true, start: p };
          P.penDraw = null;
          return;
        }
        this.h = begin('기준점 추가');
        sp.knots.push(PT.knot(p.x, p.y));
        P.setPath(sps);
        this.drag = { si: d.si, ki: sp.knots.length - 1, start: p, alt: e.altKey };
        return;
      }
      // add / delete anchors on an existing path
      if (o.autoAdd && sps.length && !e.shiftKey) {
        const hk = hitKnot(sps, p);
        if (hk) {
          this.h = begin('기준점 삭제');
          sps[hk.si].knots.splice(hk.ki, 1);
          if (sps[hk.si].knots.length < 2) sps.splice(hk.si, 1);
          P.setPath(sps);
          finish(this.h);
          this.h = null;
          return;
        }
        const n = PT.nearestOnPath(sps, p.x, p.y);
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
      P.penDraw = { si: sps.length - 1 };
      this.drag = { si: sps.length - 1, ki: 0, start: p };
    },
    move(E, p, e) {
      const dr = this.drag;
      if (!dr) return;
      const sps = PT.clonePath(P.getPath());
      const k = sps[dr.si]?.knots[dr.ki];
      if (!k) return;
      if (Math.hypot(p.x - dr.start.x, p.y - dr.start.y) < 2 / P.view.zoom) return;
      // drag: symmetric handles (Alt: only the outgoing one)
      k.out = [p.x, p.y];
      if (!(e.altKey || dr.alt)) k.in = [2 * k.p[0] - p.x, 2 * k.p[1] - p.y];
      k.smooth = !(e.altKey || dr.alt);
      if (dr.closing) [k.in, k.out] = [k.out, k.in];
      P.setPath(sps);
    },
    up() {
      this.drag = null;
      if (this.h) finish(this.h);
      this.h = null;
    },
    onKey(E, e) {
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
    },
  };

  const freePen = {
    id: 'freePen', name: '자유 형태 펜', key: 'P', icon: 'freePen', group: 'pen', cursor: 'crosshair',
    options: [['mode', '모드', 'select', null, null, 'path', [['path', '패스'], ['shape', '모양 (새 레이어)']]], ['op', '패스 작업', 'select', null, null, 'combine', PT.PATH_OPS], ['fit', '곡선 맞춤 (px)', 'range', 1, 10, 2]],
    down(E, p) {
      this.pts = [[p.x, p.y]];
      this.h = begin('자유 형태 펜');
    },
    move(E, p) {
      if (!this.pts) return;
      this.pts.push([p.x, p.y]);
      P.redraw();
    },
    up(E) {
      const pts = this.pts;
      this.pts = null;
      if (!pts || pts.length < 3) return;
      const o = E.opts('freePen');
      const closed = Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 12 / P.view.zoom;
      const sp = PT.fitFreehand(pts, o.fit, closed);
      if (!sp) return;
      ensureTargetForDrawing(o.mode === 'shape' ? 'shape' : 'path');
      const sps = P.pathTarget?.fresh ? [] : PT.clonePath(P.getPath());
      sp.op = sps.length ? o.op : 'combine';
      sps.push(sp);
      P.setPath(sps);
      if (P.pathTarget?.fresh) delete P.pathTarget.fresh;
      finish(this.h);
    },
    overlay(E, g) {
      P.drawPathOverlay(g);
      if (!this.pts) return;
      g.strokeStyle = '#3d8bff';
      g.beginPath();
      this.pts.forEach(([x, y], i) => {
        const [sx, sy] = P.toScreen(x, y);
        if (i) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
      });
      g.stroke();
    },
  };

  const anchorTool = (id, name, icon, fn) => ({
    id, name, key: null, icon, group: 'pen', cursor: 'crosshair', options: [],
    activate() {
      P.autoPathTarget();
    },
    down(E, p, e) {
      const sps = PT.clonePath(P.getPath());
      if (!sps.length) return;
      const h = begin(name);
      if (fn(sps, p, e, this) !== false) {
        P.setPath(sps);
        if (!this.drag) finish(h);
        else this.h = h;
      }
    },
    move(E, p, e) {
      if (!this.drag) return;
      const sps = PT.clonePath(P.getPath());
      const k = sps[this.drag.si]?.knots[this.drag.ki];
      if (!k) return;
      k.out = [p.x, p.y];
      if (!e.altKey) k.in = [2 * k.p[0] - p.x, 2 * k.p[1] - p.y];
      k.smooth = !e.altKey;
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
  const addAnchor = anchorTool('addAnchor', '기준점 추가', 'addAnchor', (sps, p) => {
    const n = PT.nearestOnPath(sps, p.x, p.y);
    if (!n || n.d > tol()) return false;
    sps[n.si] = PT.splitSegment(sps[n.si], n.i, n.t);
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
    const hk = hitKnot(sps, p);
    if (!hk) return false;
    const k = sps[hk.si].knots[hk.ki];
    if (!near(k.in, k.p, 0.01) || !near(k.out, k.p, 0.01)) {
      // smooth → corner
      k.in = [...k.p];
      k.out = [...k.p];
      k.smooth = false;
      return true;
    }
    // corner → smooth: drag out handles
    self.drag = { si: hk.si, ki: hk.ki };
    return true;
  });

  const selectTool = (id, name, icon, direct) => ({
    id, name, key: 'A', icon, group: 'pathSelect', cursor: 'default',
    options: direct ? [] : [['op', '패스 작업 (고른 패스)', 'select', null, null, 'combine', PT.PATH_OPS]],
    activate() {
      P.autoPathTarget();
      P.redraw();
    },
    down(E, p, e) {
      let sps = P.getPath();
      // clicking a path shape layer on the canvas targets it
      if (!sps.length || (hitSub(sps, p) < 0 && !hitKnot(sps, p))) {
        const hit = P.layerAt(p, (l) => l.kind === 'shape');
        if (hit) {
          P.selectLayer(hit.id);
          P.pathTarget = { kind: 'shape', layerId: hit.id };
          sps = P.getPath();
        }
      }
      if (!sps.length) return;
      const sel = P.pathSel;
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
        sel.knots = new Set();
        this.h = null;
        P.redraw();
        return;
      }
      const si = hitSub(sps, p);
      if (si < 0) {
        sel.subs = new Set();
        this.h = null;
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
      this.d = { kind: 'subs', a: p, orig: PT.clonePath(sps) };
      P.redraw();
    },
    move(E, p, e) {
      const d = this.d;
      if (!d) return;
      let dx = p.x - d.a.x;
      let dy = p.y - d.a.y;
      if (e.shiftKey && d.kind !== 'handle') {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
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
      if (this.d && this.h) finish(this.h);
      this.d = null;
      this.h = null;
    },
    onKey(E, e) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
      const sps = PT.clonePath(P.getPath());
      const sel = P.pathSel;
      if (!sps.length || (!sel.subs.size && !sel.knots.size)) return false;
      const h = begin('패스 삭제');
      let out = sps;
      if (direct && sel.knots.size) {
        const rm = new Set(sel.knots);
        out = sps.map((sp, si) => ({ ...sp, knots: sp.knots.filter((_, ki) => !rm.has(`${si}:${ki}`)) })).filter((sp) => sp.knots.length >= 2);
      } else out = sps.filter((_, si) => !sel.subs.has(si));
      P.pathSel = { subs: new Set(), knots: new Set() };
      P.setPath(out);
      finish(h);
      return true;
    },
    overlay(E, g) {
      P.drawPathOverlay(g);
    },
  });
  const pathSelect = selectTool('pathSelect', '패스 선택', 'pathSelect', false);
  const directSelect = selectTool('directSelect', '직접 선택', 'directSelect', true);

  for (const t of [pen, freePen, addAnchor, deleteAnchor, convertPoint, pathSelect, directSelect]) {
    TOOLS.push(t);
    TOOL_BY_ID[t.id] = t;
  }
  const ti = TOOL_GROUPS.findIndex((g) => g.includes('text'));
  TOOL_GROUPS.splice(ti, 0, ['pen', 'freePen', 'addAnchor', 'deleteAnchor', 'convertPoint']);
  TOOL_GROUPS.splice(ti + 2, 0, ['pathSelect', 'directSelect']);

  // ---------------------------------------------------------------- commands

  const C = P.cmd;
  const W = () => P.doc.width;
  const H = () => P.doc.height;
  C.pathToSelection = (mode = 'new', feather = 0) => {
    const sps = P.getPath();
    if (!sps.length) return toast('선택 영역으로 만들 패스가 없습니다');
    P.run('패스를 선택 영역으로', () => {
      const c = PT.rasterizePath(W(), H(), sps, { feather });
      const doc = P.doc;
      if (mode === 'new' || !doc.selection) doc.selection = { canvas: c };
      else doc.selection = SEL.combine(doc, c, mode);
    });
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
  C.fillPath = (color = P.fg) => {
    const sps = P.getPath();
    const l = P.doc.active;
    if (!sps.length) return toast('칠할 패스가 없습니다');
    if (l?.kind !== 'raster') return toast('이미지 레이어를 고르세요');
    P.run('패스 칠하기', () => {
      const m = PT.rasterizePath(W(), H(), sps);
      const t = makeCanvas(W(), H());
      const tg = t.getContext('2d');
      tg.drawImage(m, 0, 0);
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = color;
      tg.fillRect(0, 0, W(), H());
      const g = P.doc.editPixels(l);
      g.drawImage(t, -l.x, -l.y);
      l._styled = null;
    });
    return undefined;
  };
  /** Stroke the path with the brush (or pencil / eraser) settings, like Photoshop's "패스 획". */
  C.strokePath = (toolId = 'brush', simulatePressure = false) => {
    const sps = P.getPath();
    const l = P.doc.active;
    if (!sps.length) return toast('획을 그릴 패스가 없습니다');
    if (l?.kind !== 'raster') return toast('이미지 레이어를 고르세요');
    const o = P.opts(toolId);
    const st = new Stroke(P, toolId === 'eraser' ? 'erase' : 'paint', brushOpts(o, P, { label: '패스 획', hard: toolId === 'pencil' }));
    for (const sp of sps) {
      const pts = PT.flatten(sp, 1);
      st.last = null;
      pts.forEach(([x, y], i) => st.to({ x, y }, simulatePressure ? Math.sin((Math.PI * i) / Math.max(1, pts.length - 1)) : 1));
    }
    st.end();
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
  P.shapeSubpaths = (shape, x, y) => PT.translatePath(PT.shapeToSubpaths(shape), x, y).map((sp) => ({ ...sp, closed: shape.type === 'line' ? false : sp.closed }));
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
}
