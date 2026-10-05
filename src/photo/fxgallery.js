// The Filter Gallery's effects (Artistic, Brush Strokes, Sketch, Texture, Distort, Stylize), registered
// into FILTERS with gallery: true so they appear in the gallery (and smart filters, actions, the AI
// assistant) but not as separate Filter menu groups, like Photoshop. Sketch effects draw with the
// foreground and background colours, also like Photoshop. All are our own approximations.

import { FILTERS } from './adjust.js';
import {
  mk, read, toCanvas, lum, cl, clamp, smooth, hexRgb, grayOf, gaussF, sobelF, noiseF,
  whiteF, strokesF, shadeF, duo, kuwahara, voronoi, regionMeans, dirBlur, blurred, remap, floatCanvas, canvasFloat,
} from './fxutil.js';

const LIGHTS = [['top', '위'], ['topLeft', '왼쪽 위'], ['left', '왼쪽'], ['bottomLeft', '왼쪽 아래'], ['bottom', '아래'], ['bottomRight', '오른쪽 아래'], ['right', '오른쪽'], ['topRight', '오른쪽 위']];
const LIGHT_ANGLE = { right: 0, topRight: 45, top: 90, topLeft: 135, left: 180, bottomLeft: 225, bottom: 270, bottomRight: 315 };
const DIRS = [['rightDiag', '오른쪽 대각선'], ['horizontal', '가로'], ['leftDiag', '왼쪽 대각선'], ['vertical', '세로']];
const DIR_ANGLE = { rightDiag: -45, horizontal: 0, leftDiag: 45, vertical: 90 };

/** Pixels of a canvas with lazily computed luminance. */
function px(c) {
  const img = read(c);
  const o = { img, w: img.width, h: img.height, d: img.data, n: img.width * img.height };
  let L = null;
  Object.defineProperty(o, 'L', { get: () => L || (L = grayOf(img)) });
  return o;
}
/** New picture from a per-pixel function (i, rgba out) keeping the source alpha. */
function each(s, fn) {
  const out = new ImageData(s.w, s.h);
  const o = out.data;
  const t = [0, 0, 0];
  for (let i = 0; i < s.n; i++) {
    fn(i, t);
    o[i * 4] = cl(t[0]);
    o[i * 4 + 1] = cl(t[1]);
    o[i * 4 + 2] = cl(t[2]);
    o[i * 4 + 3] = s.d[i * 4 + 3];
  }
  return toCanvas(out);
}
const posterize = (v, levels) => {
  const st = 255 / Math.max(1, levels - 1);
  return Math.round(v / st) * st;
};
/** A procedural relief (height 0..255) for Texturizer, Rough Pastels, Underpainting, Conté. */
function textureMap(kind, w, h, scale = 1) {
  const H = new Float32Array(w * h);
  const s = Math.max(0.3, scale);
  if (kind === 'brick') {
    const bw = 48 * s;
    const bh = 20 * s;
    for (let y = 0; y < h; y++) {
      const row = Math.floor(y / bh);
      const yy = y - row * bh;
      for (let x = 0; x < w; x++) {
        const xx = (x + (row % 2) * bw * 0.5) % bw;
        const mortar = Math.min(yy, bh - yy, xx, bw - xx);
        H[y * w + x] = mortar < 2.5 * s ? 60 : 200;
      }
    }
    return gaussF(H, w, h, 1.2 * s);
  }
  if (kind === 'burlap' || kind === 'canvas') {
    const p = (kind === 'burlap' ? 8 : 4) * s;
    const N = noiseF(w, h, p * 3, 2, 5);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = Math.sin((x / p) * Math.PI);
        const b = Math.sin((y / p) * Math.PI);
        // over/under weave: threads alternate which one is on top
        const top = (Math.floor(x / p) + Math.floor(y / p)) % 2 ? Math.abs(a) : Math.abs(b);
        H[y * w + x] = top * 170 + N[y * w + x] * (kind === 'burlap' ? 85 : 40);
      }
    }
    return H;
  }
  // sandstone and frosted: grainy noise
  const N = noiseF(w, h, 6 * s, 3, 9);
  const W = whiteF(w, h, 13);
  for (let i = 0; i < H.length; i++) H[i] = N[i] * 180 + W[i] * 75;
  return gaussF(H, w, h, 0.7 * s);
}

const G = {};
const add = (id, cat, name, params, fn) => {
  G[id] = { name, group: '필터 갤러리', cat, gallery: true, slow: true, params, fn };
};

// ---------------------------------------------------------------- 예술 효과 (Artistic)
add('coloredPencil', '예술 효과', '색연필', [['width', '연필 폭', 1, 24, 4], ['pressure', '획 압력', 0, 15, 8], ['paper', '종이 밝기', 0, 50, 25]], (c, p, { bg }) => {
  const s = px(c);
  const len = p.width * 4 + 4;
  const A = strokesF(s.w, s.h, -45, len, 0.18, 3);
  const B = strokesF(s.w, s.h, 45, len, 0.18, 4);
  const { mag } = sobelF(gaussF(s.L, s.w, s.h, 1), s.w, s.h);
  const [pr, pg, pb] = hexRgb(bg).map((v) => v * (0.75 + p.paper / 200));
  return each(s, (i, o) => {
    const dark = 1 - s.L[i] / 255;
    const hatch = Math.max(A[i], dark > 0.45 ? B[i] : 0);
    const ink = clamp(hatch * dark * (0.5 + p.pressure / 12) * 1.8 + smooth(30, 160, mag[i]) * 0.5, 0, 1);
    const k = i * 4;
    o[0] = pr + (s.d[k] * 0.85 - pr) * ink;
    o[1] = pg + (s.d[k + 1] * 0.85 - pg) * ink;
    o[2] = pb + (s.d[k + 2] * 0.85 - pb) * ink;
  });
});
add('dryBrush', '예술 효과', '드라이 브러시', [['size', '브러시 크기', 0, 10, 2], ['detail', '브러시 세부', 0, 10, 8], ['texture', '텍스처', 1, 3, 1]], (c, p) => {
  const k = px(toCanvas(kuwahara(read(c), 1 + Math.round(p.size / 2))));
  const N = whiteF(k.w, k.h, 2);
  const lv = 4 + p.detail * 2;
  return each(k, (i, o) => {
    const n = (N[i] - 0.5) * p.texture * 14;
    for (let ch = 0; ch < 3; ch++) o[ch] = posterize(k.d[i * 4 + ch], lv) + n;
  });
});
add('filmGrain', '예술 효과', '필름 그레인', [['grain', '그레인', 0, 20, 4], ['highlight', '밝은 영역', 0, 20, 0], ['intensity', '강도', 0, 10, 10]], (c, p) => {
  const s = px(c);
  const N = whiteF(s.w, s.h, 7);
  const cut = 255 - p.highlight * 9;
  return each(s, (i, o) => {
    const L = s.L[i];
    const mid = 1 - Math.abs(L / 127.5 - 1) * 0.6;
    const n = (N[i] - 0.5) * p.grain * 7 * mid;
    const hl = p.highlight ? smooth(cut - 30, cut, L) * (p.intensity / 10) : 0;
    for (let ch = 0; ch < 3; ch++) {
      const v = s.d[i * 4 + ch] + n;
      o[ch] = v + (255 - v) * hl;
    }
  });
});
add('fresco', '예술 효과', '프레스코', [['size', '브러시 크기', 0, 10, 2], ['detail', '브러시 세부', 0, 10, 8], ['texture', '텍스처', 1, 3, 1]], (c, p) => {
  const k = px(toCanvas(kuwahara(read(c), 2 + Math.round(p.size / 2))));
  const { mag } = sobelF(k.L, k.w, k.h);
  const N = noiseF(k.w, k.h, 3, 2, 4);
  return each(k, (i, o) => {
    const edge = smooth(20, 120 - p.detail * 6, mag[i]) * 0.7;
    const n = (N[i] - 0.5) * p.texture * 24;
    for (let ch = 0; ch < 3; ch++) o[ch] = ((k.d[i * 4 + ch] - 128) * 1.35 + 128) * (1 - edge) + n;
  });
});
add('neonGlow', '예술 효과', '네온 광', [['size', '광선 크기', -24, 24, 5], ['brightness', '광선 밝기', 0, 50, 15], ['color', '광선 색', null, null, '#3fa9ff', 'color']], (c, p, { fg }) => {
  const s = px(c);
  const [gr, gg, gb] = hexRgb(p.color);
  const [fr, fgc, fb] = hexRgb(fg);
  const src = p.size >= 0 ? s.L : s.L.map((v) => 255 - v);
  const glow = gaussF(src.map((v) => smooth(110, 230, v) * 255), s.w, s.h, Math.abs(p.size) + 1);
  return each(s, (i, o) => {
    const t = s.L[i] / 255;
    const gl = (glow[i] / 255) * (p.brightness / 15);
    o[0] = fr * (1 - t) * 0.5 + t * 90 + gr * gl;
    o[1] = fgc * (1 - t) * 0.5 + t * 90 + gg * gl;
    o[2] = fb * (1 - t) * 0.5 + t * 90 + gb * gl;
  });
});
add('paintDaubs', '예술 효과', '페인트 바르기', [['size', '브러시 크기', 1, 50, 8], ['sharpness', '선명도', 0, 40, 7], ['type', '브러시 종류', null, null, 'simple', [['simple', '단순'], ['lightRough', '밝고 거칠게'], ['darkRough', '어둡고 거칠게'], ['wideSharp', '넓고 선명하게'], ['wideBlurry', '넓고 흐리게'], ['sparkle', '반짝임']]]], (c, p) => {
  const r = Math.max(1, Math.round(p.size / (p.type.startsWith('wide') ? 3 : 5)));
  const k = px(toCanvas(kuwahara(read(c), r)));
  const b = read(blurred(toCanvas(k.img), 1.5)).data;
  const sh = p.type === 'wideBlurry' ? -0.4 : (p.sharpness / 40) * (p.type === 'wideSharp' ? 2.5 : 1.5);
  const N = whiteF(k.w, k.h, 11);
  return each(k, (i, o) => {
    for (let ch = 0; ch < 3; ch++) {
      let v = k.d[i * 4 + ch] + (k.d[i * 4 + ch] - b[i * 4 + ch]) * sh;
      if (p.type === 'lightRough') v += (N[i] - 0.3) * 40;
      if (p.type === 'darkRough') v -= (N[i] - 0.3) * 50;
      if (p.type === 'sparkle' && N[i] > 0.985) v = 255;
      o[ch] = v;
    }
  });
});
add('paletteKnife', '예술 효과', '팔레트 나이프', [['size', '획 크기', 1, 50, 25], ['detail', '획 세부', 1, 3, 3], ['softness', '부드러움', 0, 10, 0]], (c, p) => {
  const f = Math.max(1, p.size / 8);
  const sw = Math.max(1, Math.round(c.width / f));
  const sh = Math.max(1, Math.round(c.height / f));
  const s = mk(sw, sh);
  const sg = s.getContext('2d');
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(c, 0, 0, sw, sh);
  const k = toCanvas(kuwahara(read(s), 4 - p.detail + 1));
  const out = mk(c.width, c.height);
  const og = out.getContext('2d');
  og.imageSmoothingEnabled = p.softness > 0;
  og.drawImage(k, 0, 0, c.width, c.height);
  og.globalCompositeOperation = 'destination-in';
  og.drawImage(c, 0, 0);
  return p.softness ? blurred(out, p.softness / 3) : out;
});
add('plasticWrap', '예술 효과', '플라스틱 포장', [['highlight', '밝은 영역 강도', 0, 20, 15], ['detail', '세부', 1, 15, 9], ['smoothness', '매끄러움', 1, 15, 7]], (c, p) => {
  const s = px(c);
  const H = gaussF(s.L, s.w, s.h, p.smoothness * 0.8);
  const sh = shadeF(H, s.w, s.h, 135, p.detail * 1.5);
  return each(s, (i, o) => {
    const spec = smooth(0.2, 0.7, sh[i]) * (p.highlight / 20);
    const dark = smooth(0.2, 0.7, -sh[i]) * 0.35;
    for (let ch = 0; ch < 3; ch++) o[ch] = s.d[i * 4 + ch] * (1 - dark) + (255 - s.d[i * 4 + ch]) * spec;
  });
});
add('roughPastels', '예술 효과', '거친 파스텔', [['length', '획 길이', 0, 40, 6], ['detail', '획 세부', 1, 20, 4], ['texture', '텍스처', null, null, 'canvas', [['canvas', '캔버스'], ['burlap', '삼베'], ['sandstone', '사암'], ['brick', '벽돌']]], ['relief', '부조', 0, 50, 20]], (c, p) => {
  const st = px(dirBlur(c, -45, p.length * 2 + 2));
  const s = px(c);
  const H = textureMap(p.texture, s.w, s.h);
  const sh = shadeF(H, s.w, s.h, 135, 1);
  const keep = p.detail / 25;
  return each(s, (i, o) => {
    const r = 1 + sh[i] * (p.relief / 25);
    for (let ch = 0; ch < 3; ch++) o[ch] = (st.d[i * 4 + ch] * (1 - keep) + s.d[i * 4 + ch] * keep) * r;
  });
});
add('smudgeStick', '예술 효과', '문지르기 효과', [['length', '획 길이', 0, 10, 2], ['highlight', '밝은 영역', 0, 20, 0], ['intensity', '강도', 0, 10, 10]], (c, p) => {
  const st = px(dirBlur(c, -45, p.length * 4 + 3));
  const cut = 255 - p.highlight * 9;
  return each(st, (i, o) => {
    const L = st.L[i];
    const hl = p.highlight ? smooth(cut - 30, cut, L) * (p.intensity / 10) : 0;
    for (let ch = 0; ch < 3; ch++) {
      const v = ((st.d[i * 4 + ch] - 128) * 1.15 + 128);
      o[ch] = v + (255 - v) * hl;
    }
  });
});
add('sponge', '예술 효과', '스폰지', [['size', '브러시 크기', 0, 10, 2], ['definition', '선명도', 0, 25, 12], ['smoothness', '매끄러움', 1, 15, 5]], (c, p) => {
  const s = px(blurred(c, p.smoothness / 4));
  const N = noiseF(s.w, s.h, p.size + 2, 2, 17);
  return each(s, (i, o) => {
    const hole = smooth(0.45, 0.6, N[i]) * (p.definition / 30);
    for (let ch = 0; ch < 3; ch++) o[ch] = posterize(s.d[i * 4 + ch], 8) * (1 - hole) + s.d[i * 4 + ch] * 0.15 * hole;
  });
});
add('underpainting', '예술 효과', '언더페인팅 효과', [['size', '브러시 크기', 0, 40, 6], ['coverage', '텍스처 범위', 0, 40, 16], ['texture', '텍스처', null, null, 'canvas', [['canvas', '캔버스'], ['burlap', '삼베'], ['sandstone', '사암'], ['brick', '벽돌']]], ['relief', '부조', 0, 50, 4]], (c, p) => {
  const b = px(blurred(c, p.size / 2 + 1));
  const s = px(c);
  const sh = shadeF(textureMap(p.texture, s.w, s.h), s.w, s.h, 135, 1);
  const mix = p.coverage / 40;
  return each(s, (i, o) => {
    const r = 1 + sh[i] * (p.relief / 25);
    for (let ch = 0; ch < 3; ch++) o[ch] = (b.d[i * 4 + ch] * mix + s.d[i * 4 + ch] * (1 - mix) * 0.5 + b.d[i * 4 + ch] * (1 - mix) * 0.5) * r;
  });
});
add('watercolor', '예술 효과', '수채화 효과', [['detail', '브러시 세부', 1, 14, 9], ['shadow', '어두운 영역 강도', 0, 10, 1], ['texture', '텍스처', 1, 3, 1]], (c, p) => {
  const k = px(blurred(toCanvas(kuwahara(read(c), 1 + Math.round((14 - p.detail) / 3))), 1));
  const { mag } = sobelF(k.L, k.w, k.h);
  const N = noiseF(k.w, k.h, 5, 2, 21);
  return each(k, (i, o) => {
    const L = k.L[i];
    const edge = smooth(10, 70, mag[i]) * 0.35;
    const sh = (1 - L / 255) * p.shadow * 0.07;
    const n = (N[i] - 0.5) * p.texture * 18;
    for (let ch = 0; ch < 3; ch++) {
      const v = L + (k.d[i * 4 + ch] - L) * 1.25;
      o[ch] = v * (1 - edge - sh) + n;
    }
  });
});

// ---------------------------------------------------------------- 브러시 획 (Brush Strokes)
add('accentedEdges', '브러시 획', '가장자리 강조', [['width', '가장자리 폭', 1, 14, 2], ['brightness', '가장자리 밝기', 0, 50, 38], ['smoothness', '매끄러움', 1, 15, 5]], (c, p) => {
  const s = px(c);
  const { mag } = sobelF(gaussF(s.L, s.w, s.h, p.smoothness / 4), s.w, s.h);
  const E = gaussF(mag, s.w, s.h, p.width / 2);
  const k = (p.brightness - 25) / 25;
  return each(s, (i, o) => {
    const e = smooth(10, 90, E[i]);
    for (let ch = 0; ch < 3; ch++) o[ch] = s.d[i * 4 + ch] + e * k * 200;
  });
});
add('angledStrokes', '브러시 획', '각진 획', [['balance', '방향 균형', 0, 100, 50], ['length', '획 길이', 3, 50, 15], ['sharpness', '선명도', 0, 10, 3]], (c, p) => {
  const A = px(dirBlur(c, -45, p.length));
  const B = px(dirBlur(c, 45, p.length));
  const s = px(c);
  const t0 = (p.balance / 100) * 255;
  const b2 = read(blurred(c, 1)).data;
  return each(s, (i, o) => {
    const k = smooth(t0 - 25, t0 + 25, s.L[i]);
    for (let ch = 0; ch < 3; ch++) {
      const j = i * 4 + ch;
      const v = A.d[j] * k + B.d[j] * (1 - k);
      o[ch] = v + (s.d[j] - b2[j]) * (p.sharpness / 4);
    }
  });
});
add('crosshatch', '브러시 획', '그물눈', [['length', '획 길이', 3, 50, 9], ['sharpness', '선명도', 0, 20, 6], ['strength', '강도', 1, 3, 1]], (c, p) => {
  const s = px(c);
  const A = strokesF(s.w, s.h, -45, p.length, 0.15, 5);
  const B = strokesF(s.w, s.h, 45, p.length, 0.15, 6);
  const b2 = read(blurred(c, 1)).data;
  return each(s, (i, o) => {
    const dark = 1 - s.L[i] / 255;
    const h1 = A[i] * dark;
    const h2 = dark > 0.5 ? B[i] * dark : 0;
    const ink = clamp((h1 + h2) * 0.45 * p.strength, 0, 0.9);
    for (let ch = 0; ch < 3; ch++) {
      const j = i * 4 + ch;
      o[ch] = (s.d[j] + (s.d[j] - b2[j]) * (p.sharpness / 8)) * (1 - ink);
    }
  });
});
add('darkStrokes', '브러시 획', '어두운 획', [['balance', '균형', 0, 10, 5], ['black', '검정 강도', 0, 10, 6], ['white', '흰색 강도', 0, 10, 2]], (c, p) => {
  const D = px(dirBlur(c, -45, 6));
  const Lg = px(dirBlur(c, 45, 14));
  const s = px(c);
  const t0 = 255 * (0.35 + p.balance / 30);
  return each(s, (i, o) => {
    const dark = s.L[i] < t0;
    for (let ch = 0; ch < 3; ch++) {
      const j = i * 4 + ch;
      o[ch] = dark ? D.d[j] * (1 - p.black / 14) : Lg.d[j] + (255 - Lg.d[j]) * (p.white / 16);
    }
  });
});
add('inkOutlines', '브러시 획', '잉크 윤곽선', [['length', '획 길이', 1, 50, 4], ['dark', '어두운 영역 강도', 0, 50, 20], ['light', '밝은 영역 강도', 0, 50, 10]], (c, p) => {
  const s = px(c);
  const { mag } = sobelF(s.L, s.w, s.h);
  const E = canvasFloat(dirBlur(floatCanvas(mag, s.w, s.h), -45, p.length));
  return each(s, (i, o) => {
    const ink = smooth(15, 80, E[i]) * (p.dark / 30);
    const lift = (s.L[i] / 255) * (p.light / 60);
    for (let ch = 0; ch < 3; ch++) {
      const v = s.d[i * 4 + ch] + (255 - s.d[i * 4 + ch]) * lift;
      o[ch] = v * (1 - clamp(ink + (1 - s.L[i] / 255) * (p.dark / 80), 0, 0.95));
    }
  });
});
const spatterOn = (c, radius, smoothness, seed) => {
  const w = c.width;
  const h = c.height;
  const X = gaussF(whiteF(w, h, seed), w, h, smoothness / 3);
  const Y = gaussF(whiteF(w, h, seed + 1), w, h, smoothness / 3);
  // the blurred noise has a small spread: normalise it
  const norm = (a) => {
    let m = 0;
    for (let i = 0; i < a.length; i += 7) m = Math.max(m, Math.abs(a[i] - 0.5));
    return m || 0.5;
  };
  const kx = radius / norm(X);
  const ky = radius / norm(Y);
  return remap(c, (x, y, o) => {
    const i = clamp(y | 0, 0, h - 1) * w + clamp(x | 0, 0, w - 1);
    o[0] = x + (X[i] - 0.5) * kx;
    o[1] = y + (Y[i] - 0.5) * ky;
  });
};
add('spatter', '브러시 획', '뿌리기', [['radius', '스프레이 반경', 0, 25, 10], ['smoothness', '매끄러움', 1, 15, 5]], (c, p) => spatterOn(c, p.radius, p.smoothness, 41));
add('sprayedStrokes', '브러시 획', '스프레이 획', [['length', '획 길이', 0, 20, 12], ['radius', '스프레이 반경', 0, 25, 7], ['direction', '획 방향', null, null, 'rightDiag', DIRS]], (c, p) => spatterOn(dirBlur(c, DIR_ANGLE[p.direction] ?? -45, p.length * 1.5 + 1), p.radius * 0.6, 3, 43));
add('sumie', '브러시 획', '수묵화', [['width', '획 폭', 3, 15, 10], ['pressure', '획 압력', 0, 15, 2], ['contrast', '대비', 0, 40, 16]], (c, p) => {
  const s = px(blurred(c, p.width / 4));
  const cut = 0.35 + p.pressure / 40;
  return each(s, (i, o) => {
    const dark = 1 - s.L[i] / 255;
    const ink = smooth(cut - 0.1, cut + 0.15, dark);
    const k = 1 + p.contrast / 25;
    for (let ch = 0; ch < 3; ch++) o[ch] = ((s.d[i * 4 + ch] - 128) * k + 128) * (1 - ink * 0.9);
  });
});

// ---------------------------------------------------------------- 스케치 효과 (Sketch, fg/bg colours)
add('basRelief', '스케치 효과', '저부조', [['detail', '세부', 1, 15, 13], ['smoothness', '매끄러움', 1, 15, 3], ['light', '조명', null, null, 'bottom', LIGHTS]], (c, p, { fg, bg }) => {
  const s = px(c);
  const H = gaussF(s.L, s.w, s.h, p.smoothness / 2);
  const sh = shadeF(H, s.w, s.h, LIGHT_ANGLE[p.light] ?? 270, p.detail / 3);
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) t[i] = 0.5 - sh[i] * 0.9;
  return toCanvas(duo(s.img, t, fg, bg));
});
add('chalkCharcoal', '스케치 효과', '분필과 목탄', [['charcoal', '목탄 영역', 0, 20, 6], ['chalk', '분필 영역', 0, 20, 6], ['pressure', '획 압력', 0, 5, 1]], (c, p, { fg, bg }) => {
  const s = px(c);
  const A = strokesF(s.w, s.h, -45, 14, 0.2, 51);
  const B = strokesF(s.w, s.h, 45, 14, 0.2, 52);
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const L = s.L[i] / 255;
    const char = smooth(0.65 - p.charcoal / 40, 0.95, 1 - L) * (0.5 + A[i]);
    const chalk = smooth(0.65 - p.chalk / 40, 0.95, L) * (0.5 + B[i]);
    t[i] = clamp(0.5 + (char - chalk) * (0.5 + p.pressure / 8), 0, 1);
  }
  return toCanvas(duo(s.img, t, fg, bg));
});
add('charcoal', '스케치 효과', '목탄', [['thickness', '목탄 두께', 1, 7, 1], ['detail', '세부', 0, 5, 5], ['balance', '명암 균형', 0, 100, 50]], (c, p, { fg, bg }) => {
  const s = px(c);
  const S = strokesF(s.w, s.h, -45, p.thickness * 6 + 4, 0.25, 61);
  const { mag } = sobelF(gaussF(s.L, s.w, s.h, 1), s.w, s.h);
  const cut = p.balance / 100;
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const dark = 1 - s.L[i] / 255;
    t[i] = clamp(smooth(1 - cut - 0.25, 1 - cut + 0.25, dark) * (0.4 + S[i] * 0.9) + smooth(30, 140, mag[i]) * (p.detail / 6), 0, 1);
  }
  return toCanvas(duo(s.img, t, fg, bg));
});
add('chrome', '스케치 효과', '크롬', [['detail', '세부', 0, 10, 4], ['smoothness', '매끄러움', 0, 10, 7]], (c, p) => {
  const s = px(c);
  const H = gaussF(s.L, s.w, s.h, p.smoothness + 1);
  const f = (p.detail + 2) * Math.PI;
  return each(s, (i, o) => {
    const v = 128 + 127 * Math.sin((H[i] / 255) * f);
    o[0] = o[1] = o[2] = v;
  });
});
add('conte', '스케치 효과', '콩테 크레용', [['fgLevel', '전경색 레벨', 1, 15, 11], ['bgLevel', '배경색 레벨', 1, 15, 7], ['texture', '텍스처', null, null, 'canvas', [['canvas', '캔버스'], ['burlap', '삼베'], ['sandstone', '사암'], ['brick', '벽돌']]], ['relief', '부조', 0, 50, 4]], (c, p, { fg, bg }) => {
  const s = px(c);
  const sh = shadeF(textureMap(p.texture, s.w, s.h), s.w, s.h, 135, 1);
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const dark = 1 - s.L[i] / 255;
    t[i] = clamp(dark * (p.fgLevel / 10) - (1 - dark) * (p.bgLevel / 30) + 0.1 - sh[i] * (p.relief / 20), 0, 1);
  }
  return toCanvas(duo(s.img, t, fg, bg));
});
add('graphicPen', '스케치 효과', '그래픽 펜', [['length', '획 길이', 1, 15, 15], ['balance', '명암 균형', 0, 100, 50], ['direction', '획 방향', null, null, 'rightDiag', DIRS]], (c, p, { fg, bg }) => {
  const s = px(c);
  const S = strokesF(s.w, s.h, DIR_ANGLE[p.direction] ?? -45, p.length * 2 + 2, 0.35, 71);
  const shift = (p.balance - 50) / 100;
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) t[i] = S[i] > 1 - (1 - s.L[i] / 255) - shift ? 1 : 0;
  return toCanvas(duo(s.img, t, fg, bg));
});
add('halftonePattern', '스케치 효과', '하프톤 패턴', [['size', '크기', 1, 12, 1], ['contrast', '대비', 0, 50, 5], ['type', '패턴 종류', null, null, 'dot', [['circle', '원'], ['dot', '점'], ['line', '선']]]], (c, p, { fg, bg }) => {
  const s = px(c);
  const cell = p.size * 2 + 3;
  const k = 1 + p.contrast / 10;
  const cx = s.w / 2;
  const cy = s.h / 2;
  const t = new Float32Array(s.n);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const dark = clamp((1 - s.L[i] / 255 - 0.5) * k + 0.5, 0, 1);
      let f;
      if (p.type === 'line') f = Math.abs(((y % cell) / cell) * 2 - 1);
      else if (p.type === 'circle') f = Math.abs(((Math.hypot(x - cx, y - cy) % cell) / cell) * 2 - 1);
      else {
        const dx = (x % cell) / cell - 0.5;
        const dy = (y % cell) / cell - 0.5;
        f = Math.hypot(dx, dy) * Math.SQRT2;
      }
      t[i] = f < dark ? 1 : 0;
    }
  }
  return toCanvas(duo(s.img, t, fg, bg));
});
add('notePaper', '스케치 효과', '메모지', [['balance', '이미지 균형', 0, 50, 25], ['grain', '입자', 0, 20, 10], ['relief', '부조', 0, 25, 11]], (c, p, { fg, bg }) => {
  const s = px(blurred(c, 1));
  const M = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) M[i] = s.L[i] < p.balance * 5.1 ? 255 : 0;
  const sh = shadeF(gaussF(M, s.w, s.h, 1.5), s.w, s.h, 135, p.relief / 6);
  const N = whiteF(s.w, s.h, 81);
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) t[i] = clamp((M[i] / 255) * 0.85 - sh[i] * 0.6 + (N[i] - 0.5) * (p.grain / 30), 0, 1);
  return toCanvas(duo(s.img, t, fg, bg));
});
add('photocopy', '스케치 효과', '복사', [['detail', '세부', 1, 24, 7], ['darkness', '어둡기', 1, 50, 8]], (c, p, { fg, bg }) => {
  const s = px(c);
  const B = gaussF(s.L, s.w, s.h, p.detail / 2 + 1);
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) t[i] = smooth(2, 12, B[i] - s.L[i]) * (p.darkness / 12) + smooth(0.85, 1, 1 - s.L[i] / 255);
  return toCanvas(duo(s.img, t, fg, bg));
});
add('plaster', '스케치 효과', '석고', [['balance', '이미지 균형', 0, 50, 20], ['smoothness', '매끄러움', 1, 15, 2], ['light', '조명', null, null, 'top', LIGHTS]], (c, p, { fg, bg }) => {
  const s = px(c);
  const B = gaussF(s.L, s.w, s.h, p.smoothness + 1);
  const M = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) M[i] = smooth(p.balance * 5.1 - 20, p.balance * 5.1 + 20, 255 - B[i]) * 255;
  const sh = shadeF(gaussF(M, s.w, s.h, 2), s.w, s.h, LIGHT_ANGLE[p.light] ?? 90, 1.5);
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) t[i] = clamp(0.5 - sh[i] * 0.8 + (M[i] / 255 - 0.5) * 0.3, 0, 1);
  return toCanvas(duo(s.img, t, fg, bg));
});
add('reticulation', '스케치 효과', '망사 효과', [['density', '밀도', 0, 50, 12], ['fgLevel', '전경색 레벨', 0, 50, 40], ['bgLevel', '배경색 레벨', 0, 50, 5]], (c, p, { fg, bg }) => {
  const s = px(c);
  const N = gaussF(whiteF(s.w, s.h, 91), s.w, s.h, 0.8 + (50 - p.density) / 30);
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < N.length; i += 5) {
    lo = Math.min(lo, N[i]);
    hi = Math.max(hi, N[i]);
  }
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const nn = (N[i] - lo) / (hi - lo || 1);
    const dark = 1 - s.L[i] / 255;
    t[i] = nn < dark * (0.5 + p.fgLevel / 50) - p.bgLevel / 100 ? 1 : 0;
  }
  return toCanvas(duo(s.img, t, fg, bg));
});
add('stamp', '스케치 효과', '도장', [['balance', '명암 균형', 0, 50, 25], ['smoothness', '매끄러움', 1, 50, 5]], (c, p, { fg, bg }) => {
  const s = px(c);
  const B = gaussF(s.L, s.w, s.h, p.smoothness / 4);
  const cut = p.balance * 5.1;
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) t[i] = 1 - smooth(cut - 6, cut + 6, B[i]);
  return toCanvas(duo(s.img, t, fg, bg));
});
add('tornEdges', '스케치 효과', '가장자리 찢기', [['balance', '이미지 균형', 0, 50, 25], ['smoothness', '매끄러움', 1, 15, 11], ['contrast', '대비', 1, 25, 17]], (c, p, { fg, bg }) => {
  const s = px(c);
  const N = noiseF(s.w, s.h, 3, 3, 101);
  const B = gaussF(s.L, s.w, s.h, (16 - p.smoothness) / 4 + 0.5);
  const cut = p.balance * 5.1;
  const soft = 40 / p.contrast;
  const t = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) t[i] = 1 - smooth(cut - soft, cut + soft, B[i] + (N[i] - 0.5) * 60);
  return toCanvas(duo(s.img, t, fg, bg));
});
add('waterPaper', '스케치 효과', '물 종이', [['fiber', '섬유 길이', 3, 50, 15], ['brightness', '명도', 0, 100, 60], ['contrast', '대비', 0, 100, 80]], (c, p) => {
  const s = px(blurred(c, 1.2));
  const F1 = strokesF(s.w, s.h, 90, p.fiber, 0.25, 111);
  const F2 = strokesF(s.w, s.h, 0, p.fiber * 0.6, 0.15, 112);
  const k = p.contrast / 80;
  return each(s, (i, o) => {
    const fib = 0.8 + (F1[i] + F2[i]) * 0.25;
    for (let ch = 0; ch < 3; ch++) o[ch] = ((s.d[i * 4 + ch] - 128) * k + 128 + (p.brightness - 60) * 1.5) * fib;
  });
});

// ---------------------------------------------------------------- 텍스처 (Texture)
add('craquelure', '텍스처', '균열', [['spacing', '균열 간격', 2, 100, 15], ['depth', '균열 깊이', 0, 10, 6], ['brightness', '균열 밝기', 0, 10, 9]], (c, p) => {
  const s = px(c);
  const v = voronoi(s.w, s.h, Math.max(4, p.spacing * 1.6), 121, 1);
  const crack = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) crack[i] = smooth(0, 1.6, v.edge[i]) * 255;
  const sh = shadeF(gaussF(crack, s.w, s.h, 1), s.w, s.h, 135, p.depth / 3);
  return each(s, (i, o) => {
    const dark = (1 - crack[i] / 255) * (p.depth / 10) * (1 - p.brightness / 14);
    for (let ch = 0; ch < 3; ch++) o[ch] = s.d[i * 4 + ch] * (1 - dark) * (1 + sh[i] * 0.6);
  });
});
add('grain', '텍스처', '그레인', [['intensity', '강도', 0, 100, 40], ['contrast', '대비', 0, 100, 50], ['type', '그레인 종류', null, null, 'regular', [['regular', '보통'], ['soft', '부드럽게'], ['sprinkles', '뿌림'], ['clumped', '덩어리'], ['contrasty', '대비'], ['enlarged', '확대'], ['stippled', '점묘'], ['horizontal', '가로'], ['vertical', '세로'], ['speckle', '얼룩']]]], (c, p, { fg, bg }) => {
  const s = px(c);
  const W = s.w;
  const H = s.h;
  let N;
  if (p.type === 'soft') N = gaussF(whiteF(W, H, 131), W, H, 1);
  else if (p.type === 'clumped') N = gaussF(whiteF(W, H, 131), W, H, 1.6).map((v) => (v > 0.52 ? 1 : 0));
  else if (p.type === 'enlarged') N = noiseF(W, H, 3, 1, 131);
  else if (p.type === 'horizontal' || p.type === 'vertical') N = canvasFloat(dirBlur(floatCanvas(whiteF(W, H, 131).map((v) => v * 255), W, H), p.type === 'horizontal' ? 0 : 90, 12)).map((v) => v / 255);
  else N = whiteF(W, H, 131);
  const amt = p.intensity / 100;
  const kc = 1 + p.contrast / 100;
  const [fr, fgc, fb] = hexRgb(fg);
  const [br, bgc, bb] = hexRgb(bg);
  return each(s, (i, o) => {
    const n = N[i];
    for (let ch = 0; ch < 3; ch++) {
      let v = (s.d[i * 4 + ch] - 128) * (p.type === 'contrasty' ? kc * 1.3 : 1) + 128;
      if (p.type === 'sprinkles') v = n > 1 - amt * 0.15 ? [br, bgc, bb][ch] : v;
      else if (p.type === 'stippled') v = n < amt * (1 - s.L[i] / 255) * 0.6 ? [fr, fgc, fb][ch] : v;
      else if (p.type === 'speckle') v = n > 1 - amt * 0.08 ? 255 : n < amt * 0.08 ? 0 : v;
      else v += (n - 0.5) * amt * 150 * kc;
      o[ch] = v;
    }
  });
});
add('mosaicTiles', '텍스처', '모자이크 타일', [['tile', '타일 크기', 2, 100, 12], ['grout', '줄눈 폭', 1, 15, 3], ['lighten', '줄눈 밝게', 0, 10, 9]], (c, p) => {
  const s = px(c);
  const v = voronoi(s.w, s.h, p.tile * 1.4, 141, 0.35);
  const groutF = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) groutF[i] = smooth(0, p.grout / 2 + 0.5, v.edge[i]) * 255;
  const sh = shadeF(gaussF(groutF, s.w, s.h, 1), s.w, s.h, 135, 1);
  return each(s, (i, o) => {
    const g = 1 - groutF[i] / 255;
    for (let ch = 0; ch < 3; ch++) {
      const tile = s.d[i * 4 + ch] * (1 + sh[i] * 0.5);
      const gc = s.d[i * 4 + ch] * 0.35 + (p.lighten / 10) * 160;
      o[ch] = tile * (1 - g) + gc * g;
    }
  });
});
add('patchwork', '텍스처', '패치워크', [['size', '사각형 크기', 0, 10, 4], ['relief', '부조', 0, 25, 8]], (c, p) => {
  const s = px(c);
  const sz = p.size * 2 + 4;
  const gw = Math.ceil(s.w / sz);
  const id = new Int32Array(s.n);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) id[y * s.w + x] = Math.floor(y / sz) * gw + Math.floor(x / sz);
  const means = regionMeans(s.img, id, gw * Math.ceil(s.h / sz));
  const Hm = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const k = id[i] * 4;
    Hm[i] = lum(means[k], means[k + 1], means[k + 2]);
  }
  const sh = shadeF(Hm, s.w, s.h, 135, p.relief / 6);
  return each(s, (i, o) => {
    const k = id[i] * 4;
    for (let ch = 0; ch < 3; ch++) o[ch] = means[k + ch] * (1 + sh[i] * 0.8);
  });
});
add('stainedGlass', '텍스처', '스테인드 글라스', [['cell', '셀 크기', 2, 50, 10], ['border', '테두리 두께', 1, 20, 4], ['light', '빛 강도', 0, 10, 3]], (c, p, { fg }) => {
  const s = px(c);
  const v = voronoi(s.w, s.h, p.cell * 2.2, 151, 0.9);
  const means = regionMeans(s.img, v.id, v.n);
  const [fr, fgc, fb] = hexRgb(fg);
  const cx = s.w / 2;
  const cy = s.h / 2;
  const R = Math.hypot(cx, cy);
  return each(s, (i, o) => {
    const k = v.id[i] * 4;
    const x = i % s.w;
    const y = (i / s.w) | 0;
    const lit = 1 + (p.light / 10) * 0.6 * (1 - Math.hypot(x - cx, y - cy) / R);
    const b = smooth(p.border / 2, p.border / 2 + 1, v.edge[i]);
    o[0] = fr + (means[k] * lit - fr) * b;
    o[1] = fgc + (means[k + 1] * lit - fgc) * b;
    o[2] = fb + (means[k + 2] * lit - fb) * b;
  });
});
add('texturizer', '텍스처', '텍스처화', [['texture', '텍스처', null, null, 'canvas', [['brick', '벽돌'], ['burlap', '삼베'], ['canvas', '캔버스'], ['sandstone', '사암']]], ['scaling', '비율 (%)', 50, 200, 100], ['relief', '부조', 0, 50, 4], ['light', '조명', null, null, 'top', LIGHTS]], (c, p) => {
  const s = px(c);
  const sh = shadeF(textureMap(p.texture, s.w, s.h, p.scaling / 100), s.w, s.h, LIGHT_ANGLE[p.light] ?? 90, 1);
  return each(s, (i, o) => {
    const r = 1 + sh[i] * (p.relief / 15);
    for (let ch = 0; ch < 3; ch++) o[ch] = s.d[i * 4 + ch] * r;
  });
});

// ---------------------------------------------------------------- 왜곡 (Distort, gallery)
add('diffuseGlow', '왜곡', '광선 확산', [['graininess', '그레인', 0, 10, 6], ['glow', '광선 양', 0, 20, 10], ['clear', '선명 양', 0, 20, 15]], (c, p, { bg }) => {
  const s = px(c);
  const [br, bgc, bb] = hexRgb(bg);
  const G2 = gaussF(s.L.map((v) => smooth(200 - p.glow * 6, 255, v) * 255), s.w, s.h, 4 + p.glow / 2);
  const N = whiteF(s.w, s.h, 161);
  return each(s, (i, o) => {
    const g = clamp((G2[i] / 255) * (p.glow / 10) * (1 - p.clear / 40), 0, 1);
    const grain = N[i] < (p.graininess / 10) * (G2[i] / 255) * 0.5 ? 1 : 0;
    const gg = clamp(g + grain * 0.6, 0, 1);
    o[0] = s.d[i * 4] + (br - s.d[i * 4]) * gg;
    o[1] = s.d[i * 4 + 1] + (bgc - s.d[i * 4 + 1]) * gg;
    o[2] = s.d[i * 4 + 2] + (bb - s.d[i * 4 + 2]) * gg;
  });
});
add('glass', '왜곡', '유리', [['distortion', '왜곡', 0, 20, 5], ['smoothness', '매끄러움', 1, 15, 3], ['texture', '텍스처', null, null, 'frosted', [['blocks', '블록'], ['canvas', '캔버스'], ['frosted', '서리'], ['tinyLens', '작은 렌즈']]], ['scaling', '비율 (%)', 50, 200, 100]], (c, p) => {
  const w = c.width;
  const h = c.height;
  const sc = p.scaling / 100;
  let H;
  if (p.texture === 'blocks') {
    H = new Float32Array(w * h);
    const b = 24 * sc;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = ((x % b) / b + (y % b) / b) * 127;
  } else if (p.texture === 'tinyLens') {
    H = new Float32Array(w * h);
    const b = 18 * sc;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x % b) / b - 0.5;
        const dy = (y % b) / b - 0.5;
        H[y * w + x] = Math.max(0, 0.25 - dx * dx - dy * dy) * 1000;
      }
    }
  } else H = textureMap(p.texture === 'canvas' ? 'canvas' : 'sandstone', w, h, sc);
  H = gaussF(H, w, h, p.smoothness / 2);
  const { gx, gy } = sobelF(H, w, h);
  const k = p.distortion * 0.05;
  return remap(c, (x, y, o) => {
    const i = clamp(y | 0, 0, h - 1) * w + clamp(x | 0, 0, w - 1);
    o[0] = x + gx[i] * k;
    o[1] = y + gy[i] * k;
  });
});
add('oceanRipple', '왜곡', '바다 물결', [['size', '잔물결 크기', 1, 15, 9], ['magnitude', '잔물결 강도', 0, 20, 9]], (c, p) => {
  const w = c.width;
  const h = c.height;
  const X = noiseF(w, h, p.size * 3 + 2, 2, 171);
  const Y = noiseF(w, h, p.size * 3 + 2, 2, 172);
  const k = p.magnitude * 2.2;
  return remap(c, (x, y, o) => {
    const i = clamp(y | 0, 0, h - 1) * w + clamp(x | 0, 0, w - 1);
    o[0] = x + (X[i] - 0.5) * k;
    o[1] = y + (Y[i] - 0.5) * k;
  });
});

Object.assign(FILTERS, G);

/** The gallery's folders: effects by category, including the existing filters it shows too. */
export const GALLERY = [
  ['예술 효과', ['coloredPencil', 'cutout', 'dryBrush', 'filmGrain', 'fresco', 'neonGlow', 'paintDaubs', 'paletteKnife', 'plasticWrap', 'posterEdges', 'roughPastels', 'smudgeStick', 'sponge', 'underpainting', 'watercolor']],
  ['브러시 획', ['accentedEdges', 'angledStrokes', 'crosshatch', 'darkStrokes', 'inkOutlines', 'spatter', 'sprayedStrokes', 'sumie']],
  ['왜곡', ['diffuseGlow', 'glass', 'oceanRipple']],
  ['스케치 효과', ['basRelief', 'chalkCharcoal', 'charcoal', 'chrome', 'conte', 'graphicPen', 'halftonePattern', 'notePaper', 'photocopy', 'plaster', 'reticulation', 'stamp', 'tornEdges', 'waterPaper']],
  ['스타일화', ['glowingEdges']],
  ['텍스처', ['craquelure', 'grain', 'mosaicTiles', 'patchwork', 'stainedGlass', 'texturizer']],
];
