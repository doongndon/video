// Source monitor: preview a media item, mark In/Out, insert/overwrite or drag into the timeline.

import { store } from '../store.js';
import { mediaUrl, runtime, mediaEvents, mediaStatus } from '../media.js';
import * as edit from '../edit.js';
import { h, clamp, formatTimecode, parseTimecode, snapFrame } from '../util.js';
import { fitRect, fitCanvasToBox, dnd, inlineEdit } from './common.js';
import { icon, iconButton } from './icons.js';

export const sourceApi = {};

export function createSourceMonitor() {
  const view = h('div.monitor-view');
  const video = h('video.frame', { playsInline: true, preload: 'auto', style: { display: 'none' } });
  const img = h('img.frame', { style: { position: 'absolute', objectFit: 'contain', display: 'none' } });
  const wave = h('canvas.frame', { style: { display: 'none' } });
  const overlay = h('canvas.overlay');
  const empty = h('div.monitor-empty', '프로젝트 패널의 영상·소리 항목을 두 번 클릭하면\n여기에서 미리 보고 시작(I)·끝(O)을 표시할 수 있습니다.');
  view.append(video, img, wave, overlay, empty);
  const titleEl = h('span.monitor-title', '소스 없음');
  const tcEl = h('span.tc', '00:00:00:00');
  const durEl = h('span.tc.dur', '');
  const scrub = h('canvas');
  const scrubBar = h('div.monitor-scrub', scrub);
  const playBtn = iconButton('play', '재생 / 정지 (Space)', () => togglePlay(), { cls: 'play' });
  const dragVideo = h('span.drag-src', { draggable: true, title: '끌어서 영상만 타임라인에 놓기' }, icon('film'), '영상만');
  const dragAudio = h('span.drag-src', { draggable: true, title: '끌어서 소리만 타임라인에 놓기' }, icon('audio'), '소리만');
  const transport = h('div.transport',
    tcEl,
    h('span.grow'),
    iconButton('markIn', '시작 표시 (I)', () => markIn()),
    iconButton('markOut', '끝 표시 (O)', () => markOut()),
    iconButton('goIn', '시작 표시로 이동 (Shift+I)', () => goIn()),
    iconButton('stepBack', '1프레임 뒤로 (←)', () => step(-1)),
    playBtn,
    iconButton('stepForward', '1프레임 앞으로 (→)', () => step(1)),
    iconButton('goOut', '끝 표시로 이동 (Shift+O)', () => goOut()),
    h('span.sep'),
    iconButton('insert', '삽입: 재생헤드 위치에 끼워 넣고 뒤를 밀기 (,)', () => insert('insert'), { label: '삽입' }),
    iconButton('overwrite', '덮어쓰기: 재생헤드 위치에 덮어 놓기 (.)', () => insert('overwrite'), { label: '덮어쓰기' }),
    dragVideo, dragAudio,
    h('span.grow'),
    durEl);
  const root = h('div.monitor', h('div.panel-toolbar', titleEl), view, scrubBar, transport);

  let mediaId = null;
  let shuttleRate = 0;
  let shuttleTimer = null;

  const media = () => (mediaId ? store.project.media[mediaId] : null);
  const fps = () => media()?.fps || store.seq.fps;
  const duration = () => (Number.isFinite(media()?.duration) ? media().duration : 0);
  const current = () => (media()?.kind === 'image' ? 0 : video.currentTime || 0);

  function load(id) {
    stop();
    mediaId = id;
    const m = media();
    video.pause();
    video.removeAttribute('src');
    video.load();
    img.removeAttribute('src');
    video.style.display = img.style.display = wave.style.display = 'none';
    empty.hidden = !!m;
    if (!m || mediaStatus(id) !== 'ready') {
      titleEl.textContent = m ? `${m.name} (오프라인)` : '소스 없음';
      layout();
      draw();
      return;
    }
    titleEl.textContent = m.name;
    if (m.kind === 'image') {
      img.src = mediaUrl(id);
      img.style.display = 'block';
    } else {
      video.src = mediaUrl(id);
      video.style.display = m.kind === 'video' ? 'block' : 'none';
      if (m.kind === 'audio') wave.style.display = 'block';
      const seek = store.ui.sourceSeek ?? m.inPoint ?? 0;
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = clamp(seek, 0, duration());
      }, { once: true });
    }
    dragVideo.style.display = m.kind === 'audio' ? 'none' : '';
    dragAudio.style.display = m.kind === 'image' || !m.hasAudio ? 'none' : '';
    layout();
    draw();
    store.setFocus('source');
  }

  function layout() {
    const r = view.getBoundingClientRect();
    const m = media();
    const w = m?.width || 16;
    const hh = m?.height || 9;
    const fr = fitRect(r.width, r.height, w, hh);
    for (const el of [video, img]) Object.assign(el.style, { left: `${fr.x}px`, top: `${fr.y}px`, width: `${fr.w}px`, height: `${fr.h}px` });
    Object.assign(wave.style, { left: '8px', top: '8px', width: `${r.width - 16}px`, height: `${r.height - 16}px` });
    draw();
  }

  function draw() {
    const m = media();
    tcEl.textContent = formatTimecode(current(), fps());
    const inP = m?.inPoint ?? 0;
    const outP = m?.outPoint ?? duration();
    durEl.textContent = m ? `${formatTimecode(Math.max(0, outP - inP), fps())}` : '';
    const playing = !video.paused && !!m;
    if (playBtn.dataset.state !== String(playing)) {
      playBtn.dataset.state = String(playing);
      playBtn.replaceChildren(icon(playing ? 'stop' : 'play'));
    }
    // scrub bar
    const { ctx, w, h: hh } = fitCanvasToBox(scrub);
    ctx.clearRect(0, 0, w, hh);
    const d = duration();
    if (m && d > 0) {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, hh / 2 - 2, w, 4);
      if (m.inPoint != null || m.outPoint != null) {
        ctx.fillStyle = 'rgba(90,150,240,0.6)';
        ctx.fillRect((inP / d) * w, 2, ((outP - inP) / d) * w, hh - 4);
      }
      const x = (current() / d) * w;
      ctx.fillStyle = '#4aa3ff';
      ctx.fillRect(x - 1, 0, 2, hh);
    }
    // audio waveform
    if (m?.kind === 'audio' && wave.style.display !== 'none') {
      const g = fitCanvasToBox(wave);
      g.ctx.fillStyle = '#0d0d0d';
      g.ctx.fillRect(0, 0, g.w, g.h);
      const peaks = runtime.get(mediaId)?.peaks;
      if (peaks && d > 0) {
        g.ctx.fillStyle = '#4fb183';
        for (let x = 0; x < g.w; x++) {
          const a = Math.floor((x / g.w) * d * peaks.rate);
          const b = Math.floor(((x + 1) / g.w) * d * peaks.rate);
          let v = 0;
          for (let i = a; i <= b && i < peaks.data.length; i++) v = Math.max(v, peaks.data[i]);
          g.ctx.fillRect(x, g.h / 2 - (v * g.h) / 2, 1, v * g.h);
        }
        if (m.inPoint != null || m.outPoint != null) {
          g.ctx.fillStyle = 'rgba(90,150,240,0.18)';
          g.ctx.fillRect((inP / d) * g.w, 0, ((outP - inP) / d) * g.w, g.h);
        }
        g.ctx.fillStyle = '#4aa3ff';
        g.ctx.fillRect((current() / d) * g.w - 1, 0, 2, g.h);
      }
    }
    // in/out overlay markers on the image
    const o = fitCanvasToBox(overlay);
    o.ctx.clearRect(0, 0, o.w, o.h);
    if (m && m.kind !== 'audio' && d > 0) {
      const t = current();
      o.ctx.fillStyle = 'rgba(255,255,255,0.8)';
      o.ctx.font = 'bold 13px sans-serif';
      if (m.inPoint != null && Math.abs(t - m.inPoint) < 0.5 / fps()) o.ctx.fillText('시작', 8, 18);
      if (m.outPoint != null && Math.abs(t - m.outPoint) < 0.5 / fps()) o.ctx.fillText('끝', o.w - 24, 18);
    }
  }

  // ---- transport
  function togglePlay() {
    if (!media() || media().kind === 'image') return;
    if (video.paused) {
      if (video.currentTime >= duration() - 0.05) video.currentTime = media().inPoint ?? 0;
      video.playbackRate = 1;
      video.play().catch(() => {});
    } else stop();
  }

  function stop() {
    shuttleRate = 0;
    clearInterval(shuttleTimer);
    shuttleTimer = null;
    video.pause();
    draw();
  }

  function shuttle(dir) {
    if (!media() || media().kind === 'image') return;
    if (dir === 0) return stop();
    if (Math.sign(shuttleRate) === dir) shuttleRate = clamp(shuttleRate * 2, -8, 8);
    else shuttleRate = dir;
    if (shuttleRate > 0) {
      clearInterval(shuttleTimer);
      shuttleTimer = null;
      video.playbackRate = shuttleRate;
      video.play().catch(() => {});
    } else {
      video.pause();
      clearInterval(shuttleTimer);
      shuttleTimer = setInterval(() => {
        video.currentTime = Math.max(0, video.currentTime + shuttleRate / 15);
        if (video.currentTime <= 0) stop();
      }, 1000 / 15);
    }
  }

  function seek(t) {
    if (!media() || media().kind === 'image') return;
    video.currentTime = clamp(t, 0, duration());
    draw();
  }

  function step(n) {
    stop();
    seek(snapFrame(current(), fps()) + n / fps());
  }

  function setMark(which, t) {
    const id = mediaId;
    if (!id) return;
    store.transact(which === 'in' ? '소스 시작 표시' : '소스 끝 표시', () => {
      const m = store.project.media[id];
      if (!m) return;
      if (which === 'in') {
        m.inPoint = t;
        if (m.outPoint != null && t != null && m.outPoint <= t) m.outPoint = null;
      } else {
        m.outPoint = t;
        if (m.inPoint != null && t != null && m.inPoint >= t) m.inPoint = null;
      }
    });
    draw();
  }

  const markIn = () => media() && media().kind !== 'image' && setMark('in', snapFrame(current(), fps()));
  const markOut = () => media() && media().kind !== 'image' && setMark('out', snapFrame(current(), fps()));
  const goIn = () => seek(media()?.inPoint ?? 0);
  const goOut = () => seek(media()?.outPoint ?? duration());
  const clearIn = () => setMark('in', null);
  const clearOut = () => setMark('out', null);

  function insert(mode, opts = {}) {
    if (!mediaId || mediaStatus(mediaId) !== 'ready') return;
    edit.placeMedia(mediaId, { mode, ...opts });
    // move the playhead to the end of the edit, like an NLE
    const sel = store.selectedClips();
    if (sel.length) store.setPlayhead(Math.max(...sel.map((c) => c.start + c.duration)));
  }

  // ---- interactions
  scrubBar.addEventListener('pointerdown', (e) => {
    scrubBar.setPointerCapture(e.pointerId);
    stop();
    const go = (ev) => {
      const r = scrubBar.getBoundingClientRect();
      seek(((ev.clientX - r.left) / r.width) * duration());
    };
    go(e);
    const up = () => {
      scrubBar.removeEventListener('pointermove', go);
      scrubBar.removeEventListener('pointerup', up);
    };
    scrubBar.addEventListener('pointermove', go);
    scrubBar.addEventListener('pointerup', up);
  });
  wave.addEventListener('pointerdown', (e) => {
    const r = wave.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration());
  });
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  tcEl.addEventListener('click', () => {
    if (!media()) return;
    inlineEdit(tcEl, {
      onCommit: (v) => {
        const t = parseTimecode(v, fps());
        if (t != null) seek(t);
      },
    });
  });

  const setDrag = (el, opts) => {
    el.addEventListener('dragstart', (e) => {
      if (!mediaId || mediaStatus(mediaId) !== 'ready') return e.preventDefault();
      const items = [{ mediaId, ...opts }];
      dnd.payload = { items };
      e.dataTransfer.setData('application/x-montage-media', JSON.stringify({ items }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('dragend', () => { dnd.payload = null; });
  };
  view.draggable = true;
  setDrag(view, {});
  setDrag(dragVideo, { audio: false });
  setDrag(dragAudio, { video: false });

  video.addEventListener('timeupdate', draw);
  video.addEventListener('seeked', draw);
  video.addEventListener('play', draw);
  video.addEventListener('pause', draw);
  video.addEventListener('ended', draw);
  let rafOn = false;
  const loop = () => {
    if (!video.paused) {
      draw();
      // stop at out point
      const m = media();
      if (m?.outPoint != null && video.currentTime >= m.outPoint && video.currentTime - m.outPoint < 0.2 && shuttleRate <= 1) {
        video.pause();
        video.currentTime = m.outPoint;
      }
      requestAnimationFrame(loop);
    } else rafOn = false;
  };
  video.addEventListener('play', () => {
    if (!rafOn) {
      rafOn = true;
      requestAnimationFrame(loop);
    }
  });

  store.on('source', () => load(store.ui.sourceMediaId));
  store.on('change', () => {
    if (mediaId && !store.project.media[mediaId]) load(null);
  });
  mediaEvents.on('updated', (id) => {
    if (id === mediaId) {
      if (!video.src && mediaStatus(id) === 'ready') load(id);
      else draw();
    }
  });
  new ResizeObserver(layout).observe(view);

  Object.assign(sourceApi, {
    togglePlay, stop, step, shuttle, markIn, markOut, goIn, goOut, clearIn, clearOut,
    clearInOut: () => { clearIn(); clearOut(); },
    insert: () => insert('insert'),
    overwrite: () => insert('overwrite'),
    goStart: () => seek(0),
    goEnd: () => seek(duration()),
    hasMedia: () => !!media(),
  });
  return root;
}
