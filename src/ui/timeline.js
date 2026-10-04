// Timeline panel: canvas-rendered tracks with all editing tools, DOM track headers.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { runtime, mediaEvents, mediaStatus, importFiles } from '../media.js';
import * as edit from '../edit.js';
import {
  clipEnd, clipsOnTrack, videoTracks, audioTracks, getTrack, sequenceDuration, transitionsOnTrack,
  mediaTimeAt, evalEffect, linkedClips, prevAdjacent, nextAdjacent, editPoints, isAnimated, isTimed,
} from '../model.js';
import { EFFECTS, TRANSITIONS } from '../effects.js';
import { h, clamp, EPS, formatTimecode, parseTimecode, snapFrame, dbToGain, modKey } from '../util.js';
import { showMenu, loadPref, savePref, fitCanvasToBox, promptDialog, toast, dnd, inlineEdit } from './common.js';
import { openSpeedDialog, openMarkerDialog } from './dialogs.js';

const RULER_H = 34;
const DIVIDER_H = 6;
const SNAP_PX = 8;
const EDGE_PX = 7;

const COLORS = {
  video: ['#5d5fb8', '#8487e6'],
  image: ['#7a5bb8', '#a284e6'],
  audio: ['#2f7d55', '#4fb183'],
  text: ['#a1518a', '#d07ab8'],
  color: ['#2f7680', '#53a9b5'],
  adjustment: ['#9a5f3c', '#cf8a5f'],
  shape: ['#a1518a', '#d07ab8'],
  nest: ['#6b7d2a', '#93a94a'],
};

export const timelineApi = {};

export function createTimeline() {
  const view = {
    pps: loadPref('tl.pps', 40),
    scrollX: 0,
    scrollY: 0,
    th: loadPref('tl.trackH', 50),
    showThumbs: loadPref('tl.thumbs', true),
    showWaves: loadPref('tl.waves', true),
    rows: [],
    contentH: 0,
    width: 0,
    height: 0,
  };
  let drag = null; // active pointer interaction
  let hover = null;
  let dropPreview = null;
  let staticDirty = true;

  // ---------------------------------------------------------------- DOM
  const tcEl = h('span.tc', { title: 'Click to type a timecode' }, '00:00:00:00');
  const seqName = h('span', { style: { color: 'var(--text-dim)' } });
  const snapBtn = h('button.icon', { title: 'Snap (S)', onclick: () => toggleSnap() }, '🧲');
  const linkBtn = h('button.icon', { title: 'Linked Selection', onclick: () => { store.ui.linkedSelection = !store.ui.linkedSelection; refreshTopBar(); } }, '🔗');
  const markerBtn = h('button.icon', { title: 'Add Marker (M)', onclick: () => edit.addMarker() }, '◆');
  const settingsBtn = h('button.icon', { title: 'Timeline display settings', onclick: (e) => showSettingsMenu(e) }, '⚙');
  const top = h('div.tl-top', tcEl, seqName, h('span.grow'), snapBtn, linkBtn, markerBtn, settingsBtn);
  const seqTabs = h('div.seq-tabs');

  const headersInner = h('div.tl-headers-inner');
  const rulerSpacer = h('div.tl-ruler-spacer', h('span', { style: { color: 'var(--text-faint)', fontSize: '11px' } }, 'Tracks'));
  const headers = h('div.tl-headers', rulerSpacer, headersInner);
  const canvas = h('canvas', { tabindex: 0 });
  const vscroll = h('div.tl-vscroll', h('div'));
  const wrap = h('div.tl-canvas-wrap', canvas, vscroll);
  const main = h('div.tl-main', headers, wrap);
  const hscroll = h('div.tl-hscroll', h('div'));
  const zoomSlider = h('input', { type: 'range', min: 0, max: 1000, step: 1, title: 'Zoom' });
  const durEl = h('span', { style: { color: 'var(--text-faint)' } });
  const bottom = h('div.tl-bottom', h('span', '−'), zoomSlider, h('span', '+'), h('span.grow', { style: { flex: 1 } }), durEl);
  const root = h('div.timeline', seqTabs, top, main, h('div', { style: { paddingLeft: '172px' } }, hscroll), bottom);

  const staticCanvas = document.createElement('canvas');

  // ---------------------------------------------------------------- geometry
  const xOf = (t) => t * view.pps - view.scrollX;
  const tOf = (x) => (x + view.scrollX) / view.pps;
  const fps = () => store.seq.fps;

  function layoutRows() {
    const s = store.seq;
    const rows = [];
    let y = 0;
    for (const t of videoTracks(s).slice().reverse()) {
      rows.push({ track: t, y, h: view.th });
      y += view.th;
    }
    view.dividerY = y;
    y += DIVIDER_H;
    for (const t of audioTracks(s)) {
      rows.push({ track: t, y, h: view.th });
      y += view.th;
    }
    view.rows = rows;
    view.contentH = y;
  }

  const rowY = (row) => RULER_H + row.y - view.scrollY;
  const rowOfTrack = (id) => view.rows.find((r) => r.track.id === id);
  function rowAtY(y) {
    const cy = y - RULER_H + view.scrollY;
    return view.rows.find((r) => cy >= r.y && cy < r.y + r.h) || null;
  }

  function maxScrollX() {
    const dur = Math.max(sequenceDuration(store.seq), 30);
    return Math.max(0, (dur + 30) * view.pps - view.width + 40);
  }

  function setScrollX(px) {
    view.scrollX = clamp(px, 0, Math.max(maxScrollX(), view.scrollX, px > 0 ? px : 0));
    if (view.scrollX < 0) view.scrollX = 0;
    syncScrollbars();
    invalidate();
  }

  function setScrollY(px) {
    const max = Math.max(0, view.contentH - (view.height - RULER_H) + 20);
    view.scrollY = clamp(px, 0, max);
    syncScrollbars();
    renderHeaders();
    invalidate();
  }

  function setZoom(pps, anchorX = view.width / 2) {
    const tAnchor = tOf(anchorX);
    view.pps = clamp(pps, 0.2, 3000);
    savePref('tl.pps', view.pps);
    view.scrollX = Math.max(0, tAnchor * view.pps - anchorX);
    syncScrollbars();
    invalidate();
  }

  function zoomToFit() {
    const dur = Math.max(1, sequenceDuration(store.seq));
    view.pps = clamp((view.width - 60) / dur, 0.2, 3000);
    view.scrollX = 0;
    syncScrollbars();
    invalidate();
  }

  let syncing = false;
  function syncScrollbars() {
    syncing = true;
    const total = Math.max(maxScrollX(), view.scrollX) + view.width;
    hscroll.firstChild.style.width = `${total}px`;
    hscroll.scrollLeft = view.scrollX;
    vscroll.firstChild.style.height = `${view.contentH + 20}px`;
    vscroll.scrollTop = view.scrollY;
    const z = Math.log(view.pps / 0.2) / Math.log(3000 / 0.2);
    zoomSlider.value = String(Math.round(z * 1000));
    syncing = false;
  }
  hscroll.addEventListener('scroll', () => {
    if (syncing) return;
    view.scrollX = hscroll.scrollLeft;
    invalidate();
  });
  vscroll.addEventListener('scroll', () => {
    if (syncing) return;
    view.scrollY = vscroll.scrollTop;
    renderHeaders();
    invalidate();
  });
  zoomSlider.addEventListener('input', () => {
    const z = Number(zoomSlider.value) / 1000;
    const px = xOf(store.ui.playhead);
    setZoom(0.2 * Math.pow(3000 / 0.2, z), px >= 0 && px <= view.width ? px : view.width / 2);
  });

  // ---------------------------------------------------------------- headers
  function renderHeaders() {
    headersInner.replaceChildren();
    headersInner.style.top = `${RULER_H - view.scrollY}px`;
    headersInner.style.height = `${view.contentH}px`;
    const s = store.seq;
    const anySolo = audioTracks(s).some((t) => t.solo);
    for (const row of view.rows) {
      const t = row.track;
      const lockBtn = h(`button.lock${t.locked ? '.on' : ''}`, { title: 'Toggle Track Lock', onclick: () => edit.setTrackFlag(t.id, 'locked') }, t.locked ? '🔒' : '🔓');
      const name = h(`span.tname${t.targeted ? '.targeted' : ''}`, { title: 'Toggle track targeting (source patching)', onclick: () => edit.setTrackFlag(t.id, 'targeted') }, t.name);
      const items = [lockBtn, name];
      if (t.kind === 'video') {
        items.push(h(`button.eye${t.hidden ? '.on' : ''}`, { title: 'Toggle Track Output', onclick: () => edit.setTrackFlag(t.id, 'hidden') }, t.hidden ? '⊘' : '👁'));
      } else {
        items.push(h(`button.mute${t.muted ? '.on' : ''}`, { title: 'Mute Track', onclick: () => edit.setTrackFlag(t.id, 'muted') }, 'M'));
        items.push(h(`button.solo${t.solo ? '.on' : ''}`, { title: 'Solo Track', onclick: () => edit.setTrackFlag(t.id, 'solo') }, 'S'));
        const vol = h('span.vol', { title: 'Track volume (drag)' }, `${(t.volume || 0).toFixed(1)}dB`);
        vol.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          vol.setPointerCapture(e.pointerId);
          const x0 = e.clientX;
          const v0 = t.volume || 0;
          store.begin('Track Volume');
          const move = (ev) => {
            const v = clamp(v0 + (ev.clientX - x0) * 0.2, -60, 12);
            edit.setTrackValue(t.id, 'volume', Math.round(v * 10) / 10);
            vol.textContent = `${(Math.round(v * 10) / 10).toFixed(1)}dB`;
            store.changed();
          };
          const up = () => {
            vol.removeEventListener('pointermove', move);
            vol.removeEventListener('pointerup', up);
            store.commit();
          };
          vol.addEventListener('pointermove', move);
          vol.addEventListener('pointerup', up);
        });
        vol.addEventListener('dblclick', () => {
          store.transact('Track Volume', () => edit.setTrackValue(t.id, 'volume', 0));
        });
        items.push(vol);
        if (anySolo && !t.solo) name.style.opacity = '0.5';
      }
      const isFirstAudio = t.kind === 'audio' && audioTracks(s)[0].id === t.id;
      const el = h(`div.track-header${isFirstAudio ? '.sep' : ''}`, { style: { top: `${row.y}px`, height: `${row.h}px` } }, ...items);
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu([
          { label: 'Add Video Track', action: () => edit.addTrack('video') },
          { label: 'Add Audio Track', action: () => edit.addTrack('audio') },
          '-',
          { label: `Delete Track ${t.name}`, action: () => edit.deleteTrack(t.id) },
        ], e.clientX, e.clientY);
      });
      headersInner.append(el);
    }
  }

  function renderSeqTabs() {
    const p = store.project;
    seqTabs.replaceChildren();
    for (const id of p.mediaOrder) {
      const m = p.media[id];
      if (m?.kind !== 'sequence' || !p.sequences[m.sequenceId]) continue;
      const sid = m.sequenceId;
      const tab = h(`span.seq-tab${sid === p.activeSequenceId ? '.active' : ''}`, { title: 'Click to open · double-click to rename · right-click for options' }, p.sequences[sid].name);
      tab.addEventListener('click', () => store.openSequence(sid));
      tab.addEventListener('dblclick', async () => {
        const n = await promptDialog('Rename Sequence', 'Name', p.sequences[sid].name);
        if (n) store.transact('Rename Sequence', () => { store.project.sequences[sid].name = n; });
      });
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu([
          { label: 'Open', action: () => store.openSequence(sid) },
          { label: 'Rename…', action: () => tab.dispatchEvent(new Event('dblclick')) },
          { label: 'Duplicate', action: () => edit.duplicateSequence(sid) },
          { label: 'Delete', action: () => edit.deleteSequence(sid) },
        ], e.clientX, e.clientY);
      });
      seqTabs.append(tab);
    }
    seqTabs.append(h('button.icon', { title: 'New Sequence', onclick: () => edit.newSequence() }, '+'));
  }

  function refreshTopBar() {
    const s = store.seq;
    tcEl.textContent = formatTimecode(store.ui.playhead, s.fps);
    seqName.textContent = `${s.name} · ${s.width}×${s.height} · ${s.fps} fps`;
    snapBtn.classList.toggle('on', store.ui.snapping);
    linkBtn.classList.toggle('on', store.ui.linkedSelection);
    durEl.textContent = `Duration ${formatTimecode(sequenceDuration(s), s.fps)}`;
  }

  tcEl.addEventListener('click', () => {
    // absolute timecode, or +/- offset relative to the playhead (e.g. +15 = 15 frames)
    inlineEdit(tcEl, {
      width: '110px',
      onCommit: (v) => {
        let txt = v.trim();
        const rel = /^[+-]/.test(txt) ? txt[0] : null;
        if (rel) txt = txt.slice(1);
        const t = parseTimecode(txt, fps());
        if (t != null) store.setPlayhead(rel === '+' ? store.ui.playhead + t : rel === '-' ? store.ui.playhead - t : t);
        refreshTopBar();
      },
    });
  });

  function toggleSnap() {
    store.ui.snapping = !store.ui.snapping;
    refreshTopBar();
    toast(`Snap ${store.ui.snapping ? 'on' : 'off'}`);
  }

  function showSettingsMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([
      { label: 'Track Height: Small', checked: view.th === 34, action: () => setTrackH(34) },
      { label: 'Track Height: Medium', checked: view.th === 50, action: () => setTrackH(50) },
      { label: 'Track Height: Large', checked: view.th === 80, action: () => setTrackH(80) },
      { label: 'Track Height: Extra Large', checked: view.th === 120, action: () => setTrackH(120) },
      '-',
      { label: 'Show Video Thumbnails', checked: view.showThumbs, action: () => { view.showThumbs = !view.showThumbs; savePref('tl.thumbs', view.showThumbs); invalidate(); } },
      { label: 'Show Audio Waveforms', checked: view.showWaves, action: () => { view.showWaves = !view.showWaves; savePref('tl.waves', view.showWaves); invalidate(); } },
      '-',
      { label: 'Add Video Track', action: () => edit.addTrack('video') },
      { label: 'Add Audio Track', action: () => edit.addTrack('audio') },
      { label: 'Close All Gaps', action: () => edit.closeAllGaps() },
    ], r.left, r.bottom + 2);
  }

  function setTrackH(px) {
    view.th = px;
    savePref('tl.trackH', px);
    layoutRows();
    renderHeaders();
    syncScrollbars();
    invalidate();
  }

  // ---------------------------------------------------------------- drawing

  function invalidate() {
    staticDirty = true;
    requestDraw();
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function draw() {
    const { ctx, w, h: hh, dpr } = fitCanvasToBox(canvas);
    if (w < 2 || hh < 2) return;
    if (view.width !== w || view.height !== hh) {
      view.width = w;
      view.height = hh;
      staticDirty = true;
      syncScrollbars();
    }
    if (staticDirty || staticCanvas.width !== canvas.width || staticCanvas.height !== canvas.height) {
      staticCanvas.width = canvas.width;
      staticCanvas.height = canvas.height;
      const sctx = staticCanvas.getContext('2d');
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStatic(sctx, w, hh);
      staticDirty = false;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticCanvas, 0, 0);
    ctx.restore();
    drawDynamic(ctx, w, hh);
  }

  function drawStatic(ctx, W, H) {
    const s = store.seq;
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, W, H);

    // lanes
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, W, H - RULER_H);
    ctx.clip();
    for (const row of view.rows) {
      const y = rowY(row);
      if (y > H || y + row.h < RULER_H) continue;
      ctx.fillStyle = row.track.targeted ? '#262a30' : '#242424';
      ctx.fillRect(0, y, W, row.h - 1);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, y + row.h - 1, W, 1);
      if (row.track.locked) {
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.strokeStyle = '#999';
        for (let x = -row.h; x < W; x += 10) {
          ctx.beginPath();
          ctx.moveTo(x, y + row.h);
          ctx.lineTo(x + row.h, y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    const dy = RULER_H + view.dividerY - view.scrollY;
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, dy, W, DIVIDER_H);

    // in/out shading
    if (s.inPoint != null || s.outPoint != null) {
      const a = xOf(s.inPoint ?? 0);
      const b = xOf(s.outPoint ?? sequenceDuration(s));
      ctx.fillStyle = 'rgba(90,140,220,0.07)';
      ctx.fillRect(a, RULER_H, b - a, H);
    }

    const dragIds = drag?.type === 'move' ? new Set(drag.ids) : null;
    // clips
    for (const row of view.rows) {
      const y = rowY(row);
      if (y > H || y + row.h < RULER_H) continue;
      for (const c of clipsOnTrack(s, row.track.id)) {
        const x0 = xOf(c.start);
        const x1 = xOf(clipEnd(c));
        if (x1 < 0 || x0 > W) continue;
        drawClip(ctx, c, x0, y + 1, x1 - x0, row.h - 3, { dim: dragIds?.has(c.id) && !drag.duplicate });
      }
      // transitions
      for (const tw of transitionsOnTrack(s, row.track.id)) {
        const x0 = xOf(tw.start);
        const x1 = xOf(tw.end);
        if (x1 < 0 || x0 > W) continue;
        const sel = store.selection.transition && store.selection.transition.clipId === tw.clip.id && store.selection.transition.edge === tw.edge;
        drawTransition(ctx, tw, x0, y + 1, Math.max(4, x1 - x0), Math.min(row.h - 3, 22), sel);
      }
    }

    // gap selection
    if (store.selection.gap) {
      const g = store.selection.gap;
      const row = rowOfTrack(g.trackId);
      if (row) {
        ctx.fillStyle = 'rgba(80,150,255,0.25)';
        ctx.fillRect(xOf(g.start), rowY(row) + 1, xOf(g.end) - xOf(g.start), row.h - 3);
      }
    }
    ctx.restore();

    drawRuler(ctx, W);
  }

  function drawClip(ctx, c, x, y, w, hh, { dim = false, ghost = false } = {}) {
    const selected = store.selection.clips.has(c.id);
    const [base, light] = COLORS[c.kind] || COLORS.video;
    const offline = c.mediaId && ['offline', 'error', 'missing'].includes(mediaStatus(c.mediaId));
    ctx.save();
    ctx.globalAlpha = ghost ? 0.6 : dim ? 0.35 : 1;
    ctx.beginPath();
    ctx.rect(Math.max(-2, x), y, Math.min(w, view.width + 4 - Math.max(-2, x)), hh);
    ctx.clip();
    ctx.fillStyle = offline ? '#7a2222' : selected ? light : base;
    ctx.fillRect(x, y, w, hh);

    const nameH = Math.min(15, hh);
    const bodyY = y + nameH;
    const bodyH = hh - nameH;
    const m = c.mediaId ? store.project.media[c.mediaId] : null;
    const rt = c.mediaId ? runtime.get(c.mediaId) : null;

    // thumbnails
    if (c.kind === 'video' && view.showThumbs && rt?.filmstrip?.length && bodyH > 10 && w > 8) {
      const fs = rt.filmstrip;
      const aspect = fs[0].canvas.width / fs[0].canvas.height;
      const tw = Math.max(16, bodyH * aspect);
      const startI = Math.max(0, Math.floor((0 - x) / tw));
      for (let i = startI; x + i * tw < Math.min(x + w, view.width); i++) {
        const tx = x + i * tw;
        const tm = mediaTimeAt(c, tOf(tx + tw / 2));
        let best = fs[0];
        for (const f of fs) if (Math.abs(f.t - tm) < Math.abs(best.t - tm)) best = f;
        ctx.drawImage(best.canvas, tx, bodyY, tw, bodyH);
      }
      ctx.fillStyle = selected ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)';
      ctx.fillRect(x, bodyY, w, bodyH);
    } else if ((c.kind === 'image') && rt?.thumb && bodyH > 10) {
      const tw = Math.max(16, (bodyH * rt.thumb.width) / rt.thumb.height);
      ctx.drawImage(rt.thumb, x, bodyY, tw, bodyH);
    }

    // waveform
    if (c.kind === 'audio' && view.showWaves && rt?.peaks && bodyH > 6) {
      const { data, rate } = rt.peaks;
      const mid = bodyY + bodyH / 2;
      const amp = bodyH / 2 - 1;
      const vol = c.effects.find((e) => e.type === 'volume');
      ctx.fillStyle = selected ? 'rgba(10,40,25,0.75)' : 'rgba(170,240,200,0.75)';
      const px0 = Math.max(Math.floor(x), 0);
      const px1 = Math.min(Math.ceil(x + w), view.width);
      for (let px = px0; px < px1; px++) {
        const ta = tOf(px);
        const tb = tOf(px + 1);
        if (c.hold) break;
        let ia = Math.floor(mediaTimeAt(c, ta) * rate);
        let ib = Math.floor(mediaTimeAt(c, tb) * rate);
        if (ia > ib) [ia, ib] = [ib, ia];
        let v = 0;
        for (let i = Math.max(0, ia); i <= Math.min(data.length - 1, Math.max(ia, ib)); i++) if (data[i] > v) v = data[i];
        const g = vol ? dbToGain(evalParamAt(vol, 'level', ta - c.start)) : 1;
        const a = Math.min(amp, v * g * amp);
        if (a > 0.3) ctx.fillRect(px, mid - a, 1, a * 2);
      }
    }

    // volume rubber band
    if (c.kind === 'audio' && bodyH > 14) {
      const vol = c.effects.find((e) => e.type === 'volume');
      if (vol) {
        ctx.strokeStyle = '#f0d050';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const steps = isAnimated(vol.params.level) ? Math.max(2, Math.min(200, Math.ceil(w / 4))) : 1;
        for (let i = 0; i <= steps; i++) {
          const px = x + (w * i) / steps;
          const db = evalParamAt(vol, 'level', tOf(px) - c.start);
          const py = volumeY(db, bodyY, bodyH);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        if (vol.params.level.kf) {
          ctx.fillStyle = '#f0d050';
          for (const k of vol.params.level.kf) {
            const px = xOf(c.start + k.t);
            ctx.fillRect(px - 2, volumeY(k.v, bodyY, bodyH) - 2, 4, 4);
          }
        }
      }
    }

    // text preview
    if (c.kind === 'text' && bodyH > 10) {
      const fx = c.effects.find((e) => e.type === 'text');
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '11px sans-serif';
      ctx.fillText(`T  ${String(fx?.params.content.value || '').replace(/\n/g, ' ')}`, Math.max(x, 0) + 4, bodyY + Math.min(bodyH - 3, 13));
    }
    if (c.kind === 'color' && bodyH > 6) {
      const fx = c.effects.find((e) => e.type === 'fill');
      ctx.fillStyle = fx?.params.color.value || '#000';
      ctx.fillRect(x + 3, bodyY + 2, Math.min(24, w - 6), bodyH - 4);
    }

    // name bar
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x, y, w, nameH);
    let labelX = Math.max(x, 0) + 3;
    const userFx = c.effects.filter((e) => !EFFECTS[e.type]?.fixed);
    const anyKf = c.effects.some((e) => Object.values(e.params).some((p) => p.kf?.length));
    if (w > 22) {
      ctx.fillStyle = userFx.length ? '#e8c547' : anyKf ? '#9fc5ff' : 'rgba(255,255,255,0.35)';
      ctx.font = 'italic bold 10px serif';
      ctx.fillText('fx', labelX, y + 11);
      labelX += 14;
    }
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui, sans-serif';
    let label = c.name || m?.name || c.kind;
    if (c.hold) label += ' [Hold]';
    else if (c.speed !== 1 || c.reverse) label += ` [${c.reverse ? '-' : ''}${Math.round(c.speed * 100)}%]`;
    if (offline) label = `MEDIA OFFLINE · ${label}`;
    ctx.save();
    ctx.beginPath();
    ctx.rect(labelX, y, Math.max(0, x + w - labelX - 3), nameH);
    ctx.clip();
    ctx.fillText(label, labelX, y + 11);
    ctx.restore();

    // edges
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
    if (c.enabled === false) {
      ctx.fillStyle = 'rgba(30,30,30,0.6)';
      ctx.fillRect(x, y, w, hh);
    }
    // in/out handle hints
    if (m && Number.isFinite(m.duration) && isTimed(c) && !c.hold) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      if (c.inPoint < 1e-3) ctx.fillRect(x, y, 3, 3);
      if (Math.abs(c.inPoint + c.duration * c.speed - m.duration) < 1 / fps()) ctx.fillRect(x + w - 3, y, 3, 3);
    }
    ctx.restore();
  }

  function volumeY(db, bodyY, bodyH) {
    // map +15..-60 dB onto the clip body (0 dB at ~1/4 from top)
    const n = db >= 0 ? 0.25 - (db / 15) * 0.25 : 0.25 + (Math.min(60, -db) / 60) * 0.75;
    return bodyY + 2 + clamp(n, 0, 1) * (bodyH - 4);
  }

  function dbFromY(y, bodyY, bodyH) {
    const n = clamp((y - bodyY - 2) / (bodyH - 4), 0, 1);
    return n <= 0.25 ? ((0.25 - n) / 0.25) * 15 : -((n - 0.25) / 0.75) * 60;
  }

  function evalParamAt(fx, key, tl) {
    return evalEffect({ params: { [key]: fx.params[key] } }, tl)[key];
  }

  function drawTransition(ctx, tw, x, y, w, hh, selected) {
    ctx.save();
    ctx.fillStyle = selected ? '#b98cf0' : '#8a63c7';
    ctx.globalAlpha = 0.92;
    ctx.fillRect(x, y, w, hh);
    ctx.strokeStyle = selected ? '#fff' : '#3c2a5a';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    if (tw.a && tw.b) {
      ctx.moveTo(x, y + hh);
      ctx.lineTo(x + w, y);
    } else if (tw.edge === 'in') {
      ctx.moveTo(x, y + hh);
      ctx.lineTo(x + w, y);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + hh);
    }
    ctx.stroke();
    if (w > 50) {
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.fillText(TRANSITIONS[tw.type]?.name || tw.type, x + 3, y + 12, w - 6);
    }
    ctx.restore();
  }

  function rulerStep() {
    const f = fps();
    const candidates = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (const c of candidates) if (c * view.pps >= 70) return c;
    return 3600;
  }

  function drawRuler(ctx, W) {
    const s = store.seq;
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, RULER_H - 1, W, 1);
    const step = rulerStep();
    const minor = step / 5;
    const t0 = Math.floor(tOf(0) / minor) * minor;
    ctx.strokeStyle = '#6a6a6a';
    ctx.fillStyle = '#a8a8a8';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.beginPath();
    for (let t = Math.max(0, t0); xOf(t) < W; t += minor) {
      const x = Math.round(xOf(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, major ? 14 : 22);
      ctx.lineTo(x, RULER_H - 8);
      if (major) ctx.fillText(formatTimecode(t, s.fps), x + 3, 11);
    }
    ctx.stroke();
    // in/out on ruler
    if (s.inPoint != null || s.outPoint != null) {
      const a = xOf(s.inPoint ?? 0);
      const b = xOf(s.outPoint ?? sequenceDuration(s));
      ctx.fillStyle = 'rgba(90,150,240,0.45)';
      ctx.fillRect(a, RULER_H - 8, b - a, 7);
      ctx.fillStyle = '#cfe2ff';
      if (s.inPoint != null) ctx.fillRect(a, RULER_H - 9, 2, 9);
      if (s.outPoint != null) ctx.fillRect(b - 2, RULER_H - 9, 2, 9);
    }
    // markers
    for (const mk of s.markers) {
      const x = xOf(mk.time);
      if (x < -10 || x > W + 10) continue;
      ctx.fillStyle = mk.color || '#4ade80';
      ctx.beginPath();
      ctx.moveTo(x - 5, 14);
      ctx.lineTo(x + 5, 14);
      ctx.lineTo(x + 5, 21);
      ctx.lineTo(x, 26);
      ctx.lineTo(x - 5, 21);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawDynamic(ctx, W, H) {
    const s = store.seq;
    // markers through tracks (thin)
    ctx.save();
    for (const mk of s.markers) {
      const x = Math.round(xOf(mk.time)) + 0.5;
      if (x < 0 || x > W) continue;
      ctx.strokeStyle = 'rgba(74,222,128,0.25)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    // drag ghosts
    if (drag?.type === 'move' && drag.moved) {
      for (const g of drag.ghosts || []) {
        const row = rowOfTrack(g.trackId);
        if (!row) continue;
        const c = s.clips[g.id];
        if (!c) continue;
        drawClip(ctx, c, xOf(g.start), rowY(row) + 1, c.duration * view.pps, row.h - 3, { ghost: true });
      }
    }
    if (dropPreview) {
      for (const g of dropPreview.ghosts) {
        const row = rowOfTrack(g.trackId);
        if (!row) continue;
        ctx.fillStyle = 'rgba(120,160,255,0.35)';
        ctx.strokeStyle = '#9fc5ff';
        const x = xOf(g.start);
        ctx.fillRect(x, rowY(row) + 1, g.duration * view.pps, row.h - 3);
        ctx.strokeRect(x + 0.5, rowY(row) + 1.5, g.duration * view.pps - 1, row.h - 4);
      }
      if (dropPreview.insert) {
        ctx.fillStyle = '#ffd34d';
        ctx.fillRect(xOf(dropPreview.start) - 1, RULER_H, 2, H);
      }
    }
    if (drag?.type === 'marquee' && drag.moved) {
      ctx.fillStyle = 'rgba(90,150,240,0.15)';
      ctx.strokeStyle = '#7fb0ff';
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }
    // razor preview
    if (hover?.razor != null) {
      ctx.strokeStyle = '#ff6b6b';
      ctx.setLineDash([4, 3]);
      const x = Math.round(xOf(hover.razor)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, hover.allTracks ? RULER_H : hover.y0);
      ctx.lineTo(x, hover.allTracks ? H : hover.y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // snap line
    if (drag?.snapAt != null) {
      const x = Math.round(xOf(drag.snapAt)) + 0.5;
      ctx.strokeStyle = '#ffe066';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    // trim tooltip
    if (drag?.tooltip) {
      ctx.font = '11px ui-monospace, monospace';
      const tw = ctx.measureText(drag.tooltip).width + 10;
      const tx = clamp(drag.tipX + 10, 0, W - tw);
      ctx.fillStyle = 'rgba(20,20,20,0.92)';
      ctx.fillRect(tx, drag.tipY - 26, tw, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(drag.tooltip, tx + 5, drag.tipY - 13);
    }
    // playhead
    const px = Math.round(xOf(store.ui.playhead)) + 0.5;
    if (px >= -10 && px <= W + 10) {
      ctx.strokeStyle = '#4aa3ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, RULER_H - 10);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.fillStyle = '#4aa3ff';
      ctx.beginPath();
      ctx.moveTo(px - 6, 12);
      ctx.lineTo(px + 6, 12);
      ctx.lineTo(px + 6, 20);
      ctx.lineTo(px, 26);
      ctx.lineTo(px - 6, 20);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- hit testing

  function hitTest(x, y) {
    if (y < RULER_H) return { area: 'ruler' };
    const row = rowAtY(y);
    if (!row) return { area: 'empty' };
    const t = tOf(x);
    const s = store.seq;
    const ry = rowY(row);
    // transitions (drawn in the top part of the track)
    for (const tw of transitionsOnTrack(s, row.track.id)) {
      const x0 = xOf(tw.start);
      const x1 = Math.max(x0 + 4, xOf(tw.end));
      if (x >= x0 && x <= x1 && y >= ry && y <= ry + Math.min(row.h - 3, 22)) {
        return { area: 'transition', row, t, transition: tw };
      }
    }
    const clips = clipsOnTrack(s, row.track.id);
    for (const c of clips) {
      const x0 = xOf(c.start);
      const x1 = xOf(clipEnd(c));
      if (x < x0 - 1 || x > x1 + 1) continue;
      const w = x1 - x0;
      const ez = Math.min(EDGE_PX, w / 3);
      let zone = 'body';
      if (x <= x0 + ez) zone = 'in';
      else if (x >= x1 - ez) zone = 'out';
      if (zone === 'body' && c.kind === 'audio' && row.h >= 30) {
        const nameH = Math.min(15, row.h - 3);
        const vol = c.effects.find((e) => e.type === 'volume');
        if (vol) {
          const vy = volumeY(evalParamAt(vol, 'level', t - c.start), ry + 1 + nameH, row.h - 3 - nameH);
          if (Math.abs(y - vy) <= 3) zone = 'volume';
        }
      }
      return { area: 'clip', row, t, clip: c, zone };
    }
    return { area: 'track', row, t };
  }

  function snapCandidates(excludeIds = new Set()) {
    const s = store.seq;
    const pts = [0, store.ui.playhead];
    for (const c of Object.values(s.clips)) {
      if (excludeIds.has(c.id)) continue;
      pts.push(c.start, clipEnd(c));
    }
    for (const mk of s.markers) pts.push(mk.time);
    if (s.inPoint != null) pts.push(s.inPoint);
    if (s.outPoint != null) pts.push(s.outPoint);
    return pts;
  }

  /** Snap a set of candidate times; returns {delta, at} for the best match within SNAP_PX. */
  function snapDelta(times, candidates) {
    if (!store.ui.snapping) return { delta: 0, at: null };
    let best = null;
    const thr = SNAP_PX / view.pps;
    for (const t of times) {
      for (const c of candidates) {
        const d = c - t;
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: c };
      }
    }
    return best || { delta: 0, at: null };
  }

  // ---------------------------------------------------------------- pointer interactions

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerleave', () => {
    if (hover) {
      hover = null;
      requestDraw();
    }
  });

  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    canvas.focus();
    store.setFocus('timeline');
    const { x, y } = localPos(e);
    const hit = hitTest(x, y);
    const tool = store.ui.tool;
    canvas.setPointerCapture(e.pointerId);

    if (tool === 'hand' || e.button === 1) {
      drag = { type: 'pan', x0: x, y0: y, sx: view.scrollX, sy: view.scrollY };
      return;
    }
    if (tool === 'zoom') {
      setZoom(view.pps * (e.altKey ? 0.5 : 2), x);
      return;
    }

    if (hit.area === 'ruler') {
      // marker drag?
      const mk = store.seq.markers.find((m) => Math.abs(xOf(m.time) - x) < 6 && y > 12 && y < 28);
      if (mk) {
        store.begin('Move Marker');
        drag = { type: 'marker', id: mk.id, t0: mk.time, x0: x };
        return;
      }
      playback.stop();
      drag = { type: 'scrub' };
      scrubTo(x, e.shiftKey);
      return;
    }

    if (hit.area === 'transition' && (tool === 'select' || tool === 'ripple' || tool === 'rolling')) {
      store.selectTransition(hit.transition.clip.id, hit.transition.edge);
      return;
    }

    if (hit.area === 'clip' && getTrack(store.seq, hit.clip.trackId)?.locked) {
      store.selectClips([hit.clip.id]);
      return;
    }

    switch (tool) {
      case 'razor':
        if (hit.area === 'clip') {
          const t = razorTime(x);
          if (e.shiftKey) edit.addEdit({ allTracks: true, t });
          else edit.addEdit({ t, clipIds: [hit.clip.id] });
        }
        return;
      case 'track': {
        if (hit.area === 'empty' || !hit.row) return;
        const t = hit.t;
        edit.selectForward(t, e.shiftKey ? null : hit.row.track.id);
        if (store.selection.clips.size) beginMove(e, x, y, hit, [...store.selection.clips]);
        return;
      }
      case 'slip':
        if (hit.area === 'clip' && isTimed(hit.clip)) {
          store.selectClips([...edit.withLinked([hit.clip.id])]);
          beginSlip(x, hit.clip);
        }
        return;
      case 'ripple':
      case 'rolling':
        if (hit.area === 'clip' && hit.zone !== 'body' && hit.zone !== 'volume') {
          beginTrim(x, y, hit, tool === 'ripple' ? 'ripple' : 'rolling', e);
          return;
        }
        break;
      default:
        break;
    }

    // selection tool (and fallthrough)
    if (hit.area === 'clip') {
      const c = hit.clip;
      if (hit.zone === 'volume') {
        store.selectClips([c.id]);
        if (modKey(e)) addVolumeKeyframe(c.id, hit.t);
        else beginVolume(y, hit, x);
        return;
      }
      if (hit.zone === 'in' || hit.zone === 'out') {
        beginTrim(x, y, hit, modKey(e) ? 'ripple' : 'normal', e);
        return;
      }
      const ids = e.altKey ? [c.id] : [...edit.withLinked([c.id])];
      const wasSelected = store.selection.clips.has(c.id);
      if (e.shiftKey) store.toggleClips(ids);
      else if (!wasSelected || e.altKey) store.selectClips(ids);
      if (!store.selection.clips.has(c.id)) return;
      beginMove(e, x, y, hit, [...store.selection.clips]);
      // a plain click on an already-selected clip narrows the selection on release
      if (wasSelected && !e.shiftKey && drag) drag.clickIds = ids;
      return;
    }
    if (hit.area === 'track' || hit.area === 'empty') {
      drag = { type: 'marquee', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, hit };
      if (!e.shiftKey) store.clearSelection();
    }
  }

  function razorTime(x) {
    let t = snapFrame(tOf(x), fps());
    if (store.ui.snapping && Math.abs(xOf(store.ui.playhead) - x) < SNAP_PX) t = store.ui.playhead;
    return t;
  }

  function scrubTo(x, snap) {
    let t = Math.max(0, tOf(x));
    if (snap || store.ui.snapping) {
      const pts = editPoints(store.seq).concat(store.seq.markers.map((m) => m.time));
      const sd = snapDelta([t], pts);
      if (snap || sd.at != null) t += sd.delta;
    }
    store.setPlayhead(snapFrame(t, fps()));
  }

  function beginMove(e, x, y, hit, ids) {
    const s = store.seq;
    const movable = ids.filter((id) => s.clips[id] && !getTrack(s, s.clips[id].trackId)?.locked);
    if (!movable.length) return;
    drag = {
      type: 'move', ids: movable, x0: x, y0: y, moved: false,
      anchorKind: hit.clip.kind === 'audio' ? 'audio' : 'video',
      anchorRow: view.rows.indexOf(hit.row),
      duplicate: e.altKey, insert: modKey(e),
      candidates: snapCandidates(new Set(movable)),
      ghosts: [], dt: 0, dV: 0, dA: 0,
    };
  }

  function beginTrim(x, y, hit, mode, e) {
    const s = store.seq;
    const c = hit.clip;
    const edge = hit.zone;
    let clips = e.altKey || !store.ui.linkedSelection ? [c] : linkedClips(s, c).filter((l) => Math.abs((edge === 'in' ? l.start : clipEnd(l)) - (edge === 'in' ? c.start : clipEnd(c))) < 1e-4);
    clips = clips.filter((l) => !getTrack(s, l.trackId)?.locked);
    let partner = null;
    if (mode === 'rolling') {
      partner = edge === 'out' ? nextAdjacent(s, c) : prevAdjacent(s, c);
      if (!partner) mode = 'normal';
    }
    let min = -Infinity;
    let max = Infinity;
    for (const l of clips) {
      const lim = edit.trimLimits(l, edge, { ripple: mode === 'ripple', rolling: mode === 'rolling' });
      min = Math.max(min, lim.min);
      max = Math.min(max, lim.max);
    }
    let partners = [];
    if (mode === 'rolling') {
      partners = clips.map((l) => (edge === 'out' ? nextAdjacent(s, l) : prevAdjacent(s, l))).filter(Boolean);
      const pedge = edge === 'out' ? 'in' : 'out';
      for (const p of partners) {
        const lim = edit.trimLimits(p, pedge, { rolling: true });
        // partner delta is the same time shift: for its 'in' edge positive delta shortens
        min = Math.max(min, lim.min);
        max = Math.min(max, lim.max);
      }
    }
    store.selectClips(clips.map((l) => l.id));
    store.begin(mode === 'ripple' ? 'Ripple Trim' : mode === 'rolling' ? 'Rolling Edit' : 'Trim');
    const restorePlayhead = store.ui.playhead;
    const edgeT = edge === 'in' ? c.start : clipEnd(c);
    drag = {
      type: 'trim', mode, edge, ids: clips.map((l) => l.id), partnerIds: partners.map((p) => p.id),
      x0: x, edgeT, min, max, applied: 0, candidates: snapCandidates(new Set([...clips, ...partners].map((l) => l.id))),
      tipX: x, tipY: y, restorePlayhead,
    };
  }

  function beginSlip(x, c) {
    const m = store.project.media[c.mediaId];
    const max = m && Number.isFinite(m.duration) ? (m.duration - c.inPoint - c.duration * c.speed) : Infinity;
    const min = -c.inPoint;
    store.begin('Slip');
    drag = { type: 'slip', ids: [...edit.withLinked([c.id])], x0: x, min, max, applied: 0, restorePlayhead: store.ui.playhead };
  }

  function beginVolume(y, hit, x) {
    const c = hit.clip;
    const nameH = Math.min(15, hit.row.h - 3);
    const vol = c.effects.find((e) => e.type === 'volume');
    // grabbing a keyframe dot moves just that keyframe
    const kfIndex = vol?.params.level.kf ? vol.params.level.kf.findIndex((k) => Math.abs(xOf(c.start + k.t) - x) <= 5) : -1;
    store.begin(kfIndex >= 0 ? 'Move Volume Keyframe' : 'Volume');
    drag = { type: 'volume', id: c.id, bodyY: rowY(hit.row) + 1 + nameH, bodyH: hit.row.h - 3 - nameH, tl: hit.t - c.start, kfIndex, x0: x };
  }

  /** Ctrl/Cmd+click on the volume rubber band adds a keyframe there. */
  function addVolumeKeyframe(clipId, t) {
    store.transact('Add Volume Keyframe', () => {
      const c = store.seq.clips[clipId];
      const vol = c?.effects.find((e) => e.type === 'volume');
      if (!vol) return;
      const p = vol.params.level;
      const tl = clamp(snapFrame(t, fps()) - c.start, 0, c.duration);
      const v = evalParamAt(vol, 'level', tl);
      if (!p.kf) p.kf = [];
      if (!p.kf.some((k) => Math.abs(k.t - tl) < 0.5 / fps())) p.kf.push({ t: tl, v, ease: 'linear' });
      p.kf.sort((a, b) => a.t - b.t);
    });
  }

  function onPointerMove(e) {
    const { x, y } = localPos(e);
    if (!drag) {
      updateHover(x, y, e);
      return;
    }
    const s = store.seq;
    switch (drag.type) {
      case 'pan':
        setScrollX(drag.sx - (x - drag.x0));
        setScrollY(drag.sy - (y - drag.y0));
        break;
      case 'scrub':
        scrubTo(x, e.shiftKey);
        autoScroll(x);
        break;
      case 'marker': {
        const mk = s.markers.find((m) => m.id === drag.id);
        if (mk) {
          mk.time = Math.max(0, snapFrame(drag.t0 + (x - drag.x0) / view.pps, fps()));
          store.changed();
        }
        break;
      }
      case 'marquee':
        drag.x1 = x;
        drag.y1 = y;
        drag.moved = drag.moved || Math.abs(x - drag.x0) > 3 || Math.abs(y - drag.y0) > 3;
        if (drag.moved) updateMarquee();
        requestDraw();
        break;
      case 'move': {
        const dx = x - drag.x0;
        const dy = y - drag.y0;
        if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        drag.moved = true;
        drag.duplicate = e.altKey;
        drag.insert = modKey(e);
        let dt = dx / view.pps;
        const clips = drag.ids.map((id) => s.clips[id]).filter(Boolean);
        const minStart = Math.min(...clips.map((c) => c.start));
        dt = Math.max(-minStart, dt);
        const times = clips.flatMap((c) => [c.start + dt, clipEnd(c) + dt]);
        const sd = snapDelta(times, drag.candidates);
        dt += sd.delta;
        dt = snapFrame(dt, fps());
        drag.snapAt = sd.at;
        // vertical: lanes moved within the anchor kind
        const row = rowAtY(y);
        let dV = 0;
        let dA = 0;
        if (row) {
          const kindRows = view.rows.filter((r) => r.track.kind === drag.anchorKind);
          const anchorTrackId = view.rows[drag.anchorRow]?.track.id;
          const from = kindRows.findIndex((r) => r.track.id === anchorTrackId);
          const to = kindRows.findIndex((r) => r.track.id === row.track.id);
          if (from >= 0 && to >= 0) {
            // rows for video are displayed reversed (top = highest track)
            const d = drag.anchorKind === 'video' ? from - to : to - from;
            if (drag.anchorKind === 'video') dV = d;
            else dA = d;
          }
        }
        drag.dt = dt;
        drag.dV = dV;
        drag.dA = dA;
        const vts = videoTracks(s);
        const ats = audioTracks(s);
        drag.ghosts = clips.map((c) => {
          const list = c.kind === 'audio' ? ats : vts;
          const idx = list.findIndex((t) => t.id === c.trackId);
          const ni = clamp(idx + (c.kind === 'audio' ? dA : dV), 0, list.length - 1);
          return { id: c.id, trackId: list[ni].id, start: c.start + dt };
        });
        drag.tooltip = `${dt >= 0 ? '+' : '-'}${formatTimecode(Math.abs(dt), fps())}${drag.insert ? '  (insert)' : ''}${drag.duplicate ? '  (copy)' : ''}`;
        drag.tipX = x;
        drag.tipY = y;
        autoScroll(x);
        invalidate();
        break;
      }
      case 'trim': {
        let delta = (x - drag.x0) / view.pps;
        const sd = snapDelta([drag.edgeT + delta], drag.candidates);
        delta += sd.delta;
        drag.snapAt = sd.at;
        delta = clamp(snapFrame(delta, fps()), drag.min, drag.max);
        applyTrim(delta);
        drag.tooltip = `${delta >= 0 ? '+' : '-'}${formatTimecode(Math.abs(delta), fps())}`;
        drag.tipX = x;
        drag.tipY = y;
        autoScroll(x);
        break;
      }
      case 'slip': {
        const delta = clamp(snapFrame((x - drag.x0) / view.pps, fps()), drag.min, drag.max);
        const inc = delta - drag.applied;
        for (const id of drag.ids) {
          const c = s.clips[id];
          if (c) c.inPoint += inc * c.speed;
        }
        drag.applied = delta;
        drag.tooltip = `Slip ${delta >= 0 ? '+' : '-'}${formatTimecode(Math.abs(delta), fps())}`;
        drag.tipX = x;
        drag.tipY = y;
        store.changed();
        // show the new in-point frame
        const c = s.clips[drag.ids[0]];
        if (c) store.setPlayhead(c.start);
        break;
      }
      case 'volume': {
        const c = s.clips[drag.id];
        const vol = c?.effects.find((ef) => ef.type === 'volume');
        if (!vol) break;
        const db = Math.round(dbFromY(y, drag.bodyY, drag.bodyH) * 10) / 10;
        const p = vol.params.level;
        if (drag.kfIndex >= 0 && p.kf?.[drag.kfIndex]) {
          const k = p.kf[drag.kfIndex];
          k.v = clamp(db, -60, 15);
          k.t = clamp(snapFrame(drag.tl + (x - drag.x0) / view.pps, fps()), 0, c.duration);
        } else if (isAnimated(p)) {
          // move every keyframe by the same delta
          const cur = evalParamAt(vol, 'level', drag.tl);
          const d = db - cur;
          for (const k of p.kf) k.v = clamp(k.v + d, -60, 15);
        } else p.value = clamp(db, -60, 15);
        drag.tooltip = `${db.toFixed(1)} dB`;
        drag.tipX = x;
        drag.tipY = y;
        store.changed();
        break;
      }
    }
    requestDraw();
  }

  function applyTrim(delta) {
    const s = store.seq;
    const inc = delta - drag.applied;
    if (Math.abs(inc) < EPS) return;
    const clips = drag.ids.map((id) => s.clips[id]).filter(Boolean);
    if (drag.mode === 'ripple') {
      edit.rawRippleTrim(clips, drag.edge, inc);
    } else if (drag.mode === 'rolling') {
      // the cut moves: both sides of the edit point change by the same amount
      for (const c of clips) edit.rawTrimEdge(c, drag.edge, inc);
      for (const id of drag.partnerIds) {
        const p = s.clips[id];
        if (p) edit.rawTrimEdge(p, drag.edge === 'out' ? 'in' : 'out', inc);
      }
    } else {
      for (const c of clips) edit.rawTrimEdge(c, drag.edge, inc);
    }
    drag.applied = delta;
    // preview the edit frame
    const c = clips[0];
    if (c) store.setPlayhead(drag.edge === 'in' ? c.start : Math.max(c.start, clipEnd(c) - 1 / fps()));
    store.changed();
  }

  function updateMarquee() {
    const s = store.seq;
    const t0 = tOf(Math.min(drag.x0, drag.x1));
    const t1 = tOf(Math.max(drag.x0, drag.x1));
    const y0 = Math.min(drag.y0, drag.y1);
    const y1 = Math.max(drag.y0, drag.y1);
    const ids = [];
    for (const row of view.rows) {
      const ry = rowY(row);
      if (ry + row.h < y0 || ry > y1) continue;
      for (const c of clipsOnTrack(s, row.track.id)) if (clipEnd(c) > t0 && c.start < t1) ids.push(c.id);
    }
    store.selectClips(ids, { add: drag.add });
  }

  function onPointerUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    const s = store.seq;
    switch (d.type) {
      case 'move':
        if (!d.moved && d.clickIds) store.selectClips(d.clickIds);
        if (d.moved && (Math.abs(d.dt) > EPS || d.dV || d.dA || d.duplicate)) {
          store.transact(d.duplicate ? 'Duplicate' : d.insert ? 'Insert Move' : 'Move', () => {
            const ids = edit.rawMoveClips(d.ids, d.dt, d.dV, d.dA, { mode: d.insert ? 'insert' : 'overwrite', duplicate: d.duplicate });
            if (!ids) toast('Cannot move onto a locked track');
            else if (d.duplicate) store.selectClips(ids);
          });
        }
        break;
      case 'trim':
      case 'slip':
      case 'volume':
      case 'marker':
        // trims and slips preview the edit frame in the Program monitor; put the playhead back
        if (d.restorePlayhead != null) store.setPlayhead(d.restorePlayhead);
        store.commit();
        if (d.type === 'marker') s.markers.sort((a, b) => a.time - b.time);
        break;
      case 'marquee':
        if (!d.moved && d.hit?.area === 'track') {
          // click in empty track space: select the gap if it is bounded by clips
          const clips = clipsOnTrack(s, d.hit.row.track.id);
          const t = d.hit.t;
          const prev = clips.filter((c) => clipEnd(c) <= t).pop();
          const next = clips.find((c) => c.start >= t);
          if (next) store.selectGap({ trackId: d.hit.row.track.id, start: prev ? clipEnd(prev) : 0, end: next.start });
        }
        break;
    }
    invalidate();
  }

  function updateHover(x, y, e) {
    const hit = hitTest(x, y);
    const tool = store.ui.tool;
    let cursor = 'default';
    hover = null;
    if (tool === 'hand') cursor = 'grab';
    else if (tool === 'zoom') cursor = e.altKey ? 'zoom-out' : 'zoom-in';
    else if (hit.area === 'ruler') cursor = 'pointer';
    else if (hit.area === 'clip') {
      if (tool === 'razor') {
        cursor = 'crosshair';
        const row = hit.row;
        hover = { razor: razorTime(x), allTracks: e.shiftKey, y0: rowY(row), y1: rowY(row) + row.h };
      } else if (tool === 'slip') cursor = 'ew-resize';
      else if (hit.zone === 'in' || hit.zone === 'out') cursor = tool === 'ripple' || modKey(e) ? 'col-resize' : tool === 'rolling' ? 'ew-resize' : 'col-resize';
      else if (hit.zone === 'volume') cursor = 'ns-resize';
      else if (tool === 'track') cursor = 'e-resize';
    }
    canvas.style.cursor = cursor;
    requestDraw();
  }

  function autoScroll(x) {
    if (x > view.width - 20) setScrollX(view.scrollX + 20);
    else if (x < 20 && view.scrollX > 0) setScrollX(view.scrollX - 20);
  }

  function onDoubleClick(e) {
    const { x, y } = localPos(e);
    const hit = hitTest(x, y);
    if (hit.area === 'ruler') {
      const mk = store.seq.markers.find((m) => Math.abs(xOf(m.time) - x) < 6);
      if (mk) openMarkerDialog(mk.id);
      return;
    }
    if (hit.area === 'clip') {
      const c = hit.clip;
      const nm = c.mediaId && store.project.media[c.mediaId];
      if (nm?.kind === 'sequence') {
        // open the nested sequence, parking the playhead at the matching time
        const t = mediaTimeAt(c, store.ui.playhead >= c.start && store.ui.playhead < clipEnd(c) ? store.ui.playhead : c.start);
        store.openSequence(nm.sequenceId);
        store.setPlayhead(Math.max(0, t));
        return;
      }
      if (c.mediaId && store.project.media[c.mediaId] && (c.kind === 'video' || c.kind === 'audio' || c.kind === 'image')) {
        store.ui.sourceMediaId = c.mediaId;
        store.ui.sourceSeek = mediaTimeAt(c, store.ui.playhead >= c.start && store.ui.playhead < clipEnd(c) ? store.ui.playhead : c.start);
        store.emit('source');
      }
      store.emit('reveal-effect-controls');
    }
    if (hit.area === 'transition') store.emit('reveal-effect-controls');
  }

  function onContextMenu(e) {
    e.preventDefault();
    const { x, y } = localPos(e);
    const hit = hitTest(x, y);
    const s = store.seq;
    if (hit.area === 'transition') {
      store.selectTransition(hit.transition.clip.id, hit.transition.edge);
      showMenu([
        { label: 'Set Transition Duration…', action: async () => {
          const c = s.clips[hit.transition.clip.id];
          const key = hit.transition.edge === 'in' ? 'transIn' : 'transOut';
          const v = await promptDialog('Transition Duration', 'Duration (timecode or frames)', formatTimecode(c[key].duration, s.fps));
          const d = v != null ? parseTimecode(v, s.fps) : null;
          if (d) store.transact('Transition Duration', () => edit.setTransitionDuration(c.id, hit.transition.edge, d));
        } },
        { label: 'Clear', key: 'Del', action: () => edit.deleteSelection() },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'clip') {
      const c = hit.clip;
      if (!store.selection.clips.has(c.id)) store.selectClips([...edit.withLinked([c.id])]);
      const sel = store.selectedClips();
      const ids = sel.map((x) => x.id);
      const cb = store.ui.clipboard;
      showMenu([
        { label: 'Cut', key: 'Ctrl+X', action: () => edit.copySelection(true) },
        { label: 'Copy', key: 'Ctrl+C', action: () => edit.copySelection() },
        { label: 'Paste Attributes', disabled: !(cb && cb.clips.length >= 1), action: () => edit.pasteAttributes(cb.clips.find((x) => (x.kind === 'audio') === (c.kind === 'audio')) || cb.clips[0], ids) },
        { label: 'Remove Effects', action: () => store.transact('Remove Effects', () => { for (const x of sel) x.effects = x.effects.filter((fx) => EFFECTS[fx.type]?.fixed); }) },
        '-',
        { label: 'Clear', key: 'Del', action: () => edit.deleteSelection() },
        { label: 'Ripple Delete', key: 'Shift+Del', action: () => edit.deleteSelection({ ripple: true }) },
        '-',
        { label: 'Enable', checked: c.enabled !== false, key: 'Shift+E', action: () => edit.setEnabled(ids, !(c.enabled !== false)) },
        c.linkId ? { label: 'Unlink', key: 'Ctrl+L', action: () => edit.unlinkClips(ids) } : { label: 'Link', key: 'Ctrl+L', disabled: ids.length < 2, action: () => edit.linkClips(ids) },
        { label: 'Rename…', action: async () => { const n = await promptDialog('Rename Clip', 'Name', c.name); if (n != null) edit.renameClip(c.id, n); } },
        '-',
        { label: 'Speed/Duration…', key: 'Ctrl+R', action: () => openSpeedDialog(ids) },
        { label: 'Add Frame Hold', disabled: c.kind !== 'video', action: () => edit.addFrameHold(c) },
        { label: 'Reverse Speed', checked: !!c.reverse, disabled: !isTimed(c), action: () => edit.setSpeed(ids, { speed: c.speed, reverse: !c.reverse }) },
        '-',
        { label: 'Apply Default Transitions', key: 'Shift+D', action: () => edit.applyDefaultTransitions() },
        { label: 'Nest…', action: async () => { const n = await promptDialog('Nested Sequence Name', 'Name', `Nested Sequence ${Object.keys(store.project.sequences).length}`); if (n != null) edit.nestSelection(n); } },
        c.kind === 'nest' ? { label: 'Open Nested Sequence', action: () => store.openSequence(store.project.media[c.mediaId]?.sequenceId) } : null,
        { label: 'Scale to Fill Frame', disabled: !(c.kind === 'video' || c.kind === 'image'), action: () => scaleToFill(sel) },
        { label: 'Reset Motion', disabled: !c.effects.some((fx) => fx.type === 'motion'), action: () => { for (const x of sel) { const fx = x.effects.find((f) => f.type === 'motion'); if (fx) edit.resetEffect(x.id, fx.id); } } },
        '-',
        { label: 'Reveal in Project', disabled: !c.mediaId, action: () => { store.ui.selectedMedia = new Set([c.mediaId]); store.emit('reveal-media', c.mediaId); } },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'track') {
      const clips = clipsOnTrack(s, hit.row.track.id);
      const prev = clips.filter((c) => clipEnd(c) <= hit.t).pop();
      const next = clips.find((c) => c.start >= hit.t);
      showMenu([
        { label: 'Ripple Delete', disabled: !next, action: () => { store.selectGap({ trackId: hit.row.track.id, start: prev ? clipEnd(prev) : 0, end: next.start }); edit.deleteSelection(); } },
        { label: 'Paste', key: 'Ctrl+V', disabled: !store.ui.clipboard, action: () => { store.setPlayhead(snapFrame(hit.t, fps())); edit.paste(); } },
        '-',
        { label: 'Add Video Track', action: () => edit.addTrack('video') },
        { label: 'Add Audio Track', action: () => edit.addTrack('audio') },
        { label: 'Close All Gaps', action: () => edit.closeAllGaps() },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'ruler') {
      const mk = s.markers.find((m) => Math.abs(xOf(m.time) - x) < 6);
      showMenu([
        { label: 'Add Marker', key: 'M', action: () => edit.addMarker(snapFrame(tOf(x), fps())) },
        { label: 'Edit Marker…', disabled: !mk, action: () => openMarkerDialog(mk.id) },
        { label: 'Delete Marker', disabled: !mk, action: () => edit.removeMarker(mk.id) },
        '-',
        { label: 'Mark In Here', action: () => edit.setSequenceInOut('in', tOf(x)) },
        { label: 'Mark Out Here', action: () => edit.setSequenceInOut('out', tOf(x)) },
        { label: 'Clear In and Out', action: () => store.transact('Clear In/Out', () => { s.inPoint = null; s.outPoint = null; }) },
      ], e.clientX, e.clientY);
    }
  }

  function scaleToFill(clips) {
    const s = store.seq;
    store.transact('Scale to Fill Frame', () => {
      for (const c of clips) {
        const m = store.project.media[c.mediaId];
        const motion = c.effects.find((e) => e.type === 'motion');
        if (!m?.width || !motion) continue;
        const fit = Math.min(s.width / m.width, s.height / m.height);
        const fill = Math.max(s.width / m.width, s.height / m.height);
        motion.params.scale.value = Math.round((fill / fit) * 1000) / 10;
        motion.params.scale.kf = null;
      }
    });
  }

  // ---------------------------------------------------------------- wheel

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x } = localPos(e);
    if (e.altKey || e.ctrlKey || e.metaKey) {
      setZoom(view.pps * Math.pow(1.0015, -e.deltaY), x);
    } else if (e.shiftKey) {
      setScrollY(view.scrollY + e.deltaY);
    } else {
      // like Premiere: the wheel scrolls time; Shift+wheel scrolls tracks
      setScrollX(view.scrollX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
    }
  }, { passive: false });
  headers.addEventListener('wheel', (e) => {
    e.preventDefault();
    setScrollY(view.scrollY + e.deltaY);
  }, { passive: false });

  // ---------------------------------------------------------------- drag & drop

  function dropKindsFor(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('application/x-montage-media')) return 'media';
    if (types.includes('application/x-montage-effect')) return 'effect';
    if (types.includes('Files')) return 'files';
    return null;
  }

  function mediaPlacement(payload, x, y, insert) {
    const s = store.seq;
    const m = store.project.media[payload.mediaId];
    if (!m) return null;
    const row = rowAtY(y);
    const inP = payload.inPoint ?? m.inPoint ?? 0;
    const outP = payload.outPoint ?? m.outPoint ?? (m.duration ?? inP + 5);
    const duration = Math.max(1 / s.fps, outP - inP);
    let start = Math.max(0, snapFrame(tOf(x), s.fps));
    const sd = snapDelta([start, start + duration], snapCandidates());
    start = Math.max(0, start + sd.delta);
    const vts = videoTracks(s);
    const ats = audioTracks(s);
    let vIdx = 0;
    let aIdx = 0;
    if (row) {
      if (row.track.kind === 'video') vIdx = aIdx = vts.indexOf(row.track);
      else vIdx = aIdx = ats.indexOf(row.track);
    }
    const wantV = payload.video !== false && m.kind !== 'audio';
    const wantA = payload.audio !== false && (m.kind === 'audio' || (m.kind === 'video' && m.hasAudio));
    const vTrack = wantV ? vts[Math.min(vIdx, vts.length - 1)] : null;
    const aTrack = wantA ? ats[Math.min(aIdx, ats.length - 1)] : null;
    const ghosts = [];
    if (vTrack) ghosts.push({ trackId: vTrack.id, start, duration });
    if (aTrack) ghosts.push({ trackId: aTrack.id, start, duration });
    return { start, duration, vTrack, aTrack, ghosts, insert, inPoint: inP, outPoint: outP, snapAt: sd.at };
  }

  wrap.addEventListener('dragover', (e) => {
    const kind = dropKindsFor(e);
    if (!kind) return;
    e.preventDefault();
    const { x, y } = localPos(e);
    if (kind === 'media') {
      const first = dnd.payload?.items?.[0];
      if (first) {
        dropPreview = mediaPlacement(first, x, y, modKey(e));
        if (dropPreview && dnd.payload.items.length > 1) {
          const total = dnd.payload.items.reduce((acc, it) => acc + (mediaPlacement(it, x, y, false)?.duration || 0), 0);
          for (const g of dropPreview.ghosts) g.duration = total;
        }
        e.dataTransfer.dropEffect = 'copy';
      }
    } else if (kind === 'effect') {
      const hit = hitTest(x, y);
      e.dataTransfer.dropEffect = hit.area === 'clip' ? 'copy' : 'none';
      dropPreview = null;
      if (hit.area === 'clip') store.selectClips([hit.clip.id]);
    } else {
      e.dataTransfer.dropEffect = 'copy';
      dropPreview = { ghosts: [], start: tOf(x) };
    }
    requestDraw();
  });
  wrap.addEventListener('dragleave', () => {
    dropPreview = null;
    requestDraw();
  });
  wrap.addEventListener('drop', async (e) => {
    const kind = dropKindsFor(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = localPos(e);
    dropPreview = null;
    if (kind === 'media') {
      let payload = dnd.payload;
      try { payload = JSON.parse(e.dataTransfer.getData('application/x-montage-media')) || payload; } catch { /* use shared payload */ }
      const list = payload?.items || [];
      let px = x;
      for (const item of list) {
        const pl = mediaPlacement(item, px, y, modKey(e));
        if (!pl) continue;
        edit.placeMedia(item.mediaId, {
          mode: modKey(e) ? 'insert' : 'overwrite', start: pl.start, vTrackId: pl.vTrack?.id, aTrackId: pl.aTrack?.id,
          inPoint: pl.inPoint, outPoint: pl.outPoint, video: item.video, audio: item.audio,
        });
        px = xOf(pl.start + pl.duration);
      }
      canvas.focus();
      store.setFocus('timeline');
    } else if (kind === 'effect') {
      let payload = null;
      try { payload = JSON.parse(e.dataTransfer.getData('application/x-montage-effect')); } catch { /* ignore */ }
      const hit = hitTest(x, y);
      if (!payload || hit.area !== 'clip') return;
      if (payload.transition) {
        const c = hit.clip;
        const rel = (hit.t - c.start) / c.duration;
        edit.applyTransition(c.id, rel < 0.5 ? 'in' : 'out', payload.type, 1);
      } else {
        const ids = store.selection.clips.has(hit.clip.id) ? [...store.selection.clips] : [hit.clip.id];
        edit.addEffect(ids, payload.type);
        store.selectClips([hit.clip.id]);
        store.emit('reveal-effect-controls');
      }
    } else if (kind === 'files') {
      const files = [...e.dataTransfer.files];
      const ids = await importFiles(files);
      let t = Math.max(0, snapFrame(tOf(x), fps()));
      for (const id of ids) {
        if (mediaStatus(id) !== 'ready') continue;
        const pl = mediaPlacement({ mediaId: id }, xOf(t), y, false);
        if (!pl) continue;
        edit.placeMedia(id, { mode: 'overwrite', start: t, vTrackId: pl.vTrack?.id, aTrackId: pl.aTrack?.id });
        t += pl.duration;
      }
    }
    dnd.payload = null;
    invalidate();
  });

  // ---------------------------------------------------------------- subscriptions

  function fullRefresh() {
    renderSeqTabs();
    layoutRows();
    renderHeaders();
    refreshTopBar();
    syncScrollbars();
    invalidate();
  }

  store.on('change', fullRefresh);
  store.on('selection', invalidate);
  store.on('tool', () => updateHover(-100, -100, {}));
  mediaEvents.on('updated', invalidate);
  store.on('playhead', () => {
    tcEl.textContent = formatTimecode(store.ui.playhead, fps());
    // page-scroll during playback
    const px = xOf(store.ui.playhead);
    if (playback.playing && (px > view.width - 10 || px < 0)) setScrollX(store.ui.playhead * view.pps - 10);
    requestDraw();
  });
  window.addEventListener('resize', () => {
    invalidate();
  });
  new ResizeObserver(() => invalidate()).observe(wrap);

  Object.assign(timelineApi, {
    zoomIn: () => setZoom(view.pps * 1.5, xOf(store.ui.playhead) >= 0 && xOf(store.ui.playhead) <= view.width ? xOf(store.ui.playhead) : view.width / 2),
    zoomOut: () => setZoom(view.pps / 1.5, xOf(store.ui.playhead) >= 0 && xOf(store.ui.playhead) <= view.width ? xOf(store.ui.playhead) : view.width / 2),
    zoomToFit,
    toggleSnap,
    focus: () => canvas.focus(),
    revealPlayhead: () => {
      const px = xOf(store.ui.playhead);
      if (px < 0 || px > view.width) setScrollX(store.ui.playhead * view.pps - view.width / 2);
    },
    view,
  });

  fullRefresh();
  return root;
}
