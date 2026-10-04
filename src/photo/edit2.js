// Edit ▸ Content-Aware Scale (seam carving), Edit ▸ Puppet Warp (pins, rigid moving least squares),
// Edit ▸ Fade (the last edit's strength and blend mode), Image ▸ Duplicate and Image ▸ Reveal All.

import { h, clamp } from '../util.js';
import { toast, openModal, formRow } from '../ui/common.js';
import { makeCanvas, PhotoDoc } from './doc.js';
import { applyToLayer } from './pdialogs.js';

// ---------------------------------------------------------------- shared

/** Resample src through an absolute source-coordinate field F (gw×gh, 2 per cell) over w×h. */
function remapField(src, w, hh, F, gw, gh) {
  const out = new ImageData(w, hh);
  const o = out.data;
  const sx = (gw - 1) / Math.max(1, w - 1);
  const sy = (gh - 1) / Math.max(1, hh - 1);
  for (let y = 0; y < hh; y++) {
    const gy = y * sy;
    const y0 = Math.min(gh - 2, gy | 0);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = x * sx;
      const x0 = Math.min(gw - 2, gx | 0);
      const fx = gx - x0;
      const i = (y0 * gw + x0) * 2;
      const j = i + 2;
      const m = i + gw * 2;
      const n = m + 2;
      let px = (F[i] * (1 - fx) + F[j] * fx) * (1 - fy) + (F[m] * (1 - fx) + F[n] * fx) * fy;
      let py = (F[i + 1] * (1 - fx) + F[j + 1] * fx) * (1 - fy) + (F[m + 1] * (1 - fx) + F[n + 1] * fx) * fy;
      const k = (y * w + x) * 4;
      if (px < -0.5 || py < -0.5 || px > w - 0.5 || py > hh - 0.5) continue;
      px = clamp(px, 0, w - 1.001);
      py = clamp(py, 0, hh - 1.001);
      const xi = px | 0;
      const yi = py | 0;
      const ax = px - xi;
      const ay = py - yi;
      const a = (yi * w + xi) * 4;
      const b = a + 4;
      const c = a + w * 4;
      const d = c + 4;
      for (let ch = 0; ch < 4; ch++) o[k + ch] = (src[a + ch] * (1 - ax) + src[b + ch] * ax) * (1 - ay) + (src[c + ch] * (1 - ax) + src[d + ch] * ax) * ay;
    }
  }
  return out;
}

const needLayer = (P) => {
  const l = P.doc?.active;
  if (!l || l.kind !== 'raster' || !l.canvas) {
    toast('이미지(일반) 레이어를 고르세요. 글자·모양·고급 개체는 래스터화한 뒤 쓰세요.');
    return null;
  }
  return l;
};

// ---------------------------------------------------------------- content-aware scale

/** Energy of a w×h RGBA image: gradient magnitude plus protection. */
function energyOf(d, w, hh, protect, skin) {
  const E = new Float32Array(w * hh);
  const L = new Float32Array(w * hh);
  for (let i = 0; i < w * hh; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2] + d[i * 4 + 3] * 0.3;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = L[y * w + Math.min(w - 1, x + 1)] - L[y * w + Math.max(0, x - 1)];
      const gy = L[Math.min(hh - 1, y + 1) * w + x] - L[Math.max(0, y - 1) * w + x];
      let e = Math.abs(gx) + Math.abs(gy);
      if (protect && protect[i] > 127) e += 1e5;
      if (skin) {
        const r = d[i * 4];
        const g = d[i * 4 + 1];
        const b = d[i * 4 + 2];
        // a common skin-tone rule of thumb (RGB)
        if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15) e += 3e3;
      }
      E[i] = e;
    }
  }
  return E;
}

/**
 * Column orders for seam carving at low resolution: removes k vertical seams and returns, per row,
 * the original column indices of the removed seams (in removal order).
 */
function findSeams(E0, w, hh, k) {
  let w2 = w;
  const E = E0.slice();
  const idx = new Int32Array(w * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) idx[y * w + x] = x;
  const removed = Array.from({ length: hh }, () => []);
  const M = new Float32Array(w * hh);
  const seam = new Int32Array(hh);
  for (let s = 0; s < k && w2 > 2; s++) {
    for (let x = 0; x < w2; x++) M[x] = E[x];
    for (let y = 1; y < hh; y++) {
      for (let x = 0; x < w2; x++) {
        const up = M[(y - 1) * w + x];
        const l = x > 0 ? M[(y - 1) * w + x - 1] : Infinity;
        const r = x < w2 - 1 ? M[(y - 1) * w + x + 1] : Infinity;
        M[y * w + x] = E[y * w + x] + Math.min(up, l, r);
      }
    }
    let bx = 0;
    for (let x = 1; x < w2; x++) if (M[(hh - 1) * w + x] < M[(hh - 1) * w + bx]) bx = x;
    seam[hh - 1] = bx;
    for (let y = hh - 2; y >= 0; y--) {
      const x = seam[y + 1];
      let b = x;
      if (x > 0 && M[y * w + x - 1] < M[y * w + b]) b = x - 1;
      if (x < w2 - 1 && M[y * w + x + 1] < M[y * w + b]) b = x + 1;
      seam[y] = b;
    }
    for (let y = 0; y < hh; y++) {
      const x = seam[y];
      removed[y].push(idx[y * w + x]);
      for (let i = x; i < w2 - 1; i++) {
        E[y * w + i] = E[y * w + i + 1];
        idx[y * w + i] = idx[y * w + i + 1];
      }
      // neighbours of a removed seam get a little more energy so seams spread out
      if (x < w2 - 1) E[y * w + x] += 2;
      if (x > 0) E[y * w + x - 1] += 2;
    }
    w2--;
  }
  return removed;
}

/** Width change of an RGBA image (W×H) to newW with seams found at low resolution. */
function carveWidth(src, W, H, newW, protect, skin) {
  if (newW === W) return { data: src, w: W };
  const k = Math.min(1, 420 / W, 360 / H);
  const lw = Math.max(3, Math.round(W * k));
  const lh = Math.max(3, Math.round(H * k));
  const c = makeCanvas(W, H);
  c.getContext('2d').putImageData(new ImageData(src, W, H), 0, 0);
  const sm = makeCanvas(lw, lh);
  sm.getContext('2d').drawImage(c, 0, 0, lw, lh);
  const ld = sm.getContext('2d').getImageData(0, 0, lw, lh).data;
  let lp = null;
  if (protect) {
    const pc = makeCanvas(W, H);
    pc.getContext('2d').putImageData(new ImageData(protect, W, H), 0, 0);
    const ps = makeCanvas(lw, lh);
    ps.getContext('2d').drawImage(pc, 0, 0, lw, lh);
    const pd = ps.getContext('2d').getImageData(0, 0, lw, lh).data;
    lp = new Uint8Array(lw * lh);
    for (let i = 0; i < lp.length; i++) lp[i] = pd[i * 4 + 3];
  }
  const E = energyOf(ld, lw, lh, lp, skin);
  // each low-resolution seam stands for `span` full-size columns
  const span = Math.max(1, Math.floor(W / lw));
  const removed = findSeams(E, lw, lh, Math.min(Math.round(Math.abs(newW - W) / span), lw - 3));
  const out = new Uint8ClampedArray(newW * H * 4);
  const grow = newW > W;
  // every seam takes (or doubles) the same number of full-size pixels in every row, centred on
  // the seam, so all rows keep the same length and nothing wobbles; the small rest is a plain stretch
  const count = new Uint8Array(W);
  const cols = [];
  for (let y = 0; y < H; y++) {
    const ly = Math.min(lh - 1, Math.floor((y * lh) / H));
    count.fill(0);
    for (const lx of removed[ly]) {
      const X0 = clamp(Math.round((lx + 0.5) * (W / lw) - span / 2), 0, W - span);
      for (let X = X0; X < X0 + span; X++) count[X]++;
    }
    cols.length = 0;
    for (let X = 0; X < W; X++) {
      if (!grow) {
        if (!count[X]) cols.push(X);
      } else for (let r = 0; r <= count[X]; r++) cols.push(X);
    }
    if (!cols.length) cols.push(0);
    const m = cols.length;
    for (let x = 0; x < newW; x++) {
      const t = ((x + 0.5) * m) / newW - 0.5;
      const i0 = clamp(Math.floor(t), 0, m - 1);
      const i1 = Math.min(m - 1, i0 + 1);
      const f = clamp(t - i0, 0, 1);
      const a = (y * W + cols[i0]) * 4;
      const b = (y * W + cols[i1]) * 4;
      const o = (y * newW + x) * 4;
      for (let ch = 0; ch < 4; ch++) out[o + ch] = src[a + ch] * (1 - f) + src[b + ch] * f;
    }
  }
  return { data: out, w: newW };
}

function transpose(d, w, hh) {
  const o = new Uint8ClampedArray(d.length);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) o[(x * hh + y) * 4 + c] = d[(y * w + x) * 4 + c];
  return o;
}

function contentAwareScale(P) {
  const l = needLayer(P);
  if (!l) return;
  const doc = P.doc;
  const W = l.canvas.width;
  const H = l.canvas.height;
  const wp = h('input', { type: 'number', value: 70, min: 10, max: 300, style: { width: '80px' } });
  const hp = h('input', { type: 'number', value: 100, min: 10, max: 300, style: { width: '80px' } });
  const prot = h('input', { type: 'checkbox', checked: !!doc.selection });
  const skin = h('input', { type: 'checkbox', checked: true });
  const pv = h('canvas', { style: { maxWidth: '100%', background: '#18191c', borderRadius: '6px' } });
  const info = h('div.note');
  const k = Math.min(1, 400 / W, 280 / H);
  const sw = Math.max(4, Math.round(W * k));
  const sh = Math.max(4, Math.round(H * k));
  const small = makeCanvas(sw, sh);
  small.getContext('2d').drawImage(l.canvas, 0, 0, sw, sh);
  const smallD = small.getContext('2d').getImageData(0, 0, sw, sh).data;
  const protectOf = (w, hh) => {
    if (!prot.checked || !doc.selection) return null;
    const c = makeCanvas(w, hh);
    c.getContext('2d').drawImage(doc.selection.canvas, -l.x * (w / W), -l.y * (hh / H), doc.width * (w / W), doc.height * (hh / H));
    return c.getContext('2d').getImageData(0, 0, w, hh).data;
  };
  const run = (d, w, hh, nw, nh) => {
    const p = protectOf(w, hh);
    let r = carveWidth(d, w, hh, nw, p, skin.checked);
    if (nh !== hh) {
      const t = transpose(r.data, r.w, hh);
      // the protected area for the second pass: the mask stretched to the new width (close enough)
      let p2 = null;
      if (p) {
        const pc = makeCanvas(w, hh);
        pc.getContext('2d').putImageData(new ImageData(p, w, hh), 0, 0);
        const ps = makeCanvas(nw, hh);
        ps.getContext('2d').drawImage(pc, 0, 0, nw, hh);
        p2 = transpose(ps.getContext('2d').getImageData(0, 0, nw, hh).data, nw, hh);
      }
      const r2 = carveWidth(t, hh, r.w, nh, p2, skin.checked);
      r = { data: transpose(r2.data, r2.w, r.w), w: r.w };
    }
    return r.data;
  };
  let timer = 0;
  const preview = () => {
    const nw = Math.max(4, Math.round((sw * +wp.value) / 100));
    const nh = Math.max(4, Math.round((sh * +hp.value) / 100));
    const d = run(smallD, sw, sh, nw, nh);
    pv.width = nw;
    pv.height = nh;
    pv.getContext('2d').putImageData(new ImageData(d, nw, nh), 0, 0);
    info.textContent = `결과 크기: ${Math.round((W * +wp.value) / 100)} × ${Math.round((H * +hp.value) / 100)} px (레이어)`;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(preview, 120);
  };
  for (const e of [wp, hp, prot, skin]) e.addEventListener('input', schedule);
  openModal({
    title: '내용 인식 비율',
    width: '480px',
    body: [formRow('폭 (%)', wp), formRow('높이 (%)', hp), h('label.inline', prot, ' 선택 영역 보호 (먼저 지킬 곳을 선택하세요)'), h('label.inline', skin, ' 피부 톤 보호'), pv, info, h('div.note', '사람·물체처럼 중요한 부분은 두고, 하늘·바닥처럼 단순한 부분을 줄이거나 늘려요.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const nw = Math.max(4, Math.round((W * +wp.value) / 100));
        const nh = Math.max(4, Math.round((H * +hp.value) / 100));
        if (nw === W && nh === H) return;
        toast('내용 인식 비율 적용 중…');
        const d = run(l.canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H, nw, nh);
        P.run('내용 인식 비율', () => {
          const c = makeCanvas(nw, nh);
          c.getContext('2d').putImageData(new ImageData(d, nw, nh), 0, 0);
          const cx = l.x + W / 2;
          const cy = l.y + H / 2;
          l.canvas = c;
          l.x = Math.round(cx - nw / 2);
          l.y = Math.round(cy - nh / 2);
          l._styled = null;
          doc.touch(l);
        });
      },
    }],
  });
  preview();
}

// ---------------------------------------------------------------- puppet warp

/** Rigid moving-least-squares map at v (Schaefer et al. 2006): control q → p. */
function mlsRigid(vx, vy, qs, ps, out) {
  const n = qs.length;
  let sw = 0;
  let qx = 0;
  let qy = 0;
  let px = 0;
  let py = 0;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d2 = (qs[i][0] - vx) ** 2 + (qs[i][1] - vy) ** 2;
    if (d2 < 1e-6) {
      out[0] = ps[i][0];
      out[1] = ps[i][1];
      return;
    }
    w[i] = 1 / d2;
    sw += w[i];
    qx += w[i] * qs[i][0];
    qy += w[i] * qs[i][1];
    px += w[i] * ps[i][0];
    py += w[i] * ps[i][1];
  }
  qx /= sw;
  qy /= sw;
  px /= sw;
  py /= sw;
  if (n === 1) {
    out[0] = vx + px - qx;
    out[1] = vy + py - qy;
    return;
  }
  // f(v) = |v - q*| · normalized(Σ ŵ p̂ᵢ Aᵢ) + p*
  let fx = 0;
  let fy = 0;
  const dx = vx - qx;
  const dy = vy - qy;
  for (let i = 0; i < n; i++) {
    const hx = qs[i][0] - qx;
    const hy = qs[i][1] - qy;
    const bx = ps[i][0] - px;
    const by = ps[i][1] - py;
    // Aᵢ = wᵢ [q̂ ; -q̂⊥] [v-q* ; -(v-q*)⊥]ᵀ applied to p̂
    const a = hx * dx + hy * dy;
    const b = hx * dy - hy * dx;
    fx += w[i] * (bx * a - by * b);
    fy += w[i] * (bx * b + by * a);
  }
  const len = Math.hypot(fx, fy) || 1;
  const dl = Math.hypot(dx, dy);
  out[0] = (fx / len) * dl + px;
  out[1] = (fy / len) * dl + py;
}

function puppetWarp(P) {
  const l = needLayer(P);
  if (!l) return;
  const full = l.canvas;
  const W = full.width;
  const H = full.height;
  const s = Math.min(1, 860 / W, 600 / H);
  const pw = Math.max(1, Math.round(W * s));
  const ph = Math.max(1, Math.round(H * s));
  const small = makeCanvas(pw, ph);
  small.getContext('2d').drawImage(full, 0, 0, pw, ph);
  const src = small.getContext('2d').getImageData(0, 0, pw, ph).data;
  const pins = []; // { o: [x,y] original, c: [x,y] current } in preview px
  const view = h('canvas.lq-view', { width: pw, height: ph });
  const over = h('canvas.lq-over', { width: pw, height: ph, style: { cursor: 'crosshair' } });
  const vg = view.getContext('2d');
  const og = over.getContext('2d');
  const showMesh = h('input', { type: 'checkbox', checked: true });
  const G = 10; // grid step (preview px)
  const field = (w, hh, scale) => {
    const gw = Math.ceil(w / (G * scale)) + 1;
    const gh = Math.ceil(hh / (G * scale)) + 1;
    const F = new Float32Array(gw * gh * 2);
    const qs = pins.map((p) => [p.c[0] / s * scale, p.c[1] / s * scale]);
    const ps = pins.map((p) => [p.o[0] / s * scale, p.o[1] / s * scale]);
    const o = [0, 0];
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const x = (i * (w - 1)) / (gw - 1);
        const y = (j * (hh - 1)) / (gh - 1);
        if (pins.length) mlsRigid(x, y, qs, ps, o);
        else {
          o[0] = x;
          o[1] = y;
        }
        F[(j * gw + i) * 2] = o[0];
        F[(j * gw + i) * 2 + 1] = o[1];
      }
    }
    return { F, gw, gh };
  };
  const render = () => {
    const { F, gw, gh } = field(pw, ph, s);
    vg.putImageData(remapField(src, pw, ph, F, gw, gh), 0, 0);
    og.clearRect(0, 0, pw, ph);
    if (showMesh.checked) {
      og.strokeStyle = 'rgba(80,160,255,.35)';
      og.beginPath();
      // the mesh drawn where the original grid points land
      const step = 24;
      const o = [0, 0];
      const qs = pins.map((p) => p.o);
      const ps = pins.map((p) => p.c);
      for (let y = 0; y <= ph; y += step) {
        for (let x = 0; x <= pw; x += 4) {
          if (pins.length) mlsRigid(x, y, qs, ps, o);
          else [o[0], o[1]] = [x, y];
          if (x === 0) og.moveTo(o[0], o[1]);
          else og.lineTo(o[0], o[1]);
        }
      }
      for (let x = 0; x <= pw; x += step) {
        for (let y = 0; y <= ph; y += 4) {
          if (pins.length) mlsRigid(x, y, qs, ps, o);
          else [o[0], o[1]] = [x, y];
          if (y === 0) og.moveTo(o[0], o[1]);
          else og.lineTo(o[0], o[1]);
        }
      }
      og.stroke();
    }
    const sc = view.getBoundingClientRect().width / pw || 1;
    for (const p of pins) {
      og.fillStyle = p === drag ? '#ffcc00' : '#fff';
      og.strokeStyle = '#000';
      og.lineWidth = 1.5 / sc;
      og.beginPath();
      og.arc(p.c[0], p.c[1], 5 / sc, 0, Math.PI * 2);
      og.fill();
      og.stroke();
    }
  };
  let drag = null;
  let raf = 0;
  const toPx = (e) => {
    const r = view.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * pw, ((e.clientY - r.top) / r.height) * ph];
  };
  over.addEventListener('pointerdown', (e) => {
    over.setPointerCapture(e.pointerId);
    const q = toPx(e);
    const sc = view.getBoundingClientRect().width / pw || 1;
    const hit = pins.find((p) => Math.hypot(p.c[0] - q[0], p.c[1] - q[1]) < 9 / sc);
    if (e.altKey && hit) {
      pins.splice(pins.indexOf(hit), 1);
      render();
      return;
    }
    // a new pin goes where the picture is now: back-map through the current warp
    if (!hit) {
      const o = [q[0], q[1]];
      if (pins.length) mlsRigid(q[0], q[1], pins.map((p) => p.c), pins.map((p) => p.o), o);
      pins.push({ o, c: q });
      drag = pins[pins.length - 1];
    } else drag = hit;
    render();
  });
  over.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.c = toPx(e);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  });
  over.addEventListener('pointerup', () => {
    drag = null;
    render();
  });
  showMesh.addEventListener('change', render);
  openModal({
    title: '퍼펫 뒤틀기',
    width: 'min(1100px, 97vw)',
    body: [h('div.lq', { style: { gridTemplateColumns: 'minmax(0,1fr) 220px' } },
      h('div.lq-stage', h('div.lq-canvas', view, over)),
      h('div.lq-side',
        h('b', '핀으로 자세 바꾸기'),
        h('div.note', '움직이지 않을 곳(관절, 몸통)에 먼저 핀을 여러 개 꽂고, 움직일 곳의 핀을 끌어요. Alt+클릭으로 핀을 지워요.'),
        h('label.lq-row', showMesh, h('span', '메시 보이기')),
        h('div.lq-btns', h('button.small', { onclick: () => { pins.length = 0; render(); } }, '핀 모두 지우기'))))],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        if (!pins.some((p) => Math.hypot(p.o[0] - p.c[0], p.o[1] - p.c[1]) > 0.3)) return;
        toast('퍼펫 뒤틀기 적용 중…');
        const { F, gw, gh } = field(W, H, 1);
        const out = remapField(full.getContext('2d').getImageData(0, 0, W, H).data, W, H, F, gw, gh);
        P.run('퍼펫 뒤틀기', () => applyToLayer(P, () => {
          const c = makeCanvas(W, H);
          c.getContext('2d').putImageData(out, 0, 0);
          return c;
        }));
      },
    }],
  });
  render();
}

// ---------------------------------------------------------------- fade

const FADE_MODES = [['source-over', '표준'], ['multiply', '곱하기'], ['screen', '스크린'], ['overlay', '오버레이'], ['soft-light', '소프트 라이트'], ['hard-light', '하드 라이트'], ['darken', '어둡게 하기'], ['lighten', '밝게 하기'], ['difference', '차이'], ['color', '색상'], ['luminosity', '광도'], ['hue', '색조'], ['saturation', '채도']];

function fadeDialog(P) {
  const doc = P.doc;
  const e = doc?.history.undoStack.at(-1);
  const l = doc?.active;
  const prev = e?.state.layers.find((x) => x.id === l?.id);
  if (!e || !l || l.kind !== 'raster' || !l.canvas || !prev?.canvas || prev.canvas === l.canvas) return toast('희미하게 할 마지막 작업이 없습니다 (필터·조정·칠하기 바로 뒤에 쓰세요)');
  const after = l.canvas;
  const ax = l.x;
  const ay = l.y;
  const before = doc.capture();
  const op = h('input', { type: 'range', min: 0, max: 100, value: 100 });
  const opn = h('span', '100%');
  const mode = h('select', FADE_MODES.map(([v, t]) => h('option', { value: v }, t)));
  const apply = () => {
    opn.textContent = `${op.value}%`;
    const c = makeCanvas(after.width, after.height);
    const g = c.getContext('2d');
    g.drawImage(prev.canvas, prev.x - ax, prev.y - ay);
    g.globalAlpha = +op.value / 100;
    g.globalCompositeOperation = mode.value;
    g.drawImage(after, 0, 0);
    // keep the edited layer's transparency where the edit painted
    l.canvas = c;
    l._styled = null;
    doc.touch(l);
    P.redraw();
  };
  op.addEventListener('input', apply);
  mode.addEventListener('change', apply);
  let ok = false;
  openModal({
    title: `희미하게 하기: ${e.label}`,
    width: '380px',
    body: [formRow('불투명도', op, opn), formRow('모드', mode)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { ok = true; P.commit(`희미하게 하기: ${e.label}`, before); } }],
    onClose: () => {
      if (ok) return;
      doc.restore(before);
      P.afterHistory();
    },
  });
  return undefined;
}

// ---------------------------------------------------------------- install

export function installEdit2(P) {
  const C = P.cmd;
  C.contentAwareScale = () => contentAwareScale(P);
  C.puppetWarp = () => puppetWarp(P);
  C.fade = () => fadeDialog(P);
  C.duplicateDoc = () => {
    const doc = P.doc;
    if (!doc) return;
    const st = doc.capture();
    const d = new PhotoDoc({ name: `${doc.name} 복사`, width: doc.width, height: doc.height, background: null });
    d.restore(st);
    d.name = `${doc.name} 복사`;
    d.saved = false;
    P.openDoc(d);
  };
  C.revealAll = () => {
    const doc = P.doc;
    if (!doc) return undefined;
    let x0 = 0;
    let y0 = 0;
    let x1 = doc.width;
    let y1 = doc.height;
    for (const l of doc.layers) {
      const b = doc.bounds(l);
      if (!b) continue;
      x0 = Math.min(x0, Math.floor(b.x));
      y0 = Math.min(y0, Math.floor(b.y));
      x1 = Math.max(x1, Math.ceil(b.x + b.w));
      y1 = Math.max(y1, Math.ceil(b.y + b.h));
    }
    if (x0 === 0 && y0 === 0 && x1 === doc.width && y1 === doc.height) return toast('캔버스 밖으로 나간 부분이 없습니다');
    P.cropTo({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, false, '모두 나타내기');
    return undefined;
  };
}
