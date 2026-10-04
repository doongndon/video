// Program monitor: renders the sequence through the compositor, transport controls, safe margins,
// direct manipulation (move / scale / rotate) of the selected clip, on-screen editing of masks
// (ellipse / rectangle / polygon points) and the Type tool.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { Compositor } from '../compositor.js';
import * as edit from '../edit.js';
import { clipEnd, clipsOnTrack, videoTracks, sequenceDuration, evalEffect } from '../model.js';
import { h, clamp, formatTimecode, parseTimecode, downloadBlob } from '../util.js';
import { fitRect, fitCanvasToBox, loadPref, savePref, toast, dnd, inlineEdit } from './common.js';
import { icon, iconButton } from './icons.js';
import { exportFrame } from '../export.js';
import { motionPath, rawSetPathKey, setAutoKey } from '../motionkeys.js';

export const programApi = {};

const MASK_TYPES = new Set(['mask', 'censor']);
let HANDLE = 7; // handle hit radius in px (bigger for fingers)

export function createProgramMonitor() {
  const view = h('div.monitor-view');
  const frame = h('canvas.frame');
  const overlay = h('canvas.overlay');
  const empty = h('div.monitor-empty', '타임라인에 클립을 놓으면 여기에 결과 화면이 나옵니다.\n클립을 선택하면 화면에서 직접 옮기고 크기·회전을 바꿀 수 있습니다.');
  const recBadge = h('button.pm-rec', { title: '키프레임 기록 끄기', onclick: () => setAutoKey(false) }, '● 키프레임 기록 중');
  view.append(frame, overlay, empty, recBadge);
  const compositor = new Compositor({ onAsyncReady: () => playback.requestRender() });

  let resolution = loadPref('program.res', 'auto');
  let zoom = loadPref('program.zoom', 'fit');
  let safe = loadPref('program.safe', false);
  let fr = { x: 0, y: 0, w: 1, h: 1, s: 1 };
  let handleDrag = null;

  const tcEl = h('span.tc', { title: '클릭해서 시간 입력' }, '00:00:00:00');
  const durEl = h('span.tc.dur', '');
  const scrub = h('canvas');
  const scrubBar = h('div.monitor-scrub', { title: '끌어서 이동' }, scrub);
  const playBtn = iconButton('play', '재생 / 정지 (Space)', () => playback.toggle(), { cls: 'play' });
  const loopBtn = iconButton('loop', '반복 재생 (Ctrl+Shift+L)', () => { playback.loop = !playback.loop; playback.emit('state'); });
  const keyBtn = iconButton('key', '키프레임 기록: 켜면 화면에서 옮기거나 크기·회전을 바꿀 때마다 재생헤드 위치에 키프레임이 생깁니다', () => setAutoKey(!store.ui.autoKey), { cls: 'autokey' });
  const safeBtn = iconButton('safe', '안전 영역 표시 (TV 가장자리 잘림 확인)', () => { safe = !safe; savePref('program.safe', safe); playback.requestRender(); refresh(); });
  const resSel = h('select', { title: '재생 화질 (낮추면 빨라짐)', 'aria-label': '재생 화질' },
    [['auto', '화질 자동'], ['1', '화질 전체'], ['0.5', '화질 1/2'], ['0.25', '화질 1/4']].map(([v, l]) => h('option', { value: v, selected: v === String(resolution) }, l)));
  const zoomSel = h('select', { title: '보기 배율', 'aria-label': '보기 배율' },
    [['fit', '화면 맞춤'], ['0.25', '25%'], ['0.5', '50%'], ['1', '100%'], ['2', '200%']].map(([v, l]) => h('option', { value: v, selected: v === String(zoom) }, l)));
  resSel.addEventListener('change', () => { resolution = resSel.value; savePref('program.res', resolution); layout(); });
  zoomSel.addEventListener('change', () => { zoom = zoomSel.value; savePref('program.zoom', zoom); layout(); });

  const transport = h('div.transport',
    tcEl, zoomSel, resSel,
    h('span.grow'),
    iconButton('markIn', '시작 표시 (I)', () => edit.setSequenceInOut('in', store.ui.playhead)),
    iconButton('markOut', '끝 표시 (O)', () => edit.setSequenceInOut('out', store.ui.playhead)),
    iconButton('marker', '마커 추가 (M)', () => edit.addMarker()),
    iconButton('goIn', '시작 표시로 이동 (Shift+I)', () => { playback.stop(); store.setPlayhead(store.seq.inPoint ?? 0); }),
    iconButton('stepBack', '1프레임 뒤로 (←)', () => playback.step(-1)),
    playBtn,
    iconButton('stepForward', '1프레임 앞으로 (→)', () => playback.step(1)),
    iconButton('goOut', '끝 표시로 이동 (Shift+O)', () => { playback.stop(); store.setPlayhead(store.seq.outPoint ?? sequenceDuration(store.seq)); }),
    keyBtn,
    h('span.sep'),
    iconButton('lift', '들어내기: 시작~끝 구간을 지우고 빈자리 남김 (;)', () => edit.liftExtract(false)),
    iconButton('extract', '추출: 시작~끝 구간을 지우고 당기기 (\')', () => edit.liftExtract(true)),
    iconButton('camera', '현재 프레임 저장 (PNG)', () => saveFrame()),
    loopBtn, safeBtn,
    h('span.grow'),
    durEl);
  const root = h('div.monitor', view, scrubBar, transport);

  async function saveFrame() {
    const blob = await exportFrame();
    const name = `${store.seq.name || 'frame'}_${formatTimecode(store.ui.playhead, store.seq.fps).replace(/:/g, '-')}.png`;
    if (await downloadBlob(blob, name)) toast(`${name} 저장`);
  }

  function renderScale() {
    const s = store.seq;
    if (resolution === 'auto') {
      const dpr = window.devicePixelRatio || 1;
      return clamp((fr.w * dpr) / s.width, 0.1, 1);
    }
    return parseFloat(resolution);
  }

  let laidFor = '';
  function layout() {
    const s = store.seq;
    laidFor = `${s.width}x${s.height}`;
    const r = view.getBoundingClientRect();
    fr = fitRect(r.width, r.height, s.width, s.height, zoom === 'fit' ? 0 : parseFloat(zoom));
    Object.assign(frame.style, { left: `${fr.x}px`, top: `${fr.y}px`, width: `${fr.w}px`, height: `${fr.h}px` });
    playback.requestRender();
  }

  function draw() {
    const s = store.seq;
    // the sequence size can change (settings, aspect presets, switching sequences) without a resize
    if (laidFor !== `${s.width}x${s.height}`) layout();
    const sc = renderScale();
    const w = Math.max(2, Math.round(s.width * sc));
    const hh = Math.max(2, Math.round(s.height * sc));
    if (frame.width !== w || frame.height !== hh) {
      frame.width = w;
      frame.height = hh;
    }
    const ctx = frame.getContext('2d');
    compositor.render(ctx, s, store.ui.playhead, playback.provider, { scale: w / s.width });
    empty.hidden = Object.keys(s.clips).length > 0;
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

  // ---- mask geometry (mask values are percentages of the clip's source frame)

  function maskTarget() {
    const c = activeClip();
    if (!c || playback.playing) return null;
    const fx = c.effects.find((e) => e.id === store.ui.maskFxId && MASK_TYPES.has(e.type) && e.enabled);
    if (!fx) return null;
    const quad = quadFor(c);
    if (!quad) return null;
    const v = evalEffect(fx, store.ui.playhead - c.start);
    const q0 = quad[0];
    const ax = [quad[1][0] - q0[0], quad[1][1] - q0[1]];
    const bx = [quad[3][0] - q0[0], quad[3][1] - q0[1]];
    const la = Math.hypot(...ax) || 1;
    const lb = Math.hypot(...bx) || 1;
    const P = (u, w) => [q0[0] + ax[0] * u + bx[0] * w, q0[1] + ax[1] * u + bx[1] * w];
    const det = ax[0] * bx[1] - ax[1] * bx[0] || 1e-9;
    const inv = ([x, y]) => {
      const dx = x - q0[0];
      const dy = y - q0[1];
      return [(dx * bx[1] - dy * bx[0]) / det, (ax[0] * dy - ax[1] * dx) / det];
    };
    const polygon = fx.type === 'mask' && v.shape === 'polygon';
    const geo = { c, fx, v, P, inv, la, lb, polygon };
    if (!polygon) {
      const rot = ((v.rotation || 0) * Math.PI) / 180;
      const ex = [ax[0] / la, ax[1] / la];
      const ey = [bx[0] / lb, bx[1] / lb];
      geo.ux = [ex[0] * Math.cos(rot) + ey[0] * Math.sin(rot), ex[1] * Math.cos(rot) + ey[1] * Math.sin(rot)];
      geo.uy = [-ex[0] * Math.sin(rot) + ey[0] * Math.cos(rot), -ex[1] * Math.sin(rot) + ey[1] * Math.cos(rot)];
      geo.C = P(v.cx / 100, v.cy / 100);
      geo.rx = (v.w / 200) * la;
      geo.ry = (v.h / 200) * lb;
      geo.local = (lx, ly) => [geo.C[0] + geo.ux[0] * lx + geo.uy[0] * ly, geo.C[1] + geo.ux[1] * lx + geo.uy[1] * ly];
    }
    return geo;
  }

  function maskHandles(g) {
    if (g.polygon) {
      const pts = (g.v.points || []).map(([px, py]) => seqToScreen(g.P(px / 100, py / 100)));
      const cen = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
      return { pts, center: cen };
    }
    return {
      center: seqToScreen(g.C),
      e: seqToScreen(g.local(g.rx, 0)),
      s: seqToScreen(g.local(0, g.ry)),
      se: seqToScreen(g.local(g.rx, g.ry)),
      rot: g.fx.type === 'mask' ? seqToScreen(g.local(0, -g.ry - 26 / fr.s)) : null,
    };
  }

  function drawMask(ctx, g) {
    const H = maskHandles(g);
    ctx.save();
    ctx.strokeStyle = '#ffd84d';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (g.polygon) {
      H.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    } else if (g.v.shape === 'rectangle') {
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
        const [x, y] = seqToScreen(g.local(sx * g.rx, sy * g.ry));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    } else {
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const [x, y] = seqToScreen(g.local(Math.cos(a) * g.rx, Math.sin(a) * g.ry));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd84d';
    ctx.strokeStyle = '#000';
    const square = ([x, y]) => {
      ctx.fillRect(x - 5, y - 5, 10, 10);
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    };
    if (g.polygon) H.pts.forEach(square);
    else {
      [H.e, H.s, H.se].forEach(square);
    }
    if (!g.polygon && H.rot) {
      ctx.beginPath();
      ctx.moveTo(...seqToScreen(g.local(0, -g.ry)));
      ctx.lineTo(...H.rot);
      ctx.strokeStyle = '#ffd84d';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(H.rot[0], H.rot[1], 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(H.center[0], H.center[1], 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,216,77,0.35)';
    ctx.fill();
    ctx.strokeStyle = '#ffd84d';
    ctx.stroke();
    ctx.restore();
  }

  /** What mask handle (if any) is under a screen point. */
  function maskHit(g, px, py) {
    const H = maskHandles(g);
    const near = (p) => p && Math.abs(px - p[0]) <= HANDLE && Math.abs(py - p[1]) <= HANDLE;
    if (g.polygon) {
      const i = H.pts.findIndex(near);
      if (i >= 0) return { mode: 'point', index: i };
    } else {
      if (H.rot && Math.hypot(px - H.rot[0], py - H.rot[1]) <= HANDLE) return { mode: 'mrot' };
      if (near(H.se)) return { mode: 'size', axes: 'xy' };
      if (near(H.e)) return { mode: 'size', axes: 'x' };
      if (near(H.s)) return { mode: 'size', axes: 'y' };
    }
    if (Math.hypot(px - H.center[0], py - H.center[1]) <= HANDLE + 2) return { mode: 'mmove' };
    return null;
  }

  // ---- overlay

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
    drawMotionPath(ctx, c);
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
    const g = maskTarget();
    if (g) drawMask(ctx, g);
  }

  // recording off but the object already moves: its whole motion was shifted (say so once per drag)
  let shiftNoted = false;
  function noteShift(r) {
    if (r !== 'shifted' || shiftNoted) return;
    shiftNoted = true;
    toast('키프레임 기록이 꺼져 있어 새 키프레임 없이 움직임 전체를 함께 옮겼습니다. 이 위치에 키프레임을 만들려면 ◆ 기록을 켜세요.');
  }

  /** Dashed path of the clip's position over time, with ◆ at its keyframes (the current one bigger). */
  function drawMotionPath(ctx, c) {
    const path = motionPath(c);
    if (!path) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 214, 102, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    path.pts.forEach((p, i) => {
      const [x, y] = seqToScreen(p);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    const tNow = store.ui.playhead - c.start;
    for (const k of path.keys) {
      const [x, y] = seqToScreen([k.x, k.y]);
      const now = Math.abs(k.t - tNow) < 0.5 / store.seq.fps;
      const r = now ? 8 : 6;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = now ? '#ffd666' : '#ffffff';
      ctx.strokeStyle = '#1b1d22';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The ◆ of the selected clip's motion path under the pointer. On the object itself, grabbing it
   * moves the object at the current time (that is how new keyframes are made), so there only the
   * current time's own ◆ counts.
   */
  function pathKeyAt(c, px, py) {
    const path = c && !playback.playing ? motionPath(c) : null;
    if (!path) return null;
    const quad = quadFor(c)?.map(seqToScreen);
    const onBody = quad && pointInQuad(px, py, quad);
    const tNow = store.ui.playhead - c.start;
    return path.keys.find((k) => {
      const [x, y] = seqToScreen([k.x, k.y]);
      if (Math.hypot(px - x, py - y) > HANDLE + 2) return false;
      return !onBody || Math.abs(k.t - tNow) < 0.5 / store.seq.fps;
    }) || null;
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

  /** Visible clips whose bounds contain the point, topmost first. */
  function clipsAtPoint(px, py) {
    const s = store.seq;
    const t = store.ui.playhead;
    const out = [];
    for (const tr of videoTracks(s).filter((x) => !x.hidden).reverse()) {
      const c = clipsOnTrack(s, tr.id).find((x) => t >= x.start && t < clipEnd(x) && x.enabled !== false && x.kind !== 'adjustment');
      if (!c) continue;
      const q = quadFor(c);
      if (q && pointInQuad(px, py, q.map(seqToScreen))) out.push(c);
    }
    return out;
  }

  const clipAtPoint = (px, py) => clipsAtPoint(px, py)[0] || null;

  /** Ctrl+click on a polygon mask: insert a point on the nearest edge. */
  function insertPolygonPoint(g, px, py) {
    const [u, w] = g.inv(screenToSeq(px, py));
    const pts = g.v.points;
    let best = 0;
    let bd = Infinity;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const [ax, ay] = [p[0] / 100, p[1] / 100];
      const [bx, by] = [q[0] / 100, q[1] / 100];
      const L = (bx - ax) ** 2 + (by - ay) ** 2 || 1e-9;
      const tt = clamp(((u - ax) * (bx - ax) + (w - ay) * (by - ay)) / L, 0, 1);
      const d = Math.hypot(u - (ax + (bx - ax) * tt), w - (ay + (by - ay) * tt));
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    store.transact('마스크 점 추가', () => {
      const f = store.seq.clips[g.c.id]?.effects.find((e) => e.id === g.fx.id);
      if (f) f.params.points.value.splice(best + 1, 0, [Math.round(u * 1000) / 10, Math.round(w * 1000) / 10]);
    });
  }

  const touches = new Map();
  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    HANDLE = e.pointerType === 'touch' ? 16 : 7;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: px, y: py });
      view.setPointerCapture(e.pointerId);
      if (touches.size === 2) {
        startPinch();
        return;
      }
      if (touches.size > 2) return;
    }
    store.setFocus('program');
    if (store.ui.tool === 'type') {
      const [sx, sy] = screenToSeq(px, py);
      edit.addTextClip({ x: sx, y: sy });
      store.setTool('select');
      store.emit('reveal-effect-controls', { focusText: true });
      return;
    }
    playback.stop();
    // masks first
    const g = maskTarget();
    if (g) {
      const hit = maskHit(g, px, py);
      if (hit?.mode === 'point' && e.altKey) {
        if (g.v.points.length > 3) {
          store.transact('마스크 점 삭제', () => {
            const f = store.seq.clips[g.c.id]?.effects.find((x) => x.id === g.fx.id);
            if (f) f.params.points.value.splice(hit.index, 1);
          });
        } else toast('다각형에는 점이 3개 이상 있어야 합니다');
        return;
      }
      if (!hit && g.polygon && (e.ctrlKey || e.metaKey)) {
        insertPolygonPoint(g, px, py);
        return;
      }
      if (hit) {
        view.setPointerCapture(e.pointerId);
        store.begin('마스크 편집');
        handleDrag = { ...hit, mask: true, clipId: g.c.id, fxId: g.fx.id, x0: px, y0: py, v0: g.v, g };
        return;
      }
    }
    let c = activeClip();
    const key = pathKeyAt(c, px, py);
    if (key) {
      // drag a ◆ to move that keyframe's position; a tap jumps to it
      view.setPointerCapture(e.pointerId);
      store.begin('키프레임 위치 (모션 경로)');
      handleDrag = { mode: 'pathkey', clipId: c.id, t: key.t, kx: key.x, ky: key.y, x0: px, y0: py, moved: false };
      return;
    }
    let pts = c && quadFor(c)?.map(seqToScreen);
    let mode = null;
    // the selected clip's corner / rotation handles win, even where other clips lie on top
    if (pts) {
      const rot = rotationHandle(pts);
      if (Math.hypot(px - rot[0], py - rot[1]) < HANDLE + 1) mode = 'rotate';
      else if (pts.some(([x, y]) => Math.abs(px - x) < HANDLE && Math.abs(py - y) < HANDLE)) mode = 'scale';
    }
    if (!mode) {
      // otherwise the topmost visible clip under the pointer is picked (a full-frame video that was
      // just added and selected must not swallow clicks on titles above it); Alt+click cycles to
      // the clips underneath
      const stack = clipsAtPoint(px, py);
      let hit = stack[0] || null;
      if (e.altKey && stack.length > 1) {
        const i = c ? stack.findIndex((x) => x.id === c.id) : -1;
        hit = stack[(i + 1) % stack.length];
      }
      if (hit) {
        if (!c || hit.id !== c.id) {
          store.selectClips([...edit.withLinked([hit.id])]);
          c = hit;
          pts = quadFor(c)?.map(seqToScreen);
        }
        mode = 'move';
      } else if (pts && pointInQuad(px, py, pts)) {
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
    shiftNoted = false;
    store.begin(mode === 'move' ? '위치 이동 (모션)' : mode === 'scale' ? '크기 조절 (모션)' : '회전 (모션)');
    handleDrag = {
      mode, clipId: c.id, fxId: motion.id, x0: px, y0: py, m0: m, cx, cy,
      d0: Math.hypot(px - cx, py - cy) || 1, a0: Math.atan2(py - cy, px - cx),
    };
  });

  function dragMask(d, px, py) {
    const s = store.seq;
    const c = s.clips[d.clipId];
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    const g = d.g;
    const r1 = (v) => Math.round(v * 10) / 10;
    const [u, w] = g.inv(screenToSeq(px, py));
    const [u0, w0] = g.inv(screenToSeq(d.x0, d.y0));
    if (d.mode === 'point') {
      const pts = fx.params.points.value;
      if (pts[d.index]) pts[d.index] = [r1(u * 100), r1(w * 100)];
    } else if (d.mode === 'mmove') {
      if (g.polygon) {
        const base = d.v0.points;
        fx.params.points.value = base.map(([x, y]) => [r1(x + (u - u0) * 100), r1(y + (w - w0) * 100)]);
      } else {
        edit.rawSetParam(c, fx, 'cx', r1(d.v0.cx + (u - u0) * 100));
        edit.rawSetParam(c, fx, 'cy', r1(d.v0.cy + (w - w0) * 100));
      }
    } else if (d.mode === 'size') {
      const [sx, sy] = screenToSeq(px, py);
      const dx = sx - g.C[0];
      const dy = sy - g.C[1];
      const lx = Math.abs(dx * g.ux[0] + dy * g.ux[1]);
      const ly = Math.abs(dx * g.uy[0] + dy * g.uy[1]);
      if (d.axes.includes('x')) edit.rawSetParam(c, fx, 'w', r1(clamp((lx * 2 * 100) / g.la, 0.5, 300)));
      if (d.axes.includes('y')) edit.rawSetParam(c, fx, 'h', r1(clamp((ly * 2 * 100) / g.lb, 0.5, 300)));
    } else if (d.mode === 'mrot' && 'rotation' in fx.params) {
      const C = seqToScreen(g.C);
      const a0 = Math.atan2(d.y0 - C[1], d.x0 - C[0]);
      const a1 = Math.atan2(py - C[1], px - C[0]);
      edit.rawSetParam(c, fx, 'rotation', r1((d.v0.rotation || 0) + ((a1 - a0) * 180) / Math.PI));
    }
    store.changed();
  }

  /** Two fingers on the selected clip: pinch = scale, twist = rotate, move together = position. */
  function startPinch() {
    const c = activeClip();
    if (!c) return;
    const motion = c.effects.find((fx) => fx.type === 'motion');
    if (!motion) return;
    if (!handleDrag) {
      shiftNoted = false;
      store.begin('크기·회전 (두 손가락)');
    }
    const [a, b] = [...touches.values()];
    handleDrag = {
      mode: 'pinch', clipId: c.id, fxId: motion.id, m0: evalEffect(motion, store.ui.playhead - c.start),
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2,
    };
  }

  function movePinch() {
    const d = handleDrag;
    const pts = [...touches.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const c = store.seq.clips[d.clipId];
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    const k = Math.hypot(a.x - b.x, a.y - b.y) / d.d0;
    let rot = d.m0.rotation + ((Math.atan2(b.y - a.y, b.x - a.x) - d.a0) * 180) / Math.PI;
    if (Math.abs(rot - Math.round(rot / 90) * 90) < 4) rot = Math.round(rot / 90) * 90; // snap to straight angles
    noteShift(edit.rawSetParam(c, fx, 'scale', Math.round(clamp(d.m0.scale * k, 1, 2000) * 10) / 10, { direct: true }));
    noteShift(edit.rawSetParam(c, fx, 'rotation', Math.round(rot * 10) / 10, { direct: true }));
    noteShift(edit.rawSetParam(c, fx, 'posX', Math.round((d.m0.posX + ((a.x + b.x) / 2 - d.mx0) / fr.s) * 10) / 10, { direct: true }));
    noteShift(edit.rawSetParam(c, fx, 'posY', Math.round((d.m0.posY + ((a.y + b.y) / 2 - d.my0) / fr.s) * 10) / 10, { direct: true }));
    store.changed();
  }

  view.addEventListener('pointermove', (e) => {
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: px, y: py });
    if (handleDrag?.mode === 'pinch') {
      movePinch();
      return;
    }
    if (touches.size > 1) return;
    if (!handleDrag) {
      updateCursor(px, py, e);
      return;
    }
    const d = handleDrag;
    if (d.mask) {
      dragMask(d, px, py);
      return;
    }
    const s = store.seq;
    const c = s.clips[d.clipId];
    if (d.mode === 'pathkey') {
      if (!c) return;
      if (Math.hypot(px - d.x0, py - d.y0) > 3) d.moved = true;
      if (!d.moved) return;
      rawSetPathKey(c, d.t, Math.round((d.kx + (px - d.x0) / fr.s) * 10) / 10, Math.round((d.ky + (py - d.y0) / fr.s) * 10) / 10);
      store.changed();
      return;
    }
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    if (d.mode === 'move') {
      let nx = d.m0.posX + (px - d.x0) / fr.s;
      let ny = d.m0.posY + (py - d.y0) / fr.s;
      if (!e.shiftKey) {
        if (Math.abs(nx - s.width / 2) * fr.s < 6) nx = s.width / 2;
        if (Math.abs(ny - s.height / 2) * fr.s < 6) ny = s.height / 2;
      }
      noteShift(edit.rawSetParam(c, fx, 'posX', Math.round(nx * 10) / 10, { direct: true }));
      noteShift(edit.rawSetParam(c, fx, 'posY', Math.round(ny * 10) / 10, { direct: true }));
    } else if (d.mode === 'scale') {
      const dist = Math.hypot(px - d.cx, py - d.cy);
      noteShift(edit.rawSetParam(c, fx, 'scale', Math.round(clamp((d.m0.scale * dist) / d.d0, 0, 2000) * 10) / 10, { direct: true }));
    } else {
      let a = d.m0.rotation + ((Math.atan2(py - d.cy, px - d.cx) - d.a0) * 180) / Math.PI;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      noteShift(edit.rawSetParam(c, fx, 'rotation', Math.round(a * 10) / 10, { direct: true }));
    }
    store.changed();
  });

  const endDrag = (e) => {
    if (e?.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (handleDrag?.mode === 'pinch' && touches.size >= 2) return;
    }
    if (!handleDrag) return;
    const d = handleDrag;
    handleDrag = null;
    if (d.mode === 'pathkey' && !d.moved) {
      store.cancel();
      const c = store.seq.clips[d.clipId];
      if (c) store.setPlayhead(Math.min(c.start + d.t, clipEnd(c) - 1e-3));
      touches.clear();
      return;
    }
    store.commit();
    touches.clear();
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

  function updateCursor(px, py, e) {
    if (store.ui.tool === 'type') {
      view.style.cursor = 'text';
      return;
    }
    const g = maskTarget();
    if (g) {
      const hit = maskHit(g, px, py);
      if (hit) {
        view.style.cursor = hit.mode === 'mrot' ? 'grab' : hit.mode === 'mmove' || hit.mode === 'point' ? (e?.altKey && hit.mode === 'point' ? 'not-allowed' : 'move') : 'nwse-resize';
        return;
      }
      if (g.polygon && (e?.ctrlKey || e?.metaKey)) {
        view.style.cursor = 'copy';
        return;
      }
    }
    const c = activeClip();
    const pts = c && !playback.playing ? quadFor(c)?.map(seqToScreen) : null;
    let cur = 'default';
    if (pathKeyAt(c, px, py)) {
      view.style.cursor = 'pointer';
      view.title = '키프레임 위치: 끌어서 옮기기 · 눌러서 그 시간으로 이동';
      return;
    }
    view.title = '';
    if (pts) {
      const rot = rotationHandle(pts);
      if (Math.hypot(px - rot[0], py - rot[1]) < 8) cur = 'grab';
      else if (pts.some(([x, y]) => Math.abs(px - x) < 7 && Math.abs(py - y) < 7)) cur = 'nwse-resize';
    }
    if (cur === 'default' && !playback.playing && (clipAtPoint(px, py) || (pts && pointInQuad(px, py, pts)))) cur = 'move';
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
    ctx.fillStyle = '#3a3f48';
    ctx.fillRect(0, hh / 2 - 2, w, 4);
    if (s.inPoint != null || s.outPoint != null) {
      const a = ((s.inPoint ?? 0) / d) * w;
      const b = ((s.outPoint ?? d) / d) * w;
      ctx.fillStyle = 'rgba(90,150,240,0.6)';
      ctx.fillRect(a, 2, b - a, hh - 4);
    }
    for (const mk of s.markers) {
      ctx.fillStyle = mk.color;
      ctx.fillRect((mk.time / d) * w - 1, 0, 3, 7);
    }
    ctx.fillStyle = '#4aa3ff';
    ctx.fillRect(Math.min(w - 2, (store.ui.playhead / d) * w) - 1, 0, 3, hh);
  }
  scrubBar.addEventListener('pointerdown', (e) => {
    scrubBar.setPointerCapture(e.pointerId);
    playback.stop();
    const go = (ev) => {
      const r = scrubBar.getBoundingClientRect();
      const d = Math.max(1, sequenceDuration(store.seq));
      store.setPlayhead(clamp((ev.clientX - r.left) / r.width, 0, 1) * d);
      playback.scrubAudio();
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

  let playState = null;
  function refresh() {
    const s = store.seq;
    tcEl.textContent = formatTimecode(store.ui.playhead, s.fps);
    const io = s.inPoint != null || s.outPoint != null;
    const d = io ? (s.outPoint ?? sequenceDuration(s)) - (s.inPoint ?? 0) : sequenceDuration(s);
    durEl.textContent = formatTimecode(Math.max(0, d), s.fps);
    durEl.title = io ? '시작~끝 표시 구간 길이' : '시퀀스 전체 길이';
    if (playState !== playback.playing) {
      playState = playback.playing;
      playBtn.replaceChildren(icon(playback.playing ? 'stop' : 'play'));
    }
    loopBtn.classList.toggle('on', playback.loop);
    loopBtn.setAttribute('aria-pressed', String(playback.loop));
    keyBtn.classList.toggle('on', store.ui.autoKey);
    keyBtn.setAttribute('aria-pressed', String(store.ui.autoKey));
    recBadge.hidden = !store.ui.autoKey;
    safeBtn.classList.toggle('on', safe);
    safeBtn.setAttribute('aria-pressed', String(safe));
    drawScrub();
  }

  playback.addRenderer(draw);
  playback.on('state', refresh);
  store.on('selection', () => playback.requestRender());
  store.on('autokey', () => {
    refresh();
    playback.requestRender();
  });
  store.on('mask-target', () => playback.requestRender());
  store.on('tool', () => { view.classList.toggle('type-tool', store.ui.tool === 'type'); });
  new ResizeObserver(layout).observe(view);

  Object.assign(programApi, { canvas: frame, saveFrame, layout });
  return root;
}
