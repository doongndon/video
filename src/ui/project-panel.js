// Project panel: imported media bin with list/icon views, search, hover scrub and drag to timeline.

import { store } from '../store.js';
import { runtime, mediaEvents, importFiles, createSyntheticMedia, removeMedia, attachFile, mediaStatus } from '../media.js';
import * as edit from '../edit.js';
import { relinkFromFiles } from '../persist.js';
import { h, formatTimecode, formatShort, formatBytes, modKey } from '../util.js';
import { showMenu, openModal, promptDialog, confirmDialog, loadPref, savePref, toast, dnd } from './common.js';
import { openColorMatteDialog } from './dialogs.js';

export function pickFiles({ accept = 'video/*,audio/*,image/*', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

export async function importDialog() {
  const files = await pickFiles();
  if (files.length) await importFiles(files);
}

export function createProjectPanel() {
  let mode = loadPref('project.view', 'list');
  let filter = '';
  let anchor = null;

  const search = h('input', { type: 'text', placeholder: 'Search', style: { width: '120px' } });
  const viewBtn = h('button.icon', { title: 'Toggle list / icon view' }, mode === 'list' ? '▦' : '☰');
  const importBtn = h('button', { onclick: () => importDialog() }, 'Import…');
  const newBtn = h('button', { title: 'New Item' }, 'New Item ▾');
  const toolbar = h('div.panel-toolbar', importBtn, newBtn, h('span.grow'), search, viewBtn);
  const list = h('div.project-list', { tabindex: 0 });
  const footer = h('div.panel-footer');
  const body = h('div', toolbar, list, footer);

  newBtn.addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(newItemMenu(), r.left, r.bottom + 2);
  });
  viewBtn.addEventListener('click', () => {
    mode = mode === 'list' ? 'grid' : 'list';
    viewBtn.textContent = mode === 'list' ? '▦' : '☰';
    savePref('project.view', mode);
    render();
  });
  search.addEventListener('input', () => {
    filter = search.value.toLowerCase();
    render();
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());

  // file drop
  list.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      list.classList.add('drop');
    }
  });
  list.addEventListener('dragleave', () => list.classList.remove('drop'));
  list.addEventListener('drop', (e) => {
    list.classList.remove('drop');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    importFiles([...e.dataTransfer.files]);
  });
  list.addEventListener('pointerdown', (e) => {
    if (e.target === list) {
      store.ui.selectedMedia.clear();
      render();
    }
  });
  list.addEventListener('contextmenu', (e) => {
    if (e.target !== list) return;
    e.preventDefault();
    showMenu([{ label: 'Import…', key: 'Ctrl+I', action: importDialog }, '-', ...newItemMenu()], e.clientX, e.clientY);
  });
  list.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && store.ui.selectedMedia.size) {
      e.preventDefault();
      e.stopPropagation();
      clearSelected();
    }
    if (e.key === 'Enter' && store.ui.selectedMedia.size) openInSource([...store.ui.selectedMedia][0]);
  });

  function newItemMenu() {
    return [
      { label: 'Color Matte…', action: openColorMatteDialog },
      { label: 'Black Video', action: () => createSyntheticMedia('color', { name: 'Black Video', color: '#000000' }) },
      { label: 'Adjustment Layer', action: () => createSyntheticMedia('adjustment', { name: 'Adjustment Layer' }) },
      { label: 'Sequence…', action: () => edit.newSequence() },
      { label: 'Text (at playhead)', action: () => edit.addTextClip() },
      { label: 'Rectangle (at playhead)', action: () => edit.addShapeClip('rectangle') },
      { label: 'Ellipse (at playhead)', action: () => edit.addShapeClip('ellipse') },
    ];
  }

  async function clearSelected() {
    const ids = [...store.ui.selectedMedia];
    const used = Object.values(store.project.sequences).flatMap((sq) => Object.values(sq.clips)).filter((c) => ids.includes(c.mediaId)).length;
    if (used && !(await confirmDialog('Clear Media', `${used} clip(s) in your sequences use this media and will be removed too.`))) return;
    removeMedia(ids);
    store.ui.selectedMedia.clear();
  }

  function openInSource(id) {
    store.ui.sourceMediaId = id;
    store.ui.sourceSeek = null;
    store.emit('source');
  }

  let lastSig = '';
  let queued = false;
  function scheduleRender(force = false) {
    if (force) lastSig = '';
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const proj = store.project;
      const sig = [mode, filter, [...store.ui.selectedMedia].join(','), ...proj.mediaOrder.map((id) => {
        const m = proj.media[id];
        const rt = runtime.get(id);
        return m ? `${id}:${m.name}:${m.duration}:${m.width}:${m.color}:${mediaStatus(id)}:${rt?.thumb ? 1 : 0}:${rt?.filmstrip?.length || 0}` : id;
      })].join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      render();
    });
  }

  function render() {
    const proj = store.project;
    list.className = `project-list ${mode === 'grid' ? 'grid' : ''}`;
    list.replaceChildren();
    const ids = proj.mediaOrder.filter((id) => proj.media[id] && (!filter || proj.media[id].name.toLowerCase().includes(filter)));
    if (!proj.mediaOrder.length) {
      list.append(h('div.empty-hint', 'Import media to start', h('br'), 'Drag files here, use Import… or press Ctrl+I', h('br'), 'Video · Audio · Images'));
    }
    for (const id of ids) list.append(renderItem(id));
    const offline = proj.mediaOrder.filter((id) => ['offline', 'error'].includes(mediaStatus(id))).length;
    footer.replaceChildren(...[
      h('span', `${proj.mediaOrder.length} item(s)`),
      offline ? h('span', { style: { color: 'var(--danger)' } }, ` · ${offline} offline`) : null,
      h('span.grow', { style: { flex: 1 } }),
      offline ? h('button', { onclick: linkMediaDialog }, 'Link Media…') : null,
    ].filter(Boolean));
  }

  function renderItem(id) {
    const m = store.project.media[id];
    const rt = runtime.get(id);
    const st = mediaStatus(id);
    const thumb = h('div.thumb');
    if (rt?.thumb) {
      const c = document.createElement('canvas');
      c.width = rt.thumb.width;
      c.height = rt.thumb.height;
      c.getContext('2d').drawImage(rt.thumb, 0, 0);
      thumb.append(c);
      // hover scrub in icon view
      if (mode === 'grid' && rt.filmstrip?.length) {
        thumb.addEventListener('pointermove', (e) => {
          const r = thumb.getBoundingClientRect();
          const f = rt.filmstrip[Math.min(rt.filmstrip.length - 1, Math.floor(((e.clientX - r.left) / r.width) * rt.filmstrip.length))];
          c.getContext('2d').drawImage(f.canvas, 0, 0, c.width, c.height);
        });
        thumb.addEventListener('pointerleave', () => c.getContext('2d').drawImage(rt.thumb, 0, 0, c.width, c.height));
      }
    } else if (m.kind === 'color') {
      thumb.style.background = m.color;
    } else {
      thumb.textContent = { audio: '♪', video: '▶', image: '🖼', adjustment: 'ADJ', color: '', sequence: 'SEQ' }[m.kind] || '';
      if (m.kind === 'sequence') thumb.style.background = '#3d4a18';
    }
    const badge = st === 'offline' || st === 'error' ? h('span.badge.offline', st === 'error' ? 'Error' : 'Offline') : st === 'loading' ? h('span.badge.loading', 'Loading…') : null;
    const metaParts = [];
    if (Number.isFinite(m.duration)) metaParts.push(formatShort(m.duration));
    if (m.width && m.kind !== 'audio' && m.kind !== 'adjustment') metaParts.push(`${m.width}×${m.height}`);
    if (m.fps) metaParts.push(`${m.fps}fps`);
    if (m.kind === 'video' && m.hasAudio === false) metaParts.push('no audio');
    const el = h(`div.media-item${store.ui.selectedMedia.has(id) ? '.selected' : ''}`, { draggable: true, title: m.name },
      thumb,
      h('div.name', m.name, badge),
      h('div.meta', metaParts.join(' · ')));
    el.addEventListener('click', (e) => {
      const sel = store.ui.selectedMedia;
      if (e.shiftKey && anchor) {
        const order = store.project.mediaOrder;
        const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) sel.add(order[i]);
      } else if (modKey(e)) {
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
        anchor = id;
      } else {
        sel.clear();
        sel.add(id);
        anchor = id;
      }
      render();
      store.emit('media-selection');
    });
    el.addEventListener('dblclick', () => {
      if (m.kind === 'sequence') return store.openSequence(m.sequenceId);
      if (m.kind === 'color' || m.kind === 'adjustment') return;
      if (st === 'offline' || st === 'error') return relinkOne(id);
      openInSource(id);
    });
    el.addEventListener('dragstart', (e) => {
      if (!store.ui.selectedMedia.has(id)) {
        store.ui.selectedMedia.clear();
        store.ui.selectedMedia.add(id);
      }
      const items = [...store.ui.selectedMedia].filter((x) => store.project.media[x] && mediaStatus(x) === 'ready').map((mediaId) => ({ mediaId }));
      dnd.payload = { items };
      e.dataTransfer.setData('application/x-montage-media', JSON.stringify({ items }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('dragend', () => { dnd.payload = null; });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!store.ui.selectedMedia.has(id)) {
        store.ui.selectedMedia.clear();
        store.ui.selectedMedia.add(id);
        render();
      }
      const real = m.kind !== 'color' && m.kind !== 'adjustment' && m.kind !== 'sequence';
      if (m.kind === 'sequence') {
        showMenu([
          { label: 'Open in Timeline', action: () => store.openSequence(m.sequenceId) },
          { label: 'Insert at Playhead', disabled: m.sequenceId === store.seq.id, action: () => edit.placeMedia(id, { mode: 'insert' }) },
          { label: 'Overwrite at Playhead (Nest)', disabled: m.sequenceId === store.seq.id, action: () => edit.placeMedia(id, { mode: 'overwrite' }) },
          '-',
          { label: 'Rename…', action: async () => {
            const n = await promptDialog('Rename Sequence', 'Name', m.name);
            if (n) store.transact('Rename Sequence', () => { store.project.sequences[m.sequenceId].name = n; });
          } },
          { label: 'Duplicate', action: () => edit.duplicateSequence(m.sequenceId) },
          { label: 'Delete Sequence', action: () => edit.deleteSequence(m.sequenceId) },
        ], e.clientX, e.clientY);
        return;
      }
      showMenu([
        { label: 'Open in Source Monitor', disabled: !real || st !== 'ready', action: () => openInSource(id) },
        { label: 'Insert at Playhead', key: ',', disabled: st !== 'ready', action: () => edit.placeMedia(id, { mode: 'insert' }) },
        { label: 'Overwrite at Playhead', key: '.', disabled: st !== 'ready', action: () => edit.placeMedia(id, { mode: 'overwrite' }) },
        { label: 'Append to End of Sequence', disabled: st !== 'ready', action: () => appendToEnd([...store.ui.selectedMedia]) },
        '-',
        { label: 'New Sequence Settings From Clip', disabled: !(m.width && m.kind === 'video') && m.kind !== 'image', action: () => matchSequence(m) },
        m.kind === 'color' ? { label: 'Change Color…', action: () => changeColor(id) } : null,
        { label: 'Rename…', action: async () => {
          const n = await promptDialog('Rename', 'Name', m.name);
          if (n) store.transact('Rename Media', () => { store.project.media[id].name = n; });
        } },
        { label: real ? (st === 'ready' ? 'Replace Footage…' : 'Link Media…') : 'Replace Footage…', disabled: !real, action: () => relinkOne(id) },
        { label: 'Properties…', action: () => showProperties(id) },
        '-',
        { label: 'Clear', key: 'Del', action: clearSelected },
      ], e.clientX, e.clientY);
    });
    return el;
  }

  function appendToEnd(ids) {
    for (const id of ids) {
      if (mediaStatus(id) !== 'ready') continue;
      let end = 0;
      for (const c of Object.values(store.seq.clips)) end = Math.max(end, c.start + c.duration);
      edit.placeMedia(id, { mode: 'overwrite', start: end });
    }
  }

  function matchSequence(m) {
    edit.updateSequenceSettings({ width: Math.round(m.width / 2) * 2, height: Math.round(m.height / 2) * 2, fps: m.fps ? Math.round(m.fps * 1000) / 1000 : store.seq.fps, name: store.seq.name });
    toast(`Sequence set to ${m.width}×${m.height}${m.fps ? ` @ ${m.fps} fps` : ''}`);
  }

  function changeColor(id) {
    const input = h('input', { type: 'color', value: store.project.media[id].color || '#000000' });
    openModal({
      title: 'Color Matte Color',
      body: input,
      buttons: [{ label: 'Cancel' }, {
        label: 'OK', primary: true, action: () => store.transact('Change Color', () => {
          store.project.media[id].color = input.value;
          for (const c of Object.values(store.seq.clips)) {
            if (c.mediaId === id) {
              const fx = c.effects.find((e) => e.type === 'fill');
              if (fx) fx.params.color.value = input.value;
            }
          }
        }),
      }],
    });
  }

  async function relinkOne(id) {
    const m = store.project.media[id];
    const files = await pickFiles({ multiple: false, accept: m.kind === 'image' ? 'image/*' : m.kind === 'audio' ? 'audio/*,video/*' : 'video/*,audio/*' });
    if (!files[0]) return;
    await attachFile(id, files[0]);
    store.project.media[id].name = files[0].name;
    store.changed('media');
    toast(`Linked ${files[0].name}`);
  }

  async function linkMediaDialog() {
    const files = await pickFiles();
    if (!files.length) return;
    const n = await relinkFromFiles(files);
    toast(n ? `Relinked ${n} item(s)` : 'No matching file names found');
  }

  function showProperties(id) {
    const m = store.project.media[id];
    const rt = runtime.get(id);
    const rows = [
      ['Name', m.name], ['Type', m.kind], ['Status', mediaStatus(id)], ['Duration', Number.isFinite(m.duration) ? formatTimecode(m.duration, m.fps || store.seq.fps) : 'still'],
      ['Frame size', m.width ? `${m.width} × ${m.height}` : '—'], ['Frame rate', m.fps ? `${m.fps} fps` : '—'], ['Audio', m.hasAudio ? 'yes' : 'no'],
      ['File size', m.size ? formatBytes(m.size) : '—'], ['MIME type', m.mime || '—'], ['Error', rt?.error || '—'],
      ['Used in sequence', `${Object.values(store.seq.clips).filter((c) => c.mediaId === id).length} clip(s)`],
    ];
    openModal({ title: 'Properties', body: h('div.kbd-table', rows.flatMap(([a, b]) => [h('span', a), h('span', String(b))])) });
  }

  store.on('change', () => scheduleRender());
  store.on('reveal-media', () => scheduleRender(true));
  mediaEvents.on('updated', () => scheduleRender());
  render();
  return body;
}
