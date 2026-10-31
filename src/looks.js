// Built-in creative Looks for Lumetri 색상 (크리에이티브 ▸ Look). Each look is a colour function on
// display-referred RGB (0..1) that is baked into a small 3D LUT once and applied on the GPU, the
// same way an imported .cube LUT is.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = ([r, g, b], s) => {
  const l = luma(r, g, b);
  return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s];
};
const contrast = ([r, g, b], k, pivot = 0.45) => [pivot + (r - pivot) * k, pivot + (g - pivot) * k, pivot + (b - pivot) * k];
/** Smooth S-curve around 0.5 (k > 1 adds contrast). */
const scurve = (x, k) => {
  const y = x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 * (1 - x), k);
  return clamp01(y);
};
const fade = ([r, g, b], lo, hi) => [lo + r * (hi - lo), lo + g * (hi - lo), lo + b * (hi - lo)];
/** Split toning: tint shadows towards `sh` and highlights towards `hi` (RGB offsets). */
const split = ([r, g, b], sh, hi, amt = 1) => {
  const l = luma(r, g, b);
  const ws = (1 - l) * (1 - l) * amt;
  const wh = l * l * amt;
  return [r + sh[0] * ws + hi[0] * wh, g + sh[1] * ws + hi[1] * wh, b + sh[2] * ws + hi[2] * wh];
};
const mono = ([r, g, b], wr = 0.3, wg = 0.59, wb = 0.11) => {
  const l = r * wr + g * wg + b * wb;
  return [l, l, l];
};

/** [id, Korean name, fn(r, g, b) → [r, g, b]] */
export const LOOKS = [
  ['look:tealOrange', '시네마틱 틸 앤 오렌지', (c) => {
    let o = split(c, [-0.06, 0.03, 0.08], [0.09, 0.03, -0.07], 1.4);
    o = o.map((v) => scurve(clamp01(v), 1.25));
    return sat(o, 1.08);
  }],
  ['look:bleach', '블리치 바이패스', (c) => {
    const m = mono(c, 0.2126, 0.7152, 0.0722).map((v) => scurve(v, 1.6));
    const o = c.map((v, i) => v * 0.45 + m[i] * 0.55);
    return contrast(o, 1.12);
  }],
  ['look:warmFilm', '따뜻한 필름', (c) => {
    let o = [c[0] * 1.06 + 0.015, c[1] * 1.0 + 0.01, c[2] * 0.9];
    o = o.map((v) => scurve(clamp01(v), 1.12));
    return fade(sat(o, 0.92), 0.05, 0.97);
  }],
  ['look:coolFilm', '차가운 필름', (c) => {
    let o = [c[0] * 0.92, c[1] * 1.0 + 0.01, c[2] * 1.08 + 0.02];
    o = o.map((v) => scurve(clamp01(v), 1.12));
    return fade(sat(o, 0.9), 0.05, 0.97);
  }],
  ['look:vintage', '빈티지', (c) => {
    let o = split(c, [0.05, -0.02, 0.06], [0.06, 0.04, -0.08], 1);
    o = sat(o, 0.72);
    return fade(o, 0.08, 0.93);
  }],
  ['look:matte', '매트 페이드', (c) => fade(c.map((v) => scurve(v, 1.08)), 0.1, 0.92)],
  ['look:cross', '크로스 프로세스', (c) => {
    const o = [scurve(c[0], 1.35), clamp01(c[1] * 1.06 + 0.02), clamp01(c[2] * 0.75 + 0.12)];
    return sat(o, 1.15);
  }],
  ['look:golden', '골든 아워', (c) => {
    const o = split(c, [0.04, 0.0, -0.03], [0.12, 0.06, -0.08], 1.1);
    return sat(o.map((v) => scurve(clamp01(v), 1.08)), 1.1);
  }],
  ['look:blueHour', '블루 아워', (c) => {
    const o = split(c, [-0.02, 0.02, 0.1], [-0.03, 0.02, 0.06], 1.2);
    return sat(o, 0.95);
  }],
  ['look:pastel', '파스텔', (c) => fade(sat(c.map((v) => scurve(v, 0.85)), 0.8), 0.08, 1)],
  ['look:dayForNight', '낮을 밤처럼', (c) => {
    const o = sat(c, 0.45).map((v) => v * 0.55);
    return [o[0] * 0.8, o[1] * 0.95, Math.min(1, o[2] * 1.35 + 0.03)];
  }],
  ['look:noir', '흑백 느와르', (c) => mono(c).map((v) => scurve(v, 1.7))],
  ['look:softMono', '부드러운 흑백', (c) => fade(mono(c).map((v) => scurve(v, 1.1)), 0.05, 0.96)],
  ['look:sepiaFilm', '세피아 필름', (c) => {
    const l = scurve(luma(...c), 1.1);
    return fade([l * 1.07 + 0.02, l * 0.92 + 0.01, l * 0.72], 0.04, 0.97);
  }],
];

const BY_ID = new Map(LOOKS.map(([id, , fn]) => [id, fn]));

export const isBuiltinLook = (id) => typeof id === 'string' && BY_ID.has(id);

/** Bake a built-in look into a { size, data } 3D LUT (r fastest, like .cube files). */
export function bakeLook(id, size = 25) {
  const fn = BY_ID.get(id);
  if (!fn) return null;
  const data = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
        data[o++] = clamp01(out[0]);
        data[o++] = clamp01(out[1]);
        data[o++] = clamp01(out[2]);
      }
    }
  }
  return { size, data };
}
