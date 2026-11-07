// The Color panel's views from its panel menu (Photoshop): 색조 큐브 (the field and hue strip of
// colorpicker.js), 색상환 (hue around a wheel, saturation outwards, a brightness slider), the
// Grayscale / RGB / HSB / CMYK / Lab sliders, and the colour bar under the sliders (RGB 스펙트럼,
// 회색 음영 램프, 현재 색상: foreground to background), which picks a colour when clicked or dragged.

import { h, clamp } from '../util.js';
import { loadPref, savePref } from '../ui/common.js';
import { createColorPicker, hexToHsv, hsvToHex, rgbToLab, labToRgb } from './colorpicker.js';

export const COLOR_VIEWS = [['cube', '색조 큐브'], ['wheel', '색상환'], ['gray', '회색 음영 슬라이더'], ['rgb', 'RGB 슬라이더'], ['hsb', 'HSB 슬라이더'], ['cmyk', 'CMYK 슬라이더'], ['lab', 'Lab 슬라이더']];
export const COLOR_BARS = [['rgb', 'RGB 스펙트럼'], ['gray', '회색 음영 램프'], ['current', '현재 색상']];

const hexOf = (r, g, b) => `#${[r, g, b].map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) || 0);
/** HSV (hue in degrees, s and v 0..1) to 0..255 RGB, without a string in between (the wheel). */
function hsvRgb(hh, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
// each slider view: channels [name, min, max, unit], the values of a colour, the colour of values
const SLIDERS = {
  gray: {
    ch: [['K', 0, 100, '%']],
    from: ([r, g, b]) => [Math.round(100 - (0.299 * r + 0.587 * g + 0.114 * b) / 2.55)],
    to: ([k]) => [255 * (1 - k / 100), 255 * (1 - k / 100), 255 * (1 - k / 100)],
  },
  rgb: { ch: [['R', 0, 255], ['G', 0, 255], ['B', 0, 255]], from: (c) => [...c], to: (v) => v },
  hsb: {
    ch: [['H', 0, 360, '°'], ['S', 0, 100, '%'], ['B', 0, 100, '%']],
    from: (c) => {
      const [hh, s, v] = hexToHsv(hexOf(...c));
      return [Math.round(hh), Math.round(s * 100), Math.round(v * 100)];
    },
    to: ([hh, s, v]) => rgbOf(hsvToHex(hh % 360, s / 100, v / 100)),
  },
  // simple (uncalibrated) CMYK, as the Color Picker dialog shows it
  cmyk: {
    ch: [['C', 0, 100, '%'], ['M', 0, 100, '%'], ['Y', 0, 100, '%'], ['K', 0, 100, '%']],
    from: ([r, g, b]) => {
      const k = 1 - Math.max(r, g, b) / 255;
      if (k >= 1) return [0, 0, 0, 100];
      return [(1 - r / 255 - k) / (1 - k), (1 - g / 255 - k) / (1 - k), (1 - b / 255 - k) / (1 - k), k].map((x) => Math.round(x * 100));
    },
    to: ([c, m, y, k]) => [255 * (1 - c / 100) * (1 - k / 100), 255 * (1 - m / 100) * (1 - k / 100), 255 * (1 - y / 100) * (1 - k / 100)],
  },
  lab: { ch: [['L', 0, 100], ['a', -128, 127], ['b', -128, 127]], from: (c) => rgbToLab(...c).map(Math.round), to: (v) => labToRgb(...v) },
};

/** Drag on an element: fn(x 0..1, y 0..1, done) while the pointer is down and when it is let go. */
function dragOn(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    let last = [0, 0];
    const at = (ev, done) => {
      const r = el.getBoundingClientRect();
      if (ev) last = [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)];
      fn(last[0], last[1], done);
    };
    const mv = (ev) => at(ev, false);
    const up = () => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      at(null, true);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    at(e, false);
  });
}

/**
 * The views of the Color panel. target() is 'fg' or 'bg'; set(hex, done) changes that colour.
 * Returns { el, bar, sync(), menu() }: el takes the place of the picker, bar goes under it.
 */
export function buildColorViews(P, target, set) {
  let view = loadPref('photo.colorView', 'cube');
  let barKind = loadPref('photo.colorBar', 'rgb');
  if (!COLOR_VIEWS.some((v) => v[0] === view)) view = 'cube';
  const picker = createColorPicker({ value: P.fg, onChange: (v, done) => set(v, done) });
  // a lower field than the dialogs' so the panel stays small
  const field = picker.el.querySelector('.cp-sv');
  if (field) field.height = 90;
  const el = h('div.ph-cviews');
  // values of the slider view, kept while they make the current colour (a grey keeps its hue)
  let vals = null;
  let mine = null;
  const cur = () => (target() === 'bg' ? P.bg : P.fg);
  const valuesFor = (kind) => {
    if (!vals || vals.kind !== kind || mine !== cur()) vals = { kind, v: SLIDERS[kind].from(rgbOf(cur())) };
    return vals.v;
  };
  const apply = (kind, done) => {
    mine = hexOf(...SLIDERS[kind].to(vals.v));
    set(mine, done);
  };

  // ---- sliders
  const rows = [];
  const sliderRow = (kind, i) => {
    const [name, min, max, unit] = SLIDERS[kind].ch[i];
    const track = h('div.ph-cs-track');
    const thumb = h('i.ph-cs-thumb');
    track.append(thumb);
    const num = h('input.ph-num', { type: 'number', min, max, step: 1, 'aria-label': name });
    dragOn(track, (x, _y, done) => {
      valuesFor(kind)[i] = Math.round(min + x * (max - min));
      apply(kind, done);
    });
    num.addEventListener('change', () => {
      valuesFor(kind)[i] = clamp(Math.round(+num.value || 0), min, max);
      apply(kind, true);
    });
    const row = h('div.ph-cs-row', h('b', name), track, num, h('small', unit || ''));
    row.paint = () => {
      const v = valuesFor(kind);
      const n = kind === 'rgb' || kind === 'cmyk' || kind === 'gray' ? 2 : 9;
      const stops = Array.from({ length: n }, (_, k) => {
        const w = [...v];
        w[i] = min + ((max - min) * k) / (n - 1);
        return `${hexOf(...SLIDERS[kind].to(w))} ${((k / (n - 1)) * 100).toFixed(1)}%`;
      });
      track.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
      thumb.style.left = `${((v[i] - min) / (max - min)) * 100}%`;
      if (document.activeElement !== num) num.value = v[i];
    };
    rows.push(row);
    return row;
  };

  // ---- the colour wheel: hue around, saturation outwards, at the brightness of the slider under it
  const wheel = h('canvas.ph-cwheel', { width: 132, height: 132, 'aria-label': '색상환' });
  const disc = document.createElement('canvas');
  disc.width = disc.height = 132;
  let discB = -1;
  const paintWheel = () => {
    const [hh, s, b] = valuesFor('hsb');
    const R = 65;
    if (discB !== b) {
      discB = b;
      const g = disc.getContext('2d');
      const img = g.createImageData(132, 132);
      for (let y = 0; y < 132; y++) {
        for (let x = 0; x < 132; x++) {
          const dx = x + 0.5 - 66;
          const dy = y + 0.5 - 66;
          const r = Math.hypot(dx, dy) / R;
          if (r > 1.01) continue;
          const [cr, cg, cb] = hsvRgb(((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360, Math.min(1, r), b / 100);
          const o = (y * 132 + x) * 4;
          img.data[o] = cr;
          img.data[o + 1] = cg;
          img.data[o + 2] = cb;
          img.data[o + 3] = r > 1 ? 255 * (1.01 - r) * 100 : 255;
        }
      }
      g.putImageData(img, 0, 0);
    }
    const g = wheel.getContext('2d');
    g.clearRect(0, 0, 132, 132);
    g.drawImage(disc, 0, 0);
    const a = (hh * Math.PI) / 180;
    const px = 66 + Math.cos(a) * (s / 100) * R;
    const py = 66 - Math.sin(a) * (s / 100) * R;
    g.lineWidth = 2;
    g.strokeStyle = b > 50 ? '#000' : '#fff';
    g.beginPath();
    g.arc(px, py, 5, 0, Math.PI * 2);
    g.stroke();
  };
  dragOn(wheel, (x, y, done) => {
    const dx = x * 132 - 66;
    const dy = y * 132 - 66;
    const v = valuesFor('hsb');
    v[0] = Math.round(((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360);
    v[1] = Math.round(Math.min(1, Math.hypot(dx, dy) / 65) * 100);
    apply('hsb', done);
  });

  // ---- the colour bar
  const bar = h('canvas.ph-cbar', { width: 240, height: 22, 'aria-label': '색상 막대' });
  const paintBar = () => {
    const g = bar.getContext('2d');
    const { width: w, height: hh } = bar;
    let gr = g.createLinearGradient(0, 0, w, 0);
    if (barKind === 'rgb') {
      for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, hsvToHex((i * 60) % 360, 1, 1));
    } else if (barKind === 'gray') {
      gr.addColorStop(0, '#000');
      gr.addColorStop(1, '#fff');
    } else {
      gr.addColorStop(0, P.fg);
      gr.addColorStop(1, P.bg);
    }
    g.fillStyle = gr;
    g.fillRect(0, 0, w, hh);
    if (barKind === 'rgb') {
      gr = g.createLinearGradient(0, 0, 0, hh);
      gr.addColorStop(0, '#fff');
      gr.addColorStop(0.5, 'rgba(255,255,255,0)');
      gr.addColorStop(0.5, 'rgba(0,0,0,0)');
      gr.addColorStop(1, '#000');
      g.fillStyle = gr;
      g.fillRect(0, 0, w, hh);
    }
  };
  dragOn(bar, (x, y, done) => {
    const d = bar.getContext('2d').getImageData(Math.min(bar.width - 1, Math.floor(x * bar.width)), Math.min(bar.height - 1, Math.floor(y * bar.height)), 1, 1).data;
    mine = null;
    set(hexOf(d[0], d[1], d[2]), done);
  });

  const build = () => {
    rows.length = 0;
    vals = null;
    if (view === 'cube') el.replaceChildren(picker.el);
    else if (view === 'wheel') {
      discB = -1;
      el.replaceChildren(h('div.ph-cwheel-box', wheel), sliderRow('hsb', 2));
    } else el.replaceChildren(...SLIDERS[view].ch.map((_, i) => sliderRow(view, i)));
    bar.hidden = view === 'cube' || view === 'wheel';
  };
  const sync = () => {
    if (view === 'cube') picker.set(cur());
    else {
      if (view === 'wheel') paintWheel();
      for (const r of rows) r.paint();
    }
    if (!bar.hidden) paintBar();
  };
  build();
  return {
    el,
    bar,
    sync,
    menu: () => [
      ...COLOR_VIEWS.map(([v, label]) => ({ label, checked: view === v, action: () => {
        view = v;
        savePref('photo.colorView', v);
        build();
        sync();
      } })),
      '-',
      ...COLOR_BARS.map(([v, label]) => ({ label, checked: barKind === v, disabled: view === 'cube' || view === 'wheel', action: () => {
        barKind = v;
        savePref('photo.colorBar', v);
        paintBar();
      } })),
    ],
  };
}
