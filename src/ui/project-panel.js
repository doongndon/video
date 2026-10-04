// Project panel: imported media with bins (folders), label colours, list/icon views, search,
// hover scrub and drag to the timeline.

import { store } from '../store.js';
import { runtime, mediaEvents, importFiles, createSyntheticMedia, removeMedia, attachFile, mediaStatus } from '../media.js';
import * as edit from '../edit.js';
import { relinkFromFiles } from '../persist.js';
import { LABEL_COLORS } from '../model.js';
import { h, uid, formatTimecode, formatShort, formatBytes, modKey } from '../util.js';
import { showMenu, openModal, promptDialog, confirmDialog, loadPref, savePref, toast, dnd } from './common.js';
import { icon, iconButton } from './icons.js';
import { openColorMatteDialog, openMulticamDialog, openExtractAudioDialog } from './dialogs.js';

const KIND_NAMES = { video: '영상', audio: '오디오', image: '이미지', color: '색상 매트', adjustment: '조정 레이어', sequence: '시퀀스', lut: 'LUT', font: '글꼴' };
const KIND_ICONS = { video: 'film', audio: 'audio', image: 'image', adjustment: 'wand', sequence: 'sequence', lut: 'grid', color: 'image', font: 'type' };

export function pickFiles({ accept = 'video/*,audio/*,image/*,.cube,.ttf,.otf,.woff,.woff2', multiple = true } = {}) {
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
  const closedBins = new Set(loadPref('bins.closed', []));

  const search = h('input', { type: 'search', placeholder: '이름 검색', style: { width: '130px' }, 'aria-label': '미디어 검색' });
  const viewBtn = iconButton(mode === 'list' ? 'grid' : 'list', mode === 'list' ? '아이콘 보기로 바꾸기' : '목록 보기로 바꾸기', () => {
    mode = mode === 'list' ? 'grid' : 'list';
    viewBtn.replaceChildren(icon(mode === 'list' ? 'grid' : 'list'));
    viewBtn.title = mode === 'list' ? '아이콘 보기로 바꾸기' : '목록 보기로 바꾸기';
    savePref('project.view', mode);
    render();
  });
  const importBtn = iconButton('import', '파일 가져오기 (Ctrl+I)', () => importDialog(), { label: '가져오기', cls: 'boxed' });
  const binBtn = iconButton('folderPlus', '새 저장소(폴더) 만들기', () => newBin());
  const newBtn = iconButton('plus', '새 항목 (색상 매트, 조정 레이어, 시퀀스…)', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(newItemMenu(), r.left, r.bottom + 2);
  }, { label: '새 항목', cls: 'boxed' });
  const toolbar = h('div.panel-toolbar', importBtn, newBtn, binBtn, h('span.grow'), search, viewBtn);
  const list = h('div.project-list', { tabindex: 0, 'aria-label': '프로젝트 미디어 목록' });
  const footer = h('div.panel-footer');
  const body = h('div', toolbar, list, footer);

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
    showMenu([{ label: '가져오기…', key: 'Ctrl+I', action: importDialog }, { label: '새 저장소(폴더)…', action: newBin }, '-', ...newItemMenu()], e.clientX, e.clientY);
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
      { label: '색상 매트 (단색 배경)…', action: openColorMatteDialog },
      { label: '검정 화면', action: () => createSyntheticMedia('color', { name: '검정 화면', color: '#000000' }) },
      { label: '조정 레이어 (아래 트랙 전체에 효과)', action: () => createSyntheticMedia('adjustment', { name: '조정 레이어' }) },
      { label: '새 시퀀스', action: () => edit.newSequence() },
      '-',
      { label: '텍스트 (재생헤드 위치)', action: () => edit.addTextClip() },
      { label: '사각형 (재생헤드 위치)', action: () => edit.addShapeClip('rectangle') },
      { label: '원 (재생헤드 위치)', action: () => edit.addShapeClip('ellipse') },
    ];
  }

  // ---- bins
  async function newBin() {
    const n = await promptDialog('새 저장소', '저장소 이름', `저장소 ${Object.keys(store.project.bins || {}).length + 1}`);
    if (!n) return;
    const id = uid('bin');
    const ids = [...store.ui.selectedMedia];
    store.transact('저장소 만들기', () => {
      store.project.bins = store.project.bins || {};
      store.project.bins[id] = { id, name: n };
      for (const mid of ids) if (store.project.media[mid]) store.project.media[mid].bin = id;
    });
  }

  function moveToBin(ids, binId) {
    store.transact(binId ? '저장소로 옮기기' : '저장소에서 꺼내기', () => {
      for (const id of ids) {
        const m = store.project.media[id];
        if (m) m.bin = binId || null;
      }
    });
  }

  function deleteBin(binId) {
    store.transact('저장소 삭제', () => {
      delete store.project.bins[binId];
      for (const m of Object.values(store.project.media)) if (m.bin === binId) m.bin = null;
    });
  }

  function setMediaLabel(ids, color) {
    store.transact('레이블 색상', () => {
      for (const id of ids) if (store.project.media[id]) store.project.media[id].label = color || null;
    });
  }

  async function clearSelected() {
    const ids = [...store.ui.selectedMedia];
    const used = Object.values(store.project.sequences).flatMap((sq) => Object.values(sq.clips)).filter((c) => ids.includes(c.mediaId)).length;
    if (used && !(await confirmDialog('미디어 지우기', `이 미디어를 쓰는 클립 ${used}개도 시퀀스에서 함께 지워집니다. 계속할까요?`))) return;
    removeMedia(ids);
    store.ui.selectedMedia.clear();
  }

  function openInSource(id) {
    const m = store.project.media[id];
    if (!m) return;
    if (m.kind === 'lut') {
      toast('LUT는 클립에 적용해서 씁니다: 클립을 선택하고 오른쪽 클릭 ▸ 선택한 클립에 LUT 적용');
      return;
    }
    if (m.kind === 'font') {
      toast(`"${m.fontFamily || m.name}" 글꼴은 텍스트 클립의 효과 컨트롤 ▸ 글꼴 목록(내 글꼴)에서 고를 수 있습니다`);
      return;
    }
    store.ui.sourceMediaId = id;
    store.ui.sourceSeek = null;
    store.emit('source');
  }

  function applyFont(id) {
    const family = store.project.media[id]?.fontFamily;
    const ids = store.selectedClips().filter((c) => c.kind === 'text').map((c) => c.id);
    if (!family) return;
    if (!ids.length) {
      toast('타임라인에서 글꼴을 바꿀 텍스트 클립을 먼저 선택하세요');
      return;
    }
    store.transact('글꼴 적용', () => {
      for (const cid of ids) {
        const fx = store.seq.clips[cid]?.effects.find((e) => e.type === 'text');
        if (fx) fx.params.font.value = family;
      }
    });
    store.emit('reveal-effect-controls');
  }

  function applyLut(id) {
    const ids = store.selectedClips().filter((c) => c.kind !== 'audio').map((c) => c.id);
    if (!ids.length) {
      toast('타임라인에서 LUT를 적용할 클립을 먼저 선택하세요');
      return;
    }
    store.transact('LUT 적용', () => {
      for (const cid of ids) {
        const c = store.seq.clips[cid];
        if (!c) continue;
        let fx = c.effects.find((e) => e.type === 'lut');
        if (!fx) {
          edit.addEffect([cid], 'lut');
          fx = store.seq.clips[cid].effects.filter((e) => e.type === 'lut').pop();
        }
        if (fx) fx.params.lutId.value = id;
      }
    });
    store.emit('reveal-effect-controls');
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
      const sig = [mode, filter, [...store.ui.selectedMedia].join(','), JSON.stringify(proj.bins || {}), ...proj.mediaOrder.map((id) => {
        const m = proj.media[id];
        const rt = runtime.get(id);
        return m ? `${id}:${m.name}:${m.duration}:${m.width}:${m.color}:${m.bin}:${m.label}:${mediaStatus(id)}:${rt?.thumb ? 1 : 0}:${rt?.filmstrip?.length || 0}` : id;
      })].join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      render();
    });
  }

  function render() {
    const proj = store.project;
    const bins = proj.bins || {};
    list.className = `project-list ${mode === 'grid' ? 'grid' : ''}`;
    list.replaceChildren();
    const visible = (id) => proj.media[id] && (!filter || proj.media[id].name.toLowerCase().includes(filter));
    if (!proj.mediaOrder.length) {
      list.append(h('div.empty-hint', h('b', '여기에 영상·소리·사진 파일을 끌어다 놓으세요'), h('br'), '또는 위의 "가져오기" 버튼 / Ctrl+I'));
    }
    for (const bin of Object.values(bins)) {
      const inBin = proj.mediaOrder.filter((id) => proj.media[id]?.bin === bin.id);
      const shown = inBin.filter(visible);
      if (filter && !shown.length) continue;
      list.append(renderBin(bin, inBin.length));
      if (!closedBins.has(bin.id) || filter) for (const id of shown) list.append(renderItem(id, true));
    }
    for (const id of proj.mediaOrder.filter((x) => visible(x) && !(proj.media[x].bin && bins[proj.media[x].bin]))) list.append(renderItem(id, false));
    const offline = proj.mediaOrder.filter((id) => ['offline', 'error'].includes(mediaStatus(id))).length;
    const nSel = store.ui.selectedMedia.size;
    footer.replaceChildren(...[
      h('span', `항목 ${proj.mediaOrder.length}개${nSel > 1 ? ` · ${nSel}개 선택` : ''}`),
      offline ? h('span', { style: { color: 'var(--danger)' } }, ` · 오프라인 ${offline}개`) : null,
      h('span.grow'),
      offline ? h('button', { onclick: linkMediaDialog }, '미디어 다시 연결…') : null,
    ].filter(Boolean));
  }

  function renderBin(bin, count) {
    const closed = closedBins.has(bin.id) && !filter;
    const twisty = h('span.twisty', closed ? '▸' : '▾');
    const el = h('div.media-item.bin', { title: `${bin.name} — 항목을 끌어다 놓아 넣기` }, twisty, h('div.name', icon('folder'), bin.name), h('div.meta', `${count}개`));
    const toggle = () => {
      if (closedBins.has(bin.id)) closedBins.delete(bin.id);
      else closedBins.add(bin.id);
      savePref('bins.closed', [...closedBins]);
      render();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('dragover', (e) => {
      if (!dnd.payload?.items?.length && !dnd.payload?.mediaIds) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target');
      const ids = dnd.payload?.mediaIds;
      if (!ids?.length) return;
      e.preventDefault();
      e.stopPropagation();
      moveToBin(ids, bin.id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([
        { label: '이름 바꾸기…', action: async () => {
          const n = await promptDialog('저장소 이름 바꾸기', '이름', bin.name);
          if (n) store.transact('저장소 이름 바꾸기', () => { if (store.project.bins[bin.id]) store.project.bins[bin.id].name = n; });
        } },
        { label: '저장소 삭제 (안의 항목은 남김)', action: () => deleteBin(bin.id) },
      ], e.clientX, e.clientY);
    });
    return el;
  }

  function renderItem(id, inBin) {
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
      thumb.append(icon(KIND_ICONS[m.kind] || 'film', 20));
      if (m.kind === 'sequence') thumb.style.background = '#33421a';
      if (m.kind === 'lut') thumb.style.background = 'linear-gradient(135deg,#2b4a7a,#7a2b5c,#7a6a2b)';
    }
    const badge = st === 'offline' || st === 'error' ? h('span.badge.offline', st === 'error' ? '오류' : '오프라인') : st === 'loading' ? h('span.badge.loading', '불러오는 중…') : null;
    const metaParts = [KIND_NAMES[m.kind] || m.kind];
    if (Number.isFinite(m.duration)) metaParts.push(formatShort(m.duration));
    if (m.width && !['audio', 'adjustment', 'lut', 'font'].includes(m.kind)) metaParts.push(`${m.width}×${m.height}`);
    if (m.kind === 'font' && m.fontFamily) metaParts.push(m.fontFamily);
    if (m.fps) metaParts.push(`${Math.round(m.fps * 100) / 100}fps`);
    if (m.kind === 'video' && m.hasAudio === false) metaParts.push('소리 없음');
    if (m.kind === 'sequence' && store.project.sequences[m.sequenceId]?.multicam) metaParts.unshift('멀티캠');
    const canPlace = st === 'ready' && !['lut', 'font'].includes(m.kind) && !(m.kind === 'sequence' && m.sequenceId === store.seq.id);
    const addBtn = canPlace ? h('button.m-place', {
      title: '재생헤드 위치에 넣기', 'aria-label': `${m.name} 타임라인에 넣기`,
      onclick: (e) => {
        e.stopPropagation();
        const ids = edit.placeMedia(id, { mode: 'insert' });
        if (ids.length) toast(`${m.name}을(를) 넣었습니다`);
      },
    }, '넣기') : null;
    const el = h(`div.media-item${store.ui.selectedMedia.has(id) ? '.selected' : ''}${inBin ? '.in-bin' : ''}`, { draggable: true, title: m.name },
      thumb,
      h('div.name', m.label ? h('span.label-dot', { style: { background: m.label } }) : null, h('span', m.name), badge),
      h('div.meta', metaParts.join(' · '), addBtn));
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
      const selected = [...store.ui.selectedMedia].filter((x) => store.project.media[x]);
      const items = selected.filter((x) => mediaStatus(x) === 'ready' && !['lut', 'font'].includes(store.project.media[x].kind)).map((mediaId) => ({ mediaId }));
      dnd.payload = { items, mediaIds: selected };
      e.dataTransfer.setData('application/x-montage-media', JSON.stringify({ items }));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    el.addEventListener('dragend', () => { dnd.payload = null; });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!store.ui.selectedMedia.has(id)) {
        store.ui.selectedMedia.clear();
        store.ui.selectedMedia.add(id);
        render();
      }
      const selIds = [...store.ui.selectedMedia];
      const bins = Object.values(store.project.bins || {});
      const common = [
        { label: '레이블 색상', submenu: LABEL_COLORS.map(([c, n]) => ({ label: n, swatch: c || 'transparent', checked: (m.label || '') === c, action: () => setMediaLabel(selIds, c) })) },
        { label: '저장소로 옮기기', submenu: [
          { label: '(맨 위 — 저장소 밖)', checked: !m.bin, action: () => moveToBin(selIds, null) },
          ...bins.map((b) => ({ label: b.name, checked: m.bin === b.id, action: () => moveToBin(selIds, b.id) })),
          '-',
          { label: '새 저장소 만들어 옮기기…', action: newBin },
        ] },
      ];
      if (m.kind === 'sequence') {
        showMenu([
          { label: '타임라인에서 열기', action: () => store.openSequence(m.sequenceId) },
          { label: '재생헤드에 삽입', disabled: m.sequenceId === store.seq.id, action: () => edit.placeMedia(id, { mode: 'insert' }) },
          { label: '재생헤드에 덮어쓰기 (중첩)', disabled: m.sequenceId === store.seq.id, action: () => edit.placeMedia(id, { mode: 'overwrite' }) },
          '-',
          { label: '이름 바꾸기…', action: async () => {
            const n = await promptDialog('시퀀스 이름 바꾸기', '이름', m.name);
            if (n) store.transact('시퀀스 이름 바꾸기', () => { store.project.sequences[m.sequenceId].name = n; });
          } },
          { label: '복제', action: () => edit.duplicateSequence(m.sequenceId) },
          { label: '시퀀스 삭제', action: () => edit.deleteSequence(m.sequenceId) },
          '-',
          ...common,
        ], e.clientX, e.clientY);
        return;
      }
      if (m.kind === 'font') {
        showMenu([
          { label: '선택한 텍스트 클립에 이 글꼴 적용', action: () => applyFont(id) },
          { label: '이름 바꾸기…', action: () => rename(id) },
          '-',
          ...common,
          '-',
          { label: '지우기', key: 'Del', action: clearSelected },
        ], e.clientX, e.clientY);
        return;
      }
      if (m.kind === 'lut') {
        showMenu([
          { label: '선택한 클립에 LUT 적용', action: () => applyLut(id) },
          { label: '이름 바꾸기…', action: () => rename(id) },
          '-',
          ...common,
          '-',
          { label: '지우기', key: 'Del', action: clearSelected },
        ], e.clientX, e.clientY);
        return;
      }
      const real = m.kind !== 'color' && m.kind !== 'adjustment';
      const videos = selIds.filter((x) => store.project.media[x]?.kind === 'video');
      showMenu([
        { label: '소스 모니터에서 열기', disabled: !real || st !== 'ready', action: () => openInSource(id) },
        { label: '재생헤드에 삽입', key: ',', disabled: st !== 'ready', action: () => edit.placeMedia(id, { mode: 'insert' }) },
        { label: '재생헤드에 덮어쓰기', key: '.', disabled: st !== 'ready', action: () => edit.placeMedia(id, { mode: 'overwrite' }) },
        { label: '시퀀스 끝에 이어 붙이기', disabled: st !== 'ready', action: () => appendToEnd(selIds) },
        '-',
        { label: '오디오 추출 (소리만 따로 만들기)…', disabled: !['video', 'audio'].includes(m.kind) || !m.hasAudio || st !== 'ready', action: () => openExtractAudioDialog({ mediaId: id }) },
        { label: `멀티캠 소스 시퀀스 만들기… (${videos.length}개 선택)`, disabled: videos.length < 2, action: openMulticamDialog },
        { label: '이 클립에 맞춰 시퀀스 설정 바꾸기', disabled: !(m.width && m.kind === 'video') && m.kind !== 'image', action: () => matchSequence(m) },
        m.kind === 'color' ? { label: '색상 바꾸기…', action: () => changeColor(id) } : null,
        { label: '이름 바꾸기…', action: () => rename(id) },
        { label: real ? (st === 'ready' ? '다른 파일로 바꾸기…' : '미디어 다시 연결…') : '다른 파일로 바꾸기…', disabled: !real, action: () => relinkOne(id) },
        { label: '속성…', action: () => showProperties(id) },
        '-',
        ...common,
        '-',
        { label: '지우기', key: 'Del', action: clearSelected },
      ], e.clientX, e.clientY);
    });
    return el;
  }

  async function rename(id) {
    const m = store.project.media[id];
    const n = await promptDialog('이름 바꾸기', '이름', m.name);
    if (n) store.transact('미디어 이름 바꾸기', () => { store.project.media[id].name = n; });
  }

  function appendToEnd(ids) {
    for (const id of ids) {
      if (mediaStatus(id) !== 'ready' || ['lut', 'font'].includes(store.project.media[id]?.kind)) continue;
      let end = 0;
      for (const c of Object.values(store.seq.clips)) end = Math.max(end, c.start + c.duration);
      edit.placeMedia(id, { mode: 'overwrite', start: end });
    }
  }

  function matchSequence(m) {
    edit.updateSequenceSettings({ width: Math.round(m.width / 2) * 2, height: Math.round(m.height / 2) * 2, fps: m.fps ? Math.round(m.fps * 1000) / 1000 : store.seq.fps, name: store.seq.name });
    toast(`시퀀스를 ${m.width}×${m.height}${m.fps ? ` · ${Math.round(m.fps * 100) / 100} fps` : ''}로 바꿨습니다`);
  }

  function changeColor(id) {
    const input = h('input', { type: 'color', value: store.project.media[id].color || '#000000' });
    openModal({
      title: '색상 매트 색 바꾸기',
      body: input,
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => store.transact('색상 바꾸기', () => {
          store.project.media[id].color = input.value;
          for (const sq of Object.values(store.project.sequences)) {
            for (const c of Object.values(sq.clips)) {
              if (c.mediaId !== id) continue;
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
    toast(`${files[0].name} 파일로 연결했습니다`);
  }

  async function linkMediaDialog() {
    const files = await pickFiles();
    if (!files.length) return;
    const n = await relinkFromFiles(files);
    toast(n ? `${n}개 항목을 다시 연결했습니다` : '이름이 같은 파일을 찾지 못했습니다');
  }

  function showProperties(id) {
    const m = store.project.media[id];
    const rt = runtime.get(id);
    const statusName = { ready: '사용 가능', loading: '불러오는 중', offline: '오프라인 (파일 연결 필요)', error: '오류', missing: '없음' }[mediaStatus(id)] || mediaStatus(id);
    const used = Object.values(store.project.sequences).reduce((n, sq) => n + Object.values(sq.clips).filter((c) => c.mediaId === id).length, 0);
    const rows = [
      ['이름', m.name], ['종류', KIND_NAMES[m.kind] || m.kind], ['상태', statusName], ['길이', Number.isFinite(m.duration) ? formatTimecode(m.duration, m.fps || store.seq.fps) : '정지 화면'],
      ['화면 크기', m.width ? `${m.width} × ${m.height}` : '—'], ['프레임 속도', m.fps ? `${m.fps} fps` : '—'], ['소리', m.hasAudio ? '있음' : '없음'],
      ['파일 크기', m.size ? formatBytes(m.size) : '—'], ['파일 형식', m.mime || '—'], ['오류 내용', rt?.error || '—'],
      ['사용 중인 클립', `${used}개 (모든 시퀀스)`],
    ];
    openModal({ title: '속성', body: h('div.kbd-table', rows.flatMap(([a, b]) => [h('span', a), h('span', String(b))])) });
  }

  store.on('change', () => scheduleRender());
  store.on('reveal-media', () => scheduleRender(true));
  mediaEvents.on('updated', () => scheduleRender());
  render();
  return body;
}
