// The painting modes of the blur, sharpen and smudge tools (표준, 어둡게 하기, 밝게 하기, 색조, 채도,
// 색상, 광도): how a retouched colour v replaces the colour b under the brush. Colours are 0..255.

export const RETOUCH_MODES = [['normal', '표준'], ['darken', '어둡게 하기'], ['lighten', '밝게 하기'], ['hue', '색조'], ['saturation', '채도'], ['color', '색상'], ['luminosity', '광도']];

const lum = (r, g, b) => r * 0.3 + g * 0.59 + b * 0.11;

/** setLum + clipColor of the W3C compositing spec, into out. */
function withLum(r, g, b, l, out) {
  const d = l - lum(r, g, b);
  r += d;
  g += d;
  b += d;
  const L = lum(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  const k = n < 0 ? L / Math.max(1e-6, L - n) : 1;
  const k2 = x > 255 ? (255 - L) / Math.max(1e-6, x - L) : 1;
  const s = Math.min(k, k2);
  out[0] = L + (r - L) * s;
  out[1] = L + (g - L) * s;
  out[2] = L + (b - L) * s;
}

/** setSat of the W3C compositing spec: the colour's hue with saturation (max - min) s. */
function withSat(r, g, b, s, out) {
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (x <= n) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  out[0] = ((r - n) * s) / (x - n);
  out[1] = ((g - n) * s) / (x - n);
  out[2] = ((b - n) * s) / (x - n);
}

const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
const t = [0, 0, 0];

/**
 * Mix the retouched colour v (array, 3+ values) into the base colour b (array at offset o) by the
 * mode; v is changed in place. Returns v.
 */
export function retouchMode(mode, b, o, v) {
  const br = b[o];
  const bg = b[o + 1];
  const bb = b[o + 2];
  switch (mode) {
    case 'darken':
      v[0] = Math.min(br, v[0]);
      v[1] = Math.min(bg, v[1]);
      v[2] = Math.min(bb, v[2]);
      break;
    case 'lighten':
      v[0] = Math.max(br, v[0]);
      v[1] = Math.max(bg, v[1]);
      v[2] = Math.max(bb, v[2]);
      break;
    case 'hue':
      withSat(v[0], v[1], v[2], sat(br, bg, bb), t);
      withLum(t[0], t[1], t[2], lum(br, bg, bb), v);
      break;
    case 'saturation':
      withSat(br, bg, bb, sat(v[0], v[1], v[2]), t);
      withLum(t[0], t[1], t[2], lum(br, bg, bb), v);
      break;
    case 'color':
      withLum(v[0], v[1], v[2], lum(br, bg, bb), v);
      break;
    case 'luminosity':
      withLum(br, bg, bb, lum(v[0], v[1], v[2]), v);
      break;
    default:
  }
  return v;
}
