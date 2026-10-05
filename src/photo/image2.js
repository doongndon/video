// More of Photoshop's Image, Edit, Layer, File and View commands:
//  Image  ▸ Mode (Bitmap, Duotone, Indexed Color), Image Rotation ▸ Arbitrary, Apply Image,
//           Calculations, Adjustments ▸ HDR Toning (registered as an adjustment)
//  Edit   ▸ Paste Special (in place, into, outside), Auto-Align Layers, Auto-Blend Layers (stack
//           for focus), Purge
//  Layer  ▸ Matting (defringe, remove black/white matte), Arrange ▸ Reverse, Layer Style ▸
//           Hide/Show All Effects and Create Layers, Stack Mode (median, mean…), Background ↔ layer
//  File   ▸ Quick Export, Save for Web (GIF, PNG-8, JPG, PNG-24), File Info, Print, Automate ▸
//           Contact Sheet, Fit Image
//  View   ▸ Proof Colors (CMYK look), Gamut Warning
// The menus built in editor.js are extended here.

import { h, clamp, downloadBlob } from '../util.js';
import { openModal, toast, formRow, promptDialog, confirmDialog } from '../ui/common.js';
import { newLayer, makeCanvas, cloneCanvas, lid } from './doc.js';
import { ADJUSTMENTS } from './adjust.js';
import { compositeOnto, BLEND_MODES } from './blend.js';
import { applyToLayer } from './pdialogs.js';
import { quantize, indexedToImage, gifBlob, png8Blob, PALETTES, DITHERS } from './quantize.js';
import { gaussF, grayOf, read, toCanvas, lum, cl, hexRgb } from './fxutil.js';

// ---------------------------------------------------------------- HDR toning (an adjustment)

ADJUSTMENTS.hdrToning = {
  name: 'HDR 토닝',
  params: [['radius', '반경 (px)', 1, 500, 80], ['strength', '강도', 0.1, 4, 0.6, 0.05], ['gamma', '감마', 0.1, 2, 1, 0.01], ['exposure', '노출', -5, 5, 0, 0.05], ['detail', '세부 (%)', -100, 300, 30], ['vibrance', '활기', -100, 100, 0], ['saturation', '채도', -100, 100, 20]],
  fn(img, p) {
    // local tone mapping: squeeze the big brightness differences, keep (or boost) the small ones
    const { width: w, height: hh, data: d } = img;
    const n = w * hh;
    const L = grayOf(img);
    const logL = new Float32Array(n);
    for (let i = 0; i < n; i++) logL[i] = Math.log(1 + L[i]);
    const r = Math.min(p.radius, Math.max(w, hh) / 3);
    const base = gaussF(logL, w, hh, r / 3);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += base[i];
    mean /= n || 1;
    const compress = 1 / (1 + p.strength);
    const det = 1 + p.detail / 100;
    const ex = 2 ** p.exposure;
    for (let i = 0; i < n; i++) {
      const nb = mean + (base[i] - mean) * compress;
      const nl = Math.exp(nb + (logL[i] - base[i]) * det) - 1;
      let v = clamp((nl * ex) / 255, 0, 1) ** (1 / p.gamma) * 255;
      if (!Number.isFinite(v)) v = L[i];
      const k = L[i] > 0.5 ? v / L[i] : 1;
      const o = i * 4;
      let rr = d[o] * k;
      let gg = d[o + 1] * k;
      let bb = d[o + 2] * k;
      const Y = lum(rr, gg, bb);
      const mx = Math.max(rr, gg, bb);
      const curS = mx ? (mx - Math.min(rr, gg, bb)) / mx : 0;
      const sk = 1 + p.saturation / 100 + (p.vibrance / 100) * (1 - curS);
      d[o] = cl(Y + (rr - Y) * sk);
      d[o + 1] = cl(Y + (gg - Y) * sk);
      d[o + 2] = cl(Y + (bb - Y) * sk);
    }
  },
};

// ---------------------------------------------------------------- helpers

const sel = (opts, value) => {
  const s = h('select', ...opts.map(([v, t]) => h('option', { value: v }, t)));
  s.value = value;
  return s;
};
const num = (value, min, max, step = 1) => h('input.ph-num', { type: 'number', value, min, max, step });

/** Every visible layer merged into one raster layer named 배경 (like Photoshop asks to do for mode changes). */
function flattenTo(P, label, fn, mode = null) {
  const doc = P.doc;
  P.run(label, () => {
    if (mode) doc.mode = mode;
    const c = makeCanvas(doc.width, doc.height);
    const g = c.getContext('2d');
    g.drawImage(doc.flatten({ fg: P.fg, bg: P.bg }), 0, 0);
    const out = fn(c) || c;
    const l = newLayer('raster', { name: '배경', canvas: out });
    doc.layers = [l];
    doc.activeId = l.id;
    doc.selectedIds = [l.id];
    doc.selection = null;
  });
}

/** Grey values of a channel of a canvas: 'rgb' (luminance), 'r', 'g', 'b', 'a'. */
function channelOf(c, ch) {
  const d = read(c).data;
  const n = c.width * c.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = ch === 'r' ? d[o] : ch === 'g' ? d[o + 1] : ch === 'b' ? d[o + 2] : ch === 'a' ? d[o + 3] : lum(d[o], d[o + 1], d[o + 2]);
  }
  return out;
}
const greyCanvas = (a, w, hh) => {
  const img = new ImageData(w, hh);
  for (let i = 0; i < a.length; i++) {
    const v = cl(a[i]);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  return toCanvas(img);
};
/** A selection/channel canvas (black with alpha) from grey values. */
const alphaCanvas = (a, w, hh) => {
  const img = new ImageData(w, hh);
  for (let i = 0; i < a.length; i++) img.data[i * 4 + 3] = cl(a[i]);
  return toCanvas(img);
};

const BLEND_SIMPLE = [['normal', '표준'], ['multiply', '곱하기'], ['screen', '스크린'], ['overlay', '오버레이'], ['soft light', '소프트 라이트'], ['hard light', '하드 라이트'], ['darken', '어둡게 하기'], ['lighten', '밝게 하기'], ['difference', '차이'], ['exclusion', '제외'], ['add', '더하기'], ['subtract', '빼기'], ['linear burn', '선형 번'], ['color dodge', '색상 닷지']];
/** Two grey values blended (0..255). */
function blend1(a, b, mode) {
  const x = a / 255;
  const y = b / 255;
  let r;
  switch (mode) {
    case 'multiply': r = x * y; break;
    case 'screen': r = 1 - (1 - x) * (1 - y); break;
    case 'overlay': r = x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y); break;
    case 'soft light': r = y < 0.5 ? x - (1 - 2 * y) * x * (1 - x) : x + (2 * y - 1) * (Math.sqrt(x) - x); break;
    case 'hard light': r = y < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y); break;
    case 'darken': r = Math.min(x, y); break;
    case 'lighten': r = Math.max(x, y); break;
    case 'difference': r = Math.abs(x - y); break;
    case 'exclusion': r = x + y - 2 * x * y; break;
    case 'add': r = Math.min(1, x + y); break;
    case 'subtract': r = Math.max(0, x - y); break;
    case 'linear burn': r = Math.max(0, x + y - 1); break;
    case 'color dodge': r = y >= 1 ? 1 : Math.min(1, x / (1 - y)); break;
    default: r = y;
  }
  return r * 255;
}

/** Layers that can be sources (pixels, merged). */
function sourceOptions(P) {
  return [['merged', '병합됨 (보이는 모습)'], ...[...P.doc.layers].reverse().filter((l) => l.kind !== 'adjust' && l.kind !== 'group').map((l) => [l.id, l.name])];
}
function sourceCanvas(P, id) {
  const doc = P.doc;
  if (id === 'merged') return doc.flatten({ fg: P.fg, bg: P.bg });
  const l = doc.layer(id);
  return l ? P.layerAsDocCanvas(l) : doc.flatten({ fg: P.fg, bg: P.bg });
}

// ---------------------------------------------------------------- install

export function installImage2(P) {
  const C = P.cmd;
  const need = () => {
    if (!P.doc) toast('먼저 문서를 여세요');
    return !!P.doc;
  };
  const activeRaster = (what) => {
    const l = P.doc?.active;
    if (l?.kind === 'raster' && l.canvas) return l;
    toast(`${what}: 이미지(일반) 레이어를 선택하세요`);
    return null;
  };

  // ---- Image ▸ Mode
  C.modeBitmap = () => {
    if (!need()) return;
    const method = sel([['threshold', '50% 한계값'], ['pattern', '패턴 디더'], ['diffusion', '확산 디더'], ['halftone', '하프톤 스크린']], 'diffusion');
    const freq = num(8, 3, 64);
    const angle = num(45, -180, 180);
    const shape = sel([['round', '원'], ['line', '선'], ['square', '사각형'], ['ellipse', '타원']], 'round');
    const extra = h('div', formRow('셀 크기 (px)', freq), formRow('각도 (°)', angle), formRow('모양', shape));
    const sync = () => { extra.hidden = method.value !== 'halftone'; };
    method.addEventListener('change', sync);
    sync();
    openModal({
      title: '비트맵 (검정과 흰색 두 색)',
      body: [formRow('방법', method), extra, h('div.note', '보이는 레이어를 하나로 합친 뒤 검정과 흰색 점으로 바꿉니다.')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => flattenTo(P, '모드: 비트맵', (c) => {
          const img = read(c);
          const { width: w, height: hh } = img;
          const L = grayOf(img);
          const out = new ImageData(w, hh);
          if (method.value === 'halftone') {
            const s = Math.max(3, +freq.value);
            const t = (+angle.value * Math.PI) / 180;
            const cs = Math.cos(t);
            const sn = Math.sin(t);
            for (let y = 0; y < hh; y++) {
              for (let x = 0; x < w; x++) {
                const u = (x * cs + y * sn) / s;
                const v = (-x * sn + y * cs) / s;
                const fu = u - Math.floor(u) - 0.5;
                const fv = v - Math.floor(v) - 0.5;
                const f = shape.value === 'line' ? Math.abs(fv) * 2 : shape.value === 'square' ? Math.max(Math.abs(fu), Math.abs(fv)) * 2 : shape.value === 'ellipse' ? Math.hypot(fu * 0.8, fv * 1.25) * Math.SQRT2 : Math.hypot(fu, fv) * Math.SQRT2;
                const i = y * w + x;
                const dark = 1 - L[i] / 255;
                const val = f < dark ? 0 : 255;
                out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = val;
                out.data[i * 4 + 3] = 255;
              }
            }
          } else {
            const q = quantize(img, { palette: 'bw', colors: 2, dither: method.value === 'threshold' ? 'none' : method.value, transparency: false });
            const o = indexedToImage(q);
            out.data.set(o.data);
          }
          return toCanvas(out);
        }, 'bitmap'),
      }],
    });
  };
  C.modeIndexed = () => {
    if (!need()) return;
    const palette = sel(PALETTES, 'adaptive');
    const colors = num(256, 2, 256);
    const dither = sel(DITHERS, 'diffusion');
    const amount = num(75, 0, 100);
    const transp = h('input', { type: 'checkbox', checked: true });
    const prev = h('canvas.ph-modeprev', { width: 260, height: 160 });
    const comp = P.composite();
    const k = Math.min(1, 260 / comp.width, 160 / comp.height);
    const small = makeCanvas(Math.max(1, Math.round(comp.width * k)), Math.max(1, Math.round(comp.height * k)));
    small.getContext('2d').drawImage(comp, 0, 0, small.width, small.height);
    const opts = () => ({ palette: palette.value, colors: +colors.value, dither: dither.value, amount: +amount.value, transparency: transp.checked });
    const draw = () => {
      const q = quantize(read(small), opts());
      prev.width = small.width;
      prev.height = small.height;
      prev.getContext('2d').putImageData(indexedToImage(q), 0, 0);
    };
    for (const e of [palette, colors, dither, amount, transp]) e.addEventListener('change', draw);
    openModal({
      title: '인덱스 색상',
      body: [formRow('팔레트', palette), formRow('색상 수', colors), formRow('디더', dither), formRow('디더 양 (%)', amount), formRow('투명도 유지', transp), prev, h('div.note', '보이는 레이어를 하나로 합친 뒤 고른 색상 수(최대 256)로 줄입니다. GIF·PNG-8로 저장할 때와 같은 모습입니다.')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          flattenTo(P, '모드: 인덱스 색상', (c) => toCanvas(indexedToImage(quantize(read(c), opts()))), 'indexed');
        },
      }],
    });
    draw();
  };
  C.modeDuotone = () => {
    if (!need()) return;
    const type = sel([['mono', '단색 (1도)'], ['duo', '이중톤 (2도)'], ['tri', '삼중톤 (3도)']], 'duo');
    const ink1 = h('input', { type: 'color', value: '#1d1d1d' });
    const ink2 = h('input', { type: 'color', value: '#c2803a' });
    const ink3 = h('input', { type: 'color', value: '#f2e3c6' });
    const contrast = num(0, -50, 50);
    openModal({
      title: '이중톤',
      body: [formRow('종류', type), formRow('잉크 1 (어두운 곳)', ink1), formRow('잉크 2', ink2), formRow('잉크 3 (밝은 곳)', ink3), formRow('대비', contrast), h('div.note', '보이는 레이어를 합쳐 밝기만 남긴 뒤 잉크 색으로 다시 칠합니다.')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const inks = [hexRgb(ink1.value), type.value === 'mono' ? [255, 255, 255] : hexRgb(ink2.value), type.value === 'tri' ? hexRgb(ink3.value) : null];
          flattenTo(P, '모드: 이중톤', (c) => {
            const img = read(c);
            const L = grayOf(img);
            const kc = 1 + +contrast.value / 50;
            for (let i = 0; i < L.length; i++) {
              const t = clamp(((L[i] / 255 - 0.5) * kc) + 0.5, 0, 1);
              let col;
              if (inks[2]) col = t < 0.5 ? inks[0].map((v, j) => v + (inks[1][j] - v) * (t * 2)) : inks[1].map((v, j) => v + (inks[2][j] - v) * ((t - 0.5) * 2));
              else col = inks[0].map((v, j) => v + (inks[1][j] - v) * t);
              img.data[i * 4] = col[0];
              img.data[i * 4 + 1] = col[1];
              img.data[i * 4 + 2] = col[2];
            }
            return toCanvas(img);
          }, 'duotone');
        },
      }],
    });
  };

  // ---- Image ▸ Image Rotation ▸ Arbitrary
  C.rotateArbitrary = async () => {
    if (!need()) return;
    const v = await promptDialog('캔버스 임의 회전', '각도 (°, 시계 방향이 +)', '15');
    const deg = parseFloat(v);
    if (!Number.isFinite(deg) || !deg) return;
    const doc = P.doc;
    const t = (deg * Math.PI) / 180;
    const W = doc.width;
    const H = doc.height;
    const cs = Math.abs(Math.cos(t));
    const sn = Math.abs(Math.sin(t));
    const NW = Math.ceil(W * cs + H * sn);
    const NH = Math.ceil(W * sn + H * cs);
    if (NW * NH > 80e6) return toast('결과가 너무 큽니다');
    const map = ([x, y]) => {
      const dx = x - W / 2;
      const dy = y - H / 2;
      return [NW / 2 + dx * Math.cos(t) - dy * Math.sin(t), NH / 2 + dx * Math.sin(t) + dy * Math.cos(t)];
    };
    const rot = (c, x, y) => {
      const out = makeCanvas(NW, NH);
      const g = out.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.translate(NW / 2, NH / 2);
      g.rotate(t);
      g.drawImage(c, x - W / 2, y - H / 2);
      return out;
    };
    P.run(`캔버스 회전 ${deg}°`, () => {
      for (const l of doc.layers) {
        if (l.kind === 'raster' && l.canvas) {
          l.canvas = rot(l.canvas, l.x, l.y);
          l.x = 0;
          l.y = 0;
        } else if (l.kind === 'text' || l.kind === 'shape') {
          const b = l.kind === 'text' ? P.textBox(l) : { w: l.shape.w, h: l.shape.h };
          const [cx, cy] = map([l.x + b.w / 2, l.y + b.h / 2]);
          l.x = Math.round(cx - b.w / 2);
          l.y = Math.round(cy - b.h / 2);
          l.rotation = ((l.rotation || 0) + deg) % 360;
        } else if (l.kind === 'smart' && l.smart) {
          const m = l.smart.m;
          const c = Math.cos(t);
          const s = Math.sin(t);
          // rotate the placement matrix around the old centre, then move to the new canvas
          const nm = [c * m[0] - s * m[1], s * m[0] + c * m[1], c * m[2] - s * m[3], s * m[2] + c * m[3]];
          const [tx, ty] = map([m[4], m[5]]);
          l.smart = { ...l.smart, m: [...nm, tx, ty], corners: l.smart.corners?.map(map) };
        }
        if (l.mask) l.mask = { ...l.mask, canvas: rot(l.mask.canvas, l.mask.x, l.mask.y), x: 0, y: 0 };
        l._styled = null;
        l._cache = null;
        l.rev++;
      }
      doc.width = NW;
      doc.height = NH;
      doc.selection = null;
      doc.rev++;
    });
    P.fit();
  };

  // ---- Image ▸ Apply Image
  C.applyImage = () => {
    if (!need() || !activeRaster('이미지 적용')) return;
    const src = sel(sourceOptions(P), 'merged');
    const ch = sel([['rgb', 'RGB'], ['r', '빨강'], ['g', '녹색'], ['b', '파랑'], ['a', '투명도']], 'rgb');
    const inv = h('input', { type: 'checkbox' });
    const mode = sel(BLEND_MODES.map(([id, name]) => [id, name]), 'multiply');
    const op = num(100, 0, 100);
    const keep = h('input', { type: 'checkbox', checked: true });
    openModal({
      title: '이미지 적용',
      body: [formRow('원본 레이어', src), formRow('채널', ch), formRow('반전', inv), formRow('혼합', mode), formRow('불투명도 (%)', op), formRow('투명도 유지', keep), h('div.note', '고른 레이어(또는 보이는 모습)의 채널을 지금 레이어 위에 혼합 모드로 섞습니다.')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const doc = P.doc;
          const l = doc.active;
          let s = sourceCanvas(P, src.value);
          if (ch.value !== 'rgb' || inv.checked) {
            const a = ch.value === 'rgb' ? null : channelOf(s, ch.value);
            const img = read(s);
            for (let i = 0; i < img.width * img.height; i++) {
              for (let k = 0; k < 3; k++) {
                let v = a ? a[i] : img.data[i * 4 + k];
                if (inv.checked) v = 255 - v;
                img.data[i * 4 + k] = v;
              }
              if (a) img.data[i * 4 + 3] = 255;
            }
            s = toCanvas(img);
          }
          P.run('이미지 적용', () => applyToLayer(P, (c) => {
            const out = cloneCanvas(c);
            const g = out.getContext('2d');
            g.save();
            if (keep.checked) {
              // only where the layer already has pixels
              const t = makeCanvas(c.width, c.height);
              const tg = t.getContext('2d');
              tg.drawImage(s, -l.x, -l.y);
              tg.globalCompositeOperation = 'destination-in';
              tg.drawImage(c, 0, 0);
              compositeOnto(g, t, 0, 0, mode.value, +op.value / 100);
            } else compositeOnto(g, (() => { const t = makeCanvas(c.width, c.height); t.getContext('2d').drawImage(s, -l.x, -l.y); return t; })(), 0, 0, mode.value, +op.value / 100);
            g.restore();
            return out;
          }));
        },
      }],
    });
  };

  // ---- Image ▸ Calculations
  C.calculations = () => {
    if (!need()) return;
    const chans = [['rgb', '회색 (밝기)'], ['r', '빨강'], ['g', '녹색'], ['b', '파랑'], ['a', '투명도'], ...(P.doc.selection ? [['sel', '선택 영역']] : []), ...P.doc.channels.map((c) => [`ch:${c.id}`, `알파: ${c.name}`])];
    const s1 = sel(sourceOptions(P), 'merged');
    const c1 = sel(chans, 'rgb');
    const i1 = h('input', { type: 'checkbox' });
    const s2 = sel(sourceOptions(P), 'merged');
    const c2 = sel(chans, 'rgb');
    const i2 = h('input', { type: 'checkbox' });
    const mode = sel(BLEND_SIMPLE, 'multiply');
    const op = num(100, 0, 100);
    const result = sel([['channel', '새 채널 (알파)'], ['selection', '선택 영역'], ['doc', '새 문서']], 'channel');
    const get = (s, c, inv) => {
      const doc = P.doc;
      let a;
      if (c === 'sel') a = channelOf(doc.selection.canvas, 'a');
      else if (c.startsWith('ch:')) a = channelOf(doc.channels.find((x) => x.id === c.slice(3)).canvas, 'a');
      else a = channelOf(sourceCanvas(P, s), c);
      if (inv) for (let i = 0; i < a.length; i++) a[i] = 255 - a[i];
      return a;
    };
    openModal({
      title: '계산',
      body: [h('b', '원본 1'), formRow('레이어', s1), formRow('채널', c1), formRow('반전', i1), h('b', '원본 2'), formRow('레이어', s2), formRow('채널', c2), formRow('반전', i2), formRow('혼합', mode), formRow('불투명도 (%)', op), formRow('결과', result)],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const doc = P.doc;
          const a = get(s1.value, c1.value, i1.checked);
          const b = get(s2.value, c2.value, i2.checked);
          const k = +op.value / 100;
          const out = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) out[i] = b[i] + (blend1(b[i], a[i], mode.value) - b[i]) * k;
          if (result.value === 'doc') {
            P.openCanvas(greyCanvas(out, doc.width, doc.height), `${doc.name} 계산`);
            return;
          }
          const ac = alphaCanvas(out, doc.width, doc.height);
          if (result.value === 'selection') P.run('계산: 선택 영역', () => { doc.selection = { canvas: ac }; });
          else P.run('계산: 새 채널', () => { doc.channels = [...doc.channels, { id: lid('C'), name: `알파 ${doc.channels.length + 1}`, canvas: ac }]; });
          P.emit('channels');
        },
      }],
    });
  };

  // ---- Edit ▸ Paste Special
  C.pasteInPlace = () => C.paste();
  const pasteMasked = (outside) => {
    if (!need()) return;
    const doc = P.doc;
    const cb = P.clipboard;
    if (!cb) return toast('붙여 넣을 내용이 없습니다');
    if (!doc.selection) return toast('먼저 붙여 넣을 곳을 선택하세요');
    P.run(outside ? '바깥쪽에 붙여넣기' : '안쪽에 붙여넣기', () => {
      const l = newLayer('raster', { name: '붙여넣은 레이어', canvas: cloneCanvas(cb.canvas) });
      // centre the pasted picture on the selection, like Photoshop
      const b = selectionBounds(doc);
      l.x = Math.round(b.x + b.w / 2 - cb.canvas.width / 2);
      l.y = Math.round(b.y + b.h / 2 - cb.canvas.height / 2);
      if (outside) {
        const m = makeCanvas(doc.width, doc.height);
        const g = m.getContext('2d');
        g.fillRect(0, 0, m.width, m.height);
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(doc.selection.canvas, 0, 0);
        l.mask = { canvas: m, x: 0, y: 0, enabled: true, linked: false };
      } else l.mask = { canvas: cloneCanvas(doc.selection.canvas), x: 0, y: 0, enabled: true, linked: false };
      P.addLayer(l);
      doc.selection = null;
    });
    return undefined;
  };
  C.pasteInto = () => pasteMasked(false);
  C.pasteOutside = () => pasteMasked(true);

  // ---- Edit ▸ Auto-Align / Auto-Blend, Layer ▸ Stack mode
  const pixelLayers = () => (P.doc?.selectedLayers || []).filter((l) => l.kind === 'raster' && l.canvas);
  C.autoAlign = () => {
    const ls = pixelLayers();
    if (ls.length < 2) return toast('맞출 이미지 레이어를 두 개 이상 고르세요 (Ctrl/Shift+클릭)');
    const doc = P.doc;
    const ref = ls[0];
    const refC = P.layerAsDocCanvas(ref);
    const moves = ls.slice(1).map((l) => [l, findShift(refC, P.layerAsDocCanvas(l))]);
    P.run('레이어 자동 정렬', () => {
      for (const [l, [dx, dy]] of moves) doc.translateLayers([l], dx, dy);
    });
    toast(`기준(맨 아래 고른 레이어)에 맞춰 옮겼습니다: ${moves.map(([l, m]) => `${l.name} ${m[0]}, ${m[1]}px`).join(' · ')}`);
    return undefined;
  };
  C.autoBlend = () => {
    const ls = pixelLayers();
    if (ls.length < 2) return toast('합칠 이미지 레이어를 두 개 이상 고르세요');
    const doc = P.doc;
    const W = doc.width;
    const H = doc.height;
    // focus stacking: each pixel comes from the layer that is sharpest there
    const sharp = ls.map((l) => {
      const L = grayOf(read(P.layerAsDocCanvas(l)));
      const lap = new Float32Array(W * H);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        lap[i] = Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - W] - L[i + W]);
      }
      return gaussF(lap, W, H, 3);
    });
    P.run('레이어 자동 혼합 (이미지 스택)', () => {
      ls.forEach((l, k) => {
        const a = new Float32Array(W * H);
        for (let i = 0; i < a.length; i++) {
          let best = 0;
          for (let j = 1; j < ls.length; j++) if (sharp[j][i] > sharp[best][i]) best = j;
          a[i] = best === k ? 255 : 0;
        }
        const m = alphaCanvas(gaussF(a, W, H, 1.5), W, H);
        l.mask = { canvas: m, x: 0, y: 0, enabled: true, linked: true };
        l._styled = null;
        doc.touch(l);
      });
    });
    toast('레이어마다 가장 선명한 곳만 보이게 마스크를 만들었습니다');
    return undefined;
  };
  C.stackMode = (kind) => {
    const ls = pixelLayers();
    if (ls.length < 2) return toast('합칠 이미지 레이어를 두 개 이상 고르세요');
    const doc = P.doc;
    const data = ls.map((l) => read(P.layerAsDocCanvas(l)).data);
    const n = doc.width * doc.height;
    const out = new ImageData(doc.width, doc.height);
    const vals = new Float32Array(ls.length);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        let m = 0;
        for (let k = 0; k < ls.length; k++) vals[k] = data[k][i * 4 + c];
        if (c === 3) {
          m = Math.max(...vals);
        } else if (kind === 'median') {
          const s = Array.from(vals).sort((a, b) => a - b);
          m = s[s.length >> 1];
        } else if (kind === 'mean') {
          for (const v of vals) m += v;
          m /= ls.length;
        } else if (kind === 'max') m = Math.max(...vals);
        else if (kind === 'min') m = Math.min(...vals);
        else if (kind === 'range') m = Math.max(...vals) - Math.min(...vals);
        out.data[i * 4 + c] = m;
      }
    }
    const names = { median: '중간값', mean: '평균', max: '최대값', min: '최소값', range: '범위' };
    P.run(`스택 모드: ${names[kind]}`, () => {
      const l = newLayer('raster', { name: `스택 (${names[kind]})`, canvas: toCanvas(out) });
      P.addLayer(l);
    });
    if (kind === 'median') toast('중간값: 여러 장 중 한 장에만 있는 것(지나가는 사람 등)이 사라집니다');
    return undefined;
  };

  // ---- Edit ▸ Purge
  C.purge = async (what) => {
    if (what !== 'clipboard' && !(await confirmDialog('지우기', what === 'history' ? '작업 내역을 모두 지울까요? 실행 취소로 되돌릴 수 없게 됩니다.' : '작업 내역과 클립보드를 모두 지울까요?'))) return;
    if (what !== 'history') P.clipboard = null;
    if (what !== 'clipboard' && P.doc) {
      P.doc.history.undoStack = [];
      P.doc.history.redoStack = [];
      P.afterHistory();
    }
    toast('메모리를 비웠습니다');
  };

  // ---- Layer ▸ Matting
  const matte = (label, fn) => {
    const l = activeRaster(label);
    if (!l) return;
    P.run(label, () => {
      const c = cloneCanvas(l.canvas);
      const img = read(c);
      fn(img);
      c.getContext('2d').putImageData(img, 0, 0);
      l.canvas = c;
      l._styled = null;
      P.doc.touch(l);
    });
  };
  C.defringe = async () => {
    const v = await promptDialog('가장자리 제거', '폭 (px)', '1');
    const r = Math.round(parseFloat(v));
    if (!(r > 0)) return;
    matte('가장자리 제거', (img) => {
      // edge pixels take the colour of the solid pixels next to them, ring by ring
      const { width: w, height: hh, data: d } = img;
      const solid = new Uint8Array(w * hh);
      for (let i = 0; i < solid.length; i++) solid[i] = d[i * 4 + 3] >= 250 ? 1 : 0;
      // the ring to recolour: within r of a not-solid pixel
      let core = solid;
      for (let k = 0; k < r; k++) {
        const next = new Uint8Array(core);
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!core[i]) continue;
          if ((x > 0 && !core[i - 1]) || (x < w - 1 && !core[i + 1]) || (y > 0 && !core[i - w]) || (y < hh - 1 && !core[i + w])) next[i] = 0;
        }
        core = next;
      }
      let known = new Uint8Array(core);
      for (let k = 0; k < r + 2; k++) {
        const nk = new Uint8Array(known);
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (known[i] || !d[i * 4 + 3]) continue;
          let s0 = 0;
          let s1 = 0;
          let s2 = 0;
          let n = 0;
          for (const j of [i - 1, i + 1, i - w, i + w]) {
            if (j < 0 || j >= w * hh || !known[j]) continue;
            s0 += d[j * 4];
            s1 += d[j * 4 + 1];
            s2 += d[j * 4 + 2];
            n++;
          }
          if (!n) continue;
          d[i * 4] = s0 / n;
          d[i * 4 + 1] = s1 / n;
          d[i * 4 + 2] = s2 / n;
          nk[i] = 1;
        }
        known = nk;
      }
    });
  };
  C.removeMatte = (bg) => matte(bg ? '흰색 매트 제거' : '검정 매트 제거', (img) => {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a <= 0 || a >= 1) continue;
      for (let k = 0; k < 3; k++) d[i + k] = cl(bg ? (d[i + k] - 255 * (1 - a)) / a : d[i + k] / a);
    }
  });

  // ---- Layer ▸ Arrange ▸ Reverse
  C.reverseLayers = () => {
    const doc = P.doc;
    const ls = doc?.selectedLayers || [];
    if (ls.length < 2) return toast('순서를 뒤집을 레이어를 두 개 이상 고르세요');
    P.run('레이어 순서 반전', () => {
      const idx = ls.map((l) => doc.layers.indexOf(l)).sort((a, b) => a - b);
      const rev = idx.map((i) => doc.layers[i]).reverse();
      idx.forEach((i, k) => { doc.layers[i] = rev[k]; });
      doc.rev++;
    });
    return undefined;
  };

  // ---- Layer ▸ Layer Style ▸ Hide All Effects / Create Layers
  C.toggleAllEffects = () => {
    const doc = P.doc;
    if (!doc) return;
    P.run(doc.hideFx ? '모든 효과 보이기' : '모든 효과 숨기기', () => {
      doc.hideFx = !doc.hideFx;
      for (const l of doc.layers) {
        l._styled = null;
        l.rev++;
      }
      doc.rev++;
    });
  };
  C.styleToLayers = () => {
    const doc = P.doc;
    const l = doc?.active;
    if (!l || !l.fx || !Object.values(l.fx).some((e) => e?.enabled)) return toast('레이어 스타일이 있는 레이어를 고르세요');
    const c = doc.content(l);
    if (!c) return undefined;
    const st = doc.styled(l, c);
    if (!st?.passes) return toast('나눌 효과가 없습니다');
    P.run('레이어 스타일로 레이어 만들기', () => {
      const at = doc.layers.indexOf(l);
      const made = [];
      for (const p of st.passes) {
        if (p.kind === 'body') continue;
        const cv = makeCanvas(doc.width, doc.height);
        cv.getContext('2d').drawImage(p.canvas, st.x, st.y);
        const nl = newLayer('raster', { name: `${l.name}의 ${P.fxNames?.[p.kind] || p.kind}`, canvas: cv, blend: p.blend || 'normal', opacity: p.opacity ?? 1, parent: l.parent });
        made.push([p.kind, nl]);
      }
      // shadows and glows behind the layer, the rest above it
      const below = made.filter(([k]) => k === 'dropShadow' || k === 'outerGlow').map(([, x]) => x);
      const above = made.filter(([k]) => k !== 'dropShadow' && k !== 'outerGlow').map(([, x]) => x);
      doc.layers.splice(at + 1, 0, ...above);
      doc.layers.splice(at, 0, ...below);
      l.fx = {};
      l._styled = null;
      doc.touch(l);
    });
    return undefined;
  };

  // ---- Layer ▸ New ▸ Background ↔ layer
  C.layerFromBackground = () => {
    const l = P.doc?.layers[0];
    if (!l) return;
    P.run('배경에서 레이어', () => {
      l.name = l.name === '배경' ? '레이어 0' : l.name;
      l.locked = false;
      l.lockPos = false;
      P.doc.touch(l);
    });
  };
  C.backgroundFromLayer = () => {
    const doc = P.doc;
    const l = activeRaster('레이어에서 배경으로');
    if (!l) return;
    P.run('레이어에서 배경으로', () => {
      const c = makeCanvas(doc.width, doc.height);
      const g = c.getContext('2d');
      g.fillStyle = P.bg;
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(l.canvas, l.x, l.y);
      l.canvas = c;
      l.x = 0;
      l.y = 0;
      l.name = '배경';
      l.parent = null;
      l.blend = 'normal';
      l.opacity = 1;
      doc.layers = [l, ...doc.layers.filter((x) => x !== l)];
      doc.touch(l);
    });
  };

  // ---- File ▸ Export
  C.quickExport = async () => {
    if (!need()) return;
    const { exportBlob } = await import('./io.js');
    const blob = await exportBlob(P.doc, 'png', 1, 1, { fg: P.fg, bg: P.bg });
    if (await downloadBlob(blob, `${P.doc.name}.png`)) toast(`${P.doc.name}.png 저장`);
  };
  C.saveForWeb = () => {
    if (!need()) return;
    const doc = P.doc;
    const fmt = sel([['gif', 'GIF'], ['png8', 'PNG-8 (256색, 작음)'], ['png24', 'PNG-24 (모든 색)'], ['jpg', 'JPG']], 'png8');
    const palette = sel(PALETTES, 'adaptive');
    const colors = num(128, 2, 256);
    const dither = sel(DITHERS, 'diffusion');
    const transp = h('input', { type: 'checkbox', checked: true });
    const quality = num(80, 1, 100);
    const scale = num(100, 1, 400);
    const info = h('div.note', '');
    const prev = h('canvas.ph-modeprev', { width: 320, height: 200 });
    const rowsIdx = [formRow('팔레트', palette), formRow('색상 수', colors), formRow('디더', dither), formRow('투명도', transp)];
    const rowQ = formRow('화질', quality);
    let token = 0;
    const build = async () => {
      const k = +scale.value / 100;
      const W = Math.max(1, Math.round(doc.width * k));
      const H = Math.max(1, Math.round(doc.height * k));
      const c = makeCanvas(W, H);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(P.composite(), 0, 0, W, H);
      if (fmt.value === 'jpg' || fmt.value === 'png24') {
        const type = fmt.value === 'jpg' ? 'image/jpeg' : 'image/png';
        if (fmt.value === 'jpg') {
          const m = makeCanvas(W, H);
          const mg = m.getContext('2d');
          mg.fillStyle = '#ffffff';
          mg.fillRect(0, 0, W, H);
          mg.drawImage(c, 0, 0);
          return { blob: await new Promise((r) => m.toBlob(r, type, +quality.value / 100)), canvas: m, ext: fmt.value === 'jpg' ? 'jpg' : 'png' };
        }
        return { blob: await new Promise((r) => c.toBlob(r, type)), canvas: c, ext: 'png' };
      }
      const q = quantize(read(c), { palette: palette.value, colors: +colors.value, dither: dither.value, transparency: transp.checked });
      const out = toCanvas(indexedToImage(q));
      const blob = fmt.value === 'gif' ? gifBlob(q) : await png8Blob(q);
      return { blob, canvas: out, ext: fmt.value === 'gif' ? 'gif' : 'png' };
    };
    const refresh = async () => {
      const my = ++token;
      const indexed = fmt.value === 'gif' || fmt.value === 'png8';
      for (const r of rowsIdx) r.hidden = !indexed;
      rowQ.hidden = fmt.value !== 'jpg';
      info.textContent = '계산 중…';
      const r = await build();
      if (my !== token) return;
      const k = Math.min(1, 320 / r.canvas.width, 200 / r.canvas.height);
      prev.width = Math.max(1, Math.round(r.canvas.width * k));
      prev.height = Math.max(1, Math.round(r.canvas.height * k));
      const pg = prev.getContext('2d');
      pg.imageSmoothingEnabled = k < 1;
      pg.drawImage(r.canvas, 0, 0, prev.width, prev.height);
      info.textContent = `${r.canvas.width} × ${r.canvas.height} px · 약 ${(r.blob.size / 1024).toFixed(1)} KB`;
    };
    for (const e of [fmt, palette, colors, dither, transp, quality, scale]) e.addEventListener('change', refresh);
    openModal({
      title: '웹용으로 저장',
      width: '460px',
      body: [formRow('형식', fmt), ...rowsIdx, rowQ, formRow('크기 (%)', scale), prev, info],
      buttons: [{ label: '취소' }, {
        label: '저장', primary: true, action: async () => {
          const r = await build();
          if (await downloadBlob(r.blob, `${doc.name}.${r.ext}`)) toast(`${doc.name}.${r.ext} 저장 (${(r.blob.size / 1024).toFixed(1)} KB)`);
        },
      }],
    });
    refresh();
  };
  C.fileInfo = () => {
    if (!need()) return;
    const doc = P.doc;
    const info = doc.info || {};
    const fields = [['title', '제목'], ['author', '만든 사람'], ['description', '설명'], ['keywords', '키워드 (쉼표로)'], ['copyright', '저작권']];
    const inputs = Object.fromEntries(fields.map(([k]) => [k, h(k === 'description' ? 'textarea' : 'input', { value: info[k] || '', rows: 3, style: { width: '100%' } })]));
    if (inputs.description) inputs.description.value = info.description || '';
    for (const i of Object.values(inputs)) i.addEventListener('keydown', (e) => e.stopPropagation());
    openModal({
      title: '파일 정보',
      width: '480px',
      body: [...fields.map(([k, label]) => formRow(label, inputs[k])), h('div.note', `${doc.width} × ${doc.height} px · 해상도 ${doc.resolution || 72} ppi. 이 정보는 Montage 사진 파일(.mphoto)에 함께 저장됩니다.`)],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => P.run('파일 정보', () => {
          doc.info = Object.fromEntries(fields.map(([k]) => [k, inputs[k].value.trim()]));
        }),
      }],
    });
  };
  C.print = async () => {
    if (!need()) return;
    const blob = await new Promise((r) => P.composite().toBlob(r, 'image/png'));
    const url = URL.createObjectURL(blob);
    const f = h('iframe', { style: { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' } });
    document.body.append(f);
    const d = f.contentDocument;
    d.open();
    d.write(`<!doctype html><title>${P.doc.name.replace(/</g, '&lt;')}</title><style>@page{margin:10mm}html,body{margin:0}img{max-width:100%;max-height:100vh;display:block;margin:auto}</style><img src="${url}">`);
    d.close();
    const img = d.querySelector('img');
    await new Promise((r) => (img.complete ? r() : img.addEventListener('load', r, { once: true })));
    try {
      f.contentWindow.focus();
      f.contentWindow.print();
    } catch {
      toast('이 화면에서는 인쇄할 수 없습니다. PNG로 내보낸 뒤 인쇄하세요.');
    }
    setTimeout(() => {
      f.remove();
      URL.revokeObjectURL(url);
    }, 60000);
  };

  // ---- File ▸ Automate
  C.fitImage = () => {
    if (!need()) return;
    const doc = P.doc;
    const w = num(1920, 1, 30000);
    const hh = num(1080, 1, 30000);
    const grow = h('input', { type: 'checkbox' });
    openModal({
      title: '이미지 맞추기',
      body: [formRow('최대 폭 (px)', w), formRow('최대 높이 (px)', hh), formRow('작으면 키우기', grow), h('div.note', `지금 ${doc.width} × ${doc.height} px. 비율을 지키며 상자 안에 들어가게 크기를 바꿉니다.`)],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const k = Math.min(+w.value / doc.width, +hh.value / doc.height);
          if (k >= 1 && !grow.checked) return toast('이미 상자 안에 들어갑니다');
          P.resizeImage?.(Math.max(1, Math.round(doc.width * k)), Math.max(1, Math.round(doc.height * k)));
          return undefined;
        },
      }],
    });
  };
  C.contactSheet = () => {
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      if (!files.length) return;
      const { canvasFromFile } = await import('./io.js');
      const cols = Math.ceil(Math.sqrt(files.length));
      const rows = Math.ceil(files.length / cols);
      const cell = 300;
      const pad = 16;
      const cap = 28;
      const W = cols * (cell + pad) + pad;
      const H = rows * (cell + cap + pad) + pad;
      const c = makeCanvas(W, H);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#333333';
      g.font = '14px "Noto Sans KR", sans-serif';
      g.textAlign = 'center';
      let i = 0;
      for (const f of files) {
        try {
          const im = await canvasFromFile(f);
          const k = Math.min(cell / im.width, cell / im.height);
          const x = pad + (i % cols) * (cell + pad);
          const y = pad + Math.floor(i / cols) * (cell + cap + pad);
          g.imageSmoothingQuality = 'high';
          g.drawImage(im, x + (cell - im.width * k) / 2, y + (cell - im.height * k) / 2, im.width * k, im.height * k);
          const name = f.name.length > 34 ? `${f.name.slice(0, 31)}…` : f.name;
          g.fillText(name, x + cell / 2, y + cell + 20);
          i++;
        } catch {
          /* skip files that cannot be read */
        }
      }
      P.openCanvas(c, '밀착 인화');
      toast(`${i}장으로 밀착 인화를 만들었습니다`);
    });
    input.click();
  };

  // ---- View ▸ Proof Colors / Gamut Warning
  const proof = { on: false, gamut: false, key: '', canvas: null };
  const inner = P.displayCanvas;
  P.displayCanvas = (comp) => {
    const base = inner ? inner(comp) : comp;
    if (!proof.on && !proof.gamut) return base;
    const key = `${P.doc?.id}|${P.doc?.rev}|${base.width}x${base.height}|${proof.on}|${proof.gamut}|${base === comp ? 'c' : 'd'}`;
    if (proof.key === key && proof.canvas) return proof.canvas;
    const img = read(base);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // a simple CMYK round trip: total ink limited to 300%, duller paper white and black
      const r = d[i] / 255;
      const g = d[i + 1] / 255;
      const b = d[i + 2] / 255;
      const k = 1 - Math.max(r, g, b);
      let cc = k < 1 ? (1 - r - k) / (1 - k) : 0;
      let mm = k < 1 ? (1 - g - k) / (1 - k) : 0;
      let yy = k < 1 ? (1 - b - k) / (1 - k) : 0;
      const ink = cc + mm + yy + k;
      const out = ink > 3 ? 3 / ink : 1;
      // printers can't reach very saturated RGB greens, blues and oranges
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const hard = sat > 0.75 && (g > r && g > b || b > r && b > g * 1.1 || r > 0.9 && g > 0.35 && g < 0.75 && b < 0.2);
      if (proof.gamut && hard) {
        d[i] = d[i + 1] = d[i + 2] = 128;
        continue;
      }
      if (proof.on) {
        cc *= out * 0.92;
        mm *= out * 0.92;
        yy *= out * 0.92;
        const kk = k * out * 0.9;
        const back = (v) => 255 * (1 - Math.min(1, v * (1 - kk) + kk)) * 0.96 + 4;
        let nr = back(cc);
        let ng = back(mm);
        let nb = back(yy);
        if (hard) {
          const Y = lum(nr, ng, nb);
          nr = Y + (nr - Y) * 0.75;
          ng = Y + (ng - Y) * 0.75;
          nb = Y + (nb - Y) * 0.75;
        }
        d[i] = nr;
        d[i + 1] = ng;
        d[i + 2] = nb;
      }
    }
    proof.canvas = toCanvas(img);
    proof.key = key;
    return proof.canvas;
  };
  C.proofColors = () => {
    proof.on = !proof.on;
    toast(proof.on ? '교정 색상: 인쇄(CMYK)했을 때 비슷한 모습으로 보여 줍니다 (근사)' : '교정 색상 끔');
    window.dispatchEvent(new Event('photo:redraw'));
  };
  C.gamutWarning = () => {
    proof.gamut = !proof.gamut;
    toast(proof.gamut ? '색 영역 경고: 인쇄하기 어려운 진한 색을 회색으로 표시합니다 (근사)' : '색 영역 경고 끔');
    window.dispatchEvent(new Event('photo:redraw'));
  };

  // ---------------------------------------------------------------- menus (after editor.js builds them)
  P.extendMenus = [...(P.extendMenus || []), () => extendMenus(P, C, proof)];
  P.proofState = proof;
}

function extendMenus(P, C, proof) {
  const at = (items, label) => items.findIndex((x) => typeof x === 'object' && x?.label?.startsWith(label));
  const wrap = (name, fn) => {
    const orig = P.menus[name];
    if (orig) P.menus[name] = () => fn(orig());
  };
  const no = () => !P.doc;
  wrap('이미지', (items) => {
    const m = items[at(items, '모드')];
    if (m?.submenu && Array.isArray(m.submenu)) {
      m.submenu.push('-',
        { label: '비트맵…', action: () => C.modeBitmap() },
        { label: '이중톤…', checked: P.doc?.mode === 'duotone', action: () => C.modeDuotone() },
        { label: '인덱스 색상…', checked: P.doc?.mode === 'indexed', action: () => C.modeIndexed() });
    }
    const r = items[at(items, '이미지 회전')];
    if (r?.submenu) r.submenu.splice(3, 0, { label: '임의…', action: () => C.rotateArbitrary() });
    const i = at(items, '이미지 크기');
    items.splice(i, 0, { label: '이미지 적용…', disabled: no(), action: () => C.applyImage() }, { label: '계산…', disabled: no(), action: () => C.calculations() }, '-');
    return items;
  });
  wrap('편집', (items) => {
    const i = at(items, '붙여넣기');
    if (i >= 0) {
      items.splice(i + 1, 0, { label: '특수 붙여넣기', disabled: no(), submenu: [
        { label: '제자리에 붙여넣기', key: 'Ctrl+Shift+V', action: () => C.pasteInPlace() },
        { label: '안쪽에 붙여넣기 (선택 영역 마스크)', disabled: !P.doc?.selection, action: () => C.pasteInto() },
        { label: '바깥쪽에 붙여넣기', disabled: !P.doc?.selection, action: () => C.pasteOutside() },
      ] });
    }
    items.push('-',
      { label: '레이어 자동 정렬 (위치 맞추기)', disabled: no(), action: () => C.autoAlign() },
      { label: '레이어 자동 혼합 (초점 쌓기)', disabled: no(), action: () => C.autoBlend() },
      { label: '지우기 (메모리)', submenu: [
        { label: '작업 내역', action: () => C.purge('history') },
        { label: '클립보드', action: () => C.purge('clipboard') },
        { label: '모두', action: () => C.purge('all') },
      ] });
    return items;
  });
  wrap('레이어', (items) => {
    items.push('-',
      { label: '스택 모드로 합치기 (고른 레이어)', disabled: no(), submenu: [
        { label: '중간값 (지나가는 사람 지우기)', action: () => C.stackMode('median') },
        { label: '평균 (노이즈 줄이기)', action: () => C.stackMode('mean') },
        { label: '최대값', action: () => C.stackMode('max') },
        { label: '최소값', action: () => C.stackMode('min') },
        { label: '범위 (달라진 곳 찾기)', action: () => C.stackMode('range') },
      ] },
      { label: '매팅', disabled: no(), submenu: [
        { label: '가장자리 제거…', action: () => C.defringe() },
        { label: '검정 매트 제거', action: () => C.removeMatte(false) },
        { label: '흰색 매트 제거', action: () => C.removeMatte(true) },
      ] },
      { label: '레이어 순서 반전 (고른 레이어)', disabled: no(), action: () => C.reverseLayers() },
      { label: P.doc?.hideFx ? '모든 효과 보이기' : '모든 효과 숨기기', disabled: no(), action: () => C.toggleAllEffects() },
      { label: '레이어 스타일로 레이어 만들기', disabled: no(), action: () => C.styleToLayers() },
      { label: '배경에서 레이어', disabled: no(), action: () => C.layerFromBackground() },
      { label: '레이어에서 배경으로', disabled: no(), action: () => C.backgroundFromLayer() });
    return items;
  });
  wrap('파일', (items) => {
    const i = at(items, '내보내기 (PNG');
    items.splice(i + 1, 0,
      { label: '빠른 내보내기 (PNG)', key: 'Ctrl+Shift+Alt+\'', disabled: no(), action: () => C.quickExport() },
      { label: '웹용으로 저장 (GIF · PNG-8 · JPG)…', disabled: no(), action: () => C.saveForWeb() });
    const a = items[at(items, '자동화')];
    if (a?.submenu) a.submenu.push({ label: '밀착 인화… (여러 사진을 한 장에)', action: () => C.contactSheet() }, { label: '이미지 맞추기…', disabled: no(), action: () => C.fitImage() });
    items.push('-', { label: '파일 정보…', disabled: no(), action: () => C.fileInfo() }, { label: '인쇄…', key: 'Ctrl+P', disabled: no(), action: () => C.print() });
    return items;
  });
  wrap('보기', (items) => {
    items.push('-',
      { label: '교정 색상 (인쇄 근사)', checked: proof.on, disabled: no(), action: () => C.proofColors() },
      { label: '색 영역 경고', key: 'Ctrl+Shift+Y', checked: proof.gamut, disabled: no(), action: () => C.gamutWarning() });
    return items;
  });
}

function selectionBounds(doc) {
  const c = doc.selection.canvas;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width;
  let y0 = c.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w: doc.width, h: doc.height } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The shift (dx, dy) that lines `mov` up with `ref`: a coarse-to-fine search on grey,
 * edge-emphasised copies. Translation only.
 */
function findShift(ref, mov) {
  const levels = [];
  let k = Math.min(1, 1024 / Math.max(ref.width, ref.height));
  while (k * Math.max(ref.width, ref.height) > 96) {
    levels.unshift(k);
    k /= 2;
  }
  levels.unshift(k);
  const prep = (c, s) => {
    const w = Math.max(8, Math.round(c.width * s));
    const hh = Math.max(8, Math.round(c.height * s));
    const t = makeCanvas(w, hh);
    const g = t.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, w, hh);
    const img = g.getImageData(0, 0, w, hh);
    const L = grayOf(img);
    const A = new Float32Array(w * hh);
    for (let i = 0; i < A.length; i++) A[i] = img.data[i * 4 + 3];
    return { L, A, w, h: hh };
  };
  let dx = 0;
  let dy = 0;
  levels.forEach((s, li) => {
    const a = prep(ref, s);
    const b = prep(mov, s);
    const R = li === 0 ? Math.round(Math.max(a.w, a.h) * 0.25) : 2;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    const cx = dx * s;
    const cy = dy * s;
    for (let oy = -R; oy <= R; oy++) {
      for (let ox = -R; ox <= R; ox++) {
        const sx = Math.round(cx + ox);
        const sy = Math.round(cy + oy);
        let sum = 0;
        let n = 0;
        const step = Math.max(1, Math.floor(Math.sqrt((a.w * a.h) / 6000)));
        for (let y = 0; y < a.h; y += step) {
          const yy = y - sy;
          if (yy < 0 || yy >= b.h) continue;
          for (let x = 0; x < a.w; x += step) {
            const xx = x - sx;
            if (xx < 0 || xx >= b.w) continue;
            const i = y * a.w + x;
            const j = yy * b.w + xx;
            if (a.A[i] < 128 || b.A[j] < 128) continue;
            sum += Math.abs(a.L[i] - b.L[j]);
            n++;
          }
        }
        // prefer overlaps that cover a good part of the picture
        const score = n > (a.w * a.h) / (step * step) * 0.25 ? sum / n : Infinity;
        if (score < best) {
          best = score;
          bx = sx;
          by = sy;
        }
      }
    }
    dx = bx / s;
    dy = by / s;
  });
  return [Math.round(dx), Math.round(dy)];
}
