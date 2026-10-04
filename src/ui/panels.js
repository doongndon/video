// Smaller panels: Effects browser (with user presets), Markers, History, Audio Track Mixer,
// Scopes, Multicam, Audio Meters and the Tools strip.

import { store } from '../store.js';
import { playback } from '../playback.js';
import * as edit from '../edit.js';
import { EFFECTS, TRANSITIONS } from '../effects.js';
import { audioTracks, videoTracks, clipsOnTrack, clipEnd, mediaTimeAt } from '../model.js';
import { Compositor } from '../compositor.js';
import { h, clamp, formatTimecode } from '../util.js';
import { fitCanvasToBox, loadPref, savePref, showMenu, toast } from './common.js';
import { icon, iconButton } from './icons.js';
import { openMarkerDialog } from './dialogs.js';
import { programApi } from './program-monitor.js';
import { listPresets, deletePreset, getPreset } from './presets.js';

// ---------------------------------------------------------------- effects browser

export function createEffectsPanel() {
  const search = h('input', { type: 'search', placeholder: '효과 검색 (예: 흐림, 색상, 전환)', style: { flex: 1 }, 'aria-label': '효과 검색' });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const tree = h('div.fx-browser');
  const body = h('div', h('div.panel-toolbar', search), tree,
    h('div.panel-footer', h('span.note', '클립 위로 끌어다 놓거나, 클립을 선택하고 두 번 클릭하세요.')));
  const collapsedFolders = new Set(loadPref('fx.collapsed', []));

  function folder(name, children) {
    const closed = collapsedFolders.has(name) && !search.value;
    const el = h(`div.fx-folder${closed ? '.collapsed' : ''}`);
    const head = h('div.fx-folder-head', h('span', closed ? '▸' : '▾'), icon('folder'), name.split('/').pop());
    head.addEventListener('click', () => {
      if (collapsedFolders.has(name)) collapsedFolders.delete(name);
      else collapsedFolders.add(name);
      savePref('fx.collapsed', [...collapsedFolders]);
      render();
    });
    el.append(head, h('div.fx-folder-body', children));
    return el;
  }

  function item(type, def, transition, preset = null) {
    const kindLabel = def.kind === 'audio' ? '오디오' : def.kind === 'any' ? '공통' : '비디오';
    const el = h('div.fx-item', { draggable: true, title: preset ? `${preset.name} — ${def.name} 프리셋` : `${def.name} (${kindLabel}${transition ? ' 전환' : ' 효과'})` },
      icon(transition ? 'film' : def.kind === 'audio' ? 'audio' : 'wand'), preset ? preset.name : def.name);
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-montage-effect', JSON.stringify({ type, transition, preset: preset?.id || null }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('dblclick', () => apply(type, transition, preset));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([
        { label: '선택한 클립에 적용', action: () => apply(type, transition, preset) },
        preset ? { label: '프리셋 삭제', action: () => deletePreset(preset.id) } : null,
      ], e.clientX, e.clientY);
    });
    if (preset) {
      const del = iconButton('close', '프리셋 삭제', (e) => {
        e.stopPropagation();
        deletePreset(preset.id);
      }, { cls: 'del' });
      el.append(del);
    }
    return el;
  }

  function apply(type, transition, preset) {
    const sel = store.selectedClips();
    if (!sel.length) {
      store.toast('효과를 넣을 클립을 먼저 선택하세요');
      return;
    }
    if (preset) {
      const n = edit.applyEffectPreset(sel.map((c) => c.id), preset);
      if (!n) toast('이 프리셋을 적용할 수 있는 클립이 선택되어 있지 않습니다');
      else store.emit('reveal-effect-controls');
      return;
    }
    if (transition) {
      const kind = TRANSITIONS[type].kind;
      const c = sel.find((x) => (x.kind === 'audio') === (kind === 'audio'));
      if (c) edit.applyTransition(c.id, 'in', type, 1);
      else toast(kind === 'audio' ? '오디오 클립을 선택하세요' : '비디오 클립을 선택하세요');
    } else {
      edit.addEffect(sel.map((c) => c.id), type);
      store.emit('reveal-effect-controls');
    }
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const match = (...names) => !q || names.some((n) => String(n || '').toLowerCase().includes(q));
    tree.replaceChildren();
    const presets = listPresets().filter((p) => EFFECTS[p.type] && match(p.name, EFFECTS[p.type].name));
    if (presets.length) tree.append(folder('사용자 프리셋', presets.map((p) => item(p.type, EFFECTS[p.type], false, p))));
    const groups = [
      ['비디오 효과', Object.entries(EFFECTS).filter(([, d]) => !d.fixed && d.kind === 'video'), false],
      ['비디오 전환', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'video'), true],
      ['오디오 효과', Object.entries(EFFECTS).filter(([, d]) => !d.fixed && d.kind === 'audio'), false],
      ['오디오 전환', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'audio'), true],
    ];
    for (const [name, entries, transition] of groups) {
      const cats = new Map();
      for (const [type, def] of entries) {
        if (!match(def.name, def.category, type)) continue;
        const cat = def.category || '기타';
        if (!cats.has(cat)) cats.set(cat, []);
        cats.get(cat).push(item(type, def, transition));
      }
      if (!cats.size) continue;
      tree.append(folder(name, [...cats].map(([cat, items]) => folder(`${name}/${cat}`, items))));
    }
    if (!tree.children.length) tree.append(h('div.empty-hint', `"${search.value}"에 맞는 효과가 없습니다`));
  }
  search.addEventListener('input', render);
  store.on('presets', render);
  render();
  return body;
}

/** Resolve an effect drag payload (from the Effects panel) — used by the timeline drop handler. */
export function presetFromPayload(payload) {
  return payload?.preset ? getPreset(payload.preset) : null;
}

// ---------------------------------------------------------------- markers

export function createMarkersPanel() {
  const list = h('div.list');
  const body = h('div', list, h('div.panel-footer',
    iconButton('marker', '재생헤드 위치에 마커 추가 (M)', () => edit.addMarker(), { label: '마커 추가 (M)', cls: 'boxed' }),
    iconButton('close', '마커 모두 지우기', () => store.transact('마커 모두 지우기', () => { store.seq.markers = []; }), { label: '모두 지우기', cls: 'boxed' })));
  let sig = '';
  function render(force) {
    const s = store.seq;
    const nsig = JSON.stringify(s.markers) + s.fps;
    if (!force && nsig === sig) return;
    sig = nsig;
    list.replaceChildren();
    if (!s.markers.length) list.append(h('div.empty-hint', '마커가 없습니다.\nM 키를 누르면 재생헤드 위치에 마커가 생깁니다.'));
    for (const mk of s.markers) {
      const name = h('input', { type: 'text', value: mk.name, 'aria-label': '마커 이름' });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      name.addEventListener('change', () => store.transact('마커 이름 바꾸기', () => {
        const m = store.seq.markers.find((x) => x.id === mk.id);
        if (m) m.name = name.value;
      }));
      const row = h('div.list-row', { title: mk.comment || '두 번 클릭: 마커 편집' }, h('span.dot', { style: { background: mk.color } }), h('span.mono', formatTimecode(mk.time, s.fps)), name,
        iconButton('close', '마커 삭제', (e) => { e.stopPropagation(); edit.removeMarker(mk.id); }));
      row.addEventListener('click', (e) => {
        if (e.target === name) return;
        store.setPlayhead(mk.time);
      });
      row.addEventListener('dblclick', () => openMarkerDialog(mk.id));
      list.append(row);
    }
  }
  store.on('change', () => render());
  store.on('sequence', () => render(true));
  render(true);
  return body;
}

// ---------------------------------------------------------------- history

export function createHistoryPanel() {
  const list = h('div.list');
  const body = h('div', list, h('div.panel-footer',
    iconButton('undo', '실행 취소 (Ctrl+Z)', () => store.undo(), { label: '실행 취소', cls: 'boxed' }),
    iconButton('redo', '다시 실행 (Ctrl+Shift+Z)', () => store.redo(), { label: '다시 실행', cls: 'boxed' })));
  function render() {
    list.replaceChildren();
    const undo = store.undoStack;
    const redo = store.redoStack;
    const row = (label, cls, onclick) => {
      const r = h(`div.list-row${cls}`, { style: { gridTemplateColumns: '1fr' } }, label);
      r.addEventListener('click', onclick);
      return r;
    };
    list.append(row('처음 상태', undo.length ? '' : '.current', () => { while (store.undoStack.length) store.undo(); }));
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

  function fader(value, label, onInput) {
    const r = h('input.fader', { type: 'range', min: -60, max: 12, step: 0.1, value, 'aria-label': label, title: `${label} (두 번 클릭: 0 dB)` });
    let begun = false;
    r.addEventListener('input', () => {
      if (!begun) {
        store.begin('믹서 볼륨');
        begun = true;
      }
      onInput(parseFloat(r.value));
      store.changed();
    });
    r.addEventListener('change', () => {
      if (begun) store.commit();
      begun = false;
    });
    r.addEventListener('dblclick', () => store.transact('믹서 볼륨 초기화', () => onInput(0)));
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
      const panLabel = (v) => (v === 0 ? '가운데' : v < 0 ? `왼쪽 ${-v}` : `오른쪽 ${v}`);
      const pan = h('input', { type: 'range', min: -100, max: 100, step: 1, value: t.pan || 0, title: '좌우 (두 번 클릭: 가운데)', 'aria-label': `${t.name} 좌우`, style: { width: '70px' } });
      let begun = false;
      pan.addEventListener('input', () => {
        if (!begun) { store.begin('트랙 좌우'); begun = true; }
        edit.setTrackValue(t.id, 'pan', parseFloat(pan.value));
        store.changed();
      });
      pan.addEventListener('change', () => { if (begun) store.commit(); begun = false; });
      pan.addEventListener('dblclick', () => store.transact('트랙 좌우', () => edit.setTrackValue(t.id, 'pan', 0)));
      const meter = h('canvas', { width: 8, height: 150, style: { width: '8px', height: '150px', background: '#111' } });
      meters.push({ canvas: meter, trackId: t.id });
      strips.append(h('div.strip',
        h('span.sname', t.name),
        h('span', { style: { fontSize: 'var(--fs-xs)', color: 'var(--text-faint)' } }, panLabel(t.pan || 0)),
        pan,
        h('div', { style: { display: 'flex', gap: '4px' } }, fader(t.volume || 0, `${t.name} 볼륨`, (v) => edit.setTrackValue(t.id, 'volume', v)), meter),
        db,
        h('div.btns',
          h(`button.mute${t.muted ? '.on' : ''}`, { title: '음소거', 'aria-pressed': String(!!t.muted), onclick: () => edit.setTrackFlag(t.id, 'muted') }, 'M'),
          h(`button.solo${t.solo ? '.on' : ''}`, { title: '솔로 (이 트랙만 듣기)', 'aria-pressed': String(!!t.solo), onclick: () => edit.setTrackFlag(t.id, 'solo') }, 'S'))));
    }
    const mdb = h('span.db', `${(s.masterVolume || 0).toFixed(1)} dB`);
    strips.append(h('div.strip.master', h('span.sname', '마스터'), h('span', { style: { height: '38px' } }),
      fader(s.masterVolume || 0, '마스터 볼륨', (v) => { store.seq.masterVolume = v; }), mdb));
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
  const mode = h('select', { 'aria-label': '스코프 종류' }, [['waveform', '파형 (밝기)'], ['parade', 'RGB 퍼레이드'], ['histogram', '히스토그램'], ['vectorscope', '벡터스코프 (색상)']].map(([v, l]) => h('option', { value: v }, l)));
  mode.value = loadPref('scopes.mode', 'waveform');
  mode.addEventListener('change', () => { savePref('scopes.mode', mode.value); draw(); });
  const canvas = h('canvas');
  const body = h('div.scopes', h('div.panel-toolbar', mode, h('span.note', '프로그램 모니터 화면을 분석합니다')), canvas);
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
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `${Math.round(11 * (loadPref('uiScale', 1) || 1))}px sans-serif`;
    if (mode.value === 'histogram') {
      const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      for (let i = 0; i < data.length; i += 4) {
        bins[0][data[i]]++;
        bins[1][data[i + 1]]++;
        bins[2][data[i + 2]]++;
      }
      let max = 1;
      for (const b of bins) for (let x = 1; x < 255; x++) max = Math.max(max, b[x]);
      ctx.globalCompositeOperation = 'lighter';
      ['rgba(255,60,60,0.7)', 'rgba(60,255,60,0.7)', 'rgba(60,120,255,0.7)'].forEach((col, ch) => {
        ctx.fillStyle = col;
        for (let x = 0; x < 256; x++) {
          const v = Math.min(1, bins[ch][x] / max);
          ctx.fillRect((x / 256) * w, hh - v * (hh - 4), w / 256 + 0.5, v * (hh - 4));
        }
      });
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('어두움', 4, 14);
      ctx.textAlign = 'right';
      ctx.fillText('밝음', w - 4, 14);
      ctx.textAlign = 'left';
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
      // skin tone line (about 123° in Cb/Cr space)
      ctx.strokeStyle = 'rgba(255,200,150,0.35)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos((-123 * Math.PI) / 180) * R, cy + Math.sin((-123 * Math.PI) / 180) * R);
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

// ---------------------------------------------------------------- multicam

export function createMulticamPanel() {
  const grid = h('div.multicam-grid');
  const info = h('span.note');
  const cutBtn = h('button', { title: '켜면 멈춘 상태에서도 재생헤드 위치에서 잘라 앵글을 바꿉니다' }, '멈춤 상태에서도 자르기');
  let cutWhenPaused = loadPref('multicam.cutPaused', false);
  cutBtn.addEventListener('click', () => {
    cutWhenPaused = !cutWhenPaused;
    savePref('multicam.cutPaused', cutWhenPaused);
    refreshCut();
  });
  const refreshCut = () => {
    cutBtn.classList.toggle('on', cutWhenPaused);
    cutBtn.setAttribute('aria-pressed', String(cutWhenPaused));
  };
  refreshCut();
  const body = h('div.multicam', h('div.panel-toolbar', icon('multicam'), info, h('span.grow'), cutBtn), grid,
    h('div.panel-footer', h('span.note', '앵글 화면을 누르거나 숫자 키 1~9로 바꿉니다. 재생 중에 바꾸면 그 위치에서 잘립니다.')));
  const compositor = new Compositor({ onAsyncReady: () => playback.requestRender() });
  let visible = false;
  let cells = [];
  let cellSig = '';
  let last = 0;

  function current() {
    const c = edit.multicamClipAt();
    if (!c) return null;
    const m = store.project.media[c.mediaId];
    const inner = m && store.project.sequences[m.sequenceId];
    return inner ? { clip: c, inner } : null;
  }

  function switchTo(n) {
    edit.switchAngle(n, { cut: playback.playing || cutWhenPaused });
  }

  function build(mc) {
    const tracks = videoTracks(mc.inner);
    const sig = `${mc.inner.id}:${tracks.length}`;
    if (sig === cellSig) return;
    cellSig = sig;
    const cols = Math.ceil(Math.sqrt(tracks.length));
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    cells = tracks.map((tr, i) => {
      const canvas = h('canvas');
      const label = h('span.num', `${i + 1}`);
      const cell = h('div.angle', { title: `앵글 ${i + 1} (${i + 1} 키)`, role: 'button', 'aria-label': `앵글 ${i + 1}` }, canvas, label);
      cell.addEventListener('click', () => switchTo(i + 1));
      return { cell, canvas, label, track: tr };
    });
    grid.replaceChildren(...cells.map((c) => c.cell));
  }

  function draw() {
    if (!visible) return;
    const mc = current();
    if (!mc) {
      cellSig = '';
      cells = [];
      info.textContent = '';
      grid.style.gridTemplateColumns = '1fr';
      grid.replaceChildren(h('div.empty-hint', '재생헤드 아래에 멀티캠 클립이 없습니다.\n\n프로젝트 패널에서 같은 장면을 찍은 영상 여러 개를 선택한 뒤\n클립 ▸ 멀티캠 소스 시퀀스 만들기를 누르세요.'));
      return;
    }
    build(mc);
    const { clip, inner } = mc;
    const angle = clip.multicam?.angle || 1;
    const mt = mediaTimeAt(clip, store.ui.playhead);
    info.textContent = `${inner.name} · 현재 앵글 ${angle}`;
    compositor.prefix = `${clip.id}/`;
    cells.forEach((c, i) => {
      c.cell.classList.toggle('active', i + 1 === angle);
      const r = c.cell.getBoundingClientRect();
      const w = Math.max(32, Math.round(r.width));
      const hh = Math.max(18, Math.round((w * inner.height) / inner.width));
      if (c.canvas.width !== w || c.canvas.height !== hh) {
        c.canvas.width = w;
        c.canvas.height = hh;
      }
      compositor.render(c.canvas.getContext('2d'), inner, mt, playback.provider, { scale: w / inner.width, angle: i + 1 });
      const clipOn = clipsOnTrack(inner, c.track.id).find((x) => mt >= x.start && mt < clipEnd(x));
      c.label.textContent = `${i + 1}  ${clipOn ? clipOn.name : '(없음)'}`;
    });
  }

  playback.addRenderer(() => {
    const now = performance.now();
    if (playback.playing && now - last < 60) return;
    last = now;
    draw();
  });
  store.on('change', () => playback.requestRender());
  return Object.assign(body, {
    onShow: () => {
      visible = true;
      playback.multicamPreview = true;
      playback.requestRender();
    },
    onHide: () => {
      visible = false;
      playback.multicamPreview = false;
    },
  });
}

// ---------------------------------------------------------------- audio meters

export function createMeters(el) {
  const canvas = h('canvas', { 'aria-label': '오디오 레벨 미터' });
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
    ctx.fillStyle = '#9aa1ad';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (const t of ticks) ctx.fillText(String(t), x0 - 2, y(t, hh) + 3);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- tools

export const TOOLS = [
  ['select', '선택 도구 (V)'],
  ['track', '앞쪽 트랙 선택 도구 (A)'],
  ['ripple', '잔물결 편집 도구 (B)'],
  ['rolling', '롤링 편집 도구 (N)'],
  ['razor', '자르기 도구 (C)'],
  ['slip', '밀어 넣기(슬립) 도구 (Y)'],
  ['hand', '손 도구 (H)'],
  ['zoom', '확대/축소 도구 (Z)'],
  ['type', '텍스트 도구 (T)'],
];

const TOOL_ICON = { select: 'select', track: 'track', ripple: 'ripple', rolling: 'rolling', razor: 'razor', slip: 'slip', hand: 'hand', zoom: 'zoom', type: 'type' };

export function createTools(el) {
  const buttons = TOOLS.map(([id, title]) => {
    const b = h('button', { title, 'aria-label': title, onclick: () => store.setTool(id) }, icon(TOOL_ICON[id], 18));
    b.dataset.tool = id;
    el.append(b);
    return b;
  });
  const refresh = () => buttons.forEach((b) => {
    const on = b.dataset.tool === store.ui.tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  store.on('tool', refresh);
  refresh();
}
