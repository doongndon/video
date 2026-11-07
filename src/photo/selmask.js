// Select and Mask: a workspace to refine the selection's edge (radius / smart radius, smooth,
// feather, contrast, shift edge, decontaminate colours) with the quick selection, refine edge and
// plain brushes, Refine Hair, the colour-aware / object-aware refine modes, several view modes, and
// output to a selection, mask, new layer or new document.
// The preview runs at a reduced size; the output is computed at full size.

import { h, clamp } from '../util.js';
import { toast, openModal, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { makeCanvas, cloneCanvas, newLayer, PhotoDoc } from './doc.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';

const VIEWS = [['onion', '어니언 스킨 (O)'], ['ants', '개미 행렬 (M)'], ['overlay', '오버레이 (V)'], ['black', '검정 바탕 (A)'], ['white', '흰색 바탕 (T)'], ['bw', '흑백 (K)'], ['layers', '레이어 위 (Y)']];
const VIEW_KEYS = { KeyO: 'onion', KeyM: 'ants', KeyV: 'overlay', KeyA: 'black', KeyT: 'white', KeyK: 'bw', KeyY: 'layers' };
const OUTPUTS = [['selection', '선택 영역'], ['mask', '레이어 마스크'], ['layer', '새 레이어'], ['layerMask', '레이어 마스크가 있는 새 레이어'], ['doc', '새 문서'], ['docMask', '레이어 마스크가 있는 새 문서']];
const MODES = [['color', '색상 인식'], ['object', '개체 인식']];
const DEFAULTS = {
  view: 'onion', opacity: 50, overlayColor: '#ff0000', mode: 'color', radius: 0, smart: false, smooth: 0, feather: 0, contrast: 0, shift: 0,
  decon: false, deconAmount: 50, output: 'selection', sampleAll: true, remember: false, tool: 'refine', size: 40,
};

const hexRgb = (hex) => {
  const n = parseInt((hex || '#ff0000').slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

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
  const loadSource = () => {
    src = o.sampleAll ? P.composite() : P.layerAsDocCanvas(doc.active);
    srcPx = null;
    const c = makeCanvas(pw, ph);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, pw, ph);
    smallPx = g.getImageData(0, 0, pw, ph).data;
  };
  loadSource();

  // ---------------------------------------------------------------- preview
  const view = h('canvas.ph-samview', { width: pw, height: ph, tabindex: 0, 'aria-label': '미리 보기 (브러시로 칠하기)' });
  const wrap = h('div.ph-samwrap', view);
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
      radius: o.radius * ps, smart: o.smart, brush, mode: o.mode, smooth: o.smooth, feather: o.feather * ps, contrast: o.contrast, shift: o.shift,
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
    const [ovR, ovG, ovB] = hexRgb(o.overlayColor);
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
          d[p] = r * (1 - m) + ovR * m;
          d[p + 1] = gg * (1 - m) + ovG * m;
          d[p + 2] = b * (1 - m) + ovB * m;
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

  // ---------------------------------------------------------------- zoom (to look at hair closely)
  let zoom = 1;
  const zoomLabel = h('span.ph-val', '맞춤');
  let fitted = null;
  const setZoom = (z) => {
    zoom = clamp(z, 1, 8);
    if (zoom <= 1) {
      view.style.width = '';
      view.style.height = '';
      view.style.maxWidth = '';
      view.style.maxHeight = '';
      view.style.imageRendering = '';
      for (const k of ['overflow', 'display', 'width', 'height', 'flex']) wrap.style[k] = '';
      fitted = null;
      zoomLabel.textContent = '맞춤';
      return;
    }
    if (!fitted) {
      // the preview box keeps its size and scrolls; the picture's fitted size is the 100% mark
      const r = wrap.getBoundingClientRect();
      const v = view.getBoundingClientRect();
      fitted = { w: v.width || pw };
      wrap.style.width = `${Math.round(r.width)}px`;
      wrap.style.height = `${Math.round(r.height)}px`;
      wrap.style.flex = 'none';
    }
    const k = fitted.w / pw;
    view.style.maxWidth = 'none';
    view.style.maxHeight = 'none';
    view.style.width = `${Math.round(pw * k * zoom)}px`;
    view.style.height = `${Math.round(ph * k * zoom)}px`;
    view.style.imageRendering = zoom >= 2 ? 'pixelated' : '';
    wrap.style.overflow = 'auto';
    wrap.style.display = 'block';
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  };
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
    e.preventDefault();
    const r = view.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    setZoom(zoom * Math.exp(-e.deltaY * 0.004));
    // keep the point under the pointer in place
    const r2 = view.getBoundingClientRect();
    wrap.scrollLeft += r2.left + fx * r2.width - e.clientX;
    wrap.scrollTop += r2.top + fy * r2.height - e.clientY;
  }, { passive: false });

  // ---------------------------------------------------------------- brushes on the preview
  let sub = false;
  const toolBtns = [['quick', 'quickSel', '빠른 선택 도구 (W)'], ['refine', 'brush', '가장자리 다듬기 브러시 도구 (R)'], ['brush', 'pencil', '브러시 도구 (B)']].map(([id, ic, label]) => {
    const b = h('button.small.ph-tog', { title: label, 'aria-label': label, onclick: () => setTool(id) }, icon(ic), ` ${label.replace(/ 도구.*$/, '')}`);
    b.dataset.tool = id;
    return b;
  });
  const setTool = (id) => {
    o.tool = id;
    toolBtns.forEach((x) => x.classList.toggle('on', x.dataset.tool === id));
  };
  setTool(o.tool);
  const modeBtn = h('button.small.ph-tog', { title: '더하기 / 빼기 (Alt를 누르고 칠해도 빼기)', onclick: () => setSub(!sub) }, icon('plus'), ' 더하기');
  const setSub = (v) => {
    sub = v;
    modeBtn.replaceChildren(icon(sub ? 'minus' : 'plus'), sub ? ' 빼기' : ' 더하기');
    modeBtn.classList.toggle('on', sub);
  };
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
  // Space (or the middle button) drags the zoomed preview around
  let spaceHeld = false;
  let pan = null;
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId);
    view.focus({ preventScroll: true });
    if (spaceHeld || e.button === 1) {
      pan = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
      return;
    }
    const p = docPt(e);
    stroke = { last: p, sub: sub || e.altKey };
    dab(p);
    update();
  });
  view.addEventListener('pointermove', (e) => {
    if (pan) {
      wrap.scrollLeft = pan.sl - (e.clientX - pan.x);
      wrap.scrollTop = pan.st - (e.clientY - pan.y);
      return;
    }
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
    pan = null;
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);

  // ---------------------------------------------------------------- settings
  const num = (key, label, min, max, step = 1, unit = '') => {
    const r = h('input', { type: 'range', min, max, step, value: o[key], 'aria-label': label });
    const n = h('input.ph-num', { type: 'number', min, max, step, value: o[key], style: { width: '64px' }, 'aria-label': label });
    const lab = h('label', label);
    const set = (v) => {
      o[key] = clamp(+v || 0, min, max);
      r.value = o[key];
      n.value = o[key];
      update();
    };
    r.addEventListener('input', () => set(r.value));
    n.addEventListener('change', () => set(n.value));
    const row = h('div.ph-samrow', lab, h('div.inline', r, n, unit ? h('small', unit) : null));
    row.set = set;
    row.lab = lab;
    return row;
  };
  const check = (key, label, after) => {
    const c = h('input', { type: 'checkbox', checked: !!o[key] });
    c.addEventListener('change', () => {
      o[key] = c.checked;
      after?.();
      update();
    });
    const l = h('label.ph-samchk', c, ` ${label}`);
    l.box = c;
    return l;
  };
  const viewSel = h('select', { 'aria-label': '보기 모드' }, ...VIEWS.map(([v, t]) => h('option', { value: v }, t)));
  viewSel.value = o.view;
  const opRow = num('opacity', '투명도', 0, 100, 1, '%');
  const color = h('input', { type: 'color', value: o.overlayColor, title: '오버레이 색상', 'aria-label': '오버레이 색상' });
  color.addEventListener('input', () => {
    o.overlayColor = color.value;
    render();
  });
  const colorRow = h('div.ph-samrow', h('label', '색상'), color);
  const syncView = () => {
    viewSel.value = o.view;
    // Photoshop names the slider after what it does in each view
    opRow.lab.textContent = o.view === 'onion' ? '투명도' : '불투명도';
    opRow.hidden = ['ants', 'bw'].includes(o.view);
    colorRow.hidden = o.view !== 'overlay';
  };
  const setView = (v) => {
    o.view = v;
    if (!saved?.remember) opRow.set(['onion', 'overlay'].includes(o.view) ? 50 : 100);
    syncView();
    render();
  };
  viewSel.addEventListener('change', () => setView(viewSel.value));
  const showEdge = h('input', { type: 'checkbox' });
  const showOrig = h('input', { type: 'checkbox' });
  showEdge.addEventListener('change', render);
  showOrig.addEventListener('change', render);
  const outSel = h('select', { 'aria-label': '출력 위치' }, ...OUTPUTS.map(([v, t]) => h('option', { value: v }, t)));
  outSel.value = o.output;
  const syncOut = () => {
    // decontaminated colours need pixels of their own (Photoshop does the same)
    for (const opt of outSel.options) opt.disabled = o.decon && (opt.value === 'selection' || opt.value === 'mask');
    if (o.decon && (outSel.value === 'selection' || outSel.value === 'mask')) outSel.value = 'layerMask';
    o.output = outSel.value;
  };
  outSel.addEventListener('change', syncOut);
  const modeSel = h('select', { 'aria-label': '다듬기 모드', title: '색상 인식: 배경이 단순하거나 대비가 클 때 · 개체 인식: 배경이 복잡할 때' }, ...MODES.map(([v, t]) => h('option', { value: v }, t)));
  modeSel.value = o.mode;
  modeSel.addEventListener('change', () => {
    o.mode = modeSel.value;
    update();
  });
  const radiusRow = num('radius', '반경', 0, 250, 1, 'px');
  const smartChk = check('smart', '고급 반경');
  const selectSubject = () => {
    toast('피사체를 찾는 중…');
    setTimeout(() => {
      const m = SX.selectSubject(src);
      if (!m) {
        toast('피사체를 찾지 못했습니다');
        return;
      }
      const g = base.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.drawImage(m, 0, 0);
      update();
    }, 30);
  };
  /**
   * Refine Hair: like brushing the refine edge brush over the hair, the edge areas that look like
   * hair or fur get their alpha estimated again (and the edge gets a little radius when it has none).
   */
  const refineHair = () => {
    const a0 = scaledAlpha(base);
    const box = SX.boundsOf(a0, pw, ph, 0.5);
    if (!box) {
      toast('먼저 피사체를 선택하세요 (피사체 선택 또는 빠른 선택 도구)');
      return;
    }
    // loose strands reach well out from the selection (about a fifth of its size)
    const R = clamp(Math.sqrt(box.w * box.h) * 0.2, 8, 120);
    const areas = SX.hairAreas(smallPx, pw, ph, a0, R);
    let any = 0;
    for (let i = 0; i < areas.length; i++) any += areas[i];
    if (!any) {
      toast('머리카락처럼 보이는 가장자리를 찾지 못했습니다. 가장자리 다듬기 브러시로 직접 칠해 보세요.');
      return;
    }
    const t = SX.alphaCanvas(Float32Array.from(areas), pw, ph);
    const g = brushC.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(t, 0, 0, W, H);
    if (!o.radius) radiusRow.set(3);
    if (o.view === 'bw' || o.view === 'ants') setView('onion');
    update();
    toast('머리카락 가장자리를 다듬었습니다. 남은 곳은 가장자리 다듬기 브러시로 칠하세요.');
  };
  const top = h('div.ph-samtools',
    ...toolBtns, modeBtn, h('label.inline', h('span', '크기'), size),
    h('button.small', { onclick: selectSubject, title: '피사체 선택' }, icon('smile'), ' 피사체 선택'),
    h('button.small', { onclick: refineHair, title: '머리카락 다듬기: 머리카락·털처럼 보이는 가장자리를 자동으로 다듬습니다' }, icon('sparkle'), ' 머리카락 다듬기'),
    h('label.inline', h('span', '다듬기 모드'), modeSel),
    h('span.inline', h('button.small', { title: '축소 (Ctrl+휠)', 'aria-label': '미리 보기 축소', onclick: () => setZoom(zoom / 1.5) }, icon('zoomOut')), zoomLabel, h('button.small', { title: '확대 (Ctrl+휠, Space를 누른 채 끌어 이동)', 'aria-label': '미리 보기 확대', onclick: () => setZoom(zoom * 1.5) }, icon('zoomIn'))));
  const rememberChk = check('remember', '설정 기억');
  const side = h('div.ph-samside',
    h('h4', '보기 모드'),
    h('div.ph-samrow', h('label', '보기'), viewSel),
    opRow,
    colorRow,
    h('div.inline', h('label.ph-samchk', showEdge, ' 가장자리 표시 (J)'), h('label.ph-samchk', showOrig, ' 원본 표시 (P)')),
    h('h4', '가장자리 감지'),
    radiusRow,
    smartChk,
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
      }, '반전')),
    h('h4', '출력 설정'),
    check('decon', '색상 정화', syncOut),
    num('deconAmount', '양', 0, 100, 1, '%'),
    h('div.ph-samrow', h('label', '출력 위치'), outSel),
    check('sampleAll', '모든 레이어 샘플링', () => { loadSource(); }),
    rememberChk,
    h('div.note', '머리카락 다듬기나 가장자리 다듬기 브러시로 칠한 곳은 주변의 확실한 개체·배경 색으로 투명도를 다시 계산합니다. 배경이 복잡하면 다듬기 모드를 개체 인식으로 바꿔 보세요. 단축키: F 보기 바꾸기, J 가장자리, P 원본, [ ] 브러시 크기, Alt 빼기.'));
  syncView();
  syncOut();
  const body = h('div.ph-sam',
    h('div.ph-samleft', top, wrap),
    side);
  // the workspace's own shortcuts (when the keyboard is not in a field)
  body.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && !['checkbox', 'range', 'radio', 'color'].includes(t.type)) return;
    if (t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey) return;
    const k = e.code;
    if (k === 'Space') {
      spaceHeld = true;
      view.style.cursor = 'grab';
    } else if (k === 'KeyF') setView(VIEWS[(VIEWS.findIndex(([v]) => v === o.view) + (e.shiftKey ? VIEWS.length - 1 : 1)) % VIEWS.length][0]);
    else if (VIEW_KEYS[k]) setView(VIEW_KEYS[k]);
    else if (k === 'KeyJ') {
      showEdge.checked = !showEdge.checked;
      render();
    } else if (k === 'KeyP') {
      showOrig.checked = !showOrig.checked;
      render();
    } else if (k === 'KeyW') setTool('quick');
    else if (k === 'KeyR') setTool('refine');
    else if (k === 'KeyB') setTool('brush');
    else if (k === 'BracketLeft' || k === 'BracketRight') {
      o.size = clamp(Math.round(o.size * (k === 'BracketLeft' ? 0.85 : 1.18)), 2, 300);
      size.value = o.size;
    } else return;
    e.preventDefault();
  });
  body.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceHeld = false;
      view.style.cursor = '';
    }
  });
  openModal({
    title: '선택 및 마스크',
    width: 'min(1240px, 98vw)',
    body,
    peek: false,
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        savePref('photo.sam', o.remember ? { ...o } : { remember: false });
        toast('가장자리를 계산하는 중…');
        setTimeout(() => output(P, src, base, brushC, o), 30);
      },
    }],
  });
  setTimeout(() => view.focus({ preventScroll: true }), 0);
  update();
}

function output(P, src, base, brushC, o) {
  const doc = P.doc;
  const W = doc.width;
  const H = doc.height;
  const res = SX.refineCanvas(src, base, brushC, {
    radius: o.radius, smart: o.smart, mode: o.mode, smooth: o.smooth, feather: o.feather, contrast: o.contrast, shift: o.shift, decontaminate: o.decon ? o.deconAmount : 0,
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
        doc.freeBackground(l);
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
