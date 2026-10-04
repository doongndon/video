// Program monitor: renders the sequence through the compositor, transport controls, safe margins
// and direct manipulation (move / scale / rotate) of the selected clip; Type tool creates text.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { Compositor } from '../compositor.js';
import * as edit from '../edit.js';
import { clipEnd, clipsOnTrack, videoTracks, sequenceDuration, evalEffect } from '../model.js';
import { h, clamp, formatTimecode, parseTimecode, downloadBlob } from '../util.js';
import { fitRect, fitCanvasToBox, loadPref, savePref, toast, dnd, inlineEdit } from './common.js';
import { exportFrame } from '../export.js';

export const programApi = {};

export function createProgramMonitor() {
  const view = h('div.monitor-view');
  const frame = h('canvas.frame');
  const overlay = h('canvas.overlay');
  view.append(frame, overlay);
  const compositor = new Compositor({ onAsyncReady: () => playback.requestRender() });

  let resolution = loadPref('program.res', 'auto');
  let zoom = loadPref('program.zoom', 'fit');
  let safe = loadPref('program.safe', false);
  let fr = { x: 0, y: 0, w: 1, h: 1, s: 1 };
  let handleDrag = null;

  const tcEl = h('span.tc', '00:00:00:00');
  const durEl = h('span.tc.dur', '');
  const scrub = h('canvas');
  const scrubBar = h('div.monitor-scrub', scrub);
  const btn = (label, title, fn) => h('button', { title, onclick: fn }, label);
  const playBtn = btn('▶', 'Play/Stop (Space)', () => playback.toggle());
  const loopBtn = btn('⟲', 'Loop (Ctrl+Shift+L)', () => { playback.loop = !playback.loop; refresh(); });
  const safeBtn = btn('⊞', 'Safe Margins', () => { safe = !safe; savePref('program.safe', safe); playback.requestRender(); refresh(); });
  const resSel = h('select', { title: 'Playback Resolution' },
    [['auto', 'Auto'], ['1', 'Full'], ['0.5', '1/2'], ['0.25', '1/4']].map(([v, l]) => h('option', { value: v, selected: v === String(resolution) }, l)));
  const zoomSel = h('select', { title: 'Zoom' },
    [['fit', 'Fit'], ['0.25', '25%'], ['0.5', '50%'], ['1', '100%'], ['2', '200%']].map(([v, l]) => h('option', { value: v, selected: v === String(zoom) }, l)));
  resSel.addEventListener('change', () => { resolution = resSel.value; savePref('program.res', resolution); layout(); });
  zoomSel.addEventListener('change', () => { zoom = zoomSel.value; savePref('program.zoom', zoom); layout(); });

  const transport = h('div.transport',
    tcEl, zoomSel, resSel,
    h('span.grow'),
    btn('{', 'Mark In (I)', () => edit.setSequenceInOut('in', store.ui.playhead)),
    btn('}', 'Mark Out (O)', () => edit.setSequenceInOut('out', store.ui.playhead)),
    btn('◆', 'Add Marker (M)', () => edit.addMarker()),
    btn('⇤', 'Go to In (Shift+I)', () => store.setPlayhead(store.seq.inPoint ?? 0)),
    btn('◀|', 'Step Back (←)', () => playback.step(-1)),
    playBtn,
    btn('|▶', 'Step Forward (→)', () => playback.step(1)),
    btn('⇥', 'Go to Out (Shift+O)', () => store.setPlayhead(store.seq.outPoint ?? sequenceDuration(store.seq))),
    btn('⏏', 'Lift (;)', () => edit.liftExtract(false)),
    btn('⏏⏏', 'Extract (\')', () => edit.liftExtract(true)),
    btn('📷', 'Export Frame', () => saveFrame()),
    loopBtn, safeBtn,
    h('span.grow'),
    durEl);
  const root = h('div.monitor', view, scrubBar, transport);

  async function saveFrame() {
    const blob = await exportFrame();
    const name = `${store.seq.name || 'frame'}_${formatTimecode(store.ui.playhead, store.seq.fps).replace(/:/g, '-')}.png`;
    downloadBlob(blob, name);
    toast(`Saved ${name}`);
  }

  function renderScale() {
    const s = store.seq;
    if (resolution === 'auto') {
      const dpr = window.devicePixelRatio || 1;
      return clamp((fr.w * dpr) / s.width, 0.1, 1);
    }
    return parseFloat(resolution);
  }

  function layout() {
    const s = store.seq;
    const r = view.getBoundingClientRect();
    fr = fitRect(r.width, r.height, s.width, s.height, zoom === 'fit' ? 0 : parseFloat(zoom));
    Object.assign(frame.style, { left: `${fr.x}px`, top: `${fr.y}px`, width: `${fr.w}px`, height: `${fr.h}px` });
    playback.requestRender();
  }

  function draw() {
    const s = store.seq;
    const sc = renderScale();
    const w = Math.max(2, Math.round(s.width * sc));
    const hh = Math.max(2, Math.round(s.height * sc));
    if (frame.width !== w || frame.height !== hh) {
      frame.width = w;
      frame.height = hh;
    }
    const ctx = frame.getContext('2d');
    compositor.render(ctx, s, store.ui.playhead, playback.provider, { scale: w / s.width });
    drawOverlay();
    refresh();
  }

  function seqToScreen([x, y]) {
    return [fr.x + x * fr.s, fr.y + y * fr.s];
  }

  function screenToSeq(x, y) {
    return [(x - fr.x) / fr.s, (y - fr.y) / fr.s];
  }

  /** The single selected visual clip under the playhead, if any. */
  function activeClip() {
    const sel = store.selectedClips().filter((c) => c.kind !== 'audio' && c.kind !== 'adjustment');
    if (sel.length !== 1) return null;
    const c = sel[0];
    const t = store.ui.playhead;
    if (t < c.start || t >= clipEnd(c)) return null;
    return c;
  }

  function quadFor(c) {
    return compositor.clipQuad(store.seq, c, store.ui.playhead, playback.provider);
  }

  function drawOverlay() {
    const { ctx, w, h: hh } = fitCanvasToBox(overlay);
    ctx.clearRect(0, 0, w, hh);
    const s = store.seq;
    if (safe) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      for (const k of [0.9, 0.8]) {
        const mw = fr.w * k;
        const mh = fr.h * k;
        ctx.strokeRect(fr.x + (fr.w - mw) / 2 + 0.5, fr.y + (fr.h - mh) / 2 + 0.5, mw, mh);
      }
      const [cx, cy] = seqToScreen([s.width / 2, s.height / 2]);
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy);
      ctx.lineTo(cx + 10, cy);
      ctx.moveTo(cx, cy - 10);
      ctx.lineTo(cx, cy + 10);
      ctx.stroke();
    }
    if (playback.playing) return;
    const c = activeClip();
    if (!c) return;
    const quad = quadFor(c);
    if (!quad) return;
    const pts = quad.map(seqToScreen);
    ctx.strokeStyle = '#4aa3ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of pts) ctx.fillRect(x - 4, y - 4, 8, 8);
    const rot = rotationHandle(pts);
    ctx.beginPath();
    ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
    ctx.lineTo(rot[0], rot[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rot[0], rot[1], 5, 0, Math.PI * 2);
    ctx.fill();
    // anchor (centre)
    const motion = c.effects.find((e) => e.type === 'motion');
    if (motion) {
      const m = evalEffect(motion, store.ui.playhead - c.start);
      const [ax, ay] = seqToScreen([m.posX, m.posY]);
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ax, ay, 6, 0, Math.PI * 2);
      ctx.moveTo(ax - 9, ay);
      ctx.lineTo(ax + 9, ay);
      ctx.moveTo(ax, ay - 9);
      ctx.lineTo(ax, ay + 9);
      ctx.stroke();
    }
  }

  function rotationHandle(pts) {
    const mx = (pts[0][0] + pts[1][0]) / 2;
    const my = (pts[0][1] + pts[1][1]) / 2;
    const cx = (pts[0][0] + pts[2][0]) / 2;
    const cy = (pts[0][1] + pts[2][1]) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [mx + (dx / len) * 24, my + (dy / len) * 24];
  }

  function pointInQuad(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Topmost visible clip whose bounds contain the point. */
  function clipAtPoint(px, py) {
    const s = store.seq;
    const t = store.ui.playhead;
    const tracks = videoTracks(s).filter((tr) => !tr.hidden).reverse();
    for (const tr of tracks) {
      const c = clipsOnTrack(s, tr.id).find((x) => t >= x.start && t < clipEnd(x) && x.enabled !== false && x.kind !== 'adjustment');
      if (!c) continue;
      const q = quadFor(c);
      if (q && pointInQuad(px, py, q.map(seqToScreen))) return c;
    }
    return null;
  }

  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    store.setFocus('program');
    if (store.ui.tool === 'type') {
      const [sx, sy] = screenToSeq(px, py);
      edit.addTextClip({ x: sx, y: sy });
      store.setTool('select');
      store.emit('reveal-effect-controls', { focusText: true });
      return;
    }
    playback.stop();
    let c = activeClip();
    let pts = c && quadFor(c)?.map(seqToScreen);
    let mode = null;
    if (pts) {
      const rot = rotationHandle(pts);
      if (Math.hypot(px - rot[0], py - rot[1]) < 8) mode = 'rotate';
      else if (pts.some(([x, y]) => Math.abs(px - x) < 7 && Math.abs(py - y) < 7)) mode = 'scale';
      else if (pointInQuad(px, py, pts)) mode = 'move';
    }
    if (!mode) {
      const hit = clipAtPoint(px, py);
      if (hit) {
        store.selectClips([...edit.withLinked([hit.id])]);
        c = hit;
        pts = quadFor(c)?.map(seqToScreen);
        mode = 'move';
      } else {
        store.clearSelection();
        return;
      }
    }
    const motion = c.effects.find((fx) => fx.type === 'motion');
    if (!motion || !pts) return;
    const m = evalEffect(motion, store.ui.playhead - c.start);
    const [cx, cy] = seqToScreen([m.posX, m.posY]);
    view.setPointerCapture(e.pointerId);
    store.begin(mode === 'move' ? 'Move (Motion)' : mode === 'scale' ? 'Scale (Motion)' : 'Rotate (Motion)');
    handleDrag = {
      mode, clipId: c.id, fxId: motion.id, x0: px, y0: py, m0: m, cx, cy,
      d0: Math.hypot(px - cx, py - cy) || 1, a0: Math.atan2(py - cy, px - cx),
    };
  });

  view.addEventListener('pointermove', (e) => {
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (!handleDrag) {
      updateCursor(px, py);
      return;
    }
    const d = handleDrag;
    const s = store.seq;
    const c = s.clips[d.clipId];
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    if (d.mode === 'move') {
      let nx = d.m0.posX + (px - d.x0) / fr.s;
      let ny = d.m0.posY + (py - d.y0) / fr.s;
      if (!e.shiftKey) {
        if (Math.abs(nx - s.width / 2) * fr.s < 6) nx = s.width / 2;
        if (Math.abs(ny - s.height / 2) * fr.s < 6) ny = s.height / 2;
      }
      edit.rawSetParam(c, fx, 'posX', Math.round(nx * 10) / 10);
      edit.rawSetParam(c, fx, 'posY', Math.round(ny * 10) / 10);
    } else if (d.mode === 'scale') {
      const dist = Math.hypot(px - d.cx, py - d.cy);
      edit.rawSetParam(c, fx, 'scale', Math.round(clamp((d.m0.scale * dist) / d.d0, 0, 2000) * 10) / 10);
    } else {
      let a = d.m0.rotation + ((Math.atan2(py - d.cy, px - d.cx) - d.a0) * 180) / Math.PI;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      edit.rawSetParam(c, fx, 'rotation', Math.round(a * 10) / 10);
    }
    store.changed();
  });

  const endDrag = () => {
    if (!handleDrag) return;
    handleDrag = null;
    store.commit();
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('dblclick', (e) => {
    const r = view.getBoundingClientRect();
    const c = clipAtPoint(e.clientX - r.left, e.clientY - r.top);
    if (c) {
      store.selectClips([c.id]);
      store.emit('reveal-effect-controls', { focusText: c.kind === 'text' });
    }
  });

  function updateCursor(px, py) {
    if (store.ui.tool === 'type') {
      view.style.cursor = 'text';
      return;
    }
    const c = activeClip();
    const pts = c && !playback.playing ? quadFor(c)?.map(seqToScreen) : null;
    let cur = 'default';
    if (pts) {
      const rot = rotationHandle(pts);
      if (Math.hypot(px - rot[0], py - rot[1]) < 8) cur = 'grab';
      else if (pts.some(([x, y]) => Math.abs(px - x) < 7 && Math.abs(py - y) < 7)) cur = 'nwse-resize';
      else if (pointInQuad(px, py, pts)) cur = 'move';
    }
    view.style.cursor = cur;
  }

  // drop media onto the program monitor = overwrite at playhead on the first free video track
  view.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('application/x-montage-media')) e.preventDefault();
  });
  view.addEventListener('drop', (e) => {
    const items = dnd.payload?.items;
    if (!items?.length) return;
    e.preventDefault();
    for (const it of items) edit.placeMedia(it.mediaId, { mode: 'overwrite', video: it.video, audio: it.audio });
    dnd.payload = null;
  });

  // ---- mini scrubber
  function drawScrub() {
    const { ctx, w, h: hh } = fitCanvasToBox(scrub);
    const s = store.seq;
    const d = Math.max(1, sequenceDuration(s));
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, hh / 2 - 2, w, 4);
    if (s.inPoint != null || s.outPoint != null) {
      const a = ((s.inPoint ?? 0) / d) * w;
      const b = ((s.outPoint ?? d) / d) * w;
      ctx.fillStyle = 'rgba(90,150,240,0.6)';
      ctx.fillRect(a, 2, b - a, hh - 4);
    }
    for (const mk of s.markers) {
      ctx.fillStyle = mk.color;
      ctx.fillRect((mk.time / d) * w - 1, 0, 2, 6);
    }
    ctx.fillStyle = '#4aa3ff';
    ctx.fillRect(Math.min(w - 2, (store.ui.playhead / d) * w) - 1, 0, 2, hh);
  }
  scrubBar.addEventListener('pointerdown', (e) => {
    scrubBar.setPointerCapture(e.pointerId);
    playback.stop();
    const go = (ev) => {
      const r = scrubBar.getBoundingClientRect();
      const d = Math.max(1, sequenceDuration(store.seq));
      store.setPlayhead(clamp((ev.clientX - r.left) / r.width, 0, 1) * d);
    };
    go(e);
    const up = () => {
      scrubBar.removeEventListener('pointermove', go);
      scrubBar.removeEventListener('pointerup', up);
    };
    scrubBar.addEventListener('pointermove', go);
    scrubBar.addEventListener('pointerup', up);
  });

  tcEl.addEventListener('click', () => {
    inlineEdit(tcEl, {
      onCommit: (v) => {
        const t = parseTimecode(v, store.seq.fps);
        if (t != null) store.setPlayhead(t);
      },
    });
  });

  function refresh() {
    const s = store.seq;
    tcEl.textContent = formatTimecode(store.ui.playhead, s.fps);
    const io = s.inPoint != null || s.outPoint != null;
    const d = io ? (s.outPoint ?? sequenceDuration(s)) - (s.inPoint ?? 0) : sequenceDuration(s);
    durEl.textContent = formatTimecode(Math.max(0, d), s.fps);
    durEl.title = io ? 'In/Out duration' : 'Sequence duration';
    playBtn.textContent = playback.playing ? '■' : '▶';
    loopBtn.classList.toggle('on', playback.loop);
    loopBtn.style.color = playback.loop ? 'var(--value)' : '';
    safeBtn.style.color = safe ? 'var(--value)' : '';
    drawScrub();
  }

  playback.addRenderer(draw);
  playback.on('state', refresh);
  store.on('selection', () => playback.requestRender());
  store.on('tool', () => { view.classList.toggle('type-tool', store.ui.tool === 'type'); });
  new ResizeObserver(layout).observe(view);

  Object.assign(programApi, { canvas: frame, saveFrame, layout });
  return root;
}
