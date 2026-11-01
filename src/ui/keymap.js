// Keyboard shortcuts of the video editor's app shell that src/shortcuts.js does not handle
// (Premiere's panel keys Shift+1…9, Shift+` to maximize the active frame, Ctrl+Alt+K …), the
// 편집 ▸ 키보드 단축키 dialog that lists every shortcut by menu, and the shortcuts a person assigns
// to menu commands there (kept in this browser).

import { commands as c } from '../commands.js';
import { h, isMac, modKey } from '../util.js';
import { openModal, menusOpen, modalOpen, toggleMaximize, loadPref, savePref, toast, panelIds } from './common.js';
import { icon } from './icons.js';
import { menubarApi } from './menubar.js';
import { appMode } from '../mode.js';

/** Premiere's Shift+number panel keys. */
export const PANEL_KEYS = { project: '1', source: '2', timeline: '3', program: '4', effectControls: '5', mixer: '6', effects: '7', clipMixer: '9' };

// menu commands whose keys only this module handles (shortcuts.js does not know them)
// (Ctrl+; / Ctrl+Shift+; are 보기 ▸ 안내선 표시 / 프로그램 모니터에서 스냅 wherever the focus is;
// shortcuts.js would read them as ; 들어 올리기)
const MENU_ONLY_KEYS = ['Ctrl+Alt+K', 'Ctrl+Alt+N', 'Ctrl+Shift+S', 'Ctrl+Alt+R', 'Ctrl+Alt+E', 'Ctrl+Shift+/', 'Ctrl+/', 'Ctrl+;', 'Ctrl+Shift+;', 'Shift+0'];
// the browser keeps these for itself
const RESERVED = ['Ctrl+N', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'F11', 'F12', 'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+Q'];

// ---------------------------------------------------------------- key names

const CODE_NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc', Delete: 'Delete',
  Backspace: 'Backspace', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
};

function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_NAMES[code] || null;
}

/** "Ctrl+Alt+Shift+K" for a key event (Ctrl means ⌘ on a Mac); null for a lone modifier. */
export function comboOf(e) {
  const k = keyName(e.code);
  if (!k) return null;
  return `${modKey(e) ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${k}`;
}

/** The same canonical form for a key label as menus show it ("⌘Shift+Z", "Ctrl+Alt+V", "Shift+`"). */
export function normCombo(s) {
  if (!s) return '';
  let rest = String(s).trim().replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+').replace(/Cmd\+/gi, 'Ctrl+');
  const m = { Ctrl: false, Alt: false, Shift: false };
  for (;;) {
    const x = rest.match(/^(Ctrl|Alt|Shift|Option)\+(?=.)/i);
    if (!x) break;
    const name = x[1].toLowerCase();
    m[name === 'ctrl' ? 'Ctrl' : name === 'shift' ? 'Shift' : 'Alt'] = true;
    rest = rest.slice(x[0].length);
  }
  if (/^[a-z]$/.test(rest)) rest = rest.toUpperCase();
  return `${m.Ctrl ? 'Ctrl+' : ''}${m.Alt ? 'Alt+' : ''}${m.Shift ? 'Shift+' : ''}${rest}`;
}

/** How a canonical combo is shown (⌘ on a Mac). */
export const showCombo = (k) => (isMac ? String(k).replace(/Ctrl\+/g, '⌘') : String(k));

// ---------------------------------------------------------------- the menu commands

const normLabel = (s) => String(s || '').replace(/:.*$/, '').replace(/\s+|…|\.\.\./g, '');

/** Every command in the video menus: {id, menu, path:[labels], label, key, item}. */
export function menuCommands(menus = menubarApi.video?.() || {}) {
  const out = [];
  const walk = (menu, list, path, depth) => {
    for (const it of list || []) {
      if (!it || it === '-' || it.group || !it.label) continue;
      const p = [...path, it.label];
      if (it.submenu) {
        if (depth > 3) continue;
        let sub = [];
        try {
          sub = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
        } catch { /* a submenu that cannot be listed right now */ }
        walk(menu, sub, p, depth + 1);
      } else out.push({ id: `${menu}/${p.map(normLabel).join('/')}`, menu, path: p, label: it.label, key: it.key || '', item: it });
    }
  };
  for (const [name, fn] of Object.entries(menus)) {
    let list = [];
    try {
      list = fn();
    } catch { /* skip a menu that fails */ }
    walk(name, list, [], 0);
  }
  return out;
}

// ---------------------------------------------------------------- custom shortcuts

const PREF = 'keymap.custom';
let custom = loadPref(PREF, {}) || {};
let byCombo = null;

function saveCustom() {
  savePref(PREF, custom);
  byCombo = null;
}

/** A shortcut the person assigned to the menu item at `path` (labels) in `menu`, as shown. */
export function customKeyForPath(menu, path) {
  const k = custom[`${menu}/${path.map(normLabel).join('/')}`];
  return k ? showCombo(k) : null;
}

export const hasCustomKeys = () => Object.values(custom).some(Boolean);

function comboMap() {
  if (!byCombo) {
    byCombo = new Map();
    for (const [id, k] of Object.entries(custom)) if (k) byCombo.set(k, id);
  }
  return byCombo;
}

/** Find a command by id now (menus are rebuilt every time, so look it up when the key is pressed). */
function findCommand(id) {
  return menuCommands().find((x) => x.id === id) || null;
}

function runItem(it) {
  if (!it || it.disabled || typeof it.action !== 'function') return false;
  try {
    it.action();
  } catch (err) {
    console.error(err);
    toast(String(err.message || err));
  }
  return true;
}

// ---------------------------------------------------------------- key handling

/** The photo editor's 도움말 ▸ 바로 가기 키 item (found by name: modules may add Help items). */
export const photoShortcutsItem = () => (appMode.P?.menus?.['도움말']?.() || []).find((x) => x && x !== '-' && /단축키/.test(x.label || '')) || null;

const isTyping = (t) => !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
  || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type)));

let installed = false;

/** Keys of the video editor's shell; runs before src/shortcuts.js so its keys can be reassigned. */
export function installKeymap() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    // a panel's own key handler (e.g. the Program monitor's) already took this key
    if (e.defaultPrevented || menusOpen() || modalOpen() || isTyping(e.target)) return;
    const combo = comboOf(e);
    if (!combo) return;
    // F10 / Alt+letter (Windows): open a menu-bar menu, in both editors
    const mn = combo === 'F10' ? '' : /^Alt\+[A-Z]$/.test(combo) && !comboMap().has(combo) ? combo.slice(-1) : null;
    if (mn != null && !e.repeat && menubarApi.openMenu?.(mn || null)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (document.body.classList.contains('photo-mode')) {
      // F1 lists the photo editor's shortcuts too (its 도움말 ▸ 바로 가기 키)
      if (combo === 'F1' && !e.repeat && runItem(photoShortcutsItem())) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    let done = false;
    // shortcuts the person assigned in the dialog come first
    const id = comboMap().get(combo);
    if (id) done = runItem(findCommand(id)?.item) || true;
    else if (e.repeat) return;
    else if (combo === 'Shift+`') {
      toggleMaximize({ active: true });
      done = true;
    } else if (/^Shift\+[1-9]$/.test(combo)) {
      const n = combo.slice(-1);
      const panel = Object.entries(PANEL_KEYS).find(([pid, k]) => k === n && panelIds().includes(pid))?.[0];
      if (panel) {
        c.showPanel(panel);
        done = true;
      }
    } else if (MENU_ONLY_KEYS.includes(combo)) {
      const cmd = menuCommands().find((x) => normCombo(x.key) === combo);
      done = runItem(cmd?.item) || !!cmd;
    }
    if (done) {
      e.preventDefault();
      // also keep other window capture listeners (panels' own keys) from answering the same key
      e.stopImmediatePropagation();
    }
  }, true);
  // Help ▸ 키보드 단축키, F1 and ? open this list
  c.shortcuts = openKeyboardShortcuts;
}

// ---------------------------------------------------------------- the dialog

// shortcuts that are not menu commands
function otherShortcuts(TOOLS) {
  const M = (k) => showCombo(k);
  const tools = (TOOLS || []).map(([, title]) => {
    const m = String(title).match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    return m ? [m[1], m[2]] : null;
  }).filter(Boolean);
  return [
    ['패널', [
      ...Object.entries(PANEL_KEYS).filter(([id]) => panelIds().includes(id)).map(([id, k]) => [{
        project: '프로젝트', source: '소스 모니터', timeline: '타임라인', program: '프로그램 모니터', effectControls: '효과 컨트롤', mixer: '오디오 트랙 믹서', effects: '효과', clipMixer: '오디오 클립 믹서',
      }[id] || id, `Shift+${k}`]),
      ['포인터 아래 프레임 최대화 / 복원', '`'], ['활성 프레임 최대화 / 복원', 'Shift+`'],
    ]],
    ['도구', tools],
    ['재생·이동', [
      ['재생 / 정지', 'Space'], ['뒤로 / 정지 / 앞으로 재생 (누를수록 빨라짐)', 'J / K / L'], ['느리게 뒤로 / 앞으로 재생 (누를수록 빨라짐)', 'Shift+J / Shift+L'], ['K를 누른 채 1프레임 뒤로 / 앞으로', 'K+J / K+L'],
      ['1프레임 뒤로 / 앞으로', '← / →'], ['5프레임 뒤로 / 앞으로', 'Shift+← / Shift+→'],
      ['이전 / 다음 편집 지점 (대상 트랙)', '↑ / ↓'], ['이전 / 다음 편집 지점 (모든 트랙)', 'Shift+↑ / Shift+↓'],
      ['시퀀스 처음 / 끝으로', 'Home / End'], ['시작에서 종료까지 재생', M('Ctrl+Shift+Space')],
    ]],
    ['타임라인', [
      ['모든 트랙 높이 늘리기 / 줄이기', 'Shift+= / Shift+-'], ['비디오 트랙 높이 늘리기 / 줄이기', `${M('Ctrl+=')} / ${M('Ctrl+-')}`], ['오디오 트랙 높이 늘리기 / 줄이기', 'Alt+= / Alt+-'],
      ['선택 해제', 'Esc'], ['멀티 카메라 앵글 바꾸기', '1 ~ 9'],
    ]],
    ['그 밖에', [
      ['다시 실행 (다른 키)', M('Ctrl+Y')], ['지우기 (다른 키)', 'Backspace'], ['키보드 단축키 목록', 'F1 / ?'],
      ...(isMac ? [] : [['메뉴 열기 (첫 메뉴 / 파일·편집·클립…)', 'F10 / Alt+F, E, C, S, M, G, V, W, A, H']]),
    ]],
    ['마우스', [
      ['복제하며 끌기', 'Alt+끌기'], ['삽입하며 끌기', `${M('Ctrl+')}끌기`], ['연결된 짝은 두고 한쪽만 선택', 'Alt+클릭'], ['선택에 더하기 / 빼기', 'Shift+클릭'],
      ['볼륨 선에 키프레임 추가', `${M('Ctrl+')}클릭`], ['타임라인: 시간 이동 / 트랙 이동 / 확대', `휠 / Shift+휠 / Alt 또는 ${M('Ctrl+')}휠`],
      ['파란 숫자 바꾸기 (크게 / 세밀하게)', '좌우로 끌기 (Shift / Ctrl)'],
    ]],
  ];
}

/** The single keys of a list entry ("J / K / L", "1 ~ 9", "Shift+← / Shift+→"), canonical. */
const splitKeys = (key) => {
  const range = String(key).match(/^(\d)\s*~\s*(\d)$/);
  if (range) return Array.from({ length: Math.max(0, range[2] - range[1] + 1) }, (_, i) => String(Number(range[1]) + i));
  return String(key).split(/\s+\/\s+|\s*~\s*/).map(normCombo).filter(Boolean);
};

/** 편집 ▸ 키보드 단축키: every shortcut by menu; any menu command can get a shortcut of its own. */
export async function openKeyboardShortcuts() {
  const [{ TOOLS }, { SHORTCUTS }] = await Promise.all([
    import('./panels.js').catch(() => ({})),
    import('./dialogs.js').catch(() => ({})),
  ]);
  if (modalOpen() && document.querySelector('.kb-dialog')) return;
  const search = h('input', { type: 'search', placeholder: '명령이나 키로 찾기 (예: 자르기, Ctrl+K)', 'aria-label': '단축키 찾기' });
  const onlyKeys = h('input', { type: 'checkbox', checked: true });
  const onlyBox = h('label.check.kb-only', onlyKeys, '단축키가 있는 명령만');
  const tabBtns = [['menus', '메뉴 명령'], ['other', '패널·도구·재생']].map(([id, label]) => h('button.small.kb-tab', { 'data-tab': id, onclick: () => { tab = id; render(); } }, label));
  const list = h('div.kb-list', { role: 'list' });
  let tab = 'menus';
  let capturing = null;

  function keyCell(cmd) {
    const id = cmd.id;
    const own = custom[id];
    const shown = own ? showCombo(own) : cmd.key;
    const cell = h('span.kb-keys', shown ? h('kbd', shown) : h('span.kb-none', '—'));
    if (own) cell.append(h('span.kb-own', '바꿈'));
    return cell;
  }

  function startCapture(cmd, btn) {
    capturing = cmd.id;
    btn.textContent = '키를 누르세요… (Esc 취소)';
    btn.classList.add('capturing');
    btn.focus();
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Shift', 'Control', 'Alt', 'Meta', 'Process'].includes(e.key) || e.isComposing) return;
      btn.removeEventListener('keydown', onKey);
      btn.removeEventListener('blur', onBlur);
      capturing = null;
      if (e.key === 'Escape') {
        render();
        return;
      }
      const combo = comboOf(e);
      if (!combo) {
        toast('이 키는 단축키로 쓸 수 없습니다');
        render();
        return;
      }
      if (combo === 'Tab' || combo === 'Shift+Tab') {
        toast('Tab은 화면 안에서 이동할 때 쓰는 키라서 쓸 수 없습니다');
        render();
        return;
      }
      if (RESERVED.includes(combo)) {
        toast(`${showCombo(combo)}는 브라우저가 먼저 쓰는 키라서 쓸 수 없습니다`);
        render();
        return;
      }
      if (/^(Shift\+)?[A-Z0-9]$/.test(combo) || /^Shift\+/.test(combo) || /^[^+]+$/.test(combo)) {
        // a plain key may already be a tool or playback key: say so, but allow it
        toast(`${showCombo(combo)}: 이 키의 원래 기능 대신 "${cmd.path.join(' ▸ ')}"가 실행됩니다`);
      }
      for (const [k, v] of Object.entries(custom)) if (v === combo && k !== cmd.id) delete custom[k];
      custom[cmd.id] = combo;
      saveCustom();
      menubarApi.rebuild?.();
      render();
    };
    const onBlur = () => {
      btn.removeEventListener('keydown', onKey);
      btn.removeEventListener('blur', onBlur);
      if (capturing === cmd.id) {
        capturing = null;
        render();
      }
    };
    btn.addEventListener('keydown', onKey);
    btn.addEventListener('blur', onBlur);
  }

  function render() {
    for (const b of tabBtns) b.classList.toggle('on', b.dataset.tab === tab);
    onlyBox.hidden = tab !== 'menus';
    const q = search.value.trim().toLowerCase();
    const qKey = normCombo(search.value.trim());
    const hit = (label, key) => !q || label.toLowerCase().includes(q) || String(key).toLowerCase().includes(q) || (qKey && normCombo(key) === qKey);
    const rows = [];
    const flag = (text, title) => h('span.kb-clash', { title }, icon('alert', 13), ` ${text}`);
    // the keys of the 패널·도구·재생 list, for clashes with shortcuts a person assigned
    const groups = otherShortcuts(TOOLS);
    const otherKeys = new Map();
    for (const [, r] of groups) for (const [label, k] of r) for (const p of splitKeys(k)) if (!otherKeys.has(p)) otherKeys.set(p, label);
    if (tab === 'menus') {
      const cmds = menuCommands();
      const used = new Map();
      for (const cmd of cmds) {
        const k = normCombo(custom[cmd.id] || cmd.key);
        if (k) used.set(k, [...(used.get(k) || []), cmd]);
      }
      let lastMenu = null;
      for (const cmd of cmds) {
        const key = custom[cmd.id] ? showCombo(custom[cmd.id]) : cmd.key;
        if (onlyKeys.checked && !key) continue;
        if (!hit(cmd.path.join(' '), key)) continue;
        if (cmd.menu !== lastMenu) {
          rows.push(h('div.kb-head', cmd.menu));
          lastMenu = cmd.menu;
        }
        // the same command listed in two menus (e.g. 문자 도구) is not a clash
        const clash = (used.get(normCombo(custom[cmd.id] || cmd.key)) || []).filter((x) => x !== cmd && x.item.action !== cmd.item.action && normLabel(x.label) !== normLabel(cmd.label));
        const replaced = custom[cmd.id] && otherKeys.get(custom[cmd.id]);
        const change = h('button.small.kb-change', { title: '이 명령에 새 단축키 정하기' }, '바꾸기');
        change.addEventListener('click', () => startCapture(cmd, change));
        const reset = custom[cmd.id] ? h('button.small', { title: '원래 단축키로', onclick: () => { delete custom[cmd.id]; saveCustom(); menubarApi.rebuild?.(); render(); } }, '기본값') : null;
        rows.push(h('div.kb-row', { role: 'listitem' },
          h('span.kb-label', cmd.path.length > 1 ? h('span.kb-path', `${cmd.path.slice(0, -1).join(' ▸ ')} ▸ `) : null, cmd.path[cmd.path.length - 1],
            clash.length ? flag(`${clash[0].path[clash[0].path.length - 1]}에도 쓰임`, clash.map((x) => x.path.join(' ▸ ')).join(', ')) : null,
            replaced && !clash.length ? flag(`원래 키의 "${replaced}" 대신 실행됨`, '패널·도구·재생 탭의 단축키와 같은 키입니다') : null),
          keyCell(cmd), h('span.kb-btns', change, reset)));
      }
    } else {
      // shortcuts listed elsewhere (src/ui/dialogs.js) that no menu or list here covers; a row with
      // the mouse is kept (Ctrl+클릭 means something else in each panel)
      const cmds = menuCommands();
      const known = new Set([...cmds.map((x) => normCombo(x.key)).filter(Boolean), ...otherKeys.keys()]);
      const listed = new Set(groups.flatMap(([, r]) => r.map(([, k]) => k)));
      const more = [];
      for (const [, rs] of SHORTCUTS || []) {
        for (const [label, key] of rs) {
          if (listed.has(key) || (!/클릭|끌기|휠/.test(key) && splitKeys(key).every((k) => known.has(k)))) continue;
          listed.add(key);
          for (const p of splitKeys(key)) known.add(p);
          more.push([label, key]);
        }
      }
      if (more.length) groups.push(['그 밖의 단축키', more]);
      const customBy = comboMap();
      for (const [group, rs] of groups) {
        const shown = rs.filter(([label, key]) => hit(label, key));
        if (!shown.length) continue;
        rows.push(h('div.kb-head', group));
        for (const [label, key] of shown) {
          // a key a person gave to a menu command now runs that command instead
          const over = splitKeys(key).map((k) => customBy.get(k)).filter(Boolean).map((id) => cmds.find((x) => x.id === id)).filter(Boolean);
          rows.push(h('div.kb-row', { role: 'listitem' },
            h('span.kb-label', label, over.length ? flag(`대신 "${over[0].label}" 실행 (바꾼 단축키)`, over.map((x) => x.path.join(' ▸ ')).join(', ')) : null),
            h('span.kb-keys', h('kbd', key)), h('span.kb-btns')));
        }
      }
    }
    list.replaceChildren(...(rows.length ? rows : [h('div.empty-hint', '찾는 단축키가 없습니다')]));
  }

  search.addEventListener('input', render);
  onlyKeys.addEventListener('change', render);
  const reset = () => {
    custom = {};
    saveCustom();
    menubarApi.rebuild?.();
    render();
    toast('모든 단축키를 기본값으로 되돌렸습니다');
    return false;
  };
  render();
  openModal({
    title: '키보드 단축키',
    width: 'min(860px, 96vw)',
    body: [
      h('div.kb-dialog',
        h('div.kb-bar', h('span.kb-search', icon('search', 15), search), h('div.kb-tabs', tabBtns), onlyBox),
        list,
        h('div.note', `"바꾸기"를 누르고 원하는 키를 누르면 그 명령의 단축키가 됩니다(이 브라우저에 저장). ${isMac ? '⌘' : 'Ctrl'} 키 단축키는 macOS에서 ⌘로 씁니다. 한글 입력 상태에서도 키 위치대로 작동합니다.`)),
    ],
    buttons: [{ label: '모두 기본값으로', action: reset }, { label: '닫기', primary: true }],
  });
  setTimeout(() => search.focus(), 0);
}

// a debugging hook for automated tests
export const keymapApi = { menuCommands, normCombo, comboOf, get custom() { return custom; } };
