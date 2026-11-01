// Practice media for the Premiere Learn panel (학습), made in the browser: no footage is shipped and
// nothing is downloaded. Each item is drawn on a canvas and synthesised as sound, encoded to a real
// WebM file (VP8 / VP9 video + Opus audio, WebCodecs through the vendored mediabunny muxer) and
// imported into the project bin '연습 파일' like any other file. Finished files are cached in this
// browser (IndexedDB 'montage-practice'), so a lesson opens at once the next time; the Learn panel
// shows how much room they take and can delete them.

import { store } from '../store.js';
import { importFiles, mediaStatus } from '../media.js';
import { uid } from '../util.js';

const MB_URL = '../../vendor/mediabunny/mediabunny.min.mjs';
const SR = 48000;
// pictures are drawn in a 640×360 space and rendered at S times that (960×540)
const W = 640;
const H = 360;
const S = 1.5;
const FPS = 25;
// bump when a generator changes, so cached files are made again
const GEN_VER = 1;
export const PRACTICE_BIN = '연습 파일';

// ---------------------------------------------------------------- small helpers

/** Small seeded random, so a practice file is the same every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** RBJ band-pass (0 dB peak) or low/high-pass biquad, run in place over a range. */
function biquad(type, f, q) {
  const w = (2 * Math.PI * f) / SR;
  const al = Math.sin(w) / (2 * q);
  const cs = Math.cos(w);
  let b0;
  let b1;
  let b2;
  if (type === 'bp') [b0, b1, b2] = [al, 0, -al];
  else if (type === 'lp') [b0, b1, b2] = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2];
  else [b0, b1, b2] = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2];
  const a0 = 1 + al;
  const k = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cs) / a0, a2: (1 - al) / a0 };
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = k.b0 * x + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

function toBuffer(left, right = left) {
  const buf = new AudioBuffer({ length: left.length, numberOfChannels: 2, sampleRate: SR });
  buf.getChannelData(0).set(left);
  buf.getChannelData(1).set(right);
  return buf;
}

function normalize(a, peak) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  if (m > 0) for (let i = 0; i < a.length; i++) a[i] *= peak / m;
  return a;
}

// ---------------------------------------------------------------- sound

const VOWELS = [[800, 1200], [500, 1900], [300, 2300], [500, 900], [330, 850]];

/**
 * Speech-like sound: syllables with a pitch contour through two formant filters, words and
 * phrases with pauses, and hummed "음…" fillers at `ums` (seconds, each about 0.6 s long).
 * Returns { data, env } where env is the mouth opening (0..1) every 10 ms.
 */
function speech(dur, { seed = 3, ums = [], f0 = 125, start = 0.4, peak = 0.32 } = {}) {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  const env = new Float32Array(Math.ceil(dur * 100) + 1);
  const r = rng(seed);
  const parts = [];
  let t = start;
  let words = 0;
  const umAt = [...ums];
  while (t < dur - 0.5) {
    if (umAt.length && t >= umAt[0] - 0.3) {
      const u = umAt.shift();
      parts.push({ t0: u, t1: u + 0.62, um: true });
      t = u + 0.62 + 0.35;
      continue;
    }
    const syl = 2 + Math.floor(r() * 3);
    for (let s = 0; s < syl; s++) {
      const len = 0.13 + r() * 0.11;
      parts.push({ t0: t, t1: t + len, v: VOWELS[Math.floor(r() * VOWELS.length)], stress: s === 0 ? 1.15 : 0.85 + r() * 0.2, burst: r() < 0.6 });
      t += len + 0.015;
    }
    words++;
    t += words % (4 + Math.floor(r() * 3)) === 0 ? 0.38 + r() * 0.3 : 0.05 + r() * 0.07;
  }
  const noise = rng(seed + 99);
  let phase = 0;
  let soft = 0;
  for (const p of parts) {
    const i0 = Math.max(0, Math.round(p.t0 * SR));
    const i1 = Math.min(n, Math.round(p.t1 * SR));
    const len = i1 - i0;
    const f1 = biquad(p.um ? 'lp' : 'bp', p.um ? 380 : p.v[0], p.um ? 0.9 : 5);
    const f2 = p.um ? null : biquad('bp', p.v[1], 7);
    const hiss = biquad('hp', 3500, 0.7);
    for (let i = 0; i < len; i++) {
      const tt = i / SR;
      const x = i / len;
      const a = smooth(tt / 0.025) * smooth((len / SR - tt) / 0.045);
      // pitch falls a little over each phrase and wobbles with the syllable
      const pitch = (p.um ? f0 * 0.88 : f0 * p.stress) * (1 + 0.06 * Math.sin(x * Math.PI)) * (1 - 0.08 * ((p.t0 % 3) / 3));
      phase = (phase + pitch / SR) % 1;
      soft += ((phase * 2 - 1) - soft) * 0.35;
      let y = p.um ? f1(soft) * 0.9 : f1(soft) * 1.6 + f2(soft) * 0.9;
      if (p.burst && tt < 0.035) y += hiss(noise() * 2 - 1) * 0.5 * (1 - tt / 0.035);
      out[i0 + i] += y * a * (p.um ? 0.75 : 1);
    }
    for (let k = Math.floor(p.t0 * 100); k <= Math.min(env.length - 1, Math.ceil(p.t1 * 100)); k++) {
      const tt = k / 100 - p.t0;
      env[k] = Math.max(env[k], (p.um ? 0.12 : 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, tt / (p.t1 - p.t0))))));
    }
  }
  normalize(out, peak);
  return { data: out, env };
}

/** Room tone: soft hiss and a little mains hum (something for 대화 정리 to clean up). */
function roomTone(a, { level = 0.006, hum = 0.004, seed = 5 } = {}) {
  const r = rng(seed);
  const lp = biquad('lp', 5000, 0.7);
  for (let i = 0; i < a.length; i++) a[i] += lp(r() * 2 - 1) * level + Math.sin((2 * Math.PI * 60 * i) / SR) * hum;
  return a;
}

/** Ambience under the B-roll: wind, city rumble or surf. */
function ambience(dur, kind, seed) {
  const n = Math.round(dur * SR);
  const a = new Float32Array(n);
  const r = rng(seed);
  const lp = biquad('lp', kind === 'city' ? 300 : kind === 'waves' ? 900 : 500, 0.7);
  const bp = biquad('bp', 1800, 1.5);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const w = r() * 2 - 1;
    let g;
    if (kind === 'waves') g = 0.35 + 0.65 * smooth((Math.sin((2 * Math.PI * t) / 3.2) + 1) / 2) ** 2;
    else if (kind === 'city') g = 0.7 + 0.3 * Math.sin(t * 1.3);
    else g = 0.5 + 0.5 * Math.sin(t * 0.9 + Math.sin(t * 2.3));
    a[i] = lp(w) * g * 0.9 + (kind === 'waves' ? bp(w) * g * 0.25 : 0);
    // a car horn far away
    if (kind === 'city' && t > 3.1 && t < 3.5) a[i] += Math.sin(2 * Math.PI * 440 * t) * 0.03 * Math.sin(((t - 3.1) / 0.4) * Math.PI);
  }
  return normalize(a, 0.18);
}

/** A hand clap: a few quick noise bursts through a band-pass. */
function clap(a, at, gain = 0.8, seed = 11) {
  const r = rng(seed);
  const bp = biquad('bp', 1400, 1.2);
  const i0 = Math.round(at * SR);
  for (let i = 0; i < 0.25 * SR && i0 + i < a.length; i++) {
    const t = i / SR;
    const e = Math.exp(-t / 0.045) + (t > 0.008 ? 0.6 * Math.exp(-(t - 0.008) / 0.01) : 0);
    a[i0 + i] += bp(r() * 2 - 1) * e * gain * 3;
  }
}

/** 30 s of music at 120 BPM: kick on every beat, snare on 2 and 4, hats, bass and pads (C G Am F). */
function music(dur = 30) {
  const n = Math.round(dur * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const beat = 0.5;
  const chords = [[261.6, 329.6, 392], [196, 246.9, 293.7], [220, 261.6, 329.6], [174.6, 220, 261.6]];
  const r = rng(21);
  const add = (i, v, pan = 0) => {
    if (i < 0 || i >= n) return;
    L[i] += v * (1 - pan);
    R[i] += v * (1 + pan);
  };
  for (let b = 0; b * beat < dur; b++) {
    const t0 = b * beat;
    const i0 = Math.round(t0 * SR);
    const intro = t0 < 4;
    // kick
    if (!intro || b % 2 === 0) {
      let ph = 0;
      for (let i = 0; i < 0.3 * SR; i++) {
        const t = i / SR;
        ph += (2 * Math.PI * (45 + 90 * Math.exp(-t / 0.04))) / SR;
        add(i0 + i, Math.sin(ph) * Math.exp(-t / 0.12) * 0.9);
      }
    }
    // snare on 2 and 4
    if (!intro && b % 2 === 1) {
      const hp = biquad('hp', 900, 0.8);
      for (let i = 0; i < 0.2 * SR; i++) {
        const t = i / SR;
        add(i0 + i, (hp(r() * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * 185 * t) * 0.25) * Math.exp(-t / 0.06));
      }
    }
    // closed hats on eighths
    for (const off of [0, beat / 2]) {
      const hp = biquad('hp', 7000, 0.7);
      const j0 = Math.round((t0 + off) * SR);
      for (let i = 0; i < 0.05 * SR; i++) add(j0 + i, hp(r() * 2 - 1) * 0.18 * Math.exp(-(i / SR) / 0.015), off ? 0.3 : -0.3);
    }
  }
  // bass and pad, one chord per bar (4 beats)
  const lp = biquad('lp', 500, 0.9);
  let bph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bar = Math.floor(t / (4 * beat));
    const ch = chords[bar % 4];
    const inBeat = (t % beat) / beat;
    const bf = ch[0] / 2;
    bph = (bph + bf / SR) % 1;
    const bass = t < 4 ? 0 : lp(bph * 2 - 1) * 0.5 * (inBeat < 0.8 ? 1 : 0.4);
    const barT = t % (4 * beat);
    const padEnv = smooth(barT / 0.4) * (0.75 + 0.25 * Math.cos(barT * 1.5));
    let pad = 0;
    for (let k = 0; k < 3; k++) pad += Math.sin(2 * Math.PI * ch[k] * t) + 0.3 * Math.sin(2 * Math.PI * ch[k] * 2 * t + k);
    const fade = smooth(t / 1.5) * smooth((dur - t) / 2.5);
    L[i] = (L[i] + bass + pad * 0.07 * padEnv) * fade;
    R[i] = (R[i] + bass + pad * 0.07 * padEnv) * fade;
  }
  const k = 0.7 / Math.max(peakOf(L), peakOf(R));
  for (let i = 0; i < n; i++) {
    L[i] *= k;
    R[i] *= k;
  }
  return toBuffer(L, R);
}

function peakOf(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m || 1;
}

function whoosh() {
  const dur = 1.2;
  const a = new Float32Array(Math.round(dur * SR));
  const r = rng(31);
  let f = null;
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    if (i % 256 === 0) f = biquad('bp', 300 + 2600 * (t / dur) ** 1.5, 2.5);
    a[i] = f(r() * 2 - 1) * Math.sin(Math.PI * (t / dur)) ** 2;
  }
  return toBuffer(normalize(a, 0.6));
}

function ding() {
  const dur = 1.6;
  const a = new Float32Array(Math.round(dur * SR));
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    a[i] = (Math.sin(2 * Math.PI * 1318.5 * t) + 0.5 * Math.sin(2 * Math.PI * 1318.5 * 2.76 * t) * Math.exp(-t / 0.15)) * Math.exp(-t / 0.5) * smooth(t / 0.003);
  }
  return toBuffer(normalize(a, 0.5));
}

// ---------------------------------------------------------------- pictures

const SKIN = '#e9b48f';

/** A person from the waist up, facing the camera; mouth opening 0..1, blink 0..1, wave (arm angle) or null. */
function person(g, cx, top, s, { mouth = 0, blink = 0, shirt = '#3d6fb6', hair = '#2b211c', wave = null, turn = 0 } = {}) {
  g.save();
  g.translate(cx, top);
  g.scale(s, s);
  // body
  g.fillStyle = shirt;
  g.beginPath();
  g.moveTo(-95, 260);
  g.quadraticCurveTo(-92, 150, -40, 140);
  g.lineTo(40, 140);
  g.quadraticCurveTo(92, 150, 95, 260);
  g.closePath();
  g.fill();
  if (wave != null) {
    g.save();
    g.translate(70, 160);
    g.rotate(-1.9 + wave);
    g.fillStyle = shirt;
    g.fillRect(-14, 0, 28, 95);
    g.fillStyle = SKIN;
    g.beginPath();
    g.arc(0, 105, 17, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // neck and head
  g.fillStyle = '#d9a07b';
  g.fillRect(-17, 100, 34, 45);
  g.fillStyle = SKIN;
  g.beginPath();
  g.ellipse(turn * 8, 70, 50, 62, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = hair;
  g.beginPath();
  g.ellipse(turn * 8, 40, 54, 40, 0, Math.PI, 0);
  g.fill();
  g.fillRect(-54 + turn * 8, 36, 12, 30);
  g.fillRect(42 + turn * 8, 36, 12, 30);
  // eyes and brows
  const ex = turn * 12;
  g.fillStyle = '#2a1d17';
  for (const sx of [-19, 19]) {
    g.beginPath();
    g.ellipse(sx + ex, 66, 6, Math.max(0.8, 6 * (1 - blink)), 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(sx + ex - 9, 52, 18, 3);
  }
  // mouth
  g.fillStyle = '#7a2f2f';
  g.beginPath();
  g.ellipse(ex, 100, 13, 2 + mouth * 9, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

const blinkAt = (t) => {
  const p = t % 3.7;
  return p < 0.12 ? Math.sin((p / 0.12) * Math.PI) : 0;
};
const envAt = (env, t) => env[Math.max(0, Math.min(env.length - 1, Math.round(t * 100)))] || 0;

/** An offscreen picture of w×h logical pixels, rendered at the output scale. */
function off(w, h) {
  const c = new OffscreenCanvas(Math.round(w * S), Math.round(h * S));
  const g = c.getContext('2d');
  g.scale(S, S);
  return [c, g];
}

function office(w, h) {
  const [c, g] = off(w, h);
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#c9b9a3');
  gr.addColorStop(1, '#9c8a73');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  // window with light
  g.fillStyle = '#dfeef7';
  g.fillRect(w * 0.06, h * 0.12, w * 0.24, h * 0.42);
  g.strokeStyle = '#f4efe7';
  g.lineWidth = 6;
  g.strokeRect(w * 0.06, h * 0.12, w * 0.24, h * 0.42);
  g.beginPath();
  g.moveTo(w * 0.18, h * 0.12);
  g.lineTo(w * 0.18, h * 0.54);
  g.stroke();
  // bookshelf
  const r = rng(4);
  g.fillStyle = '#6b4a2f';
  g.fillRect(w * 0.36, h * 0.18, w * 0.2, h * 0.62);
  for (let row = 0; row < 3; row++) {
    let x = w * 0.37;
    const y = h * (0.21 + row * 0.2);
    while (x < w * 0.55) {
      const bw = 6 + r() * 9;
      g.fillStyle = ['#a33b2f', '#2f5d8a', '#d9b44a', '#3f7a4f', '#eae0cf'][Math.floor(r() * 5)];
      g.fillRect(x, y + r() * 8, bw, h * 0.16 - r() * 8);
      x += bw + 1;
    }
  }
  // plant
  g.fillStyle = '#7a5235';
  g.fillRect(w * 0.08, h * 0.74, w * 0.07, h * 0.14);
  g.fillStyle = '#3e7d46';
  for (let i = 0; i < 7; i++) {
    g.beginPath();
    g.ellipse(w * 0.115 + Math.cos(i) * 22, h * 0.68 - (i % 3) * 14, 12, 26, i * 0.7, 0, Math.PI * 2);
    g.fill();
  }
  // a soft shadow behind where the person sits
  const sg = g.createRadialGradient(w * 0.68, h * 0.7, 10, w * 0.68, h * 0.7, w * 0.3);
  sg.addColorStop(0, 'rgba(0,0,0,.18)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sg;
  g.fillRect(0, 0, w, h);
  return c;
}

function ridge(g, w, h, y0, amp, color, seed) {
  const r = rng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) {
    const u = x / w;
    g.lineTo(x, y0 - amp * (0.5 * Math.sin(u * 7 + ph[0]) + 0.3 * Math.sin(u * 17 + ph[1]) + 0.2 * Math.sin(u * 41 + ph[2])));
  }
  g.lineTo(w, h);
  g.closePath();
  g.fill();
}

/** Wide pictures the camera pans over, drawn once. */
function landscapePano(w, h) {
  const [c, g] = off(w, h);
  const sky = g.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, '#5b8fd1');
  sky.addColorStop(1, '#f2d8b0');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,240,200,.9)';
  g.beginPath();
  g.arc(w * 0.62, h * 0.3, 26, 0, Math.PI * 2);
  g.fill();
  ridge(g, w, h, h * 0.5, h * 0.12, '#7c8db5', 1);
  ridge(g, w, h, h * 0.6, h * 0.1, '#55708a', 2);
  ridge(g, w, h, h * 0.72, h * 0.06, '#3d6b45', 3);
  const lake = g.createLinearGradient(0, h * 0.8, 0, h);
  lake.addColorStop(0, '#4f86a8');
  lake.addColorStop(1, '#2d5c78');
  g.fillStyle = lake;
  g.fillRect(0, h * 0.8, w, h * 0.2);
  const r = rng(8);
  g.fillStyle = '#2f5a36';
  for (let i = 0; i < 60; i++) {
    const x = r() * w;
    const y = h * (0.74 + r() * 0.05);
    g.beginPath();
    g.moveTo(x, y - 18 - r() * 14);
    g.lineTo(x - 7, y + 4);
    g.lineTo(x + 7, y + 4);
    g.fill();
  }
  return c;
}

function cityPano(w, h) {
  const [c, g] = off(w, h);
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#1b2140');
  sky.addColorStop(0.7, '#d0745a');
  sky.addColorStop(1, '#f0b07a');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const r = rng(12);
  for (const [layer, col, hMin, hMax] of [[0, '#3a3456', 0.25, 0.5], [1, '#1d1a2c', 0.35, 0.75]]) {
    let x = -10;
    while (x < w) {
      const bw = 30 + r() * 60;
      const bh = h * (hMin + r() * (hMax - hMin));
      g.fillStyle = col;
      g.fillRect(x, h - bh, bw, bh);
      if (layer) {
        for (let wy = h - bh + 8; wy < h - 10; wy += 12) {
          for (let wx = x + 5; wx < x + bw - 6; wx += 9) {
            if (r() < 0.45) {
              g.fillStyle = r() < 0.8 ? '#f6d27a' : '#9fd1f0';
              g.fillRect(wx, wy, 4, 6);
            }
          }
        }
      }
      x += bw + 2 + r() * 6;
    }
  }
  return c;
}

/** Draw functions for each video item: (g, t) → paints frame at t seconds. */
const PICTURES = {
  interview: (sp) => {
    const bg = office(W, H);
    return (g, t) => {
      g.drawImage(bg, 0, 0, W, H);
      person(g, W * 0.66, H * 0.2 + Math.sin(t * 1.3) * 2, 1.15, { mouth: envAt(sp.env, t), blink: blinkAt(t) });
    };
  },
  landscape: () => {
    const pano = landscapePano(W * 2, H);
    return (g, t) => g.drawImage(pano, -W * (t / 8) * 0.9, 0, W * 2, H);
  },
  city: () => {
    const pano = cityPano(W * 2.2, H);
    return (g, t) => {
      g.drawImage(pano, -W * 1.1 + W * (t / 8) * 1.0, 0, W * 2.2, H);
      // traffic lights streaking along the street
      g.fillStyle = '#121019';
      g.fillRect(0, H * 0.9, W, H * 0.1);
      for (let i = 0; i < 6; i++) {
        const x = ((t * 140 + i * 130) % (W + 60)) - 30;
        g.fillStyle = i % 2 ? '#ff5a4a' : '#fff3c4';
        g.fillRect(x, H * 0.93, 14, 4);
      }
    };
  },
  waves: () => (g, t) => {
    const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
    sky.addColorStop(0, '#79b7e6');
    sky.addColorStop(1, '#dff1fb');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const horizon = H * 0.45 + Math.sin(t * 0.5) * 6;
    g.fillStyle = '#2c6f9c';
    g.fillRect(0, horizon, W, H - horizon);
    for (let k = 0; k < 14; k++) {
      const y = horizon + 6 + k * k * 1.6;
      const amp = 1 + k * 0.6;
      g.strokeStyle = k % 3 ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.7)';
      g.lineWidth = 1 + k * 0.25;
      g.beginPath();
      for (let x = 0; x <= W; x += 8) g.lineTo(x, y + Math.sin(x * (0.03 - k * 0.0015) + t * (1.5 + k * 0.2) + k) * amp);
      g.stroke();
    }
    g.fillStyle = '#e8d4a6';
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) g.lineTo(x, H * 0.9 + Math.sin(x * 0.01 + 1) * 8 - Math.max(0, Math.sin(t * 2)) * 4);
    g.lineTo(W, H);
    g.fill();
  },
  greenscreen: () => (g, t) => {
    // a chroma green a little off the 울트라 키 default, so picking it with the eyedropper shows
    g.fillStyle = '#12bf4a';
    g.fillRect(0, 0, W, H);
    person(g, W / 2, H * 0.18, 1.2, { mouth: 0.3 + 0.3 * Math.sin(t * 9), blink: blinkAt(t + 1), shirt: '#c0392b', wave: Math.sin(t * 4) * 0.5 });
  },
  face: () => {
    const [wall, wg] = off(W, H);
    const r = rng(41);
    wg.fillStyle = '#8b5a44';
    wg.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 22) {
      for (let x = (y / 22) % 2 ? -24 : 0; x < W; x += 48) {
        const v = 120 + r() * 50;
        wg.fillStyle = `rgb(${v + 40},${v * 0.55},${v * 0.42})`;
        wg.fillRect(x + 2, y + 2, 44, 18);
      }
    }
    return (g, t) => {
      g.drawImage(wall, 0, 0, W, H);
      const u = t / 8;
      const x = W * (0.15 + 0.7 * u);
      const y = H * (0.48 + 0.12 * Math.sin(u * Math.PI * 2));
      g.fillStyle = '#2e4f7a';
      g.beginPath();
      g.ellipse(x, y + 120, 70, 60, 0, Math.PI, 0);
      g.fill();
      g.fillStyle = SKIN;
      g.beginPath();
      g.arc(x, y, 48, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#2b211c';
      g.beginPath();
      g.arc(x, y - 10, 50, Math.PI * 1.05, Math.PI * 1.95);
      g.fill();
      g.fillStyle = '#1f1612';
      for (const sx of [-16, 16]) {
        g.beginPath();
        g.arc(x + sx, y + 2, 5, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = '#7a2f2f';
      g.lineWidth = 4;
      g.beginPath();
      g.arc(x, y + 18, 14, 0.15 * Math.PI, 0.85 * Math.PI);
      g.stroke();
    };
  },
  // three framings of one scene: a person with a clapper slate before speaking
  cam: (sp, { angle, offset }) => {
    const bg = office(W * 1.6, H * 1.6);
    const clapT = 2.0;
    return (g, t) => {
      const st = t + offset;
      g.save();
      if (angle === 1) g.drawImage(bg, -W * 0.3, -H * 0.3, W * 1.6, H * 1.6);
      else if (angle === 2) {
        g.drawImage(bg, -W * 0.9, -H * 0.5, W * 2.2, H * 2.2);
        g.translate(W * 0.5, 0);
        g.scale(1.7, 1.7);
        g.translate(-W * 0.62, -H * 0.04);
      } else {
        g.drawImage(bg, -W * 0.1, -H * 0.4, W * 1.9, H * 1.9);
        g.translate(-W * 0.15, H * 0.05);
      }
      person(g, W * 0.62, H * 0.22, 1, { mouth: envAt(sp.env, st), blink: blinkAt(st), turn: angle === 3 ? -1 : angle === 2 ? 0.4 : 0, shirt: '#4b7a52' });
      g.restore();
      // the slate comes in before the clap and leaves after it
      if (st < clapT + 0.6) {
        const open = Math.max(0, Math.min(1, (clapT - st) / 0.5));
        const sx = angle === 2 ? W * 0.18 : W * 0.25;
        g.save();
        g.translate(sx, H * 0.55);
        g.fillStyle = '#202020';
        g.fillRect(0, 0, 150, 90);
        g.fillStyle = '#fff';
        g.font = 'bold 18px sans-serif';
        g.fillText(`CAM ${angle}`, 12, 40);
        g.fillText('씬 1 · 테이크 1', 12, 72);
        g.rotate(-open * 0.5);
        g.fillStyle = '#eee';
        g.fillRect(0, -18, 150, 16);
        g.fillStyle = '#202020';
        for (let i = 0; i < 5; i++) g.fillRect(8 + i * 30, -18, 14, 16);
        g.restore();
      }
    };
  },
};

// ---------------------------------------------------------------- the catalogue

const INTERVIEW_UMS = [5.2, 10.6];
const CAM_OFFSETS = [0, 0.6, 1.3];

/**
 * key → { name, kind, dur, make() → { draw, audio } }. Names end up in the project panel.
 * `notes` are facts lessons rely on (where the "음…" pauses are, the clap, the beat).
 */
export const PRACTICE = {
  interview: {
    name: '인터뷰.webm', kind: 'video', dur: 16, notes: { ums: INTERVIEW_UMS },
    make() {
      const sp = speech(16, { ums: INTERVIEW_UMS });
      roomTone(sp.data);
      return { draw: PICTURES.interview(sp), audio: toBuffer(sp.data) };
    },
  },
  brollLandscape: {
    name: 'B롤 - 풍경.webm', kind: 'video', dur: 8,
    make: () => ({ draw: PICTURES.landscape(), audio: toBuffer(ambience(8, 'wind', 51)) }),
  },
  brollCity: {
    name: 'B롤 - 도시.webm', kind: 'video', dur: 8,
    make: () => ({ draw: PICTURES.city(), audio: toBuffer(ambience(8, 'city', 52)) }),
  },
  brollWaves: {
    name: 'B롤 - 파도.webm', kind: 'video', dur: 8,
    make: () => ({ draw: PICTURES.waves(), audio: toBuffer(ambience(8, 'waves', 53)) }),
  },
  greenscreen: {
    name: '그린 스크린 인물.webm', kind: 'video', dur: 8,
    make: () => ({ draw: PICTURES.greenscreen(), audio: null }),
  },
  face: {
    name: '움직이는 얼굴.webm', kind: 'video', dur: 8,
    make: () => ({ draw: PICTURES.face(), audio: null }),
  },
  music: {
    name: '음악 (120 BPM).webm', kind: 'audio', dur: 30, notes: { bpm: 120 },
    make: () => ({ draw: null, audio: music(30) }),
  },
  ...Object.fromEntries([1, 2, 3].map((angle) => [`cam${angle}`, {
    name: `멀티캠 - 카메라 ${angle}.webm`, kind: 'video', dur: 12, notes: { clap: 2 - CAM_OFFSETS[angle - 1] },
    make() {
      const offset = CAM_OFFSETS[angle - 1];
      const sp = speech(14, { seed: 9, start: 3.0, f0: 115 });
      roomTone(sp.data, { level: 0.004 + angle * 0.002, hum: 0.002, seed: angle });
      clap(sp.data, 2.0);
      const i0 = Math.round(offset * SR);
      return { draw: PICTURES.cam(sp, { angle, offset }), audio: toBuffer(sp.data.slice(i0, i0 + 12 * SR)) };
    },
  }])),
  sfxWhoosh: {
    name: '효과음 - 휙.webm', kind: 'audio', dur: 1.2,
    make: () => ({ draw: null, audio: whoosh() }),
  },
  sfxDing: {
    name: '효과음 - 딩.webm', kind: 'audio', dur: 1.6,
    make: () => ({ draw: null, audio: ding() }),
  },
};

// ---------------------------------------------------------------- encoding

function sliceBuffer(buf, s0, s1) {
  const out = new AudioBuffer({ length: Math.max(1, s1 - s0), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(s0, s1));
  return out;
}

/** Encode frames drawn by draw(g, t) and/or an AudioBuffer into a WebM Blob. */
async function encodeWebM({ dur, draw, audio, onProgress }) {
  const MB = await import(MB_URL);
  const videoCodec = draw ? await MB.getFirstEncodableVideoCodec(['vp8', 'vp9'], { width: W * S, height: H * S, frameRate: FPS }) : null;
  if (draw && !videoCodec) throw new Error('이 브라우저에서는 연습 영상을 만들 수 없습니다 (최신 Chrome·Edge 권장)');
  const audioCodec = audio ? await MB.getFirstEncodableAudioCodec(['opus', 'vorbis', 'pcm-s16'], { numberOfChannels: 2, sampleRate: SR }) : null;
  if (!draw && !audioCodec) throw new Error('이 브라우저에서는 연습 소리를 만들 수 없습니다');
  const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
  let canvas = null;
  let g = null;
  let video = null;
  if (draw) {
    canvas = document.createElement('canvas');
    canvas.width = W * S;
    canvas.height = H * S;
    g = canvas.getContext('2d', { alpha: false });
    video = new MB.CanvasSource(canvas, { codec: videoCodec, quality: MB.QUALITY_HIGH, keyFrameInterval: 1 });
    output.addVideoTrack(video, { frameRate: FPS });
  }
  const sound = audioCodec ? new MB.AudioBufferSource({ codec: audioCodec, quality: MB.QUALITY_HIGH }) : null;
  if (sound) output.addAudioTrack(sound);
  await output.start();
  try {
    if (video) {
      const total = Math.round(dur * FPS);
      let audioPos = 0;
      for (let i = 0; i < total; i++) {
        g.setTransform(S, 0, 0, S, 0, 0);
        draw(g, i / FPS);
        await video.add(i / FPS, 1 / FPS);
        if (sound) {
          const want = Math.min(audio.length, Math.ceil(((i + 1) / FPS + 1) * SR));
          if (want > audioPos) {
            await sound.add(sliceBuffer(audio, audioPos, want));
            audioPos = want;
          }
        }
        if (i % 10 === 0) {
          onProgress(i / total);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (sound && audioPos < audio.length) await sound.add(sliceBuffer(audio, audioPos, audio.length));
    } else if (sound) await sound.add(audio);
    await output.finalize();
  } catch (err) {
    try { await output.cancel(); } catch { /* ignore */ }
    throw err;
  }
  onProgress(1);
  return new Blob([output.target.buffer], { type: draw ? 'video/webm' : 'audio/webm' });
}

// ---------------------------------------------------------------- cache (IndexedDB)

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('montage-practice', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('files', mode);
    const req = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const cacheGet = (key) => idb('readonly', (s) => s.get(key)).catch(() => null);
const cachePut = (key, value) => idb('readwrite', (s) => s.put(value, key)).catch((err) => console.warn('practice cache', err));

/** What the cache holds: [{ key, name, size }] and the total in bytes. */
export async function practiceUsage() {
  try {
    const all = await idb('readonly', (s) => s.getAll());
    const items = (all || []).map((x) => ({ key: x.key, name: x.name, size: x.blob?.size || 0 }));
    return { items, total: items.reduce((a, x) => a + x.size, 0) };
  } catch {
    return { items: [], total: 0 };
  }
}

/** Delete the cached practice files (the copies already in a project stay there). */
export const clearPracticeCache = () => idb('readwrite', (s) => s.clear()).catch(() => null);

/** A practice file as a File: from the cache, or made now (and cached). */
export async function practiceFile(key, onProgress = () => {}) {
  const def = PRACTICE[key];
  if (!def) throw new Error(`no practice item ${key}`);
  const hit = await cacheGet(key);
  if (hit?.ver === GEN_VER && hit.blob) {
    onProgress(1);
    return new File([hit.blob], def.name, { type: hit.blob.type });
  }
  const { draw, audio } = def.make();
  const blob = await encodeWebM({ dur: def.dur, draw, audio, onProgress });
  await cachePut(key, { key, name: def.name, ver: GEN_VER, blob, made: Date.now() });
  return new File([blob], def.name, { type: blob.type });
}

// ---------------------------------------------------------------- into the project

/** The project's '연습 파일' bin (made when missing). */
function practiceBin() {
  const bins = store.project.bins || (store.project.bins = {});
  const found = Object.values(bins).find((b) => b.name === PRACTICE_BIN);
  if (found) return found.id;
  const id = uid('bin');
  bins[id] = { id, name: PRACTICE_BIN };
  return id;
}

/** The project media made from practice item `key`, if it is there and readable. */
export function practiceMediaId(key) {
  return store.project.mediaOrder.find((id) => {
    const m = store.project.media[id];
    return m?.practice === key && mediaStatus(id) !== 'error' && mediaStatus(id) !== 'offline';
  }) || null;
}

/**
 * Make sure the practice items `keys` are in the project (bin '연습 파일'); returns { key: mediaId }.
 * onProgress(fraction, label) reports the whole job.
 */
export async function ensurePractice(keys, onProgress = () => {}) {
  const out = {};
  const missing = [];
  for (const k of keys) {
    const id = practiceMediaId(k);
    if (id) out[k] = id;
    else missing.push(k);
  }
  const files = [];
  for (let i = 0; i < missing.length; i++) {
    const k = missing[i];
    files.push(await practiceFile(k, (f) => onProgress((i + f) / missing.length, PRACTICE[k].name)));
  }
  if (files.length) {
    const ids = await importFiles(files);
    store.transact('연습 파일 정리', () => {
      const bin = practiceBin();
      ids.forEach((id, i) => {
        const m = store.project.media[id];
        if (!m) return;
        m.practice = missing[i];
        m.bin = bin;
        out[missing[i]] = id;
      });
    });
  }
  onProgress(1, '');
  return out;
}
