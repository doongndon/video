// Edit ▸ Perspective Warp (원근 뒤틀기): draw one or more quads on the planes of an object (Layout),
// then drag their corners to change the perspective (Warp). Quads that touch share their corners.
// Lives in P.transform like the free transform, so Enter commits, Esc cancels and the options bar
// (transform2.js) shows its buttons.

import { homography, applyH, meshWarp } from './transform.js';

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Closest point to p on segment ab. */
function closestOnSeg(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return [a[0] + dx * t, a[1] + dy * t];
}

/** A quad that can carry a perspective: convex, with some area. */
function convexQuad(q) {
  let sign = 0;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    if (sign && Math.sign(cr) !== sign) return false;
    sign = Math.sign(cr);
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2 > 4;
}

function inPoly(p, q) {
  let ins = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < ((q[j][0] - q[i][0]) * (p[1] - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) ins = !ins;
  }
  return ins;
}

export class PerspectiveWarp {
  constructor(E) {
    const doc = E.doc;
    const l = doc.active;
    if (!l || l.kind !== 'raster' || !l.canvas) throw new Error('원근 뒤틀기는 일반(이미지) 레이어에서 씁니다. 글자·모양·고급 개체는 래스터화한 뒤 쓰세요.');
    if (l.locked || l.lockPixels || l.lockPos) throw new Error('잠긴 레이어입니다 (레이어 패널에서 잠금 해제)');
    this.E = E;
    this.kind = 'perspwarp';
    this.layer = l;
    this.before = doc.capture();
    this.mode = 'layout';
    this.V = []; // corners: { s: layout position, t: warped position } (doc coords)
    this.Q = []; // quads: 4 corner indices, clockwise from the top left
    this.straight = new Map(); // straightened edges "a-b" → 'h' | 'v'
    this.sel = -1;
    // the layer's pixels float while warping (the layer itself is emptied)
    this.src = l.canvas;
    this.sx = l.x;
    this.sy = l.y;
    const g = doc.editPixels(l);
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    this.update();
  }

  get interp() {
    return this.E.transformInterp || 'bicubic';
  }

  // ---------------------------------------------------------------- geometry

  quadPts(k, which = 's') {
    return this.Q[k].map((i) => this.V[i][which]);
  }

  /** Where a doc point of the layer goes: each quad's perspective, blended smoothly between quads. */
  mapper() {
    // quads that are not convex (a corner dragged across) carry nothing
    const ok = this.Q.map((_, k) => convexQuad(this.quadPts(k, 's')) && convexQuad(this.quadPts(k, 't')));
    const Hs = this.Q.map((_, k) => (ok[k] ? homography(this.quadPts(k, 's'), this.quadPts(k, 't')) : null)).filter(Boolean);
    const polys = this.Q.map((_, k) => this.quadPts(k, 's')).filter((_, k) => ok[k]);
    const W = this.src.width;
    const H = this.src.height;
    const diag = Math.hypot(W, H);
    const eps = Math.max(1, (diag * 0.004) ** 2);
    // nothing lands absurdly far away (a perspective close to its horizon runs off to infinity)
    const lim = [this.sx - 2 * W, this.sy - 2 * H, this.sx + 3 * W, this.sy + 3 * H];
    const clampPt = (q) => [Math.max(lim[0], Math.min(lim[2], q[0])), Math.max(lim[1], Math.min(lim[3], q[1]))];
    return (p) => clampPt(this.mapRaw(p, Hs, polys, eps));
  }

  mapRaw(p, Hs, polys, eps) {
    if (!Hs.length) return p;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let k = 0; k < Hs.length; k++) {
      const q = polys[k];
      let f;
      let d2 = 0;
      if (inPoly(p, q)) f = applyH(Hs[k], p[0], p[1]);
      else {
        // outside: the quad's perspective at its nearest edge point, carried on straight
        let c = null;
        let best = Infinity;
        for (let i = 0; i < 4; i++) {
          const cp = closestOnSeg(p, q[i], q[(i + 1) % 4]);
          const dd = dist2(cp, p);
          if (dd < best) {
            best = dd;
            c = cp;
          }
        }
        d2 = best;
        const f0 = applyH(Hs[k], c[0], c[1]);
        const fx = applyH(Hs[k], c[0] + 1, c[1]);
        const fy = applyH(Hs[k], c[0], c[1] + 1);
        const vx = p[0] - c[0];
        const vy = p[1] - c[1];
        f = [f0[0] + (fx[0] - f0[0]) * vx + (fy[0] - f0[0]) * vy, f0[1] + (fx[1] - f0[1]) * vx + (fy[1] - f0[1]) * vy];
      }
      if (!Number.isFinite(f[0]) || !Number.isFinite(f[1])) continue;
      const w = 1 / (d2 + eps);
      sx += f[0] * w;
      sy += f[1] * w;
      sw += w;
    }
    return sw ? [sx / sw, sy / sw] : p;
  }

  /** Quad k can't be used (not convex): it is drawn red. */
  badQuad(k) {
    return !convexQuad(this.quadPts(k, 's')) || !convexQuad(this.quadPts(k, 't'));
  }

  /** The warped layer: a mesh over the layer pushed through the mapping. */
  render(n) {
    const map = this.mapper();
    const W = this.src.width;
    const H = this.src.height;
    const pts = [];
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) pts.push(map([this.sx + (c / n) * W, this.sy + (r / n) * H]));
    return meshWarp(this.src, pts, n, n, { interp: this.interp });
  }

  warped() {
    return this.V.some((v) => dist2(v.s, v.t) > 1e-6);
  }

  update(fine = false) {
    const E = this.E;
    let r = null;
    if (this.mode === 'warp' && this.warped()) {
      try {
        r = this.render(fine ? 48 : 28);
      } catch {
        r = null;
      }
    }
    E.float = r ? { ...r, layerId: this.layer.id } : { canvas: this.src, x: this.sx, y: this.sy, layerId: this.layer.id };
    E.transformChanged?.(this);
    E.redraw();
  }

  // ---------------------------------------------------------------- interaction

  pos() {
    return this.mode === 'warp' ? 't' : 's';
  }

  vertexAt(p, tol) {
    const which = this.pos();
    let best = -1;
    let bd = tol * tol;
    this.V.forEach((v, i) => {
      if (!this.Q.some((q) => q.includes(i))) return;
      const d = dist2(v[which], p);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  quadAt(p) {
    const which = this.pos();
    for (let k = this.Q.length - 1; k >= 0; k--) if (inPoly(p, this.quadPts(k, which))) return k;
    return -1;
  }

  /** An edge of a quad (in warp positions) near p: [a, b] corner indices, or null. */
  edgeAt(p, tol) {
    let best = null;
    let bd = tol * tol;
    for (const q of this.Q) {
      for (let i = 0; i < 4; i++) {
        const a = q[i];
        const b = q[(i + 1) % 4];
        const d = dist2(closestOnSeg(p, this.V[a].t, this.V[b].t), p);
        if (d <= bd) {
          bd = d;
          best = [a, b];
        }
      }
    }
    return best;
  }

  hit(p) {
    const tol = 9 / this.E.view.zoom;
    const pt = [p.x, p.y];
    if (this.vertexAt(pt, tol) >= 0) return 'c0';
    if (this.mode === 'layout') return this.quadAt(pt) >= 0 ? 'move' : 'none';
    return 'none';
  }

  down(p, e = {}) {
    const tol = 9 / this.E.view.zoom;
    const pt = [p.x, p.y];
    const vi = this.vertexAt(pt, tol);
    if (this.mode === 'warp') {
      // Shift+click an edge: make it level or upright, and keep it so
      if (e.shiftKey && vi < 0) {
        const ed = this.edgeAt(pt, tol);
        if (ed) this.straighten(ed);
        this.d = null;
        return;
      }
      this.d = vi >= 0 ? { v: vi, a: pt, t0: [...this.V[vi].t] } : null;
      return;
    }
    if (vi >= 0) {
      this.d = { v: vi, a: pt, s0: this.V.map((v) => [...v.s]), t0: this.V.map((v) => [...v.t]) };
      return;
    }
    const k = this.quadAt(pt);
    if (k >= 0) {
      this.sel = k;
      this.d = { quad: k, a: pt, s0: this.V.map((v) => [...v.s]), t0: this.V.map((v) => [...v.t]) };
      return;
    }
    // a new quad, drawn as a box first
    this.d = { draw: true, a: pt, b: pt };
  }

  move(p) {
    const d = this.d;
    if (!d) return;
    const pt = [p.x, p.y];
    const dx = pt[0] - d.a[0];
    const dy = pt[1] - d.a[1];
    if (d.draw) d.b = pt;
    else if (this.mode === 'warp') {
      const v = this.V[d.v];
      v.t = [d.t0[0] + dx, d.t0[1] + dy];
      this.keepStraight(d.v);
      this.update();
      return;
    } else if (d.quad != null) {
      for (const i of this.Q[d.quad]) {
        this.V[i].s = [d.s0[i][0] + dx, d.s0[i][1] + dy];
        this.V[i].t = [d.t0[i][0] + dx, d.t0[i][1] + dy];
      }
    } else if (d.v != null) {
      this.V[d.v].s = [d.s0[d.v][0] + dx, d.s0[d.v][1] + dy];
      this.V[d.v].t = [d.t0[d.v][0] + dx, d.t0[d.v][1] + dy];
    }
    this.E.redraw();
  }

  up() {
    const d = this.d;
    this.d = null;
    if (!d) return;
    if (d.draw) {
      const [x0, x1] = [Math.min(d.a[0], d.b[0]), Math.max(d.a[0], d.b[0])];
      const [y0, y1] = [Math.min(d.a[1], d.b[1]), Math.max(d.a[1], d.b[1])];
      if ((x1 - x0) * this.E.view.zoom < 8 || (y1 - y0) * this.E.view.zoom < 8) {
        this.sel = -1;
        this.E.redraw();
        return;
      }
      const base = this.V.length;
      for (const c of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) this.V.push({ s: c, t: [...c] });
      this.Q.push([base, base + 1, base + 2, base + 3]);
      this.sel = this.Q.length - 1;
      this.snapQuad(this.sel);
    } else if (this.mode === 'layout') {
      if (d.quad != null) this.snapQuad(d.quad);
      else if (d.v != null) this.snapVertex(d.v);
    } else {
      this.update(true);
      return;
    }
    this.E.transformChanged?.(this);
    this.E.redraw();
  }

  /** Layout: a corner let go near another quad's corner joins it (the quads then share that edge). */
  snapVertex(i) {
    const tol = 14 / this.E.view.zoom;
    const mine = new Set(this.Q.filter((q) => q.includes(i)).flat());
    let best = -1;
    let bd = tol * tol;
    this.V.forEach((v, j) => {
      if (j === i || mine.has(j) || !this.Q.some((q) => q.includes(j))) return;
      const d = dist2(v.s, this.V[i].s);
      if (d <= bd) {
        bd = d;
        best = j;
      }
    });
    if (best < 0) return false;
    this.joinCorner(i, best);
    return true;
  }

  /** Corner `from` becomes corner `to` in every quad. */
  joinCorner(from, to) {
    for (const q of this.Q) for (let k = 0; k < 4; k++) if (q[k] === from) q[k] = to;
  }

  /**
   * Layout: a quad drawn (or moved) with an edge near another quad's edge joins it there, so both
   * share that edge (Photoshop snaps the planes together); else near corners join one by one.
   */
  snapQuad(k) {
    const tol = 24 / this.E.view.zoom;
    const q = this.Q[k];
    const d = (i, j) => Math.sqrt(dist2(this.V[i].s, this.V[j].s));
    let best = null;
    let bd = tol;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      this.Q.forEach((o, ko) => {
        if (ko === k) return;
        for (let j = 0; j < 4; j++) {
          const c = o[j];
          const e = o[(j + 1) % 4];
          if ([c, e].includes(a) || [c, e].includes(b)) continue;
          // neighbours drawn the same way round run along a shared edge in opposite directions
          for (const [x, y] of [[e, c], [c, e]]) {
            const cost = Math.max(d(a, x), d(b, y));
            if (cost < bd) {
              bd = cost;
              best = [a, b, x, y];
            }
          }
        }
      });
    }
    if (best) {
      this.joinCorner(best[0], best[2]);
      this.joinCorner(best[1], best[3]);
      return;
    }
    for (const c of [...new Set(q)]) this.snapVertex(c);
  }

  /** Make edge [a, b] level or upright (whichever it is closer to) and keep it so while warping. */
  straighten([a, b], kind = null) {
    const A = this.V[a].t;
    const B = this.V[b].t;
    const k = kind || (Math.abs(B[0] - A[0]) >= Math.abs(B[1] - A[1]) ? 'h' : 'v');
    if (k === 'h') {
      const y = (A[1] + B[1]) / 2;
      this.V[a].t = [A[0], y];
      this.V[b].t = [B[0], y];
    } else {
      const x = (A[0] + B[0]) / 2;
      this.V[a].t = [x, A[1]];
      this.V[b].t = [x, B[1]];
    }
    this.straight.set(`${Math.min(a, b)}-${Math.max(a, b)}`, k);
    this.update(true);
  }

  /** After corner i moved: straightened edges through it stay level / upright. */
  keepStraight(i) {
    for (const [key, k] of this.straight) {
      const [a, b] = key.split('-').map(Number);
      if (a !== i && b !== i) continue;
      const o = a === i ? b : a;
      const v = this.V[i].t;
      this.V[o].t = k === 'h' ? [this.V[o].t[0], v[1]] : [v[0], this.V[o].t[1]];
    }
  }

  /** Auto straighten: every edge within 25° of level ('h'), upright ('v') or both. */
  autoStraighten(which) {
    if (this.mode !== 'warp') this.setMode('warp');
    const lim = Math.tan((25 * Math.PI) / 180);
    for (const q of this.Q) {
      for (let i = 0; i < 4; i++) {
        const a = q[i];
        const b = q[(i + 1) % 4];
        const A = this.V[a].t;
        const B = this.V[b].t;
        const dx = Math.abs(B[0] - A[0]);
        const dy = Math.abs(B[1] - A[1]);
        if (which !== 'v' && dy <= dx * lim) this.straighten([a, b], 'h');
        else if (which !== 'h' && dx <= dy * lim) this.straighten([a, b], 'v');
      }
    }
    this.update(true);
  }

  /** Layout: remove the selected quad. */
  removeSelected() {
    if (this.mode !== 'layout' || this.sel < 0) return false;
    this.Q.splice(this.sel, 1);
    this.sel = -1;
    this.E.redraw();
    this.E.transformChanged?.(this);
    return true;
  }

  setMode(mode) {
    if (mode !== 'layout' && mode !== 'warp') return;
    if (mode === 'warp' && !this.Q.length) {
      this.E.toast('먼저 레이아웃 모드에서 사각형을 그리세요 (기울어진 면마다 하나씩)');
      return;
    }
    this.mode = mode;
    this.sel = -1;
    this.update(true);
    this.E.emit?.('transform');
  }

  /** Arrow keys: move every warped corner (Warp) or the selected quad (Layout). */
  nudge(dx, dy) {
    if (this.mode === 'warp') for (const v of this.V) v.t = [v.t[0] + dx, v.t[1] + dy];
    else {
      const ids = this.sel >= 0 ? new Set(this.Q[this.sel]) : null;
      if (!ids) return;
      for (const i of ids) {
        this.V[i].s = [this.V[i].s[0] + dx, this.V[i].s[1] + dy];
        this.V[i].t = [this.V[i].t[0] + dx, this.V[i].t[1] + dy];
      }
    }
    this.update(true);
  }

  numbers() {
    return { x: 0, y: 0, w: 100, h: 100, angle: 0, skew: 0, skewV: 0 };
  }

  // ---------------------------------------------------------------- finish

  apply() {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
    E.float = null;
    if (!this.warped()) {
      // nothing was warped: leave the layer as it was, with no step recorded
      doc.restore(this.before);
      E.afterHistory?.();
      return;
    }
    let r;
    try {
      r = this.render(64);
    } catch (err) {
      // the layer is put back as it was rather than lost
      this.cancel();
      E.afterHistory?.();
      E.toast(`원근 뒤틀기를 적용하지 못했습니다: ${err.message || err}`);
      return;
    }
    const g = doc.editPixels(l, { x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height });
    g.drawImage(r.canvas, r.x - l.x, r.y - l.y);
    l._styled = null;
    doc.touch(l);
    E.commit('원근 뒤틀기', this.before);
  }

  cancel() {
    this.E.float = null;
    this.E.doc.restore(this.before);
    this.E.redraw();
  }

  overlay(g) {
    const E = this.E;
    const S = (p) => E.toScreen(p[0], p[1]);
    const which = this.pos();
    g.save();
    // the quads, with a grid on each plane
    this.Q.forEach((q, k) => {
      const pts = q.map((i) => S(this.V[i][which]));
      g.fillStyle = k === this.sel && this.mode === 'layout' ? 'rgba(74,163,255,.18)' : 'rgba(74,163,255,.08)';
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,.45)';
      g.lineWidth = 1;
      const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q.map((i) => this.V[i][which]));
      g.beginPath();
      for (const t of [0.25, 0.5, 0.75]) {
        const a1 = S(applyH(H, t, 0));
        const b1 = S(applyH(H, t, 1));
        const a2 = S(applyH(H, 0, t));
        const b2 = S(applyH(H, 1, t));
        g.moveTo(...a1);
        g.lineTo(...b1);
        g.moveTo(...a2);
        g.lineTo(...b2);
      }
      g.stroke();
      for (let i = 0; i < 4; i++) {
        const a = q[i];
        const b = q[(i + 1) % 4];
        const st = this.straight.get(`${Math.min(a, b)}-${Math.max(a, b)}`) && this.mode === 'warp';
        // edges shared by two quads are drawn thicker
        const shared = this.Q.filter((qq) => qq.includes(a) && qq.includes(b)).length > 1;
        g.strokeStyle = this.badQuad(k) ? '#ff4d4d' : st ? '#ffcc00' : '#4aa3ff';
        g.lineWidth = st || shared ? 2.5 : 1.5;
        g.beginPath();
        g.moveTo(...S(this.V[a][which]));
        g.lineTo(...S(this.V[b][which]));
        g.stroke();
      }
    });
    // corners
    const used = new Set(this.Q.flat());
    g.lineWidth = 1.5;
    for (const i of used) {
      const [x, y] = S(this.V[i][which]);
      g.fillStyle = '#fff';
      g.strokeStyle = '#1d6fd1';
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    // a quad being drawn
    if (this.d?.draw) {
      const [x1, y1] = S(this.d.a);
      const [x2, y2] = S(this.d.b);
      g.setLineDash([4, 3]);
      g.strokeStyle = '#4aa3ff';
      g.strokeRect(Math.min(x1, x2) + 0.5, Math.min(y1, y2) + 0.5, Math.abs(x2 - x1), Math.abs(y2 - y1));
      g.setLineDash([]);
    }
    const label = this.mode === 'layout'
      ? (this.Q.length ? '레이아웃: 사각형 모서리를 면에 맞추세요 (맞닿게 그리면 붙습니다) · 다 되면 뒤틀기' : '레이아웃: 기울어진 면 위에 사각형을 그리세요')
      : '뒤틀기: 모서리를 끌어 원근을 바꾸세요 · Shift+클릭으로 가장자리 직선화 · Enter 적용 · Esc 취소';
    g.font = '12px system-ui, sans-serif';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,.7)';
    g.fillStyle = '#fff';
    g.strokeText(label, 30, 40);
    g.fillText(label, 30, 40);
    g.restore();
  }
}
