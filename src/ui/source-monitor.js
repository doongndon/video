// Source monitor: preview a media item, mark In/Out, insert/overwrite or drag into the timeline
// (video only / audio only), make subclips (하위 클립 만들기, Ctrl+U) and set poster frames (Shift+P).
// A subclip opens on its master's file, limited to the subclip's range.

import { store } from '../store.js';
import { mediaUrl, runtime, mediaEvents, mediaStatus, interpretRatio } from '../media.js';
import * as edit from '../edit.js';
import { h, clamp, formatTimecode, parseTimecode, snapFrame, modKey } from '../util.js';
import { fitRect, fitCanvasToBox, dnd, inlineEdit, showMenu, toast, menusOpen } from './common.js';
import { icon, iconButton } from './icons.js';
import { extendMenu } from './menubar.js';
import { fileIdOf, itemRange, isSubclip } from '../subclips.js';

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
  const subBtn = iconButton('subclip', '하위 클립 만들기 (Ctrl+U): 시작~끝 표시 구간을 새 프로젝트 항목으로', () => makeSubclip());
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
    subBtn,
    dragVideo, dragAudio,
    h('span.grow'),
    durEl);
  const root = h('div.monitor', h('div.panel-toolbar', titleEl), view, scrubBar, transport);

  let mediaId = null;
  let shuttleRate = 0;
  let shuttleTimer = null;
  let stopAtOut = true;

  const media = () => (mediaId ? store.project.media[mediaId] : null);
  const fps = () => media()?.fps || store.seq.fps;
  /** The playable range of the item: the whole file, or a subclip's part of its master. */
  const range = () => {
    const m = media();
    if (!m) return [0, 0];
    return itemRange(m);
  };
  const duration = () => range()[1];
  // 푸티지 해석: marks and times are interpreted media seconds; the element plays the file
  const ratio = () => (mediaId ? interpretRatio(store.project.media[fileIdOf(mediaId)]) : 1);
  const toFile = (t) => t / ratio();
  const current = () => (media()?.kind === 'image' ? 0 : (video.currentTime || 0) * ratio());
  /** Element speed for a media-time rate (an interpreted item plays its file slower or faster). */
  const elRate = (r) => clamp(r / ratio(), 0.0625, 16);
  const inOf = (m) => m?.inPoint ?? range()[0];
  const outOf = (m) => m?.outPoint ?? range()[1];

  function load(id, { focus = true } = {}) {
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
    titleEl.textContent = isSubclip(m) ? `${m.name} (하위 클립)` : m.name;
    const file = fileIdOf(id);
    if (m.kind === 'image') {
      img.src = mediaUrl(file);
      img.style.display = 'block';
    } else {
      video.src = mediaUrl(file);
      video.style.display = m.kind === 'video' ? 'block' : 'none';
      if (m.kind === 'audio') wave.style.display = 'block';
      const [lo, hi] = range();
      const seekTo = clamp(store.ui.sourceSeek ?? m.inPoint ?? lo, lo, hi);
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = toFile(clamp(seekTo, lo, duration()));
      }, { once: true });
    }
    dragVideo.style.display = m.kind === 'audio' ? 'none' : '';
    dragAudio.style.display = m.kind === 'image' || !m.hasAudio ? 'none' : '';
    subBtn.style.display = ['video', 'audio'].includes(m.kind) ? '' : 'none';
    layout();
    draw();
    if (focus) store.setFocus('source');
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

  /** x position (0..w) of a media time on the scrub bar / waveform. */
  const xOf = (t, w) => {
    const [lo, hi] = range();
    return ((t - lo) / Math.max(1e-6, hi - lo)) * w;
  };

  function draw() {
    const m = media();
    tcEl.textContent = formatTimecode(current(), fps());
    const inP = inOf(m);
    const outP = outOf(m);
    durEl.textContent = m ? `${formatTimecode(Math.max(0, outP - inP), fps())}` : '';
    const playing = !video.paused && !!m;
    if (playBtn.dataset.state !== String(playing)) {
      playBtn.dataset.state = String(playing);
      playBtn.replaceChildren(icon(playing ? 'stop' : 'play'));
    }
    const [lo, hi] = range();
    const marked = !!m && (m.inPoint != null || m.outPoint != null) && (Math.abs(inP - lo) > 1e-6 || Math.abs(outP - hi) > 1e-6);
    // scrub bar
    const { ctx, w, h: hh } = fitCanvasToBox(scrub);
    ctx.clearRect(0, 0, w, hh);
    if (m && hi > lo) {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, hh / 2 - 2, w, 4);
      if (marked) {
        ctx.fillStyle = 'rgba(90,150,240,0.6)';
        ctx.fillRect(xOf(inP, w), 2, xOf(outP, w) - xOf(inP, w), hh - 4);
      }
      if (m.posterTime != null && m.posterTime >= lo && m.posterTime <= hi) {
        ctx.fillStyle = '#ffd666';
        ctx.fillRect(xOf(m.posterTime, w) - 1, hh - 5, 3, 5);
      }
      ctx.fillStyle = '#4aa3ff';
      ctx.fillRect(xOf(current(), w) - 1, 0, 2, hh);
    }
    // audio waveform
    if (m?.kind === 'audio' && wave.style.display !== 'none') {
      const g = fitCanvasToBox(wave);
      g.ctx.fillStyle = '#0d0d0d';
      g.ctx.fillRect(0, 0, g.w, g.h);
      const peaks = runtime.get(fileIdOf(mediaId))?.peaks;
      if (peaks && hi > lo) {
        g.ctx.fillStyle = '#4fb183';
        const span = hi - lo;
        for (let x = 0; x < g.w; x++) {
          const a = Math.floor((lo + (x / g.w) * span) * peaks.rate);
          const b = Math.floor((lo + ((x + 1) / g.w) * span) * peaks.rate);
          let v = 0;
          for (let i = a; i <= b && i < peaks.data.length; i++) v = Math.max(v, peaks.data[i]);
          g.ctx.fillRect(x, g.h / 2 - (v * g.h) / 2, 1, v * g.h);
        }
        if (marked) {
          g.ctx.fillStyle = 'rgba(90,150,240,0.18)';
          g.ctx.fillRect(xOf(inP, g.w), 0, xOf(outP, g.w) - xOf(inP, g.w), g.h);
        }
        g.ctx.fillStyle = '#4aa3ff';
        g.ctx.fillRect(xOf(current(), g.w) - 1, 0, 2, g.h);
      }
    }
    // in/out overlay markers on the image
    const o = fitCanvasToBox(overlay);
    o.ctx.clearRect(0, 0, o.w, o.h);
    if (m && m.kind !== 'audio' && hi > lo) {
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
      const m = media();
      const [lo, hi] = range();
      if (current() >= hi - 0.05) video.currentTime = toFile(m.inPoint ?? lo);
      // started at (or after) the Out point: play on past it, like Premiere
      stopAtOut = m.outPoint == null || current() < m.outPoint - 0.5 / fps();
      video.playbackRate = elRate(1);
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
    const lo = range()[0];
    if (shuttleRate > 0) {
      clearInterval(shuttleTimer);
      shuttleTimer = null;
      stopAtOut = false;
      video.playbackRate = elRate(shuttleRate);
      video.play().catch(() => {});
    } else {
      video.pause();
      clearInterval(shuttleTimer);
      shuttleTimer = setInterval(() => {
        const t = Math.max(lo, current() + shuttleRate / 15);
        video.currentTime = toFile(t);
        if (t <= lo) stop();
      }, 1000 / 15);
    }
  }

  function seek(t) {
    if (!media() || media().kind === 'image') return;
    const [lo, hi] = range();
    video.currentTime = toFile(clamp(t, lo, hi));
    draw();
  }

  function step(n) {
    stop();
    seek(snapFrame(current(), fps()) + n / fps());
  }

  function setMark(which, t) {
    const id = mediaId;
    if (!id) return;
    const [lo, hi] = range();
    const sub = isSubclip(media());
    store.transact(which === 'in' ? '소스 시작 표시' : '소스 끝 표시', () => {
      const m = store.project.media[id];
      if (!m) return;
      // a subclip's marks never leave its range (cleared marks fall back to its bounds)
      const v = t == null ? (sub ? (which === 'in' ? lo : hi) : null) : clamp(t, lo, hi);
      if (which === 'in') {
        m.inPoint = v;
        if (m.outPoint != null && v != null && m.outPoint <= v) m.outPoint = sub ? hi : null;
      } else {
        m.outPoint = v;
        if (m.inPoint != null && v != null && m.inPoint >= v) m.inPoint = sub ? lo : null;
      }
    });
    draw();
  }

  const markIn = () => media() && media().kind !== 'image' && setMark('in', snapFrame(current(), fps()));
  const markOut = () => media() && media().kind !== 'image' && setMark('out', snapFrame(current(), fps()));
  const goIn = () => seek(inOf(media()));
  const goOut = () => seek(outOf(media()));
  const clearIn = () => setMark('in', null);
  const clearOut = () => setMark('out', null);

  function insert(mode, opts = {}) {
    if (!mediaId || mediaStatus(mediaId) !== 'ready') return;
    edit.placeMedia(mediaId, { mode, ...opts });
    // move the playhead to the end of the edit, like an NLE
    const sel = store.selectedClips();
    if (sel.length) store.setPlayhead(Math.max(...sel.map((c) => c.start + c.duration)));
  }

  /** 하위 클립 만들기: the In/Out range (or the whole item) becomes a new project item. */
  async function makeSubclip() {
    const m = media();
    if (!m || !['video', 'audio'].includes(m.kind)) {
      toast('하위 클립은 영상·소리 항목으로 만듭니다. 프로젝트 패널에서 항목을 두 번 클릭해 소스 모니터에서 여세요.');
      return;
    }
    const { openSubclipDialog } = await import('./dialogs.js');
    openSubclipDialog(mediaId, { inPoint: inOf(m), outPoint: outOf(m) });
  }

  /** 포스터 프레임 설정: the project panel shows this frame as the item's thumbnail. */
  function setPosterFrame() {
    const m = media();
    if (!m || m.kind !== 'video') {
      toast('포스터 프레임은 영상 항목에 설정합니다');
      return;
    }
    const t = snapFrame(current(), fps());
    store.transact('포스터 프레임 설정', () => {
      const x = store.project.media[mediaId];
      if (x) x.posterTime = t;
    });
    toast(`포스터 프레임: ${formatTimecode(t, fps())}`);
  }

  // ---- interactions
  scrubBar.addEventListener('pointerdown', (e) => {
    scrubBar.setPointerCapture(e.pointerId);
    stop();
    const go = (ev) => {
      const r = scrubBar.getBoundingClientRect();
      const [lo, hi] = range();
      seek(lo + clamp((ev.clientX - r.left) / r.width, 0, 1) * (hi - lo));
    };
    go(e);
    const up = () => {
      scrubBar.removeEventListener('pointermove', go);
      scrubBar.removeEventListener('pointerup', up);
      scrubBar.removeEventListener('pointercancel', up);
    };
    scrubBar.addEventListener('pointermove', go);
    scrubBar.addEventListener('pointerup', up);
    scrubBar.addEventListener('pointercancel', up);
  });
  wave.addEventListener('pointerdown', (e) => {
    const r = wave.getBoundingClientRect();
    const [lo, hi] = range();
    seek(lo + ((e.clientX - r.left) / r.width) * (hi - lo));
  });
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  view.addEventListener('pointerdown', () => { if (media()) store.setFocus('source'); });
  view.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const m = media();
    if (!m) return;
    const timed = ['video', 'audio'].includes(m.kind);
    showMenu([
      { label: '하위 클립 만들기…', key: 'Ctrl+U', disabled: !timed, action: makeSubclip },
      { label: '포스터 프레임 설정', key: 'Shift+P', disabled: m.kind !== 'video', action: setPosterFrame },
      '-',
      { label: '시작 표시 지우기', key: 'Ctrl+Shift+I', disabled: !timed, action: clearIn },
      { label: '끝 표시 지우기', key: 'Ctrl+Shift+O', disabled: !timed, action: clearOut },
      '-',
      { label: '프로젝트에서 표시', action: () => store.emit('reveal-media', mediaId) },
    ], e.clientX, e.clientY);
  });

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
      const m = media();
      const hi = range()[1];
      const t = current();
      // stop at the Out point (or at the end of a subclip)
      if (stopAtOut && m?.outPoint != null && t >= m.outPoint && t - m.outPoint < 0.25 && shuttleRate <= 1) {
        video.pause();
        video.currentTime = toFile(m.outPoint);
      } else if (isSubclip(m) && t >= hi) {
        video.pause();
        video.currentTime = toFile(hi);
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

  // keyboard: Ctrl+U (하위 클립 만들기) and Shift+P (포스터 프레임 설정)
  window.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('photo-mode') || menusOpen() || document.querySelector('.modal-backdrop')) return;
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type)))) return;
    if (modKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyU') {
      e.preventDefault();
      e.stopPropagation();
      subclipCommand();
    } else if (e.shiftKey && !modKey(e) && !e.altKey && e.code === 'KeyP' && store.ui.focusPanel === 'source' && media()) {
      e.preventDefault();
      e.stopPropagation();
      setPosterFrame();
    }
  }, true);

  store.on('source', () => load(store.ui.sourceMediaId));
  store.on('change', () => {
    if (mediaId && !store.project.media[mediaId]) return load(null);
    // a new 푸티지 해석 while playing forward changes the element's speed at once
    if (!video.paused && shuttleRate >= 0) video.playbackRate = elRate(shuttleRate || 1);
    draw();
  });
  mediaEvents.on('updated', (id) => {
    if (!mediaId || (id !== mediaId && id !== fileIdOf(mediaId))) return;
    const m = media();
    const loaded = m?.kind === 'image' ? !!img.getAttribute('src') : !!video.getAttribute('src');
    // a file that just came online: load it, without pulling keyboard focus away from where the user is
    if (!loaded && mediaStatus(mediaId) === 'ready') load(mediaId, { focus: false });
    else draw();
  });
  new ResizeObserver(layout).observe(view);

  Object.assign(sourceApi, {
    togglePlay, stop, step, shuttle, markIn, markOut, goIn, goOut, clearIn, clearOut,
    clearInOut: () => { clearIn(); clearOut(); },
    insert: () => insert('insert'),
    overwrite: () => insert('overwrite'),
    goStart: () => seek(range()[0]),
    goEnd: () => seek(range()[1]),
    hasMedia: () => !!media(),
    currentTime: () => (media() ? current() : null),
    mediaId: () => mediaId,
    makeSubclip,
    setPosterFrame,
  });
  return root;
}

/**
 * 하위 클립 만들기 (Ctrl+U): from the Source monitor's In/Out, or from the one video / audio item
 * selected in the Project panel when that panel has the focus.
 */
export function subclipCommand() {
  const sel = [...store.ui.selectedMedia].map((id) => store.project.media[id]).filter((m) => m && ['video', 'audio'].includes(m.kind));
  const useProject = sel.length === 1 && (store.ui.focusPanel === 'project' || !sourceApi.hasMedia?.());
  if (!useProject && sourceApi.hasMedia?.()) return sourceApi.makeSubclip();
  const m = sel[0];
  if (!m) {
    toast('소스 모니터에서 영상을 열거나 프로젝트 패널에서 영상·소리 항목을 하나 고르세요');
    return;
  }
  const [lo, hi] = itemRange(m);
  import('./dialogs.js').then(({ openSubclipDialog }) => openSubclipDialog(m.id, { inPoint: m.inPoint ?? lo, outPoint: m.outPoint ?? hi }));
}

// 클립 ▸ 하위 클립 만들기 / 하위 클립 편집 (the menu bar places them after 이름 바꾸기, like Premiere)
extendMenu('클립', (items) => {
  const sel = () => [...store.ui.selectedMedia].map((id) => store.project.media[id]).filter(Boolean);
  return [
    ...items,
    { label: '하위 클립 만들기…', key: 'Ctrl+U', action: subclipCommand },
    { label: '하위 클립 편집…', disabled: !sel().some(isSubclip), action: () => {
      const m = sel().find(isSubclip);
      if (m) import('./dialogs.js').then(({ openEditSubclipDialog }) => openEditSubclipDialog(m.id));
    } },
  ];
});
