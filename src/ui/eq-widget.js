// Frequency-response curve for the EQ audio effects in Effect Controls (파라메트릭 이퀄라이저, 그래픽
// 이퀄라이저, 베이스, 고음). Drag a point to change its frequency and gain, use the wheel over a point
// for Q, double-click a parametric band to switch it on or off. The curve is computed with the same
// biquad settings the audio chain uses (eqSpecs), so what is drawn is what is heard.

import { store } from '../store.js';
import * as edit from '../edit.js';
import { evalEffect } from '../model.js';
import { eqSpecs, eqOutputDb, PEQ_BANDS, GEQ_FREQS } from '../audio-fx2.js';
import { clamp } from '../util.js';

const F_MIN = 20;
const F_MAX = 20000;
const DB_RANGE = 24;
const POINTS = 240;
const BAND_COLORS = ['#f87171', '#fbbf24', '#4ade80', '#60a5fa', '#c084fc'];

let actx = null;
let freqs = null;
const nodes = [];
function responseDb(specs, outDb) {
  if (!actx) {
    actx = new OfflineAudioContext(1, 128, 48000);
    freqs = new Float32Array(POINTS);
    for (let i = 0; i < POINTS; i++) freqs[i] = F_MIN * (F_MAX / F_MIN) ** (i / (POINTS - 1));
  }
  const total = new Float32Array(POINTS).fill(outDb);
  const mag = new Float32Array(POINTS);
  const ph = new Float32Array(POINTS);
  specs.forEach((s, i) => {
    if (s.type === 'peaking' && !s.gain) return; // flat
    if (!nodes[i]) nodes[i] = actx.createBiquadFilter();
    const f = nodes[i];
    f.type = s.type;
    f.frequency.value = clamp(s.freq, 10, 23000);
    f.Q.value = s.type === 'lowpass' || s.type === 'highpass' ? 20 * Math.log10(Math.max(1e-3, s.q)) : s.q;
    f.gain.value = s.gain || 0;
    f.getFrequencyResponse(freqs, mag, ph);
    for (let k = 0; k < POINTS; k++) total[k] += 20 * Math.log10(Math.max(1e-6, mag[k]));
  });
  return total;
}

/** Draggable points of an EQ effect: [{key prefix, freq key, gain key, q key, color, label, on}]. */
function handles(type, v) {
  if (type === 'parametricEq') {
    const out = PEQ_BANDS.map((_, i) => {
      const n = i + 1;
      return { n, label: String(n), fKey: `b${n}Freq`, gKey: `b${n}Gain`, qKey: `b${n}Q`, onKey: `b${n}On`, color: BAND_COLORS[i], on: !!v[`b${n}On`] };
    });
    out.push({ n: 'hp', label: 'HP', fKey: 'hpFreq', onKey: 'hpOn', color: '#9ca3af', on: !!v.hpOn, fixedGain: 0 });
    out.push({ n: 'lp', label: 'LP', fKey: 'lpFreq', onKey: 'lpOn', color: '#9ca3af', on: !!v.lpOn, fixedGain: 0 });
    return out;
  }
  if (type === 'graphicEq') return GEQ_FREQS.map((f, i) => ({ n: i, label: '', fixedFreq: f, gKey: `g${i}`, color: '#60a5fa', on: true }));
  return [{ n: 0, label: '', fKey: 'freq', gKey: 'boost', color: '#60a5fa', on: true }];
}

export function mountEqWidget(el, { clipId, fxId, type }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'eq-canvas';
  canvas.setAttribute('aria-label', 'EQ 곡선: 점을 끌어 주파수와 게인을 바꿉니다');
  canvas.style.cssText = 'display:block;width:100%;height:150px;touch-action:none;cursor:crosshair;border-radius:4px;background:#14171c';
  const hint = document.createElement('div');
  hint.className = 'note';
  hint.style.cssText = 'font-size:11px;margin-top:4px';
  hint.textContent = type === 'parametricEq'
    ? '점을 끌면 주파수·게인, 휠은 Q(폭), 두 번 클릭은 밴드 켜기/끄기'
    : type === 'graphicEq' ? '막대 점을 위아래로 끌어 대역별 게인을 바꿉니다' : '점을 끌어 주파수와 부스트를 바꿉니다';
  el.append(canvas, hint);

  const fx = () => store.seq?.clips[clipId]?.effects.find((e) => e.id === fxId);
  const clip = () => store.seq?.clips[clipId];
  const tLocal = () => {
    const c = clip();
    return c ? clamp(store.ui.playhead - c.start, 0, c.duration) : 0;
  };
  const values = () => {
    const f = fx();
    return f ? evalEffect(f, tLocal()) : null;
  };
  const geom = () => {
    const r = canvas.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top, pad: 6 };
  };
  const xOf = (f, g) => g.pad + ((g.w - 2 * g.pad) * Math.log(f / F_MIN)) / Math.log(F_MAX / F_MIN);
  const fOf = (x, g) => F_MIN * (F_MAX / F_MIN) ** clamp((x - g.pad) / (g.w - 2 * g.pad), 0, 1);
  const yOf = (db, g) => g.h / 2 - (clamp(db, -DB_RANGE, DB_RANGE) / DB_RANGE) * (g.h / 2 - g.pad);
  const dbOf = (y, g) => ((g.h / 2 - y) / (g.h / 2 - g.pad)) * DB_RANGE;

  let lastSig = '';
  let hot = null;
  function draw() {
    const v = values();
    if (!v) return;
    const g = geom();
    if (g.w < 20) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(g.w * dpr) || canvas.height !== Math.round(g.h * dpr)) {
      canvas.width = Math.round(g.w * dpr);
      canvas.height = Math.round(g.h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xOf(f, g)) + 0.5;
      ctx.strokeStyle = '#262b33';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, g.h);
      ctx.stroke();
      ctx.fillStyle = '#6b7280';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, g.h - 3);
    }
    for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
      const y = Math.round(yOf(db, g)) + 0.5;
      ctx.strokeStyle = db === 0 ? '#3b4250' : '#262b33';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(g.w, y);
      ctx.stroke();
      if (db) {
        ctx.fillStyle = '#6b7280';
        ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 2, y - 2);
      }
    }
    const curve = responseDb(eqSpecs(type, v), eqOutputDb(type, v));
    ctx.beginPath();
    for (let k = 0; k < POINTS; k++) {
      const x = xOf(freqs[k], g);
      const y = yOf(curve[k], g);
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(xOf(F_MAX, g), yOf(0, g));
    ctx.lineTo(xOf(F_MIN, g), yOf(0, g));
    ctx.closePath();
    ctx.fillStyle = 'rgba(125, 211, 252, 0.10)';
    ctx.fill();
    for (const hd of handles(type, v)) {
      const { x, y } = handlePos(hd, v, g);
      ctx.beginPath();
      ctx.arc(x, y, hot === hd.n ? 7.5 : 6, 0, Math.PI * 2);
      ctx.fillStyle = hd.on ? hd.color : '#14171c';
      ctx.strokeStyle = hd.color;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      if (hd.label) {
        ctx.fillStyle = hd.on ? '#0b0d10' : hd.color;
        ctx.textAlign = 'center';
        ctx.fillText(hd.label.length > 1 ? hd.label[0] : hd.label, x, y + 3.5);
        ctx.textAlign = 'start';
      }
    }
  }

  function handlePos(hd, v, g) {
    const f = hd.fixedFreq ?? v[hd.fKey];
    const db = hd.fixedGain ?? v[hd.gKey] ?? 0;
    return { x: xOf(f, g), y: yOf(db, g) };
  }

  function pick(e) {
    const v = values();
    if (!v) return null;
    const g = geom();
    const px = e.clientX - g.left;
    const py = e.clientY - g.top;
    let best = null;
    let bestD = 14 * 14;
    for (const hd of handles(type, v)) {
      const { x, y } = handlePos(hd, v, g);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = hd;
      }
    }
    return best;
  }

  const setValues = (pairs) => {
    const c = clip();
    const f = fx();
    if (!c || !f) return;
    for (const [k, val] of pairs) if (f.params[k]) edit.rawSetParam(c, f, k, val);
    store.changed();
  };

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hd = pick(e);
    if (!hd) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = { hd, began: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      const hd = pick(e);
      const n = hd ? hd.n : null;
      canvas.style.cursor = hd ? 'grab' : 'crosshair';
      if (n !== hot) {
        hot = n;
        draw();
      }
      return;
    }
    if (!drag.began) {
      store.begin('EQ 변경');
      drag.began = true;
    }
    const g = geom();
    const { hd } = drag;
    const pairs = [];
    if (hd.fKey && hd.fixedFreq == null) pairs.push([hd.fKey, Math.round(fOf(e.clientX - g.left, g))]);
    if (hd.gKey && hd.fixedGain == null) pairs.push([hd.gKey, Math.round(dbOf(e.clientY - g.top, g) * 10) / 10]);
    if (hd.onKey && !values()?.[hd.onKey]) pairs.push([hd.onKey, true]);
    setValues(pairs);
  });
  const end = () => {
    if (drag?.began) store.commit();
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const hd = pick(e);
    const f = fx();
    if (!hd?.onKey || !f) return;
    store.transact(hd.on ? 'EQ 밴드 끄기' : 'EQ 밴드 켜기', () => {
      const ff = fx();
      if (ff) ff.params[hd.onKey].value = !hd.on;
    });
  });
  let wheelTimer = 0;
  canvas.addEventListener('wheel', (e) => {
    const hd = pick(e);
    if (!hd?.qKey) return;
    e.preventDefault();
    const v = values();
    if (!v) return;
    if (!wheelTimer) store.begin('EQ Q 변경');
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = 0;
      store.commit();
    }, 400);
    const q = clamp((v[hd.qKey] || 1) * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 30);
    setValues([[hd.qKey, Math.round(q * 100) / 100]]);
  }, { passive: false });

  // redraw while the widget is on screen and its values (or size) change
  let seen = false;
  const born = performance.now();
  const loop = () => {
    if (!el.isConnected) {
      if (seen || performance.now() - born > 5000) return;
    } else seen = true;
    const v = values();
    const r = canvas.getBoundingClientRect();
    const sig = v ? `${JSON.stringify(v)}|${r.width}|${r.height}|${hot}` : '';
    if (sig !== lastSig) {
      lastSig = sig;
      draw();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
