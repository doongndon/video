// HSV colour picker (saturation/value square + hue strip + hex field) for the photo editor.

import { h } from '../util.js';

export function hexToHsv(hex) {
  const n = parseInt(String(hex).slice(1), 16);
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
    const v = `#${hex.value.replace(/[^0-9a-f]/gi, '').padEnd(6, '0').slice(0, 6)}`;
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
