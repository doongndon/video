// Colour pickers for the photo editor: the compact HSV picker of the Color panel (saturation /
// value square, hue strip, hex field) and Photoshop's Color Picker dialog (색상 피커): a big field and
// a slider for any of H, S, B, R, G, B, L, a, b, the numbers in HSB, RGB, Lab, CMYK and hex, Only
// Web Colors, the new and current colours, Add to Swatches.

import { h, clamp } from '../util.js';
import { openModal } from '../ui/common.js';
import { injectStyle } from '../ui/style-inject.js';

/** '#abc', 'abc', '#aabbcc' or 'aabbcc' as '#aabbcc' (null when it is not a colour). */
export function normHex(v) {
  let t = String(v || '').trim().replace(/^#/, '').replace(/[^0-9a-f]/gi, '');
  if (t.length === 3) t = t.split('').map((c) => c + c).join('');
  if (t.length !== 6) return null;
  return `#${t.toLowerCase()}`;
}

export function hexToHsv(hex) {
  const n = parseInt((normHex(hex) || '#000000').slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, max ? d / max : 0, max];
}

export function hsvToHex(hh, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((k) => Math.round((k + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** onChange(hex, done) is called while dragging (done=false) and at the end (done=true). */
export function createColorPicker({ value = '#000000', onChange = () => {} } = {}) {
  let [hue, sat, val] = hexToHsv(value);
  const sv = h('canvas.cp-sv', { width: 220, height: 140, 'aria-label': '채도·밝기' });
  const hb = h('canvas.cp-hue', { width: 220, height: 14, 'aria-label': '색조' });
  const hex = h('input.cp-hex', { type: 'text', value, maxlength: 7, 'aria-label': '색상 코드', spellcheck: false });
  const el = h('div.cp', sv, hb, h('div.cp-row', h('span', '#'), hex));

  function draw() {
    const g = sv.getContext('2d');
    const { width: w, height: hh } = sv;
    g.fillStyle = hsvToHex(hue, 1, 1);
    g.fillRect(0, 0, w, hh);
    const wg = g.createLinearGradient(0, 0, w, 0);
    wg.addColorStop(0, '#fff');
    wg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = wg;
    g.fillRect(0, 0, w, hh);
    const bg = g.createLinearGradient(0, 0, 0, hh);
    bg.addColorStop(0, 'rgba(0,0,0,0)');
    bg.addColorStop(1, '#000');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, hh);
    g.strokeStyle = val > 0.5 ? '#000' : '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sat * w, (1 - val) * hh, 6, 0, Math.PI * 2);
    g.stroke();
    const hg = hb.getContext('2d');
    const grad = hg.createLinearGradient(0, 0, hb.width, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, hsvToHex(i * 60 % 360, 1, 1));
    hg.fillStyle = grad;
    hg.fillRect(0, 0, hb.width, hb.height);
    hg.fillStyle = '#fff';
    hg.fillRect((hue / 360) * hb.width - 2, 0, 4, hb.height);
    hg.strokeStyle = '#000';
    hg.strokeRect((hue / 360) * hb.width - 2.5, 0.5, 5, hb.height - 1);
  }

  const emit = (done) => {
    const v = hsvToHex(hue, sat, val);
    hex.value = v.slice(1);
    onChange(v, done);
  };
  const drag = (canvas, fn) => {
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const at = (ev) => {
        const r = canvas.getBoundingClientRect();
        fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
        draw();
        emit(false);
      };
      at(e);
      const mv = (ev) => at(ev);
      const up = () => {
        canvas.removeEventListener('pointermove', mv);
        canvas.removeEventListener('pointerup', up);
        emit(true);
      };
      canvas.addEventListener('pointermove', mv);
      canvas.addEventListener('pointerup', up);
    });
  };
  drag(sv, (x, y) => {
    sat = x;
    val = 1 - y;
  });
  drag(hb, (x) => {
    hue = x * 359.9;
  });
  hex.addEventListener('change', () => {
    // three digits mean doubled digits (f80 = ff8800), like CSS and Photoshop
    const v = normHex(hex.value) || `#${hex.value.replace(/[^0-9a-f]/gi, '').padEnd(6, '0').slice(0, 6)}`;
    [hue, sat, val] = hexToHsv(v);
    draw();
    onChange(v, true);
  });
  draw();
  return {
    el,
    set(v) {
      if (!v) return;
      const [h2, s2, v2] = hexToHsv(v);
      // keep the hue when the colour is grey
      if (s2 > 0 && v2 > 0) hue = h2;
      sat = s2;
      val = v2;
      hex.value = v.slice(1);
      draw();
    },
  };
}

// ---------------------------------------------------------------- Photoshop's Color Picker

const D65 = [0.95047, 1, 1.08883];
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB (0..255) to CIE Lab (D65). */
export function rgbToLab(r, g, b) {
  const R = lin(r / 255);
  const G = lin(g / 255);
  const B = lin(b / 255);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / D65[0]);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / D65[2]);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE Lab (D65) to sRGB (0..255, clipped) and whether it had to be clipped. */
export function labToRgb(L, a, b) {
  const y = (L + 16) / 116;
  const x = a / 500 + y;
  const z = y - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = D65[0] * f(x);
  const Y = f(y);
  const Z = D65[2] * f(z);
  const rgb = [X * 3.2406 + Y * -1.5372 + Z * -0.4986, X * -0.9689 + Y * 1.8758 + Z * 0.0415, X * 0.0557 + Y * -0.204 + Z * 1.057].map((c) => gam(c) * 255);
  return rgb.map((c) => clamp(c, 0, 255));
}

function hsbToRgb(hh, s, v) {
  hh = (((hh % 360) + 360) % 360) / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6].map((x) => x * 255);
}

function rgbToHsb(r, g, b) {
  const [hh, s, v] = hexToHsv(`#${[r, g, b].map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('')}`);
  return [hh, s, v];
}

const hexOf = (r, g, b) => `#${[r, g, b].map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
const rgbOf = (hex) => {
  const n = parseInt((normHex(hex) || '#000000').slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** Simple (uncalibrated) CMYK, in percent, like a quick approximation of Photoshop's numbers. */
const rgbToCmyk = (r, g, b) => {
  const k = 1 - Math.max(r, g, b) / 255;
  if (k >= 1) return [0, 0, 0, 100];
  return [(1 - r / 255 - k) / (1 - k), (1 - g / 255 - k) / (1 - k), (1 - b / 255 - k) / (1 - k), k].map((x) => Math.round(x * 100));
};
const cmykToRgb = (c, m, y, k) => [255 * (1 - c / 100) * (1 - k / 100), 255 * (1 - m / 100) * (1 - k / 100), 255 * (1 - y / 100) * (1 - k / 100)];
/** Nearest of the 216 web-safe colours. */
const webSafe = (rgb) => rgb.map((c) => Math.round(c / 51) * 51);

injectStyle('ph-colorpicker-dialog-css', `
.pcp { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.pcp-field, .pcp-strip { display: block; border: 1px solid var(--line-2); cursor: crosshair; touch-action: none; }
.pcp-field { width: calc(256px * var(--ui-scale)); height: calc(256px * var(--ui-scale)); max-width: 62vw; max-height: 62vw; }
.pcp-strip { width: calc(22px * var(--ui-scale)); height: calc(256px * var(--ui-scale)); max-height: 62vw; }
.pcp-side { display: flex; flex-direction: column; gap: 6px; min-width: calc(220px * var(--ui-scale)); }
.pcp-swatch { display: grid; grid-template-rows: 1fr 1fr; width: calc(70px * var(--ui-scale)); height: calc(70px * var(--ui-scale)); border: 1px solid var(--line-2); border-radius: 3px; overflow: hidden; }
.pcp-swatch > div { min-height: 0; }
.pcp-swatch .cur { cursor: pointer; }
.pcp-top { display: flex; gap: 10px; align-items: center; }
.pcp-top small { color: var(--text-faint); font-size: var(--fs-xs); line-height: 1.6; }
.pcp-grid { display: grid; grid-template-columns: auto auto; gap: 3px 14px; }
.pcp-f { display: flex; align-items: center; gap: 4px; font-size: var(--fs-s); color: var(--text-dim); }
.pcp-f input[type=radio] { margin: 0; }
.pcp-f b { min-width: 14px; font-weight: 600; }
.pcp-f input[type=number] { width: calc(54px * var(--ui-scale)); min-height: 0; height: calc(24px * var(--ui-scale)); padding: 0 4px; }
.pcp-f small { color: var(--text-faint); min-width: 12px; }
.pcp-hex { width: calc(78px * var(--ui-scale)); font-family: ui-monospace, Menlo, Consolas, monospace; text-transform: uppercase; }
.pcp-warn { color: var(--warn); font-size: var(--fs-xs); min-height: 1.2em; }
.pcp-note { color: var(--text-faint); font-size: var(--fs-xs); }
.pcp-web { display: inline-flex; align-items: center; gap: 4px; padding: 0 4px; min-height: 0; height: calc(20px * var(--ui-scale)); font-size: var(--fs-xs); }
.pcp-web i { display: inline-block; width: 12px; height: 12px; border: 1px solid var(--line-2); }
.modal-backdrop.pcp-sampling { background: rgba(0, 0, 0, .15); cursor: crosshair; }
.modal-backdrop.pcp-sampling .modal { cursor: auto; }
`);

/**
 * Photoshop's Color Picker as a dialog. onOk(hex) is called with the chosen colour; onAddSwatch(hex)
 * (optional) shows the 견본에 추가 button; sample(clientX, clientY) (optional) returns the colour of
 * the picture under the pointer, so clicking the picture behind the dialog picks it, like Photoshop.
 */
export function colorPickerDialog({ title = '색상 피커', value = '#000000', onOk = () => {}, onAddSwatch = null, sample = null } = {}) {
  const current = normHex(value) || '#000000';
  let rgb = rgbOf(current);
  let [hue, sat, bri] = rgbToHsb(...rgb);
  let lab = rgbToLab(...rgb);
  let mode = 'H';
  let webOnly = false;
  const field = h('canvas.pcp-field', { width: 256, height: 256, 'aria-label': '색상 필드' });
  const strip = h('canvas.pcp-strip', { width: 22, height: 256, 'aria-label': '색상 슬라이더' });
  const sNew = h('div', { title: '새로운 색' });
  const sCur = h('div.cur', { title: '현재 색 (누르면 되돌리기)', style: { background: current } });
  const warn = h('div.pcp-warn');
  // Photoshop's "not a web colour" cube: the nearest web-safe colour, clicked to use it
  const webChip = h('i');
  const webBtn = h('button.small.pcp-web', { title: '웹 색상이 아님: 가장 가까운 웹 색상으로 바꾸기', 'aria-label': '가장 가까운 웹 색상', onclick: () => setRgb(webSafe(rgb)) }, webChip, '웹 색상으로');
  const inputs = {};
  const num = (key, min, max, unit) => {
    const i = h('input', { type: 'number', min, max, step: 1, 'aria-label': key });
    inputs[key] = i;
    i.addEventListener('change', () => fromInput(key));
    return [i, unit ? h('small', unit) : h('small')];
  };
  const radio = (m) => {
    const r = h('input', { type: 'radio', name: 'pcp-mode', checked: mode === m, 'aria-label': `${m} 기준` });
    r.addEventListener('change', () => {
      mode = m;
      draw();
    });
    return r;
  };
  const row = (m, label, key, min, max, unit) => h('label.pcp-f', m ? radio(m) : h('span', { style: { width: '13px' } }), h('b', label), ...num(key, min, max, unit));
  const hex = h('input.pcp-hex', { type: 'text', maxlength: 7, 'aria-label': '16진수 색상 코드', spellcheck: false });
  hex.addEventListener('change', () => {
    const v = normHex(hex.value);
    if (v) setRgb(rgbOf(v));
    else update();
  });
  const web = h('input', { type: 'checkbox', 'aria-label': '웹 색상만' });
  web.addEventListener('change', () => {
    webOnly = web.checked;
    if (webOnly) setRgb(webSafe(rgb));
    else draw();
  });

  // ---- state changes
  function setRgb(v, keepHsb = false) {
    rgb = webOnly ? webSafe(v) : v.map((c) => clamp(c, 0, 255));
    if (!keepHsb || webOnly) {
      const [h2, s2, b2] = rgbToHsb(...rgb);
      // a grey keeps the hue (and a black the saturation), so the field does not jump
      if (s2 > 0 && b2 > 0) hue = h2;
      if (b2 > 0) sat = s2;
      bri = b2;
    }
    lab = rgbToLab(...rgb);
    draw();
  }
  function setHsb(h2, s2, b2) {
    hue = clamp(h2, 0, 359.99);
    sat = clamp(s2, 0, 1);
    bri = clamp(b2, 0, 1);
    setRgb(hsbToRgb(hue, sat, bri), true);
  }
  function setLab(L, a, b) {
    setRgb(labToRgb(clamp(L, 0, 100), clamp(a, -128, 127), clamp(b, -128, 127)));
    lab = [clamp(L, 0, 100), clamp(a, -128, 127), clamp(b, -128, 127)];
    update();
  }
  function fromInput(key) {
    const v = +inputs[key].value;
    if (Number.isNaN(v)) return update();
    const cm = rgbToCmyk(...rgb);
    switch (key) {
      case 'H': return setHsb(v, sat, bri);
      case 'S': return setHsb(hue, v / 100, bri);
      case 'B': return setHsb(hue, sat, v / 100);
      case 'R': return setRgb([v, rgb[1], rgb[2]]);
      case 'G': return setRgb([rgb[0], v, rgb[2]]);
      case 'Bl': return setRgb([rgb[0], rgb[1], v]);
      case 'L': return setLab(v, lab[1], lab[2]);
      case 'a': return setLab(lab[0], v, lab[2]);
      case 'b': return setLab(lab[0], lab[1], v);
      default: {
        const i = ['C', 'M', 'Y', 'K'].indexOf(key);
        cm[i] = clamp(v, 0, 100);
        return setRgb(cmykToRgb(...cm));
      }
    }
  }

  /** The colour at field position (fx, fy) and slider value t, all 0..1, for the current mode. */
  const colourAt = (fx, fy, t) => {
    switch (mode) {
      case 'S': return hsbToRgb(fx * 360, t, 1 - fy);
      case 'B': return hsbToRgb(fx * 360, 1 - fy, t);
      case 'R': return [t * 255, (1 - fy) * 255, fx * 255];
      case 'G': return [(1 - fy) * 255, t * 255, fx * 255];
      case 'Bl': return [fx * 255, (1 - fy) * 255, t * 255];
      case 'L': return labToRgb(t * 100, fx * 255 - 128, (1 - fy) * 255 - 128);
      case 'a': return labToRgb((1 - fy) * 100, t * 255 - 128, fx * 255 - 128);
      case 'b': return labToRgb((1 - fy) * 100, fx * 255 - 128, t * 255 - 128);
      default: return hsbToRgb(t * 360, fx, 1 - fy);
    }
  };
  /** Where the colour sits: [fx, fy, t]. */
  const position = () => {
    switch (mode) {
      case 'S': return [hue / 360, 1 - bri, sat];
      case 'B': return [hue / 360, 1 - sat, bri];
      case 'R': return [rgb[2] / 255, 1 - rgb[1] / 255, rgb[0] / 255];
      case 'G': return [rgb[2] / 255, 1 - rgb[0] / 255, rgb[1] / 255];
      case 'Bl': return [rgb[0] / 255, 1 - rgb[1] / 255, rgb[2] / 255];
      case 'L': return [(lab[1] + 128) / 255, 1 - (lab[2] + 128) / 255, lab[0] / 100];
      case 'a': return [(lab[2] + 128) / 255, 1 - lab[0] / 100, (lab[1] + 128) / 255];
      case 'b': return [(lab[1] + 128) / 255, 1 - lab[0] / 100, (lab[2] + 128) / 255];
      default: return [sat, 1 - bri, hue / 360];
    }
  };
  const pick = (fx, fy, t) => {
    const p = position();
    fx = clamp(fx ?? p[0], 0, 1);
    fy = clamp(fy ?? p[1], 0, 1);
    t = clamp(t ?? p[2], 0, 1);
    switch (mode) {
      case 'H': return setHsb(t * 359.99, fx, 1 - fy);
      case 'S': return setHsb(fx * 359.99, t, 1 - fy);
      case 'B': return setHsb(fx * 359.99, 1 - fy, t);
      case 'L': return setLab(t * 100, fx * 255 - 128, (1 - fy) * 255 - 128);
      case 'a': return setLab((1 - fy) * 100, t * 255 - 128, fx * 255 - 128);
      case 'b': return setLab((1 - fy) * 100, fx * 255 - 128, t * 255 - 128);
      default: return setRgb(colourAt(fx, fy, t));
    }
  };

  // ---- drawing
  const fieldImg = field.getContext('2d').createImageData(256, 256);
  const stripImg = strip.getContext('2d').createImageData(22, 256);
  let fieldKey = '';
  let stripKey = '';
  function draw() {
    const [px, py, pt] = position();
    // the field only changes with the mode and the slider value
    const key = `${mode}|${pt.toFixed(4)}|${webOnly}`;
    if (key !== fieldKey) {
      fieldKey = key;
      const d = fieldImg.data;
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          let c = colourAt(x / 255, y / 255, pt);
          if (webOnly) c = webSafe(c);
          const o = (y * 256 + x) * 4;
          d[o] = c[0];
          d[o + 1] = c[1];
          d[o + 2] = c[2];
          d[o + 3] = 255;
        }
      }
    }
    field.getContext('2d').putImageData(fieldImg, 0, 0);
    // the hue slider shows every hue at full strength, like Photoshop; the others follow the field
    const sk = mode === 'H' ? `H|${webOnly}` : `${mode}|${px.toFixed(4)}|${py.toFixed(4)}|${webOnly}`;
    if (sk !== stripKey) {
      stripKey = sk;
      const sd = stripImg.data;
      for (let y = 0; y < 256; y++) {
        const t = 1 - y / 255;
        let c = mode === 'H' ? hsbToRgb(t * 360, 1, 1) : colourAt(px, py, t);
        if (webOnly) c = webSafe(c);
        for (let x = 0; x < 22; x++) {
          const o = (y * 22 + x) * 4;
          sd[o] = c[0];
          sd[o + 1] = c[1];
          sd[o + 2] = c[2];
          sd[o + 3] = 255;
        }
      }
    }
    strip.getContext('2d').putImageData(stripImg, 0, 0);
    const fg = field.getContext('2d');
    fg.lineWidth = 1.5;
    fg.strokeStyle = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140 ? '#000' : '#fff';
    fg.beginPath();
    fg.arc(px * 255, py * 255, 5, 0, Math.PI * 2);
    fg.stroke();
    const sg = strip.getContext('2d');
    const sy = (1 - pt) * 255;
    sg.fillStyle = '#fff';
    sg.strokeStyle = '#000';
    sg.fillRect(0, sy - 1.5, 22, 3);
    sg.strokeRect(0.5, sy - 2, 21, 4);
    update();
  }
  function update() {
    const cm = rgbToCmyk(...rgb);
    const vals = { H: Math.round(hue) % 360, S: Math.round(sat * 100), B: Math.round(bri * 100), R: Math.round(rgb[0]), G: Math.round(rgb[1]), Bl: Math.round(rgb[2]), L: Math.round(lab[0]), a: Math.round(lab[1]), b: Math.round(lab[2]), C: cm[0], M: cm[1], Y: cm[2], K: cm[3] };
    for (const [k, v] of Object.entries(vals)) if (document.activeElement !== inputs[k]) inputs[k].value = v;
    const hx = hexOf(...rgb);
    if (document.activeElement !== hex) hex.value = hx.slice(1);
    sNew.style.background = hx;
    // colours a printer cannot reach exactly (very saturated): Photoshop's gamut warning
    const [, s2, v2] = rgbToHsb(...rgb);
    warn.textContent = s2 > 0.92 && v2 > 0.85 && Math.max(...rgb) - Math.min(...rgb) > 200 ? '인쇄(CMYK)로는 정확히 나오지 않는 색입니다' : '';
    const ws = webSafe(rgb);
    webBtn.hidden = webOnly || ws.every((c, i) => c === Math.round(rgb[i]));
    webChip.style.background = hexOf(...ws);
  }

  const drag = (el, fn) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      const at = (ev) => {
        const r = el.getBoundingClientRect();
        // inside the border, so the last pixel is the end of the range
        const x = (ev.clientX - r.left - el.clientLeft) / Math.max(1, el.clientWidth - 1);
        const y = (ev.clientY - r.top - el.clientTop) / Math.max(1, el.clientHeight - 1);
        fn(clamp(x, 0, 1), clamp(y, 0, 1));
      };
      at(e);
      const mv = (ev) => at(ev);
      const up = () => {
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  drag(field, (x, y) => pick(x, y, null));
  drag(strip, (x, y) => pick(null, null, 1 - y));
  sCur.addEventListener('click', () => setRgb(rgbOf(current)));

  const grid = h('div.pcp-grid',
    row('H', 'H', 'H', 0, 359, '°'), row('L', 'L', 'L', 0, 100),
    row('S', 'S', 'S', 0, 100, '%'), row('a', 'a', 'a', -128, 127),
    row('B', 'B', 'B', 0, 100, '%'), row('b', 'b', 'b', -128, 127),
    row('R', 'R', 'R', 0, 255), row(null, 'C', 'C', 0, 100, '%'),
    row('G', 'G', 'G', 0, 255), row(null, 'M', 'M', 0, 100, '%'),
    row('Bl', 'B', 'Bl', 0, 255), row(null, 'Y', 'Y', 0, 100, '%'),
    h('label.pcp-f', h('b', '#'), hex), row(null, 'K', 'K', 0, 100, '%'));
  /** A number or code still being typed counts (Enter closes the dialog before its change event). */
  const commitTyping = () => {
    const a = document.activeElement;
    if (a === hex) {
      const v = normHex(hex.value);
      if (v && v !== hexOf(...rgb)) setRgb(rgbOf(v));
    } else {
      const k = Object.keys(inputs).find((key) => inputs[key] === a);
      if (k) fromInput(k);
    }
  };
  const addBtn = onAddSwatch ? h('button.small', { onclick: () => {
    commitTyping();
    onAddSwatch(hexOf(...rgb));
  } }, '견본에 추가') : null;
  const side = h('div.pcp-side',
    h('div.pcp-top', h('div.pcp-swatch', sNew, sCur), h('small', '새로운 색 (위)', h('br'), '현재 색 (아래)'), addBtn),
    warn, grid,
    h('div.pcp-f', h('label.pcp-f', web, h('span', '웹 색상만')), webBtn),
    sample ? h('div.pcp-note', '창 밖의 그림을 눌러 색을 고를 수도 있습니다') : null);
  draw();
  const m = openModal({
    title,
    width: 'auto',
    peek: false,
    side: true,
    body: [h('div.pcp', field, strip, side)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => {
      commitTyping();
      onOk(hexOf(...rgb));
    } }],
  });
  m.modal.style.maxWidth = '96vw';
  // with the dialog open, clicking or dragging on the picture picks its colour
  if (sample) {
    const bd = m.modal.parentElement;
    bd.classList.add('pcp-sampling');
    let on = false;
    const at = (e) => {
      const hx = sample(e.clientX, e.clientY);
      if (hx) setRgb(rgbOf(hx));
    };
    bd.addEventListener('pointerdown', (e) => {
      if (e.target !== bd) return;
      e.preventDefault();
      on = true;
      bd.setPointerCapture?.(e.pointerId);
      at(e);
    });
    bd.addEventListener('pointermove', (e) => {
      if (on) at(e);
    });
    for (const t of ['pointerup', 'pointercancel']) bd.addEventListener(t, () => { on = false; });
  }
  return m;
}
