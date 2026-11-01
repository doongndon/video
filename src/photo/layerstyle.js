// Layer ▸ Layer Style (레이어 스타일): Photoshop's dialog with Styles, Blending Options and the ten
// effects on the left, their settings on the right and a live preview on the canvas. Blending Options
// has fill opacity, channels, knockout, the group options, the mask options and Blend If sliders
// (Alt+drag splits a slider for a soft transition). Effects that Photoshop lets you add more than once
// (stroke, shadows, colour and gradient overlays) have a + button; every effect has a contour where
// Photoshop has one, global light, and "make / reset to default".

import { h, clamp } from '../util.js';
import { openModal, toast } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { FX_NAMES, STYLE_PRESETS, MULTI_FX, CONTOURS, instanceKeys, setInstances, baseKey, fxDefaults, saveFxDefaults, factoryFx, normalizeFx, contourLut } from './styles.js';
import { blendSelect, gradientPicker } from './panels.js';
import { listPatterns, GRADIENT_STYLES } from './resources.js';
import { blendIfActive } from './doc.js';

/** The effects in Photoshop's order (top of the list = drawn on top). */
export const FX_LIST = ['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
const USES_LIGHT = new Set(['dropShadow', 'innerShadow', 'bevel']);
const STYLES_KEY = 'montage.photo.styles';

export const userStyles = () => {
  try {
    return JSON.parse(localStorage.getItem(STYLES_KEY) || '[]');
  } catch {
    return [];
  }
};
function saveUserStyle(entry) {
  const list = userStyles();
  list.push(entry);
  try {
    localStorage.setItem(STYLES_KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
}

const FULL = () => [0, 0, 255, 255];
const BLEND_KEYS = ['blend', 'opacity', 'fillOpacity', 'blendIf', 'blendChannels', 'knockout', 'blendInterior', 'blendClipped', 'transparencyShapes', 'maskHidesFx', 'vmaskHidesFx'];

/** A copy of a layer's blending settings and effects (what this dialog edits). */
function readLayer(l, doc) {
  const o = { fx: normalizeFx(structuredClone(l.fx || {})), globalAngle: doc.globalAngle ?? 120, globalAltitude: doc.globalAltitude ?? 30 };
  for (const k of BLEND_KEYS) o[k] = l[k] && typeof l[k] === 'object' ? structuredClone(l[k]) : l[k];
  o.opacity ??= 1;
  o.fillOpacity ??= 1;
  return o;
}
function writeLayer(l, doc, o) {
  l.fx = structuredClone(o.fx);
  for (const k of BLEND_KEYS) {
    const v = o[k];
    if (v === undefined) delete l[k];
    else l[k] = v && typeof v === 'object' ? structuredClone(v) : v;
  }
  if (l.blendIf && !blendIfActive(l.blendIf)) l.blendIf = null;
  if (l.blendChannels && l.blendChannels.r !== false && l.blendChannels.g !== false && l.blendChannels.b !== false) l.blendChannels = null;
  doc.globalAngle = o.globalAngle;
  doc.globalAltitude = o.globalAltitude;
}

// ---------------------------------------------------------------- small controls

let cssDone = false;
function ensureCss() {
  if (cssDone) return;
  cssDone = true;
  document.head.append(h('style', `
.pls { display: grid; grid-template-columns: 216px minmax(0, 1fr); gap: 12px; min-height: 430px; }
.pls-side { display: flex; flex-direction: column; gap: 1px; border-right: 1px solid var(--line); padding-right: 8px; max-height: 66vh; overflow: auto; }
.pls-item { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 6px; border-radius: 4px; cursor: pointer; color: var(--text-dim); font-size: var(--fs-s); user-select: none; }
.pls-item:hover { background: var(--bg-3); }
.pls-item.on { background: var(--sel); color: var(--text); }
.pls-item.sub { padding-left: 28px; }
.pls-item.head { font-weight: 600; color: var(--text); }
.pls-item .pls-add { margin-left: auto; min-height: 0; width: 22px; height: 22px; padding: 0; display: grid; place-items: center; }
.pls-item .pls-n { color: var(--text-faint); font-size: 11px; }
.pls-prev { display: flex; align-items: center; gap: 6px; font-size: var(--fs-s); padding: 2px 6px 6px; white-space: nowrap; }
.pls-prev label, .pls-item { white-space: nowrap; }
.pls-prev label { display: inline-flex; align-items: center; gap: 4px; }
.pls-sidefoot { display: flex; gap: 4px; margin-top: auto; padding-top: 6px; border-top: 1px solid var(--line); }
.pls-sidefoot button { min-width: 30px; padding: 0 6px; }
.pls-pane { display: grid; gap: 8px; align-content: start; max-height: 66vh; overflow: auto; padding-right: 4px; }
.pls-pane h4 { margin: 0; }
.pls-pane fieldset { border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px 10px; display: grid; gap: 6px; margin: 0; min-width: 0; }
.pls-pane legend { font-size: var(--fs-xs); color: var(--text-faint); padding: 0 4px; }
.pls-row { display: grid; grid-template-columns: 104px minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: var(--fs-s); min-width: 0; }
.pls-row > span:first-child { color: var(--text-dim); }
.pls-row input[type=range] { width: 100%; min-width: 60px; }
.pls-row .ph-num { width: 62px; }
.pls-row small { color: var(--text-faint); min-width: 18px; }
.pls-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-s); }
.pls-inline label { display: inline-flex; align-items: center; gap: 4px; }
.pls-color { width: 34px; height: 24px; padding: 0; border: 1px solid var(--line-2); border-radius: 3px; background: none; }
.pls-dial { width: 36px; height: 36px; cursor: pointer; touch-action: none; flex-shrink: 0; }
.pls-contour { width: 30px; height: 30px; border: 1px solid var(--line-2); border-radius: 3px; background: #fff; flex-shrink: 0; }
.pls-bi { display: grid; gap: 2px; }
.pls-bi-lab { display: flex; justify-content: space-between; font-size: var(--fs-s); color: var(--text-dim); }
.pls-bi-lab b { font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text); }
.pls-bar { position: relative; height: 14px; margin: 2px 7px 14px; border: 1px solid var(--line-2); border-radius: 2px; touch-action: none; cursor: ew-resize; }
.pls-h { position: absolute; top: 100%; width: 0; height: 0; margin-left: -6px; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 11px solid #e8e8e8; pointer-events: none; }
.pls-h.dark { border-bottom-color: #111; filter: drop-shadow(0 0 1px #aaa); }
.pls-h.lh { border-right-width: 0; margin-left: -6px; }
.pls-h.rh { border-left-width: 0; margin-left: 0; }
.pls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
.pls-cell { min-height: 54px; padding: 4px; display: grid; place-items: center; font-size: var(--fs-xs); text-align: center; white-space: normal; }
.pls-note { font-size: var(--fs-xs); color: var(--text-faint); }
.pls-btns { display: flex; gap: 6px; flex-wrap: wrap; }
body.mobile .pls { grid-template-columns: minmax(0, 1fr); min-height: 0; }
body.mobile .pls-side { flex-direction: row; overflow-x: auto; border-right: none; border-bottom: 1px solid var(--line); padding: 0 0 6px; max-height: none; }
body.mobile .pls-item { flex: 0 0 auto; min-height: 38px; }
body.mobile .pls-item.sub { padding-left: 8px; }
body.mobile .pls-sidefoot { margin: 0; padding: 0 0 0 6px; border-top: none; border-left: 1px solid var(--line); }
body.mobile .pls-pane { max-height: 52dvh; }
body.mobile .pls-row { grid-template-columns: 84px minmax(0, 1fr) auto; }
`));
}

function rangeRow(label, value, min, max, unit, onSet, step = 1) {
  const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const n = h('input.ph-num', { type: 'number', min, max, step, value, 'aria-label': label });
  const set = (v) => {
    const val = clamp(Math.round(+v / step) * step, min, max);
    r.value = val;
    n.value = val;
    onSet(val);
  };
  r.addEventListener('input', () => set(r.value));
  n.addEventListener('change', () => set(n.value));
  return h('label.pls-row', h('span', label), r, h('span.pls-inline', n, unit ? h('small', unit) : null));
}
function selectRow(label, opts, value, onSet) {
  const s = h('select', { 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v }, t)));
  s.value = value;
  s.addEventListener('change', () => onSet(s.value));
  return h('label.pls-row', h('span', label), s, h('span'));
}
function check(label, on, onSet, title = null) {
  const b = h('input', { type: 'checkbox', checked: !!on });
  b.addEventListener('change', () => onSet(b.checked));
  return h('label', { title }, b, label);
}
function colorInput(value, onSet, label = '색상') {
  const c = h('input.pls-color', { type: 'color', value: value || '#000000', title: label, 'aria-label': label });
  c.addEventListener('input', () => onSet(c.value));
  return c;
}
function blendRow(label, e, key = 'blend', colorKey = 'color', onChange) {
  const s = blendSelect(false);
  s.value = e[key] || 'normal';
  s.addEventListener('change', () => { e[key] = s.value; onChange(); });
  return h('label.pls-row', h('span', label), s, colorKey ? colorInput(e[colorKey], (v) => { e[colorKey] = v; onChange(); }) : h('span'));
}

/** A round dial for an angle (0° = light from the right, 90° = from above). */
function angleDial(value, onSet) {
  const c = h('canvas.pls-dial', { width: 72, height: 72, 'aria-label': '각도 다이얼' });
  const draw = (a) => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 72, 72);
    g.lineWidth = 3;
    g.strokeStyle = '#9aa0a8';
    g.fillStyle = '#2a2d33';
    g.beginPath();
    g.arc(36, 36, 31, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    const r = (a * Math.PI) / 180;
    g.strokeStyle = '#fff';
    g.beginPath();
    g.moveTo(36, 36);
    g.lineTo(36 + Math.cos(r) * 28, 36 - Math.sin(r) * 28);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(36, 36, 4, 0, Math.PI * 2);
    g.fill();
  };
  draw(value);
  const pick = (e) => {
    const b = c.getBoundingClientRect();
    let a = Math.round((Math.atan2(-(e.clientY - b.top - b.height / 2), e.clientX - b.left - b.width / 2) * 180) / Math.PI);
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    draw(a);
    onSet(a);
  };
  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    pick(e);
    const move = (ev) => pick(ev);
    const up = () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  });
  c.redraw = draw;
  return c;
}

function contourIcon(id) {
  const c = h('canvas.pls-contour', { width: 30, height: 30 });
  const g = c.getContext('2d');
  const lut = contourLut(id);
  g.strokeStyle = '#000';
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i <= 28; i++) {
    const x = i / 28;
    const y = lut ? lut[Math.round(x * 256)] : x;
    if (i) g.lineTo(1 + i, 29 - y * 28);
    else g.moveTo(1, 29 - y * 28);
  }
  g.stroke();
  return c;
}
function contourRow(label, e, key, onChange, withAA = true) {
  const icn = h('span', contourIcon(e[key] || 'linear'));
  const s = h('select', { 'aria-label': label }, CONTOURS.map(([v, t]) => h('option', { value: v }, t)));
  s.value = e[key] || 'linear';
  s.addEventListener('change', () => {
    e[key] = s.value;
    icn.replaceChildren(contourIcon(s.value));
    onChange();
  });
  return h('div.pls-row', h('span', label), h('span.pls-inline', icn, s), withAA ? h('span.pls-inline', check('앤티 앨리어스', e.antialias, (v) => { e.antialias = v; onChange(); })) : h('span'));
}

/**
 * A Blend If slider: four values [black low, black high, white low, white high]. Dragging a handle
 * moves it; Alt+drag (or the split switch on phones) pulls the two halves apart for a soft transition.
 */
function blendIfSlider(label, range, gradient, onSet, splitMode) {
  const r = range.slice();
  const bar = h('div.pls-bar', { style: { background: gradient }, role: 'slider', 'aria-label': label, tabindex: 0 });
  const hs = [0, 1, 2, 3].map((i) => h(`div.pls-h${i < 2 ? '.dark' : ''}`));
  bar.append(...hs);
  const lab = h('div.pls-bi-lab', h('span', label), h('b'));
  const paint = () => {
    for (let i = 0; i < 4; i++) {
      hs[i].style.left = `${(r[i] / 255) * 100}%`;
      const joined = i < 2 ? r[0] === r[1] : r[2] === r[3];
      hs[i].classList.toggle('lh', !joined && (i === 0 || i === 2));
      hs[i].classList.toggle('rh', !joined && (i === 1 || i === 3));
    }
    const left = r[0] === r[1] ? `${r[0]}` : `${r[0]} / ${r[1]}`;
    const right = r[2] === r[3] ? `${r[3]}` : `${r[2]} / ${r[3]}`;
    lab.lastChild.textContent = `${left}  ·  ${right}`;
    bar.setAttribute('aria-valuetext', `${left} ~ ${right}`);
  };
  paint();
  const valAt = (e) => {
    const b = bar.getBoundingClientRect();
    return clamp(Math.round(((e.clientX - b.left) / Math.max(1, b.width)) * 255), 0, 255);
  };
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const v0 = valAt(e);
    // the nearest handle (pair) to the pointer
    const pairLeft = Math.abs(v0 - (r[0] + r[1]) / 2) <= Math.abs(v0 - (r[2] + r[3]) / 2);
    const [i0, i1] = pairLeft ? [0, 1] : [2, 3];
    const joined = r[i0] === r[i1];
    const split = e.altKey || splitMode();
    let which = null; // index moved alone, or 'pair'
    if (!joined) which = Math.abs(v0 - r[i0]) <= Math.abs(v0 - r[i1]) ? i0 : i1;
    else if (!split) which = 'pair';
    const start = r.slice();
    const move = (ev) => {
      const v = valAt(ev);
      if (which === null) {
        if (v === v0) return;
        which = v > v0 ? i1 : i0;
      }
      if (which === 'pair') {
        const d = clamp(v - v0, (pairLeft ? 0 : start[1]) - start[i0], (pairLeft ? start[2] : 255) - start[i1]);
        r[i0] = start[i0] + d;
        r[i1] = start[i1] + d;
      } else {
        const lo = which === 0 ? 0 : r[which - 1];
        const hi = which === 3 ? 255 : r[which + 1];
        r[which] = clamp(v, lo, hi);
      }
      paint();
      onSet(r.slice());
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
  // keyboard: arrows move the black handles, Shift+arrows the white ones
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.ctrlKey ? 10 : 1);
    if (e.shiftKey) {
      r[2] = clamp(r[2] + d, r[1], 255);
      r[3] = clamp(r[3] + d, r[2], 255);
    } else {
      r[0] = clamp(r[0] + d, 0, r[2]);
      r[1] = clamp(r[1] + d, r[0], r[2]);
    }
    paint();
    onSet(r.slice());
  });
  return h('div.pls-bi', lab, bar);
}

// ---------------------------------------------------------------- the dialog

/** Open the Layer Style dialog on the active layer at `start` ('blending', 'styles' or an effect key). */
export function layerStyleDialog(P, start = 'blending') {
  const doc = P.doc;
  const l = doc?.active;
  if (!l) return toast('레이어를 고르세요');
  ensureCss();
  const adjust = l.kind === 'adjust';
  if (adjust && start !== 'blending') start = 'blending';
  const before = doc.capture();
  const orig = readLayer(l, doc);
  const st = readLayer(l, doc);
  let preview = true;
  let splitTouch = false;
  let raf = 0;
  const apply = () => {
    raf = 0;
    writeLayer(l, doc, preview ? st : orig);
    l._styled = null;
    l._cache = null;
    doc.touch(l);
    P.redraw();
  };
  const changed = () => {
    if (!raf) raf = requestAnimationFrame(apply);
    renderSide();
  };

  // the selected entry: 'styles', 'blending', 'bevelContour' or an fx key ('stroke', 'stroke_2', …)
  let cur = start;
  if (FX_LIST.includes(start)) {
    if (!st.fx[start]) st.fx[start] = newEffect(start);
    else st.fx[start].enabled = true;
  }
  function newEffect(k) {
    const e = fxDefaults(k);
    if (USES_LIGHT.has(k) && e.useGlobalLight === undefined) e.useGlobalLight = true;
    return e;
  }
  const ensure = (key) => {
    const k = baseKey(key);
    if (!st.fx[key]) st.fx[key] = newEffect(k);
    return st.fx[key];
  };

  const side = h('div.pls-side');
  const pane = h('div.pls-pane');
  const sideFoot = h('div.pls-sidefoot');

  function select(key, enable = false) {
    cur = key;
    if (enable && key !== 'styles' && key !== 'blending') {
      if (key === 'bevelContour') {
        const b = ensure('bevel');
        b.enabled = true;
        b.contourOn = true;
      } else ensure(key).enabled = true;
      changed();
    }
    renderSide();
    renderPane();
  }

  // keep the chosen entry in view (the list scrolls sideways on phones); only the list scrolls
  function revealOn() {
    const on = side.querySelector('.pls-item.on');
    if (!on || !side.isConnected) return;
    const a = side.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    if (b.left < a.left) side.scrollLeft -= a.left - b.left + 8;
    else if (b.right > a.right) side.scrollLeft += b.right - a.right + 8;
    if (b.top < a.top) side.scrollTop -= a.top - b.top;
    else if (b.bottom > a.bottom) side.scrollTop += b.bottom - a.bottom;
  }

  function renderSide() {
    const rows = [
      h('div.pls-prev', check('미리 보기', preview, (v) => { preview = v; apply(); })),
      h(`div.pls-item.head${cur === 'styles' ? '.on' : ''}`, { onclick: () => select('styles'), role: 'button', tabindex: 0 }, '스타일'),
      h(`div.pls-item.head${cur === 'blending' ? '.on' : ''}`, { onclick: () => select('blending'), role: 'button', tabindex: 0 }, '혼합 옵션'),
    ];
    if (!adjust) {
      for (const k of FX_LIST) {
        const keys = instanceKeys(st.fx, k);
        const list = keys.length ? keys : [k];
        list.forEach((key, i) => {
          const e = st.fx[key];
          const box = h('input', { type: 'checkbox', checked: !!e?.enabled, 'aria-label': `${FX_NAMES[k]} 켜기` });
          box.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ensure(key).enabled = box.checked;
            changed();
          });
          const add = MULTI_FX.includes(k) && i === 0 ? h('button.small.pls-add', {
            title: `${FX_NAMES[k]} 하나 더 추가`, 'aria-label': `${FX_NAMES[k]} 추가`,
            onclick: (ev) => {
              ev.stopPropagation();
              const all = instanceKeys(st.fx, k).map((x) => st.fx[x]);
              const src = st.fx[cur] && baseKey(cur) === k ? st.fx[cur] : newEffect(k);
              const at = Math.max(0, instanceKeys(st.fx, k).indexOf(cur));
              all.splice(at, 0, { ...structuredClone(src), enabled: true });
              setInstances(st.fx, k, all);
              changed();
              select(instanceKeys(st.fx, k)[at]);
            },
          }, icon('plus', 13)) : null;
          rows.push(h(`div.pls-item${cur === key ? '.on' : ''}`, { role: 'button', tabindex: 0, onclick: () => select(key, true) },
            box, h('span', FX_NAMES[k]), list.length > 1 ? h('span.pls-n', `${i + 1}`) : null, add));
          if (k === 'bevel') {
            const b = st.fx.bevel;
            const cb = h('input', { type: 'checkbox', checked: !!(b?.enabled && b.contourOn), 'aria-label': '윤곽선 켜기' });
            cb.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const bb = ensure('bevel');
              bb.contourOn = cb.checked;
              if (cb.checked) bb.enabled = true;
              changed();
            });
            rows.push(h(`div.pls-item.sub${cur === 'bevelContour' ? '.on' : ''}`, { role: 'button', tabindex: 0, onclick: () => select('bevelContour', true) }, cb, h('span', '윤곽선')));
          }
        });
      }
    }
    side.replaceChildren(...rows, sideFoot);
    revealOn();
    // move / delete the selected effect
    const k = baseKey(cur);
    const isFx = FX_LIST.includes(k) && cur !== 'bevelContour';
    const keys = isFx ? instanceKeys(st.fx, k) : [];
    const at = keys.indexOf(cur);
    const moveBy = (d) => {
      const all = keys.map((x) => st.fx[x]);
      const [it] = all.splice(at, 1);
      all.splice(at + d, 0, it);
      setInstances(st.fx, k, all);
      changed();
      select(instanceKeys(st.fx, k)[at + d]);
    };
    sideFoot.replaceChildren(
      h('button.small', { title: '위로 (위에 있는 효과가 위에 그려집니다)', 'aria-label': '효과 위로', disabled: !isFx || at <= 0, onclick: () => moveBy(-1) }, '▲'),
      h('button.small', { title: '아래로', 'aria-label': '효과 아래로', disabled: !isFx || at < 0 || at >= keys.length - 1, onclick: () => moveBy(1) }, '▼'),
      h('button.small', {
        title: '이 효과 삭제', 'aria-label': '효과 삭제', disabled: !isFx || !st.fx[cur],
        onclick: () => {
          const all = keys.map((x) => st.fx[x]).filter((_, i) => i !== at);
          setInstances(st.fx, k, all);
          changed();
          select(all.length ? instanceKeys(st.fx, k)[Math.max(0, at - 1)] : 'blending');
        },
      }, icon('trash', 13)));
  }

  // ---- panes

  const defaultsButtons = (k, e) => h('div.pls-btns',
    h('button.small', { title: '지금 설정을 새 효과의 기본값으로 기억합니다', onclick: () => { saveFxDefaults(k, e); toast(`${FX_NAMES[k]}: 기본값으로 만들었습니다`); } }, '기본값으로 만들기'),
    h('button.small', {
      title: '기억해 둔 기본값(없으면 포토샵 기본값)으로 되돌립니다',
      onclick: () => {
        const d = fxDefaults(k);
        for (const key of Object.keys(e)) delete e[key];
        Object.assign(e, d, { enabled: true });
        if (USES_LIGHT.has(k) && e.useGlobalLight === undefined) e.useGlobalLight = true;
        changed();
        renderPane();
      },
    }, '기본값으로 재설정'),
    h('button.small', {
      title: '포토샵 처음 기본값으로 되돌리고, 기억해 둔 기본값도 지웁니다',
      onclick: () => {
        saveFxDefaults(k, null);
        const d = factoryFx(k);
        for (const key of Object.keys(e)) delete e[key];
        Object.assign(e, d);
        if (USES_LIGHT.has(k)) e.useGlobalLight = true;
        changed();
        renderPane();
      },
    }, '처음 기본값'));

  /** Angle (+ global light) controls; with global light the dial moves the document's light. */
  const angleRows = (e, withAltitude = false) => {
    const useGlobal = () => !!e.useGlobalLight;
    const get = () => (useGlobal() ? st.globalAngle : e.angle ?? 120);
    const num = h('input.ph-num', { type: 'number', min: -180, max: 180, value: get(), 'aria-label': '각도' });
    const set = (a) => {
      a = ((((Math.round(a) + 180) % 360) + 360) % 360) - 180;
      if (useGlobal()) st.globalAngle = a;
      else e.angle = a;
      num.value = a;
      dial.redraw(a);
      changed();
    };
    const dial = angleDial(get(), set);
    num.addEventListener('change', () => set(+num.value));
    const rows = [h('div.pls-row', h('span', '각도'), h('span.pls-inline', dial, num, h('small', '°')),
      h('span.pls-inline', check('전체 조명 사용', e.useGlobalLight, (v) => {
        // on: the effect follows the document's light; off: it keeps that angle as its own
        e.useGlobalLight = v;
        if (!v) e.angle = st.globalAngle;
        if (withAltitude && !v) e.altitude = st.globalAltitude;
        changed();
        renderPane();
      }, '모든 레이어의 효과가 같은 빛 방향을 씁니다')))];
    if (withAltitude) {
      rows.push(rangeRow('고도', useGlobal() ? st.globalAltitude : e.altitude ?? 30, 0, 90, '°', (v) => {
        if (useGlobal()) st.globalAltitude = v;
        else e.altitude = v;
        changed();
      }));
    }
    return rows;
  };
  const pct = (e, key, label, def = 1) => rangeRow(label, Math.round((e[key] ?? def) * 100), 0, 100, '%', (v) => { e[key] = v / 100; changed(); });
  const pxRow = (e, key, label, max = 250, min = 0) => rangeRow(label, e[key] ?? 0, min, max, 'px', (v) => { e[key] = v; changed(); });
  const pRow = (e, key, label, max = 100, min = 0) => rangeRow(label, e[key] ?? 0, min, max, '%', (v) => { e[key] = v; changed(); });
  const fs = (legend, ...kids) => h('fieldset', h('legend', legend), ...kids);

  function renderPane() {
    if (cur === 'styles') return paneStyles();
    if (cur === 'blending') return paneBlending();
    if (cur === 'bevelContour') return paneBevelContour();
    const k = baseKey(cur);
    const e = ensure(cur);
    const title = h('h4', FX_NAMES[k]);
    let body = [];
    {
      if (k === 'dropShadow' || k === 'innerShadow') {
        body = [
          fs('구조',
            blendRow('혼합 모드', e, 'blend', 'color', changed),
            pct(e, 'opacity', '불투명도', 0.75),
            ...angleRows(e),
            pxRow(e, 'distance', '거리', 1000),
            k === 'dropShadow' ? pRow(e, 'spread', '스프레드') : pRow(e, 'choke', '경계 감소'),
            pxRow(e, 'size', '크기', 250)),
          fs('품질',
            contourRow('윤곽선', e, 'contour', changed),
            pRow(e, 'noise', '노이즈')),
          k === 'dropShadow' ? h('div.pls-inline', check('레이어가 드롭 섀도를 녹아웃', e.knockout !== false, (v) => { e.knockout = v; changed(); }, '레이어 아래에 가려진 그림자를 지웁니다 (칠을 낮췄을 때 보임)')) : null,
        ];
      } else if (k === 'outerGlow' || k === 'innerGlow') {
        body = [
          fs('구조',
            blendRow('혼합 모드', e, 'blend', 'color', changed),
            pct(e, 'opacity', '불투명도', 0.75),
            pRow(e, 'noise', '노이즈')),
          fs('요소',
            selectRow('기법', [['softer', '더 부드럽게'], ['precise', '정확하게']], e.technique || 'softer', (v) => { e.technique = v; changed(); }),
            k === 'innerGlow' ? h('div.pls-row', h('span', '소스'), h('span.pls-inline',
              ...[['center', '가운데'], ['edge', '가장자리']].map(([v, t]) => {
                const rb = h('input', { type: 'radio', name: 'pls-src', checked: (e.source || 'edge') === v });
                rb.addEventListener('change', () => { if (rb.checked) { e.source = v; changed(); } });
                return h('label', rb, t);
              })), h('span')) : null,
            k === 'outerGlow' ? pRow(e, 'spread', '스프레드') : pRow(e, 'choke', '경계 감소'),
            pxRow(e, 'size', '크기', 250)),
          fs('품질',
            contourRow('윤곽선', e, 'contour', changed),
            rangeRow('범위', e.range ?? 50, 1, 100, '%', (v) => { e.range = v; changed(); })),
        ];
      } else if (k === 'bevel') {
        body = [
          fs('구조',
            selectRow('스타일', [['inner bevel', '내부 경사'], ['outer bevel', '외부 경사'], ['emboss', '엠보스'], ['pillow emboss', '쿠션 엠보스'], ['stroke emboss', '획 엠보스']], e.style || 'inner bevel', (v) => { e.style = v; changed(); }),
            selectRow('기법', [['smooth', '매끄럽게'], ['chisel hard', '단단하게 깎기'], ['chisel soft', '부드럽게 깎기']], e.technique || 'smooth', (v) => { e.technique = v; changed(); }),
            rangeRow('깊이', e.depth ?? 100, 1, 1000, '%', (v) => { e.depth = v; changed(); }),
            h('div.pls-row', h('span', '방향'), h('span.pls-inline', ...[['up', '위로'], ['down', '아래로']].map(([v, t]) => {
              const rb = h('input', { type: 'radio', name: 'pls-dir', checked: (e.direction || 'up') === v });
              rb.addEventListener('change', () => { if (rb.checked) { e.direction = v; changed(); } });
              return h('label', rb, t);
            })), h('span')),
            pxRow(e, 'size', '크기', 250),
            pxRow(e, 'soften', '부드럽게', 16)),
          fs('음영',
            ...angleRows(e, true),
            contourRow('광택 윤곽선', e, 'gloss', changed),
            blendRow('밝은 영역 모드', e, 'highlightBlend', 'highlightColor', changed),
            pct(e, 'highlightOpacity', '불투명도', 0.75),
            blendRow('그림자 모드', e, 'shadowBlend', 'shadowColor', changed),
            pct(e, 'shadowOpacity', '불투명도', 0.75)),
          e.style === 'stroke emboss' ? h('div.pls-note', '획 엠보스는 획 효과의 테두리에 입체감을 줍니다 (획 효과를 함께 켜세요).') : null,
        ];
      } else if (k === 'satin') {
        body = [fs('구조',
          blendRow('혼합 모드', e, 'blend', 'color', changed),
          pct(e, 'opacity', '불투명도', 0.5),
          angleField(e),
          pxRow(e, 'distance', '거리', 250),
          pxRow(e, 'size', '크기', 250),
          contourRow('윤곽선', e, 'contour', changed),
          h('div.pls-inline', check('반전', e.invert, (v) => { e.invert = v; changed(); })))];
      } else if (k === 'colorOverlay') {
        body = [fs('색상', blendRow('혼합 모드', e, 'blend', 'color', changed), pct(e, 'opacity', '불투명도'))];
      } else if (k === 'gradientOverlay') {
        body = [fs('그레이디언트',
          blendRow('혼합 모드', e, 'blend', null, changed),
          h('div.pls-inline', check('디더', e.dither, (v) => { e.dither = v; changed(); })),
          pct(e, 'opacity', '불투명도'),
          h('div.pls-row', h('span', '그레이디언트'), gradientPicker(P, e.gradient, (g) => { e.gradient = g; changed(); }), h('span.pls-inline', check('반전', e.reverse, (v) => { e.reverse = v; changed(); }))),
          selectRow('스타일', GRADIENT_STYLES, e.style || 'linear', (v) => { e.style = v; changed(); }),
          h('div.pls-inline', check('레이어에 정렬', e.align !== false, (v) => { e.align = v; changed(); })),
          angleField(e),
          rangeRow('비율', e.scale ?? 100, 10, 150, '%', (v) => { e.scale = v; changed(); }))];
      } else if (k === 'patternOverlay') {
        body = [fs('패턴',
          blendRow('혼합 모드', e, 'blend', null, changed),
          pct(e, 'opacity', '불투명도'),
          selectRow('패턴', listPatterns().map((p) => [p.id, p.name]), e.pattern || 'checker', (v) => { e.pattern = v; changed(); }),
          rangeRow('비율', e.scale ?? 100, 1, 1000, '%', (v) => { e.scale = v; changed(); }),
          h('div.pls-inline', check('레이어에 연결', e.link !== false, (v) => { e.link = v; changed(); })))];
      } else if (k === 'stroke') {
        const typeSpecific = e.fillType === 'gradient'
          ? [h('div.pls-row', h('span', '그레이디언트'), gradientPicker(P, e.gradient, (g) => { e.gradient = g; changed(); }), h('span.pls-inline', check('반전', e.reverse, (v) => { e.reverse = v; changed(); }))),
            selectRow('스타일', GRADIENT_STYLES, e.style || 'linear', (v) => { e.style = v; changed(); }),
            h('div.pls-inline', check('레이어에 정렬', e.align !== false, (v) => { e.align = v; changed(); }, '끄면 그레이디언트가 문서 전체에 펼쳐집니다')),
            angleField(e),
            rangeRow('비율', e.scale ?? 100, 10, 150, '%', (v) => { e.scale = v; changed(); })]
          : e.fillType === 'pattern'
            ? [selectRow('패턴', listPatterns().map((p) => [p.id, p.name]), e.pattern || 'checker', (v) => { e.pattern = v; changed(); }),
              rangeRow('비율', e.scale ?? 100, 1, 1000, '%', (v) => { e.scale = v; changed(); }),
              h('div.pls-inline', check('레이어에 연결', e.link !== false, (v) => { e.link = v; changed(); }, '켜면 레이어를 옮길 때 패턴도 함께 움직입니다'))]
            : [h('div.pls-row', h('span', '색상'), colorInput(e.color, (v) => { e.color = v; changed(); }), h('span'))];
        body = [
          fs('구조',
            pxRow(e, 'size', '크기', 250, 1),
            selectRow('위치', [['outside', '바깥쪽'], ['inside', '안쪽'], ['center', '가운데']], e.position || 'outside', (v) => { e.position = v; changed(); }),
            blendRow('혼합 모드', e, 'blend', null, changed),
            pct(e, 'opacity', '불투명도'),
            h('div.pls-inline', check('중복 인쇄', e.overprint, (v) => { e.overprint = v; changed(); }))),
          fs('칠',
            selectRow('칠 유형', [['color', '색상'], ['gradient', '그레이디언트'], ['pattern', '패턴']], e.fillType || 'color', (v) => { e.fillType = v; changed(); renderPane(); }),
            ...typeSpecific),
        ];
      }
    }
    pane.replaceChildren(title, ...body.filter(Boolean), defaultsButtons(k, e));
    return undefined;
  }

  /** A plain angle field (gradients, satin) without global light. */
  function angleField(e) {
    const num = h('input.ph-num', { type: 'number', min: -180, max: 180, value: e.angle ?? 90, 'aria-label': '각도' });
    const dial = angleDial(e.angle ?? 90, (a) => { e.angle = a; num.value = a; changed(); });
    num.addEventListener('change', () => { e.angle = clamp(Math.round(+num.value), -180, 180); dial.redraw(e.angle); changed(); });
    return h('div.pls-row', h('span', '각도'), h('span.pls-inline', dial, num, h('small', '°')), h('span'));
  }

  function paneBevelContour() {
    const e = ensure('bevel');
    pane.replaceChildren(h('h4', '윤곽선'), fs('요소',
      contourRow('윤곽선', e, 'profile', changed),
      rangeRow('범위', e.profileRange ?? 50, 1, 100, '%', (v) => { e.profileRange = v; changed(); }),
      h('div.pls-note', '경사 면의 모양(굴곡)을 바꿉니다. 왼쪽 목록의 "윤곽선"을 켜야 적용됩니다.')));
  }

  function paneStyles() {
    const presets = [...STYLE_PRESETS, ...userStyles().map((u) => ({ ...u, user: true }))];
    pane.replaceChildren(h('h4', '스타일'), h('div.pls-note', '누르면 이 레이어의 효과를 그 스타일로 바꿉니다.'), h('div.pls-grid', presets.map((pr) => h('button.pls-cell', {
      title: pr.name,
      onclick: () => {
        st.fx = normalizeFx(structuredClone(pr.fx || {}));
        if (pr.blending) Object.assign(st, structuredClone(pr.blending));
        changed();
      },
    }, pr.name))));
  }

  function paneBlending() {
    const isGroup = l.kind === 'group';
    const blend = blendSelect(isGroup);
    blend.value = st.blend || (isGroup ? 'pass through' : 'normal');
    blend.addEventListener('change', () => { st.blend = blend.value; changed(); });
    const general = fs('일반 혼합',
      h('label.pls-row', h('span', '혼합 모드'), blend, h('span')),
      rangeRow('불투명도', Math.round(st.opacity * 100), 0, 100, '%', (v) => { st.opacity = v / 100; changed(); }));
    const ch = st.blendChannels || { r: true, g: true, b: true };
    const chan = (key, label) => check(label, ch[key] !== false, (v) => { st.blendChannels = { ...ch, ...(st.blendChannels || {}), [key]: v }; ch[key] = v; changed(); }, `${label} 채널에 그립니다`);
    const knock = h('select', { 'aria-label': '녹아웃' }, [['none', '없음'], ['shallow', '얕게'], ['deep', '깊게']].map(([v, t]) => h('option', { value: v }, t)));
    knock.value = st.knockout || 'none';
    knock.addEventListener('change', () => { st.knockout = knock.value === 'none' ? undefined : knock.value; changed(); });
    const advanced = fs('고급 혼합',
      isGroup ? null : rangeRow('칠 불투명도', Math.round((st.fillOpacity ?? 1) * 100), 0, 100, '%', (v) => { st.fillOpacity = v / 100; changed(); }),
      h('div.pls-row', h('span', '채널'), h('span.pls-inline', chan('r', 'R'), chan('g', 'G'), chan('b', 'B')), h('span')),
      h('label.pls-row', h('span', '녹아웃'), knock, h('span')),
      h('div.pls-inline', check('내부 효과를 그룹으로 혼합', st.blendInterior, (v) => { st.blendInterior = v || undefined; changed(); }, '색상 오버레이·새틴·내부 광선 같은 안쪽 효과도 칠 불투명도와 혼합 모드를 따릅니다')),
      h('div.pls-inline', check('클리핑된 레이어를 그룹으로 혼합', st.blendClipped !== false, (v) => { st.blendClipped = v ? undefined : false; changed(); }, '끄면 클리핑된 레이어가 각자 자기 혼합 모드로 섞입니다')),
      h('div.pls-inline', check('투명 모양 레이어', st.transparencyShapes !== false, (v) => { st.transparencyShapes = v ? undefined : false; changed(); })),
      h('div.pls-inline', check('레이어 마스크로 효과 숨기기', st.maskHidesFx, (v) => { st.maskHidesFx = v || undefined; changed(); }, '효과를 마스크 전의 모양으로 만들고, 마스크가 효과까지 가립니다')),
      h('div.pls-inline', check('벡터 마스크로 효과 숨기기', st.vmaskHidesFx, (v) => { st.vmaskHidesFx = v || undefined; changed(); })));
    // Blend If
    const chSel = h('select', { 'aria-label': '혼합 조건 채널' }, [['gray', '회색'], ['r', '빨강'], ['g', '초록'], ['b', '파랑']].map(([v, t]) => h('option', { value: v }, t)));
    chSel.value = paneBlending.ch || 'gray';
    const sliders = h('div', { style: { display: 'grid', gap: '6px' } });
    const grad = { gray: '#fff', r: '#f00', g: '#0f0', b: '#00f' };
    const drawSliders = () => {
      const c = chSel.value;
      paneBlending.ch = c;
      const bi = st.blendIf || { this: FULL(), under: FULL() };
      const part = c === 'gray' ? bi : bi[c] || { this: FULL(), under: FULL() };
      const bg = `linear-gradient(to right, #000, ${grad[c]})`;
      const setPart = (which, v) => {
        const nb = structuredClone(st.blendIf || { this: FULL(), under: FULL() });
        if (c === 'gray') nb[which] = v;
        else {
          nb[c] ||= { this: FULL(), under: FULL() };
          nb[c][which] = v;
        }
        st.blendIf = nb;
        changed();
      };
      sliders.replaceChildren(
        blendIfSlider('현재 레이어:', part.this, bg, (v) => setPart('this', v), () => splitTouch),
        blendIfSlider('밑에 있는 레이어:', part.under, bg, (v) => setPart('under', v), () => splitTouch));
    };
    chSel.addEventListener('change', drawSliders);
    drawSliders();
    const blendIf = fs('혼합 조건',
      h('label.pls-row', h('span', '채널'), chSel, h('span.pls-inline', h('button.small', { title: '모든 채널의 혼합 조건을 처음으로', onclick: () => { st.blendIf = null; changed(); drawSliders(); } }, '재설정'))),
      sliders,
      h('div.pls-inline', check('슬라이더 나누기 (Alt+드래그와 같음)', splitTouch, (v) => { splitTouch = v; }, '켜고 끌면 삼각형이 둘로 나뉘어 부드럽게 넘어가게 됩니다')),
      h('div.pls-note', '이 레이어가 보일 밝기 범위와, 아래 레이어의 어느 밝기 위에서 보일지를 정합니다. Alt를 누른 채 삼각형을 끌면 반으로 나뉘어 경계가 부드러워집니다.'));
    pane.replaceChildren(h('h4', '혼합 옵션'), general, advanced, blendIf);
  }

  renderSide();
  renderPane();
  let ok = false;
  const newStyle = async () => {
    const name = h('input', { type: 'text', value: '내 스타일', style: { width: '100%' } });
    const incFx = h('input', { type: 'checkbox', checked: true });
    const incBlend = h('input', { type: 'checkbox' });
    openModal({
      title: '새 스타일',
      body: [h('div.form-row', h('label', '이름'), name), h('label.inline', incFx, '레이어 효과 포함'), h('label.inline', incBlend, '레이어 혼합 옵션 포함')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const entry = { id: `u${Date.now()}`, name: name.value.trim() || '내 스타일', fx: incFx.checked ? structuredClone(st.fx) : {} };
          if (incBlend.checked) entry.blending = Object.fromEntries(BLEND_KEYS.map((k) => [k, st[k]]).filter(([, v]) => v !== undefined));
          saveUserStyle(entry);
          P.emit?.('styles');
          toast(`스타일 "${entry.name}"을(를) 저장했습니다 (레이어 스타일 ▸ 스타일)`);
          if (cur === 'styles') paneStyles();
        },
      }],
    });
    return false;
  };
  openModal({
    title: '레이어 스타일',
    width: '880px',
    body: [h('div.pls', side, pane)],
    buttons: [
      { label: '새 스타일…', action: newStyle },
      { label: '취소' },
      { label: '확인', primary: true, action: () => { cancelAnimationFrame(raf); preview = true; apply(); ok = true; P.commit('레이어 스타일', before); } },
    ],
    onClose: () => {
      cancelAnimationFrame(raf);
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  if (FX_LIST.includes(start)) changed();
  requestAnimationFrame(revealOn);
  return undefined;
}

/** Layer ▸ Layer Style ▸ Global Light… (전체 조명): the light all effects with "use global light" share. */
export function globalLightDialog(P) {
  const doc = P.doc;
  if (!doc) return;
  ensureCss();
  const before = doc.capture();
  const v = { a: doc.globalAngle ?? 120, alt: doc.globalAltitude ?? 30 };
  const apply = () => {
    doc.globalAngle = v.a;
    doc.globalAltitude = v.alt;
    for (const x of doc.layers) x._styled = null;
    doc.rev++;
    P.redraw();
  };
  const num = h('input.ph-num', { type: 'number', min: -180, max: 180, value: v.a, 'aria-label': '각도' });
  const dial = angleDial(v.a, (a) => { v.a = a; num.value = a; apply(); });
  num.addEventListener('change', () => { v.a = clamp(Math.round(+num.value), -180, 180); dial.redraw(v.a); apply(); });
  let ok = false;
  openModal({
    title: '전체 조명',
    width: '380px',
    body: [h('div.pls-pane', h('div.pls-row', h('span', '각도'), h('span.pls-inline', dial, num, h('small', '°')), h('span')),
      rangeRow('고도', v.alt, 0, 90, '°', (x) => { v.alt = x; apply(); }),
      h('div.pls-note', '"전체 조명 사용"을 켠 드롭 섀도·내부 그림자·경사와 엠보스가 모두 이 빛 방향을 따릅니다.'))],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { apply(); ok = true; P.commit('전체 조명', before); } }],
    onClose: () => {
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
}
