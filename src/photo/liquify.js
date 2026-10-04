// Filter ▸ Liquify: push, reconstruct, twirl, pucker, bloat, push left, freeze / thaw mask.
// The picture is edited through a displacement map at preview size (each preview pixel shows the
// source at p + D[p]); OK scales the map up and resamples the full-size layer once.

import { h, clamp } from '../util.js';
import { toast, openModal } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { applyToLayer } from './pdialogs.js';

const TOOLS = [
  ['warp', '뒤틀기 (밀기)', 'W', '<path d="M2.5 11c2.5 0 3-6 6-6s3 3 5 3"/><path d="M11 5.5 13.5 8 11 10.5"/>'],
  ['reconstruct', '재구성 (되돌리기)', 'R', '<path d="M3.5 6.5A5 5 0 1 1 3 9M3.5 3v3.5H7"/>'],
  ['twirl', '시계 방향 돌리기 (Alt: 반대)', 'C', '<path d="M8 8a1.5 1.5 0 1 1 1.5 1.5A3 3 0 1 1 12.5 6.5 4.5 4.5 0 1 1 8 3.5"/>'],
  ['pucker', '오목 (작게)', 'S', '<circle cx="8" cy="8" r="5.5"/><path d="M8 3.5v2.5M8 10v2.5M3.5 8H6M10 8h2.5"/>'],
  ['bloat', '볼록 (크게)', 'B', '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>'],
  ['pushLeft', '왼쪽 밀기', 'O', '<path d="M3 4h10M3 8h10M3 12h10"/><path d="M6 2 3 4l3 2"/>'],
  ['freeze', '마스크 고정 (못 움직이게)', 'F', '<path d="M8 2v12M3 5l10 6M13 5 3 11"/>'],
  ['thaw', '마스크 풀기', 'D', '<path d="M8 2v12M3 5l10 6M13 5 3 11"/><path d="M2 14 14 2"/>'],
];

const svg = (p) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.3');
  s.setAttribute('stroke-linecap', 'round');
  s.innerHTML = p;
  return s;
};

/** Bilinear sample of a 2-channel field at (x, y). */
function field2(D, w, hh, x, y, o) {
  x = clamp(x, 0, w - 1.001);
  y = clamp(y, 0, hh - 1.001);
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = (y0 * w + x0) * 2;
  const j = i + 2;
  const m = i + w * 2;
  const n = m + 2;
  o[0] = (D[i] * (1 - fx) + D[j] * fx) * (1 - fy) + (D[m] * (1 - fx) + D[n] * fx) * fy;
  o[1] = (D[i + 1] * (1 - fx) + D[j + 1] * fx) * (1 - fy) + (D[m + 1] * (1 - fx) + D[n + 1] * fx) * fy;
}

/** Resample src (RGBA w×h) through the map: out[p] = src[p + D(p)·k], D at grid size gw×gh. */
function warpImage(src, w, hh, D, gw, gh) {
  const out = new ImageData(w, hh);
  const o = out.data;
  const sx = gw / w;
  const sy = gh / hh;
  const v = [0, 0];
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      field2(D, gw, gh, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, v);
      let px = x + v[0] / sx;
      let py = y + v[1] / sy;
      px = clamp(px, 0, w - 1.001);
      py = clamp(py, 0, hh - 1.001);
      const x0 = px | 0;
      const y0 = py | 0;
      const fx = px - x0;
      const fy = py - y0;
      const i = (y0 * w + x0) * 4;
      const j = i + 4;
      const m = i + w * 4;
      const n = m + 4;
      const k = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) o[k + c] = (src[i + c] * (1 - fx) + src[j + c] * fx) * (1 - fy) + (src[m + c] * (1 - fx) + src[n + c] * fx) * fy;
    }
  }
  return out;
}

export function liquifyDialog(P) {
  const doc = P.doc;
  const l = doc?.active;
  if (!l || l.kind !== 'raster' || !l.canvas) return toast('이미지(일반) 레이어를 고르세요. 글자·모양·고급 개체는 래스터화한 뒤 쓰세요.');
  const full = l.canvas;
  const W = full.width;
  const H = full.height;
  const s = Math.min(1, 900 / W, 620 / H);
  const pw = Math.max(1, Math.round(W * s));
  const ph = Math.max(1, Math.round(H * s));
  const small = makeCanvas(pw, ph);
  small.getContext('2d').drawImage(full, 0, 0, pw, ph);
  const src = small.getContext('2d').getImageData(0, 0, pw, ph).data;
  let D = new Float32Array(pw * ph * 2);
  const F = new Float32Array(pw * ph);
  const undo = [];

  const st = { tool: 'warp', size: Math.round(Math.min(pw, ph) / 6), pressure: 50, density: 50, showMask: true };
  const view = h('canvas.lq-view', { width: pw, height: ph });
  const vg = view.getContext('2d');
  const over = h('canvas.lq-over', { width: pw, height: ph });
  const og = over.getContext('2d');
  const img = vg.createImageData(pw, ph);

  const render = (x0 = 0, y0 = 0, x1 = pw, y1 = ph) => {
    x0 = clamp(Math.floor(x0), 0, pw);
    y0 = clamp(Math.floor(y0), 0, ph);
    x1 = clamp(Math.ceil(x1), 0, pw);
    y1 = clamp(Math.ceil(y1), 0, ph);
    const o = img.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * pw + x;
        const px = clamp(x + D[p * 2], 0, pw - 1.001);
        const py = clamp(y + D[p * 2 + 1], 0, ph - 1.001);
        const xi = px | 0;
        const yi = py | 0;
        const fx = px - xi;
        const fy = py - yi;
        const i = (yi * pw + xi) * 4;
        const j = i + 4;
        const m = i + pw * 4;
        const n = m + 4;
        const k = p * 4;
        for (let c = 0; c < 4; c++) o[k + c] = (src[i + c] * (1 - fx) + src[j + c] * fx) * (1 - fy) + (src[m + c] * (1 - fx) + src[n + c] * fx) * fy;
        if (st.showMask && F[p] > 0) {
          const a = F[p] * 0.55;
          o[k] = o[k] * (1 - a) + 230 * a;
          o[k + 1] *= 1 - a;
          o[k + 2] *= 1 - a;
          o[k + 3] = Math.max(o[k + 3], 255 * a);
        }
      }
    }
    vg.putImageData(img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  };

  // ---- brush
  const tmp = [0, 0];
  const dab = (cx, cy, vx, vy, alt) => {
    const R = st.size / 2;
    const x0 = Math.max(0, Math.floor(cx - R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(pw, Math.ceil(cx + R));
    const y1 = Math.min(ph, Math.ceil(cy + R));
    if (x1 <= x0 || y1 <= y0) return;
    const old = D;
    const nD = st.tool === 'freeze' || st.tool === 'thaw' ? D : D.slice();
    const pr = st.pressure / 100;
    const hard = st.density / 100;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const r = Math.hypot(dx, dy);
        if (r >= R) continue;
        // falloff: density = how much of the brush works at full strength
        const t = r / R;
        let wgt = t <= hard * 0.6 ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * ((t - hard * 0.6) / (1 - hard * 0.6)));
        const p = y * pw + x;
        if (st.tool === 'freeze') {
          F[p] = Math.min(1, F[p] + wgt * pr);
          continue;
        }
        if (st.tool === 'thaw') {
          F[p] = Math.max(0, F[p] - wgt * pr);
          continue;
        }
        wgt *= 1 - F[p];
        if (wgt <= 0) continue;
        let sx = x;
        let sy = y;
        switch (st.tool) {
          case 'warp':
            sx -= vx * wgt * pr * 1.6;
            sy -= vy * wgt * pr * 1.6;
            break;
          case 'pushLeft': {
            const k = wgt * pr * 0.8 * (alt ? -1 : 1);
            sx -= vy * k;
            sy += vx * k;
            break;
          }
          case 'twirl': {
            const a = wgt * pr * 0.08 * (alt ? -1 : 1);
            sx = cx + dx * Math.cos(a) + dy * Math.sin(a) - 0.5;
            sy = cy - dx * Math.sin(a) + dy * Math.cos(a) - 0.5;
            break;
          }
          case 'pucker':
          case 'bloat': {
            const k = 1 + (st.tool === 'pucker' ? 1 : -1) * (alt ? -1 : 1) * wgt * pr * 0.06;
            sx = cx + dx * k - 0.5;
            sy = cy + dy * k - 0.5;
            break;
          }
          case 'reconstruct':
            nD[p * 2] = old[p * 2] * (1 - wgt * pr * 0.25);
            nD[p * 2 + 1] = old[p * 2 + 1] * (1 - wgt * pr * 0.25);
            continue;
          default:
        }
        // new map at p = old map at the moved point
        field2(old, pw, ph, sx, sy, tmp);
        nD[p * 2] = sx - x + tmp[0];
        nD[p * 2 + 1] = sy - y + tmp[1];
      }
    }
    D = nD;
    render(x0, y0, x1, y1);
  };

  // ---- pointer
  let drag = null;
  let timer = null;
  const toPx = (e) => {
    const r = view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * pw, y: ((e.clientY - r.top) / r.height) * ph };
  };
  const drawCursor = (q) => {
    og.clearRect(0, 0, pw, ph);
    if (!q) return;
    const sc = view.getBoundingClientRect().width / pw || 1;
    og.lineWidth = 1 / sc;
    for (const [c, off] of [['rgba(0,0,0,.7)', 0.5], ['#fff', 0]]) {
      og.strokeStyle = c;
      og.beginPath();
      og.arc(q.x, q.y, st.size / 2 + off / sc, 0, Math.PI * 2);
      og.stroke();
    }
  };
  const tick = () => {
    // tools that work while held still (twirl, pucker, bloat, reconstruct)
    if (!drag || ['warp', 'pushLeft'].includes(st.tool)) return;
    dab(drag.p.x, drag.p.y, 0, 0, drag.alt);
  };
  over.addEventListener('pointerdown', (e) => {
    over.setPointerCapture(e.pointerId);
    undo.push({ D: D.slice(), F: F.slice() });
    if (undo.length > 20) undo.shift();
    const p = toPx(e);
    drag = { p, alt: e.altKey };
    dab(p.x, p.y, 0, 0, e.altKey);
    clearInterval(timer);
    timer = setInterval(tick, 40);
  });
  over.addEventListener('pointermove', (e) => {
    const p = toPx(e);
    drawCursor(p);
    if (!drag) return;
    const vx = p.x - drag.p.x;
    const vy = p.y - drag.p.y;
    const d = Math.hypot(vx, vy);
    if (d < 0.5) return;
    // dabs along the movement, a quarter brush apart
    const step = Math.max(1, st.size / 8);
    const n = Math.ceil(d / step);
    for (let i = 1; i <= n; i++) dab(drag.p.x + (vx * i) / n, drag.p.y + (vy * i) / n, vx / n, vy / n, e.altKey);
    drag.p = p;
    drag.alt = e.altKey;
  });
  const end = () => {
    drag = null;
    clearInterval(timer);
  };
  over.addEventListener('pointerup', end);
  over.addEventListener('pointercancel', end);
  over.addEventListener('pointerleave', () => !drag && drawCursor(null));
  over.addEventListener('wheel', (e) => {
    e.preventDefault();
    st.size = clamp(Math.round(st.size * (e.deltaY < 0 ? 1.1 : 0.9)), 4, Math.max(pw, ph));
    sync();
    drawCursor(toPx(e));
  }, { passive: false });

  // ---- side panels
  const toolBtns = TOOLS.map(([id, name, key, icon]) => {
    const b = h('button.lq-tool', { title: `${name} (${key})`, 'aria-label': name, onclick: () => setTool(id) }, svg(icon));
    b.dataset.id = id;
    return b;
  });
  const setTool = (id) => {
    st.tool = id;
    for (const b of toolBtns) b.classList.toggle('on', b.dataset.id === id);
    toolName.textContent = TOOLS.find((t) => t[0] === id)[1];
  };
  const toolName = h('div.lq-toolname');
  const num = (key, label, min, max) => {
    const r = h('input', { type: 'range', min, max, value: st[key] });
    const n = h('input.ph-num', { type: 'number', min, max, value: st[key] });
    const set = (v) => {
      st[key] = clamp(Math.round(+v), min, max);
      r.value = st[key];
      n.value = st[key];
    };
    r.addEventListener('input', () => set(r.value));
    n.addEventListener('change', () => set(n.value));
    return { el: h('label.lq-row', h('span', label), r, n), set };
  };
  const size = num('size', '브러시 크기', 4, Math.max(pw, ph));
  const pressure = num('pressure', '압력 (세기)', 1, 100);
  const density = num('density', '밀도 (가장자리)', 0, 100);
  const sync = () => size.set(st.size);
  const maskChk = h('input', { type: 'checkbox', checked: true });
  maskChk.addEventListener('change', () => {
    st.showMask = maskChk.checked;
    render();
  });
  const btn = (label, fn) => h('button.small', { onclick: fn }, label);
  const side = h('div.lq-side',
    toolName,
    size.el, pressure.el, density.el,
    h('label.lq-row', maskChk, h('span', '고정 마스크 보이기')),
    h('div.lq-btns',
      btn('되돌리기 (Ctrl+Z)', () => doUndo()),
      btn('모두 재구성', () => {
        undo.push({ D: D.slice(), F: F.slice() });
        D = new Float32Array(pw * ph * 2);
        render();
      }),
      btn('마스크 모두 지우기', () => {
        F.fill(0);
        render();
      }),
      btn('마스크 반전', () => {
        for (let i = 0; i < F.length; i++) F[i] = 1 - F[i];
        render();
      })),
    h('div.note', '끌어서 밀고, 돌리기·오목·볼록·재구성은 누르고 있으면 계속 작용해요. Alt를 누르면 반대로 움직여요. 마우스 휠로 브러시 크기를 바꿔요.'));
  const doUndo = () => {
    const u = undo.pop();
    if (!u) return;
    D = u.D;
    F.set(u.F);
    render();
  };
  const onKey = (e) => {
    if (e.target.tagName === 'INPUT' || e.key === 'Escape' || e.key === 'Enter') return;
    // the editor behind the dialog must not see these keys (Ctrl+Z would undo the document)
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }
    const t = TOOLS.find((x) => x[2].toLowerCase() === k);
    if (t && !e.ctrlKey && !e.metaKey) setTool(t[0]);
    if (k === '[' || k === ']') {
      st.size = clamp(Math.round(st.size * (k === ']' ? 1.15 : 0.87)), 4, Math.max(pw, ph));
      sync();
    }
  };
  window.addEventListener('keydown', onKey, true);

  const stage = h('div.lq-stage', h('div.lq-canvas', view, over));
  setTool('warp');
  render();
  openModal({
    title: '픽셀 유동화',
    width: 'min(1240px, 97vw)',
    body: [h('div.lq', h('div.lq-tools', toolBtns), stage, side)],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        if (!D.some((v) => Math.abs(v) > 0.01)) return;
        toast('픽셀 유동화 적용 중…');
        const fd = full.getContext('2d').getImageData(0, 0, W, H).data;
        const out = warpImage(fd, W, H, D, pw, ph);
        P.run('픽셀 유동화', () => applyToLayer(P, () => {
          const c = makeCanvas(W, H);
          c.getContext('2d').putImageData(out, 0, 0);
          return c;
        }));
      },
    }],
    onClose: () => {
      window.removeEventListener('keydown', onKey, true);
      clearInterval(timer);
    },
  });
  return undefined;
}
