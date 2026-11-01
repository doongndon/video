// Edit ▸ Content-Aware Fill (내용 인식 채우기): Photoshop's workspace. The picture with the sampling
// area shown as a green overlay, the 샘플링 브러시 to add to it or take from it, the lasso tools to
// change the fill area, a live 미리 보기 panel and the fill settings (샘플링 영역 옵션, 채우기 설정:
// 색상 조정 / 회전 조정 / 비율 / 미러링, 출력 설정). 확인 applies everything as one step. The fill runs in a
// worker (cafill-worker.js) so the workspace stays responsive.

import { h, clamp } from '../util.js';
import { toast, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { makeCanvas, newLayer, cloneCanvas } from './doc.js';
import { antsImage, alphaBounds } from './selection.js';
import { contentAwareFill } from './inpaint.js';

const DEFAULTS = {
  area: 'auto', sampleAll: false, colorAdapt: 'default', rotate: 'none', scale: false, mirror: false, output: 'current',
  overlay: true, overlayOpacity: 50, overlayColor: '#00ff00', overlayShow: 'sample', brush: 60,
};
const COLOR_ADAPT = { none: 0, default: 0.35, high: 0.65, veryHigh: 1 };
const PREVIEW_PX = 200000;

// ---------------------------------------------------------------- the fill, in a worker

let worker = null;
let pending = null;
let seq = 0;

/** Run one fill job ({ data, w, h, hole, sample, opts }); a newer job cancels the one running. */
function runJob(job) {
  if (pending) {
    pending.reject(new Error('superseded'));
    pending = null;
    worker?.terminate();
    worker = null;
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const sync = () => setTimeout(() => {
      try {
        resolve(contentAwareFill(job.data, job.w, job.h, job.hole, job.sample, job.opts));
      } catch (err) {
        reject(err);
      }
    }, 20);
    try {
      worker ||= new Worker(new URL('./cafill-worker.js', import.meta.url), { type: 'module' });
    } catch {
      sync();
      return;
    }
    pending = { id, resolve, reject };
    worker.onmessage = (e) => {
      if (e.data.id !== pending?.id) return;
      const p = pending;
      pending = null;
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.data);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      // no module workers here: do it on this thread instead
      worker?.terminate();
      worker = null;
      if (pending?.id !== id) return;
      pending = null;
      sync();
    };
    // copied, not transferred: the job stays here in case the worker can't run it
    worker.postMessage({ id, data: job.data, w: job.w, h: job.h, hole: job.hole, sample: job.sample, opts: job.opts });
  });
}

function stopJobs() {
  if (pending) pending.reject(new Error('superseded'));
  pending = null;
  worker?.terminate();
  worker = null;
}

// ---------------------------------------------------------------- masks

/** Grow (r > 0) or shrink (r < 0) the opaque part of a canvas mask by |r| pixels (square). */
function growCanvas(c, r) {
  const w = c.width;
  const hh = c.height;
  const g = c.getContext('2d');
  const img = g.getImageData(0, 0, w, hh);
  const d = img.data;
  const m = new Uint8Array(w * hh);
  const out = r < 0;
  for (let i = 0; i < w * hh; i++) m[i] = (d[i * 4 + 3] > 127) !== out ? 1 : 0;
  const k = Math.abs(r);
  const t = new Uint8Array(w * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0, run = -1e9; x < w; x++) {
      if (m[y * w + x]) run = x;
      if (x - run <= k) t[y * w + x] = 1;
    }
    for (let x = w - 1, run = 1e9; x >= 0; x--) {
      if (m[y * w + x]) run = x;
      if (run - x <= k) t[y * w + x] = 1;
    }
  }
  m.fill(0);
  for (let x = 0; x < w; x++) {
    for (let y = 0, run = -1e9; y < hh; y++) {
      if (t[y * w + x]) run = y;
      if (y - run <= k) m[y * w + x] = 1;
    }
    for (let y = hh - 1, run = 1e9; y >= 0; y--) {
      if (t[y * w + x]) run = y;
      if (run - y <= k) m[y * w + x] = 1;
    }
  }
  for (let i = 0; i < w * hh; i++) {
    const on = m[i] !== (out ? 1 : 0);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0;
    d[i * 4 + 3] = on ? 255 : 0;
  }
  g.putImageData(img, 0, 0);
}

/** Alpha of a canvas region (x, y, w, h), scaled to sw × sh. */
function alphaOf(c, R, sw, sh) {
  const t = makeCanvas(sw, sh);
  const g = t.getContext('2d', { willReadFrequently: true });
  g.drawImage(c, R.x, R.y, R.w, R.h, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;
  const a = new Uint8Array(sw * sh);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
}

const unionBox = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

// ---------------------------------------------------------------- style

const STYLE_ID = 'ph-caf-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.modal-backdrop.caf { display: grid; place-items: stretch; background: var(--bg); z-index: 950;
  grid-template: "top top top" auto "tools stage side" minmax(0, 1fr) / 42px minmax(0, 1fr) 300px; }
.caf-top { grid-area: top; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--line); background: var(--bg-2); font-size: var(--fs-s); min-height: 36px; }
.caf-top > * { flex: none; white-space: nowrap; }
.caf-top .caf-name { font-weight: 600; display: inline-flex; align-items: center; gap: 4px; margin-right: 6px; }
.caf-top label { display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); }
.caf-top input[type=number] { width: 58px; }
.caf-top input[type=range] { width: 110px; }
.caf button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--value); }
.caf-tools { grid-area: tools; display: flex; flex-direction: column; gap: 2px; padding: 4px; border-right: 1px solid var(--line); background: var(--bg-2); }
.caf-tools button { width: 32px; height: 32px; padding: 0; display: grid; place-items: center; }
.caf-stage { grid-area: stage; position: relative; overflow: hidden; background: #1f2125; touch-action: none; min-height: 0; }
.caf-stage canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
.caf-side { grid-area: side; display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--line); background: var(--bg-2); }
.caf-scroll { flex: 1; overflow-y: auto; min-height: 0; }
.caf-panel { border-bottom: 1px solid var(--line); }
.caf-panel > h4 { margin: 0; padding: 6px 10px; font-size: var(--fs-s); font-weight: 600; background: var(--bg-3); }
.caf-panel > div { padding: 6px 10px 10px; display: grid; gap: 6px; font-size: var(--fs-s); color: var(--text-dim); }
.caf-sub { font-size: var(--fs-xs); color: var(--text-faint); margin-top: 4px; }
.caf-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.caf-row > span:first-child { min-width: 64px; }
.caf-row select { flex: 1; min-width: 0; }
.caf-pv { width: 100%; height: 190px; background: #111; border-radius: 4px; display: block; }
.caf-status { font-size: var(--fs-xs); color: var(--text-faint); min-height: 1.3em; }
.caf-foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line); align-items: center; }
.caf-foot .grow { flex: 1; }
body.mobile .modal-backdrop.caf { place-items: stretch; grid-template: "top" auto "tools" auto "stage" minmax(0, 1fr) "side" auto / minmax(0, 1fr); }
body.mobile .caf-tools { flex-direction: row; border-right: 0; border-bottom: 1px solid var(--line); }
body.mobile .caf-top { overflow-x: auto; flex-wrap: nowrap; }
body.mobile .caf-hint { display: none; }
body.mobile .caf-side { max-height: 40vh; border-left: 0; border-top: 1px solid var(--line); }
body.mobile .caf-pv { height: 120px; }
`;
  document.head.append(h('style', { id: STYLE_ID }, css));
}

// ---------------------------------------------------------------- the workspace

/** Edit ▸ Content-Aware Fill…: open the workspace for the active layer and the selection. */
export function contentAwareFillWorkspace(P) {
  const doc = P.doc;
  if (!doc) return toast('먼저 문서를 여세요');
  if (P.transform) P.applyTransform();
  P.finishText?.();
  if (!doc.selection || !P.selBounds(doc.selection.canvas)) return toast('먼저 채울 곳을 선택하세요 (지울 물체를 조금 넉넉하게 둘러싸서)');
  const l = doc.active;
  // a normal, unlocked layer takes the fill; otherwise the fill goes on a new layer
  const rasterOk = l?.kind === 'raster' && !l.locked && !l.lockPixels;
  if (l?.kind === 'raster' && !rasterOk) toast('잠긴 레이어라서 결과는 새 레이어에 만듭니다');
  ensureStyle();
  const W = doc.width;
  const H = doc.height;
  const S = { ...DEFAULTS, ...loadPref('photo.caf', {}) };
  if (!rasterOk) {
    S.output = 'new';
    S.sampleAll = true;
  }
  const save = () => savePref('photo.caf', S);

  // the pictures: what is shown, what is sampled, the fill area and the sampling area (doc size)
  const comp = doc.flatten({ fg: P.fg, bg: P.bg });
  const layerC = makeCanvas(W, H);
  if (rasterOk && l.canvas) layerC.getContext('2d').drawImage(l.canvas, l.x, l.y);
  const holeC = makeCanvas(W, H);
  holeC.getContext('2d').drawImage(doc.selection.canvas, 0, 0);
  const sampC = makeCanvas(W, H);
  const tintC = makeCanvas(W, H);
  let holeSel = { canvas: holeC };
  let holeBox = alphaBounds(holeC);
  let rev = 0;
  const source = () => (S.sampleAll || !rasterOk ? comp : layerC);

  // ---- sampling area
  const autoArea = () => {
    const g = sampC.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!holeBox) return;
    if (S.area === 'rect') {
      // the box around the fill area with a margin
      const m = Math.round(Math.max(holeBox.w, holeBox.h) * 0.5 + 24);
      g.fillRect(holeBox.x - m, holeBox.y - m, holeBox.w + 2 * m, holeBox.h + 2 * m);
    } else {
      // 자동: the surroundings, about as far out as the fill area is big
      const m = clamp(Math.round(Math.max(holeBox.w, holeBox.h) * 0.9), 16, 360);
      const R = { x: Math.max(0, holeBox.x - m), y: Math.max(0, holeBox.y - m) };
      R.w = Math.min(W, holeBox.x + holeBox.w + m) - R.x;
      R.h = Math.min(H, holeBox.y + holeBox.h + m) - R.y;
      const t = makeCanvas(R.w, R.h);
      t.getContext('2d').drawImage(holeC, -R.x, -R.y);
      growCanvas(t, m);
      g.drawImage(t, R.x, R.y);
    }
    // only pixels with something in them can be copied
    const src = source();
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-over';
  };
  const tint = () => {
    const g = tintC.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    g.fillStyle = S.overlayColor;
    if (S.overlayShow === 'sample') {
      g.drawImage(sampC, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillRect(0, 0, W, H);
    } else {
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(sampC, 0, 0);
    }
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(holeC, 0, 0);
    g.globalCompositeOperation = 'source-over';
  };
  const changed = ({ hole = false, area = false } = {}) => {
    rev++;
    if (hole) {
      holeSel = { canvas: holeC };
      holeBox = alphaBounds(holeC);
    }
    if ((hole || area) && S.area !== 'custom') autoArea();
    tint();
    draw();
    schedule();
  };

  // ---- in-workspace undo (brush strokes, lasso, grow / shrink)
  const undoStack = [];
  const redoStack = [];
  const snap = () => ({ hole: cloneCanvas(holeC), samp: cloneCanvas(sampC), area: S.area });
  const restoreSnap = (s) => {
    for (const [dst, src] of [[holeC, s.hole], [sampC, s.samp]]) {
      const g = dst.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.drawImage(src, 0, 0);
    }
    S.area = s.area;
    syncInputs();
    changed({ hole: true });
  };
  const pushUndo = () => {
    undoStack.push(snap());
    if (undoStack.length > 20) undoStack.shift();
    redoStack.length = 0;
  };
  const undo = () => {
    if (!undoStack.length) return;
    redoStack.push(snap());
    restoreSnap(undoStack.pop());
  };
  const redo = () => {
    if (!redoStack.length) return;
    undoStack.push(snap());
    restoreSnap(redoStack.pop());
  };

  // ---------------------------------------------------------------- layout

  const view = h('canvas');
  const over = h('canvas');
  const stage = h('div.caf-stage', view, over);
  const pv = h('canvas.caf-pv');
  const status = h('div.caf-status');
  const top = h('div.caf-top');
  const toolsEl = h('div.caf-tools');
  let tool = 'brush';
  let selMode = 'new';
  let brushSub = false;
  let growPx = 5;

  const TOOLS = [
    ['brush', '샘플링 브러시 도구 (B)', 'brush'],
    ['lasso', '올가미 도구 (L)', 'lasso'],
    ['polyLasso', '다각형 올가미 도구 (L)', 'polyLasso'],
    ['hand', '손 도구 (H)', 'hand'],
    ['zoom', '돋보기 도구 (Z)', 'zoom'],
  ];
  const setTool = (t) => {
    tool = t;
    poly = null;
    renderTools();
    renderTop();
    cursor();
    drawOver();
  };
  const renderTools = () => toolsEl.replaceChildren(...TOOLS.map(([id, name, ic]) => h(`button.small${tool === id ? '.on' : ''}`, { title: name, 'aria-label': name, onclick: () => setTool(id) }, icon(ic, 18))));
  const tog = (on, label, title, onclick) => h(`button.small${on ? '.on' : ''}`, { title, onclick }, label);
  const renderTop = () => {
    const name = TOOLS.find((t) => t[0] === tool)[1].replace(/ \(.\)$/, '');
    const out = [h('span.caf-name', icon(TOOLS.find((t) => t[0] === tool)[2], 16), name)];
    if (tool === 'brush') {
      const size = h('input', { type: 'range', min: 1, max: 500, value: S.brush, 'aria-label': '크기' });
      const num = h('input.ph-num', { type: 'number', min: 1, max: 5000, value: S.brush, 'aria-label': '크기' });
      const set = (v) => {
        S.brush = clamp(Math.round(+v) || 1, 1, 5000);
        size.value = S.brush;
        num.value = S.brush;
        save();
      };
      size.addEventListener('input', () => set(size.value));
      num.addEventListener('change', () => set(num.value));
      out.push(
        tog(!brushSub, icon('plus', 14), '샘플링 영역에 추가 (Alt: 빼기)', () => { brushSub = false; renderTop(); }),
        tog(brushSub, icon('minus', 14), '샘플링 영역에서 빼기 (Alt: 추가)', () => { brushSub = true; renderTop(); }),
        h('label', h('span', '크기'), size, num, h('small', 'px')),
        h('span.caf-sub.caf-hint', '[ ] 키로 크기를 바꿔요'),
      );
    } else if (tool === 'lasso' || tool === 'polyLasso') {
      const px = h('input.ph-num', { type: 'number', min: 1, max: 500, value: growPx, 'aria-label': '픽셀' });
      px.addEventListener('change', () => { growPx = clamp(Math.round(+px.value) || 1, 1, 500); });
      const grow = (r) => {
        pushUndo();
        growCanvas(holeC, r);
        changed({ hole: true });
      };
      out.push(
        h('span.caf-row', { style: { gap: '2px' } },
          tog(selMode === 'new', '새 선택', '새 선택 영역', () => { selMode = 'new'; renderTop(); }),
          tog(selMode === 'add', '추가', '선택 영역에 추가 (Shift)', () => { selMode = 'add'; renderTop(); }),
          tog(selMode === 'sub', '빼기', '선택 영역에서 빼기 (Alt)', () => { selMode = 'sub'; renderTop(); }),
          tog(selMode === 'and', '교차', '선택 영역과 교차 (Shift+Alt)', () => { selMode = 'and'; renderTop(); })),
        h('button.small', { title: '채우기 영역을 넓혀요', onclick: () => grow(growPx) }, '확장'),
        h('button.small', { title: '채우기 영역을 좁혀요', onclick: () => grow(-growPx) }, '축소'),
        h('label', px, h('small', '픽셀')),
      );
    } else {
      out.push(
        h('button.small', { onclick: () => zoomTo(1) }, '100%'),
        h('button.small', { onclick: () => fit() }, '화면 크기 맞추기'),
      );
    }
    top.replaceChildren(...out);
  };

  // ---- the panels
  const sel = (key, items, label, after = null) => {
    const s = h('select', { 'aria-label': label }, items.map(([v, t]) => h('option', { value: v }, t)));
    s.value = String(S[key]);
    s.addEventListener('change', () => {
      S[key] = s.value;
      save();
      after?.();
      schedule();
    });
    inputs[key] = s;
    return h('label.caf-row', h('span', label), s);
  };
  const chk = (key, label, title, after = null) => {
    const c = h('input', { type: 'checkbox', checked: !!S[key] });
    c.addEventListener('change', () => {
      S[key] = c.checked;
      save();
      after?.();
      schedule();
    });
    inputs[key] = c;
    return h('label.caf-row', { title }, c, h('span', label));
  };
  const inputs = {};
  const areaRadios = [['auto', '자동', '채울 곳 둘레에서 비슷한 내용을 가져와요'], ['rect', '사각형', '채울 곳을 둘러싼 사각형 안에서 가져와요'], ['custom', '사용자 정의', '샘플링 브러시로 칠한 곳에서만 가져와요']].map(([v, t, title]) => {
    const r = h('input', { type: 'radio', name: 'caf-area', value: v, checked: S.area === v });
    r.addEventListener('change', () => {
      if (!r.checked) return;
      pushUndo();
      S.area = v;
      save();
      changed({ area: true });
    });
    return [r, h('label.caf-row', { title }, r, h('span', t))];
  });
  const syncInputs = () => {
    for (const [r] of areaRadios) r.checked = r.value === S.area;
    for (const [k, el] of Object.entries(inputs)) {
      if (el.type === 'checkbox') el.checked = !!S[k];
      else el.value = String(S[k]);
    }
  };
  const opacity = h('input', { type: 'range', min: 0, max: 100, value: S.overlayOpacity, 'aria-label': '불투명도' });
  opacity.addEventListener('input', () => {
    S.overlayOpacity = +opacity.value;
    save();
    draw();
  });
  inputs.overlayOpacity = opacity;
  const color = h('input', { type: 'color', value: S.overlayColor, 'aria-label': '색상', style: { width: '36px', padding: 0 } });
  color.addEventListener('input', () => {
    S.overlayColor = color.value;
    save();
    tint();
    draw();
  });
  inputs.overlayColor = color;
  const outItems = [['current', '현재 레이어'], ['new', '새 레이어'], ['duplicate', '레이어 복제']].filter(([v]) => rasterOk || v === 'new');
  const reset = () => {
    pushUndo();
    Object.assign(S, { ...DEFAULTS, brush: S.brush }, rasterOk ? {} : { output: 'new', sampleAll: true });
    save();
    syncInputs();
    changed({ area: true });
  };
  const side = h('div.caf-side',
    h('div.caf-scroll',
      h('div.caf-panel', h('h4', '미리 보기'), h('div', pv, status)),
      h('div.caf-panel', h('h4', '내용 인식 채우기'), h('div',
        h('div.caf-sub', '샘플링 영역 오버레이'),
        chk('overlay', '샘플링 영역 표시', '초록색 오버레이를 보이거나 숨겨요', () => draw()),
        h('label.caf-row', h('span', '불투명도'), opacity),
        h('label.caf-row', h('span', '색상'), color),
        sel('overlayShow', [['sample', '샘플링 영역'], ['excluded', '제외된 영역']], '표시', () => { tint(); draw(); }),
        h('div.caf-sub', '샘플링 영역 옵션'),
        ...areaRadios.map((x) => x[1]),
        chk('sampleAll', '모든 레이어 샘플링', '보이는 모든 레이어를 합친 모습에서 가져와요', () => changed({ area: true })),
        h('div.caf-sub', '채우기 설정'),
        sel('colorAdapt', [['none', '없음'], ['default', '기본값'], ['high', '높음'], ['veryHigh', '매우 높음']], '색상 조정'),
        sel('rotate', [['none', '없음'], ['low', '낮음'], ['medium', '중간'], ['high', '높음'], ['full', '전체']], '회전 조정'),
        chk('scale', '비율', '크기가 다른 무늬(멀어지는 바닥·벽)도 맞춰 가져와요'),
        chk('mirror', '미러링', '좌우로 뒤집은 내용도 가져와요 (얼굴·건물처럼 대칭인 것)'),
        h('div.caf-sub', '출력 설정'),
        sel('output', outItems, '출력 위치'),
      ))),
    h('div.caf-foot',
      h('button.small.ph-icobtn', { title: '모든 설정을 기본값으로', 'aria-label': '기본값으로 재설정', onclick: reset }, icon('reset', 16)),
      h('span.grow'),
      h('button.small', { onclick: () => close() }, '취소'),
      h('button.primary.small', { onclick: () => ok() }, '확인')));
  const root = h('div.modal-backdrop.caf', { role: 'dialog', 'aria-label': '내용 인식 채우기' }, top, toolsEl, stage, side);
  document.body.append(root);

  // ---------------------------------------------------------------- view

  const V = { z: 1, x: 0, y: 0 };
  const dpr = () => window.devicePixelRatio || 1;
  const fit = () => {
    const r = stage.getBoundingClientRect();
    V.z = Math.min((r.width - 40) / W, (r.height - 40) / H) || 1;
    V.x = (r.width - W * V.z) / 2;
    V.y = (r.height - H * V.z) / 2;
    draw();
  };
  const zoomAt = (z, sx, sy) => {
    z = clamp(z, 0.02, 32);
    V.x = sx - ((sx - V.x) * z) / V.z;
    V.y = sy - ((sy - V.y) * z) / V.z;
    V.z = z;
    draw();
  };
  const zoomTo = (z) => {
    const r = stage.getBoundingClientRect();
    zoomAt(z, r.width / 2, r.height / 2);
  };
  const toDoc = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left - V.x) / V.z, y: (e.clientY - r.top - V.y) / V.z, sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const draw = () => {
    const k = dpr();
    const r = stage.getBoundingClientRect();
    const cw = Math.max(1, Math.round(r.width * k));
    const ch = Math.max(1, Math.round(r.height * k));
    for (const c of [view, over]) {
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
    }
    const g = view.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.setTransform(k * V.z, 0, 0, k * V.z, k * V.x, k * V.y);
    g.imageSmoothingEnabled = V.z < 2;
    g.drawImage(comp, 0, 0);
    if (S.overlay) {
      g.globalAlpha = S.overlayOpacity / 100;
      g.drawImage(tintC, 0, 0);
      g.globalAlpha = 1;
    }
    drawOver();
  };
  let phase = 0;
  let hover = null;
  let poly = null;
  let lasso = null;
  const drawOver = () => {
    const k = dpr();
    const g = over.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    const ants = antsImage(holeSel, { zoom: V.z * k, x: V.x * k, y: V.y * k }, over.width, over.height, phase);
    if (ants) g.putImageData(ants, 0, 0);
    else g.clearRect(0, 0, over.width, over.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    const sp = (p) => [p.x * V.z + V.x, p.y * V.z + V.y];
    g.lineWidth = 1;
    const pts = lasso || poly;
    if (pts?.length) {
      g.strokeStyle = '#fff';
      g.setLineDash([4, 3]);
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(...sp(p)) : g.moveTo(...sp(p))));
      if (poly && hover) g.lineTo(hover.sx, hover.sy);
      g.stroke();
      g.setLineDash([]);
    }
    if (tool === 'brush' && hover) {
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.beginPath();
      g.arc(hover.sx, hover.sy, Math.max(1, (S.brush / 2) * V.z), 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = '#fff';
      g.beginPath();
      g.arc(hover.sx, hover.sy, Math.max(1, (S.brush / 2) * V.z) - 1, 0, Math.PI * 2);
      g.stroke();
    }
  };
  const antsTimer = setInterval(() => {
    phase = (phase + 1) % 8;
    drawOver();
  }, 140);
  const ro = new ResizeObserver(() => draw());
  ro.observe(stage);

  // ---------------------------------------------------------------- pointer

  let spaceDown = false;
  let altDown = false;
  let act = null;
  const touches = new Map();
  const cursor = () => {
    stage.style.cursor = spaceDown || tool === 'hand' ? 'grab' : tool === 'zoom' ? (altDown ? 'zoom-out' : 'zoom-in') : tool === 'brush' ? 'none' : 'crosshair';
  };
  const paint = (a, b, sub) => {
    const g = sampC.getContext('2d');
    g.globalCompositeOperation = sub ? 'destination-out' : 'source-over';
    g.strokeStyle = '#000';
    g.fillStyle = '#000';
    g.lineCap = 'round';
    g.lineWidth = S.brush;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x + 0.01, b.y);
    g.stroke();
    g.globalCompositeOperation = 'source-over';
  };
  let raf = 0;
  const tintSoon = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      tint();
      draw();
    });
  };
  const combineHole = (pts, mode) => {
    if (pts.length < 3) return;
    pushUndo();
    const g = holeC.getContext('2d');
    if (mode === 'new') g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = mode === 'sub' ? 'destination-out' : mode === 'and' ? 'destination-in' : 'source-over';
    g.fillStyle = '#000';
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fill();
    g.globalCompositeOperation = 'source-over';
    changed({ hole: true });
  };
  const modeOf = (e) => (e.shiftKey && e.altKey ? 'and' : e.shiftKey ? 'add' : e.altKey ? 'sub' : selMode);
  over.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    over.setPointerCapture(e.pointerId);
    const p = toDoc(e);
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, p);
      if (touches.size === 2) {
        // two fingers: pan and pinch
        if (act?.kind === 'brush' || act?.kind === 'lasso') {
          if (act.snap) restoreSnap(undoStack.pop());
          lasso = null;
        }
        const [a, b] = [...touches.values()];
        act = { kind: 'pinch', d: Math.hypot(a.sx - b.sx, a.sy - b.sy), z: V.z, mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2, vx: V.x, vy: V.y };
        return;
      }
    }
    if (e.button === 1 || spaceDown || tool === 'hand') {
      act = { kind: 'pan', sx: p.sx, sy: p.sy, vx: V.x, vy: V.y };
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (tool === 'zoom') {
      zoomAt(V.z * (e.altKey ? 0.5 : 2), p.sx, p.sy);
      return;
    }
    if (tool === 'brush') {
      pushUndo();
      act = { kind: 'brush', last: p, sub: brushSub !== e.altKey, snap: true };
      if (S.area !== 'custom') {
        // painting the sampling area makes it the user's own (Photoshop switches to 사용자 정의)
        S.area = 'custom';
        save();
        syncInputs();
      }
      paint(p, p, act.sub);
      tintSoon();
      return;
    }
    if (tool === 'lasso') {
      lasso = [p];
      act = { kind: 'lasso', mode: modeOf(e) };
      return;
    }
    if (tool === 'polyLasso') {
      if (!poly) {
        poly = [p];
        poly.mode = modeOf(e);
      } else {
        const f = poly[0];
        if (poly.length >= 3 && Math.hypot((f.x - p.x) * V.z, (f.y - p.y) * V.z) < 8) {
          const pts = poly;
          poly = null;
          combineHole(pts, pts.mode);
        } else poly.push(p);
      }
      drawOver();
    }
  });
  over.addEventListener('pointermove', (e) => {
    const p = toDoc(e);
    hover = p;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, p);
    if (!act) {
      drawOver();
      return;
    }
    if (act.kind === 'pinch') {
      if (touches.size < 2) return;
      const [a, b] = [...touches.values()];
      const z = clamp((act.z * Math.hypot(a.sx - b.sx, a.sy - b.sy)) / (act.d || 1), 0.02, 32);
      const mx = (a.sx + b.sx) / 2;
      const my = (a.sy + b.sy) / 2;
      V.x = mx - ((act.mx - act.vx) * z) / act.z;
      V.y = my - ((act.my - act.vy) * z) / act.z;
      V.z = z;
      draw();
    } else if (act.kind === 'pan') {
      V.x = act.vx + p.sx - act.sx;
      V.y = act.vy + p.sy - act.sy;
      draw();
    } else if (act.kind === 'brush') {
      paint(act.last, p, act.sub);
      act.last = p;
      tintSoon();
    } else if (act.kind === 'lasso') {
      lasso.push(p);
      drawOver();
    }
  });
  const end = (e) => {
    touches.delete(e.pointerId);
    if (!act) return;
    const a = act;
    if (a.kind === 'pinch') {
      if (!touches.size) act = null;
      return;
    }
    act = null;
    if (a.kind === 'brush') {
      rev++;
      tint();
      draw();
      schedule();
    } else if (a.kind === 'lasso') {
      const pts = lasso;
      lasso = null;
      if (pts.length > 2) combineHole(pts, a.mode);
      else drawOver();
    }
  };
  over.addEventListener('pointerup', end);
  over.addEventListener('pointercancel', end);
  over.addEventListener('pointerleave', () => {
    hover = null;
    drawOver();
  });
  over.addEventListener('dblclick', () => {
    if (!poly) return;
    const pts = poly;
    poly = null;
    combineHole(pts, pts.mode);
  });
  over.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toDoc(e);
    if (e.ctrlKey || e.altKey || e.metaKey) zoomAt(V.z * Math.exp(-e.deltaY * 0.0025), p.sx, p.sy);
    else {
      V.x -= e.deltaX;
      V.y -= e.deltaY;
      draw();
    }
  }, { passive: false });

  // ---------------------------------------------------------------- keys

  const onKey = (e) => {
    const tag = e.target?.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(e.target.type));
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Alt') {
      altDown = true;
      cursor();
      stop();
      return;
    }
    if (e.key === 'Escape') {
      stop();
      if (poly) {
        poly = null;
        drawOver();
      } else close();
      return;
    }
    if (e.key === 'Enter' && !typing) {
      stop();
      if (poly) {
        const pts = poly;
        poly = null;
        combineHole(pts, pts.mode);
      } else ok();
      return;
    }
    if (typing) return;
    if (e.code === 'Space') {
      spaceDown = true;
      cursor();
      stop();
      return;
    }
    if (mod && e.code === 'KeyZ') return stop(), e.shiftKey ? redo() : undo();
    if (mod && e.code === 'Digit0') return stop(), fit();
    if (mod && e.code === 'Digit1') return stop(), zoomTo(1);
    if (mod && (e.key === '+' || e.key === '=')) return stop(), zoomTo(V.z * 1.5);
    if (mod && e.key === '-') return stop(), zoomTo(V.z / 1.5);
    if (mod) return stop();
    const keyTool = { KeyB: 'brush', KeyH: 'hand', KeyZ: 'zoom' }[e.code];
    if (keyTool) return stop(), setTool(keyTool);
    if (e.code === 'KeyL') return stop(), setTool(e.shiftKey || tool === 'lasso' ? (tool === 'polyLasso' ? 'lasso' : 'polyLasso') : 'lasso');
    if (e.key === '[' || e.key === ']') {
      S.brush = clamp(Math.round(S.brush * (e.key === ']' ? 1.15 : 1 / 1.15)) + (e.key === ']' ? 1 : -1), 1, 5000);
      save();
      if (tool === 'brush') renderTop();
      drawOver();
      stop();
    }
  };
  const onKeyUp = (e) => {
    if (e.code === 'Space') spaceDown = false;
    if (e.key === 'Alt') altDown = false;
    cursor();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);

  // ---------------------------------------------------------------- the fill

  const fillOpts = () => ({ colorAdapt: COLOR_ADAPT[S.colorAdapt] ?? 0.35, rotate: S.rotate, scale: !!S.scale, mirror: !!S.mirror });
  const keyOf = () => `${rev}:${JSON.stringify(fillOpts())}:${S.sampleAll}`;
  const extra = () => (S.mirror ? 1 : 0) + ({ none: 0, low: 2, medium: 4, high: 4, full: 5 }[S.rotate] || 0) * 1.4 + (S.scale ? 2.3 : 0);
  /** The work for a fill at scale k (≤ 1) of the area that matters, or a message why there is none. */
  const makeJob = (maxPx) => {
    if (!holeBox) return '채울 영역이 없습니다. 올가미로 채울 곳을 그리세요.';
    const sb = alphaBounds(sampC);
    if (!sb) return '샘플링 영역이 비어 있습니다. 샘플링 브러시로 가져올 곳을 칠하세요.';
    const u = unionBox(holeBox, sb);
    const R = { x: Math.max(0, u.x - 4), y: Math.max(0, u.y - 4) };
    R.w = Math.min(W, u.x + u.w + 4) - R.x;
    R.h = Math.min(H, u.y + u.h + 4) - R.y;
    const k = Math.min(1, Math.sqrt(maxPx / (R.w * R.h * (1 + extra()))));
    const w = Math.max(8, Math.round(R.w * k));
    const hh = Math.max(8, Math.round(R.h * k));
    const t = makeCanvas(w, hh);
    const tg = t.getContext('2d', { willReadFrequently: true });
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(source(), R.x, R.y, R.w, R.h, 0, 0, w, hh);
    const data = tg.getImageData(0, 0, w, hh).data;
    const ha = alphaOf(holeC, R, w, hh);
    const sa = alphaOf(sampC, R, w, hh);
    const hole = new Uint8Array(w * hh);
    const sample = new Uint8Array(w * hh);
    let n = 0;
    for (let i = 0; i < w * hh; i++) {
      hole[i] = ha[i] > (k < 1 ? 0 : 8) ? 1 : 0;
      sample[i] = !hole[i] && sa[i] > 127 && data[i * 4 + 3] > 127 ? 1 : 0;
      n += sample[i];
    }
    if (n < 50) return '샘플링 영역이 너무 작습니다. 샘플링 브러시로 더 칠하세요.';
    return { R, k, w, h: hh, data, hole, sample, amt: ha, opts: { ...fillOpts(), seed: 7 }, key: keyOf() };
  };
  let last = null; // { key, k, R, data }
  let timer = 0;
  let busy = false;
  const schedule = () => {
    clearTimeout(timer);
    status.textContent = '미리 보기 만드는 중…';
    timer = setTimeout(preview, 250);
  };
  const showPreview = (job, data) => {
    const { R, w, h: hh } = job;
    const res = new ImageData(new Uint8ClampedArray(data), w, hh);
    // only the filled pixels, faded in at soft edges, over the picture
    for (let i = 0; i < w * hh; i++) {
      const a = job.k < 1 ? (job.hole[i] ? 255 : 0) : job.amt[i];
      res.data[i * 4 + 3] = (res.data[i * 4 + 3] * a) / 255;
    }
    const f = makeCanvas(w, hh);
    f.getContext('2d').putImageData(res, 0, 0);
    const k = dpr();
    const r = pv.getBoundingClientRect();
    pv.width = Math.max(1, Math.round(r.width * k));
    pv.height = Math.max(1, Math.round(r.height * k));
    const g = pv.getContext('2d');
    // the fill area with some of its surroundings
    const m = Math.max(holeBox.w, holeBox.h) * 0.35 + 8;
    const vx = holeBox.x - m;
    const vy = holeBox.y - m;
    const vw = holeBox.w + 2 * m;
    const vh = holeBox.h + 2 * m;
    const s = Math.min(pv.width / vw, pv.height / vh);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pv.width, pv.height);
    g.setTransform(s, 0, 0, s, (pv.width - vw * s) / 2 - vx * s, (pv.height - vh * s) / 2 - vy * s);
    g.imageSmoothingQuality = 'high';
    g.drawImage(comp, 0, 0);
    g.drawImage(f, R.x, R.y, R.w, R.h);
  };
  const preview = () => {
    const job = makeJob(PREVIEW_PX);
    if (typeof job === 'string') {
      status.textContent = job;
      pv.getContext('2d').clearRect(0, 0, pv.width, pv.height);
      return;
    }
    const t0 = performance.now();
    runJob(job).then((data) => {
      if (closed || job.key !== keyOf()) return;
      last = { key: job.key, k: job.k, R: job.R, data };
      showPreview(job, data);
      status.textContent = job.k < 1 ? `미리 보기 (${Math.round(job.k * 100)}% 크기, ${Math.round(performance.now() - t0)}ms) · 확인하면 원래 크기로 채워요` : '미리 보기 (원래 크기)';
    }, (err) => {
      if (err.message !== 'superseded' && !closed) status.textContent = `미리 보기를 만들지 못했습니다: ${err.message}`;
    });
  };

  /** Write a full-size result into the document as one step. */
  const commit = (job, data) => {
    const { R, w, h: hh, amt } = job;
    const blendInto = (layer) => {
      const g = doc.editPixels(layer, R);
      const ox = R.x - layer.x;
      const oy = R.y - layer.y;
      const img = g.getImageData(ox, oy, w, hh);
      const d = img.data;
      for (let i = 0; i < w * hh; i++) {
        const a = amt[i] / 255;
        if (!a) continue;
        for (let c = 0; c < 4; c++) d[i * 4 + c] += (data[i * 4 + c] - d[i * 4 + c]) * a;
      }
      g.putImageData(img, ox, oy);
      layer._styled = null;
      doc.touch(layer);
    };
    if (S.output === 'new') {
      P.run('내용 인식 채우기', () => {
        const c = makeCanvas(w, hh);
        const img = new ImageData(new Uint8ClampedArray(data), w, hh);
        for (let i = 0; i < w * hh; i++) img.data[i * 4 + 3] = (img.data[i * 4 + 3] * amt[i]) / 255;
        c.getContext('2d').putImageData(img, 0, 0);
        P.addLayer(newLayer('raster', { name: doc.nextLayerName(), canvas: c, x: R.x, y: R.y }));
      });
    } else if (S.output === 'duplicate') {
      const before = doc.capture();
      const topStep = doc.history.undoStack.at(-1);
      P.cmd.duplicateLayer({ noSelection: true });
      while (doc.history.undoStack.length && doc.history.undoStack.at(-1) !== topStep) doc.history.undoStack.pop();
      const d = doc.active;
      if (d && d !== l && d.kind === 'raster') blendInto(d);
      P.commit('내용 인식 채우기', before);
    } else P.run('내용 인식 채우기', () => blendInto(l));
  };
  const ok = () => {
    if (busy) return;
    if (last && last.k === 1 && last.key === keyOf()) {
      const job = makeJob(Infinity);
      if (typeof job !== 'string') {
        close();
        commit(job, last.data);
        return;
      }
    }
    const job = makeJob(Infinity);
    if (typeof job === 'string') {
      toast(job);
      return;
    }
    busy = true;
    clearTimeout(timer);
    status.textContent = '내용 인식 채우기 적용 중…';
    root.style.cursor = 'progress';
    for (const b of side.querySelectorAll('.caf-foot button')) b.disabled = true;
    runJob(job).then((data) => {
      close();
      commit(job, data);
    }, (err) => {
      busy = false;
      root.style.cursor = '';
      for (const b of side.querySelectorAll('.caf-foot button')) b.disabled = false;
      if (err.message !== 'superseded') toast(`내용 인식 채우기를 하지 못했습니다: ${err.message}`);
    });
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(antsTimer);
    if (!busy) stopJobs();
    ro.disconnect();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    root.remove();
    P.redraw?.();
  };
  // a mode switch or a new document closes the workspace without applying
  const watch = setInterval(() => {
    if (closed) return clearInterval(watch);
    if (P.doc !== doc || !document.body.classList.contains('photo-mode')) close();
    return undefined;
  }, 500);

  renderTools();
  renderTop();
  cursor();
  if (S.area !== 'custom') autoArea();
  else {
    // a custom area from an earlier time doesn't fit this picture: start from 자동's
    S.area = 'auto';
    autoArea();
    S.area = 'custom';
  }
  tint();
  requestAnimationFrame(() => {
    fit();
    schedule();
  });
  return undefined;
}
