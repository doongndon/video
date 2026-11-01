// Premiere Pro's header bar (2022+): 홈 | 가져오기 | 편집 | 내보내기 modes on the left, the project
// name in the middle and the workspace tabs (편집, 색상, 효과 …) on the right. 가져오기 and 내보내기 are
// full-area pages over the panels: a media browser that stages files before importing them (with
// 새 빈 / 새 시퀀스 만들기), and the export settings with a preview. 홈 is the start screen (home.js).

import { h, formatTimecode, formatBytes, debounce, uid } from '../util.js';
import { store } from '../store.js';
import { playback } from '../playback.js';
import { commands as c } from '../commands.js';
import * as edit from '../edit.js';
import { guessKind } from '../media.js';
import { sequenceDuration } from '../model.js';
import { listProjects, currentProjectId, storedFile } from '../persist.js';
import { appMode } from '../mode.js';
import { showMenu, toast, loadPref, savePref, showPanel, isMaximized, toggleMaximize } from './common.js';
import { icon } from './icons.js';
import { allWorkspaces, currentWorkspace, applyWorkspace, resetWorkspace, saveWorkspaceAs, workspaceMenuItem } from './workspaces.js';
import { pickFiles, importAny } from './project-panel.js';
import { openExportSettings } from './export-dialog.js';
import { buildHomePage, newProjectDialog, ago } from './home.js';

const MODES = [['import', '가져오기'], ['edit', '편집'], ['export', '내보내기']];
let mode = 'edit';
const pages = {};
let header = null;
let refreshTabs = () => {};

/** For other modules (tutorials, menus): the mode on screen and a way to switch. */
export const headerApi = { mode: () => mode, go: (m) => setHeaderMode(m), stage: null };

const phone = () => document.body.classList.contains('mobile');

export function setHeaderMode(next) {
  if (!['home', 'import', 'edit', 'export'].includes(next)) next = 'edit';
  if (next !== 'edit' && appMode.isPhoto()) return;
  const prev = mode;
  mode = next;
  document.body.dataset.hmode = next;
  for (const b of header?.querySelectorAll('[data-hmode]') || []) {
    const on = b.dataset.hmode === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  if (next !== 'edit') {
    playback.stop?.();
    if (isMaximized()) toggleMaximize();
  }
  for (const [id, p] of Object.entries(pages)) {
    p.el.hidden = id !== next;
    if (id === next && prev !== next) p.show?.();
    if (id === prev && prev !== next) p.hide?.();
  }
  if (next !== 'edit') setTimeout(() => pages[next]?.el.focus({ preventScroll: true }), 0);
  if (next === 'edit') {
    playback.requestRender();
    window.dispatchEvent(new Event('resize'));
  }
  refreshTabs();
}

// keys typed on a page stay there (Space must not play the hidden timeline); shortcuts with
// Ctrl / Alt still work
function pageEl(cls, id) {
  const el = h(`div.hm-page.${cls}`, { 'data-page': id, tabindex: -1, hidden: true });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input, select, textarea')) {
      e.preventDefault();
      setHeaderMode('edit');
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
  });
  return el;
}

// ---------------------------------------------------------------- 가져오기

function buildImportPage() {
  const el = pageEl('import-page', 'import');
  let staged = []; // [{file, url, on}]
  const grid = h('div.im-grid');
  const count = h('span.im-count');
  const importBtn = h('button.primary.im-go', '가져오기');
  const binOn = h('input', { type: 'checkbox' });
  const binName = h('input', { type: 'text', value: '새 저장소', 'aria-label': '새 저장소 이름' });
  const seqOn = h('input', { type: 'checkbox', checked: loadPref('import.newSeq', true) });
  const seqName = h('input', { type: 'text', value: '시퀀스 01', 'aria-label': '새 시퀀스 이름' });
  const recentBox = h('div.im-recent');
  const projLine = h('div.im-proj');

  const add = (files) => {
    let skipped = 0;
    for (const f of files) {
      if (!guessKind(f) && !/\.srt$/i.test(f.name)) {
        skipped++;
        continue;
      }
      if (staged.some((s) => s.file.name === f.name && s.file.size === f.size)) continue;
      staged.push({ file: f, url: URL.createObjectURL(f), on: true });
    }
    if (skipped) toast(`가져올 수 없는 파일 ${skipped}개는 뺐습니다`);
    paint();
  };
  headerApi.stage = add;
  const clear = () => {
    for (const s of staged) URL.revokeObjectURL(s.url);
    staged = [];
    paint();
  };

  function tile(s) {
    const kind = guessKind(s.file) || 'captions';
    const media = kind === 'image' ? h('img', { src: s.url, alt: '' })
      : kind === 'video' ? h('video', { src: `${s.url}#t=0.5`, muted: true, preload: 'metadata' })
        : icon(kind === 'audio' ? 'audio' : kind === 'captions' ? 'captions' : 'film', 28);
    const box = h('input', { type: 'checkbox', checked: s.on, 'aria-label': `${s.file.name} 고르기`, onchange: () => { s.on = box.checked; t.classList.toggle('off', !s.on); paintCount(); } });
    const t = h(`div.im-tile${s.on ? '' : '.off'}`, { title: `${s.file.name} · ${formatBytes(s.file.size)}` },
      h('div.im-th', media, box),
      h('div.im-name', s.file.name),
      h('div.im-meta', `${({ video: '비디오', audio: '오디오', image: '이미지', lut: 'LUT', font: '글꼴' })[kind] || '캡션'} · ${formatBytes(s.file.size)}`));
    t.addEventListener('click', (e) => {
      if (e.target === box) return;
      box.checked = !box.checked;
      box.onchange();
    });
    return t;
  }

  function paintCount() {
    const n = staged.filter((s) => s.on).length;
    count.textContent = staged.length ? `${staged.length}개 중 ${n}개 선택` : '';
    importBtn.disabled = !n;
    importBtn.textContent = n ? `가져오기 (${n})` : '가져오기';
  }

  function paint() {
    grid.replaceChildren(...staged.map(tile));
    el.classList.toggle('has-files', staged.length > 0);
    paintCount();
  }

  async function paintRecent() {
    // the next free 시퀀스 NN name (a new project's empty sequence is replaced, so its name is free)
    const seqs = Object.values(store.project.sequences);
    const replaced = seqs.length === 1 && !Object.keys(seqs[0].clips).length;
    const names = new Set(replaced ? [] : seqs.map((q) => q.name));
    let n = 1;
    while (names.has(`시퀀스 ${String(n).padStart(2, '0')}`)) n++;
    seqName.value = `시퀀스 ${String(n).padStart(2, '0')}`;
    // and a bin name not used yet (a second import made another "새 저장소")
    const bins = new Set(Object.values(store.project.bins || {}).map((b) => b.name));
    let b = 1;
    while (bins.has(b > 1 ? `새 저장소 ${b}` : '새 저장소')) b++;
    binName.value = b > 1 ? `새 저장소 ${b}` : '새 저장소';
    projLine.replaceChildren(icon('film', 14), h('span', `프로젝트: ${store.project.name}`), h('span.note', ' · 이 브라우저에 저장'));
    const here = new Set(store.project.mediaOrder.map((id) => `${store.project.media[id]?.name}|${store.project.media[id]?.size}`));
    const seen = new Set();
    const rows = [];
    for (const r of await listProjects().catch(() => [])) {
      if (r.id === currentProjectId()) continue;
      for (const m of r.media || []) {
        const key = `${m.name}|${m.size}`;
        if (seen.has(key) || here.has(key) || !['video', 'audio', 'image'].includes(m.kind)) continue;
        seen.add(key);
        rows.push({ m, r });
      }
    }
    recentBox.replaceChildren(...(rows.length ? rows.slice(0, 40).map(({ m, r }) => h('button.im-recent-row', {
      title: `${m.name}\n${r.name} 프로젝트 · ${ago(r.modified)}`,
      onclick: async () => {
        const f = await storedFile(m.id);
        if (f) add([f instanceof File ? f : new File([f], m.name, { type: f.type })]);
        else toast('이 파일은 브라우저에 저장되어 있지 않습니다');
      },
    }, icon(m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'film', 14), h('span', m.name), h('small', r.name))) : [h('div.note', '다른 프로젝트에서 가져온 미디어가 여기에 나옵니다. 누르면 다시 고르지 않고 바로 담깁니다.')]));
  }

  const pickFolder = () => {
    const input = h('input', { type: 'file', multiple: true });
    input.webkitdirectory = true;
    input.addEventListener('change', () => add([...input.files]));
    input.click();
  };

  importBtn.addEventListener('click', async () => {
    const files = staged.filter((s) => s.on).map((s) => s.file);
    if (!files.length) return;
    importBtn.disabled = true;
    try {
      savePref('import.newSeq', seqOn.checked);
      const before = new Set(store.project.mediaOrder);
      const ids = (await importAny(files)) || [];
      const fresh = ids.filter((id) => store.project.media[id] && !before.has(id));
      if (binOn.checked && fresh.length) {
        const bin = uid('bin');
        store.transact('저장소 만들기', () => {
          store.project.bins = store.project.bins || {};
          store.project.bins[bin] = { id: bin, name: binName.value.trim() || '새 저장소' };
          for (const id of fresh) store.project.media[id].bin = bin;
        });
      }
      const placeable = fresh.filter((id) => ['video', 'audio', 'image'].includes(store.project.media[id].kind));
      if (seqOn.checked && placeable.length) {
        const first = placeable.find((id) => store.project.media[id].kind !== 'audio') || placeable[0];
        // a new project's empty starting sequence gives way to the one made from the media
        const empty = !Object.keys(store.seq.clips).length && Object.keys(store.project.sequences).length === 1 ? store.seq.id : null;
        const sid = edit.newSequenceFromMedia(first);
        if (sid) {
          if (empty) edit.deleteSequence(empty);
          const name = seqName.value.trim();
          if (name) store.transact('시퀀스 이름 바꾸기', () => { store.project.sequences[sid].name = name; });
          for (const id of placeable) if (id !== first) edit.placeMedia(id, { mode: 'overwrite', start: sequenceDuration(store.seq) });
          store.setPlayhead(0);
        }
      }
      clear();
      setHeaderMode('edit');
      showPanel('project');
      toast(fresh.length ? `${fresh.length}개를 가져왔습니다${seqOn.checked && placeable.length ? ' · 새 시퀀스에 넣었습니다' : ''}` : '가져온 파일이 없습니다');
    } finally {
      paintCount();
    }
  });

  // dropping files on this page stages them (the window's own drop would import right away)
  el.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    add([...e.dataTransfer.files]);
  });

  el.append(
    h('aside.im-side',
      h('h3', '가져오기 위치'),
      h('button.im-src', { onclick: async () => add(await pickFiles()) }, icon('fileOpen', 16), '파일 선택…'),
      h('button.im-src', { onclick: pickFolder }, icon('folder', 16), '폴더 선택…'),
      h('h3', '최근 가져온 미디어'),
      recentBox),
    h('section.im-main',
      projLine,
      h('div.im-drop', { onclick: async () => add(await pickFiles()) },
        icon('import', 32),
        h('b', '미디어를 여기로 끌어 놓으세요'),
        h('span', '또는 눌러서 파일 선택 · 영상, 오디오, 이미지, 자막(.srt), LUT, 글꼴')),
      h('div.im-tools', h('b', '고른 미디어'), h('span.grow'),
        h('button.small', { onclick: () => { for (const s of staged) s.on = true; paint(); } }, '모두 선택'),
        h('button.small', { onclick: clear }, '목록 비우기')),
      grid),
    h('aside.im-settings',
      h('h3', '가져오기 설정'),
      h('label.check.im-opt', binOn, ' 새 저장소 만들기'),
      binName,
      h('label.check.im-opt', seqOn, ' 새 시퀀스 만들기'),
      seqName,
      h('p.note', '새 시퀀스는 첫 영상(또는 이미지)의 크기와 프레임 속도로 만들고, 고른 순서대로 이어 붙입니다.'),
      h('div.grow'),
      count,
      h('div.im-btns', h('button', { onclick: () => setHeaderMode('edit') }, '닫기'), importBtn)));
  paint();
  return { el, show: paintRecent };
}

// ---------------------------------------------------------------- 내보내기

function buildExportPage() {
  const el = pageEl('export-page', 'export');
  const mount = h('div.ex-settings');
  const img = h('img.ex-img', { alt: '내보내기 미리 보기' });
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': '미리 보기 위치' });
  const tc = h('span.tc');
  const durEl = h('span.tc.dur');
  const info = h('div.ex-info');
  let busy = false;
  let again = false;
  let url = null;
  let t = 0;

  const render = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const { sampleFrames } = await import('../export.js');
      const [shot] = await sampleFrames(store.seq, [t], { maxSide: 960, quality: 0.85 });
      if (url) URL.revokeObjectURL(url);
      url = shot?.blob ? URL.createObjectURL(shot.blob) : null;
      if (url) img.src = url;
    } catch (err) {
      console.warn('export preview', err);
    } finally {
      busy = false;
      if (again) {
        again = false;
        render();
      }
    }
  };
  const later = debounce(render, 120);
  slider.addEventListener('input', () => {
    const s = store.seq;
    const dur = sequenceDuration(s);
    t = Math.round((slider.value / 1000) * dur * s.fps) / s.fps;
    tc.textContent = formatTimecode(t, s.fps);
    later();
  });

  const show = () => {
    const s = store.seq;
    const dur = sequenceDuration(s);
    t = Math.min(store.ui.playhead, dur);
    slider.value = dur ? Math.round((t / dur) * 1000) : 0;
    tc.textContent = formatTimecode(t, s.fps);
    durEl.textContent = formatTimecode(dur, s.fps);
    info.replaceChildren(
      h('div', h('span', '시퀀스'), h('b', s.name || '시퀀스')),
      h('div', h('span', '프레임 크기'), h('b', `${s.width} × ${s.height}`)),
      h('div', h('span', '프레임 속도'), h('b', `${s.fps} fps`)),
      h('div', h('span', '길이'), h('b', formatTimecode(dur, s.fps))),
      ...(s.inPoint != null || s.outPoint != null ? [h('div', h('span', '시작/끝 표시'), h('b', `${formatTimecode(s.inPoint ?? 0, s.fps)} ~ ${formatTimecode(s.outPoint ?? dur, s.fps)}`))] : []));
    // fresh settings each time: the sequence may have changed
    mount.replaceChildren();
    openExportSettings({ mount });
    render();
  };
  // 닫기 in the settings: back to editing
  mount.addEventListener('modal-closed', () => { if (mode === 'export') setHeaderMode('edit'); });

  el.append(mount, h('section.ex-preview',
    h('div.ex-head', h('h3', '미리 보기'), h('span.grow'), h('span.note', '내보낼 화면 그대로')),
    h('div.ex-view', img),
    h('div.ex-scrub', tc, slider, durEl),
    info));
  return { el, show };
}

// ---------------------------------------------------------------- the bar

// 작업 영역 (Premiere 2025: the icon at the right of the header): the workspaces with their
// Alt+Shift+number keys, then reset / save / delete
function openWorkspaceMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const items = workspaceMenuItem().submenu().map((it) => (it && it.action && allWorkspaces().some((w) => w.name === it.label)
    ? { ...it, action: () => { it.action(); setHeaderMode('edit'); } }
    : it));
  showMenu(items, Math.max(4, r.right - 280), r.bottom + 2);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => toast('이 브라우저에서는 전체 화면을 쓸 수 없습니다'));
}

export function initHeaderModes() {
  const ws = document.getElementById('workspace');
  const home = buildHomePage({
    go: setHeaderMode,
    newProject: () => newProjectDialog({ onCreated: (goImport) => setHeaderMode(goImport ? 'import' : 'edit') }),
    // cancelling the file picker or the confirm question stays on the home screen
    openFile: async () => {
      const was = store.project;
      await c.openProject();
      if (store.project !== was && mode === 'home') setHeaderMode('edit');
    },
    sample: async () => {
      const was = store.project;
      await c.loadSample();
      if (store.project !== was && mode === 'home') setHeaderMode('edit');
    },
  });
  // files dropped on the home screen go to the import page
  home.el.addEventListener('dragover', (e) => e.preventDefault());
  home.el.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    setHeaderMode('import');
    headerApi.stage?.([...e.dataTransfer.files]);
  });
  home.el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input, select, textarea')) {
      e.preventDefault();
      setHeaderMode('edit');
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
  });
  pages.home = { el: home.el, show: home.refresh };
  home.el.hidden = true;
  pages.import = buildImportPage();
  pages.export = buildExportPage();
  for (const p of Object.values(pages)) ws.append(p.el);

  const btn = (id, label) => h('button.hm-mode', { 'data-hmode': id, 'aria-pressed': 'false', onclick: () => setHeaderMode(id) }, label);
  const homeBtn = h('button.hm-mode.hm-home', { 'data-hmode': 'home', 'aria-pressed': 'false', title: '홈', 'aria-label': '홈', onclick: () => setHeaderMode('home') }, icon('homeIcon', 16));
  // the project name in the middle, "- 편집됨" after changes not yet saved as a project file
  // (Ctrl+S) — the browser keeps an automatic copy all the time
  const titleName = h('span.hm-name');
  const titleEdited = h('span.hm-edited', ' - 편집됨');
  const title = h('button.hm-title', { onclick: () => c.renameProject() }, titleName, titleEdited);
  const iconBtn = (ic, label, fn, extra = {}) => h('button.hm-icon', { type: 'button', title: label, 'aria-label': label, onclick: (e) => fn(e.currentTarget), ...extra }, icon(ic, 16));
  const wsMenu = iconBtn('workspace', '작업 영역 (Alt+Shift+1~9로 바꾸기)', openWorkspaceMenu, { 'aria-haspopup': 'menu' });
  wsMenu.classList.add('hm-ws-menu');
  const wsName = h('span.hm-ws-name', { onclick: () => openWorkspaceMenu(wsMenu), title: '작업 영역' });
  const quickBtn = iconBtn('share', '빠른 내보내기 (편집 화면에서 바로 파일 만들기)', () => (appMode.isPhoto() ? appMode.P?.exportDialog() : openExportSettings()));
  const fullBtn = iconBtn('maximize', '전체 화면 (다시 누르거나 Esc로 돌아가기)', toggleFullscreen);
  header = h('header#pr-header', { 'aria-label': '헤더 표시줄' },
    h('nav.hm-modes', { 'aria-label': '모드' }, homeBtn, ...MODES.map(([id, label]) => btn(id, label))),
    title,
    h('div.hm-right', wsName, wsMenu, quickBtn, fullBtn));
  document.getElementById('menubar').after(header);
  const paintWs = () => {
    const cur = allWorkspaces().find((w) => w.id === currentWorkspace());
    wsName.textContent = cur ? cur.name : '';
  };
  window.addEventListener('montage:workspace', paintWs);
  refreshTabs = () => { wsName.hidden = mode !== 'edit'; };
  let edited = false;
  let savedAt = null;
  const paintTitle = () => {
    titleName.textContent = store.project.name || '제목 없는 프로젝트';
    titleEdited.hidden = !edited;
    title.title = `${store.project.name || '제목 없는 프로젝트'} (눌러서 이름 바꾸기)\n${edited ? '프로젝트 파일로 저장하지 않은 변경 내용이 있습니다 (Ctrl+S: 저장)' : '변경 내용 없음'}${savedAt ? `\n브라우저 자동 저장: ${savedAt.toLocaleTimeString('ko-KR')}` : ''}`;
  };
  // every undoable step marks the project edited; opening or starting a project starts clean
  let loading = false;
  store.on('change', (reason) => {
    if (reason === 'load') {
      loading = true;
      // a project opened from the menu bar while 홈 / 가져오기 / 내보내기 is up (파일 ▸ 샘플
      // 프로젝트 열기, 프로젝트 열기…): show it, rather than a page about the previous project
      if (mode !== 'edit') setHeaderMode('edit');
    }
    paintTitle();
  });
  store.on('history', () => {
    edited = !loading && store.undoStack.length > 0;
    loading = false;
    paintTitle();
  });
  store.on('saved', (d) => { savedAt = d; paintTitle(); });
  const saveFile = c.saveProject;
  c.saveProject = async (...args) => {
    const r = await saveFile(...args);
    edited = false;
    paintTitle();
    return r;
  };
  paintTitle();
  paintWs();
  // the photo editor has its own header: leave the pages there
  appMode.on((m) => { if (m === 'photo' && mode !== 'edit') setHeaderMode('edit'); });
  // Premiere 2022+: 파일 ▸ 내보내기 ▸ 미디어 (Ctrl+M) opens the 내보내기 mode (phones keep the dialog)
  const dialogExport = c.exportMedia;
  c.exportMedia = () => (phone() || appMode.isPhoto() ? dialogExport() : setHeaderMode('export'));
  c.home = () => setHeaderMode('home');
  c.importMode = () => setHeaderMode('import');
  c.newProject = () => newProjectDialog({ onCreated: (goImport) => setHeaderMode(goImport ? 'import' : 'edit') });
  setHeaderMode('edit');
}
