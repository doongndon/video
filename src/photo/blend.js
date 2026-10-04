// Blend modes. Most map to a canvas composite operation; the rest (dissolve, linear burn, vivid light…)
// are computed per pixel with the W3C compositing formula: Cs' = (1 - ab)·Cs + ab·B(Cb, Cs), then
// source-over with the source alpha.

/** [id (PSD name), Korean label, canvas operation or null when computed here] grouped like Photoshop. */
export const BLEND_GROUPS = [
  [['normal', '표준', 'source-over'], ['dissolve', '디졸브', null]],
  [['darken', '어둡게 하기', 'darken'], ['multiply', '곱하기', 'multiply'], ['color burn', '색상 번', 'color-burn'], ['linear burn', '선형 번', null], ['darker color', '어두운 색상', null]],
  [['lighten', '밝게 하기', 'lighten'], ['screen', '스크린', 'screen'], ['color dodge', '색상 닷지', 'color-dodge'], ['linear dodge', '선형 닷지 (추가)', 'lighter'], ['lighter color', '밝은 색상', null]],
  [['overlay', '오버레이', 'overlay'], ['soft light', '소프트 라이트', 'soft-light'], ['hard light', '하드 라이트', 'hard-light'], ['vivid light', '선명한 라이트', null], ['linear light', '선형 라이트', null], ['pin light', '핀 라이트', null], ['hard mix', '하드 혼합', null]],
  [['difference', '차이', 'difference'], ['exclusion', '제외', 'exclusion'], ['subtract', '빼기', null], ['divide', '나누기', null]],
  [['hue', '색조', 'hue'], ['saturation', '채도', 'saturation'], ['color', '색상', 'color'], ['luminosity', '광도', 'luminosity']],
];
export const PASS_THROUGH = ['pass through', '통과', null];
export const BLEND_MODES = BLEND_GROUPS.flat();
const OP = Object.fromEntries(BLEND_MODES.map(([id, , op]) => [id, op]));
export const blendName = (id) => (id === 'pass through' ? '통과' : BLEND_MODES.find((b) => b[0] === id)?.[1] || id);
export const isBlend = (id) => id in OP || id === 'pass through';

/** The canvas operation for a mode, or null when the mode has to be computed per pixel. */
export function canvasOp(mode) {
  if (!mode || mode === 'pass through') return 'source-over';
  return OP[mode] === undefined ? 'source-over' : OP[mode];
}

// separable blend functions on 0..1 values
const burn = (b, s) => (s <= 0 ? (b >= 1 ? 1 : 0) : 1 - Math.min(1, (1 - b) / s));
const dodge = (b, s) => (s >= 1 ? (b <= 0 ? 0 : 1) : Math.min(1, b / (1 - s)));
const SEP = {
  'linear burn': (b, s) => Math.max(0, b + s - 1),
  'vivid light': (b, s) => (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * (s - 0.5))),
  'linear light': (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
  'pin light': (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  'hard mix': (b, s) => (b + s >= 1 - 1e-6 ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s)),
};

// deterministic per-pixel noise for dissolve
const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * Composite `src` (canvas at sx, sy in ctx pixels) onto ctx with `mode` and `alpha`.
 * Uses the canvas operation when there is one, otherwise blends the pixels here.
 */
export function compositeOnto(ctx, src, sx, sy, mode, alpha = 1) {
  const op = canvasOp(mode);
  if (OP[mode] !== null || mode === 'pass through' || !(mode in OP)) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(src, sx, sy);
    ctx.restore();
    return;
  }
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const x0 = Math.max(0, Math.floor(sx));
  const y0 = Math.max(0, Math.floor(sy));
  const x1 = Math.min(W, Math.ceil(sx + src.width));
  const y1 = Math.min(H, Math.ceil(sy + src.height));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const dst = ctx.getImageData(x0, y0, w, h);
  // the source region aligned to the destination pixels
  let sdata;
  if (Number.isInteger(sx) && Number.isInteger(sy)) {
    sdata = src.getContext('2d').getImageData(x0 - sx, y0 - sy, w, h).data;
  } else {
    const t = document.createElement('canvas');
    t.width = w;
    t.height = h;
    t.getContext('2d').drawImage(src, sx - x0, sy - y0);
    sdata = t.getContext('2d').getImageData(0, 0, w, h).data;
  }
  blendData(dst.data, sdata, mode, alpha, x0, y0, w);
  ctx.putImageData(dst, x0, y0);
}

/** Blend source pixels over destination pixels in place (both non-premultiplied RGBA bytes). */
export function blendData(d, s, mode, alpha, ox = 0, oy = 0, w = 1) {
  const f = SEP[mode];
  const n = d.length;
  for (let i = 0; i < n; i += 4) {
    let as = (s[i + 3] / 255) * alpha;
    if (as <= 0) continue;
    if (mode === 'dissolve') {
      const p = i / 4;
      if (hash(ox + (p % w), oy + Math.floor(p / w)) >= as) continue;
      as = 1;
    }
    const ab = d[i + 3] / 255;
    let r = s[i] / 255;
    let g = s[i + 1] / 255;
    let b = s[i + 2] / 255;
    const cr = d[i] / 255;
    const cg = d[i + 1] / 255;
    const cb = d[i + 2] / 255;
    if (ab > 0 && mode !== 'dissolve') {
      let br;
      let bg;
      let bb;
      if (f) {
        br = f(cr, r);
        bg = f(cg, g);
        bb = f(cb, b);
      } else {
        // darker / lighter colour pick a whole colour by its luminance
        const darker = 0.3 * cr + 0.59 * cg + 0.11 * cb < 0.3 * r + 0.59 * g + 0.11 * b;
        const pickBack = mode === 'darker color' ? darker : !darker;
        [br, bg, bb] = pickBack ? [cr, cg, cb] : [r, g, b];
      }
      r = (1 - ab) * r + ab * br;
      g = (1 - ab) * g + ab * bg;
      b = (1 - ab) * b + ab * bb;
    }
    const ao = as + ab * (1 - as);
    d[i] = Math.round(((as * r + ab * (1 - as) * cr) / ao) * 255);
    d[i + 1] = Math.round(((as * g + ab * (1 - as) * cg) / ao) * 255);
    d[i + 2] = Math.round(((as * b + ab * (1 - as) * cb) / ao) * 255);
    d[i + 3] = Math.round(ao * 255);
  }
}
