// Smaller panels: Effects browser, Markers, History, Audio Track Mixer, Scopes, Audio Meters, Tools.

import { store } from '../store.js';
import { playback } from '../playback.js';
import * as edit from '../edit.js';
import { EFFECTS, TRANSITIONS } from '../effects.js';
import { audioTracks } from '../model.js';
import { h, clamp, formatTimecode } from '../util.js';
import { fitCanvasToBox, loadPref, savePref, showMenu } from './common.js';
import { openMarkerDialog } from './dialogs.js';
import { programApi } from './program-monitor.js';

// ---------------------------------------------------------------- effects browser

export function createEffectsPanel() {
  const search = h('input', { type: 'text', placeholder: 'Search effects', style: { flex: 1 } });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const tree = h('div.fx-browser');
  const body = h('div', h('div.panel-toolbar', search), tree,
    h('div.panel-footer', h('span.note', 'Drag onto a clip, or double-click to apply to the selection.')));
  const collapsedFolders = new Set(loadPref('fx.collapsed', []));

  function folder(name, children) {
    const el = h(`div.fx-folder${collapsedFolders.has(name) && !search.value ? '.collapsed' : ''}`);
    const head = h('div.fx-folder-head', `${collapsedFolders.has(name) && !search.value ? '▸' : '▾'} ${name.split('/').pop()}`);
    head.addEventListener('click', () => {
      if (collapsedFolders.has(name)) collapsedFolders.delete(name);
      else collapsedFolders.add(name);
      savePref('fx.collapsed', [...collapsedFolders]);
      render();
    });
    el.append(head, h('div.fx-folder-body', children));
    return el;
  }

  function item(type, def, transition) {
    const el = h('div.fx-item', { draggable: true, title: `${def.name} (${def.kind})` }, def.name);
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-montage-effect', JSON.stringify({ type, transition }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('dblclick', () => apply(type, transition));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([{ label: 'Apply to Selected Clips', action: () => apply(type, transition) }], e.clientX, e.clientY);
    });
    return el;
  }

  function apply(type, transition) {
    const sel = store.selectedClips();
    if (!sel.length) {
      store.toast('Select a clip first');
      return;
    }
    if (transition) {
      const kind = TRANSITIONS[type].kind;
      const c = sel.find((x) => (x.kind === 'audio') === (kind === 'audio'));
      if (c) edit.applyTransition(c.id, 'in', type, 1);
    } else {
      edit.addEffect(sel.map((c) => c.id), type);
      store.emit('reveal-effect-controls');
    }
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const match = (d) => !q || d.name.toLowerCase().includes(q);
    tree.replaceChildren();
    const groups = [
      ['Video Effects', Object.entries(EFFECTS).filter(([, d]) => !d.fixed && d.kind === 'video'), false],
      ['Video Transitions', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'video'), true],
      ['Audio Effects', Object.entries(EFFECTS).filter(([, d]) => !d.fixed && d.kind === 'audio'), false],
      ['Audio Transitions', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'audio'), true],
    ];
    for (const [name, entries, transition] of groups) {
      const cats = new Map();
      for (const [type, def] of entries) {
        if (!match(def)) continue;
        const cat = def.category || 'Other';
        if (!cats.has(cat)) cats.set(cat, []);
        cats.get(cat).push(item(type, def, transition));
      }
      if (!cats.size) continue;
      tree.append(folder(name, [...cats].map(([cat, items]) => folder(`${name}/${cat}`, items))));
    }
  }
  search.addEventListener('input', render);
  render();
  return body;
}

// ---------------------------------------------------------------- markers

export function createMarkersPanel() {
  const list = h('div.list');
  const body = h('div', list, h('div.panel-footer',
    h('button', { onclick: () => edit.addMarker() }, 'Add Marker (M)'),
    h('button', { onclick: () => store.transact('Clear All Markers', () => { store.seq.markers = []; }) }, 'Clear All')));
  let sig = '';
  function render(force) {
    const s = store.seq;
    const nsig = JSON.stringify(s.markers) + s.fps;
    if (!force && nsig === sig) return;
    sig = nsig;
    list.replaceChildren();
    if (!s.markers.length) list.append(h('div.empty-hint', 'No markers. Press M to add one at the playhead.'));
    for (const mk of s.markers) {
      const name = h('input', { type: 'text', value: mk.name });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      name.addEventListener('change', () => store.transact('Rename Marker', () => {
        const m = store.seq.markers.find((x) => x.id === mk.id);
        if (m) m.name = name.value;
      }));
      const row = h('div.list-row', h('span.dot', { style: { background: mk.color } }), h('span.mono', formatTimecode(mk.time, s.fps)), name,
        h('button.icon', { title: 'Delete', onclick: (e) => { e.stopPropagation(); edit.removeMarker(mk.id); } }, '✕'));
      row.addEventListener('click', (e) => {
        if (e.target === name) return;
        store.setPlayhead(mk.time);
      });
      row.addEventListener('dblclick', () => openMarkerDialog(mk.id));
      list.append(row);
    }
  }
  store.on('change', () => render());
  render(true);
  return body;
}

// ---------------------------------------------------------------- history

export function createHistoryPanel() {
  const list = h('div.list');
  const body = h('div', list, h('div.panel-footer',
    h('button', { onclick: () => store.undo() }, 'Undo'),
    h('button', { onclick: () => store.redo() }, 'Redo')));
  function render() {
    list.replaceChildren();
    const undo = store.undoStack;
    const redo = store.redoStack;
    const row = (label, cls, onclick) => {
      const r = h(`div.list-row${cls}`, { style: { gridTemplateColumns: '1fr' } }, label);
      r.addEventListener('click', onclick);
      return r;
    };
    list.append(row('Initial State', undo.length ? '' : '.current', () => { while (store.undoStack.length) store.undo(); }));
    undo.forEach((e, i) => {
      list.append(row(e.label, i === undo.length - 1 ? '.current' : '', () => {
        while (store.undoStack.length > i + 1) store.undo();
      }));
    });
    [...redo].reverse().forEach((e, i) => {
      list.append(row(e.label, '.future', () => {
        for (let k = 0; k <= i; k++) store.redo();
      }));
    });
    list.scrollTop = list.scrollHeight;
  }
  store.on('history', render);
  render();
  return body;
}

// ---------------------------------------------------------------- audio track mixer

export function createMixerPanel() {
  const strips = h('div.mixer');
  const body = h('div', strips);
  let sig = '';
  const meters = [];

  function fader(value, onInput, onCommit) {
    const r = h('input.fader', { type: 'range', min: -60, max: 12, step: 0.1, value });
    let begun = false;
    r.addEventListener('input', () => {
      if (!begun) {
        store.begin('Mixer');
        begun = true;
      }
      onInput(parseFloat(r.value));
      store.changed();
    });
    r.addEventListener('change', () => {
      begun = false;
      store.commit();
      onCommit?.();
    });
    r.addEventListener('dblclick', () => {
      store.transact('Mixer Reset', () => onInput(0));
    });
    return r;
  }

  function render() {
    const s = store.seq;
    const nsig = JSON.stringify(audioTracks(s)) + (s.masterVolume || 0);
    if (nsig === sig) return;
    sig = nsig;
    strips.replaceChildren();
    meters.length = 0;
    for (const t of audioTracks(s)) {
      const db = h('span.db', `${(t.volume || 0).toFixed(1)} dB`);
      const pan = h('input', { type: 'range', min: -100, max: 100, step: 1, value: t.pan || 0, title: 'Pan', style: { width: '64px' } });
      let begun = false;
      pan.addEventListener('input', () => {
        if (!begun) { store.begin('Track Pan'); begun = true; }
        edit.setTrackValue(t.id, 'pan', parseFloat(pan.value));
        store.changed();
      });
      pan.addEventListener('change', () => { begun = false; store.commit(); });
      pan.addEventListener('dblclick', () => store.transact('Track Pan', () => edit.setTrackValue(t.id, 'pan', 0)));
      const meter = h('canvas', { width: 8, height: 140, style: { width: '8px', height: '140px', background: '#111' } });
      meters.push({ canvas: meter, trackId: t.id, peak: -Infinity });
      strips.append(h('div.strip',
        h('span.sname', t.name),
        h('span', { style: { fontSize: '10px', color: 'var(--text-faint)' } }, `Pan ${t.pan || 0}`),
        pan,
        h('div', { style: { display: 'flex', gap: '4px' } }, fader(t.volume || 0, (v) => edit.setTrackValue(t.id, 'volume', v)), meter),
        db,
        h('div.btns',
          h(`button.mute${t.muted ? '.on' : ''}`, { onclick: () => edit.setTrackFlag(t.id, 'muted') }, 'M'),
          h(`button.solo${t.solo ? '.on' : ''}`, { onclick: () => edit.setTrackFlag(t.id, 'solo') }, 'S'))));
    }
    const mdb = h('span.db', `${(s.masterVolume || 0).toFixed(1)} dB`);
    strips.append(h('div.strip.master', h('span.sname', 'Master'), h('span', { style: { height: '38px' } }),
      fader(s.masterVolume || 0, (v) => { store.seq.masterVolume = v; }), mdb));
  }

  function drawMeters() {
    for (const m of meters) {
      const lvl = playback.playing ? playback.trackLevel(m.trackId) : -Infinity;
      const ctx = m.canvas.getContext('2d');
      const hh = m.canvas.height;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, 8, hh);
      const n = clamp((lvl + 60) / 66, 0, 1);
      const grad = ctx.createLinearGradient(0, hh, 0, 0);
      grad.addColorStop(0, '#2fbf71');
      grad.addColorStop(0.8, '#e8d44d');
      grad.addColorStop(1, '#e5484d');
      ctx.fillStyle = grad;
      ctx.fillRect(0, hh * (1 - n), 8, hh * n);
    }
    requestAnimationFrame(drawMeters);
  }
  requestAnimationFrame(drawMeters);
  store.on('change', render);
  render();
  return body;
}

// ---------------------------------------------------------------- scopes

export function createScopesPanel() {
  const mode = h('select', [['waveform', 'Waveform (Luma)'], ['parade', 'RGB Parade'], ['histogram', 'Histogram'], ['vectorscope', 'Vectorscope']].map(([v, l]) => h('option', { value: v }, l)));
  mode.value = loadPref('scopes.mode', 'waveform');
  mode.addEventListener('change', () => { savePref('scopes.mode', mode.value); draw(); });
  const canvas = h('canvas');
  const body = h('div.scopes', h('div.panel-toolbar', mode, h('span.note', 'Analyses the Program monitor')), canvas);
  const sample = document.createElement('canvas');
  let last = 0;
  let visible = false;

  function draw() {
    const src = programApi.canvas;
    if (!src || !visible) return;
    const { ctx, w, h: hh } = fitCanvasToBox(canvas);
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, w, hh);
    const sw = 192;
    const sh = Math.max(1, Math.round((sw * src.height) / Math.max(1, src.width)));
    sample.width = sw;
    sample.height = sh;
    const sctx = sample.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(src, 0, 0, sw, sh);
    const data = sctx.getImageData(0, 0, sw, sh).data;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px sans-serif';
    if (mode.value === 'histogram') {
      const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      for (let i = 0; i < data.length; i += 4) {
        bins[0][data[i]]++;
        bins[1][data[i + 1]]++;
        bins[2][data[i + 2]]++;
      }
      const max = Math.max(...bins.flatMap((b) => [...b.slice(1, 255)])) || 1;
      ctx.globalCompositeOperation = 'lighter';
      ['rgba(255,60,60,0.7)', 'rgba(60,255,60,0.7)', 'rgba(60,120,255,0.7)'].forEach((col, ch) => {
        ctx.fillStyle = col;
        for (let x = 0; x < 256; x++) {
          const v = Math.min(1, bins[ch][x] / max);
          ctx.fillRect((x / 256) * w, hh - v * (hh - 4), w / 256 + 0.5, v * (hh - 4));
        }
      });
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    if (mode.value === 'vectorscope') {
      const cx = w / 2;
      const cy = hh / 2;
      const R = Math.min(w, hh) / 2 - 8;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();
      ctx.fillStyle = 'rgba(120,255,140,0.35)';
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
        ctx.fillRect(cx + cb * 2 * R, cy - cr * 2 * R, 1, 1);
      }
      return;
    }
    // waveform / parade: x = column, y = level
    for (const lvl of [0, 25, 50, 75, 100]) {
      const y = 4 + (1 - lvl / 100) * (hh - 8);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(String(lvl), 2, y - 2);
    }
    const parade = mode.value === 'parade';
    const cols = parade ? ['rgba(255,70,70,0.25)', 'rgba(70,255,70,0.25)', 'rgba(70,130,255,0.25)'] : ['rgba(140,255,160,0.22)'];
    const segW = parade ? w / 3 : w;
    for (let ch = 0; ch < cols.length; ch++) {
      ctx.fillStyle = cols[ch];
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const i = (y * sw + x) * 4;
          const v = parade ? data[i + ch] : 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          ctx.fillRect(ch * segW + (x / sw) * segW, 4 + (1 - v / 255) * (hh - 8), Math.max(1, segW / sw), 1);
        }
      }
    }
  }

  playback.addRenderer(() => {
    const now = performance.now();
    if (now - last < 120) return;
    last = now;
    draw();
  });
  return Object.assign(body, {
    onShow: () => { visible = true; draw(); },
    setVisible: (v) => { visible = v; },
  });
}

// ---------------------------------------------------------------- audio meters

export function createMeters(el) {
  const canvas = h('canvas');
  el.append(canvas, h('div.meter-label', 'dB'));
  const peaks = [-Infinity, -Infinity];
  const holds = [{ v: -Infinity, t: 0 }, { v: -Infinity, t: 0 }];
  const ticks = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54];
  const y = (db, hh) => 6 + (1 - clamp((db + 60) / 60, 0, 1)) * (hh - 12);
  function draw(now) {
    const { ctx, w, h: hh } = fitCanvasToBox(canvas);
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, 0, w, hh);
    const levels = playback.playing ? playback.meterLevels() : [-Infinity, -Infinity];
    const barW = 8;
    const x0 = w - barW * 2 - 6;
    for (let ch = 0; ch < 2; ch++) {
      peaks[ch] = Math.max(levels[ch], peaks[ch] - 1.2);
      if (levels[ch] > holds[ch].v || now - holds[ch].t > 1500) holds[ch] = { v: levels[ch], t: now };
      const x = x0 + ch * (barW + 2);
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(x, 6, barW, hh - 12);
      const top = y(peaks[ch], hh);
      const grad = ctx.createLinearGradient(0, hh, 0, 0);
      grad.addColorStop(0, '#2fbf71');
      grad.addColorStop(0.75, '#2fbf71');
      grad.addColorStop(0.88, '#e8d44d');
      grad.addColorStop(1, '#e5484d');
      ctx.fillStyle = grad;
      if (Number.isFinite(peaks[ch])) ctx.fillRect(x, top, barW, hh - 6 - top);
      if (Number.isFinite(holds[ch].v)) {
        ctx.fillStyle = holds[ch].v > -0.5 ? '#e5484d' : '#ddd';
        ctx.fillRect(x, y(holds[ch].v, hh) - 1, barW, 2);
      }
    }
    ctx.fillStyle = '#777';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    for (const t of ticks) ctx.fillText(String(t), x0 - 2, y(t, hh) + 3);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- tools

const TOOL_ICONS = {
  select: '<path d="M4 2l9 6-4 1 3 5-2 1-3-5-3 3z"/>',
  track: '<path d="M2 8h9M8 5l3 3-3 3M13 3v10"/>',
  ripple: '<path d="M3 3v10M3 8h7M8 5l3 3-3 3M13 3v10"/>',
  rolling: '<path d="M8 2v12M2 8h4M10 8h4M4 6l-2 2 2 2M12 6l2 2-2 2"/>',
  razor: '<path d="M3 13l7-7M8 3l5 5-3 3-5-5zM2 14l2-1"/>',
  slip: '<path d="M2 5h12v6H2zM5 8h6M5 8l2-2M5 8l2 2M11 8l-2-2M11 8l-2 2"/>',
  hand: '<path d="M5 14V7M5 7V3.5a1 1 0 012 0V7M7 7V2.5a1 1 0 012 0V7M9 7V3.5a1 1 0 012 0V9c0 3-1.5 5-4 5S3 12 3 10V8"/>',
  zoom: '<circle cx="7" cy="7" r="4"/><path d="M10 10l4 4M5 7h4M7 5v4"/>',
  type: '<path d="M3 3h10M8 3v10M6 13h4"/>',
};

export const TOOLS = [
  ['select', 'Selection Tool (V)'],
  ['track', 'Track Select Forward Tool (A)'],
  ['ripple', 'Ripple Edit Tool (B)'],
  ['rolling', 'Rolling Edit Tool (N)'],
  ['razor', 'Razor Tool (C)'],
  ['slip', 'Slip Tool (Y)'],
  ['hand', 'Hand Tool (H)'],
  ['zoom', 'Zoom Tool (Z)'],
  ['type', 'Type Tool (T)'],
];

export function createTools(el) {
  const buttons = TOOLS.map(([id, title]) => {
    const b = h('button', { title, onclick: () => store.setTool(id) });
    b.innerHTML = `<svg viewBox="0 0 16 16">${TOOL_ICONS[id]}</svg>`;
    b.dataset.tool = id;
    el.append(b);
    return b;
  });
  const refresh = () => buttons.forEach((b) => b.classList.toggle('active', b.dataset.tool === store.ui.tool));
  store.on('tool', refresh);
  refresh();
}
