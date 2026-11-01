// Photo editor dialogs. Each takes the editor API `P`.

import { h, clamp } from '../util.js';
import { openModal, formRow, toast } from '../ui/common.js';
import { makeCanvas, cloneCanvas } from './doc.js';
import { ADJUSTMENTS, defaultParams, applyAdjustment, FILTERS, defaultFilterParams, applyFilter, visibleParams } from './adjust.js';
import { EXPORT_TYPES } from './io.js';
import { BLEND_MODES, compositeOnto } from './blend.js';
import { GRADIENTS, GRADIENT_STYLES, gradientSwatch, listPatterns, resolveStopColor, paintPattern } from './resources.js';
import { CUSTOM_EDITORS, histOf, ensureAdjStyle, curvesGraph } from './adjui.js';
import { cameraRawDialog } from './camraw.js';
import { createColorPicker } from './colorpicker.js';

export const DOC_PRESETS = [
  ['1920x1080', '유튜브·동영상 1920 × 1080', 1920, 1080],
  ['1080x1920', '쇼츠·릴스·스토리 1080 × 1920', 1080, 1920],
  ['1080x1080', '인스타 정사각형 1080 × 1080', 1080, 1080],
  ['1080x1350', '인스타 세로 1080 × 1350', 1080, 1350],
  ['1280x720', '유튜브 썸네일 1280 × 720', 1280, 720],
  ['1200x628', '웹 배너·링크 1200 × 628', 1200, 628],
  ['2480x3508', 'A4 인쇄 (300ppi) 2480 × 3508', 2480, 3508],
  ['800x600', '작은 그림 800 × 600', 800, 600],
];

const num = (value, min, max, step = 1, w = '90px') => h('input', { type: 'number', value, min, max, step, style: { width: w } });
const sel = (opts, value) => {
  const s = h('select', opts.map(([v, t]) => h('option', { value: v }, t)));
  s.value = value;
  return s;
};
const chk = (checked, label) => {
  const box = h('input', { type: 'checkbox', checked });
  return { el: h('label.inline', box, label), box };
};

// ---------------------------------------------------------------- units

export const UNITS = [['px', '픽셀'], ['percent', '퍼센트'], ['in', '인치'], ['cm', '센티미터'], ['mm', '밀리미터'], ['pt', '포인트'], ['pica', '파이카']];
const PER_INCH = { in: 1, cm: 2.54, mm: 25.4, pt: 72, pica: 6 };
/** A length in `unit` → pixels (`base`: 100% for percent, `res`: pixels per inch). */
export const toPx = (v, unit, res, base) => (unit === 'px' ? v : unit === 'percent' ? (base * v) / 100 : (v * res) / PER_INCH[unit]);
export const fromPx = (px, unit, res, base) => (unit === 'px' ? px : unit === 'percent' ? (px / base) * 100 : (px / res) * PER_INCH[unit]);
const roundUnit = (v, unit) => (unit === 'px' ? Math.round(v) : Math.round(v * 100) / 100);
const unitSel = (value, list = UNITS) => sel(list, value);
const fmtSize = (w, hh) => {
  const b = w * hh * 3;
  return b >= 1e6 ? `${(b / 1048576).toFixed(1)}M` : `${Math.round(b / 1024)}K`;
};

// ---------------------------------------------------------------- new document

export function newDocDialog(P) {
  const name = h('input', { type: 'text', value: `제목 없음-${P.docs.length + 1}`, style: { width: '100%' } });
  const preset = sel([...DOC_PRESETS.map(([id, t]) => [id, t]), ['custom', '직접 입력']], '1920x1080');
  const st = { w: 1920, h: 1080, res: 72 };
  const w = num(1920, 0.01, 30000, 'any');
  const hh = num(1080, 0.01, 30000, 'any');
  const unit = unitSel('px', UNITS.filter(([u]) => u !== 'percent'));
  const res = num(72, 1, 9999, 1, '80px');
  const resUnit = sel([['in', '픽셀/인치'], ['cm', '픽셀/센티미터']], 'in');
  const orient = sel([['portrait', '세로'], ['landscape', '가로']], 'landscape');
  const bg = sel([['#ffffff', '흰색'], ['#000000', '검정'], ['bg', '배경색'], ['fg', '전경색'], ['transparent', '투명'], ['custom', '사용자 정의…']], '#ffffff');
  const bgColor = h('input', { type: 'color', value: '#808080', hidden: true, 'aria-label': '배경 색' });
  bg.addEventListener('change', () => { bgColor.hidden = bg.value !== 'custom'; });
  const ppi = () => (resUnit.value === 'cm' ? +res.value * 2.54 : +res.value) || 72;
  const show = () => {
    w.value = roundUnit(fromPx(st.w, unit.value, ppi(), st.w), unit.value);
    hh.value = roundUnit(fromPx(st.h, unit.value, ppi(), st.h), unit.value);
    orient.value = st.w >= st.h ? 'landscape' : 'portrait';
  };
  preset.addEventListener('change', () => {
    const p = DOC_PRESETS.find((x) => x[0] === preset.value);
    if (!p) return;
    st.w = p[2];
    st.h = p[3];
    if (p[0] === '2480x3508') res.value = resUnit.value === 'cm' ? 118.11 : 300;
    show();
  });
  w.addEventListener('input', () => {
    st.w = toPx(+w.value || 1, unit.value, ppi(), st.w);
    preset.value = 'custom';
    orient.value = st.w >= st.h ? 'landscape' : 'portrait';
  });
  hh.addEventListener('input', () => {
    st.h = toPx(+hh.value || 1, unit.value, ppi(), st.h);
    preset.value = 'custom';
    orient.value = st.w >= st.h ? 'landscape' : 'portrait';
  });
  unit.addEventListener('change', show);
  resUnit.addEventListener('change', () => {
    res.value = Math.round((resUnit.value === 'cm' ? +res.value / 2.54 : +res.value * 2.54) * 100) / 100;
  });
  res.addEventListener('change', () => {
    // physical sizes keep their size: the pixels follow the resolution
    if (unit.value !== 'px') {
      st.w = toPx(+w.value || 1, unit.value, ppi(), st.w);
      st.h = toPx(+hh.value || 1, unit.value, ppi(), st.h);
    }
  });
  orient.addEventListener('change', () => {
    if ((orient.value === 'landscape') !== st.w >= st.h) [st.w, st.h] = [st.h, st.w];
    show();
  });
  show();
  openModal({
    title: '새 문서',
    width: '500px',
    body: [formRow('이름', name), formRow('사전 설정', preset), formRow('폭', w, unit), formRow('높이', hh), formRow('방향', orient), formRow('해상도', res, resUnit), formRow('배경 내용', bg, bgColor), formRow('색상 모드', h('span', 'RGB 색상 · 8비트'))],
    buttons: [{ label: '취소' }, {
      label: '만들기', primary: true, action: () => {
        const W = clamp(Math.round(st.w || 1), 1, 30000);
        const H = clamp(Math.round(st.h || 1), 1, 30000);
        if (W * H > 80e6) {
          toast('너무 큰 문서입니다 (최대 약 8000만 픽셀)');
          return false;
        }
        const b = bg.value === 'fg' ? P.fg : bg.value === 'bg' ? P.bg : bg.value === 'custom' ? bgColor.value : bg.value;
        P.newDoc({ name: name.value.trim() || '제목 없음', width: W, height: H, background: b });
        if (P.doc) P.doc.resolution = Math.max(1, Math.round(ppi() * 100) / 100);
        return true;
      },
    }],
  });
}

// ---------------------------------------------------------------- image / canvas size

export const RESAMPLE = [['auto', '자동'], ['preserve', '세부 묘사 유지 (확대)'], ['bicubicSmoother', '쌍입방 매끄럽게 (확대)'], ['bicubicSharper', '쌍입방 선명하게 (축소)'], ['bicubic', '쌍입방 (매끄러운 그레이디언트)'], ['nearest', '최단입점 (명확한 가장자리)'], ['bilinear', '쌍선형']];
const FIT_TO = [
  ['', '원본 크기'],
  ['px:1920x1080', '1920 × 1080 픽셀 (풀 HD)'], ['px:1280x720', '1280 × 720 픽셀'], ['px:1080x1080', '1080 × 1080 픽셀'], ['px:800x600', '800 × 600 픽셀'],
  ['in:4x6@300', '4 × 6 인치 300 ppi'], ['in:5x7@300', '5 × 7 인치 300 ppi'], ['in:8x10@300', '8 × 10 인치 300 ppi'],
  ['cm:21x29.7@300', 'A4 (21 × 29.7 cm) 300 ppi'], ['res:72', '72 ppi (웹)'], ['res:300', '300 ppi (인쇄)'],
];

export function imageSizeDialog(P) {
  const doc = P.doc;
  if (!doc) return;
  const W0 = doc.width;
  const H0 = doc.height;
  const st = { w: W0, h: H0, res: doc.resolution || 72 };
  const ratio = W0 / H0;
  const info = h('div.note');
  const fit = sel(FIT_TO, '');
  const w = num(W0, 0.01, 300000, 'any');
  const hh = num(H0, 0.01, 300000, 'any');
  const wu = unitSel('px');
  const hu = unitSel('px');
  const res = num(st.res, 0.01, 99999, 'any', '90px');
  const resU = sel([['in', '픽셀/인치'], ['cm', '픽셀/센티미터']], 'in');
  const keep = chk(true, '비율 제한');
  const resample = chk(true, '리샘플링');
  const method = sel(RESAMPLE, 'auto');
  const noise = h('input', { type: 'range', min: 0, max: 100, value: 0, 'aria-label': '노이즈 감소' });
  const noiseRow = formRow('노이즈 감소 (%)', noise);
  const ppi = () => st.res;
  const show = (skip) => {
    if (skip !== w) w.value = roundUnit(fromPx(st.w, wu.value, ppi(), W0), wu.value);
    if (skip !== hh) hh.value = roundUnit(fromPx(st.h, hu.value, ppi(), H0), hu.value);
    if (skip !== res) res.value = Math.round((resU.value === 'cm' ? st.res / 2.54 : st.res) * 100) / 100;
    const nw = Math.round(st.w);
    const nh = Math.round(st.h);
    info.textContent = `이미지 크기: ${fmtSize(nw, nh)}${nw !== W0 || nh !== H0 ? ` (이전 ${fmtSize(W0, H0)})` : ''} · 치수: ${nw} × ${nh} 픽셀`;
    for (const u of [wu, hu]) for (const o of u.options) o.disabled = !resample.box.checked && (o.value === 'px' || o.value === 'percent');
    method.disabled = !resample.box.checked;
    noiseRow.hidden = !(resample.box.checked && method.value === 'preserve');
  };
  const fromField = (field) => {
    const isW = field === w;
    const unit = (isW ? wu : hu).value;
    const v = +field.value || 0;
    if (!(v > 0)) return;
    if (resample.box.checked) {
      if (isW) st.w = toPx(v, unit, ppi(), W0);
      else st.h = toPx(v, unit, ppi(), H0);
      if (keep.box.checked) {
        if (isW) st.h = st.w / ratio;
        else st.w = st.h * ratio;
      }
    } else {
      // pixels stay: a physical size sets the resolution
      const px = isW ? st.w : st.h;
      st.res = clamp((px / v) * PER_INCH[unit], 0.01, 99999);
    }
    fit.value = '';
    show(field);
  };
  w.addEventListener('input', () => fromField(w));
  hh.addEventListener('input', () => fromField(hh));
  for (const [u, other] of [[wu, hu], [hu, wu]]) {
    u.addEventListener('change', () => {
      // linked sizes share their unit (Photoshop); unlinked, percent stays on its own row
      if (keep.box.checked || (u.value !== 'percent' && other.value !== 'percent')) other.value = u.value;
      show();
    });
  }
  res.addEventListener('input', () => {
    const v = +res.value;
    if (!(v > 0)) return;
    const nres = resU.value === 'cm' ? v * 2.54 : v;
    if (resample.box.checked) {
      // the print size stays, so the pixels change
      st.w *= nres / st.res;
      st.h *= nres / st.res;
    }
    st.res = nres;
    fit.value = '';
    show(res);
  });
  resU.addEventListener('change', () => show());
  resample.box.addEventListener('change', () => {
    if (!resample.box.checked) {
      st.w = W0;
      st.h = H0;
      if (wu.value === 'px' || wu.value === 'percent') {
        wu.value = 'in';
        hu.value = 'in';
      }
    }
    show();
  });
  method.addEventListener('change', () => show());
  keep.box.addEventListener('change', () => {
    if (keep.box.checked) st.h = st.w / ratio;
    show();
  });
  fit.addEventListener('change', () => {
    const v = fit.value;
    if (!v) {
      st.w = W0;
      st.h = H0;
      st.res = doc.resolution || 72;
    } else if (v.startsWith('px:')) {
      const [a, b] = v.slice(3).split('x').map(Number);
      // fit inside the box keeping the proportions
      const k = Math.min(a / W0, b / H0);
      st.w = W0 * k;
      st.h = H0 * k;
      wu.value = 'px';
      hu.value = 'px';
    } else if (v.startsWith('res:')) {
      const r = +v.slice(4);
      if (resample.box.checked) {
        st.w *= r / st.res;
        st.h *= r / st.res;
      }
      st.res = r;
    } else {
      const m = v.match(/^(in|cm):([\d.]+)x([\d.]+)@(\d+)$/);
      const [, u, a, b, r] = m;
      st.res = +r;
      const k = Math.min(toPx(+a, u, st.res, 0) / W0, toPx(+b, u, st.res, 0) / H0);
      st.w = W0 * k;
      st.h = H0 * k;
      wu.value = u;
      hu.value = u;
    }
    if (!resample.box.checked) {
      st.w = W0;
      st.h = H0;
    }
    show();
  });
  show();
  openModal({
    title: '이미지 크기',
    width: '500px',
    body: [info, formRow('맞추기', fit), formRow('폭', w, wu), formRow('높이', hh, hu), formRow('', keep.el), formRow('해상도', res, resU), formRow('', resample.el, method), noiseRow,
      h('div.note', '리샘플링을 끄면 픽셀은 그대로 두고 인쇄 크기와 해상도만 바뀝니다. 글자·모양 레이어는 크기 값만 바뀌어 선명하게 유지됩니다.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const W = clamp(Math.round(st.w), 1, 30000);
        const H = clamp(Math.round(st.h), 1, 30000);
        if (W * H > 120e6) {
          toast('너무 큰 크기입니다 (최대 약 1억 2천만 픽셀)');
          return false;
        }
        const r = Math.round(st.res * 100) / 100;
        if (W !== W0 || H !== H0) {
          P.resizeImage(W, H, method.value, { noise: +noise.value });
          // the resolution belongs to the same step (its "before" already holds the old one)
          if (P.doc) P.doc.resolution = r;
        } else if (r !== (doc.resolution || 72)) P.run('이미지 크기', () => { doc.resolution = r; });
        return true;
      },
    }],
  });
}

export function canvasSizeDialog(P) {
  const doc = P.doc;
  if (!doc) return;
  const W0 = doc.width;
  const H0 = doc.height;
  const ppi = doc.resolution || 72;
  const cur = h('div.note');
  const w = num(W0, -300000, 300000, 'any');
  const hh = num(H0, -300000, 300000, 'any');
  const wu = unitSel('px');
  const rel = chk(false, '상대치');
  let anchor = [1, 1];
  const ARROWS = { '-1,-1': '↖', '0,-1': '↑', '1,-1': '↗', '-1,0': '←', '1,0': '→', '-1,1': '↙', '0,1': '↓', '1,1': '↘' };
  const grid = h('div.ph-anchor', [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => {
    const b = h('button.small', { type: 'button', onclick: () => { anchor = [c, r]; paint(); }, 'aria-label': `기준점 ${r * 3 + c + 1}` }, '');
    b.dataset.c = c;
    b.dataset.r = r;
    return b;
  })));
  const paint = () => grid.querySelectorAll('button').forEach((b) => {
    const dc = +b.dataset.c - anchor[0];
    const dr = +b.dataset.r - anchor[1];
    b.textContent = !dc && !dr ? '●' : Math.abs(dc) <= 1 && Math.abs(dr) <= 1 ? ARROWS[`${dc},${dr}`] : '';
  });
  const isBg = doc.layers[0]?.kind === 'raster' && doc.layers[0]?.name === '배경';
  const ext = sel([['fg', '전경색'], ['bg', '배경색'], ['#ffffff', '흰색'], ['#000000', '검정'], ['#808080', '회색'], ['custom', '기타…']], 'bg');
  const extColor = h('input', { type: 'color', value: P.bg, hidden: true, 'aria-label': '확장 색' });
  ext.addEventListener('change', () => { extColor.hidden = ext.value !== 'custom'; });
  const showCur = () => {
    const u = wu.value === 'percent' ? 'px' : wu.value;
    const name = UNITS.find((x) => x[0] === u)[1];
    cur.textContent = `현재 크기: ${fmtSize(W0, H0)} · 폭 ${roundUnit(fromPx(W0, u, ppi, W0), u)} ${name} · 높이 ${roundUnit(fromPx(H0, u, ppi, H0), u)} ${name}`;
  };
  const target = () => {
    const u = wu.value;
    let nw = toPx(+w.value || 0, u, ppi, W0);
    let nh = toPx(+hh.value || 0, u, ppi, H0);
    if (rel.box.checked) {
      nw = u === 'percent' ? W0 + (W0 * (+w.value || 0)) / 100 : W0 + nw;
      nh = u === 'percent' ? H0 + (H0 * (+hh.value || 0)) / 100 : H0 + nh;
    }
    return [Math.round(nw), Math.round(nh)];
  };
  const refill = () => {
    const u = wu.value;
    if (rel.box.checked) {
      w.value = 0;
      hh.value = 0;
    } else {
      w.value = roundUnit(fromPx(W0, u, ppi, W0), u);
      hh.value = roundUnit(fromPx(H0, u, ppi, H0), u);
    }
    showCur();
  };
  wu.addEventListener('change', refill);
  rel.box.addEventListener('change', refill);
  paint();
  refill();
  openModal({
    title: '캔버스 크기',
    width: '460px',
    body: [cur, h('div.ph-sub', '새로운 크기'), formRow('폭', w, wu), formRow('높이', hh), formRow('', rel.el), formRow('기준', grid),
      formRow('캔버스 확장 색상', ext, extColor),
      h('div.note', isBg ? '늘어난 곳은 배경 레이어에서 확장 색상으로 칠해지고, 다른 레이어에서는 투명합니다.' : '배경 레이어가 없어 늘어난 곳은 투명합니다.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const [Wn, Hn] = target();
        const W = clamp(Wn, 1, 30000);
        const H = clamp(Hn, 1, 30000);
        if (W === W0 && H === H0) return true;
        P.cropTo({ x: Math.round(((W0 - W) * anchor[0]) / 2), y: Math.round(((H0 - H) * anchor[1]) / 2), w: W, h: H }, false, '캔버스 크기');
        const bl = P.doc?.layers[0];
        if (isBg && bl?.canvas && (W > W0 || H > H0)) {
          // the background layer gets the extension colour (same undo step as the resize)
          const col = ext.value === 'fg' ? P.fg : ext.value === 'bg' ? P.bg : ext.value === 'custom' ? extColor.value : ext.value;
          const c = makeCanvas(W, H);
          const g = c.getContext('2d');
          g.fillStyle = col;
          g.fillRect(0, 0, W, H);
          g.drawImage(bl.canvas, bl.x, bl.y);
          bl.canvas = c;
          bl.x = 0;
          bl.y = 0;
          bl._styled = null;
          P.doc.touch(bl);
          P.redraw();
        }
        return true;
      },
    }],
  });
}

// ---------------------------------------------------------------- param editors (shared by adjustments, filters and the properties panel)

// the editor API for editors opened without it (the Properties panel)
let apiP = null;
export const setPhotoApi = (P) => {
  apiP = P;
};

/**
 * A pick on the picture: the next click on the photo samples a colour (dialogs stay open; their
 * backdrop lets the click through), Esc or a click elsewhere cancels. cb([r, g, b] | null).
 */
let picking = null;
export function pickOnPicture(P, sampleAt, cb) {
  picking?.cancel();
  const stage = document.querySelector('.ph-stage');
  if (!P?.doc || !stage) return cb(null);
  // the dialog fades and lets clicks through while the picture is being sampled
  const backs = [...document.querySelectorAll('.modal-backdrop')];
  for (const b of backs) {
    b.style.pointerEvents = 'none';
    b.style.background = 'transparent';
    b.querySelectorAll(':scope > .modal').forEach((m) => {
      m.style.pointerEvents = 'none';
      m.style.opacity = '0.3';
    });
  }
  document.body.classList.add('ph-picking');
  const prevCursor = stage.style.cursor;
  stage.style.cursor = 'crosshair';
  const finish = (rgb) => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    for (const b of backs) {
      b.style.pointerEvents = '';
      b.style.background = '';
      b.querySelectorAll(':scope > .modal').forEach((m) => {
        m.style.pointerEvents = '';
        m.style.opacity = '';
      });
    }
    document.body.classList.remove('ph-picking');
    stage.style.cursor = prevCursor;
    picking = null;
    cb(rgb);
  };
  const onDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    if (!stage.contains(e.target)) return finish(null);
    const pt = P.toDoc(e.clientX, e.clientY);
    let rgb = null;
    try {
      rgb = sampleAt(Math.floor(pt.x), Math.floor(pt.y));
    } catch {
      rgb = null;
    }
    return finish(rgb);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish(null);
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  picking = { cancel: () => finish(null) };
  toast('그림에서 샘플링할 곳을 누르세요 (Esc: 취소)');
  return undefined;
}

/** Average colour of a 3×3 spot of a canvas at (x, y) in its own pixels. */
function spot(c, x, y) {
  if (!c || x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
  const x0 = clamp(x - 1, 0, c.width - 1);
  const y0 = clamp(y - 1, 0, c.height - 1);
  const w = Math.min(3, c.width - x0);
  const hh = Math.min(3, c.height - y0);
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, hh).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : null;
}

/**
 * What adjustment editors look at: `source()` is the picture before the adjustment (histograms, Auto)
 * and `sampleAt(x, y)` reads it at document coordinates (eyedroppers). Defaults follow the active
 * layer: an adjustment layer looks at what is below it, an image layer at its own pixels.
 */
function makeEnv(P, { source = null, sampleAt = null, ctls = {} } = {}) {
  const api = P || apiP;
  const doc = api?.doc;
  let cached = null;
  const src = () => {
    if (cached) return cached;
    if (source) cached = source();
    else {
      const l = doc?.active;
      if (!doc) return null;
      if (l?.kind === 'raster' && l.canvas) cached = l.canvas;
      else cached = doc.flatten({ skipId: l?.kind === 'adjust' ? l.id : null, fg: api.fg, bg: api.bg });
    }
    return cached;
  };
  const at = sampleAt || ((x, y) => {
    const l = doc?.active;
    if (!source && l?.kind === 'raster' && l.canvas) return spot(l.canvas, x - l.x, y - l.y);
    return spot(src(), x, y);
  });
  return {
    P: api,
    histSource: src,
    hist: () => histOf(src()),
    sample: doc ? (cb) => pickOnPicture(api, at, cb) : null,
    ctl: (key) => ctls[key],
    ctls,
  };
}

/**
 * Controls for a params definition list [key, label, min, max, default, kind]. kind: 'bool' | 'color' |
 * 'curve' | 'gradient' | 'pattern' | 'blend' | 'kernel' | 'hidden' | [[value, label]…] (a select) | a
 * number (slider step) | the name of a custom editor (adjui.js). onChange(params, done).
 * `envOpts` tells custom editors what the picture is: { source, sampleAt } (see makeEnv); its `ctls`
 * object gets a setter per plain control (key → set(v)) so a caller can move them.
 */
export function paramEditors(defs, params, onChange, P = null, envOpts = {}) {
  ensureAdjStyle();
  const rows = [];
  let env = null;
  const getEnv = () => (env ||= makeEnv(P, envOpts));
  for (const [key, label, min, max, , kind] of defs) {
    if (kind === 'hidden') continue;
    if (typeof kind === 'string' && CUSTOM_EDITORS[kind]) {
      rows.push(...CUSTOM_EDITORS[kind](params, onChange, getEnv()));
      continue;
    }
    if (kind === 'bool') {
      const c = chk(!!params[key], label);
      c.box.addEventListener('change', () => {
        params[key] = c.box.checked;
        onChange(params, true);
      });
      getEnv().ctls[key] = (v) => { c.box.checked = !!v; };
      rows.push(h('div.ph-prow', c.el));
    } else if (kind === 'color') {
      const inp = h('input', { type: 'color', value: params[key] });
      inp.addEventListener('input', () => {
        params[key] = inp.value;
        onChange(params, false);
      });
      inp.addEventListener('change', () => onChange(params, true));
      const e = getEnv();
      const pick = e.sample ? h('button.small', {
        type: 'button', title: '그림에서 색 고르기 (스포이드)', 'aria-label': `${label}: 그림에서 색 고르기`,
        onclick: () => e.sample((rgb) => {
          if (!rgb) return;
          inp.value = `#${rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
          params[key] = inp.value;
          onChange(params, true);
        }),
      }, '스포이드') : null;
      e.ctls[key] = (v) => { inp.value = v; };
      rows.push(h('label.ph-prow', h('span', label), inp, pick));
    } else if (kind === 'kernel') {
      // a 5×5 grid of weights (Filter ▸ Other ▸ Custom)
      params[key] = Array.isArray(params[key]) && params[key].length === 25 ? params[key].slice() : Array.from({ length: 25 }, (_, i) => (i === 12 ? 1 : 0));
      const grid = h('div.ph-kernel', ...params[key].map((v, i) => {
        const inp = h('input', { type: 'number', step: 1, value: v, 'aria-label': `${Math.floor(i / 5) + 1}행 ${(i % 5) + 1}열` });
        inp.addEventListener('change', () => {
          params[key][i] = Number(inp.value) || 0;
          onChange(params, true);
        });
        return inp;
      }));
      rows.push(h('div.ph-prow.ph-kernelrow', h('span', label), grid));
    } else if (kind === 'curve') {
      rows.push(curveEditor(params[key], (pts, done) => {
        params[key] = pts;
        onChange(params, done);
      }));
    } else if (kind === 'gradient') {
      rows.push(h('div.ph-prow', h('span', label), gradientButton(P, params[key], (g) => {
        params[key] = g;
        onChange(params, true);
      })));
    } else if (kind === 'pattern' || kind === 'blend' || Array.isArray(kind)) {
      const opts = kind === 'pattern' ? listPatterns().map((p) => [p.id, p.name]) : kind === 'blend' ? BLEND_MODES.map(([id, n]) => [id, n]) : kind;
      const s2 = h('select', { 'aria-label': label }, opts.map(([v, t]) => h('option', { value: String(v) }, t)));
      s2.value = String(params[key]);
      s2.addEventListener('change', () => {
        const v0 = opts[0][0];
        params[key] = typeof v0 === 'number' ? +s2.value : typeof v0 === 'boolean' ? s2.value === 'true' : s2.value;
        onChange(params, true);
      });
      getEnv().ctls[key] = (v) => { s2.value = String(v); };
      rows.push(h('label.ph-prow', h('span', label), s2));
    } else {
      const step = typeof kind === 'number' ? kind : max - min > 20 ? 1 : 0.01;
      const r = h('input', { type: 'range', min, max, step, value: params[key] });
      const n = h('input.ph-num', { type: 'number', min, max, step, value: params[key] });
      const set = (v, done) => {
        params[key] = clamp(+v, min, max);
        r.value = params[key];
        n.value = params[key];
        onChange(params, done);
      };
      r.addEventListener('input', () => set(r.value, false));
      r.addEventListener('change', () => set(r.value, true));
      // dialogs' number boxes scrub (drag): follow them live, commit on change
      n.addEventListener('input', () => {
        if (n.value !== '' && Number.isFinite(+n.value)) set(n.value, false);
      });
      n.addEventListener('change', () => set(n.value, true));
      // drag on the label to change the value (Photoshop's scrubby sliders)
      const lab = h('span.ph-scrub', { title: '좌우로 끌어서 값 바꾸기' }, label);
      lab.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        lab.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const v0 = +params[key];
        let moved = false;
        const per = (max - min) / 300;
        const mv = (ev) => {
          const dx = ev.clientX - x0;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          const raw = v0 + dx * per * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
          set(Math.round(raw / step) * step, false);
        };
        const up = () => {
          lab.removeEventListener('pointermove', mv);
          lab.removeEventListener('pointerup', up);
          lab.removeEventListener('pointercancel', up);
          if (moved) set(params[key], true);
        };
        lab.addEventListener('pointermove', mv);
        lab.addEventListener('pointerup', up);
        lab.addEventListener('pointercancel', up);
      });
      getEnv().ctls[key] = (v) => {
        r.value = v;
        n.value = v;
      };
      rows.push(h('label.ph-prow', lab, r, n));
    }
  }
  return rows;
}

function gradientButton(P, gr, onChange) {
  const b = h('button.ph-gradbtn', { type: 'button', title: '그레이디언트 편집' });
  const paint = (g) => b.replaceChildren(gradientSwatch(g, 140, 18, P?.fg, P?.bg));
  paint(gr || GRADIENTS[0]);
  b.addEventListener('click', () => gradientEditor(P, gr || GRADIENTS[0], (g) => {
    gr = g;
    paint(g);
    onChange(g);
  }));
  return b;
}

/** A curves editor: click to add a point, drag to move, drag out or double-click a point to remove it. */
export function curveEditor(points, onChange, opts = {}) {
  ensureAdjStyle();
  const g = curvesGraph(points, onChange, opts);
  g.append(h('div.note', '누르면 점 추가 · 끌어서 이동 · 밖으로 끌거나 두 번 눌러 삭제'));
  return g;
}

// ---------------------------------------------------------------- destructive adjustment / filter with live preview

/** The selection as a mask the size of canvas `c` that stands for the active layer's pixels. */
export function selMaskFor(P, c) {
  const doc = P.doc;
  const l = doc?.active;
  if (!doc?.selection || !l?.canvas || !c) return null;
  const m = makeCanvas(c.width, c.height);
  const g = m.getContext('2d');
  g.scale(c.width / l.canvas.width, c.height / l.canvas.height);
  g.drawImage(doc.selection.canvas, -l.x, -l.y);
  return m;
}

// adjustments whose result at a pixel depends only on that pixel: a smaller copy previews them exactly
const PER_PIXEL = new Set(['brightness', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'bw', 'photoFilter', 'invert', 'posterize', 'threshold', 'gradientMap', 'desaturate', 'selectiveColor', 'channelMixer', 'replaceColor', 'colorLookup']);
// [x, y] parameters (percent of the layer) a filter dialog shows as pins on the picture
const POS_PAIRS = [['x', 'y'], ['x1', 'y1'], ['x2', 'y2'], ['fx', 'fy']];
// filters that look the same on a smaller copy (their sizes are relative to the picture)
const SCALE_FREE = new Set(['vignette', 'spherize', 'pinch', 'twirl', 'lensCorrection', 'polar', 'oil', 'depthBlur', 'skinSmoothing']);

/** A dialog that can be dragged by its title bar, to see the picture under it (as in Photoshop). */
function movable(modal) {
  const head = modal.querySelector('header');
  if (!head) return;
  head.style.cursor = 'move';
  head.style.touchAction = 'none';
  let at = [0, 0];
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const x0 = e.clientX - at[0];
    const y0 = e.clientY - at[1];
    const mv = (ev) => {
      // the title bar stays on the screen
      at = [clamp(ev.clientX - x0, -window.innerWidth / 2, window.innerWidth / 2), clamp(ev.clientY - y0, -window.innerHeight / 2 + 40, window.innerHeight / 2)];
      modal.style.translate = `${at[0]}px ${at[1]}px`;
    };
    const up = () => {
      head.removeEventListener('pointermove', mv);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
    };
    head.addEventListener('pointermove', mv);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
}

/**
 * Run `compute(baseCanvas, params)` live on the active layer (inside the selection), OK keeps it.
 * `proxy`: on a big layer, previews are computed at about screen resolution (what the view shows at
 * the current zoom) and only "확인" computes the full-size result. `box`: a 100% preview box in the
 * dialog (filters), with zoom buttons and dragging, like Photoshop's.
 */
function liveLayerDialog(P, { title, defs, params, compute, label, slow = false, record = null, proxy = false, box = false }) {
  const doc = P.doc;
  const l = doc.active;
  if (!l || l.kind !== 'raster' || !l.canvas) {
    toast('이미지(일반) 레이어를 선택하세요. 글자·모양 레이어는 레이어 ▸ 래스터화 후 쓸 수 있고, 조정은 "새 조정 레이어"로도 넣을 수 있습니다.');
    return;
  }
  const before = doc.capture();
  const base = l.canvas;
  const bx = l.x;
  const by = l.y;
  const status = h('div.note', '');
  let timer = null;
  let applied = false;
  let small = null;
  let result = null;
  const proxyScale = () => {
    const px = base.width * base.height;
    if (!proxy || px <= 3e6) return 1;
    return Math.min(1, Math.max(doc.view.zoom * (window.devicePixelRatio || 1), Math.sqrt(2.5e6 / px)));
  };
  // ---- the preview box: a window into the result at 100% (or another zoom), dragged to look around
  const boxC = box ? h('canvas.ph-fbox', { width: 240, height: 180, 'aria-label': '미리 보기 (끌어서 이동)' }) : null;
  const zoomLbl = h('span.mono', '100%');
  let bz = 1;
  let bc = { x: base.width / 2, y: base.height / 2 };
  const drawBox = () => {
    if (!boxC) return;
    const g = boxC.getContext('2d');
    g.fillStyle = '#26282d';
    g.fillRect(0, 0, boxC.width, boxC.height);
    const src = result || base;
    const sw = boxC.width / bz;
    const sh = boxC.height / bz;
    bc.x = clamp(bc.x, Math.min(sw / 2, base.width / 2), Math.max(base.width - sw / 2, base.width / 2));
    bc.y = clamp(bc.y, Math.min(sh / 2, base.height / 2), Math.max(base.height - sh / 2, base.height / 2));
    g.imageSmoothingEnabled = bz < 1;
    g.drawImage(src, bc.x - sw / 2, bc.y - sh / 2, sw, sh, 0, 0, boxC.width, boxC.height);
    zoomLbl.textContent = `${Math.round(bz * 100)}%`;
  };
  if (boxC) {
    let drag = null;
    boxC.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: bc.x, cy: bc.y };
      boxC.setPointerCapture(e.pointerId);
    });
    boxC.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = boxC.getBoundingClientRect();
      const k = boxC.width / r.width / bz;
      bc = { x: drag.cx - (e.clientX - drag.x) * k, y: drag.cy - (e.clientY - drag.y) * k };
      drawBox();
    });
    boxC.addEventListener('pointerup', () => { drag = null; });
  }
  const ZS = [0.25, 0.5, 1, 2, 4];
  const zoomBy = (d) => {
    const i = ZS.indexOf(bz);
    bz = ZS[clamp((i < 0 ? 2 : i) + d, 0, ZS.length - 1)];
    drawBox();
  };
  const boxRow = boxC ? h('div.ph-fboxwrap', boxC, h('div.inline', h('button.small', { type: 'button', title: '축소', onclick: () => zoomBy(-1) }, '−'), zoomLbl, h('button.small', { type: 'button', title: '확대', onclick: () => zoomBy(1) }, '+'))) : null;

  const pv = chk(true, '미리 보기');
  const preview = (full = false) => {
    try {
      const s = full ? 1 : proxyScale();
      let out;
      if (s < 0.95) {
        if (small?.s !== s) {
          const c = makeCanvas(Math.max(1, Math.round(base.width * s)), Math.max(1, Math.round(base.height * s)));
          const cg = c.getContext('2d');
          cg.imageSmoothingQuality = 'high';
          cg.drawImage(base, 0, 0, c.width, c.height);
          small = { s, canvas: c };
        }
        const r = compute(small.canvas, params);
        out = makeCanvas(base.width, base.height);
        const og = out.getContext('2d');
        og.imageSmoothingQuality = 'high';
        og.drawImage(r, 0, 0, base.width, base.height);
      } else out = compute(base, params);
      if (doc.selection) {
        // only inside the selection: original outside, result inside
        const g = out.getContext('2d');
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(doc.selection.canvas, -bx, -by);
        const mix = cloneCanvas(base);
        const mg = mix.getContext('2d');
        mg.globalCompositeOperation = 'destination-out';
        mg.drawImage(doc.selection.canvas, -bx, -by);
        mg.globalCompositeOperation = 'source-over';
        mg.drawImage(out, 0, 0);
        out = mix;
      }
      result = out;
      l.canvas = full || pv.box.checked ? out : base;
      l.x = bx;
      l.y = by;
      l._styled = null;
      doc.touch(l);
      P.redraw();
      drawBox();
      status.textContent = '';
    } catch (err) {
      status.textContent = String(err.message || err);
    }
  };
  const schedule = (now) => {
    clearTimeout(timer);
    const heavy = slow && proxyScale() >= 0.95;
    if (heavy) status.textContent = '미리 보기 계산 중…';
    timer = setTimeout(preview, now ? 0 : heavy ? 220 : 40);
  };
  pv.box.addEventListener('change', () => {
    l.canvas = pv.box.checked && result ? result : base;
    l._styled = null;
    doc.touch(l);
    P.redraw();
    if (pv.box.checked && !result) schedule(true);
  });
  // 창 숨기기 ▸ 원본 보기 (held): the layer as it was, then the preview again
  let held = null;
  const compare = (on) => {
    if (on && !held) {
      held = l.canvas;
      l.canvas = base;
    } else if (!on && held) {
      l.canvas = held;
      held = null;
    } else return;
    l._styled = null;
    doc.touch(l);
    P.redraw();
  };
  const sampleAt = (x, y) => spot(base, x - bx, y - by);
  const ctls = {};
  let placePins = null;
  const dlg = openModal({
    title,
    width: box ? '560px' : '460px',
    peek: true,
    compare,
    body: [...(boxRow ? [boxRow] : []), ...paramEditors(defs, params, () => { schedule(false); placePins?.(true); }, P, { source: () => base, sampleAt, ctls }), h('div.inline', pv.el), status],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        clearTimeout(timer);
        // set before the window closes: closing undoes the preview unless the result is kept
        applied = true;
        const finish = () => {
          preview(true);
          P.commit(label, before);
          if (record) P.recordStep?.({ ...record, params: structuredClone(params) });
        };
        // a big, slow result: say so before the work blocks the page
        if (slow && base.width * base.height > 4e6) {
          toast(`${label} 적용 중…`);
          setTimeout(finish, 30);
        } else finish();
      },
    }],
    onClose: () => {
      clearTimeout(timer);
      picking?.cancel();
      if (!applied) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  movable(dlg.modal);
  // ---- on the picture around the window: the filter's centres as pins to drag (Lens Flare, Lighting
  // Effects, Radial Blur, the Blur Gallery), and a click shows that spot in the preview box
  const back = dlg.modal.parentElement;
  // the window stays above the pins
  dlg.modal.style.position = 'relative';
  dlg.modal.style.zIndex = '1';
  const gate = (a) => (a.endsWith('2') && defs.some((d) => d[0] === 'two') ? () => !!params.two : () => true);
  const pins = POS_PAIRS.filter(([a, b]) => defs.some((d) => d[0] === a && d[2] === 0 && d[3] === 100) && defs.some((d) => d[0] === b))
    .map(([a, b], i, all) => ({ a, b, on: gate(a), el: h('div.ph-pin', { title: all.length > 1 ? `핀 ${i + 1} (끌어서 옮기기)` : '중심 (끌어서 옮기기)' }) }));
  const pinAt = (pin) => [bx + (base.width * params[pin.a]) / 100, by + (base.height * params[pin.b]) / 100];
  const toClient = (x, y) => {
    // the inverse of P.toDoc (the view may be zoomed, moved or turned)
    const o = P.toDoc(0, 0);
    const ex = P.toDoc(1, 0);
    const ey = P.toDoc(0, 1);
    const a = ex.x - o.x;
    const b = ey.x - o.x;
    const c = ex.y - o.y;
    const d = ey.y - o.y;
    const det = a * d - b * c || 1;
    return [(d * (x - o.x) - b * (y - o.y)) / det, (-c * (x - o.x) + a * (y - o.y)) / det];
  };
  let viewKey = '';
  placePins = (force = false) => {
    const o = P.toDoc(0, 0);
    const e = P.toDoc(1, 1);
    const key = `${o.x},${o.y},${e.x},${e.y}`;
    if (!force && key === viewKey) return;
    viewKey = key;
    for (const pin of pins) {
      pin.el.hidden = !pin.on();
      const [cx, cy] = toClient(...pinAt(pin));
      pin.el.style.left = `${cx}px`;
      pin.el.style.top = `${cy}px`;
    }
  };
  const movePin = (pin, e) => {
    const pt = P.toDoc(e.clientX, e.clientY);
    for (const [k, v] of [[pin.a, ((pt.x - bx) / base.width) * 100], [pin.b, ((pt.y - by) / base.height) * 100]]) {
      params[k] = clamp(Math.round(v), 0, 100);
      ctls[k]?.(params[k]);
    }
    placePins(true);
    schedule(false);
  };
  const dragPin = (pin, e) => {
    e.preventDefault();
    e.stopPropagation();
    pin.el.setPointerCapture(e.pointerId);
    const mv = (ev) => movePin(pin, ev);
    const up = () => {
      pin.el.removeEventListener('pointermove', mv);
      pin.el.removeEventListener('pointerup', up);
      pin.el.removeEventListener('pointercancel', up);
    };
    pin.el.addEventListener('pointermove', mv);
    pin.el.addEventListener('pointerup', up);
    pin.el.addEventListener('pointercancel', up);
  };
  for (const pin of pins) {
    pin.el.addEventListener('pointerdown', (e) => dragPin(pin, e));
    back.append(pin.el);
  }
  const stageAt = (e) => {
    const r = document.querySelector('.ph-stage')?.getBoundingClientRect();
    return e.target === back && r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
  };
  if (boxC || pins.length) {
    back.addEventListener('pointermove', (e) => {
      back.style.cursor = stageAt(e) ? 'crosshair' : '';
    });
    back.addEventListener('pointerdown', (e) => {
      if (!stageAt(e) || picking) return;
      const pt = P.toDoc(e.clientX, e.clientY);
      if (boxC) {
        bc = { x: pt.x - bx, y: pt.y - by };
        drawBox();
      }
      // the nearest pin jumps there and follows the drag
      const near = pins.filter((pin) => pin.on()).sort((p1, p2) => Math.hypot(...pinAt(p1).map((v, i) => v - [pt.x, pt.y][i])) - Math.hypot(...pinAt(p2).map((v, i) => v - [pt.x, pt.y][i])))[0];
      if (near) {
        movePin(near, e);
        dragPin(near, e);
      }
    });
  }
  if (pins.length) {
    // follow the view while it is zoomed or moved (the window hidden with H)
    const watch = () => {
      if (!back.isConnected) return;
      placePins();
      requestAnimationFrame(watch);
    };
    placePins(true);
    requestAnimationFrame(watch);
  }
  schedule(true);
}

export function adjustDialog(P, type) {
  const def = ADJUSTMENTS[type];
  if (!P.doc) return undefined;
  if (P.channelEdit?.('adjust', type)) return undefined; // an alpha channel / quick mask (selchan.js)
  if (maskDialog(P, 'adjust', type)) return undefined; // the layer mask / a smart object's filter mask
  const params = defaultParams(type);
  if (P.doc?.active?.kind === 'smart') return smartFilterDialog(P, `adj:${type}`, params);
  if (!visibleParams(def.params).length) {
    // instant adjustments (invert, desaturate, equalize)
    const doc = P.doc;
    const l = doc.active;
    if (!l || l.kind !== 'raster' || !l.canvas) return toast('이미지(일반) 레이어를 선택하세요');
    P.run(def.name, () => applyToLayer(P, (c) => adjustCanvas(c, type, params, P)));
    P.recordStep?.({ type: 'adjust', id: type, params });
    return undefined;
  }
  liveLayerDialog(P, { title: def.name, defs: def.params, params, label: def.name, compute: (c, p) => adjustCanvas(c, type, p, P), slow: P.doc.width * P.doc.height > 6e6 || type === 'shadowsHighlights', record: { type: 'adjust', id: type }, proxy: PER_PIXEL.has(type) });
  return undefined;
}

export function adjustCanvas(c, type, params, P = null) {
  const out = makeCanvas(c.width, c.height);
  const g = out.getContext('2d');
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  applyAdjustment(img, type, { ...params, _fg: params._fg || P?.fg || apiP?.fg, _bg: params._bg || P?.bg || apiP?.bg });
  g.putImageData(img, 0, 0);
  return out;
}

/** Replace the active layer's pixels with fn(canvas), limited to the selection. Raw (inside a run). */
export function applyToLayer(P, fn) {
  const doc = P.doc;
  const l = doc.active;
  const base = l.canvas;
  const out = fn(base);
  if (doc.selection) {
    const g = out.getContext('2d');
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(doc.selection.canvas, -l.x, -l.y);
    const mix = cloneCanvas(base);
    const mg = mix.getContext('2d');
    mg.globalCompositeOperation = 'destination-out';
    mg.drawImage(doc.selection.canvas, -l.x, -l.y);
    mg.globalCompositeOperation = 'source-over';
    mg.drawImage(out, 0, 0);
    l.canvas = mix;
  } else l.canvas = out;
  l._styled = null;
  doc.touch(l);
}

// ---------------------------------------------------------------- a mask as the target

// adjustments that mean something on a grey mask (Photoshop greys out the colour ones there)
const MASK_ADJ = new Set(['levels', 'curves', 'brightness', 'exposure', 'invert', 'posterize', 'threshold', 'equalize', 'shadowsHighlights']);

/** A mask canvas (its alpha is the value) as an opaque grey picture, and back. */
function maskToGrey(c) {
  const img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = d[i + 3];
    d[i + 3] = 255;
  }
  const out = makeCanvas(c.width, c.height);
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
}
function greyToMask(c) {
  const img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
  const out = makeCanvas(c.width, c.height);
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
}

/** The new mask `out` kept only inside the selection; outside, the old values of `orig` stay. */
function maskInSelection(P, mt, orig, out) {
  const sel = P.doc.selection?.canvas;
  if (!sel) return out;
  const keep = cloneCanvas(orig);
  const kg = keep.getContext('2d');
  kg.globalCompositeOperation = 'destination-out';
  kg.drawImage(sel, -mt.x, -mt.y);
  const g = out.getContext('2d');
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(sel, -mt.x, -mt.y);
  // both are amounts in alpha: they add up
  g.globalCompositeOperation = 'lighter';
  g.drawImage(keep, 0, 0);
  g.globalCompositeOperation = 'source-over';
  return out;
}

/** The mask being painted (P.maskTarget) gets a private canvas; returns its writer. Raw. */
function maskWriter(P, mt) {
  const g = mt.edit();
  return (c) => {
    g.globalCompositeOperation = 'copy';
    g.drawImage(c, 0, 0);
    g.globalCompositeOperation = 'source-over';
    if (mt.kind === 'layer' || mt.kind === 'filter') P.doc.touch(P.doc.active);
    P.doc.rev++;
  };
}

const maskName = (mt) => ({ layer: '레이어 마스크', filter: '고급 필터 마스크', quick: '빠른 마스크' })[mt.kind] || '알파 채널';
const runOn = (kind, id, c, p, P) => (kind === 'adjust' ? adjustCanvas(c, id, p, P) : applyFilter(c, id, p, { fg: P.fg, bg: P.bg }));

/**
 * Image ▸ Adjustments and filters with the layer mask (or a smart object's filter mask) targeted
 * work on the mask as a grey picture, as in Photoshop (Ctrl+I inverts the mask, Gaussian Blur
 * softens it…). Alpha channels and the quick mask go through P.channelEdit first (selchan.js).
 * Returns true when it took over.
 */
function maskDialog(P, kind, id) {
  const mt = P.maskTarget?.();
  if (!mt || (mt.kind !== 'layer' && mt.kind !== 'filter')) return false;
  const def = kind === 'adjust' ? ADJUSTMENTS[id] : FILTERS[id];
  if (!def) return false;
  const name = maskName(mt);
  if ((kind === 'adjust' && !MASK_ADJ.has(id)) || (kind === 'filter' && (def.dialog || def.neural))) {
    toast(`${def.name}은(는) ${name}에 쓸 수 없습니다. 레벨·곡선·반전·흐림 효과 등을 쓰거나, 레이어 패널에서 레이어 썸네일을 눌러 그림으로 돌아가세요.`);
    return true;
  }
  const doc = P.doc;
  const label = `${def.name} (${name})`;
  const params = kind === 'adjust' ? defaultParams(id) : randomize(id, lastFilter?.id === id ? structuredClone(lastFilter.params) : defaultFilterParams(id));
  const remember = () => {
    if (kind === 'filter') lastFilter = { id, params: structuredClone(params) };
  };
  const before = doc.capture();
  const orig = mt.canvas;
  const write = maskWriter(P, mt);
  const full = (p) => maskInSelection(P, mt, orig, greyToMask(runOn(kind, id, maskToGrey(orig), p, P)));
  if (!visibleParams(def.params).length) {
    write(full(params));
    P.commit(label, before);
    remember();
    return true;
  }
  // previews of a big mask are worked out on a smaller copy
  const k = Math.min(1, Math.sqrt(1.5e6 / (orig.width * orig.height)));
  let grey = null;
  const small = () => {
    if (grey) return grey;
    const c = makeCanvas(Math.max(1, Math.round(orig.width * k)), Math.max(1, Math.round(orig.height * k)));
    c.getContext('2d').drawImage(orig, 0, 0, c.width, c.height);
    grey = maskToGrey(c);
    return grey;
  };
  let timer = 0;
  let ok = false;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        if (k >= 1) return write(full(params));
        const r = greyToMask(runOn(kind, id, small(), params, P));
        const out = makeCanvas(orig.width, orig.height);
        const og = out.getContext('2d');
        og.imageSmoothingQuality = 'high';
        og.drawImage(r, 0, 0, out.width, out.height);
        write(maskInSelection(P, mt, orig, out));
      } catch (err) {
        toast(String(err.message || err));
      }
      P.redraw();
    }, 40);
  };
  const controls = paramEditors(def.params, params, preview, P, { source: () => maskToGrey(orig), sampleAt: (x, y) => spot(maskToGrey(orig), x - mt.x, y - mt.y) });
  // the editors' channel pickers (RGB / 빨강 / 녹색 / 파랑) offer only the mask, as in Photoshop
  for (const c of controls) {
    for (const s of c.querySelectorAll?.('select') || []) {
      const v = [...s.options].map((o) => o.value);
      if (v.length === 4 && v[1] === 'r' && v[2] === 'g' && v[3] === 'b') {
        s.options[0].textContent = name;
        while (s.options.length > 1) s.remove(1);
      }
    }
  }
  const dlg = openModal({
    title: `${def.name} — ${name}`,
    width: '460px',
    peek: true,
    body: [...controls, h('div.note', `${name}에 적용합니다 (흰색 = 보임, 검정 = 숨김). 그림에 쓰려면 레이어 패널에서 레이어 썸네일을 누르세요.`)],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        clearTimeout(timer);
        ok = true;
        write(full(params));
        P.commit(label, before);
        remember();
      },
    }],
    onClose: () => {
      clearTimeout(timer);
      picking?.cancel();
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  movable(dlg.modal);
  preview();
  return true;
}

/** Ctrl+F on any mask being painted (layer mask, filter mask, alpha channel, quick mask). */
function repeatOnMask(P, mt, id, params) {
  const f = FILTERS[id];
  if (f.dialog || f.neural) return toast(`${f.name}은(는) ${maskName(mt)}에 쓸 수 없습니다`);
  const before = P.doc.capture();
  const orig = mt.canvas;
  maskWriter(P, mt)(maskInSelection(P, mt, orig, greyToMask(runOn('filter', id, maskToGrey(orig), params, P))));
  P.commit(`${f.name} (${maskName(mt)})`, before);
  P.emit('channels');
  return undefined;
}

let lastFilter = null;
export const lastFilterInfo = () => lastFilter;
/** Filters with windows of their own (Camera Raw, the Filter Gallery) become Ctrl+F's filter too. */
export const setLastFilter = (id, params) => {
  lastFilter = { id, params: structuredClone(params) };
};
/** A filter's own window, if it has one (Camera Raw, the Filter Gallery). */
const ownDialog = (P, id, params, extra = {}) => {
  if (FILTERS[id]?.dialog === 'camraw') {
    cameraRawDialog(P, { params, ...extra });
    return true;
  }
  if (FILTERS[id]?.dialog === 'gallery' && P.cmd.filterGallery) {
    P.cmd.filterGallery();
    return true;
  }
  return false;
};
const randomize = (id, params) => {
  if (FILTERS[id]?.random) params.seed = 1 + Math.floor(Math.random() * 1e6);
  return params;
};

export function filterDialog(P, id) {
  const f = FILTERS[id];
  if (!f || !P.doc) return undefined;
  if (P.channelEdit?.('filter', id)) return undefined; // an alpha channel / quick mask (selchan.js)
  if (maskDialog(P, 'filter', id)) return undefined; // the layer mask / a smart object's filter mask
  const params = randomize(id, lastFilter?.id === id ? structuredClone(lastFilter.params) : defaultFilterParams(id));
  if (ownDialog(P, id, lastFilter?.id === id ? lastFilter.params : null)) return undefined;
  if (P.doc?.active?.kind === 'smart') return smartFilterDialog(P, id, params);
  const run = (c, p) => applyFilter(c, id, p, { fg: P.fg, bg: P.bg, mask: selMaskFor(P, c) });
  const remember = () => { lastFilter = { id, params: structuredClone(params) }; };
  if (!visibleParams(f.params).length) {
    const l = P.doc.active;
    if (!l || l.kind !== 'raster' || !l.canvas) return toast('이미지(일반) 레이어를 선택하세요');
    const go = () => {
      P.run(f.name, () => applyToLayer(P, (c) => run(c, params)));
      remember();
      P.recordStep?.({ type: 'filter', id, params: structuredClone(params) });
    };
    if (f.slow && l.canvas.width * l.canvas.height > 4e6) {
      toast(`${f.name} 적용 중…`);
      setTimeout(go, 30);
    } else go();
    return undefined;
  }
  const big = P.doc.width * P.doc.height;
  liveLayerDialog(P, { title: f.name, defs: f.params, params, label: f.name, record: { type: 'filter', id }, compute: (c, p) => { remember(); return run(c, p); }, slow: big > 2e6 || !!f.slow || ['median', 'motion', 'twirl', 'spherize', 'pinch', 'wave', 'edges', 'emboss'].includes(id), proxy: SCALE_FREE.has(id), box: true });
  return undefined;
}

/** Ctrl+F: the last filter again with the same settings. */
export function repeatFilter(P) {
  if (!lastFilter) return toast('아직 적용한 필터가 없습니다');
  if (!P.doc) return undefined;
  const { id } = lastFilter;
  const params = randomize(id, structuredClone(lastFilter.params));
  const mt = P.maskTarget?.();
  if (mt) return repeatOnMask(P, mt, id, params);
  if (P.doc?.active?.kind === 'smart') {
    const l = P.doc.active;
    P.run(`고급 필터: ${FILTERS[id].name}`, () => { l.smart = { ...l.smart, filters: [...(l.smart.filters || []), { id, params: { ...params, _fg: P.fg, _bg: P.bg }, enabled: true }] }; P.doc.touch(l); });
    return undefined;
  }
  const l = P.doc.active;
  if (!l || l.kind !== 'raster' || !l.canvas) return toast('이미지(일반) 레이어를 선택하세요');
  const go = () => {
    P.run(FILTERS[id].name, () => applyToLayer(P, (c) => applyFilter(c, id, params, { fg: P.fg, bg: P.bg, mask: selMaskFor(P, c) })));
    P.recordStep?.({ type: 'filter', id, params: structuredClone(params) });
  };
  if (l.canvas.width * l.canvas.height > 4e6 && FILTERS[id].slow) {
    toast(`${FILTERS[id].name} 적용 중…`);
    setTimeout(go, 30);
  } else go();
  return undefined;
}

/** Ctrl+Alt+F: the last filter's window again, with its settings. */
export function lastFilterDialog(P) {
  if (!lastFilter) return toast('아직 적용한 필터가 없습니다');
  return filterDialog(P, lastFilter.id);
}

// ---------------------------------------------------------------- smart filters

export const filterName = (id) => (id.startsWith('adj:') ? ADJUSTMENTS[id.slice(4)]?.name : FILTERS[id]?.name) || id;
const filterDefs = (id) => (id.startsWith('adj:') ? ADJUSTMENTS[id.slice(4)].params : FILTERS[id].params);

/** Add (index = null) or edit a smart filter on a smart object layer, with live preview. */
export function smartFilterDialog(P, id, params, index = null) {
  const doc = P.doc;
  const l = doc.active;
  if (!id.startsWith('adj:') && FILTERS[id]?.dialog === 'camraw') {
    cameraRawDialog(P, { params, smartIndex: index });
    return undefined;
  }
  const before = doc.capture();
  const defs = filterDefs(id);
  const list = [...(l.smart.filters || [])];
  const at = index ?? list.length;
  let entry = index != null ? { ...list[index] } : { id, params: { ...params }, enabled: true };
  const p = structuredClone(entry.params);
  const apply = () => {
    entry = { ...entry, params: { ...p, _fg: P.fg, _bg: P.bg } };
    const fl = [...list];
    fl[at] = entry;
    l.smart = { ...l.smart, filters: fl };
    doc.touch(l);
    P.redraw();
  };
  if (!visibleParams(defs).length) {
    P.run(`고급 필터: ${filterName(id)}`, apply);
    return undefined;
  }
  let timer = null;
  let ok = false;
  const op = { opacity: Math.round((entry.opacity ?? 1) * 100) };
  // the smart object's own content before this filter: what eyedroppers and histograms look at
  const source = () => doc.rasterizeLayer(l);
  const dlg = openModal({
    title: `고급 필터: ${filterName(id)}`,
    width: '460px',
    body: [...paramEditors(defs, p, () => { clearTimeout(timer); timer = setTimeout(apply, 60); }, P, { source, sampleAt: (x, y) => spot(doc.flatten({ fg: P.fg, bg: P.bg }), x, y) }),
      ...paramEditors([['opacity', '불투명도 (%)', 0, 100, 100]], op, () => { entry.opacity = op.opacity / 100; clearTimeout(timer); timer = setTimeout(apply, 60); }, P),
      h('div.note', '고급 개체에 넣는 필터는 원본을 바꾸지 않습니다. 레이어 패널에서 끄거나 두 번 눌러 다시 고칠 수 있습니다.')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { clearTimeout(timer); apply(); ok = true; P.commit(`고급 필터: ${filterName(id)}`, before); } }],
    onClose: () => {
      clearTimeout(timer);
      picking?.cancel();
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  movable(dlg.modal);
  apply();
  return undefined;
}

// ---------------------------------------------------------------- gradient editor

/** Pick a preset or edit colour/opacity stops (drag them along the bar). onApply(gradient). */
export function gradientEditor(P, gr, onApply) {
  // Photoshop's full Gradient Editor (gradedit.js) when it is installed
  if (P?.gradientEditor) return P.gradientEditor(gr, onApply);
  let g = structuredClone(gr?.stops ? gr : GRADIENTS[0]);
  g.alphas ||= [{ pos: 0, a: 1 }, { pos: 1, a: 1 }];
  const bar = h('div.ph-gbar');
  const stopsC = h('div.ph-gstops.color');
  const stopsA = h('div.ph-gstops.alpha');
  const detail = h('div.ph-gdetail');
  let selected = { kind: 'c', i: 0 };
  const W = 360;
  const paint = () => {
    bar.replaceChildren(gradientSwatch(g, W, 26, P?.fg, P?.bg));
    const mk = (arr, kind, el) => {
      el.replaceChildren(...arr.map((s, i) => {
        const m = h(`button.ph-gstop${selected.kind === kind && selected.i === i ? '.on' : ''}`, { style: { left: `${s.pos * 100}%`, background: kind === 'c' ? resolveStopColor(s.color, P?.fg, P?.bg) : `rgba(0,0,0,${s.a})` }, 'aria-label': `${kind === 'c' ? '색' : '불투명도'} 정지점 ${Math.round(s.pos * 100)}%` });
        m.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          selected = { kind, i };
          m.setPointerCapture(e.pointerId);
          const r = el.getBoundingClientRect();
          const mv = (ev) => {
            s.pos = clamp((ev.clientX - r.left) / r.width, 0, 1);
            m.style.left = `${s.pos * 100}%`;
            bar.replaceChildren(gradientSwatch(g, W, 26, P?.fg, P?.bg));
          };
          const up = () => {
            m.removeEventListener('pointermove', mv);
            m.removeEventListener('pointerup', up);
            paint();
          };
          m.addEventListener('pointermove', mv);
          m.addEventListener('pointerup', up);
          paint();
        });
        return m;
      }));
    };
    mk(g.stops, 'c', stopsC);
    mk(g.alphas, 'a', stopsA);
    const arr = selected.kind === 'c' ? g.stops : g.alphas;
    const s = arr[Math.min(selected.i, arr.length - 1)];
    if (!s) return;
    const pos = h('input.ph-num', { type: 'number', min: 0, max: 100, value: Math.round(s.pos * 100) });
    pos.addEventListener('change', () => { s.pos = clamp(+pos.value / 100, 0, 1); paint(); });
    const del = h('button.small', { disabled: arr.length <= 2, onclick: () => { arr.splice(arr.indexOf(s), 1); selected.i = 0; paint(); } }, '정지점 삭제');
    if (selected.kind === 'c') {
      const col = h('input', { type: 'color', value: resolveStopColor(s.color, P?.fg, P?.bg) });
      col.addEventListener('input', () => { s.color = col.value; paint(); });
      detail.replaceChildren(h('label.ph-prow', h('span', '색'), col, h('button.small', { onclick: () => { s.color = 'fg'; paint(); } }, '전경색'), h('button.small', { onclick: () => { s.color = 'bg'; paint(); } }, '배경색')), h('label.ph-prow', h('span', '위치 (%)'), pos), del);
    } else {
      const a = h('input.ph-num', { type: 'number', min: 0, max: 100, value: Math.round(s.a * 100) });
      a.addEventListener('change', () => { s.a = clamp(+a.value / 100, 0, 1); paint(); });
      detail.replaceChildren(h('label.ph-prow', h('span', '불투명도 (%)'), a), h('label.ph-prow', h('span', '위치 (%)'), pos), del);
    }
  };
  // click the strips to add stops
  const addAt = (el, kind) => el.addEventListener('dblclick', (e) => {
    const r = el.getBoundingClientRect();
    const pos = clamp((e.clientX - r.left) / r.width, 0, 1);
    if (kind === 'c') g.stops.push({ pos, color: '#808080' });
    else g.alphas.push({ pos, a: 1 });
    selected = { kind, i: (kind === 'c' ? g.stops : g.alphas).length - 1 };
    paint();
  });
  addAt(stopsC, 'c');
  addAt(stopsA, 'a');
  const presets = h('div.ph-gpresets', GRADIENTS.map((pr) => h('button.ph-gpreset', { title: pr.name, onclick: () => { g = structuredClone(pr); g.alphas ||= [{ pos: 0, a: 1 }, { pos: 1, a: 1 }]; selected = { kind: 'c', i: 0 }; paint(); } }, gradientSwatch(pr, 64, 20, P?.fg, P?.bg))));
  paint();
  openModal({
    title: '그레이디언트 편집기',
    width: '440px',
    body: [h('div.ph-sub', '사전 설정'), presets, h('div.ph-sub', '불투명도 정지점 (위) · 색 정지점 (아래) — 끌어서 옮기고, 줄을 두 번 눌러 추가'), h('div.ph-gwrap', stopsA, bar, stopsC), detail,
      h('div.inline', h('button.small', { onclick: () => { g.stops = g.stops.map((s) => ({ ...s, pos: 1 - s.pos })); g.alphas = g.alphas.map((s) => ({ ...s, pos: 1 - s.pos })); paint(); } }, '좌우 뒤집기'))],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => onApply(structuredClone(g)) }],
  });
}

// ---------------------------------------------------------------- new fill layer

export function fillLayerDialog(P, type) {
  if (type === 'solid') {
    let color = P.fg;
    const picker = createColorPicker({ value: color, onChange: (v) => { color = v; } });
    openModal({
      title: '새 칠 레이어: 단색',
      width: '300px',
      body: [picker.el],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.cmd.newFillLayer({ type: 'solid', color }) }],
    });
    return;
  }
  if (type === 'gradient') {
    const p = { gradient: structuredClone(GRADIENTS[0]), style: 'linear', angle: 90, scale: 100, reverse: false };
    openModal({
      title: '새 칠 레이어: 그레이디언트',
      width: '420px',
      body: paramEditors([['gradient', '그레이디언트', null, null, null, 'gradient'], ['style', '스타일', null, null, 'linear', GRADIENT_STYLES], ['angle', '각도 (°)', -180, 180, 90], ['scale', '비율 (%)', 10, 150, 100], ['reverse', '반전', null, null, false, 'bool']], p, () => {}, P),
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.cmd.newFillLayer({ type: 'gradient', ...structuredClone(p), gradient: resolveGradient(p.gradient, P) }) }],
    });
    return;
  }
  const p = { pattern: 'checker', scale: 100 };
  openModal({
    title: '새 칠 레이어: 패턴',
    width: '380px',
    body: paramEditors([['pattern', '패턴', null, null, 'checker', 'pattern'], ['scale', '비율 (%)', 1, 1000, 100]], p, () => {}, P),
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.cmd.newFillLayer({ type: 'pattern', ...p }) }],
  });
}

/** Fill layers keep real colours (not "foreground") so they look the same later. */
function resolveGradient(g, P) {
  return { ...g, stops: g.stops.map((s) => ({ ...s, color: resolveStopColor(s.color, P.fg, P.bg) })) };
}

// ---------------------------------------------------------------- fill / stroke

export function fillDialog(P) {
  const what = sel([['fg', '전경색'], ['bg', '배경색'], ['custom', '색상…'], ['content', '내용 인식'], ['pattern', '패턴'], ['#000000', '검정'], ['#808080', '50% 회색'], ['#ffffff', '흰색']], 'fg');
  const color = h('input', { type: 'color', value: P.fg, hidden: true, 'aria-label': '색상' });
  const pat = sel(listPatterns().map((p) => [p.id, p.name]), listPatterns()[0]?.id || 'checker');
  const patRow = formRow('사용자 정의 패턴', pat);
  const mode = sel(BLEND_MODES.map(([id, n]) => [id, n]), 'normal');
  const op = num(100, 1, 100, 1, '70px');
  const keepAlpha = chk(!!P.doc?.active?.lockAlpha, '투명 영역 보존');
  const sync = () => {
    color.hidden = what.value !== 'custom';
    patRow.hidden = what.value !== 'pattern';
    const ca = what.value === 'content';
    mode.disabled = ca;
    op.disabled = ca;
  };
  what.addEventListener('change', sync);
  sync();
  openModal({
    title: '칠',
    width: '420px',
    body: [h('div.ph-sub', '내용'), formRow('내용', what, color), patRow, h('div.ph-sub', '혼합'), formRow('모드', mode), formRow('불투명도 (%)', op), formRow('', keepAlpha.el),
      h('div.note', P.doc.selection ? '선택 영역을 채웁니다.' : '선택 영역이 없어 레이어 전체를 채웁니다.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        if (what.value === 'content') return P.cmd.contentAwareFill();
        const alpha = clamp(+op.value / 100, 0.01, 1);
        const c = what.value === 'fg' ? P.fg : what.value === 'bg' ? P.bg : what.value === 'custom' ? color.value : what.value;
        const doc = P.doc;
        const l = doc.active;
        const plain = mode.value === 'normal' && what.value !== 'pattern' && !keepAlpha.box.checked;
        // a plain colour fill (also into masks and quick mask): the editor's own fill
        if (plain || P.maskTarget?.() || !l || l.kind !== 'raster' || !l.canvas) {
          if (what.value === 'pattern') return toast('패턴 칠은 이미지(일반) 레이어에 쓸 수 있습니다');
          P.fill(c, alpha);
          return undefined;
        }
        P.run('칠', () => applyToLayer(P, (base) => {
          // the fill as its own layer the size of the layer canvas, blended onto it
          const f = what.value === 'pattern' ? paintPattern(base.width, base.height, pat.value, 100, l.x, l.y) : (() => {
            const t = makeCanvas(base.width, base.height);
            const tg = t.getContext('2d');
            tg.fillStyle = c;
            tg.fillRect(0, 0, t.width, t.height);
            return t;
          })();
          const out = cloneCanvas(base);
          const g = out.getContext('2d');
          if (keepAlpha.box.checked && mode.value === 'normal') {
            g.globalAlpha = alpha;
            g.globalCompositeOperation = 'source-atop';
            g.drawImage(f, 0, 0);
            return out;
          }
          compositeOnto(g, f, 0, 0, mode.value, alpha);
          if (keepAlpha.box.checked) {
            // only where the layer already has pixels, with their opacity
            g.globalCompositeOperation = 'destination-in';
            g.drawImage(base, 0, 0);
            g.globalCompositeOperation = 'source-over';
          }
          return out;
        }));
        return undefined;
      },
    }],
  });
}

export function strokeDialog(P) {
  if (!P.doc.selection) return toast('먼저 선택 영역을 만드세요');
  const width = num(4, 1, 200);
  const color = h('input', { type: 'color', value: P.fg });
  const pos = sel([['outside', '바깥쪽'], ['center', '가운데'], ['inside', '안쪽']], 'center');
  openModal({
    title: '획 (선택 영역 테두리 그리기)',
    width: '400px',
    body: [formRow('두께 (px)', width), formRow('색', color), formRow('위치', pos)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.strokeSelection(+width.value, color.value, pos.value) }],
  });
  return undefined;
}

// ---------------------------------------------------------------- export / send to video

export function exportDialog(P) {
  const doc = P.doc;
  const type = sel(EXPORT_TYPES.map(([id, t]) => [id, t]), 'png');
  const q = h('input', { type: 'range', min: 0.3, max: 1, step: 0.01, value: 0.9 });
  const qv = h('span', '90%');
  q.addEventListener('input', () => { qv.textContent = `${Math.round(q.value * 100)}%`; });
  const scale = sel([[1, '원래 크기'], [0.5, '50%'], [0.25, '25%'], [2, '200%']], 1);
  const name = h('input', { type: 'text', value: doc.name, style: { width: '100%' } });
  const qRow = formRow('화질', q, qv);
  const sync = () => { qRow.hidden = type.value === 'png'; };
  type.addEventListener('change', sync);
  sync();
  openModal({
    title: '내보내기 (이미지 파일로 저장)',
    width: '440px',
    body: [formRow('파일 이름', name), formRow('형식', type), qRow, formRow('크기', scale), h('div.note', `${doc.width} × ${doc.height} px · 보이는 레이어를 합쳐 저장합니다.`)],
    buttons: [{ label: '취소' }, { label: '저장', primary: true, action: () => P.exportImage(name.value.trim() || doc.name, type.value, +q.value, +scale.value) }],
  });
}

export function sendToVideoDialog(P) {
  const doc = P.doc;
  const replace = chk(false, '영상 타임라인에서 원래 이미지를 쓰던 클립도 이 이미지로 바꾸기');
  if (!doc.sourceMediaId) replace.box.disabled = true;
  openModal({
    title: '영상 편집으로 보내기',
    width: '460px',
    body: [
      h('div.note', '보이는 레이어를 합친 PNG를 영상 프로젝트의 미디어(프로젝트 패널)에 새 이미지로 넣습니다.'),
      doc.sourceMediaId ? replace.el : h('div.note', '이 문서는 영상 프로젝트의 이미지에서 연 것이 아니어서 새 이미지로만 넣을 수 있습니다.'),
    ],
    buttons: [{ label: '취소' }, { label: '보내기', primary: true, action: () => P.sendToVideo({ replace: replace.box.checked }) }],
  });
}
