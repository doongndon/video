// Premiere Pro's 홈 screen: 새 프로젝트, 프로젝트 열기 and the recent projects stored in this browser
// (grid or list, with thumbnails, names and times; right-click 열기 / 이름 바꾸기 / 복제 / 삭제;
// search), how much storage they use, and the 새 프로젝트 dialog that asks for a name.

import { h, formatBytes } from '../util.js';
import { store } from '../store.js';
import { playback } from '../playback.js';
import { runtime } from '../media.js';
import { createProject } from '../model.js';
import {
  listProjects, currentProjectId, openStoredProject, renameStoredProject, duplicateStoredProject, deleteStoredProject,
  storageEstimate, clearAnalysisCache, clearSession, setAutosave, storeAsNewProject, saveProjectNow,
} from '../persist.js';
import { openModal, confirmDialog, promptDialog, showMenu, toast, loadPref, savePref, formRow } from './common.js';
import { icon } from './icons.js';

/** "3분 전" style times. */
export function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return new Date(t).toLocaleDateString('ko-KR');
}

/** A project's size: its data plus the media files it keeps in this browser. */
const projectBytes = (r) => (r.bytes || 0) + (r.media || []).reduce((n, m) => n + (m.size || 0), 0);

function nextName(base, names) {
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Leaves the open project (it stays stored) and starts an empty one with this name. */
export async function startNewProject(name) {
  playback.stop?.();
  setAutosave(false);
  await clearSession();
  for (const rt of runtime.values()) if (rt.url) URL.revokeObjectURL(rt.url);
  runtime.clear();
  playback.resetMedia();
  store.loadProject(createProject(name));
  setAutosave(true);
  await storeAsNewProject();
}

/**
 * 새 프로젝트 (Ctrl+Alt+N): asks for the name like Premiere's dialog, then makes the project.
 * Resolves true when one was made. `onCreated(goImport)` runs afterwards.
 */
export async function newProjectDialog({ onCreated } = {}) {
  const names = new Set((await listProjects().catch(() => [])).map((r) => r.name));
  const name = h('input', { type: 'text', value: nextName('제목 없는 프로젝트', names), style: { width: '100%' }, 'aria-label': '프로젝트 이름' });
  const goImport = h('input', { type: 'checkbox', checked: loadPref('home.newGoImport', true) });
  let made = false;
  await new Promise((resolve) => {
    openModal({
      title: '새 프로젝트',
      width: '460px',
      body: [
        formRow('프로젝트 이름', name),
        formRow('프로젝트 위치', h('span.note', '이 브라우저 (자동 저장, 홈 화면의 최근 항목에 나옵니다)')),
        h('label.check', goImport, ' 만든 뒤 가져오기 화면 열기 (미디어를 골라 바로 시퀀스 만들기)'),
      ],
      buttons: [
        { label: '취소' },
        {
          label: '만들기', primary: true, action: async () => {
            const n = name.value.trim() || '제목 없는 프로젝트';
            savePref('home.newGoImport', goImport.checked);
            await startNewProject(n);
            made = true;
          },
        },
      ],
      onClose: resolve,
    });
    setTimeout(() => name.select(), 0);
  });
  if (made) {
    toast(`새 프로젝트 "${store.project.name}"을(를) 만들었습니다`);
    onCreated?.(goImport.checked);
  }
  return made;
}

/** Opens a stored project. */
export async function openProjectById(id) {
  if (id === currentProjectId()) return true;
  try {
    playback.stop?.();
    playback.resetMedia();
    await openStoredProject(id);
    const offline = store.project.mediaOrder.filter((m) => runtime.get(m)?.status === 'offline').length;
    toast(offline ? `"${store.project.name}"을(를) 열었습니다. 미디어 ${offline}개는 파일 ▸ 미디어 연결로 다시 이어 주세요.` : `"${store.project.name}"을(를) 열었습니다`);
    return true;
  } catch (err) {
    console.error(err);
    toast(`프로젝트를 열 수 없습니다: ${err.message || err}`);
    return false;
  }
}

/**
 * The home page. api: {go(mode), newProject(), openFile(), sample()}. Returns {el, refresh}.
 */
export function buildHomePage(api) {
  const search = h('input', { type: 'search', placeholder: '최근 항목 검색', 'aria-label': '최근 항목 검색' });
  const viewBtns = [['grid', '격자 보기'], ['list', '목록 보기']].map(([v, label]) => h('button.icon.home-view', {
    'data-view': v, title: label, 'aria-label': label, onclick: () => { savePref('home.view', v); paint(); },
  }, icon(v, 16)));
  const listBox = h('div.home-recent');
  const storageBox = h('div.home-storage');
  const atStart = h('input', { type: 'checkbox', checked: loadPref('home.atStart', false) });
  atStart.addEventListener('change', () => savePref('home.atStart', atStart.checked));
  let records = [];
  let urls = [];

  const open = async (r) => {
    if (await openProjectById(r.id)) api.go('edit');
  };
  const rename = async (r) => {
    const n = await promptDialog('이름 바꾸기', '프로젝트 이름', r.name);
    if (!n || !n.trim() || n.trim() === r.name) return;
    await renameStoredProject(r.id, n.trim());
    refresh();
  };
  const duplicate = async (r) => {
    const names = new Set(records.map((x) => x.name));
    await duplicateStoredProject(r.id, nextName(`${r.name} 복사본`, names));
    toast(`"${r.name}"을(를) 복제했습니다`);
    refresh();
  };
  const remove = async (r) => {
    if (r.id === currentProjectId()) {
      toast('열려 있는 프로젝트는 지울 수 없습니다. 다른 프로젝트를 열거나 새 프로젝트를 만든 뒤 지우세요.');
      return;
    }
    if (!(await confirmDialog('프로젝트 삭제', `"${r.name}" 프로젝트를 이 브라우저에서 지울까요?\n다른 프로젝트가 쓰지 않는 미디어 파일도 함께 지워집니다. 되돌릴 수 없습니다.`))) return;
    await deleteStoredProject(r.id);
    toast(`"${r.name}"을(를) 지웠습니다`);
    refresh();
  };
  const menuFor = (r, x, y) => {
    const isCur = r.id === currentProjectId();
    showMenu([
      { label: isCur ? '열기 (열려 있음)' : '열기', action: () => (isCur ? api.go('edit') : open(r)) },
      { label: '이름 바꾸기…', action: () => rename(r) },
      { label: '복제', action: () => duplicate(r) },
      '-',
      { label: '삭제…', disabled: isCur, hint: isCur ? '열려 있음' : undefined, action: () => remove(r) },
    ], x, y);
  };

  function card(r, view) {
    const isCur = r.id === currentProjectId();
    let thumb;
    if (r.thumb) {
      const u = URL.createObjectURL(r.thumb);
      urls.push(u);
      thumb = h('img', { src: u, alt: '' });
    } else thumb = icon('film', 28);
    const more = h('button.icon.home-more', { title: '더 보기', 'aria-label': `${r.name} 메뉴`, onclick: (e) => {
      e.stopPropagation();
      const b = e.currentTarget.getBoundingClientRect();
      menuFor(r, b.left, b.bottom + 2);
    } }, icon('more', 16));
    const el = h(`div.home-item${isCur ? '.current' : ''}`, {
      role: 'button', tabindex: 0, title: `${r.name}\n수정: ${new Date(r.modified).toLocaleString('ko-KR')}`,
      'data-project': r.id,
      onclick: () => open(r),
      onkeydown: (e) => {
        if (e.key === 'Enter') open(r);
        else if (e.key === 'Delete') remove(r);
        else if (e.key === 'F2') rename(r);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        menuFor(r, e.clientX, e.clientY);
      },
    },
    h('div.home-thumb', thumb, isCur ? h('span.home-badge', '열려 있음') : null),
    h('div.home-name', r.name),
    h('div.home-meta', view === 'list' ? ago(Math.max(r.modified, r.opened || 0)) : `${ago(Math.max(r.modified, r.opened || 0))} · ${formatBytes(projectBytes(r))}`),
    view === 'list' ? h('div.home-meta', formatBytes(projectBytes(r))) : null,
    more);
    return el;
  }

  function paint() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    const view = loadPref('home.view', 'grid');
    for (const b of viewBtns) b.classList.toggle('on', b.dataset.view === view);
    const q = search.value.trim().toLowerCase();
    const shown = records.filter((r) => !q || r.name.toLowerCase().includes(q));
    listBox.className = `home-recent ${view}`;
    listBox.replaceChildren(
      ...(view === 'list' && shown.length ? [h('div.home-head', h('span'), h('span', '이름'), h('span', '마지막으로 연 날짜'), h('span', '크기'), h('span'))] : []),
      ...shown.map((r) => card(r, view)),
    );
    if (!shown.length) {
      listBox.append(h('div.empty-hint', records.length ? `"${search.value}"와(과) 맞는 프로젝트가 없습니다` : '아직 저장된 프로젝트가 없습니다.\n새 프로젝트를 만들면 여기에 나옵니다.'));
    }
  }

  async function paintStorage() {
    const est = await storageEstimate();
    const mine = records.reduce((n, r) => n + projectBytes(r), 0);
    const pct = est?.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
    storageBox.replaceChildren(
      h('div.home-storage-head', icon('folder', 14), h('b', '저장 공간')),
      h('div.progress', { title: est ? `${pct.toFixed(1)}%` : '' }, h('div', { style: { width: `${pct}%` } })),
      h('div.note', `프로젝트 ${records.length}개 · 약 ${formatBytes(mine)}`),
      est ? h('div.note', `이 사이트 사용 ${formatBytes(est.usage || 0)} / 가능 ${formatBytes(est.quota || 0)}`) : null,
      h('button.small', {
        title: '파형·필름스트립 미리 보기 캐시를 지웁니다 (필요할 때 다시 만듭니다)',
        onclick: async () => {
          await clearAnalysisCache();
          toast('미디어 캐시를 지웠습니다');
          paintStorage();
        },
      }, '미디어 캐시 지우기'),
      h('p.note', '안 쓰는 프로젝트는 오른쪽 클릭 ▸ 삭제로 지우면 공간이 늘어납니다.'));
  }

  async function refresh() {
    // the open project's card shows what is on screen now
    await saveProjectNow({ thumb: true }).catch(() => {});
    records = await listProjects().catch(() => []);
    paint();
    paintStorage();
  }

  search.addEventListener('input', paint);
  const el = h('div.hm-page.home-page', { 'data-page': 'home', tabindex: -1 },
    h('nav.home-nav', { 'aria-label': '홈' },
      h('button.primary.home-new', { onclick: () => api.newProject() }, icon('fileNew', 16), '새 프로젝트'),
      h('button.home-open', { onclick: () => api.openFile() }, icon('fileOpen', 16), '프로젝트 열기'),
      h('button.home-sample', { onclick: () => api.sample() }, icon('film', 16), '샘플 프로젝트'),
      h('button.home-back', { onclick: () => api.go('edit'), title: '열려 있는 프로젝트로 돌아가기 (Esc)' }, icon('chevLeft', 16), '편집으로 돌아가기'),
      h('div.grow'),
      storageBox,
      h('label.check.home-atstart', atStart, ' 시작할 때 홈 화면 보기')),
    h('div.home-main',
      h('h2', '다시 오신 것을 환영합니다'),
      h('p.note', '프리미어 프로 강의를 보면서 같은 화면, 같은 메뉴로 따라 해 보세요. 프로젝트는 이 브라우저에 저장됩니다.'),
      h('div.home-bar', h('h3', '최근 항목'), h('span.grow'), h('span.home-search', icon('search', 14), search), ...viewBtns),
      listBox));
  return { el, refresh };
}
