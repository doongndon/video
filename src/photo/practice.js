// Practice pictures for the Learn panel, drawn in the browser (no photos shipped, no network):
// a person on a background, a landscape with sky, a forest, a product shot, a brick wall, a fruit
// on a table, a balloon sticker, a pattern motif. Each `build*` returns { name, width, height, layers }
// where layers are { name, canvas, ...layer props } from bottom to top.

import { makeCanvas } from './doc.js';

/** Small seeded random, so a practice file looks the same every time. */
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

const canvas = (w, h, paint) => {
  const c = makeCanvas(w, h);
  paint(c.getContext('2d'), w, h);
  return c;
};

function vgrad(g, h, stops, x0 = 0, x1 = 0) {
  const gr = g.createLinearGradient(x0, 0, x1, h);
  stops.forEach(([at, col]) => gr.addColorStop(at, col));
  return gr;
}

/** Film grain: adds a little noise so filters and retouching have something to work on. */
function grain(c, amount = 8, seed = 7) {
  const g = c.getContext('2d');
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const r = rng(seed);
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const n = (r() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Soft blurred blobs (bokeh, clouds): drawn on a small canvas and scaled up. */
function blobs(g, w, h, n, colors, { seed = 1, rMin = 0.04, rMax = 0.12, y0 = 0, y1 = 1, alpha = 0.5, blur = 18 } = {}) {
  const r = rng(seed);
  g.save();
  g.filter = `blur(${blur}px)`;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = alpha * (0.5 + r() * 0.5);
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    g.beginPath();
    g.arc(r() * w, (y0 + r() * (y1 - y0)) * h, (rMin + r() * (rMax - rMin)) * Math.min(w, h), 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

// ---------------------------------------------------------------- skies and landscapes

const SKY = {
  blue: [[0, '#2f6fb8'], [0.6, '#79aee0'], [1, '#cfe3f2']],
  dull: [[0, '#c9ccd0'], [1, '#e9eaec']],
  sunset: [[0, '#2c2a5a'], [0.45, '#c4577a'], [0.8, '#f29a5c'], [1, '#ffd38a']],
};

function paintSky(g, w, h, kind, seed = 3) {
  g.fillStyle = vgrad(g, h, SKY[kind] || SKY.blue);
  g.fillRect(0, 0, w, h);
  if (kind === 'dull') return;
  // clouds: clusters of flat soft ellipses
  const r = rng(seed);
  g.save();
  g.filter = 'blur(6px)';
  for (let k = 0; k < 7; k++) {
    const cx = r() * w;
    const cy = (0.12 + r() * 0.55) * h;
    const size = (0.05 + r() * 0.06) * w;
    for (let i = 0; i < 6; i++) {
      g.globalAlpha = 0.45 + r() * 0.4;
      g.fillStyle = kind === 'sunset' ? (i % 2 ? '#ffc6a8' : '#f7a8b8') : '#ffffff';
      g.beginPath();
      g.ellipse(cx + (r() - 0.5) * size * 2, cy + (r() - 0.5) * size * 0.3, size * (0.5 + r() * 0.6), size * (0.16 + r() * 0.12), 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

function mountains(g, w, top, base, color, seed, rough = 0.5) {
  const r = rng(seed);
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0, base);
  let y = top + (base - top) * 0.5;
  for (let x = 0; x <= w; x += w / 40) {
    y = Math.max(top, Math.min(base - 4, y + (r() - 0.5) * (base - top) * rough));
    g.lineTo(x, y);
  }
  g.lineTo(w, base);
  g.closePath();
  g.fill();
}

function pine(g, x, y, hgt, color) {
  g.fillStyle = color;
  for (let i = 0; i < 4; i++) {
    const t = y - hgt * (0.25 + i * 0.22);
    const half = hgt * (0.3 - i * 0.06);
    g.beginPath();
    g.moveTo(x, t - hgt * 0.28);
    g.lineTo(x - half, t + hgt * 0.12);
    g.lineTo(x + half, t + hgt * 0.12);
    g.closePath();
    g.fill();
  }
  g.fillRect(x - hgt * 0.03, y - hgt * 0.2, hgt * 0.06, hgt * 0.2);
}

/** A lake in the mountains. `sky`: blue · dull (overcast, for Sky Replacement) · sunset. `dark`: underexposed. */
export function landscape(w, h, { sky = 'blue', dark = false, seed = 11 } = {}) {
  const c = canvas(w, h, (g) => {
    const horizon = h * 0.56;
    paintSky(g, w, horizon + 4, sky, seed);
    mountains(g, w, h * 0.26, horizon + 2, sky === 'dull' ? '#8f99a3' : '#6f86a8', seed + 1, 0.35);
    mountains(g, w, h * 0.38, horizon + 2, sky === 'dull' ? '#5f6f63' : '#4d6f58', seed + 2, 0.3);
    // lake with a soft reflection of the sky
    g.fillStyle = vgrad(g, h, [[0.56, sky === 'dull' ? '#a9b2b8' : '#5b8fbf'], [0.75, sky === 'dull' ? '#76838a' : '#2f5f86']]);
    g.fillRect(0, horizon, w, h - horizon);
    g.globalAlpha = 0.25;
    g.fillStyle = '#fff';
    for (let i = 0; i < 30; i++) g.fillRect((i * 97) % w, horizon + 6 + ((i * 37) % (h * 0.2)), 40 + (i % 5) * 20, 2);
    g.globalAlpha = 1;
    // shore, grass and trees
    g.fillStyle = vgrad(g, h, [[0.76, '#4f7a3a'], [1, '#2c4a22']]);
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, h * 0.8);
    g.quadraticCurveTo(w * 0.35, h * 0.72, w * 0.6, h * 0.79);
    g.quadraticCurveTo(w * 0.85, h * 0.84, w, h * 0.77);
    g.lineTo(w, h);
    g.fill();
    const r = rng(seed + 5);
    for (let i = 0; i < 14; i++) {
      const x = i < 7 ? r() * w * 0.3 : w * 0.72 + r() * w * 0.28;
      pine(g, x, h * (0.8 + r() * 0.05), h * (0.18 + r() * 0.14), i % 2 ? '#1f3a24' : '#27472b');
    }
  });
  grain(c, 7, seed);
  if (dark) {
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(20, 24, 40, 0.45)';
    g.fillRect(0, 0, w, h);
  }
  return c;
}

/** A misty pine forest (for Double Exposure). */
export function forest(w, h, seed = 21) {
  return grain(canvas(w, h, (g) => {
    g.fillStyle = vgrad(g, h, [[0, '#e8eef0'], [1, '#aebdbd']]);
    g.fillRect(0, 0, w, h);
    const rows = [['#9fb0ae', 0.55], ['#71878a', 0.68], ['#465c5c', 0.82], ['#1d2b2b', 1.02]];
    rows.forEach(([col, base], k) => {
      const r = rng(seed + k);
      for (let x = -20; x < w + 20; x += 34 + r() * 60) pine(g, x, h * base, h * (0.3 + r() * 0.25 + k * 0.08), col);
      g.fillStyle = col;
      g.fillRect(0, h * base - h * 0.06, w, h);
      if (k < rows.length - 1) {
        g.fillStyle = 'rgba(232,238,240,0.25)';
        g.fillRect(0, 0, w, h);
      }
    });
  }), 6, seed);
}

// ---------------------------------------------------------------- people

/**
 * A head-and-shoulders person facing the camera, centred at (cx, ·), head size `s` (px).
 * opts: skin, hair, shirt, blemishes (number of spots), wrinkles.
 */
function person(g, cx, top, s, { skin = '#e8b796', hair = '#2b1d16', shirt = '#3d5a80', blemishes = 0, seed = 5 } = {}) {
  const r = rng(seed);
  const headY = top + s * 0.62;
  // shoulders and shirt
  g.fillStyle = shirt;
  g.beginPath();
  g.moveTo(cx - s * 1.45, top + s * 3.2);
  g.bezierCurveTo(cx - s * 1.4, top + s * 1.85, cx - s * 0.9, top + s * 1.55, cx - s * 0.25, top + s * 1.45);
  g.lineTo(cx + s * 0.25, top + s * 1.45);
  g.bezierCurveTo(cx + s * 0.9, top + s * 1.55, cx + s * 1.4, top + s * 1.85, cx + s * 1.45, top + s * 3.2);
  g.closePath();
  g.fill();
  const shade = g.createLinearGradient(cx - s * 1.4, 0, cx + s * 1.4, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.35)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  shade.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = shade;
  g.fill();
  // neck
  g.fillStyle = skin;
  g.beginPath();
  g.moveTo(cx - s * 0.22, headY + s * 0.4);
  g.lineTo(cx - s * 0.25, top + s * 1.55);
  g.quadraticCurveTo(cx, top + s * 1.72, cx + s * 0.25, top + s * 1.55);
  g.lineTo(cx + s * 0.22, headY + s * 0.4);
  g.fill();
  g.fillStyle = 'rgba(90,40,20,0.25)';
  g.fillRect(cx - s * 0.23, headY + s * 0.42, s * 0.46, s * 0.14);
  // hair behind the head, down to the shoulders
  g.fillStyle = hair;
  g.beginPath();
  g.moveTo(cx - s * 0.5, headY);
  g.bezierCurveTo(cx - s * 0.62, headY - s * 0.85, cx + s * 0.62, headY - s * 0.85, cx + s * 0.5, headY);
  g.bezierCurveTo(cx + s * 0.5, headY + s * 0.55, cx + s * 0.62, top + s * 1.7, cx + s * 0.42, top + s * 1.78);
  g.lineTo(cx - s * 0.42, top + s * 1.78);
  g.bezierCurveTo(cx - s * 0.62, top + s * 1.7, cx - s * 0.5, headY + s * 0.55, cx - s * 0.5, headY);
  g.fill();
  // ears
  g.fillStyle = skin;
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + sx * s * 0.4, headY + s * 0.02, s * 0.07, s * 0.12, 0, 0, Math.PI * 2);
    g.fill();
  }
  // face
  const face = g.createRadialGradient(cx - s * 0.1, headY - s * 0.12, s * 0.05, cx, headY, s * 0.55);
  face.addColorStop(0, '#f6d2b8');
  face.addColorStop(0.55, skin);
  face.addColorStop(1, '#b97a5c');
  g.fillStyle = face;
  g.beginPath();
  g.ellipse(cx, headY, s * 0.38, s * 0.5, 0, 0, Math.PI * 2);
  g.fill();
  // fringe and side hair
  g.fillStyle = hair;
  g.beginPath();
  g.moveTo(cx - s * 0.42, headY + s * 0.05);
  g.bezierCurveTo(cx - s * 0.48, headY - s * 0.55, cx + s * 0.1, headY - s * 0.75, cx + s * 0.44, headY - s * 0.2);
  g.bezierCurveTo(cx + s * 0.2, headY - s * 0.4, cx - s * 0.15, headY - s * 0.35, cx - s * 0.33, headY - s * 0.05);
  g.closePath();
  g.fill();
  // brows, eyes
  for (const sx of [-1, 1]) {
    const ex = cx + sx * s * 0.15;
    const ey = headY - s * 0.03;
    g.strokeStyle = hair;
    g.lineWidth = s * 0.035;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(ex - s * 0.08, ey - s * 0.1);
    g.quadraticCurveTo(ex, ey - s * 0.14, ex + s * 0.08, ey - s * 0.1);
    g.stroke();
    g.fillStyle = '#fbf7f2';
    g.beginPath();
    g.ellipse(ex, ey, s * 0.075, s * 0.038, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5a3a24';
    g.beginPath();
    g.arc(ex, ey, s * 0.033, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#120c08';
    g.beginPath();
    g.arc(ex, ey, s * 0.016, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(ex + s * 0.01, ey - s * 0.012, s * 0.008, 0, Math.PI * 2);
    g.fill();
  }
  // nose and mouth
  g.strokeStyle = 'rgba(120,60,40,0.45)';
  g.lineWidth = s * 0.018;
  g.beginPath();
  g.moveTo(cx + s * 0.01, headY + s * 0.02);
  g.quadraticCurveTo(cx + s * 0.05, headY + s * 0.15, cx - s * 0.03, headY + s * 0.17);
  g.stroke();
  g.fillStyle = '#c0606a';
  g.beginPath();
  g.moveTo(cx - s * 0.11, headY + s * 0.28);
  g.quadraticCurveTo(cx, headY + s * 0.24, cx + s * 0.11, headY + s * 0.28);
  g.quadraticCurveTo(cx, headY + s * 0.36, cx - s * 0.11, headY + s * 0.28);
  g.fill();
  // cheeks
  g.fillStyle = 'rgba(230,110,100,0.18)';
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + sx * s * 0.2, headY + s * 0.15, s * 0.09, s * 0.06, 0, 0, Math.PI * 2);
    g.fill();
  }
  // blemishes: small red-brown spots on cheeks, forehead and chin
  for (let i = 0; i < blemishes; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.15 + r() * 0.75;
    const x = cx + Math.cos(a) * s * 0.3 * d;
    const y = headY + Math.sin(a) * s * 0.42 * d;
    if (Math.abs(y - (headY - s * 0.03)) < s * 0.07 || Math.abs(y - (headY + s * 0.28)) < s * 0.06) continue; // not on eyes or lips
    const rad = s * (0.008 + r() * 0.014);
    const sp = g.createRadialGradient(x, y, 0, x, y, rad * 1.8);
    sp.addColorStop(0, r() < 0.5 ? 'rgba(150,50,40,0.85)' : 'rgba(110,60,40,0.8)');
    sp.addColorStop(1, 'rgba(150,60,50,0)');
    g.fillStyle = sp;
    g.beginPath();
    g.arc(x, y, rad * 1.8, 0, Math.PI * 2);
    g.fill();
  }
}

const BACKS = {
  studio: (g, w, h) => {
    const gr = g.createRadialGradient(w * 0.5, h * 0.4, 10, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    gr.addColorStop(0, '#9aa3ab');
    gr.addColorStop(1, '#3b4148');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  },
  white: (g, w, h) => {
    g.fillStyle = '#f4f4f2';
    g.fillRect(0, 0, w, h);
  },
  outdoor: (g, w, h) => {
    g.fillStyle = vgrad(g, h, [[0, '#a7c98a'], [0.6, '#5f8f4e'], [1, '#3f5f34']]);
    g.fillRect(0, 0, w, h);
    blobs(g, w, h, 60, ['#f4e7a1', '#cfe6a8', '#ffffff', '#8fbf6a'], { seed: 9, rMin: 0.02, rMax: 0.07, alpha: 0.55, blur: 6 });
  },
};

/** A person on a background: `back` studio · white · outdoor. */
export function portrait(w, h, { back = 'studio', blemishes = 0, shirt, close = false, seed = 5 } = {}) {
  const c = canvas(w, h, (g) => {
    (BACKS[back] || BACKS.studio)(g, w, h);
    const s = close ? Math.min(w * 0.75, h * 0.62) : Math.min(w * 0.42, h * 0.32);
    person(g, w / 2, close ? h * 0.5 - s * 0.62 : h - s * 3.05, s, { blemishes, shirt, seed });
  });
  return grain(c, back === 'white' ? 4 : 9, seed);
}

/** Only the person, on a transparent layer (for Dispersion and Double Exposure checks). */
export function personLayer(w, h, opts = {}) {
  const s = Math.min(w * 0.42, h * 0.32);
  return canvas(w, h, (g) => person(g, w / 2, h - s * 3.05, s, opts));
}

// ---------------------------------------------------------------- objects and textures

export function bricks(w, h, { dark = true, seed = 31 } = {}) {
  const c = canvas(w, h, (g) => {
    g.fillStyle = dark ? '#2a2624' : '#9a958c';
    g.fillRect(0, 0, w, h);
    const r = rng(seed);
    const bw = 96;
    const bh = 40;
    for (let row = 0, y = 0; y < h; row++, y += bh) {
      for (let x = row % 2 ? -bw / 2 : 0; x < w; x += bw) {
        const k = 0.75 + r() * 0.35;
        const base = dark ? [92, 48, 38] : [168, 82, 60];
        g.fillStyle = `rgb(${base.map((v) => Math.round(v * k)).join(',')})`;
        g.fillRect(x + 3, y + 3, bw - 6, bh - 6);
      }
    }
    // vignette
    const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.7);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, dark ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.35)');
    g.fillStyle = v;
    g.fillRect(0, 0, w, h);
  });
  return grain(c, 22, seed);
}

/** A backdrop and a floor (for product shots). */
export function studioFloor(w, h, { top = '#d9dde2', bottom = '#b7bcc2' } = {}) {
  return grain(canvas(w, h, (g) => {
    g.fillStyle = vgrad(g, h, [[0, top], [0.62, '#eef0f2'], [0.64, '#c9cdd2'], [1, bottom]]);
    g.fillRect(0, 0, w, h);
  }), 5, 41);
}

/** A cosmetic bottle on a transparent layer, standing on y = `base`. */
export function bottle(w, h, base) {
  return canvas(w, h, (g) => {
    const cx = w / 2;
    const bw = w * 0.16;
    const bh = h * 0.42;
    const y0 = base - bh;
    const glass = g.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
    glass.addColorStop(0, '#1f5d55');
    glass.addColorStop(0.3, '#5fb3a3');
    glass.addColorStop(0.45, '#c8f0e6');
    glass.addColorStop(0.6, '#3f8f80');
    glass.addColorStop(1, '#143f3a');
    g.fillStyle = glass;
    g.beginPath();
    g.roundRect(cx - bw / 2, y0, bw, bh, bw * 0.18);
    g.fill();
    // cap
    const cap = g.createLinearGradient(cx - bw * 0.3, 0, cx + bw * 0.3, 0);
    cap.addColorStop(0, '#6b5a3a');
    cap.addColorStop(0.4, '#f3dfa8');
    cap.addColorStop(1, '#5c4b2e');
    g.fillStyle = cap;
    g.beginPath();
    g.roundRect(cx - bw * 0.28, y0 - bh * 0.22, bw * 0.56, bh * 0.24, 6);
    g.fill();
    // label
    g.fillStyle = 'rgba(250,248,240,0.92)';
    g.fillRect(cx - bw * 0.42, y0 + bh * 0.35, bw * 0.84, bh * 0.3);
    g.fillStyle = '#244';
    g.font = `bold ${Math.round(bw * 0.15)}px sans-serif`;
    g.textAlign = 'center';
    g.fillText('MONTAGE', cx, y0 + bh * 0.52);
    g.font = `${Math.round(bw * 0.09)}px sans-serif`;
    g.fillText('SERUM 30ml', cx, y0 + bh * 0.6);
  });
}

/** An orange on a wooden table (for the selection lesson). */
export function fruitTable(w, h) {
  const c = canvas(w, h, (g) => {
    g.fillStyle = vgrad(g, h, [[0, '#6d7f8c'], [0.6, '#a3b3bd']]);
    g.fillRect(0, 0, w, h * 0.62);
    g.fillStyle = vgrad(g, h, [[0.62, '#8a5a34'], [1, '#5a3a20']]);
    g.fillRect(0, h * 0.62, w, h * 0.38);
    g.strokeStyle = 'rgba(40,20,10,0.25)';
    g.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      const y = h * 0.64 + i * h * 0.021;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(w * 0.3, y + 6, w * 0.6, y - 6, w, y + 3);
      g.stroke();
    }
    const cx = w * 0.5;
    const cy = h * 0.6;
    const R = Math.min(w, h) * 0.2;
    // shadow
    g.fillStyle = 'rgba(20,10,0,0.45)';
    g.beginPath();
    g.ellipse(cx + R * 0.15, cy + R * 0.92, R * 1.05, R * 0.22, 0, 0, Math.PI * 2);
    g.fill();
    const o = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    o.addColorStop(0, '#ffd27a');
    o.addColorStop(0.45, '#f39a1e');
    o.addColorStop(1, '#b85a08');
    g.fillStyle = o;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3f7a2a';
    g.beginPath();
    g.ellipse(cx + R * 0.2, cy - R * 1.02, R * 0.32, R * 0.12, -0.5, 0, Math.PI * 2);
    g.fill();
  });
  return grain(c, 10, 51);
}

/** A hot-air balloon sticker on a transparent layer. */
export function balloon(size) {
  return canvas(size, size * 1.3, (g, w, h) => {
    const cx = w / 2;
    const R = w * 0.42;
    const cy = R + 6;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, Math.PI * 0.8, Math.PI * 0.2);
    g.quadraticCurveTo(cx + R * 0.55, h * 0.62, cx + R * 0.22, h * 0.72);
    g.lineTo(cx - R * 0.22, h * 0.72);
    g.quadraticCurveTo(cx - R * 0.55, h * 0.62, cx + Math.cos(Math.PI * 0.8) * R, cy + Math.sin(Math.PI * 0.8) * R);
    g.closePath();
    g.clip();
    const cols = ['#e63946', '#f1c453', '#2a9d8f', '#f1c453', '#e63946', '#457b9d'];
    const sw = (R * 2) / cols.length;
    cols.forEach((col, i) => {
      g.fillStyle = col;
      g.fillRect(cx - R + i * sw, 0, sw + 1, h);
    });
    const shade = g.createRadialGradient(cx - R * 0.4, cy - R * 0.4, R * 0.1, cx, cy, R * 1.3);
    shade.addColorStop(0, 'rgba(255,255,255,0.35)');
    shade.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);
    g.restore();
    g.strokeStyle = '#4a3a2a';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - R * 0.22, h * 0.72);
    g.lineTo(cx - R * 0.15, h * 0.84);
    g.moveTo(cx + R * 0.22, h * 0.72);
    g.lineTo(cx + R * 0.15, h * 0.84);
    g.stroke();
    g.fillStyle = '#8a5a2a';
    g.fillRect(cx - R * 0.18, h * 0.84, R * 0.36, h * 0.1);
  });
}

/** A leaf-and-berry motif on a cream tile (for the seamless pattern lesson). */
export function motif(size) {
  return canvas(size, size, (g, w, h) => {
    g.fillStyle = '#f6efe1';
    g.fillRect(0, 0, w, h);
    const leaf = (x, y, a, s, col) => {
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(0, -s);
      g.quadraticCurveTo(s * 0.6, 0, 0, s);
      g.quadraticCurveTo(-s * 0.6, 0, 0, -s);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(0, -s * 0.8);
      g.lineTo(0, s * 0.8);
      g.stroke();
      g.restore();
    };
    leaf(w * 0.5, h * 0.5, 0.6, w * 0.16, '#5a8a4a');
    leaf(w * 0.38, h * 0.42, -0.9, w * 0.11, '#7aa65a');
    leaf(w * 0.62, h * 0.6, 2.2, w * 0.1, '#3f6f3a');
    g.fillStyle = '#c8414b';
    for (const [x, y] of [[0.45, 0.62], [0.52, 0.66], [0.58, 0.38]]) {
      g.beginPath();
      g.arc(w * x, h * y, w * 0.035, 0, Math.PI * 2);
      g.fill();
    }
  });
}

/** A ball on a transparent layer at (x, y), for the animated GIF frames. */
export function ball(w, h, x, y, r, color = '#ff6b35') {
  return canvas(w, h, (g) => {
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    gr.addColorStop(0, '#fff2d0');
    gr.addColorStop(0.35, color);
    gr.addColorStop(1, '#7a2a10');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  });
}

export function solid(w, h, color) {
  return canvas(w, h, (g) => {
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
  });
}
