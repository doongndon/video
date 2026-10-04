// Select and Mask: a workspace to refine the selection's edge (radius / smart radius, smooth,
// feather, contrast, shift edge, decontaminate colours) with the quick selection, refine edge and
// plain brushes, several view modes, and output to a selection, mask, new layer or new document.
// The preview runs at a reduced size; the output is computed at full size.

import { h, clamp } from '../util.js';
import { toast, openModal, loadPref, savePref } from '../ui/common.js';
import { makeCanvas, cloneCanvas, newLayer, PhotoDoc } from './doc.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';

const VIEWS = [['onion', '어니언 스킨'], ['ants', '개미 행렬'], ['overlay', '오버레이'], ['black', '검정 바탕'], ['white', '흰색 바탕'], ['bw', '흑백'], ['layers', '레이어 위']];
const OUTPUTS = [['selection', '선택 영역'], ['mask', '레이어 마스크'], ['layer', '새 레이어'], ['layerMask', '레이어 마스크가 있는 새 레이어'], ['doc', '새 문서'], ['docMask', '레이어 마스크가 있는 새 문서']];
const DEFAULTS = { view: 'onion', opacity: 50, radius: 0, smart: false, smooth: 0, feather: 0, contrast: 0, shift: 0, decon: false, deconAmount: 50, output: 'selection', sampleAll: true, remember: false, tool: 'refine', size: 40 };

export function selectAndMaskDialog(P) {
  const doc = P.doc;
  if (!doc) return;
  if (P.transform) P.applyTransform();
  const W = doc.width;
  const H = doc.height;
  const saved = loadPref('photo.sam', null);
  const o = { ...DEFAULTS, ...(saved?.remember ? saved : {}) };
  const base = makeCanvas(W, H);
  if (doc.selection) base.getContext('2d').drawImage(doc.selection.canvas, 0, 0);
  const brushC = makeCanvas(W, H);
  let src = null;
  let srcPx = null;
  const ps = Math.min(1, 820 / W, 600 / H);
  const pw = Math.max(1, Math.round(W * ps));
  const ph = Math.max(1, Math.round(H * ps));
  let smallPx = null;
  let smallImg = null;
  const loadSource = () => {
    src = o.sampleAll ? P.composite() : P.layerAsDocCanvas(doc.active);
    srcPx = null;
    smallImg = makeCanvas(pw, ph);
    const g = smallImg.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, pw, ph);
    smallPx = g.getImageData(0, 0, pw, ph).data;
  };
  loadSource();

  // ---------------------------------------------------------------- preview
  const view = h('canvas.ph-samview', { width: pw, height: ph });
  const scaledAlpha = (c) => {
    const t = makeCanvas(pw, ph);
    const g = t.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, pw, ph);
    return SX.alphaOf(t);
  };
  let result = null;
  const compute = () => {
    const a0 = scaledAlpha(base);
    const b = scaledAlpha(brushC);
    const brush = Uint8Array.from(b, (v) => (v > 0.3 ? 1 : 0));
    const r = SX.refineAlpha(smallPx, pw, ph, a0, {
      radius: o.radius * ps, smart: o.smart, brush, smooth: o.smooth, feather: o.feather * ps, contrast: o.contrast, shift: o.shift,
      decontaminate: o.decon ? o.deconAmount : 0, scale: ps,
    });
    result = { a0, ...r };
  };
  let checker = null;
  const render = () => {
    if (!result) return;
    const g = view.getContext('2d');
    const a = showOrig.checked ? result.a0 : result.alpha;
    const T = o.opacity / 100;
    const img = g.createImageData(pw, ph);
    const d = img.data;
    const px = smallPx;
    const fg = !showOrig.checked && o.decon ? result.fg : null;
    const amt = o.deconAmount / 100;
    if (!checker) {
      checker = new Uint8Array(pw * ph);
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) checker[y * pw + x] = ((x >> 3) + (y >> 3)) & 1 ? 255 : 204;
    }
    for (let i = 0; i < pw * ph; i++) {
      const p = i * 4;
      let r = px[p];
      let gg = px[p + 1];
      let b = px[p + 2];
      const al = a[i];
      if (fg && al < 0.995) {
        r += (fg[i * 3] - r) * amt;
        gg += (fg[i * 3 + 1] - gg) * amt;
        b += (fg[i * 3 + 2] - b) * amt;
      }
      const layerA = px[p + 3] / 255;
      let bgc;
      switch (o.view) {
        case 'bw':
          d[p] = d[p + 1] = d[p + 2] = al * 255;
          d[p + 3] = 255;
          continue;
        case 'overlay': {
          const m = (1 - al) * T;
          d[p] = r * (1 - m) + 255 * m;
          d[p + 1] = gg * (1 - m);
          d[p + 2] = b * (1 - m);
          d[p + 3] = 255;
          continue;
        }
        case 'ants':
          d[p] = r;
          d[p + 1] = gg;
          d[p + 2] = b;
          d[p + 3] = 255;
          continue;
        case 'black':
          bgc = [0, 0, 0];
          break;
        case 'white':
          bgc = [255, 255, 255];
          break;
        default:
          bgc = [checker[i], checker[i], checker[i]];
      }
      // unselected areas fade by the transparency setting ('on layers' hides them)
      const k = (o.view === 'layers' ? al : al + (1 - al) * (1 - T)) * layerA;
      d[p] = bgc[0] + (r - bgc[0]) * k;
      d[p + 1] = bgc[1] + (gg - bgc[1]) * k;
      d[p + 2] = bgc[2] + (b - bgc[2]) * k;
      d[p + 3] = 255;
    }
    if (o.view === 'ants' || showEdge.checked) {
      // the selection edge (ants view) or the area being refined (show edge)
      for (let y = 1; y < ph - 1; y++) {
        for (let x = 1; x < pw - 1; x++) {
          const i = y * pw + x;
          const p = i * 4;
          if (showEdge.checked && a[i] > 0.02 && a[i] < 0.98) {
            d[p] = d[p] * 0.4;
            d[p + 1] = d[p + 1] * 0.4 + 150;
            d[p + 2] = d[p + 2] * 0.4 + 150;
          }
          if (o.view === 'ants') {
            const inside = a[i] >= 0.5;
            if (inside && (a[i - 1] < 0.5 || a[i + 1] < 0.5 || a[i - pw] < 0.5 || a[i + pw] < 0.5)) {
              const on = ((x + y) >> 2) & 1;
              d[p] = d[p + 1] = d[p + 2] = on ? 255 : 0;
            }
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
  };
  let pending = 0;
  const update = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      compute();
      render();
    });
  };

  // ---------------------------------------------------------------- brushes on the preview
  let sub = false;
  const toolBtns = [['quick', '빠른 선택'], ['refine', '가장자리 다듬기 브러시'], ['brush', '브러시']].map(([id, label]) => {
    const b = h('button.small.ph-tog', { onclick: () => { o.tool = id; toolBtns.forEach((x) => x.classList.toggle('on', x === b)); } }, label);
    if (o.tool === id) b.classList.add('on');
    return b;
  });
  const modeBtn = h('button.small.ph-tog', { title: '더하기 / 빼기 (Alt를 누르고 칠해도 빼기)', onclick: () => { sub = !sub; modeBtn.textContent = sub ? '－ 빼기' : '＋ 더하기'; modeBtn.classList.toggle('on', sub); } }, '＋ 더하기');
  const size = h('input', { type: 'range', min: 2, max: 300, value: o.size, 'aria-label': '브러시 크기' });
  size.addEventListener('input', () => { o.size = +size.value; });
  let stroke = null;
  const docPt = (e) => {
    const r = view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, k: W / r.width };
  };
  const dab = (p) => {
    const rad = (o.size / 2) * p.k;
    const neg = stroke.sub;
    if (o.tool === 'quick') {
      if (!srcPx) srcPx = SX.pixelsOf(src);
      if (!stroke.qs) stroke.qs = new SX.QuickSelector(srcPx, W, H);
      const box = stroke.qs.dab(p.x, p.y, rad);
      if (!box) return;
      const img = new ImageData(box.w, box.h);
      for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) if (stroke.qs.mask[(y + box.y) * W + x + box.x]) img.data[(y * box.w + x) * 4 + 3] = 255;
      const t = makeCanvas(box.w, box.h);
      t.getContext('2d').putImageData(img, 0, 0);
      const g = base.getContext('2d');
      g.globalCompositeOperation = neg ? 'destination-out' : 'source-over';
      g.drawImage(t, box.x, box.y);
      g.globalCompositeOperation = 'source-over';
      return;
    }
    const g = (o.tool === 'refine' ? brushC : base).getContext('2d');
    g.globalCompositeOperation = neg ? 'destination-out' : 'source-over';
    g.fillStyle = '#000';
    g.beginPath();
    g.arc(p.x, p.y, rad, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  };
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId);
    const p = docPt(e);
    stroke = { last: p, sub: sub || e.altKey };
    dab(p);
    update();
  });
  view.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = docPt(e);
    const step = Math.max(1, (o.size / 4) * p.k);
    const len = Math.hypot(p.x - stroke.last.x, p.y - stroke.last.y);
    for (let t = step; t <= len; t += step) dab({ x: stroke.last.x + ((p.x - stroke.last.x) * t) / len, y: stroke.last.y + ((p.y - stroke.last.y) * t) / len, k: p.k });
    if (len >= step) stroke.last = p;
    update();
  });
  const end = () => {
    stroke = null;
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);

  // ---------------------------------------------------------------- settings
  const num = (key, label, min, max, step = 1, unit = '') => {
    const r = h('input', { type: 'range', min, max, step, value: o[key] });
    const n = h('input.ph-num', { type: 'number', min, max, step, value: o[key], style: { width: '64px' } });
    const set = (v) => {
      o[key] = clamp(+v || 0, min, max);
      r.value = o[key];
      n.value = o[key];
      update();
    };
    r.addEventListener('input', () => set(r.value));
    n.addEventListener('change', () => set(n.value));
    return h('div.ph-samrow', h('label', label), h('div.inline', r, n, unit ? h('small', unit) : null));
  };
  const check = (key, label, after) => {
    const c = h('input', { type: 'checkbox', checked: !!o[key] });
    c.addEventListener('change', () => {
      o[key] = c.checked;
      after?.();
      update();
    });
    return h('label.ph-samchk', c, ` ${label}`);
  };
  const viewSel = h('select', ...VIEWS.map(([v, t]) => h('option', { value: v }, t)));
  viewSel.value = o.view;
  viewSel.addEventListener('change', () => {
    o.view = viewSel.value;
    if (!saved?.remember) o.opacity = ['onion', 'overlay'].includes(o.view) ? 50 : 100;
    opRow.querySelector('input[type=range]').value = o.opacity;
    opRow.querySelector('input[type=number]').value = o.opacity;
    render();
  });
  const opRow = num('opacity', '투명도', 0, 100, 1, '%');
  const showEdge = h('input', { type: 'checkbox' });
  const showOrig = h('input', { type: 'checkbox' });
  showEdge.addEventListener('change', render);
  showOrig.addEventListener('change', render);
  const outSel = h('select', ...OUTPUTS.map(([v, t]) => h('option', { value: v }, t)));
  outSel.value = o.output;
  const syncOut = () => {
    // decontaminated colours need pixels of their own (Photoshop does the same)
    for (const opt of outSel.options) opt.disabled = o.decon && (opt.value === 'selection' || opt.value === 'mask');
    if (o.decon && (outSel.value === 'selection' || outSel.value === 'mask')) outSel.value = 'layerMask';
    o.output = outSel.value;
  };
  outSel.addEventListener('change', syncOut);
  const side = h('div.ph-samside',
    h('h4', '보기 모드'),
    h('div.ph-samrow', h('label', '보기'), viewSel),
    opRow,
    h('div.inline', h('label.ph-samchk', showEdge, ' 가장자리 표시'), h('label.ph-samchk', showOrig, ' 원본 표시')),
    h('h4', '가장자리 감지'),
    num('radius', '반경', 0, 250, 1, 'px'),
    check('smart', '고급 반경'),
    h('h4', '전역 다듬기'),
    num('smooth', '매끄럽게', 0, 100),
    num('feather', '페더', 0, 250, 0.5, 'px'),
    num('contrast', '대비', 0, 100, 1, '%'),
    num('shift', '가장자리 이동', -100, 100, 1, '%'),
    h('div.inline',
      h('button.small', { onclick: () => { base.getContext('2d').clearRect(0, 0, W, H); brushC.getContext('2d').clearRect(0, 0, W, H); update(); } }, '선택 영역 지우기'),
      h('button.small', {
        onclick: () => {
          const g = base.getContext('2d');
          const t = cloneCanvas(base);
          g.globalCompositeOperation = 'copy';
          g.fillRect(0, 0, W, H);
          g.globalCompositeOperation = 'destination-out';
          g.drawImage(t, 0, 0);
          g.globalCompositeOperation = 'source-over';
          update();
        },
      }, '반전'),
      h('button.small', {
        onclick: () => {
          const m = SX.selectSubject(src);
          if (!m) return toast('피사체를 찾지 못했습니다');
          const g = base.getContext('2d');
          g.clearRect(0, 0, W, H);
          g.drawImage(m, 0, 0);
          update();
          return undefined;
        },
      }, '피사체 선택')),
    h('h4', '출력 설정'),
    check('decon', '색상 정화', syncOut),
    num('deconAmount', '양', 0, 100, 1, '%'),
    h('div.ph-samrow', h('label', '출력 위치'), outSel),
    check('sampleAll', '모든 레이어 샘플링', () => { loadSource(); }),
    check('remember', '설정 기억하기'),
    h('div.note', '가장자리 다듬기 브러시로 머리카락 같은 곳을 칠하면 주변의 확실한 개체·배경 색으로 투명도를 다시 계산합니다. 포토샵의 인공지능 기반 다듬기와는 다른 단순한 색 추정 방식이라 결과가 다를 수 있습니다.'));
  syncOut();
  const body = h('div.ph-sam',
    h('div.ph-samleft',
      h('div.ph-samtools', ...toolBtns, modeBtn, h('label.inline', h('span', '크기'), size)),
      h('div.ph-samwrap', view)),
    side);
  openModal({
    title: '선택 및 마스크',
    width: 'min(1240px, 98vw)',
    body,
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        savePref('photo.sam', o.remember ? { ...o } : { remember: false });
        toast('가장자리를 계산하는 중…');
        setTimeout(() => output(P, src, base, brushC, o), 30);
      },
    }],
  });
  update();
}

function output(P, src, base, brushC, o) {
  const doc = P.doc;
  const W = doc.width;
  const H = doc.height;
  const res = SX.refineCanvas(src, base, brushC, {
    radius: o.radius, smart: o.smart, smooth: o.smooth, feather: o.feather, contrast: o.contrast, shift: o.shift, decontaminate: o.decon ? o.deconAmount : 0,
  });
  const alpha = res.alpha;
  const l = doc.active;
  const pixels = () => {
    const c = P.layerAsDocCanvas(l);
    if (res.colors) {
      const g = c.getContext('2d');
      g.globalCompositeOperation = 'source-atop';
      g.drawImage(res.colors.canvas, res.colors.x, res.colors.y);
    }
    return c;
  };
  const mask = () => ({ canvas: cloneCanvas(alpha), x: 0, y: 0, enabled: true, linked: true });
  switch (o.output) {
    case 'selection':
      P.run('선택 및 마스크', () => { doc.selection = SEL.combine(doc, alpha, 'new'); });
      break;
    case 'mask':
      if (!l) return;
      P.run('선택 및 마스크 (레이어 마스크)', () => {
        l.mask = mask();
        doc.selection = null;
        doc.touch(l);
      });
      P.editMask = false;
      break;
    case 'layer':
    case 'layerMask':
      P.run('선택 및 마스크 (새 레이어)', () => {
        const c = pixels();
        const nl = newLayer('raster', { name: `${l?.name || '레이어'} 복사` });
        if (o.output === 'layer') {
          const g = c.getContext('2d');
          g.globalCompositeOperation = 'destination-in';
          g.drawImage(alpha, 0, 0);
        } else nl.mask = mask();
        nl.canvas = c;
        nl.x = 0;
        nl.y = 0;
        doc.insertAbove(nl, l?.id);
        if (l) l.visible = false;
        doc.activeId = nl.id;
        doc.selectedIds = [nl.id];
        doc.selection = null;
        doc.touch(nl);
      });
      break;
    default: {
      const c = pixels();
      if (o.output === 'doc') {
        const g = c.getContext('2d');
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(alpha, 0, 0);
      }
      const nd = new PhotoDoc({ name: `${doc.name} 선택`, width: W, height: H, background: null });
      const nl = newLayer('raster', { name: l?.name || '레이어' });
      nl.canvas = c;
      if (o.output === 'docMask') nl.mask = mask();
      nd.layers.push(nl);
      nd.activeId = nl.id;
      P.openDoc(nd);
    }
  }
  P.emit('layers');
  P.redraw();
}
