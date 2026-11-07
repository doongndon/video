// Application menu bar (Korean), laid out like Premiere Pro's: 파일 · 편집 · 클립 · 시퀀스 · 마커 ·
// 그래픽 및 타이틀 · 보기 · 창 · AI · 도움말. Other modules add items with extendMenu(); items they
// add land where Premiere has them (see PLACE), the rest before each menu's closing section.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { commands as c } from '../commands.js';
import * as edit from '../edit.js';
import { h, isMac } from '../util.js';
import { showMenu, closeMenus, UI_SCALES, uiScale, promptDialog, toast, toggleMaximize, panelIds, openAppearanceDialog } from './common.js';
import { LABEL_COLORS } from '../model.js';
import { templateMenu } from '../templates.js';
import { WORKSPACES } from './workspaces.js';
import { appMode, setMode } from '../mode.js';
import { icon } from './icons.js';
import { duplicateClips } from '../features.js';
import { installKeymap, openKeyboardShortcuts, customKeyForPath, hasCustomKeys, PANEL_KEYS, photoShortcutsItem } from './keymap.js';

/** Open the manual (loaded the first time), at a page that fits the editor on screen. */
export const openManual = (id = appMode.isPhoto() ? 'p-start' : null) => import('../docs/viewer.js').then((m) => m.openDocs(id));

const mod = isMac ? '⌘' : 'Ctrl+';

/** Menu definitions, shared with the phone layout's menu sheet. */
export const menubarApi = { menus: null, videoMenus: null, extenders: [], rebuild: null };

// Premiere's menu order; menus other modules create go before AI
// Alt+letter opens a menu-bar menu (Windows; Premiere's and Photoshop's 파일(F), 편집(E) …)
const MNEMONICS = {
  '파일': 'F', '편집': 'E', '클립': 'C', '시퀀스': 'S', '마커': 'M', '그래픽 및 타이틀': 'G', '보기': 'V', '창': 'W', '도움말': 'H', 'AI': 'A',
  '이미지': 'I', '레이어': 'L', '문자': 'Y', '선택': 'S', '필터': 'T', '3D': 'D', '플러그인': 'P',
};
export const mnemonicOf = (name) => (isMac ? null : MNEMONICS[name] || null);

const ORDER = ['파일', '편집', '클립', '시퀀스', '마커', '그래픽 및 타이틀', '보기', '창', 'AI', '도움말'];
// names other modules may use for the same menu
const ALIASES = { '그래픽': '그래픽 및 타이틀', '타이틀': '그래픽 및 타이틀', '그래픽 및 제목': '그래픽 및 타이틀', '도움': '도움말', '윈도우': '창' };

/**
 * Add to a video menu from another module: fn(items) → items. Call it when the module is first
 * evaluated (before the menu bar is built); later calls apply at once. A menu that does not
 * exist yet is created (before AI). Safe to call while this module is still loading (import cycles).
 */
export function extendMenu(name, fn) {
  if (extendMenu.state) extendMenu.state.add(name, fn);
  else (extendMenu.pending || (extendMenu.pending = [])).push([name, fn]);
}

function applyExtension(menus, name, fn) {
  const target = ALIASES[name] || name;
  const orig = menus[target] || (() => []);
  menus[target] = () => fn(orig());
}

// ---------------------------------------------------------------- placing other modules' items

const BASE = new WeakSet();
/** Mark the items a menu definition owns (everything else came from extendMenu). */
const base = (list) => {
  for (const it of list) if (it && typeof it === 'object') BASE.add(it);
  return list;
};
const norm = (s) => String(s || '').replace(/\s+|…|\.\.\.|\(.*?\)/g, '').toLowerCase();

/**
 * Where items from other modules go, by label: into a submenu, after an item, or at a slot.
 * Unmatched items stay in the order they were added, before the menu's closing section.
 */
const PLACE = {
  '파일': [
    [/막대|톤|카운트다운|카운팅 리더|투명 비디오|색상 매트|블랙 비디오|조정 레이어|오프라인 파일|^저장소|검색 저장소|^캡션|^시퀀스|클립에서|^새 /, { into: '새로 만들기' }],
    [/^미디어|^프레임|^마커|^EDL|^XML|^AAF|^OMF|^오디오만|^동작 그래픽|^캡션 내보내기/, { into: '내보내기' }],
  ],
  '편집': [
    [/특성/, { after: '특성 붙여넣기' }],
    [/^복제|^찾기|^다음 찾기/, { after: '잔물결 삭제' }],
    [/환경 설정|키보드/, { at: 'prefs' }],
  ],
  '클립': [
    [/하위 클립/, { after: '이름 바꾸기' }],
    [/푸티지 해석|오디오 채널|타임코드/, { into: '수정' }],
    [/오디오 게인|모노로 분리|오디오 채널|노멀라이즈/, { into: '오디오 옵션' }],
    [/프레임 고정|프레임 크기|필드 옵션|시간 보간|프레임 혼합|광학 흐름/, { into: '비디오 옵션' }],
    [/시간 다시 매핑|시간 재매핑|속도/, { after: '속도/지속 시간' }],
    [/바꾸기|대체/, { after: '덮어쓰기' }],
    [/^그룹|그룹 해제|동기화|클립 병합|^사용|^활성화/, { after: '연결' }],
    [/멀티 ?카메라|멀티캠/, { after: '중첩' }],
  ],
  '시퀀스': [
    [/렌더/, { after: '시퀀스 설정' }],
    [/일치|매치/, { after: '프레임 일치' }],
    [/트랙.*(확장|최소화|높이)|(확장|최소화).*트랙/, { after: '시퀀스로 확대/축소' }],
    [/편집 추가|편집 트리밍|편집.*확장|확장.*편집|트리밍/, { after: '모든 트랙에 편집 추가' }],
    [/전환/, { after: '선택 항목에 기본 전환 적용' }],
    [/간격/, { after: '간격 닫기' }],
    [/스냅|연결된 선택|재생 헤드 따르기|선택 항목 따르기/, { after: '연결된 선택' }],
    [/트랙/, { after: '오디오 트랙 추가' }],
    [/하위 시퀀스|단순화|시퀀스 자동화/, { at: 'seqTools' }],
  ],
  '마커': [
    [/선택 항목 표시|분할/, { after: '클립 표시' }],
    [/분할로 이동|으로 이동$/, { after: '종료로 이동' }],
    [/지우기/, { after: '시작 및 종료 지우기' }],
    [/마커/, { after: '마커 편집' }],
  ],
  '그래픽 및 타이틀': [
    [/^텍스트$|^세로 텍스트|^사각형$|^타원$|^다각형$|^파일에서/, { into: '새 레이어' }],
    [/정렬|맨 앞|맨 뒤|앞으로|뒤로/, { at: 'arrange' }],
    [/캡션|자막/, { at: 'captions' }],
  ],
  '창': [[/.*/, { at: 'panels' }]],
};

// 창's panel list follows Premiere's order: its English panel names, alphabetically
const PANEL_EN = {
  '오디오 클립 믹서': 'Audio Clip Mixer', '오디오 미터': 'Audio Meters', '오디오 트랙 믹서': 'Audio Track Mixer', '캡션': 'Captions',
  '효과 컨트롤': 'Effect Controls', '효과': 'Effects', '기본 그래픽': 'Essential Graphics', '기본 사운드': 'Essential Sound', '작업 내역': 'History',
  '정보': 'Info', '라이브러리': 'Libraries', 'Lumetri 색상': 'Lumetri Color', 'Lumetri 범위': 'Lumetri Scopes', '마커': 'Markers',
  '미디어 브라우저': 'Media Browser', '메타데이터': 'Metadata', '멀티 카메라': 'Multi-Camera', '프로그램 모니터': 'Program Monitor',
  '프로젝트': 'Project', '참조 모니터': 'Reference Monitor', '소스 모니터': 'Source Monitor', '텍스트': 'Text', '타임라인': 'Timelines', '도구': 'Tools', '학습': 'Learn',
};
const panelOrder = (it) => PANEL_EN[String(it.label).replace(/\s*\(.*\)$/, '')] || it.label;

function sortPanels(out) {
  const slot = out.findIndex((b) => b?.slot === 'panels');
  if (slot < 0) return;
  let start = slot;
  while (start > 0 && out[start - 1] !== '-') start -= 1;
  const block = out.slice(start, slot).sort((a, b) => panelOrder(a).localeCompare(panelOrder(b), 'en'));
  out.splice(start, block.length, ...block);
}

function matches(it, label) {
  const a = norm(it?.label);
  const b = norm(label);
  return !!a && (a === b || a.startsWith(b));
}

const same = (a, b) => !!a && a !== '-' && !!a.label && ((a.action && a.action === b.action) || norm(a.label) === norm(b.label));
const resolve = (sub) => (typeof sub === 'function' ? sub() : sub) || [];

/**
 * Put another module's items into one of our lists: an item for the same command (same action or
 * label) takes the place of ours (same-named submenus are merged), the others follow the item
 * they came after in their own list.
 */
function mergeLists(own, theirs) {
  const out = [...own];
  let anchor = -1;
  for (const x of theirs) {
    if (!x || x === '-' || x.group || !x.label) continue;
    const i = out.findIndex((b) => same(b, x));
    if (i >= 0) {
      out[i] = x.submenu && out[i].submenu ? { ...x, submenu: mergeSub(out[i].submenu, x.submenu) } : x;
      anchor = i;
    } else {
      out.splice(anchor + 1, 0, x);
      anchor += 1;
    }
  }
  return out;
}
const mergeSub = (own, theirs) => () => mergeLists(resolve(own), resolve(theirs));

function arrange(name, list) {
  list = (list || []).filter(Boolean);
  const out = [];
  const extra = [];
  // a separator goes with the items before it (another module's separators move with its items)
  let ours = true;
  for (const it of list) {
    if (it !== '-') ours = BASE.has(it) || !!it.slot;
    (ours ? out : extra).push(it);
  }
  // an item another module defines again (same action or label) takes the place of ours
  const leftovers = [];
  for (const it of extra) {
    if (it === '-' || it.group || !it.label) {
      leftovers.push(it);
      continue;
    }
    const i = out.findIndex((b) => BASE.has(b) && same(b, it));
    if (i < 0) leftovers.push(it);
    else if (out[i].submenu && it.submenu) out[i].submenu = mergeSub(out[i].submenu, it.submenu);
    else out[i] = it;
  }
  const unplaced = [];
  const afterCount = new Map();
  for (const it of leftovers) {
    const rule = it.label && (PLACE[name] || []).find(([re]) => re.test(it.label))?.[1];
    if (rule?.into) {
      const host = out.find((b) => BASE.has(b) && b.submenu && matches(b, rule.into));
      if (host) {
        host.submenu = mergeSub(host.submenu, [it]);
        continue;
      }
    }
    if (rule?.after) {
      const i = out.findIndex((b) => b !== '-' && BASE.has(b) && matches(b, rule.after));
      if (i >= 0) {
        const n = afterCount.get(i) || 0;
        out.splice(i + 1 + n, 0, it);
        // later anchors moved down by one
        for (const [k, v] of [...afterCount]) if (k > i) afterCount.set(k + 1, v), afterCount.delete(k);
        afterCount.set(i, n + 1);
        continue;
      }
    }
    if (rule?.at) {
      const i = out.findIndex((b) => b?.slot === rule.at);
      if (i >= 0) {
        out.splice(i, 0, it);
        continue;
      }
    }
    unplaced.push(it);
  }
  if (name === '창') sortPanels(out);
  // the rest go before the closing section (a {slot: 'tail'} marker), or at the end
  const tail = out.findIndex((b) => b?.slot === 'tail');
  if (unplaced.length) {
    if (tail >= 0) out.splice(tail, 0, '-', ...unplaced, '-');
    else out.push(...unplaced);
  }
  // a submenu kept for other modules' items stays hidden while it is empty
  const result = out.filter((it) => !it?.slot && !(it?.hideEmpty && !resolve(it.submenu).some((x) => x && x !== '-')));
  // separators only between items
  const tidy = result.filter((it, i) => it !== '-' || (i > 0 && i < result.length - 1 && result[i - 1] !== '-'));
  return hasCustomKeys() ? withCustomKeys(name, [], tidy) : tidy;
}

/** Show the shortcuts a person assigned (편집 ▸ 키보드 단축키) in place of the default ones. */
function withCustomKeys(menu, path, list) {
  return list.map((it) => {
    if (!it || it === '-' || !it.label) return it;
    const p = [...path, it.label];
    const k = customKeyForPath(menu, p);
    let out = k ? { ...it, key: k } : it;
    if (it.submenu) {
      const sub = it.submenu;
      out = { ...out, submenu: () => withCustomKeys(menu, p, (typeof sub === 'function' ? sub() : sub) || []) };
    }
    return out;
  });
}

// ---------------------------------------------------------------- small commands of the menus

const sel = () => store.selectedClips();
const has = () => sel().length > 0;

async function renameClip() {
  const list = sel();
  if (list.length !== 1) return toast('이름을 바꿀 클립을 하나만 선택하세요');
  const name = await promptDialog('클립 이름 바꾸기', '클립 이름', list[0].name || '');
  if (name != null && name.trim()) edit.renameClip(list[0].id, name.trim());
}

async function saveAs() {
  const name = await promptDialog('다른 이름으로 저장', '프로젝트 이름 (파일 이름)', store.project.name);
  if (name == null || !name.trim()) return;
  if (name.trim() !== store.project.name) store.transact('프로젝트 이름 바꾸기', () => { store.project.name = name.trim(); });
  c.saveProject();
}

function duplicate() {
  if (!has()) return toast('복제할 클립을 선택하세요');
  duplicateClips([...store.selection.clips]);
}

const linkedSel = () => sel().some((x) => x.linkId);

// ---------------------------------------------------------------- the menus

function videoMenus() {
  const pk = (id) => (PANEL_KEYS[id] ? `Shift+${PANEL_KEYS[id]}` : undefined);
  const panel = (id, label) => ({ label, key: pk(id), action: () => c.showPanel(id) });
  return {
    '파일': () => base([
      // the header bar's house button (Premiere's 홈 screen)
      c.home ? { label: '홈', hint: '최근 프로젝트', action: c.home } : null,
      {
        label: '새로 만들기',
        submenu: () => base([
          { label: '프로젝트…', key: `${mod}Alt+N`, action: c.newProject },
          { label: '시퀀스', action: c.newSequence },
          c.newSequenceFromClip ? { label: '시퀀스 (클립에서)', action: c.newSequenceFromClip } : null,
          '-',
          { label: '조정 레이어', action: c.newAdjustment },
          { label: '색상 매트…', action: c.newColorMatte },
          { label: '블랙 비디오', action: c.newBlack },
        ]),
      },
      { label: '프로젝트 열기…', key: `${mod}O`, action: c.openProject },
      '-',
      { label: '저장', key: `${mod}S`, hint: '프로젝트 파일', action: () => c.saveProject() },
      { label: '다른 이름으로 저장…', key: `${mod}Shift+S`, action: saveAs },
      { label: '프로젝트 이름 바꾸기…', action: c.renameProject },
      '-',
      { label: '가져오기…', key: `${mod}I`, hint: '영상·오디오·이미지·LUT', action: c.importMedia },
      { label: '캡션 가져오기 (.srt)…', action: c.importCaptions },
      { label: '미디어 연결…', action: c.linkMedia },
      '-',
      {
        label: '내보내기',
        submenu: () => base([
          { label: '미디어…', key: `${mod}M`, action: c.exportMedia },
          { label: '프레임…', key: `${mod}Shift+E`, hint: 'PNG · JPEG', action: c.exportFrame },
          { label: '캡션 (.srt)', action: c.exportCaptions },
          '-',
          { label: '프레임을 사진 편집에서 열기', action: c.frameToPhoto },
        ]),
      },
      { slot: 'tail' },
      '-',
      { label: '샘플 프로젝트 열기', action: c.loadSample },
    ]),
    '편집': () => base([
      { label: `실행 취소${store.undoStack.length ? `: ${store.undoStack[store.undoStack.length - 1].label}` : ''}`, key: `${mod}Z`, disabled: !store.undoStack.length, action: c.undo },
      { label: `다시 실행${store.redoStack.length ? `: ${store.redoStack[store.redoStack.length - 1].label}` : ''}`, key: `${mod}Shift+Z`, disabled: !store.redoStack.length, action: c.redo },
      '-',
      { label: '잘라내기', key: `${mod}X`, disabled: !has(), action: c.cut },
      { label: '복사', key: `${mod}C`, disabled: !has(), action: c.copy },
      { label: '붙여넣기', key: `${mod}V`, disabled: !store.ui.clipboard, action: c.paste },
      { label: '삽입 붙여넣기', key: `${mod}Shift+V`, disabled: !store.ui.clipboard, action: c.pasteInsert },
      { label: '특성 붙여넣기…', key: `${mod}Alt+V`, disabled: !store.ui.clipboard || !has(), action: c.pasteAttributes },
      { label: '특성 제거…', disabled: !has(), action: c.removeAttributes || c.removeEffects },
      '-',
      { label: '지우기', key: 'Delete', action: c.clear },
      { label: '잔물결 삭제', key: 'Shift+Delete', hint: '빈자리 당김', action: c.rippleDelete },
      { label: '복제', key: `${mod}Shift+/`, disabled: !has(), action: duplicate },
      '-',
      { label: '모두 선택', key: `${mod}A`, action: c.selectAll },
      { label: '모두 선택 해제', key: `${mod}Shift+A`, action: c.deselectAll },
      '-',
      { label: '레이블', disabled: !has(), submenu: () => LABEL_COLORS.map(([color, name]) => ({ label: name, swatch: color || 'transparent', action: () => c.setLabel(color) })) },
      '-',
      { slot: 'prefs' },
      { label: '키보드 단축키…', key: `${mod}Alt+K`, action: openKeyboardShortcuts },
      {
        label: '환경 설정',
        submenu: () => [
          { label: '모양…', hint: '밝기', action: openAppearanceDialog },
          { label: '화면 크기', submenu: () => UI_SCALES.map(([v, name]) => ({ label: name, checked: Math.abs(uiScale() - v) < 0.01, action: () => c.uiScale(v) })) },
          { label: '오디오 스크러빙 (끌 때 소리 듣기)', checked: !!store.ui.audioScrub, action: c.toggleAudioScrub },
          {
            label: '기본 미디어 비율 조정',
            submenu: () => edit.MEDIA_SCALING.map(([v, name]) => ({
              label: name,
              checked: edit.defaultMediaScaling() === v,
              action: () => {
                edit.setDefaultMediaScaling(v);
                toast(`새로 놓는 클립: ${name}`);
              },
            })),
          },
        ],
      },
    ]),
    '클립': () => base([
      { label: '이름 바꾸기…', disabled: sel().length !== 1, action: renameClip },
      // Premiere's Clip ▸ Modify (shown once a module adds to it)
      { label: '수정', hideEmpty: true, submenu: () => base([]) },
      '-',
      {
        label: '비디오 옵션',
        disabled: !sel().some((x) => x.kind !== 'audio'),
        submenu: () => base([
          c.frameHoldOptions ? { label: '프레임 고정 옵션…', action: c.frameHoldOptions } : null,
          { label: '프레임 고정 추가', action: c.frameHold },
          c.frameHoldSegment ? { label: '프레임 고정 세그먼트 삽입', action: c.frameHoldSegment } : null,
          '-',
          c.scaleToFrameSize ? { label: '프레임 크기로 비율 조정', action: c.scaleToFrameSize } : null,
          c.setToFrameSize ? { label: '프레임 크기로 설정', action: c.setToFrameSize } : null,
        ]),
      },
      {
        label: '오디오 옵션',
        submenu: () => base([
          c.audioGain ? { label: '오디오 게인…', key: 'G', disabled: !has(), action: c.audioGain } : null,
          { label: '오디오 추출…', action: c.extractAudio },
          { label: '노멀라이즈 (최대 -1 dB)', disabled: !has(), action: c.normalize },
        ]),
      },
      { label: '속도/지속 시간…', key: `${mod}R`, disabled: !has(), action: c.speedDuration },
      { label: '역재생', disabled: !has(), action: c.reverse },
      { label: '장면 편집 감지…', disabled: !sel().some((x) => x.kind === 'video'), action: c.sceneDetect },
      '-',
      { label: '삽입', key: ',', hint: '소스에서', action: c.insert },
      { label: '덮어쓰기', key: '.', hint: '소스에서', action: c.overwrite },
      c.replaceFromSource ? {
        label: '다음으로 바꾸기',
        disabled: !has(),
        submenu: () => [
          { label: '소스 모니터', action: c.replaceFromSource },
          c.replaceFromSourceMatch ? { label: '소스 모니터, 일치하는 프레임', action: c.replaceFromSourceMatch } : null,
          c.replaceFromBin ? { label: '저장소 (선택한 프로젝트 항목)', action: c.replaceFromBin } : null,
        ],
      } : null,
      '-',
      { label: '사용', key: 'Shift+E', checked: has() && sel()[0].enabled !== false, disabled: !has(), action: c.toggleEnable },
      { label: linkedSel() ? '연결 해제' : '연결', key: `${mod}L`, disabled: !has() || (!linkedSel() && sel().length < 2), action: c.linkToggle },
      c.group ? { label: '그룹', key: `${mod}G`, disabled: sel().length < 2, action: c.group } : null,
      c.ungroup ? { label: '그룹 해제', key: `${mod}Shift+G`, disabled: !sel().some((x) => x.groupId), action: c.ungroup } : null,
      { label: '중첩…', disabled: !has(), action: c.nest },
      '-',
      { label: '멀티 카메라 소스 시퀀스 만들기…', action: c.multicamCreate },
      { label: '멀티 카메라', submenu: () => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `카메라 ${n}`, key: String(n), action: () => c.switchAngle(n) })) },
      { slot: 'tail' },
      '-',
      {
        label: '빠른 편집',
        submenu: () => [
          { label: '애니메이션 (등장·퇴장·반복)', action: () => c.quick('anim') },
          { label: '필터', action: () => c.quick('filter') },
          { label: '화면 위치 · 배경 채우기 · 비율', action: () => c.quick('frame') },
          { label: '목소리 효과 (로봇·전화·동굴…)', action: () => c.quick('audio') },
        ],
      },
      { label: '효과 모두 제거', disabled: !has(), action: c.removeEffects },
      { label: '왼쪽으로 1프레임 이동', key: 'Alt+←', disabled: !has(), action: c.nudgeLeft },
      { label: '오른쪽으로 1프레임 이동', key: 'Alt+→', disabled: !has(), action: c.nudgeRight },
    ]),
    '시퀀스': () => base([
      { label: '시퀀스 설정…', action: c.sequenceSettings },
      '-',
      { label: '프레임 일치', key: 'F', hint: '소스 모니터에서 원본 열기', action: c.matchFrame },
      { label: '편집 추가', key: `${mod}K`, action: c.addEdit },
      { label: '모든 트랙에 편집 추가', key: `${mod}Shift+K`, action: c.addEditAll },
      { label: '이전 편집 지점을 재생 헤드로 잔물결 트리밍', key: 'Q', action: c.rippleTrimPrev },
      { label: '다음 편집 지점을 재생 헤드로 잔물결 트리밍', key: 'W', action: c.rippleTrimNext },
      '-',
      { label: '비디오 전환 적용', key: `${mod}D`, action: c.applyVideoTransition },
      { label: '오디오 전환 적용', key: `${mod}Shift+D`, action: c.applyAudioTransition },
      { label: '선택 항목에 기본 전환 적용', key: 'Shift+D', action: c.applyDefaultTransitions },
      '-',
      { label: '들어 올리기', key: ';', hint: '시작~종료 지우기', action: c.lift },
      { label: '추출', key: "'", hint: '시작~종료 지우고 당기기', action: c.extract },
      '-',
      { label: '확대', key: '=', action: c.zoomIn },
      { label: '축소', key: '-', action: c.zoomOut },
      { label: '시퀀스로 확대/축소', key: '\\', action: c.zoomFit },
      '-',
      { label: '간격 닫기', hint: '모든 빈자리', action: c.closeGaps },
      '-',
      { label: '타임라인에서 스냅', key: 'S', checked: store.ui.snapping, action: c.toggleSnap },
      { label: '연결된 선택', checked: store.ui.linkedSelection, action: c.toggleLinked },
      '-',
      { label: '자동 리프레임 시퀀스…', hint: '세로·정사각형', action: c.autoReframe },
      { label: '시퀀스 자동화 (사진 슬라이드쇼)…', action: c.slideshow },
      { slot: 'seqTools' },
      '-',
      { label: '비디오 트랙 추가', action: c.addVideoTrack },
      { label: '오디오 트랙 추가', action: c.addAudioTrack },
      { label: '보이스오버 녹음', hint: '대상 오디오 트랙', action: c.voiceover },
      { slot: 'tail' },
      '-',
      { label: '시퀀스 복제', action: c.duplicateSequence },
      { label: '시퀀스 삭제', action: c.deleteSequence },
    ]),
    '마커': () => base([
      { label: '시작 표시', key: 'I', action: c.markIn },
      { label: '종료 표시', key: 'O', action: c.markOut },
      { label: '클립 표시', key: 'X', action: c.markClip },
      c.markSelection ? { label: '선택 항목 표시', key: '/', disabled: !has(), action: c.markSelection } : null,
      '-',
      { label: '시작으로 이동', key: 'Shift+I', action: c.goIn },
      { label: '종료로 이동', key: 'Shift+O', action: c.goOut },
      '-',
      { label: '시작 지우기', key: `${mod}Shift+I`, action: c.clearIn },
      { label: '종료 지우기', key: `${mod}Shift+O`, action: c.clearOut },
      { label: '시작 및 종료 지우기', key: `${mod}Shift+X`, action: c.clearInOut },
      '-',
      { label: '마커 추가', key: 'M', action: c.addMarker },
      { label: '다음 마커로 이동', key: 'Shift+M', action: c.nextMarker },
      { label: '이전 마커로 이동', key: `${mod}Shift+M`, action: c.prevMarker },
      c.clearSelectedMarker ? { label: '선택한 마커 지우기', key: `${mod}Alt+M`, action: c.clearSelectedMarker } : null,
      { label: '모든 마커 지우기', key: `${mod}Alt+Shift+M`, action: c.clearMarkers },
      '-',
      { label: '마커 편집…', action: c.editMarker },
      c.addChapterMarker ? { label: '챕터 마커 추가', action: c.addChapterMarker } : null,
    ]),
    '그래픽 및 타이틀': () => base([
      {
        label: '새 레이어',
        submenu: () => base([
          { label: '텍스트', action: c.newText },
          { label: '사각형', key: `${mod}Alt+R`, action: c.newRectangle },
          { label: '타원', key: `${mod}Alt+E`, action: c.newEllipse },
          { label: '삼각형', action: c.newTriangle },
          { label: '선', action: c.newLine },
        ]),
      },
      { label: '문자 도구', key: 'T', hint: '모니터를 클릭해 입력', action: () => store.setTool('type') },
      { slot: 'arrange' },
      '-',
      { label: '타이틀 템플릿', submenu: () => templateMenu((id) => c.template(id)) },
      { label: '글자 스타일', action: () => c.quick('text') },
      { label: '스티커', action: () => c.quick('sticker') },
      '-',
      { group: '캡션' },
      { label: '자동 캡션 만들기 (음성 인식)…', action: c.autoCaptions },
      { label: '캡션 가져오기 (.srt)…', action: c.importCaptions },
      { label: '캡션 내보내기 (.srt)', action: c.exportCaptions },
      { slot: 'captions' },
    ]),
    '보기': () => base([
      { slot: 'tail' },
      '-',
      { group: '재생' },
      { label: '재생 / 정지', key: 'Space', action: c.playStop },
      { label: '시작에서 종료까지 재생', key: `${mod}Shift+Space`, action: c.playInToOut },
      { label: '반복 재생', key: `${mod}Shift+L`, checked: playback.loop, action: c.toggleLoop },
      { label: '오디오 스크러빙 (끌 때 소리 듣기)', checked: !!store.ui.audioScrub, action: c.toggleAudioScrub },
    ]),
    '창': () => base([
      {
        label: '작업 영역',
        submenu: () => [
          ...WORKSPACES.map((w) => ({ label: w.name, action: () => c.workspace(w.id) })),
          '-',
          { label: '레이아웃 초기화', hint: '새로 고침', action: c.resetLayout },
        ],
      },
      // the phone layout shows one panel at a time (no frames to maximize)
      { label: '프레임 최대화', key: 'Shift+`', disabled: document.body.classList.contains('mobile'), action: () => toggleMaximize({ active: true }) },
      '-',
      // Premiere's order (its English names, alphabetically); panels other modules add follow
      panelIds().includes('clipMixer') ? panel('clipMixer', '오디오 클립 믹서') : null,
      panel('mixer', '오디오 트랙 믹서'),
      panel('effectControls', '효과 컨트롤'),
      panel('effects', '효과'),
      panel('history', '작업 내역'),
      panel('scopes', 'Lumetri 범위'),
      panel('markers', '마커'),
      panel('multicam', '멀티 카메라'),
      panel('program', '프로그램 모니터'),
      panel('project', '프로젝트'),
      panel('source', '소스 모니터'),
      panel('timeline', '타임라인'),
      { slot: 'panels' },
      '-',
      panel('quick', '빠른 편집'),
      panel('ai', 'AI 편집'),
      { slot: 'tail' },
      '-',
      { label: '화면 크기', submenu: () => UI_SCALES.map(([v, name]) => ({ label: name, checked: Math.abs(uiScale() - v) < 0.01, action: () => c.uiScale(v) })) },
    ]),
    'AI': () => base([
      { label: 'AI로 전체 편집하기…', action: () => c.ai('auto') },
      { label: 'AI 편집 도우미 (Gemini)…', action: () => c.ai('chat') },
      { label: '대본으로 편집 (자막 고치기·줄 잘라내기)', action: () => c.ai('script') },
      { label: 'Gemini API 키 설정…', action: () => c.ai('settings') },
      '-',
      { label: '자동 캡션 만들기 (음성 인식)…', action: c.autoCaptions },
      { label: '무음 구간 자동 삭제 (점프 컷)…', action: c.silenceCut },
      { label: '비트 마커 (음악 박자 맞추기)…', action: c.beatMarkers },
      { label: '장면 편집 감지…', action: c.sceneDetect },
      { label: '자동 더킹 (말할 때 음악 줄이기)…', action: c.autoDuck },
    ]),
    '도움말': () => base([
      { label: '설명서 (모든 기능)', action: () => openManual() },
      { label: '시작 가이드', action: c.guide },
      { label: '키보드 단축키', key: 'F1', action: openKeyboardShortcuts },
      { label: '샘플 프로젝트 열기', action: c.loadSample },
      { slot: 'tail' },
      '-',
      { label: 'Montage 웹사이트 (새 탭)', action: () => window.open('index.html', '_blank', 'noopener') },
      { label: 'Montage 정보', action: c.about },
    ]),
  };
}

/** The menus in Premiere's order, each arranged (other modules' items placed). */
function orderedMenus(raw) {
  const names = Object.keys(raw);
  const extra = names.filter((n) => !ORDER.includes(n));
  const order = ORDER.filter((n) => raw[n]);
  order.splice(order.indexOf('AI') >= 0 ? order.indexOf('AI') : order.length, 0, ...extra);
  return Object.fromEntries(order.map((n) => [n, () => arrange(n, raw[n]())]));
}

export function createMenubar(el) {
  const raw = videoMenus();
  for (const [n, fn] of extendMenu.pending || []) applyExtension(raw, n, fn);
  for (const apply of menubarApi.extenders) apply(raw);
  extendMenu.pending = [];
  menubarApi.extenders = [];
  menubarApi.videoMenus = raw;
  let menus = orderedMenus(raw);
  menubarApi.menus = menus;
  // the video menus, also while the photo editor's menus are on the bar (keyboard shortcuts)
  menubarApi.video = () => menus;
  el.append(h('span.brand', 'Montage'));
  // 영상 / 사진: the two editors share this bar; each brings its own menus
  // the short label ("영상") shows on the compact bars; " 편집" is spelled out on wider ones
  const modeBtns = [['video', '영상'], ['photo', '사진']].map(([id, label]) => h('button.mode-btn', { 'data-mode': id, 'aria-pressed': 'false', 'aria-label': `${label} 편집`, title: `${label} 편집기로 바꾸기`, onclick: () => setMode(id) }, label, h('span.mode-sfx', ' 편집')));
  el.append(h('div.mode-switch', { role: 'group', 'aria-label': '편집기 바꾸기' }, modeBtns));
  const menuWrap = h('div.menu-btns', { role: 'menubar' });
  el.append(menuWrap);
  const buttons = [];
  const renderMenus = () => {
    closeMenus();
    buttons.length = 0;
    menuWrap.replaceChildren();
    for (const name of Object.keys(menubarApi.menus)) {
      const mn = mnemonicOf(name);
      const b = h('button.menu-btn', { 'aria-haspopup': 'menu', 'aria-keyshortcuts': mn ? `Alt+${mn}` : null, title: mn ? `${name} (Alt+${mn})` : null }, name);
      b.dataset.menu = name;
      const open = (select = false) => {
        const r = b.getBoundingClientRect();
        // look the menu up when it opens: modules may extend it after the bar was built
        const items = menubarApi.menus[name];
        if (!items) return;
        showMenu(items, r.left, r.bottom + 2, { select, nav: { step: (dir) => step(b, dir) } });
        buttons.forEach((x) => x.classList.remove('open'));
        b.classList.add('open');
      };
      b.open = open;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.classList.contains('open')) closeMenus();
        else open(e.detail === 0); // Enter / Space on the button: highlight the first item
      });
      b.addEventListener('pointerenter', () => {
        if (buttons.some((x) => x.classList.contains('open') && x !== b) && document.querySelector('.menu')) open();
      });
      buttons.push(b);
      menuWrap.append(b);
    }
  };
  // ← → while a menu is open: the neighbouring menu
  const step = (b, dir) => {
    const i = buttons.indexOf(b);
    if (i < 0 || !buttons.length) return;
    buttons[(i + dir + buttons.length) % buttons.length].open(true);
  };
  // F10 / Alt+letter: open a menu with its first item highlighted (true when one opened)
  menubarApi.openMenu = (letter = null) => {
    const b = letter ? buttons.find((x) => mnemonicOf(x.dataset.menu) === letter) : buttons[0];
    if (!b || !b.isConnected || !b.offsetParent) return false;
    b.open(true);
    return true;
  };
  menubarApi.rebuild = () => {
    menus = orderedMenus(raw);
    if (!appMode.isPhoto()) {
      menubarApi.menus = menus;
      renderMenus();
    }
  };
  extendMenu.state = {
    add: (n, fn) => {
      applyExtension(raw, n, fn);
      menubarApi.rebuild();
    },
  };
  renderMenus();
  const name = h('span.project-name');
  const saved = h('span.saved');
  // in the photo editor the same button lists its shortcuts
  const guideLabel = h('span', '시작 가이드');
  const guideBtn = h('button.guide-btn', { onclick: () => (appMode.isPhoto() ? photoShortcutsItem()?.action?.() : c.guide()), title: '처음 쓰는 분을 위한 안내', 'aria-label': '시작 가이드' }, icon('help', 16), guideLabel);
  const exportBtn = h('button.primary.export-btn', { onclick: () => (appMode.isPhoto() ? appMode.P.exportDialog() : c.exportMedia()) }, '내보내기');
  const docsBtn = h('button.docs-open-btn', { onclick: () => openManual(), title: '모든 기능 설명서', 'aria-label': '설명서' }, icon('book', 16), h('span', '설명서'));
  el.append(h('span.spacer'), name, saved, docsBtn, guideBtn, exportBtn);
  const refresh = () => {
    const P = appMode.isPhoto() ? appMode.P : null;
    name.textContent = P ? (P.doc ? `${P.doc.name} · ${P.doc.width}×${P.doc.height}` : '사진 편집') : store.project.name;
    name.title = name.textContent;
    guideLabel.textContent = P ? '단축키' : '시작 가이드';
    guideBtn.setAttribute('aria-label', guideLabel.textContent);
    guideBtn.title = P ? '사진 편집 단축키' : '처음 쓰는 분을 위한 안내';
    for (const b of modeBtns) {
      const on = b.dataset.mode === appMode.current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  store.on('change', refresh);
  store.on('saved', (d) => { if (!appMode.isPhoto()) saved.textContent = `자동 저장됨 ${d.toLocaleTimeString('ko-KR')}`; });
  let photoHooked = false;
  appMode.on((m) => {
    menubarApi.menus = m === 'photo' && appMode.P ? appMode.P.menus : menus;
    if (appMode.P && !photoHooked) {
      photoHooked = true;
      appMode.P.on('doc', refresh);
      appMode.P.on('history', refresh);
      appMode.P.on('saved', () => { if (appMode.isPhoto()) saved.textContent = `자동 저장됨 ${new Date().toLocaleTimeString('ko-KR')}`; });
    }
    saved.textContent = '';
    renderMenus();
    refresh();
  });
  refresh();
  installKeymap();
}
