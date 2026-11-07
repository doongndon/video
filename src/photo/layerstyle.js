// Layer ▸ Layer Style (레이어 스타일): Photoshop's dialog. On the left the list (Styles, Blending Options and
// the ten effects, a + on those Photoshop lets you add more than once) with fx ▾ / ↑ ↓ / trash under it;
// the chosen entry's settings in the middle, in Photoshop's grouped boxes, with 기본값으로 만들기 /
// 기본값으로 재설정 under them; 확인 · 취소 · 새 스타일… · 미리 보기 and a swatch of the style on the right.
// Blending Options has fill opacity, channels, knockout, the group options, the mask options and Blend If
// sliders (Alt+drag splits a slider for a soft transition). While the dialog is open, dragging on the
// picture moves a drop shadow / inner shadow (angle and distance), a gradient or a pattern, as in Photoshop.
// Styles live in styles/photo-dialogs.css.

import { h, clamp } from '../util.js';
import { openModal, toast, showMenu } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { FX_NAMES, STYLE_PRESETS, MULTI_FX, CONTOURS, instanceKeys, setInstances, baseKey, fxDefaults, saveFxDefaults, factoryFx, normalizeFx, contourLut, scaleFx } from './styles.js';
import { blendSelect, gradientPicker } from './panels.js';
import { listPatterns, patternCanvas, GRADIENT_STYLES } from './resources.js';
import { blendIfActive, PhotoDoc, newLayer, makeCanvas } from './doc.js';

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
// the list shows every instance of an effect ('all') or one row per effect ('default'); fx ▾ switches
let listMode = 'all';

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

/**
 * A style drawn on a grey square with the real effects engine (the swatch under 미리 보기 and the
 * Styles grid). `k` scales sizes and distances so the square looks like the layer does.
 */
function styleSquare(fx, { size = 80, k = 1, opacity = 1, fillOpacity = 1, angle = 120, altitude = 30, fg = '#000000', bg = '#ffffff' } = {}) {
  const doc = new PhotoDoc({ width: size, height: size, background: null });
  doc.globalAngle = angle;
  doc.globalAltitude = altitude;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const m = Math.round(size * 0.22);
  g.fillStyle = '#9a9a9a';
  g.fillRect(m, m, size - m * 2, size - m * 2);
  const l = newLayer('raster', { name: 'swatch', canvas: c, fx: normalizeFx(scaleFx(fx || {}, k)), opacity, fillOpacity });
  doc.layers.push(l);
  doc.activeId = l.id;
  try {
    return doc.flatten({ fg, bg });
  } catch {
    return c;
  }
}

// ---------------------------------------------------------------- small controls

/** A Photoshop row: a right-aligned label, then the controls. */
const row = (label, ...kids) => h('div.pls-row', h('span.pls-lbl', label), ...kids.filter(Boolean));

function rangeRow(label, value, min, max, unit, onSet, step = 1, ...extra) {
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
  return row(label, r, n, unit ? h('small.pls-unit', unit) : null, ...extra);
}
function selectRow(label, opts, value, onSet, ...extra) {
  const s = h('select', { 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v }, t)));
  s.value = value;
  s.addEventListener('change', () => onSet(s.value));
  return row(label, s, ...extra);
}
function check(label, on, onSet, title = null) {
  const b = h('input', { type: 'checkbox', checked: !!on });
  b.addEventListener('change', () => onSet(b.checked));
  return h('label.pls-chk', { title }, b, label);
}
function colorInput(value, onSet, label = '색상') {
  const c = h('input.pls-color', { type: 'color', value: value || '#000000', title: `${label} 설정`, 'aria-label': label });
  c.addEventListener('input', () => onSet(c.value));
  return c;
}
function blendRow(label, e, key = 'blend', colorKey = 'color', onChange, ...extra) {
  const s = blendSelect(false);
  s.value = e[key] || 'normal';
  s.addEventListener('change', () => { e[key] = s.value; onChange(); });
  return row(label, s, colorKey ? colorInput(e[colorKey], (v) => { e[colorKey] = v; onChange(); }) : null, ...extra);
}
function radios(name, opts, value, onSet) {
  return opts.map(([v, t, aria]) => {
    const rb = h('input', { type: 'radio', name, checked: value === v, 'aria-label': aria || t });
    rb.addEventListener('change', () => { if (rb.checked) onSet(v); });
    return h('label.pls-chk', rb, t);
  });
}

/** A round dial for an angle (0° = light from the right, 90° = from above). */
function angleDial(value, onSet) {
  const c = h('canvas.pls-dial', { width: 64, height: 64, 'aria-label': '각도 다이얼' });
  const draw = (a) => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    g.lineWidth = 2.5;
    g.strokeStyle = '#b4b4b4';
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.beginPath();
    g.arc(32, 32, 28, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    const r = (a * Math.PI) / 180;
    g.strokeStyle = '#f0f0f0';
    g.beginPath();
    g.moveTo(32, 32);
    g.lineTo(32 + Math.cos(r) * 25, 32 - Math.sin(r) * 25);
    g.stroke();
    g.fillStyle = '#f0f0f0';
    g.beginPath();
    g.arc(32, 32, 3.5, 0, Math.PI * 2);
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
  const c = h('canvas.pls-contour', { width: 26, height: 26 });
  const g = c.getContext('2d');
  const lut = contourLut(id);
  g.strokeStyle = '#000';
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i <= 24; i++) {
    const x = i / 24;
    const y = lut ? lut[Math.round(x * 256)] : x;
    if (i) g.lineTo(1 + i, 25 - y * 24);
    else g.moveTo(1, 25 - y * 24);
  }
  g.stroke();
  return c;
}
function contourRow(label, e, key, onChange, withAA = true, ...extra) {
  const icn = h('span.pls-cicon', contourIcon(e[key] || 'linear'));
  const s = h('select', { 'aria-label': label }, CONTOURS.map(([v, t]) => h('option', { value: v }, t)));
  s.value = e[key] || 'linear';
  s.addEventListener('change', () => {
    e[key] = s.value;
    icn.replaceChildren(contourIcon(s.value));
    onChange();
  });
  return row(label, icn, s, withAA ? check('앤티 앨리어스', e.antialias, (v) => { e.antialias = v; onChange(); }) : null, ...extra);
}

/** Photoshop's pattern picker: the pattern's swatch; a press opens the grid of patterns. */
function patternPicker(value, onSet, modal) {
  const sw = (id, s) => {
    const c = h('canvas', { width: s, height: s });
    const g = c.getContext('2d');
    g.fillStyle = g.createPattern(patternCanvas(id), 'repeat');
    g.fillRect(0, 0, s, s);
    return c;
  };
  const b = h('button.pls-patbtn', { type: 'button', title: '패턴 고르기', 'aria-label': '패턴 고르기', 'aria-haspopup': 'true' }, sw(value, 30), h('i.ph-caret'));
  let pop = null;
  const close = () => {
    pop?.remove();
    pop = null;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => {
    if (pop && !pop.contains(e.target) && !b.contains(e.target)) close();
  };
  b.addEventListener('click', () => {
    if (pop) return close();
    const host = modal() || document.body;
    pop = h('div.pls-patpop', { role: 'listbox', 'aria-label': '패턴' }, listPatterns().map((p) => h(`button.pls-patcell${p.id === value ? '.on' : ''}`, {
      type: 'button', title: p.name, 'aria-label': p.name,
      onclick: () => {
        value = p.id;
        b.firstChild.replaceWith(sw(value, 30));
        onSet(value);
        close();
        b.focus();
      },
    }, sw(p.id, 32))));
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      b.focus();
    });
    // placed inside the dialog (it may be dragged), under the button
    host.style.position ||= 'relative';
    const hr = host.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    pop.style.left = `${br.left - hr.left}px`;
    pop.style.top = `${br.bottom - hr.top + 2}px`;
    host.append(pop);
    pop.querySelector('.on, button')?.focus();
    document.addEventListener('pointerdown', outside, true);
  });
  b.closePop = close;
  return b;
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
  const adjust = l.kind === 'adjust';
  if (adjust && start !== 'blending') start = 'blending';
  const before = doc.capture();
  const orig = readLayer(l, doc);
  const st = readLayer(l, doc);
  let preview = true;
  let splitTouch = false;
  let raf = 0;
  let swTimer = 0;
  let dlg = null;
  // while a slider (or the shadow on the picture) is being dragged the picture shows a quicker,
  // smaller rendering of the effects; letting go draws them at full quality
  let held = false;
  const onHold = () => { held = true; };
  const onLetGo = () => {
    held = false;
    if (doc._fxDraft && !raf) raf = requestAnimationFrame(apply);
  };
  window.addEventListener('pointerdown', onHold, true);
  window.addEventListener('pointerup', onLetGo, true);
  window.addEventListener('pointercancel', onLetGo, true);
  const unhold = () => {
    window.removeEventListener('pointerdown', onHold, true);
    window.removeEventListener('pointerup', onLetGo, true);
    window.removeEventListener('pointercancel', onLetGo, true);
    if (doc._fxDraft?.id === l.id) doc._fxDraft = null;
  };
  const apply = () => {
    raf = 0;
    doc._fxDraft = held && preview ? { id: l.id } : null;
    writeLayer(l, doc, preview ? st : orig);
    l._styled = null;
    l._cache = null;
    // the pixels stay as they are: keep their measured bounds (reading a big layer again takes a while)
    const ob = l._ob?.rev === l.rev ? l._ob : null;
    doc.touch(l);
    if (ob) ob.rev = l.rev;
    P.redraw();
  };
  const changed = () => {
    if (!raf) raf = requestAnimationFrame(apply);
    clearTimeout(swTimer);
    swTimer = setTimeout(drawSwatch, 90);
    renderSide();
  };

  // ---- the swatch under 미리 보기: this style on a square, sized like the layer
  const swatch = h('canvas.pls-swatch', { width: 80, height: 80, 'aria-label': '스타일 미리 보기' });
  const layerBox = () => {
    try {
      return doc.opaqueBounds(l) || { w: doc.width, h: doc.height };
    } catch {
      return { w: doc.width, h: doc.height };
    }
  };
  const box0 = layerBox();
  function drawSwatch() {
    const g = swatch.getContext('2d');
    g.clearRect(0, 0, 80, 80);
    const k = clamp(44 / Math.max(1, box0.w, box0.h), 0.5, 1);
    g.drawImage(styleSquare(st.fx, { k, opacity: st.opacity, fillOpacity: st.fillOpacity ?? 1, angle: st.globalAngle, altitude: st.globalAltitude, fg: P.fg, bg: P.bg }), 0, 0);
  }

  // the selected entry: 'styles', 'blending', 'bevelContour', 'bevelTexture' or an fx key ('stroke', 'stroke_2', …)
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

  const list = h('div.pls-list', { role: 'list' });
  const sideFoot = h('div.pls-sidefoot');
  const side = h('div.pls-side', list, sideFoot);
  const pane = h('div.pls-pane');
  const defs = h('div.pls-defs');
  const main = h('div.pls-main', pane, defs);

  function select(key, enable = false) {
    cur = key;
    if (enable && key !== 'styles' && key !== 'blending') {
      if (key === 'bevelContour' || key === 'bevelTexture') {
        const b = ensure('bevel');
        b.enabled = true;
        b[key === 'bevelContour' ? 'contourOn' : 'textureOn'] = true;
      } else ensure(key).enabled = true;
      changed();
    }
    renderSide();
    renderPane();
  }
  /** Add one more of an effect (a copy of the chosen one, above it), as Photoshop's + does. */
  function addInstance(k) {
    const all = instanceKeys(st.fx, k).map((x) => st.fx[x]);
    const src = st.fx[cur] && baseKey(cur) === k ? st.fx[cur] : newEffect(k);
    const at = Math.max(0, instanceKeys(st.fx, k).indexOf(cur));
    all.splice(at, 0, { ...structuredClone(src), enabled: true });
    setInstances(st.fx, k, all);
    listMode = 'all';
    changed();
    select(instanceKeys(st.fx, k)[at]);
  }

  // keep the chosen entry in view (the list scrolls sideways on phones); only the list scrolls
  function revealOn() {
    const on = list.querySelector('.pls-item.on');
    if (!on || !list.isConnected) return;
    const a = list.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    if (b.left < a.left) list.scrollLeft -= a.left - b.left + 8;
    else if (b.right > a.right) list.scrollLeft += b.right - a.right + 8;
    if (b.top < a.top) list.scrollTop -= a.top - b.top;
    else if (b.bottom > a.bottom) list.scrollTop += b.bottom - a.bottom;
  }

  // a list row: Space chooses it; Enter is 확인 as everywhere in Photoshop's dialogs (a row keeps
  // the focus after a click, and Enter used to turn on the effect under it instead of closing)
  const item = (cls, onPick, ...kids) => h(`div.pls-item${cls}`, {
    role: 'button', tabindex: 0, onclick: onPick,
    onkeydown: (e) => {
      // (Space on the row's own check box toggles the box)
      if (e.key !== ' ' || e.target !== e.currentTarget) return;
      e.preventDefault();
      onPick();
    },
  }, ...kids);
  const box = (on, label, set) => {
    const b = h('input', { type: 'checkbox', checked: !!on, 'aria-label': label });
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      set(b.checked);
      changed();
    });
    return b;
  };

  function renderSide() {
    const rows = [
      item(`.head${cur === 'styles' ? '.on' : ''}`, () => select('styles'), h('span', '스타일')),
      item(`.head${cur === 'blending' ? '.on' : ''}`, () => select('blending'), h('span', '혼합 옵션')),
    ];
    if (!adjust) {
      for (const k of FX_LIST) {
        const keys = instanceKeys(st.fx, k);
        let shown = keys.length ? keys : [k];
        if (listMode === 'default') shown = shown.includes(cur) ? [cur] : shown.slice(0, 1);
        shown.forEach((key, i) => {
          const e = st.fx[key];
          const add = MULTI_FX.includes(k) ? h('button.pls-add', {
            type: 'button', title: `${FX_NAMES[k]} 하나 더 추가`, 'aria-label': `${FX_NAMES[k]} 추가`,
            onclick: (ev) => {
              ev.stopPropagation();
              addInstance(k);
            },
          }, icon('plus', 10)) : null;
          rows.push(item(cur === key ? '.on' : '', () => select(key, true),
            box(e?.enabled, `${FX_NAMES[k]} 켜기`, (v) => { ensure(key).enabled = v; }),
            h('span', FX_NAMES[k]), keys.length > 1 && listMode === 'all' ? h('span.pls-n', `${i + 1}`) : null, add));
          if (k === 'bevel') {
            const b = st.fx.bevel;
            rows.push(item(`.sub${cur === 'bevelContour' ? '.on' : ''}`, () => select('bevelContour', true),
              box(b?.enabled && b.contourOn, '윤곽선 켜기', (v) => {
                const bb = ensure('bevel');
                bb.contourOn = v;
                if (v) bb.enabled = true;
              }), h('span', '윤곽선')));
            rows.push(item(`.sub${cur === 'bevelTexture' ? '.on' : ''}`, () => select('bevelTexture', true),
              box(b?.enabled && b.textureOn, '텍스처 켜기', (v) => {
                const bb = ensure('bevel');
                bb.textureOn = v;
                if (v) bb.enabled = true;
              }), h('span', '텍스처')));
          }
        });
      }
    }
    list.replaceChildren(...rows);
    revealOn();
    // fx ▾, move up / down, delete the selected effect
    const k = baseKey(cur);
    const isFx = FX_LIST.includes(k) && cur !== 'bevelContour' && cur !== 'bevelTexture';
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
    const fxBtn = h('button.pls-fx', { type: 'button', title: '효과 추가 및 목록 표시 방법', 'aria-label': '효과 메뉴', 'aria-haspopup': 'menu' }, h('i', 'fx'), h('i.ph-caret'));
    fxBtn.addEventListener('click', () => {
      const r = fxBtn.getBoundingClientRect();
      showMenu([
        { label: '모든 효과 표시', checked: listMode === 'all', action: () => { listMode = 'all'; renderSide(); } },
        { label: '기본값 효과 표시', checked: listMode === 'default', action: () => { listMode = 'default'; renderSide(); } },
        '-',
        { label: '혼합 옵션…', action: () => select('blending') },
        ...(adjust ? [] : FX_LIST.map((fk) => ({
          label: `${FX_NAMES[fk]}…`,
          action: () => {
            if (MULTI_FX.includes(fk) && instanceKeys(st.fx, fk).some((x) => st.fx[x]?.enabled)) addInstance(fk);
            else select(instanceKeys(st.fx, fk).find((x) => st.fx[x]) || fk, true);
          },
        }))),
        '-',
        {
          label: '이 효과를 처음 기본값으로',
          hint: '포토샵 기본값',
          disabled: !isFx,
          action: () => {
            const e = ensure(cur);
            saveFxDefaults(k, null);
            for (const key of Object.keys(e)) delete e[key];
            Object.assign(e, factoryFx(k));
            if (USES_LIGHT.has(k)) e.useGlobalLight = true;
            changed();
            renderPane();
          },
        },
      ], r.left, r.top, { select: true });
    });
    sideFoot.replaceChildren(fxBtn,
      h('button.pls-ib', { type: 'button', title: '효과를 위로 이동 (위에 있는 효과가 위에 그려집니다)', 'aria-label': '효과 위로', disabled: !isFx || at <= 0, onclick: () => moveBy(-1) }, icon('up', 13)),
      h('button.pls-ib', { type: 'button', title: '효과를 아래로 이동', 'aria-label': '효과 아래로', disabled: !isFx || at < 0 || at >= keys.length - 1, onclick: () => moveBy(1) }, icon('down', 13)),
      h('span.pls-gap'),
      h('button.pls-ib', {
        type: 'button', title: '효과 삭제', 'aria-label': '효과 삭제', disabled: !isFx || !st.fx[cur],
        onclick: () => {
          const all = keys.map((x) => st.fx[x]).filter((_, i) => i !== at);
          setInstances(st.fx, k, all);
          changed();
          select(all.length ? instanceKeys(st.fx, k)[Math.max(0, at - 1)] : 'blending');
        },
      }, icon('trash', 13)));
  }

  // ---- panes

  const defaultsButtons = (k, e) => [
    h('button', { type: 'button', title: '지금 설정을 이 효과의 기본값으로 기억합니다', onclick: () => { saveFxDefaults(k, e); toast(`${FX_NAMES[k]}: 기본값으로 만들었습니다`); } }, '기본값으로 만들기'),
    h('button', {
      type: 'button',
      title: '기억해 둔 기본값(없으면 포토샵 기본값)으로 되돌립니다',
      onclick: () => {
        const d = fxDefaults(k);
        for (const key of Object.keys(e)) delete e[key];
        Object.assign(e, d, { enabled: true });
        if (USES_LIGHT.has(k) && e.useGlobalLight === undefined) e.useGlobalLight = true;
        changed();
        renderPane();
      },
    }, '기본값으로 재설정')];

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
    const rows = [row('각도', dial, num, h('small.pls-unit', '°'),
      check('전체 조명 사용', e.useGlobalLight, (v) => {
        // on: the effect follows the document's light; off: it keeps that angle as its own
        e.useGlobalLight = v;
        if (!v) e.angle = st.globalAngle;
        if (withAltitude && !v) e.altitude = st.globalAltitude;
        changed();
        renderPane();
      }, '모든 레이어의 효과가 같은 빛 방향을 씁니다'))];
    if (withAltitude) {
      rows.push(rangeRow('고도', useGlobal() ? st.globalAltitude : e.altitude ?? 30, 0, 90, '°', (v) => {
        if (useGlobal()) st.globalAltitude = v;
        else e.altitude = v;
        changed();
      }));
    }
    return rows;
  };
  /** A plain angle (gradients, satin, patterns) without global light. `reset`: 정렬 재설정 beside it. */
  const angleField = (e, key = 'angle', def = 90, ...extra) => {
    const num = h('input.ph-num', { type: 'number', min: -180, max: 180, value: e[key] ?? def, 'aria-label': '각도' });
    const dial = angleDial(e[key] ?? def, (a) => { e[key] = a; num.value = a; changed(); });
    num.addEventListener('change', () => { e[key] = clamp(Math.round(+num.value), -180, 180); dial.redraw(e[key]); changed(); });
    return row('각도', dial, num, h('small.pls-unit', '°'), ...extra);
  };
  const pct = (e, key, label, def = 1, ...extra) => rangeRow(label, Math.round((e[key] ?? def) * 100), 0, 100, '%', (v) => { e[key] = v / 100; changed(); }, 1, ...extra);
  const pxRow = (e, key, label, max = 250, min = 0) => rangeRow(label, e[key] ?? 0, min, max, 'px', (v) => { e[key] = v; changed(); });
  const pRow = (e, key, label, max = 100, min = 0) => rangeRow(label, e[key] ?? 0, min, max, '%', (v) => { e[key] = v; changed(); });
  const fs = (legend, ...kids) => h('fieldset.pls-group', legend ? h('legend', legend) : null, ...kids.filter(Boolean));
  const modalEl = () => dlg?.modal;
  const resetBtn = (label, title, fn) => h('button.pls-sbtn', { type: 'button', title, onclick: () => { fn(); changed(); } }, label);
  // the gradient part of a gradient overlay / a gradient stroke, laid out as in Photoshop
  const gradientRows = (e, withDither) => [
    row('그레이디언트', gradientPicker(P, e.gradient, (g) => { e.gradient = g; changed(); }), check('반전', e.reverse, (v) => { e.reverse = v; changed(); })),
    selectRow('스타일', GRADIENT_STYLES, e.style || 'linear', (v) => { e.style = v; changed(); },
      check('레이어에 정렬', e.align !== false, (v) => { e.align = v; changed(); }, '끄면 그레이디언트가 문서 전체에 펼쳐집니다')),
    angleField(e, 'angle', 90, resetBtn('정렬 재설정', '그림에서 끌어 옮긴 그레이디언트를 가운데로 되돌립니다', () => { delete e.offset; }),
      withDither ? check('디더', e.dither, (v) => { e.dither = v; changed(); }, '단계가 줄무늬로 보이지 않게 고르게 섞습니다') : null),
    rangeRow('비율', e.scale ?? 100, 10, 150, '%', (v) => { e.scale = v; changed(); }),
    h('div.pls-note', '창이 열린 동안 그림을 끌면 그레이디언트를 옮길 수 있습니다.'),
  ];
  // a pattern with 원점에 스냅 (Snap to Origin), its angle and scale
  const patternRows = (e, { key = 'pattern', phase = 'phase', angle = 'angle', scale = 'scale' } = {}) => [
    row('패턴', patternPicker(e[key] || 'checker', (v) => { e[key] = v; changed(); }, modalEl),
      resetBtn('원점에 스냅', '그림에서 끌어 옮긴 패턴을 원점으로 되돌립니다', () => { delete e[phase]; })),
    angle ? angleField(e, angle, 0) : null,
    rangeRow('비율', e[scale] ?? 100, 1, 1000, '%', (v) => { e[scale] = v; changed(); }),
  ];
  // a glow's paint: one colour or a gradient (with 파형 under 품질)
  const glowFill = (e) => {
    const name = `pls-gf-${Math.random().toString(36).slice(2, 7)}`;
    const [rc, rg] = radios(name, [['color', '', '단색'], ['gradient', '', '그레이디언트']], e.fill === 'gradient' ? 'gradient' : 'color', (v) => {
      e.fill = v;
      if (v === 'gradient' && !e.gradient) e.gradient = { stops: [{ pos: 0, color: e.color || '#ffffbe' }, { pos: 1, color: e.color || '#ffffbe' }], alphas: [{ pos: 0, a: 1 }, { pos: 1, a: 0 }] };
      changed();
    });
    rc.title = '단색';
    rg.title = '그레이디언트';
    return h('div.pls-row.pls-glowfill', h('span.pls-lbl'), rc, colorInput(e.color, (v) => { e.color = v; changed(); }),
      rg, gradientPicker(P, e.gradient || { stops: [{ pos: 0, color: e.color || '#ffffbe' }, { pos: 1, color: e.color || '#ffffbe' }], alphas: [{ pos: 0, a: 1 }, { pos: 1, a: 0 }] }, (g) => { e.gradient = g; e.fill = 'gradient'; rg.querySelector('input').checked = true; changed(); }));
  };

  function renderPane() {
    pane.closest('.modal')?.querySelectorAll('.pls-patpop').forEach((p) => p.remove());
    defs.replaceChildren();
    if (cur === 'styles') return paneStyles();
    if (cur === 'blending') return paneBlending();
    if (cur === 'bevelContour') return paneBevelContour();
    if (cur === 'bevelTexture') return paneBevelTexture();
    const k = baseKey(cur);
    const e = ensure(cur);
    let body = [];
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
        k === 'dropShadow' ? h('div.pls-row', h('span.pls-lbl'), check('레이어가 드롭 섀도를 녹아웃', e.knockout !== false, (v) => { e.knockout = v; changed(); }, '레이어 아래에 가려진 그림자를 지웁니다 (칠을 낮췄을 때 보임)')) : null,
        h('div.pls-note', '창이 열린 동안 그림을 끌면 그림자의 각도와 거리를 바꿀 수 있습니다.'),
      ];
    } else if (k === 'outerGlow' || k === 'innerGlow') {
      body = [
        fs('구조',
          blendRow('혼합 모드', e, 'blend', null, changed),
          pct(e, 'opacity', '불투명도', 0.75),
          pRow(e, 'noise', '노이즈'),
          glowFill(e)),
        fs('요소',
          selectRow('기법', [['softer', '더 부드럽게'], ['precise', '정확하게']], e.technique || 'softer', (v) => { e.technique = v; changed(); }),
          k === 'innerGlow' ? row('소스', ...radios(`pls-src-${cur}`, [['center', '가운데'], ['edge', '가장자리']], e.source || 'edge', (v) => { e.source = v; changed(); })) : null,
          k === 'outerGlow' ? pRow(e, 'spread', '스프레드') : pRow(e, 'choke', '경계 감소'),
          pxRow(e, 'size', '크기', 250)),
        fs('품질',
          contourRow('윤곽선', e, 'contour', changed),
          rangeRow('범위', e.range ?? 50, 1, 100, '%', (v) => { e.range = v; changed(); }),
          rangeRow('파형', e.jitter ?? 0, 0, 100, '%', (v) => { e.jitter = v; changed(); })),
      ];
    } else if (k === 'bevel') {
      body = [
        fs('구조',
          selectRow('스타일', [['inner bevel', '내부 경사'], ['outer bevel', '외부 경사'], ['emboss', '엠보스'], ['pillow emboss', '쿠션 엠보스'], ['stroke emboss', '획 엠보스']], e.style || 'inner bevel', (v) => { e.style = v; changed(); }),
          selectRow('기법', [['smooth', '매끄럽게'], ['chisel hard', '단단하게 깎기'], ['chisel soft', '부드럽게 깎기']], e.technique || 'smooth', (v) => { e.technique = v; changed(); }),
          rangeRow('깊이', e.depth ?? 100, 1, 1000, '%', (v) => { e.depth = v; changed(); }),
          row('방향', ...radios(`pls-dir-${cur}`, [['up', '위로'], ['down', '아래로']], e.direction || 'up', (v) => { e.direction = v; changed(); })),
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
        angleField(e, 'angle', 19),
        pxRow(e, 'distance', '거리', 250),
        pxRow(e, 'size', '크기', 250),
        contourRow('윤곽선', e, 'contour', changed, true, check('반전', e.invert, (v) => { e.invert = v; changed(); })))];
    } else if (k === 'colorOverlay') {
      body = [fs('색상', blendRow('혼합 모드', e, 'blend', 'color', changed), pct(e, 'opacity', '불투명도'))];
    } else if (k === 'gradientOverlay') {
      body = [fs('그레이디언트',
        blendRow('혼합 모드', e, 'blend', null, changed, check('디더', e.dither, (v) => { e.dither = v; changed(); }, '단계가 줄무늬로 보이지 않게 고르게 섞습니다')),
        pct(e, 'opacity', '불투명도'),
        ...gradientRows(e, false))];
    } else if (k === 'patternOverlay') {
      body = [fs('패턴',
        blendRow('혼합 모드', e, 'blend', null, changed),
        pct(e, 'opacity', '불투명도'),
        ...patternRows(e),
        row('', check('레이어에 연결', e.link !== false, (v) => { e.link = v; changed(); }, '켜면 레이어를 옮길 때 패턴도 함께 움직입니다')),
        h('div.pls-note', '창이 열린 동안 그림을 끌면 패턴을 옮길 수 있습니다.'))];
    } else if (k === 'stroke') {
      const typeSpecific = e.fillType === 'gradient'
        ? gradientRows(e, true)
        : e.fillType === 'pattern'
          ? [...patternRows(e, { angle: 'patAngle' }),
            row('', check('레이어에 연결', e.link !== false, (v) => { e.link = v; changed(); }, '켜면 레이어를 옮길 때 패턴도 함께 움직입니다'))]
          : [row('색상', colorInput(e.color, (v) => { e.color = v; changed(); }))];
      body = [
        fs('구조',
          pxRow(e, 'size', '크기', 250, 1),
          selectRow('위치', [['outside', '바깥쪽'], ['inside', '안쪽'], ['center', '가운데']], e.position || 'outside', (v) => { e.position = v; changed(); }),
          blendRow('혼합 모드', e, 'blend', null, changed),
          pct(e, 'opacity', '불투명도'),
          row('', check('중복 인쇄', e.overprint, (v) => { e.overprint = v; changed(); }))),
        fs('', selectRow('칠 유형', [['color', '색상'], ['gradient', '그레이디언트'], ['pattern', '패턴']], e.fillType || 'color', (v) => { e.fillType = v; changed(); renderPane(); }),
          ...typeSpecific),
      ];
    }
    pane.replaceChildren(h('h4', FX_NAMES[k]), ...body.filter(Boolean));
    defs.replaceChildren(...defaultsButtons(k, e));
    return undefined;
  }

  function paneBevelContour() {
    const e = ensure('bevel');
    pane.replaceChildren(h('h4', '윤곽선'), fs('요소',
      contourRow('윤곽선', e, 'profile', changed),
      rangeRow('범위', e.profileRange ?? 50, 1, 100, '%', (v) => { e.profileRange = v; changed(); }),
      h('div.pls-note', '경사 면의 모양(굴곡)을 바꿉니다. 왼쪽 목록의 "윤곽선"을 켜야 적용됩니다.')));
  }

  function paneBevelTexture() {
    const e = ensure('bevel');
    pane.replaceChildren(h('h4', '텍스처'), fs('요소',
      ...patternRows(e, { key: 'texPattern', phase: 'texPhase', angle: null, scale: 'texScale' }),
      rangeRow('깊이', e.texDepth ?? 100, -1000, 1000, '%', (v) => { e.texDepth = v; changed(); }),
      row('', check('반전', e.texInvert, (v) => { e.texInvert = v; changed(); }),
        check('레이어에 연결', e.texLink !== false, (v) => { e.texLink = v; changed(); }, '켜면 레이어를 옮길 때 텍스처도 함께 움직입니다')),
      h('div.pls-note', '패턴의 밝은 곳은 솟아오르고 어두운 곳은 들어가 보입니다. 왼쪽 목록의 "텍스처"를 켜야 적용됩니다. 창이 열린 동안 그림을 끌면 텍스처를 옮길 수 있습니다.')));
  }

  const thumbs = new Map();
  function paneStyles() {
    const presets = [...STYLE_PRESETS, ...userStyles().map((u) => ({ ...u, user: true }))];
    const cell = (pr) => {
      const key = `${pr.id}:${JSON.stringify(pr.fx || {}).length}`;
      if (!thumbs.has(key)) {
        const t = h('canvas', { width: 44, height: 44 });
        t.getContext('2d').drawImage(styleSquare(pr.fx, { size: 88, k: 0.6, fg: P.fg, bg: P.bg }), 0, 0, 44, 44);
        thumbs.set(key, t);
      }
      return h('button.pls-cell', {
        type: 'button', title: pr.name, 'aria-label': pr.name,
        onclick: () => {
          st.fx = normalizeFx(structuredClone(pr.fx || {}));
          if (pr.blending) Object.assign(st, structuredClone(pr.blending));
          changed();
        },
      }, thumbs.get(key));
    };
    pane.replaceChildren(h('h4', '스타일'), h('div.pls-note', '누르면 이 레이어의 효과를 그 스타일로 바꿉니다. 이름은 칸 위에 마우스를 올리면 보입니다.'), h('div.pls-grid', presets.map(cell)));
  }

  function paneBlending() {
    const isGroup = l.kind === 'group';
    const blend = blendSelect(isGroup);
    blend.value = st.blend || (isGroup ? 'pass through' : 'normal');
    blend.addEventListener('change', () => { st.blend = blend.value; changed(); });
    const general = fs('일반 혼합',
      row('혼합 모드', blend),
      rangeRow('불투명도', Math.round(st.opacity * 100), 0, 100, '%', (v) => { st.opacity = v / 100; changed(); }));
    const ch = st.blendChannels || { r: true, g: true, b: true };
    const chan = (key, label) => check(label, ch[key] !== false, (v) => { st.blendChannels = { ...ch, ...(st.blendChannels || {}), [key]: v }; ch[key] = v; changed(); }, `${label} 채널에 그립니다`);
    const knock = h('select', { 'aria-label': '녹아웃' }, [['none', '없음'], ['shallow', '얕게'], ['deep', '깊게']].map(([v, t]) => h('option', { value: v }, t)));
    knock.value = st.knockout || 'none';
    knock.addEventListener('change', () => { st.knockout = knock.value === 'none' ? undefined : knock.value; changed(); });
    const advanced = fs('고급 혼합',
      isGroup ? null : rangeRow('칠 불투명도', Math.round((st.fillOpacity ?? 1) * 100), 0, 100, '%', (v) => { st.fillOpacity = v / 100; changed(); }),
      row('채널', chan('r', 'R'), chan('g', 'G'), chan('b', 'B')),
      row('녹아웃', knock),
      h('div.pls-checks',
        check('내부 효과를 그룹으로 혼합', st.blendInterior, (v) => { st.blendInterior = v || undefined; changed(); }, '색상 오버레이·새틴·내부 광선 같은 안쪽 효과도 칠 불투명도와 혼합 모드를 따릅니다'),
        check('클리핑된 레이어를 그룹으로 혼합', st.blendClipped !== false, (v) => { st.blendClipped = v ? undefined : false; changed(); }, '끄면 클리핑된 레이어가 각자 자기 혼합 모드로 섞입니다'),
        check('투명 모양 레이어', st.transparencyShapes !== false, (v) => { st.transparencyShapes = v ? undefined : false; changed(); }),
        check('레이어 마스크로 효과 숨기기', st.maskHidesFx, (v) => { st.maskHidesFx = v || undefined; changed(); }, '효과를 마스크 전의 모양으로 만들고, 마스크가 효과까지 가립니다'),
        check('벡터 마스크로 효과 숨기기', st.vmaskHidesFx, (v) => { st.vmaskHidesFx = v || undefined; changed(); })));
    // Blend If
    const chSel = h('select', { 'aria-label': '혼합 조건 채널' }, [['gray', '회색'], ['r', '빨강'], ['g', '초록'], ['b', '파랑']].map(([v, t]) => h('option', { value: v }, t)));
    chSel.value = paneBlending.ch || 'gray';
    const sliders = h('div.pls-bis');
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
      row('', chSel, resetBtn('재설정', '모든 채널의 혼합 조건을 처음으로', () => { st.blendIf = null; drawSliders(); })),
      sliders,
      row('', check('슬라이더 나누기 (Alt+드래그와 같음)', splitTouch, (v) => { splitTouch = v; }, '켜고 끌면 삼각형이 둘로 나뉘어 부드럽게 넘어가게 됩니다')),
      h('div.pls-note', '이 레이어가 보일 밝기 범위와, 아래 레이어의 어느 밝기 위에서 보일지를 정합니다. Alt를 누른 채 삼각형을 끌면 반으로 나뉘어 경계가 부드러워집니다.'));
    pane.replaceChildren(h('h4', '혼합 옵션'), general, advanced, blendIf);
  }

  // ---- dragging on the picture while the dialog is open (Photoshop moves the effect being edited)
  const dragTarget = () => {
    const k = baseKey(cur);
    if (cur === 'bevelTexture') return st.fx.bevel?.textureOn ? 'texture' : null;
    const e = st.fx[cur];
    if (!e?.enabled) return null;
    if (k === 'dropShadow' || k === 'innerShadow') return 'shadow';
    if (k === 'gradientOverlay' || (k === 'stroke' && e.fillType === 'gradient')) return 'gradient';
    if (k === 'patternOverlay' || (k === 'stroke' && e.fillType === 'pattern')) return 'pattern';
    return null;
  };
  const onStage = (e, back) => {
    const r = document.querySelector('.ph-stage')?.getBoundingClientRect();
    return e.target === back && r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
  };
  function pictureDrag(back) {
    back.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      back.style.cursor = onStage(e, back) && dragTarget() ? 'move' : '';
    });
    back.addEventListener('pointerdown', (e) => {
      const kind = onStage(e, back) && e.button === 0 ? dragTarget() : null;
      if (!kind || !P.toDoc) return;
      e.preventDefault();
      back.setPointerCapture(e.pointerId);
      const p0 = P.toDoc(e.clientX, e.clientY);
      const fx = kind === 'texture' ? st.fx.bevel : st.fx[cur];
      const global = kind === 'shadow' && fx.useGlobalLight;
      const a0 = (((global ? st.globalAngle : fx.angle ?? 120) * Math.PI) / 180);
      const v0 = [-Math.cos(a0) * (fx.distance || 0), Math.sin(a0) * (fx.distance || 0)];
      const off0 = (kind === 'gradient' ? fx.offset : kind === 'texture' ? fx.texPhase : fx.phase) || [0, 0];
      const gb = fx.align === false ? { w: doc.width, h: doc.height } : layerBox();
      const mv = (ev) => {
        const p = P.toDoc(ev.clientX, ev.clientY);
        const dx = p.x - p0.x;
        const dy = p.y - p0.y;
        if (kind === 'shadow') {
          const vx = v0[0] + dx;
          const vy = v0[1] + dy;
          fx.distance = clamp(Math.round(Math.hypot(vx, vy)), 0, 30000);
          if (fx.distance) {
            const a = Math.round((Math.atan2(vy, -vx) * 180) / Math.PI);
            if (global) st.globalAngle = a;
            else fx.angle = a;
          }
        } else if (kind === 'gradient') fx.offset = [Math.round(off0[0] + (dx / Math.max(1, gb.w)) * 100), Math.round(off0[1] + (dy / Math.max(1, gb.h)) * 100)];
        else fx[kind === 'texture' ? 'texPhase' : 'phase'] = [Math.round(off0[0] + dx), Math.round(off0[1] + dy)];
        changed();
      };
      const up = () => {
        back.removeEventListener('pointermove', mv);
        back.removeEventListener('pointerup', up);
        back.removeEventListener('pointercancel', up);
        renderPane();
      };
      back.addEventListener('pointermove', mv);
      back.addEventListener('pointerup', up);
      back.addEventListener('pointercancel', up);
    });
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
      width: '420px',
      side: true,
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
  const aside = h('div.pls-aside',
    check('미리 보기', preview, (v) => { preview = v; apply(); }, '끄면 그림에서 원래 모습을 봅니다'),
    h('div.pls-swwrap', swatch));
  dlg = openModal({
    title: '레이어 스타일',
    width: '900px',
    side: true,
    aside,
    body: [h('div.pls', side, main)],
    buttons: [
      { label: '취소' },
      { label: '새 스타일…', action: newStyle },
      { label: '확인', primary: true, action: () => { cancelAnimationFrame(raf); preview = true; held = false; apply(); ok = true; P.commit('레이어 스타일', before); } },
    ],
    onClose: () => {
      cancelAnimationFrame(raf);
      clearTimeout(swTimer);
      unhold();
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  dlg.modal.classList.add('pls-dlg');
  pictureDrag(dlg.modal.parentElement);
  if (FX_LIST.includes(start)) changed();
  drawSwatch();
  requestAnimationFrame(revealOn);
  return undefined;
}

/** Layer ▸ Layer Style ▸ Global Light… (전체 조명): the light all effects with "use global light" share. */
export function globalLightDialog(P) {
  const doc = P.doc;
  if (!doc) return;
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
    width: '420px',
    side: true,
    body: [h('div.pls-pane.plain', h('fieldset.pls-group', h('legend', '전체 조명'),
      row('각도', dial, num, h('small.pls-unit', '°')),
      rangeRow('고도', v.alt, 0, 90, '°', (x) => { v.alt = x; apply(); })),
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
