// Workspaces (창 ▸ 작업 영역), like Premiere Pro's: each one brings the panels a kind of work needs to
// the front and sizes the panel areas. Alt+Shift+1…9 switch workspaces in the order of the list,
// Alt+Shift+0 restores the current one (저장된 레이아웃으로 재설정), and the current layout can be
// saved as a new workspace.

import { showPanel, savePref, loadPref, panelIds, toast, promptDialog, confirmDialog, isMaximized, toggleMaximize } from './common.js';

/**
 * tabs: for each panel area [top left, bottom left], the first panel that exists comes to the
 * front (the program monitor and timeline are always shown). vars: sizes of the panel areas.
 */
export const WORKSPACES = [
  {
    id: 'learning', name: '학습', hint: '빠른 편집 패널에서 기능을 차례로 써 보며 배웁니다 (도움말 ▸ 설명서도 함께 보세요)',
    tabs: [['quick', 'source'], ['project']], vars: { '--tl-w': '34%', '--bl-w': '30%', '--top-h': '55%' },
  },
  {
    id: 'assembly', name: '어셈블리', hint: '프로젝트 패널을 크게: 촬영 소스를 고르고 소스 모니터에서 시작/끝을 표시해 타임라인에 넣습니다',
    tabs: [['source'], ['project']], vars: { '--tl-w': '32%', '--bl-w': '58%', '--top-h': '50%' },
  },
  {
    id: 'edit', name: '편집', hint: '소스 · 프로그램 모니터와 넓은 타임라인',
    tabs: [['source'], ['project']], vars: { '--tl-w': '32%', '--bl-w': '30%', '--top-h': '52%' },
  },
  {
    id: 'color', name: '색상', hint: 'Lumetri 범위를 보며 Lumetri 색상으로 보정합니다',
    tabs: [['scopes'], ['lumetri', 'effects']], vars: { '--tl-w': '34%', '--bl-w': '34%', '--top-h': '56%' },
  },
  {
    id: 'effects', name: '효과', hint: '효과 패널에서 효과를 끌어다 놓고 효과 컨트롤에서 조절합니다',
    tabs: [['effectControls'], ['effects']], vars: { '--tl-w': '40%', '--bl-w': '30%', '--top-h': '55%' },
  },
  {
    id: 'audio', name: '오디오', hint: '오디오 클립 믹서 · 기본 사운드와 오디오 효과',
    tabs: [['essentialSound', 'clipMixer', 'mixer'], ['effects']], vars: { '--tl-w': '36%', '--bl-w': '30%', '--top-h': '50%' },
  },
  {
    id: 'graphics', name: '그래픽', hint: '텍스트·도형 클립을 효과 컨트롤에서 다듬습니다',
    tabs: [['essentialGraphics', 'graphics', 'effectControls'], ['project']], vars: { '--tl-w': '38%', '--bl-w': '30%', '--top-h': '55%' },
  },
  {
    id: 'captions', name: '캡션 및 그래픽', hint: '자막(캡션)과 텍스트를 만들고 꾸밉니다',
    tabs: [['captions', 'text', 'essentialGraphics', 'effectControls'], ['markers']], vars: { '--tl-w': '38%', '--bl-w': '30%', '--top-h': '55%' },
  },
  {
    id: 'multicam', name: '멀티 카메라', hint: '앵글을 보며 실시간으로 바꿉니다',
    tabs: [['multicam'], ['project']], vars: { '--tl-w': '44%', '--bl-w': '30%', '--top-h': '58%' },
  },
  {
    id: 'review', name: '검토', hint: '모니터를 크게, 마커로 메모합니다',
    tabs: [['scopes'], ['markers']], vars: { '--tl-w': '26%', '--bl-w': '30%', '--top-h': '66%' },
  },
];

const VARS = ['--tl-w', '--bl-w', '--top-h'];
const GROUP_PANELS = [
  ['source', 'effectControls', 'quick', 'ai', 'mixer', 'clipMixer', 'essentialSound', 'scopes', 'multicam', 'lumetri', 'essentialGraphics', 'graphics', 'captions', 'text'],
  ['project', 'effects', 'markers', 'history', 'lumetri', 'essentialGraphics', 'graphics', 'captions', 'text'],
];

/** Workspaces saved with 새 작업 영역으로 저장 (this browser). */
export function customWorkspaces() {
  const list = loadPref('workspaces.custom', []);
  return Array.isArray(list) ? list.filter((w) => w && w.id && w.name) : [];
}

export const allWorkspaces = () => [...WORKSPACES, ...customWorkspaces()];
export const currentWorkspace = () => loadPref('workspace', 'edit');

export function applyWorkspace(id) {
  const ws = allWorkspaces().find((w) => w.id === id);
  if (!ws) return;
  if (isMaximized()) toggleMaximize();
  const root = document.documentElement;
  for (const [k, v] of Object.entries(ws.vars || {})) {
    root.style.setProperty(k, v);
    savePref(`split${k}`, v);
  }
  const ids = panelIds();
  for (const list of ws.tabs || []) {
    const tab = (Array.isArray(list) ? list : [list]).find((p) => ids.includes(p));
    if (tab) showPanel(tab, { quiet: true });
  }
  savePref('workspace', id);
  window.dispatchEvent(new Event('resize'));
}

/** 저장된 레이아웃으로 재설정 (Alt+Shift+0): the current workspace as it was defined. */
export function resetWorkspace() {
  const id = currentWorkspace();
  applyWorkspace(allWorkspaces().some((w) => w.id === id) ? id : 'edit');
  toast('작업 영역을 저장된 레이아웃으로 되돌렸습니다');
}

/** 새 작업 영역으로 저장: the panel sizes and the panels in front now. */
export async function saveWorkspaceAs() {
  const name = await promptDialog('새 작업 영역', '작업 영역 이름', '내 작업 영역');
  if (!name || !name.trim()) return;
  const root = document.documentElement;
  const vars = {};
  for (const v of VARS) {
    const cur = root.style.getPropertyValue(v) || getComputedStyle(root).getPropertyValue(v);
    if (cur) vars[v] = cur.trim();
  }
  const tabs = GROUP_PANELS.map((list) => {
    const active = list.find((id) => document.querySelector(`.panel-body.active[data-panel="${id}"]`));
    return active ? [active] : [];
  });
  const list = customWorkspaces().filter((w) => w.name !== name.trim());
  const ws = { id: `custom-${Date.now().toString(36)}`, name: name.trim(), tabs, vars, custom: true };
  list.push(ws);
  savePref('workspaces.custom', list);
  savePref('workspace', ws.id);
  toast(`"${ws.name}" 작업 영역을 저장했습니다 (창 ▸ 작업 영역)`);
}

async function deleteWorkspace(ws) {
  if (!(await confirmDialog('작업 영역 삭제', `"${ws.name}" 작업 영역을 삭제할까요?`))) return;
  savePref('workspaces.custom', customWorkspaces().filter((w) => w.id !== ws.id));
  if (currentWorkspace() === ws.id) savePref('workspace', 'edit');
}

/** The 창 ▸ 작업 영역 submenu (Premiere's order and keys). */
export function workspaceMenuItem() {
  return {
    label: '작업 영역',
    submenu: () => {
      const cur = currentWorkspace();
      const custom = customWorkspaces();
      return [
        ...WORKSPACES.map((w, i) => ({ label: w.name, hint: i < 9 ? undefined : w.hint, key: i < 9 ? `Alt+Shift+${i + 1}` : '', checked: w.id === cur, action: () => applyWorkspace(w.id) })),
        ...(custom.length ? ['-', { group: '내 작업 영역' }, ...custom.map((w) => ({ label: w.name, checked: w.id === cur, action: () => applyWorkspace(w.id) }))] : []),
        '-',
        { label: '저장된 레이아웃으로 재설정', key: 'Alt+Shift+0', action: resetWorkspace },
        { label: '새 작업 영역으로 저장…', action: saveWorkspaceAs },
        custom.length ? { label: '작업 영역 삭제', submenu: () => custom.map((w) => ({ label: w.name, action: () => deleteWorkspace(w) })) } : null,
        '-',
        { label: '레이아웃 초기화 (새로 고침)', action: () => import('../commands.js').then((m) => m.commands.resetLayout?.()) },
      ];
    },
  };
}

// Alt+Shift+1…9: workspaces in order; Alt+Shift+0: back to the saved layout (Premiere's keys)
window.addEventListener('keydown', (e) => {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
  if (document.body.classList.contains('photo-mode') || document.querySelector('.modal-backdrop')) return;
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (!m) return;
  const t = e.target;
  if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type)))) return;
  e.preventDefault();
  e.stopPropagation();
  const n = Number(m[1]);
  if (n === 0) resetWorkspace();
  else if (WORKSPACES[n - 1]) {
    applyWorkspace(WORKSPACES[n - 1].id);
    toast(`작업 영역: ${WORKSPACES[n - 1].name}`);
  }
});
