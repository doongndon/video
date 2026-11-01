// Brush presets and brush panels: the brush tools' options bar (preset picker, pen pressure for size
// and opacity, airbrush, smoothing), the Brushes panel (presets in groups, new preset, Define Brush,
// Photoshop .abr import) and the Brush Settings panel (F5) with Photoshop's sections and a live
// stroke preview. Imported tips and presets are kept in this browser (IndexedDB).

import { h, clamp } from '../util.js';
import { toast, promptDialog, showMenu, confirmDialog, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { injectStyle } from '../ui/style-inject.js';
import { makeCanvas } from './doc.js';
import { TOOL_BY_ID } from './tools.js';
import {
  TIP_LIST, DYN, DYN_KEYS, CONTROLS, ANGLE_CONTROLS, TEXTURE_MODES, DUAL_MODES, normDyn, addSampledTip, removeTip,
  renameTip, hasTip, isDrawnTip, tipName, tipSize, tipThumb, tipFromGray, previewStroke,
} from './brushengine.js';
import { listPatterns, patternCanvas, resGet, resPut, resDel, keepImportedPatterns, resourceEvents, blobCanvas } from './resources.js';
import { parseAbr } from './psdres.js';

/** Photoshop's painting modes the canvas can do, with their Korean names (value: canvas operation). */
export const BRUSH_MODES = [
  ['source-over', '표준'], ['destination-over', '뒤'], ['destination-out', '지우기'],
  ['darken', '어둡게 하기'], ['multiply', '곱하기'], ['color-burn', '색상 번'],
  ['lighten', '밝게 하기'], ['screen', '스크린'], ['color-dodge', '색상 닷지'], ['lighter', '선형 닷지(추가)'],
  ['overlay', '오버레이'], ['soft-light', '소프트 라이트'], ['hard-light', '하드 라이트'],
  ['difference', '차이'], ['exclusion', '제외'],
  ['hue', '색조'], ['saturation', '채도'], ['color', '색상'], ['luminosity', '광도'],
];
const MODE_OPT = ['blend', '모드', 'select', null, null, 'source-over', BRUSH_MODES];
const BAR_REST = [
  ['opacity', '불투명도', 'range', 1, 100, 100, '%'],
  ['pressureOpacity', '압력: 불투명도', 'bool', null, null, false],
  ['flow', '흐름', 'range', 1, 100, 100, '%'],
  ['airbrush', '에어브러시', 'bool', null, null, false],
  ['smoothing', '보정', 'range', 0, 100, 10, '%'],
  ['pressureSize', '압력: 크기', 'bool', null, null, true],
];
/** Options-bar settings of the brush (Photoshop's order: size, mode, opacity, flow, airbrush, smoothing, pressure). */
export const BRUSH_BAR = [['size', '크기', 'range', 1, 1000, 30, 'px'], ['hardness', '경도', 'range', 0, 100, 70, '%'], MODE_OPT, ...BAR_REST];
/** The eraser: brush, pencil or block, and Erase to History. */
export const ERASER_BAR = [
  ['eraseMode', '모드', 'select', null, null, 'brush', [['brush', '브러시'], ['pencil', '연필'], ['block', '블록']]],
  ['size', '크기', 'range', 1, 1000, 30, 'px'], ['hardness', '경도', 'range', 0, 100, 70, '%'], ...BAR_REST,
  ['eraseHistory', '작업 내역 지우기', 'bool', null, null, false],
];

/** Tools that paint with brush tips and the brush settings. */
export const BRUSH_TOOLS = ['brush', 'eraser', 'mixer', 'historyBrush', 'clone', 'healBrush', 'patternStamp'];

// ---------------------------------------------------------------- presets

const MINE = '내 브러시';
/** Photoshop's default brush groups, with this app's drawn tips. */
const BUILTIN = [
  ['일반 브러시', '부드러운 원', { tip: 'round', size: 30, hardness: 0 }],
  ['일반 브러시', '선명한 원', { tip: 'round', size: 30, hardness: 100 }],
  ['일반 브러시', '부드러운 원 압력 불투명도', { tip: 'round', size: 45, hardness: 0, s: { transferOn: true, opacityCtrl: 'pressure' } }],
  ['일반 브러시', '선명한 원 압력 크기', { tip: 'round', size: 19, hardness: 100, s: { shapeDyn: true, sizeCtrl: 'pressure' } }],
  ['일반 브러시', '에어브러시 부드러운 원', { tip: 'round', size: 65, hardness: 0, flow: 15, s: { spacing: 4, airbrush: true } }],
  ['일반 브러시', '서예 펜', { tip: 'round', size: 24, hardness: 95, s: { spacing: 4, roundness: 22, angle: 40 } }],
  ['일반 브러시', '선명한 사각', { tip: 'square', size: 30, hardness: 100, s: { spacing: 10 } }],
  ['건식 재료 브러시', '분필', { tip: 'chalk', size: 36, hardness: 80, s: { spacing: 18, shapeDyn: true, angleJitter: 100, sizeJitter: 12 } }],
  ['건식 재료 브러시', '목탄', { tip: 'chalk', size: 30, hardness: 60, s: { spacing: 12, textureOn: true, texPattern: 'paper', texDepth: 80, texContrast: 60 } }],
  ['건식 재료 브러시', '연필 스케치', { tip: 'round', size: 6, hardness: 70, s: { spacing: 8, textureOn: true, texPattern: 'noise', texDepth: 55, transferOn: true, opacityJitter: 25 } }],
  ['건식 재료 브러시', '크레용', { tip: 'chalk', size: 24, hardness: 90, s: { spacing: 10, textureOn: true, texPattern: 'paper', texDepth: 100, texContrast: 50, texMode: 'height' } }],
  ['습식 재료 브러시', '수채 붓털', { tip: 'bristle', size: 40, hardness: 60, s: { spacing: 6, transferOn: true, opacityJitter: 30, shapeDyn: true, angleCtrl: 'direction' } }],
  ['습식 재료 브러시', '수채화 젖은 가장자리', { tip: 'round', size: 50, hardness: 40, flow: 70, s: { spacing: 8, wetEdges: true } }],
  ['습식 재료 브러시', '유화 붓', { tip: 'bristle', size: 34, hardness: 80, s: { spacing: 4, shapeDyn: true, angleCtrl: 'direction', textureOn: true, texPattern: 'noise', texDepth: 35, transferOn: true, flowJitter: 20 } }],
  ['습식 재료 브러시', '마른 붓 (이중 브러시)', { tip: 'round', size: 40, hardness: 90, s: { spacing: 6, dualOn: true, dualTip: 'spray', dualSize: 60, dualSpacing: 10, dualScatter: 30, dualMode: 'multiply' } }],
  ['특수 효과 브러시', '스프레이', { tip: 'spray', size: 40, hardness: 100, s: { spacing: 30, shapeDyn: true, angleJitter: 100 } }],
  ['특수 효과 브러시', '나뭇잎 흩뿌리기', { tip: 'leaf', size: 40, hardness: 90, s: { spacing: 60, scatterOn: true, scatter: 150, count: 2, shapeDyn: true, sizeJitter: 60, angleJitter: 100, colorDyn: true, fgbgJitter: 60, hueJitter: 6 } }],
  ['특수 효과 브러시', '풀', { tip: 'grass', size: 50, hardness: 90, s: { spacing: 35, scatterOn: true, scatter: 60, shapeDyn: true, sizeJitter: 50, angleJitter: 6, colorDyn: true, fgbgJitter: 50 } }],
  ['특수 효과 브러시', '별 흩뿌리기', { tip: 'star', size: 30, hardness: 90, s: { spacing: 90, scatterOn: true, scatter: 200, count: 2, shapeDyn: true, sizeJitter: 70, angleJitter: 100, colorDyn: true, hueJitter: 30 } }],
  ['특수 효과 브러시', '점 무리', { tip: 'dots', size: 36, hardness: 90, s: { spacing: 50, scatterOn: true, scatter: 100, shapeDyn: true, sizeJitter: 40, angleJitter: 100 } }],
  ['특수 효과 브러시', '보케 (빛망울)', { tip: 'round', size: 60, hardness: 75, s: { spacing: 120, scatterOn: true, scatter: 300, bothAxes: true, count: 2, shapeDyn: true, sizeJitter: 70, transferOn: true, opacityJitter: 70, colorDyn: true, hueJitter: 8, briJitter: 20 } }],
].map(([group, name, p], i) => ({ id: `b${i}`, group, name, ...p, builtin: true }));

let userPresets = [];
/** Ids of the sampled tips kept in this browser: [{ id, name }]. */
let savedTips = [];
const allPresets = () => [...BUILTIN, ...userPresets];
const presetById = (id) => allPresets().find((p) => p.id === id) || null;
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const savePresets = () => resPut('brushPresets', userPresets).catch(() => toast('브라우저 저장 공간이 모자라 브러시를 기억하지 못했습니다'));
const saveTipList = () => resPut('brushTips', savedTips).catch(() => {});
const canvasPng = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

/** Keep a sampled tip: register it and store its picture. */
async function keepTip(id, name, canvas) {
  addSampledTip(id, name, canvas);
  if (!savedTips.some((t) => t.id === id)) savedTips.push({ id, name });
  await resPut(`brushTip:${id}`, { blob: await canvasPng(canvas), w: canvas.width, h: canvas.height });
}

/** The brush settings that differ from the defaults (what a preset keeps). */
function presetSettings(o) {
  const D = normDyn(o);
  const s = {};
  for (const k of DYN_KEYS) if (D[k] !== DYN[k] && k !== 'smoothing' && k !== 'smoothingOn') s[k] = D[k];
  return s;
}

/** Make a tool use a preset: its tip, size, hardness and every brush setting (others back to default). */
function applyPreset(P, toolId, pr) {
  const o = P.opts(toolId);
  const keep = o.protectTexture && o.textureOn ? { texPattern: o.texPattern, texScale: o.texScale } : null;
  for (const k of DYN_KEYS) if (k !== 'smoothing' && k !== 'smoothingOn') o[k] = DYN[k];
  delete o.followDir;
  delete o.scatterLegacy;
  Object.assign(o, pr.s || {});
  if (keep && o.textureOn) Object.assign(o, keep);
  o.tip = hasTip(pr.tip) ? pr.tip : 'round';
  o.hardness = pr.hardness ?? (isDrawnTip(o.tip) ? o.hardness : 100);
  o.flow = pr.flow ?? 100;
  // presets saved with their tool settings (imported from Photoshop) also set these
  if (pr.opacity != null) o.opacity = pr.opacity;
  if (pr.blend) o.blend = pr.blend;
  o._preset = pr.id;
  // one setOpt saves everything and tells the bars and panels
  P.setOpt(toolId, 'size', clamp(Math.round(pr.size || o.size), 1, 5000));
}

// ---------------------------------------------------------------- styles

injectStyle('ph-brushpanel-css', `
.bp-presets { display: flex; flex-direction: column; gap: 6px; }
.bp-group > button.bp-ghead { width: 100%; display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 2px 0; min-height: 0; color: var(--text-dim); font-size: var(--fs-s); text-align: left; }
.bp-group > button.bp-ghead .bp-count { margin-left: auto; color: var(--text-faint); font-size: var(--fs-xs); }
.bp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(52px * var(--ui-scale)), 1fr)); gap: 4px; }
.bp-cell { position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 3px 2px 2px; min-height: 0; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; }
.bp-cell:hover { border-color: var(--line-2); background: var(--bg-3); }
.bp-cell.on { border-color: var(--accent); background: var(--accent-soft); }
.bp-cell canvas { width: calc(40px * var(--ui-scale)); height: calc(40px * var(--ui-scale)); display: block; }
.bp-cell .bp-size { position: absolute; left: 3px; top: 1px; font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.bp-cell .bp-name { max-width: 100%; font-size: 10px; line-height: 1.2; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-row { display: flex; align-items: center; gap: 6px; font-size: var(--fs-s); color: var(--text-dim); }
.bp-row > span:first-child { min-width: calc(64px * var(--ui-scale)); }
.bp-row input[type=range] { flex: 1; min-width: 60px; }
.bp-row .ph-num { width: calc(56px * var(--ui-scale)); }
.bp-row select { flex: 1; min-width: 0; }
.bp-row small { color: var(--text-faint); min-width: 18px; }
.bp-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.bp-actions button { display: inline-flex; align-items: center; gap: 4px; }
.bp-pop { position: fixed; z-index: 60; width: calc(330px * var(--ui-scale)); max-height: 70vh; overflow: auto; padding: 10px; background: var(--bg-2); border: 1px solid var(--line-2); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.45); display: flex; flex-direction: column; gap: 8px; }
.bp-sections { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 6px; }
.bp-sec { display: flex; align-items: center; gap: 5px; padding: 2px 4px; border-radius: 4px; font-size: var(--fs-s); color: var(--text-dim); cursor: pointer; user-select: none; }
.bp-sec:hover { background: var(--bg-3); }
.bp-sec.on { background: var(--accent-soft); color: var(--value); }
.bp-sec input { margin: 0; }
.bp-body { display: flex; flex-direction: column; gap: 5px; border-top: 1px solid var(--line); padding-top: 6px; }
.bp-title { font-weight: 600; font-size: var(--fs-s); color: var(--text); }
.bp-tips { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(34px * var(--ui-scale)), 1fr)); gap: 3px; max-height: calc(132px * var(--ui-scale)); overflow: auto; padding: 2px; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; }
.bp-tips button { padding: 1px; min-height: 0; background: none; border: 1px solid transparent; border-radius: 4px; }
.bp-tips button.on { border-color: var(--accent); background: var(--accent-soft); }
.bp-tips canvas { width: calc(30px * var(--ui-scale)); height: calc(30px * var(--ui-scale)); display: block; }
.bp-preview { width: 100%; height: calc(64px * var(--ui-scale)); background: #fff; border-radius: 5px; display: block; flex-shrink: 0; }
.bp-note { color: var(--text-faint); font-size: var(--fs-xs); }
.ph-bpbtn { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; }
.ph-bpbtn canvas { width: 22px; height: 22px; display: block; }
body.mobile .bp-cell canvas { width: 46px; height: 46px; }
body.mobile .bp-row input[type=range] { min-height: 28px; }
`);

// ---------------------------------------------------------------- shared pieces

const thumbCache = new Map();
/** A preset's tip thumbnail (cached per preset look). */
function presetThumb(pr, size = 40) {
  const key = `${pr.tip}|${pr.hardness ?? 100}|${pr.s?.roundness ?? 100}|${pr.s?.angle ?? 0}|${size}`;
  let c = thumbCache.get(key);
  if (!c) {
    const t = tipThumb(hasTip(pr.tip) ? pr.tip : 'round', size, (pr.hardness ?? 100) / 100);
    c = makeCanvas(size, size);
    const g = c.getContext('2d');
    g.translate(size / 2, size / 2);
    g.rotate(((pr.s?.angle || 0) * Math.PI) / 180);
    g.scale(1, (pr.s?.roundness ?? 100) / 100);
    g.drawImage(t, -size / 2, -size / 2);
    if (thumbCache.size > 600) thumbCache.clear();
    thumbCache.set(key, c);
  }
  const out = makeCanvas(size, size);
  out.getContext('2d').drawImage(c, 0, 0);
  return out;
}

/** A labelled slider with a number box. */
function rangeRow(label, min, max, value, unit, onSet, { step = 1 } = {}) {
  const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const n = h('input.ph-num', { type: 'number', min, max, step, value, 'aria-label': label });
  const set = (v, done) => {
    v = clamp(Math.round(+v / step) * step, min, max);
    if (Number.isNaN(v)) return;
    r.value = v;
    n.value = v;
    onSet(v, done);
  };
  r.addEventListener('input', () => set(r.value, false));
  r.addEventListener('change', () => set(r.value, true));
  n.addEventListener('change', () => set(n.value, true));
  const el = h('label.bp-row', h('span', label), r, n, unit ? h('small', unit) : null);
  el.update = (v) => {
    r.value = v;
    n.value = v;
  };
  return el;
}

function selectRow(label, list, value, onSet) {
  const s = h('select', { 'aria-label': label }, list.map(([v, t]) => h('option', { value: v }, t)));
  s.value = value;
  s.addEventListener('change', () => onSet(s.value));
  return h('label.bp-row', h('span', label), s);
}

function checkRow(label, value, onSet) {
  const b = h('input', { type: 'checkbox', checked: !!value });
  b.addEventListener('change', () => onSet(b.checked));
  return h('label.bp-row', b, h('span', label));
}

/** The presets in their groups; onPick(preset), onMenu(preset, x, y). */
function presetList(P, toolId, { onPick, onMenu, filter = '' }) {
  const o = P.opts(toolId);
  const open = loadPref('photo.brushGroups', {});
  const groups = new Map();
  const q = filter.trim().toLowerCase();
  for (const pr of allPresets()) {
    if (q && !(pr.name || tipName(pr.tip)).toLowerCase().includes(q)) continue;
    const g = pr.group || MINE;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(pr);
  }
  const el = h('div.bp-presets');
  for (const [g, list] of groups) {
    const shown = q || open[g] !== false;
    const grid = h('div.bp-grid', { hidden: !shown });
    const head = h('button.bp-ghead', {
      onclick: () => {
        open[g] = grid.hidden;
        grid.hidden = !grid.hidden;
        savePref('photo.brushGroups', open);
        head.firstChild.replaceWith(icon(grid.hidden ? 'chevRight' : 'chevDown', 12));
      },
    }, icon(shown ? 'chevDown' : 'chevRight', 12), h('span', g), h('span.bp-count', String(list.length)));
    for (const pr of list) {
      const name = pr.name || tipName(pr.tip);
      const cell = h(`button.bp-cell${o._preset === pr.id ? '.on' : ''}`, { title: `${name} (${pr.size}px)`, 'aria-label': name, onclick: () => onPick(pr) },
        presetThumb(pr), h('span.bp-size', String(pr.size)), h('span.bp-name', name));
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        onMenu?.(pr, e.clientX, e.clientY);
      });
      let timer = 0;
      cell.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse') timer = setTimeout(() => onMenu?.(pr, e.clientX, e.clientY), 550);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cell.addEventListener(ev, () => clearTimeout(timer));
      grid.append(cell);
    }
    el.append(h('div.bp-group', head, grid));
  }
  if (!groups.size) el.append(h('div.bp-note', '맞는 브러시가 없습니다'));
  return el;
}

// ---------------------------------------------------------------- install

// ---- number keys: 1-9 / 0 set the opacity in tens, two quick digits an exact value (4 then 5: 45%),
// Shift with them the flow; with the airbrush on it is the other way round (Photoshop). Listened to
// from when this module loads, so it comes before the editor's own number keys (layer opacity).
let keysP = null;
let lastDigit = null;
window.addEventListener('keydown', (e) => {
  const P = keysP;
  const m = /^(Digit|Numpad)([0-9])$/.exec(e.code);
  if (!P || !m || e.ctrlKey || e.metaKey || e.altKey || !document.body.classList.contains('photo-mode')) return;
  const t = e.target;
  if (t?.isContentEditable || ['TEXTAREA', 'SELECT'].includes(t?.tagName) || (t?.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type))) return;
  if (document.querySelector('.modal-backdrop, .menu')) return;
  const id = P.tool;
  const opts = TOOL_BY_ID[id]?.options || [];
  const has = (k) => opts.some((x) => x[0] === k);
  if (!has('flow') && !has('opacity')) return;
  const air = has('flow') && !!P.opts(id).airbrush;
  const key = e.shiftKey !== air ? 'flow' : 'opacity';
  if (!has(key)) return;
  const d = +m[2];
  const now = performance.now();
  let v;
  if (lastDigit && lastDigit.id === id && lastDigit.key === key && now - lastDigit.t < 600) {
    v = lastDigit.d * 10 + d;
    lastDigit = null;
  } else {
    v = d === 0 ? 100 : d * 10;
    lastDigit = { id, key, d, t: now };
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  P.setOpt(id, key, clamp(v, 1, 100));
}, true);

export function installBrushPanels(P) {
  const C = P.cmd;
  keysP = P;
  /** The tool the brush panels change: the current one when it paints with brushes. */
  const target = () => (BRUSH_TOOLS.includes(P.tool) && TOOL_BY_ID[P.tool] ? P.tool : 'brush');

  for (const id of ['brush', 'eraser']) TOOL_BY_ID[id].options = id === 'brush' ? BRUSH_BAR : ERASER_BAR;

  // ---- loading what was saved in this browser
  const loaded = (async () => {
    // anything added before the saved lists came in is kept
    const early = { tips: savedTips, presets: userPresets };
    savedTips = (await resGet('brushTips')) || [];
    for (const t of early.tips) if (!savedTips.some((x) => x.id === t.id)) savedTips.push(t);
    for (const t of savedTips) {
      if (early.tips.includes(t)) continue;
      try {
        const rec = await resGet(`brushTip:${t.id}`);
        if (rec?.blob) addSampledTip(t.id, t.name, await blobCanvas(rec.blob));
      } catch {
        // a tip that cannot be read is left out
      }
    }
    userPresets = ((await resGet('brushPresets')) || []).filter((p) => p && p.id);
    for (const p of early.presets) if (!userPresets.some((x) => x.id === p.id)) userPresets.push(p);
    // brushes defined before they were kept here lived in the preferences as data URLs
    const legacy = loadPref('photo.brushTips', []);
    if (legacy.length) {
      for (const t of legacy) {
        if (savedTips.some((x) => x.id === t.id) || !t.data) continue;
        try {
          const c = await blobCanvas(await (await fetch(t.data)).blob());
          await keepTip(t.id, t.name, c);
          userPresets.push({ id: uid('u'), group: MINE, name: t.name, tip: t.id, size: Math.max(c.width, c.height), s: {} });
        } catch {
          // skip
        }
      }
      await saveTipList();
      await savePresets();
      savePref('photo.brushTips', []);
    }
    P.emit('brushes');
    P.emit('opts');
  })().catch(() => {});

  const persistAll = async () => {
    await saveTipList();
    await savePresets();
    P.emit('brushes');
  };

  // ---- preset actions
  const pickPreset = (pr) => {
    applyPreset(P, target(), pr);
    P.emit('brushes');
  };
  const newPreset = async () => {
    const id = target();
    const o = P.opts(id);
    const name = await promptDialog('새 브러시 사전 설정', '이름', `${tipName(o.tip || 'round')} ${o.size}`);
    if (!name) return;
    const pr = { id: uid('u'), group: MINE, name: name.slice(0, 40), tip: o.tip || 'round', size: o.size, hardness: o.hardness, flow: o.flow, s: presetSettings(o) };
    userPresets.push(pr);
    P.opts(id)._preset = pr.id;
    await persistAll();
    toast(`"${pr.name}" 브러시 사전 설정을 만들었습니다`);
  };
  const tipInUse = (tip) => allPresets().some((p) => p.tip === tip);
  const deletePresets = async (list) => {
    userPresets = userPresets.filter((p) => !list.includes(p));
    for (const pr of list) {
      if (!isDrawnTip(pr.tip) && !tipInUse(pr.tip)) {
        removeTip(pr.tip);
        savedTips = savedTips.filter((t) => t.id !== pr.tip);
        await resDel(`brushTip:${pr.tip}`);
      }
    }
    await persistAll();
  };
  const presetMenu = (pr, x, y) => {
    const group = userPresets.filter((p) => (p.group || MINE) === (pr.group || MINE));
    showMenu([
      { label: '이 브러시 쓰기', action: () => pickPreset(pr) },
      { label: '이름 바꾸기…', disabled: pr.builtin, action: async () => {
        const n = await promptDialog('브러시 이름 바꾸기', '이름', pr.name || tipName(pr.tip));
        if (!n) return;
        pr.name = n.slice(0, 40);
        await persistAll();
      } },
      { label: '브러시 삭제', disabled: pr.builtin, action: () => deletePresets([pr]) },
      { label: `"${pr.group || MINE}" 그룹 모두 삭제`, disabled: pr.builtin || !group.length, action: async () => {
        if (await confirmDialog('브러시 그룹 삭제', `"${pr.group || MINE}" 그룹의 브러시 ${group.length}개를 지울까요?`)) await deletePresets(group);
      } },
      '-',
      { label: '새 브러시 사전 설정…', action: () => newPreset() },
      { label: '브러시 가져오기… (.abr)', action: () => C.importBrushes() },
    ], x, y);
  };

  // ---- Edit ▸ Define Brush Preset: the selection (or the picture), dark = paint, at its own size
  C.defineBrush = async () => {
    const doc = P.doc;
    if (!doc) return;
    const sel = doc.selection;
    const r = sel ? P.selBounds(sel.canvas) : { x: 0, y: 0, w: doc.width, h: doc.height };
    if (!r || r.w < 1 || r.h < 1) return void toast('선택 영역이 비어 있습니다');
    // Photoshop keeps up to 5000 px; 2500 keeps memory in check
    const k = Math.min(1, 2500 / Math.max(r.w, r.h));
    const w = Math.max(1, Math.round(r.w * k));
    const hh = Math.max(1, Math.round(r.h * k));
    const c = makeCanvas(w, hh);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, hh);
    g.drawImage(P.composite(), r.x, r.y, r.w, r.h, 0, 0, w, hh);
    const d = g.getImageData(0, 0, w, hh).data;
    let sa = null;
    if (sel) {
      const t = makeCanvas(w, hh);
      const tg = t.getContext('2d', { willReadFrequently: true });
      tg.drawImage(sel.canvas, r.x, r.y, r.w, r.h, 0, 0, w, hh);
      sa = tg.getImageData(0, 0, w, hh).data;
    }
    const gray = new Uint8Array(w * hh);
    let tot = 0;
    for (let i = 0; i < w * hh; i++) {
      // dark = paint, like Photoshop
      const a = (255 - (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2])) * (sa ? sa[i * 4 + 3] / 255 : 1);
      gray[i] = a;
      tot += a;
    }
    if (tot < w * hh * 2) return void toast('어두운 부분이 브러시 모양이 됩니다. 흰 바탕에 검게 그린 뒤 다시 해 보세요.');
    // the white around the shape is trimmed away, like Photoshop
    let x0 = w;
    let y0 = hh;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        if (gray[y * w + x] < 3) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const tw = x1 - x0 + 1;
    const th = y1 - y0 + 1;
    const trimmed = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) trimmed.set(gray.subarray((y + y0) * w + x0, (y + y0) * w + x0 + tw), y * tw);
    const name = await promptDialog('브러시 사전 설정 정의', '이름', `샘플 브러시 ${userPresets.length + 1}`);
    if (!name) return;
    const id = uid('tip:');
    await keepTip(id, name.slice(0, 40), tipFromGray(trimmed, tw, th));
    const pr = { id: uid('u'), group: MINE, name: name.slice(0, 40), tip: id, size: Math.max(tw, th), s: { spacing: 25 } };
    userPresets.push(pr);
    await persistAll();
    P.setTool('brush');
    applyPreset(P, 'brush', pr);
    toast(`"${pr.name}" 브러시를 만들어 브러시 도구에 골라 두었습니다 (크기 ${pr.size}px)`);
  };

  // ---- Photoshop brushes (.abr): tips, presets and the textures they use
  const importAbr = async (file) => {
    const res = parseAbr(await file.arrayBuffer());
    const base = file.name.replace(/\.[^.]+$/, '');
    // textures first, so presets can point at them
    const patIds = new Map();
    const pats = res.patterns.map((p) => {
      const c = makeCanvas(p.w, p.h);
      c.getContext('2d').putImageData(new ImageData(p.rgba, p.w, p.h), 0, 0);
      return { canvas: c, name: p.name };
    });
    if (pats.length) {
      keepImportedPatterns(pats).forEach((pid, i) => {
        patIds.set(res.patterns[i].id, pid);
        patIds.set(`name:${res.patterns[i].name}`, pid);
      });
      P.emit('patterns');
    }
    const tipIds = new Map();
    let n = 0;
    for (const t of res.tips) {
      const id = uid('abr:');
      await keepTip(id, t.name || `${base} ${++n}`, tipFromGray(t.gray, t.w, t.h));
      tipIds.set(t.key, id);
    }
    const added = [];
    res.presets.forEach((p, i) => {
      const tip = p.tip === 'round' ? 'round' : tipIds.get(p.tip);
      if (!tip) return;
      const s = { ...p.s };
      if (s.texPatternRef) {
        const pid = patIds.get(s.texPatternRef.id) || patIds.get(`name:${s.texPatternRef.name}`);
        if (pid) s.texPattern = pid;
        else s.textureOn = false;
        delete s.texPatternRef;
      }
      if (s.dualTipRef) {
        const dt = s.dualTipRef === 'round' ? 'round' : tipIds.get(s.dualTipRef);
        if (dt) s.dualTip = dt;
        else s.dualOn = false;
        delete s.dualTipRef;
      }
      for (const [k, v] of Object.entries(s)) if (!(k in DYN) || typeof v !== typeof DYN[k]) delete s[k];
      const pr = { id: uid('u'), group: base, name: p.name || `${base} ${i + 1}`, tip, size: clamp(Math.round(p.size), 1, 5000), hardness: p.hardness, s };
      // presets saved with their tool settings
      for (const k of ['flow', 'opacity', 'blend']) if (p[k] != null) pr[k] = p[k];
      added.push(pr);
    });
    // tips take their preset's name
    for (const pr of added) {
      const t = savedTips.find((x) => x.id === pr.tip);
      if (t && t.name !== pr.name) {
        t.name = pr.name;
        renameTip(pr.tip, pr.name);
      }
    }
    userPresets.push(...added);
    await persistAll();
    return added.length;
  };
  C.importBrushes = async (files = null) => {
    if (!files) {
      const { pickFiles } = await import('../ui/project-panel.js');
      files = await pickFiles({ accept: '.abr', multiple: true });
    }
    let total = 0;
    for (const f of files) {
      try {
        const n = await importAbr(f);
        total += n;
        toast(n ? `${f.name}: 브러시 ${n}개를 가져왔습니다 (브러시 패널의 "${f.name.replace(/\.[^.]+$/, '')}" 그룹)` : `${f.name}: 가져올 브러시가 없습니다`);
      } catch (err) {
        toast(`${f.name}: 브러시 파일을 읽을 수 없습니다 (${err.message || err})`);
      }
    }
    if (total) P.showPanel('brushes');
    return total;
  };
  // .abr files opened or dropped on the photo editor go into the Brushes panel, like Photoshop
  const openFiles = P.openFiles;
  P.openFiles = async (files) => {
    const list = [...files];
    const abr = list.filter((f) => /\.abr$/i.test(f.name));
    if (abr.length) await C.importBrushes(abr);
    const rest = list.filter((f) => !abr.includes(f));
    if (rest.length) return openFiles(rest);
    return undefined;
  };

  // ---- options bar: the preset picker and the Brush Settings button
  let pop = null;
  const closePop = () => {
    pop?.remove();
    pop = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', popKeys, true);
  };
  const outside = (e) => {
    if (pop && !pop.contains(e.target) && !e.target.closest?.('.ph-bpbtn')) closePop();
  };
  // Enter or Esc closes it, like Photoshop (wherever the keyboard is)
  const popKeys = (e) => {
    if (!pop || (e.key !== 'Escape' && !(e.key === 'Enter' && e.target.type !== 'search'))) return;
    // a number being typed counts
    if (e.key === 'Enter' && pop.contains(e.target) && e.target.type === 'number') e.target.dispatchEvent(new Event('change'));
    e.preventDefault();
    e.stopImmediatePropagation();
    closePop();
  };
  /**
   * The Brush Preset picker under an anchor element or at a point { x, y } (right-click on the
   * picture). Tools that paint with brush presets get the list; the other brush-shaped tools (dodge,
   * blur, pencil…) only their size and hardness, like Photoshop.
   */
  const openPicker = (anchor, toolId = target()) => {
    if (pop) return closePop();
    const id = toolId;
    const presets = BRUSH_TOOLS.includes(id);
    const body = h('div.bp-pop', { role: 'dialog', 'aria-label': '브러시 사전 설정 피커' });
    const render = () => {
      const oo = P.opts(id);
      const hasHard = TOOL_BY_ID[id]?.options?.some((x) => x[0] === 'hardness');
      if (!presets) {
        body.replaceChildren(
          rangeRow('크기', 1, 1000, oo.size, 'px', (v) => P.setOpt(id, 'size', v)),
          hasHard ? rangeRow('경도', 0, 100, oo.hardness, '%', (v) => P.setOpt(id, 'hardness', v)) : null,
          h('div.bp-note', `${TOOL_BY_ID[id]?.name || ''} 도구의 브러시 크기${hasHard ? '와 경도' : ''}`));
        return;
      }
      const search = h('input', { type: 'search', placeholder: '브러시 찾기', value: body.dataset.q || '', 'aria-label': '브러시 찾기' });
      search.addEventListener('input', () => {
        body.dataset.q = search.value;
        listBox.replaceChildren(presetList(P, id, { onPick: (pr) => { pickPreset(pr); render(); }, onMenu: presetMenu, filter: search.value }));
      });
      const listBox = h('div', presetList(P, id, { onPick: (pr) => { pickPreset(pr); render(); }, onMenu: presetMenu, filter: body.dataset.q || '' }));
      body.replaceChildren(
        rangeRow('크기', 1, 1000, oo.size, 'px', (v) => P.setOpt(id, 'size', v)),
        isDrawnTip(oo.tip || 'round') ? rangeRow('경도', 0, 100, oo.hardness, '%', (v) => P.setOpt(id, 'hardness', v)) : h('div.bp-note', '샘플 브러시는 경도가 없습니다'),
        search,
        listBox,
        h('div.bp-actions',
          h('button.small', { onclick: () => newPreset().then(render) }, icon('plus', 13), '새 브러시'),
          h('button.small', { onclick: () => C.importBrushes().then(render) }, icon('import', 13), '가져오기…'),
          h('button.small', { onclick: () => { closePop(); P.showPanel('brushSettings'); } }, icon('sliders', 13), '브러시 설정')),
      );
    };
    render();
    document.body.append(body);
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y };
    body.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - body.offsetWidth - 8))}px`;
    body.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - body.offsetHeight - 8))}px`;
    pop = body;
    // opened on the picture: the size is ready to be typed over
    if (!anchor.getBoundingClientRect) {
      const n = body.querySelector('input[type=number]');
      n?.focus({ preventScroll: true });
      n?.select();
    }
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', popKeys, true);
  };
  P.on('tool', closePop);
  const pickerButton = (id) => {
    const o = P.opts(id);
    const pr = presetById(o._preset);
    const t = tipThumb(hasTip(o.tip) ? o.tip : 'round', 22, (o.hardness ?? 100) / 100);
    return h('button.small.ph-bpbtn', { title: `브러시 사전 설정 피커: ${pr?.name || tipName(o.tip || 'round')}`, 'aria-label': '브러시 사전 설정 피커', onclick: (e) => openPicker(e.currentTarget) }, t, h('span', String(o.size)), icon('chevDown', 11));
  };
  const settingsButton = () => h('button.small', { title: '브러시 설정 패널 (F5)', 'aria-label': '브러시 설정 패널', onclick: () => P.showPanel('brushSettings') }, icon('sliders', 14));
  /** The preset picker and Brush Settings buttons, first in a brush tool's options bar. */
  P.brushOptionButtons = (id) => [pickerButton(id), settingsButton()];
  P.brushLead = (id) => {
    const t = TOOL_BY_ID[id];
    if (t) t.leadButtons = () => P.brushOptionButtons(id);
  };
  for (const id of ['brush', 'eraser']) P.brushLead(id);

  // ---- on the picture: right-click opens the picker, Alt+right-drag (Ctrl+Alt+drag on a Mac)
  // sizes the brush (sideways) and sets its hardness (up and down), like Photoshop
  const onPicture = (e) => document.body.classList.contains('photo-mode') && P.doc && !document.querySelector('.modal-backdrop') && !!e.target.matches?.('.ph-stage canvas.ph-view, .ph-stage canvas.ph-over');
  /** Tools whose brush the picker and the on-picture sizing change. */
  const brushShaped = (id) => {
    const t = TOOL_BY_ID[id];
    return !!t && (t.group === 'paint' || t.group === 'retouch') && id !== 'redEye' && t.options?.some((x) => x[0] === 'size');
  };
  let sizing = null;
  let eatMenu = 0;
  window.addEventListener('contextmenu', (e) => {
    if (!onPicture(e)) return;
    if (sizing || e.altKey || performance.now() < eatMenu) {
      // the end of an Alt+right-drag: no menu
      eatMenu = 0;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!brushShaped(P.tool) || TOOL_BY_ID[P.tool]?.st) return;
    e.preventDefault();
    e.stopPropagation();
    closePop();
    openPicker({ x: e.clientX, y: e.clientY }, P.tool);
  }, true);
  const hud = h('div', { style: { position: 'fixed', zIndex: 70, pointerEvents: 'none', borderRadius: '50%', border: '1px solid rgba(255,255,255,.9)', boxShadow: '0 0 0 1px rgba(0,0,0,.6)', display: 'none' } });
  const hudText = h('div', { style: { position: 'fixed', zIndex: 71, pointerEvents: 'none', padding: '3px 7px', borderRadius: '4px', background: 'rgba(20,20,20,.85)', color: '#fff', font: '12px/1.4 sans-serif', whiteSpace: 'nowrap', display: 'none' } });
  const showHud = () => {
    const { x, y, id } = sizing;
    const o = P.opts(id);
    const d = Math.max(2, (o.size || 1) * (P.view.zoom || 1));
    const hard = clamp(o.hardness ?? 100, 0, 100);
    Object.assign(hud.style, { display: 'block', left: `${x - d / 2}px`, top: `${y - d / 2}px`, width: `${d}px`, height: `${d}px`,
      background: `radial-gradient(circle closest-side, rgba(255,40,40,.55) ${hard * 0.98}%, rgba(255,40,40,0) 100%)` });
    hudText.textContent = sizing.hard ? `지름 ${o.size} px · 경도 ${o.hardness}%` : `지름 ${o.size} px`;
    Object.assign(hudText.style, { display: 'block', left: `${x + d / 2 + 8}px`, top: `${y - 12}px` });
  };
  window.addEventListener('pointerdown', (e) => {
    const mac = e.ctrlKey && e.altKey && e.button === 0;
    if (!((e.altKey && e.button === 2) || mac) || !onPicture(e) || !brushShaped(P.tool)) return;
    e.preventDefault();
    e.stopPropagation();
    closePop();
    const id = P.tool;
    const o = P.opts(id);
    sizing = { id, x: e.clientX, y: e.clientY, size: o.size || 1, hardness: o.hardness ?? 100, hard: TOOL_BY_ID[id].options.some((x) => x[0] === 'hardness') && isDrawnTip(o.tip || 'round') };
    if (!hud.isConnected) document.body.append(hud, hudText);
    showHud();
    let raf = 0;
    let last = e;
    const move = (ev) => {
      last = ev;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!sizing) return;
        const z = P.view.zoom || 1;
        const max = TOOL_BY_ID[id].options.find((x) => x[0] === 'size')?.[4] || 1000;
        P.setOpt(id, 'size', clamp(Math.round(sizing.size + ((last.clientX - sizing.x) * 2) / z), 1, max));
        if (sizing.hard) P.setOpt(id, 'hardness', clamp(Math.round(sizing.hardness - (last.clientY - sizing.y) / 2), 0, 100));
        showHud();
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      cancelAnimationFrame(raf);
      sizing = null;
      eatMenu = performance.now() + 300;
      hud.style.display = 'none';
      hudText.style.display = 'none';
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }, true);

  // ---- Brushes panel
  const brushesEl = h('div.ph-panel.bp-brushes');
  let brushesQ = '';
  const renderBrushes = () => {
    if (pop) return;
    const id = target();
    const o = P.opts(id);
    const search = h('input', { type: 'search', placeholder: '브러시 찾기', value: brushesQ, 'aria-label': '브러시 찾기' });
    const listBox = h('div', presetList(P, id, { onPick: pickPreset, onMenu: presetMenu, filter: brushesQ }));
    search.addEventListener('input', () => {
      brushesQ = search.value;
      listBox.replaceChildren(presetList(P, id, { onPick: pickPreset, onMenu: presetMenu, filter: brushesQ }));
    });
    brushesEl.replaceChildren(
      h('div.bp-note', `${TOOL_BY_ID[id].name} 도구에 쓸 브러시 · 오른쪽 클릭(길게 누르기)으로 이름 바꾸기·삭제`),
      rangeRow('크기', 1, 1000, o.size, 'px', (v) => P.setOpt(id, 'size', v)),
      search,
      listBox,
      h('div.bp-actions',
        h('button.small', { title: '지금 설정을 새 브러시 사전 설정으로', onclick: () => newPreset() }, icon('plus', 13), '새 브러시'),
        h('button.small', { title: 'Photoshop 브러시 파일 (.abr)', onclick: () => C.importBrushes() }, icon('import', 13), '브러시 가져오기…'),
        h('button.small', { title: '선택 영역의 어두운 부분으로 브러시 만들기', onclick: () => C.defineBrush() }, icon('brush', 13), '브러시 정의…'),
        h('button.small', { onclick: () => P.showPanel('brushSettings') }, icon('sliders', 13), '브러시 설정')),
    );
  };
  P.addPanel('brushes', '브러시', brushesEl, 'top');

  // ---- Brush Settings panel
  const settingsEl = h('div.ph-panel.bp-settings');
  P.addPanel('brushSettings', '브러시 설정', settingsEl, 'top');
  let section = loadPref('photo.brushSection', 'tip');
  let selfChange = false;
  const preview = h('canvas.bp-preview', { width: 560, height: 128, title: '미리 보기' });
  const drawPreview = () => {
    const id = target();
    const o = P.opts(id);
    const eraser = id === 'eraser';
    const col = eraser ? '#333333' : P.fg;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16));
    preview.style.background = 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#2b2b2b' : '#fff';
    try {
      previewStroke(preview, { ...o, size: clamp(o.size || 30, 6, 64) * 2 }, { color: col, bg: P.bg, size: clamp(o.size || 30, 6, 64) * 2 });
    } catch {
      // a preview that cannot be drawn is left blank
    }
  };
  let previewRaf = 0;
  const schedulePreview = () => {
    if (!previewRaf) previewRaf = requestAnimationFrame(() => {
      previewRaf = 0;
      drawPreview();
    });
  };

  const renderSettings = () => {
    if (selfChange) return;
    const id = target();
    const o = P.opts(id);
    const D = normDyn(o);
    const set = (k, v) => {
      selfChange = true;
      try {
        P.setOpt(id, k, v);
      } finally {
        selfChange = false;
      }
      schedulePreview();
    };
    // a change that shows or hides other controls redraws the panel
    const setAndRender = (k, v) => {
      set(k, v);
      renderSettings();
    };
    const R = (k, label, min, max, unit = '%') => rangeRow(label, min, max, D[k] ?? o[k], unit, (v) => set(k, v));
    const S = (k, label, list) => selectRow(label, list, D[k], (v) => setAndRender(k, v));
    const B = (k, label) => checkRow(label, D[k], (v) => set(k, v));
    /** A "조절" menu with its fade steps when it is 희미하게. */
    const Ctrl = (k, fadeKey, list = CONTROLS, label = '조절') => {
      const rows = [S(k, label, list)];
      if (D[k] === 'fade') rows.push(R(fadeKey, '희미하게 단계', 1, 999, '단계'));
      if (D[k] === 'pressure' || D[k] === 'tilt') rows.push(h('div.bp-note', D[k] === 'pressure' ? '펜(스타일러스)으로 칠할 때 누르는 힘을 따릅니다' : '펜을 기울인 정도를 따릅니다'));
      return rows;
    };
    const tipGrid = (key, cur) => h('div.bp-tips', TIP_LIST.map(([tid, name]) => h(`button${tid === cur ? '.on' : ''}`, {
      title: name, 'aria-label': name,
      onclick: () => {
        if (key === 'tip') {
          const sz = tipSize(tid);
          set('tip', tid);
          if (sz && !isDrawnTip(tid)) set('size', Math.max(sz[0], sz[1]));
          delete P.opts(id)._preset;
        } else set(key, tid);
        renderSettings();
      },
    }, tipThumb(tid, 30, 1))));

    const SECTIONS = [
      ['tip', '브러시 모양', null], ['shape', '모양', 'shapeDyn'], ['scatter', '분산', 'scatterOn'], ['texture', '텍스처', 'textureOn'],
      ['dual', '이중 브러시', 'dualOn'], ['color', '색상', 'colorDyn'], ['transfer', '전송', 'transferOn'], ['noise', '노이즈', 'noise'],
      ['wet', '젖은 가장자리', 'wetEdges'], ['buildup', '효과 쌓기', 'airbrush'], ['smooth', '보정', 'smoothingOn'], ['protect', '텍스처 보호', 'protectTexture'],
    ];
    const secList = h('div.bp-sections', SECTIONS.map(([sid, name, flag]) => {
      const box = flag ? h('input', { type: 'checkbox', checked: !!D[flag], 'aria-label': `${name} 사용`, onclick: (e) => e.stopPropagation() }) : null;
      box?.addEventListener('change', () => {
        set(flag, box.checked);
        if (box.checked) section = sid;
        savePref('photo.brushSection', section);
        renderSettings();
      });
      return h(`div.bp-sec${section === sid ? '.on' : ''}`, {
        role: 'button', tabindex: 0,
        onclick: () => {
          section = sid;
          savePref('photo.brushSection', sid);
          renderSettings();
        },
      }, box || h('span', { style: { width: '16px' } }), h('span', name));
    }));

    const body = [];
    const sampled = !isDrawnTip(o.tip || 'round');
    switch (section) {
      case 'shape':
        body.push(R('sizeJitter', '크기 지터', 0, 100), ...Ctrl('sizeCtrl', 'sizeFade'), R('minDiameter', '최소 직경', 0, 100),
          R('angleJitter', '각도 지터', 0, 100), ...Ctrl('angleCtrl', 'angleFade', ANGLE_CONTROLS),
          R('roundJitter', '원형율 지터', 0, 100), ...Ctrl('roundCtrl', 'roundFade'), R('minRoundness', '최소 원형율', 1, 100),
          B('flipXJitter', '가로 뒤집기 지터'), B('flipYJitter', '세로 뒤집기 지터'));
        if (o.pressureSize) body.push(h('div.bp-note', '옵션 막대의 "압력: 크기"가 켜져 있으면 크기는 펜 압력을 따릅니다'));
        break;
      case 'scatter':
        body.push(R('scatter', '분산', 0, 1000), B('bothAxes', '양축'), ...Ctrl('scatterCtrl', 'scatterFade'), R('count', '개수', 1, 16, '개'), R('countJitter', '개수 지터', 0, 100), ...Ctrl('countCtrl', 'countFade'));
        break;
      case 'texture': {
        const pats = listPatterns();
        const sw = h('canvas', { width: 44, height: 44, style: { width: '44px', height: '44px', borderRadius: '4px', border: '1px solid var(--line-2)' } });
        const pc = patternCanvas(D.texPattern);
        const sg = sw.getContext('2d');
        sg.fillStyle = sg.createPattern(pc, 'repeat');
        sg.fillRect(0, 0, 44, 44);
        body.push(h('div.bp-row', sw, h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' } },
          selectRow('패턴', pats.map((p) => [p.id, p.name]), D.texPattern, (v) => setAndRender('texPattern', v)), B('texInvert', '반전'))),
        R('texScale', '비율', 1, 1000), R('texBrightness', '명도', -150, 150, ''), R('texContrast', '대비', -50, 100, ''),
        B('texEachTip', '각 팁에 텍스처 적용'), S('texMode', '모드', TEXTURE_MODES), R('texDepth', '깊이', 0, 100));
        if (D.texEachTip) body.push(R('texMinDepth', '최소 깊이', 0, 100), R('texDepthJitter', '깊이 지터', 0, 100), ...Ctrl('texDepthCtrl', 'texDepthFade'));
        else body.push(h('div.bp-note', '최소 깊이와 깊이 지터는 "각 팁에 텍스처 적용"을 켜면 쓸 수 있습니다'));
        break;
      }
      case 'dual':
        body.push(S('dualMode', '모드', DUAL_MODES), B('dualFlip', '뒤집기'), tipGrid('dualTip', D.dualTip), R('dualSize', '크기', 1, 1000, 'px'), R('dualSpacing', '간격', 1, 1000), R('dualScatter', '분산', 0, 1000), B('dualBothAxes', '양축'), R('dualCount', '개수', 1, 16, '개'));
        break;
      case 'color':
        body.push(B('colorEachTip', '팁별 적용'), R('fgbgJitter', '전경/배경 지터', 0, 100), ...Ctrl('fgbgCtrl', 'fgbgFade'), R('hueJitter', '색조 지터', 0, 100), R('satJitter', '채도 지터', 0, 100), R('briJitter', '밝기 지터', 0, 100), R('purity', '순도', -100, 100));
        if (id === 'eraser') body.push(h('div.bp-note', '지우개에는 색상 설정이 쓰이지 않습니다'));
        break;
      case 'transfer':
        body.push(R('opacityJitter', '불투명도 지터', 0, 100), ...Ctrl('opacityCtrl', 'opacityFade'), R('minOpacity', '최소', 0, 100), R('flowJitter', '흐름 지터', 0, 100), ...Ctrl('flowCtrl', 'flowFade'), R('minFlow', '최소', 0, 100));
        if (o.pressureOpacity) body.push(h('div.bp-note', '옵션 막대의 "압력: 불투명도"가 켜져 있으면 불투명도는 펜 압력을 따릅니다'));
        break;
      case 'noise':
        body.push(B('noise', '노이즈'), h('div.bp-note', '부드러운 가장자리에 거친 알갱이를 더합니다 (단단한 팁에는 거의 차이가 없습니다)'));
        break;
      case 'wet':
        body.push(B('wetEdges', '젖은 가장자리'), h('div.bp-note', '획 가운데는 옅게, 가장자리에 물감이 고인 수채화처럼 칠합니다'));
        break;
      case 'buildup':
        body.push(B('airbrush', '효과 쌓기 (에어브러시)'), h('div.bp-note', '누르고 멈춰 있으면 물감이 계속 쌓입니다 (옵션 막대의 에어브러시와 같음)'));
        break;
      case 'smooth':
        body.push(B('smoothingOn', '보정'), R('smoothing', '보정 정도', 0, 100), h('div.bp-note', '손떨림을 줄여 선을 매끄럽게 합니다 (옵션 막대의 보정과 같음)'));
        break;
      case 'protect':
        body.push(B('protectTexture', '텍스처 보호'), h('div.bp-note', '다른 브러시 사전 설정을 골라도 지금 텍스처 패턴과 비율을 그대로 둡니다'));
        break;
      default: {
        body.push(tipGrid('tip', o.tip || 'round'), R('size', '크기', 1, 1000, 'px'));
        const ts = tipSize(o.tip);
        if (ts && sampled) body.push(h('div.bp-actions', h('button.small', { onclick: () => setAndRender('size', Math.max(...ts)) }, `원본 크기로 (${Math.max(...ts)}px)`)));
        body.push(h('div.bp-row', checkRow('가로 뒤집기', D.flipX, (v) => set('flipX', v)), checkRow('세로 뒤집기', D.flipY, (v) => set('flipY', v))),
          R('angle', '각도', -180, 180, '°'), R('roundness', '원형율', 1, 100));
        if (sampled) body.push(h('div.bp-note', '샘플 브러시는 경도가 없습니다'));
        else body.push(R('hardness', '경도', 0, 100));
        body.push(R('spacing', '간격', 1, 1000));
      }
    }
    const title = SECTIONS.find((s) => s[0] === section)?.[1] || '브러시 모양';
    const pr = presetById(o._preset);
    settingsEl.replaceChildren(
      h('div.bp-note', `${TOOL_BY_ID[id].name} · ${pr?.name || tipName(o.tip || 'round')}${BRUSH_TOOLS.includes(P.tool) ? '' : ' (브러시를 쓰는 도구를 고르면 그 도구의 설정)'}`),
      h('div.bp-actions', h('button.small', { onclick: () => P.showPanel('brushes') }, icon('brush', 13), '브러시 사전 설정'), h('button.small', { onclick: () => newPreset() }, icon('plus', 13), '새로 저장'),
        h('button.small', { title: '모든 설정을 기본값으로', onclick: () => applyPreset(P, id, { id: '', tip: o.tip || 'round', size: o.size, hardness: o.hardness, s: {} }) }, icon('reset', 13), '기본값')),
      preview,
      secList,
      h('div.bp-body', h('div.bp-title', title), ...body),
    );
    schedulePreview();
  };

  // redraw a panel when something it shows changes, once per frame, and only while it is visible
  const panels = [[brushesEl, renderBrushes], [settingsEl, renderSettings]];
  const shown = new Set();
  const stale = new Set();
  let refreshRaf = 0;
  const refresh = () => {
    for (const [el] of panels) stale.add(el);
    if (refreshRaf) return;
    refreshRaf = requestAnimationFrame(() => {
      refreshRaf = 0;
      for (const [el, render] of panels) {
        if (shown.has(el) && stale.has(el)) {
          stale.delete(el);
          render();
        }
      }
    });
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        shown.add(en.target);
        if (stale.has(en.target)) refresh();
      } else shown.delete(en.target);
    }
  });
  for (const [el] of panels) io.observe(el);
  P.on('opts', () => {
    if (!selfChange) refresh();
  });
  P.on('tool', refresh);
  P.on('brushes', refresh);
  P.on('color', () => {
    if (shown.has(settingsEl)) schedulePreview();
  });
  resourceEvents.addEventListener('patterns', () => {
    if (section === 'texture') refresh();
  });
  renderBrushes();
  renderSettings();

  // ---- F5: Brush Settings, like Photoshop (the browser would reload the page)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F5' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!document.body.classList.contains('photo-mode') || document.querySelector('.modal-backdrop')) return;
    e.preventDefault();
    e.stopPropagation();
    P.showPanel('brushSettings');
  }, true);

  // ---- Window menu
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['창'];
    if (!orig) return;
    P.menus['창'] = () => {
      const items = orig();
      const at = items.findIndex((it) => it?.label === '색상');
      const add = [{ label: '브러시 설정', key: 'F5', action: () => P.showPanel('brushSettings') }, { label: '브러시', action: () => P.showPanel('brushes') }];
      if (at < 0) return [...items, ...add];
      return [...items.slice(0, at), ...add, ...items.slice(at)];
    };
  }];
  return loaded;
}
