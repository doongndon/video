// Learn panel lessons (learn.js runs them). Lessons are data: a practice file to open and steps.
// A step: t (what), d (how), why, path (menu path, shown and pointed at), key (shortcut),
// show (what '보여 주기' points at when it is not the menu path: { tool } · { panel, sel } · { sel } ·
// { text, within }), done(s) (true when the app state shows the step is done; none: '다음' only).
// `s` (see learn.js): doc, layers, active, tool, sel, count, base, did(re), times(re), kind(k),
// adj(type), fx(key), blend(mode), named(name), panel(id), opt(tool, key), modal(re), changed(kind).

import * as X from './practice.js';

const W = 1200;
const H = 800;
const PW = 900;
const PH = 1100;

const layer = (name, canvas, props = {}) => ({ name, canvas, ...props });

// ---------------------------------------------------------------- practice files

const FILES = {
  layers: () => ({ width: W, height: H, layers: [layer('배경', X.landscape(W, H)), layer('열기구', X.balloon(240), { x: 760, y: 70 })], active: 0 }),
  select: () => ({ width: W, height: H, layers: [layer('배경', X.fruitTable(W, H))] }),
  mask: () => ({ width: W, height: H, layers: [layer('배경', X.landscape(W, H)), layer('노을', X.landscape(W, H, { sky: 'sunset', seed: 12 }))], active: 0 }),
  adjust: () => ({ width: W, height: H, layers: [layer('배경', X.landscape(W, H, { dark: true }))] }),
  type: () => ({ width: W, height: H, layers: [layer('배경', X.landscape(W, H, { sky: 'sunset', seed: 13 }))] }),
  transform: () => ({ width: W, height: H, layers: [layer('배경', X.landscape(W, H)), layer('열기구', X.balloon(240), { x: 480, y: 120 })] }),
  brush: () => ({ width: W, height: H, layers: [layer('배경', X.solid(W, H, '#ffffff')), layer('그림', X.solid(W, H, 'transparent'))] }),
  portraitClose: () => ({ width: PW, height: PH, layers: [layer('배경', X.portrait(PW, PH, { blemishes: 28, close: true }))] }),
  portraitStudio: () => ({ width: PW, height: PH, layers: [layer('배경', X.portrait(PW, PH, { back: 'studio' }))] }),
  portraitOutdoor: () => ({ width: PW, height: PH, layers: [layer('배경', X.portrait(PW, PH, { back: 'outdoor' }))] }),
  portraitWhite: () => ({ width: PW, height: PH, layers: [layer('배경', X.portrait(PW, PH, { back: 'white', shirt: '#c0392b' }))] }),
  skyDull: () => ({ width: W, height: H, layers: [layer('배경', X.landscape(W, H, { sky: 'dull' }))] }),
  dark: () => ({ width: W, height: H, layers: [layer('배경', X.landscape(W, H, { dark: true, seed: 14 }))] }),
  double: () => ({
    width: PW, height: PH,
    layers: [layer('배경', X.solid(PW, PH, '#f4f4f2')), layer('인물', X.portrait(PW, PH, { back: 'white' })), layer('숲', X.forest(PW, PH))],
  }),
  shadow: () => ({ width: W, height: 900, layers: [layer('배경', X.studioFloor(W, 900)), layer('제품', X.bottle(W, 900, 640))] }),
  bricks: () => ({ width: W, height: H, layers: [layer('배경', X.bricks(W, H))] }),
  card: () => ({ width: 1080, height: 1080, layers: [layer('배경', X.solid(1080, 1080, '#f3efe6')), layer('사진', X.landscape(1080, 720, { sky: 'sunset', seed: 15 }), { y: 180 })], active: 1 }),
  motif: () => ({ width: 400, height: 400, layers: [layer('배경', X.motif(400))] }),
  gif: () => ({
    width: 800, height: 600,
    layers: [layer('배경', X.landscape(800, 600)), ...[[150, 380], [400, 200], [650, 380]].map(([x, y], i) => layer(`공 ${i + 1}`, X.ball(800, 600, x, y, 50)))],
  }),
};

// ---------------------------------------------------------------- shared steps

const newLayerStep = (t = '새 레이어 만들기', why = '원본을 건드리지 않고 그 위에서 작업하면 언제든 지우고 다시 할 수 있습니다.') => ({
  t, d: '레이어 패널 아래의 + 단추(새 레이어)를 누르거나 레이어 ▸ 새로 만들기 ▸ 레이어…를 고르세요.',
  why, path: ['레이어', '새로 만들기', '레이어…'], key: 'Ctrl+Shift+N', show: { panel: 'layers', sel: '[aria-label="새 레이어"]' },
  done: (s) => s.count > s.base.count,
});
const dupStep = (t = '레이어 복제하기', d = '레이어 ▸ 새로 만들기 ▸ 복사한 레이어(Ctrl+J)로 지금 레이어를 한 장 더 만드세요.', why = '복사본에서 작업하면 원본이 아래에 그대로 남습니다.') => ({
  t, d, why, path: ['레이어', '새로 만들기', '복사한 레이어'], key: 'Ctrl+J', done: (s) => s.count > s.base.count,
});
const blendStep = (mode, name, why) => ({
  t: `혼합 모드를 '${name}'(으)로`, d: `레이어 패널 위쪽의 혼합 모드 목록(처음에는 '표준')에서 '${name}'을(를) 고르세요.`,
  why, show: { panel: 'layers', sel: 'select[aria-label="혼합 모드"]' }, done: (s) => s.blend(mode),
});
const gaussStep = (t, d, why, n = 1) => ({
  t, d, why, path: ['필터', '흐림 효과', '가우시안 흐림 효과…'], done: (s) => s.times(/가우시안 흐림/) >= n,
});
const adjStep = (type, name, d, why) => ({
  t: `${name} 조정 레이어`, d: d || `레이어 ▸ 새 조정 레이어 ▸ ${name}…를 고르면 속성 패널에 설정이 나옵니다.`,
  why, path: ['레이어', '새 조정 레이어', `${name}…`], done: (s) => s.adj(type),
});
const toolStep = (tool, t, d, why, key) => ({ t, d, why, key, show: { tool }, done: (s) => s.tool === tool });

// ---------------------------------------------------------------- lessons

export const LESSON_GROUPS = ['기초', '보정', '합성', '디자인'];

export const LESSONS = [
  // ------------------------------------------------ basics
  {
    id: 'layers', group: '기초', title: '레이어', min: 5, file: 'layers',
    intro: '레이어는 투명한 필름을 겹쳐 놓은 것과 같습니다. 열기구를 옮기고, 새 레이어에 그리고, 순서와 불투명도를 바꿔 봅니다.',
    steps: [
      { t: '레이어 패널 보기', d: '창 ▸ 레이어(F7)를 누르세요. 오른쪽 아래 레이어 패널에 \'배경\'과 \'열기구\'가 보입니다.', why: '위에 있는 레이어가 화면에서 앞에 보입니다.', path: ['창', '레이어'], key: 'F7', show: { panel: 'layers' }, done: (s) => s.panel('layers') },
      { t: '열기구 레이어 고르기', d: '레이어 패널에서 \'열기구\' 줄을 누르세요.', why: '작업은 언제나 고른(파랗게 표시된) 레이어에만 적용됩니다.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.active?.name === '열기구' },
      { t: '이동 도구로 옮기기', d: '이동 도구(V)를 고르고 열기구를 끌어 다른 곳에 놓으세요.', why: '레이어가 나뉘어 있어서 배경은 그대로 두고 열기구만 움직일 수 있습니다.', key: 'V', show: { tool: 'move' }, done: (s) => s.did(/이동/) },
      newLayerStep(),
      { t: '새 레이어에 그리기', d: '브러시 도구(B)를 고르고 하늘에 새나 구름을 그려 보세요.', why: '새 레이어에 그린 것은 배경 사진과 섞이지 않아 나중에 따로 지우거나 옮길 수 있습니다.', key: 'B', show: { tool: 'brush' }, done: (s) => s.did(/브러시/) },
      { t: '불투명도 낮추기', d: '레이어 패널의 불투명도 칸에 50을 넣거나 숫자 키 5를 누르세요.', why: '불투명도로 레이어를 반쯤 비치게 해서 아래와 자연스럽게 섞습니다.', show: { panel: 'layers', sel: 'input[aria-label="불투명도"]' }, done: (s) => s.layers.some((l) => l.opacity < 1) },
      { t: '레이어 순서 바꾸기', d: '레이어 ▸ 정돈 ▸ 뒤로(Ctrl+[)를 누르거나, 레이어 패널에서 줄을 위아래로 끌어 보세요.', why: '순서가 바뀌면 무엇이 앞에 보이는지가 바뀝니다.', path: ['레이어', '정돈', '뒤로'], key: 'Ctrl+[', done: (s) => s.did(/레이어 순서/) },
      { t: '숨기고 다시 보이기', d: '레이어 줄 왼쪽의 눈 아이콘을 눌러 레이어를 숨겨 보세요. 다시 누르면 보입니다.', why: '숨긴 레이어는 지워지지 않습니다. 전과 후를 비교할 때 자주 씁니다.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.layers.some((l) => !l.visible) },
    ],
  },
  {
    id: 'select', group: '기초', title: '선택', min: 5, file: 'select',
    intro: '선택 영역을 만들면 그 안만 바뀝니다. 오렌지만 남기고 배경을 흑백으로 바꿔 봅니다.',
    steps: [
      toolStep('ellipse', '원형 선택 윤곽 도구', '도구 상자의 사각형 선택 윤곽 칸을 오른쪽 클릭(휴대폰은 길게 누르기)해서 원형 선택 윤곽 도구를 고르세요.', '같은 칸에 비슷한 도구가 묶여 있습니다. Shift+M으로도 바꿀 수 있습니다.', 'M'),
      { t: '오렌지 둘레 선택하기', d: '오렌지 가운데에서 Alt를 누른 채 바깥으로 끌면 가운데부터 원이 그려집니다. Shift를 같이 누르면 정원이 됩니다.', why: '움직이는 점선(개미 행렬)이 선택 영역입니다. 끄는 동안 Space를 누르면 위치를 옮길 수 있습니다.', show: { tool: 'ellipse' }, done: (s) => s.sel },
      { t: '선택 반전', d: '선택 ▸ 반전(Ctrl+Shift+I)을 누르세요. 이제 오렌지를 뺀 나머지가 선택됩니다.', why: '바꾸고 싶은 부분보다 남길 부분을 고르는 게 쉬울 때 씁니다.', path: ['선택', '반전'], key: 'Ctrl+Shift+I', done: (s) => s.did(/선택 반전/) },
      { t: '배경만 흑백으로', d: '이미지 ▸ 조정 ▸ 채도 감소(Ctrl+Shift+U)를 누르세요.', why: '선택 영역 안만 바뀌어서 오렌지 색은 그대로 남습니다.', path: ['이미지', '조정', '채도 감소'], key: 'Ctrl+Shift+U', done: (s) => s.did(/채도 감소/) },
      { t: '선택 해제', d: '선택 ▸ 선택 해제(Ctrl+D)로 점선을 없애세요.', why: '선택이 남아 있으면 다음 작업도 그 안에만 적용됩니다.', path: ['선택', '선택 해제'], key: 'Ctrl+D', done: (s) => !s.sel && s.did(/선택 해제/) },
      { t: '더 쉬운 방법: 개체 선택', d: 'Ctrl+Z로 흑백을 되돌린 뒤, 개체 선택 도구(W)로 오렌지 둘레에 상자를 그려 보세요. 모양을 알아서 따라 선택합니다.', why: '선택 ▸ 피사체를 누르면 한 번에 주인공을 고릅니다.', key: 'W', show: { tool: 'objSel' }, done: (s) => s.tool === 'objSel' && s.sel },
    ],
  },
  {
    id: 'mask', group: '기초', title: '마스크', min: 6, file: 'mask',
    intro: '레이어 마스크는 지우개 대신 쓰는 \'가리개\'입니다. 검정은 숨기고 흰색은 보입니다. 낮 하늘과 노을 사진을 자연스럽게 이어 봅니다.',
    steps: [
      { t: '위 레이어 고르기', d: '레이어 패널에서 \'노을\' 레이어를 누르세요.', why: '마스크는 고른 레이어에 붙습니다.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.active?.name === '노을' },
      { t: '레이어 마스크 추가', d: '레이어 패널 아래의 마스크 단추(사각형 안에 원)를 누르세요. 레이어 줄에 흰색 썸네일이 생깁니다.', why: '지우개로 지우면 되돌릴 수 없지만, 마스크는 언제든 다시 칠해서 되살릴 수 있습니다.', path: ['레이어', '레이어 마스크', '모두 나타내기'], show: { panel: 'layers', sel: '[aria-label^="레이어 마스크 추가"]' }, done: (s) => !!s.active?.mask },
      toolStep('gradient', '그레이디언트 도구', '그레이디언트 도구(G)를 고르세요. D를 누르면 색이 기본(검정·흰색)으로 돌아갑니다.', '검정에서 흰색으로 부드럽게 바뀌는 그레이디언트가 두 사진을 자연스럽게 섞습니다.', 'G'),
      { t: '마스크에 그레이디언트 끌기', d: '마스크 썸네일이 고른 상태(흰 테두리)인지 확인하고, 그림 아래쪽에서 위쪽으로 끄세요.', why: '검정이 된 아래쪽은 노을이 숨고 낮 사진이 보입니다. 다시 끌면 새로 그려집니다.', show: { tool: 'gradient' }, done: (s) => !!s.active?.mask && s.did(/그레이디언트/) },
      { t: '브러시로 다듬기', d: '브러시(B)로 마스크를 칠해 보세요. 검정은 숨기고 흰색은 보입니다. X로 두 색을 바꿉니다.', why: '불투명도를 30%쯤으로 낮추면 조금씩 부드럽게 다듬을 수 있습니다.', key: 'B', show: { tool: 'brush' }, done: (s) => s.did(/브러시/) },
    ],
  },
  {
    id: 'adjust', group: '기초', title: '조정 레이어', min: 5, file: 'adjust',
    intro: '조정 레이어는 원본을 바꾸지 않고 밝기와 색을 고칩니다. 어두운 사진을 밝게 하고 색을 살려 봅니다.',
    steps: [
      { t: '조정 패널 보기', d: '창 ▸ 조정을 누르세요. 아이콘을 누르면 바로 조정 레이어가 생깁니다.', why: '이미지 ▸ 조정은 픽셀을 직접 바꾸고, 조정 레이어는 위에 얹혀서 나중에 고치거나 끌 수 있습니다.', path: ['창', '조정'], show: { panel: 'adjustments' }, done: (s) => s.panel('adjustments') },
      adjStep('levels', '레벨', null, '레벨은 가장 어두운 곳과 가장 밝은 곳을 정해 사진의 대비를 살립니다.'),
      { t: '속성 패널에서 고치기', d: '속성 패널의 히스토그램 아래 흰색 삼각형을 왼쪽으로, 가운데 회색 삼각형도 조금 왼쪽으로 끌어 밝게 하세요.', why: '히스토그램 오른쪽 빈 곳이 없어질 때까지 흰색을 끌면 대비가 좋아집니다.', show: { panel: 'props' }, done: (s) => s.changed('adjust') },
      adjStep('hueSat', '색조/채도', null, '채도를 +20쯤 올리면 색이 살아납니다.'),
      { t: '조정 레이어 마스크에 칠하기', d: '조정 레이어에는 마스크가 함께 생깁니다. 브러시(B)를 검정으로 두고 하늘을 칠하면 거기만 조정이 빠집니다.', why: '조정을 사진의 일부에만 적용하는 방법입니다.', key: 'B', show: { tool: 'brush' }, done: (s) => s.did(/브러시/) },
      { t: '전후 비교', d: '조정 레이어의 눈 아이콘을 눌러 끄고 켜 보세요.', why: '원본이 그대로 있으니 언제든 비교하고 되돌릴 수 있습니다.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.layers.some((l) => l.kind === 'adjust' && !l.visible) },
    ],
  },
  {
    id: 'type', group: '기초', title: '문자', min: 5, file: 'type',
    intro: '사진 위에 제목을 넣고 글꼴, 크기, 색, 그림자를 바꿔 봅니다.',
    steps: [
      toolStep('text', '수평 문자 도구', '도구 상자에서 T 모양의 수평 문자 도구를 고르세요.', '세로 문자, 문자 마스크 도구도 같은 칸에 있습니다.', 'T'),
      { t: '글자 입력하기', d: '그림을 한 번 누르고 \'여름 여행\'처럼 입력한 뒤 Ctrl+Enter(또는 옵션 막대의 체크)로 끝내세요.', why: '누르면 한 줄 글자(점 문자), 끌면 상자 안에서 줄이 바뀌는 단락 문자가 됩니다.', show: { tool: 'text' }, done: (s) => s.kind('text') },
      { t: '문자 패널 열기', d: '창 ▸ 문자를 누르세요.', why: '글꼴, 크기, 자간, 행간, 색을 한곳에서 바꿉니다.', path: ['창', '문자'], show: { panel: 'char' }, done: (s) => s.panel('char') },
      { t: '글꼴 · 크기 · 색 바꾸기', d: '문자 레이어를 고른 채 문자 패널에서 글꼴을 굵게, 크기를 120pt쯤으로, 색을 흰색으로 바꾸세요.', why: '레이어를 고른 채 바꾸면 글자 전체가 한 번에 바뀝니다.', show: { panel: 'char' }, done: (s) => s.changed('text') },
      { t: '위치 옮기기', d: '이동 도구(V)로 글자를 하늘 쪽으로 끌어 놓으세요. 가운데에 오면 분홍색 안내선이 나타납니다.', key: 'V', show: { tool: 'move' }, done: (s) => s.did(/이동/) },
      { t: '드롭 섀도 넣기', d: '레이어 ▸ 레이어 스타일 ▸ 드롭 섀도…에서 거리와 크기를 정하고 확인을 누르세요.', why: '그림자가 있으면 밝은 배경 위에서도 글자가 잘 읽힙니다. 레이어 패널의 fx 단추로도 엽니다.', path: ['레이어', '레이어 스타일', '드롭 섀도…'], done: (s) => s.fx('dropShadow') },
    ],
  },
  {
    id: 'transform', group: '기초', title: '변형', min: 5, file: 'transform',
    intro: '크기, 회전, 뒤집기를 자유 변형으로 해 봅니다. 먼저 고급 개체로 바꾸면 여러 번 바꿔도 화질이 떨어지지 않습니다.',
    steps: [
      { t: '고급 개체로 변환', d: '\'열기구\' 레이어를 고른 채 레이어 ▸ 고급 개체 ▸ 고급 개체로 변환을 누르세요. 썸네일에 작은 표시가 생깁니다.', why: '고급 개체는 원본을 안에 보관해서 줄였다 키워도 흐려지지 않습니다.', path: ['레이어', '고급 개체', '고급 개체로 변환'], done: (s) => s.kind('smart') },
      { t: '자유 변형 시작', d: '편집 ▸ 자유 변형(Ctrl+T)을 누르면 둘레에 조절 상자가 생깁니다.', path: ['편집', '자유 변형'], key: 'Ctrl+T', done: (s) => s.transforming || s.did(/변형/) },
      { t: '크기와 회전', d: '모서리를 끌면 비율을 지키며 크기가 바뀝니다(Shift: 비율 풀기). 상자 바깥에서 끌면 회전합니다. Enter로 적용하세요.', why: 'Alt를 누르고 끌면 가운데를 기준으로 바뀝니다. Esc는 취소입니다.', done: (s) => !s.transforming && s.did(/변형/) },
      { t: '가로로 뒤집기', d: '편집 ▸ 변형 ▸ 가로로 뒤집기를 누르세요.', path: ['편집', '변형', '가로로 뒤집기'], done: (s) => s.did(/뒤집기/) },
      dupStep('하나 더 만들어 작게', '복사한 레이어(Ctrl+J)를 만든 다음, Ctrl+T로 작게 줄여 멀리 있는 열기구처럼 놓아 보세요.', '복사본도 고급 개체라서 원래 크기로 되돌려도 깨끗합니다.'),
    ],
  },
  {
    id: 'brush', group: '기초', title: '브러시', min: 5, file: 'brush',
    intro: '브러시 크기, 경도, 색을 단축키로 바꾸며 그려 봅니다.',
    steps: [
      toolStep('brush', '브러시 도구', '도구 상자에서 브러시 도구(B)를 고르세요.', '연필, 혼합 브러시, 색상 대체 도구도 같은 칸에 있습니다.', 'B'),
      { t: '크기 바꾸기', d: '[ 키를 누르면 작아지고 ] 키를 누르면 커집니다. 옵션 막대에서 숫자로 정해도 됩니다.', why: 'Alt+오른쪽 클릭을 누른 채 좌우로 끌어도 크기가 바뀝니다.', key: '[ / ]', show: { sel: '.ph-opts' }, done: (s) => s.opt('brush', 'size') !== s.base.brushSize },
      { t: '경도 바꾸기', d: 'Shift+[ 로 가장자리를 부드럽게, Shift+] 로 딱딱하게 하세요.', why: '부드러운 브러시는 마스크와 보정에, 딱딱한 브러시는 선명한 선에 씁니다.', key: 'Shift+[ / ]', show: { sel: '.ph-opts' }, done: (s) => s.opt('brush', 'hardness') !== s.base.brushHardness },
      { t: '전경색 고르기', d: '도구 상자 아래의 위쪽 색 사각형(전경색)을 눌러 색상 피커에서 색을 고르세요.', why: '브러시는 전경색으로 칠합니다. D는 기본 색, X는 전경색과 배경색 바꾸기입니다.', show: { sel: '.ph-sw.fg' }, done: (s) => s.fg !== s.base.fg },
      { t: '칠하기와 직선', d: '\'그림\' 레이어에 그려 보세요. 한 번 누르고 Shift를 누른 채 다른 곳을 누르면 직선이 됩니다.', why: '숫자 키 1~0으로 브러시 불투명도를 10~100%로 바꿀 수 있습니다.', done: (s) => s.did(/브러시/) },
      { t: '브러시 모양 바꾸기', d: '창 ▸ 브러시를 열고 다른 브러시(예: 특수 효과 브러시)를 골라 그려 보세요.', why: '.abr 브러시 파일도 편집 ▸ 사전 설정 ▸ 브러시 가져오기…로 넣을 수 있습니다.', path: ['창', '브러시'], show: { panel: 'brushes' }, done: (s) => s.panel('brushes') },
      { t: '지우개', d: '지우개 도구(E)로 그린 것을 조금 지워 보세요.', why: '나중에 다시 살릴 수 있게 지우려면 지우개 대신 레이어 마스크를 씁니다.', key: 'E', show: { tool: 'eraser' }, done: (s) => s.did(/지우개/) },
    ],
  },

  // ------------------------------------------------ retouching
  {
    id: 'freq', group: '보정', title: '주파수 분리', min: 10, file: 'portraitClose',
    intro: '피부의 색(저주파)과 결(고주파)을 두 레이어로 나눠 결은 살리고 얼룩만 매끄럽게 하는 인물 보정 기법입니다.',
    steps: [
      { t: '배경을 두 번 복제', d: 'Ctrl+J를 두 번 눌러 \'배경\' 위에 복사본 두 장을 만드세요.', why: '아래 장은 색(저주파), 위 장은 결(고주파)이 됩니다.', path: ['레이어', '새로 만들기', '복사한 레이어'], key: 'Ctrl+J', done: (s) => s.count >= s.base.count + 2 },
      { t: '이름 붙이기', d: '레이어 이름을 두 번 눌러 아래 복사본은 \'저주파\', 위 복사본은 \'고주파\'로 바꾸세요. 고주파는 잠시 눈을 꺼 두세요.', why: '이름이 있어야 다음 단계에서 헷갈리지 않습니다.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.named('저주파') && s.named('고주파') },
      gaussStep('저주파 흐리게', '\'저주파\'를 고르고 필터 ▸ 흐림 효과 ▸ 가우시안 흐림 효과…에서 잡티와 피부결이 막 사라질 만큼(반경 6~10픽셀) 흐리게 하세요.', '여기서 고른 반경을 기억해 두세요. 색과 얼룩만 남습니다.'),
      { t: '고주파 만들기', d: '\'고주파\'를 보이게 하고 고른 뒤 이미지 ▸ 이미지 적용…에서 레이어: 저주파, 혼합: 빼기, 비율: 2, 오프셋: 128로 두고 확인하세요.', why: '원본에서 흐린 사진을 빼면 회색 위에 피부결만 남습니다.', path: ['이미지', '이미지 적용…'], done: (s) => s.did(/이미지 적용/) },
      blendStep('linear light', '선형 라이트', '고주파를 선형 라이트로 섞으면 원래 사진과 똑같아 보입니다. 이제 두 층을 따로 고칠 수 있습니다.'),
      gaussStep('얼룩만 매끄럽게', '\'저주파\'를 고르고 올가미(L)로 볼처럼 얼룩진 곳을 골라 Shift+F6로 페더 20을 준 뒤 가우시안 흐림을 한 번 더 하세요.', '결은 고주파에 그대로 있어서 피부가 뭉개지지 않습니다.', 2),
      { t: '결 다듬기', d: '\'고주파\'에서 복구 브러시(J, 샘플: 현재 레이어)로 남은 점을 지우세요. 끝나면 \'다음\'을 누르세요.', why: '고주파에는 색이 없어서 결만 깨끗하게 바뀝니다.', key: 'J', show: { tool: 'healBrush' } },
    ],
  },
  {
    id: 'dodgeburn', group: '보정', title: '닷지와 번', min: 7, file: 'portraitStudio',
    intro: '밝게(닷지) 어둡게(번) 칠해서 얼굴에 입체감을 줍니다. 50% 회색 레이어에 해서 원본은 그대로 둡니다.',
    steps: [
      { t: '50% 회색 레이어', d: '레이어 ▸ 새로 만들기 ▸ 레이어…(Ctrl+Shift+N)에서 모드를 \'오버레이\'로 바꾸고 \'오버레이 중간색으로 칠하기 (50% 회색)\'를 켠 뒤 확인하세요.', why: '오버레이에서 50% 회색은 보이지 않습니다. 여기에 밝게, 어둡게 칠한 것만 사진에 보입니다.', path: ['레이어', '새로 만들기', '레이어…'], key: 'Ctrl+Shift+N', done: (s) => s.layers.some((l) => l.kind === 'raster' && (l.blend === 'overlay' || l.blend === 'soft light')) },
      toolStep('dodge', '닷지 도구', '닷지 도구(O)를 고르고 옵션 막대에서 범위: 중간 영역, 노출: 10%쯤으로 두세요.', '노출을 낮게 두고 여러 번 칠해야 자연스럽습니다.', 'O'),
      { t: '밝게 칠하기', d: '이마 가운데, 콧등, 광대 위, 턱 끝처럼 빛이 닿는 곳을 칠하세요.', show: { tool: 'dodge' }, done: (s) => s.did(/닷지/) },
      toolStep('burn', '번 도구', '닷지 칸을 오른쪽 클릭해서 번 도구를 고르세요.', '닷지·번·스폰지 도구가 한 칸에 있습니다.', 'O'),
      { t: '어둡게 칠하기', d: '턱선 아래, 볼 옆, 머리카락 경계처럼 그늘지는 곳을 칠하세요.', show: { tool: 'burn' }, done: (s) => s.did(/^번$/) },
      { t: '세기 조절', d: '회색 레이어의 불투명도를 60%쯤으로 낮춰 자연스럽게 맞추세요.', why: '보정은 덜 한 듯할 때가 가장 자연스럽습니다.', show: { panel: 'layers', sel: 'input[aria-label="불투명도"]' }, done: (s) => s.layers.some((l) => (l.blend === 'overlay' || l.blend === 'soft light') && l.opacity < 1) },
    ],
  },
  {
    id: 'blemish', group: '보정', title: '잡티 제거', min: 6, file: 'portraitClose',
    intro: '스팟 복구 브러시와 제거 도구로 얼굴의 잡티를 지웁니다. 빈 레이어에 작업해서 원본을 지키는 방법도 익힙니다.',
    steps: [
      newLayerStep('잡티용 새 레이어', '빈 레이어에 고치면 원본이 그대로 남아 잘못 고친 곳만 지울 수 있습니다.'),
      toolStep('heal', '스팟 복구 브러시', '도구 상자에서 반창고 모양의 스팟 복구 브러시 도구(J)를 고르세요.', '주변 피부를 알아서 가져와 메웁니다.', 'J'),
      { t: '모든 레이어 샘플링', d: '옵션 막대에서 \'모든 레이어 샘플링\'을 켜세요.', why: '빈 레이어에 칠해도 아래 사진을 보고 고칩니다.', show: { text: '모든 레이어', within: '.ph-opts' }, done: (s) => !!s.opt('heal', 'sampleAll') },
      { t: '잡티 누르기', d: '[ ] 키로 브러시를 잡티보다 조금 크게 하고 잡티를 하나씩 누르세요.', why: '한 번에 크게 칠하는 것보다 작게 여러 번 누르는 게 자연스럽습니다.', show: { tool: 'heal' }, done: (s) => s.times(/스팟 복구/) >= 3 },
      { t: '제거 도구', d: '같은 칸의 제거 도구로 여러 잡티가 모인 곳을 한 번에 칠해 보세요.', why: '넓은 부분이나 사진 속 물건을 지울 때 씁니다.', show: { tool: 'remove' }, done: (s) => s.did(/제거 도구/) },
      { t: '전후 비교', d: '잡티용 레이어의 눈 아이콘을 꺼서 원본과 비교해 보세요.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.layers.some((l) => !l.visible) },
    ],
  },
  {
    id: 'sky', group: '보정', title: '하늘 바꾸기', min: 5, file: 'skyDull',
    intro: '흐린 하늘을 맑은 하늘이나 노을로 바꾸고 전체 색을 맞춥니다.',
    steps: [
      { t: '하늘 선택해 보기', d: '선택 ▸ 하늘을 누르세요. 하늘만 알아서 선택됩니다.', why: '하늘만 따로 보정하고 싶을 때도 이 명령을 씁니다.', path: ['선택', '하늘'], done: (s) => s.sel },
      { t: '선택 해제', d: 'Ctrl+D로 선택을 없애세요. 하늘 대체는 선택 없이 알아서 하늘을 찾습니다.', path: ['선택', '선택 해제'], key: 'Ctrl+D', done: (s) => !s.sel },
      { t: '하늘 대체', d: '편집 ▸ 하늘 대체…에서 하늘을 고르고, 가장자리 이동·페이드·조명 조정을 바꿔 본 뒤 확인하세요.', why: '그림 위를 끌면 하늘 위치를 옮길 수 있습니다.', path: ['편집', '하늘 대체…'], done: (s) => s.did(/하늘 대체/) },
      { t: '만들어진 레이어 보기', d: '레이어 패널을 보세요. 하늘과 조명 레이어가 따로 생겨서 나중에 고칠 수 있습니다. 확인했으면 \'다음\'을 누르세요.', show: { panel: 'layers' } },
      adjStep('curves', '곡선', '맨 위 레이어를 고른 채 레이어 ▸ 새 조정 레이어 ▸ 곡선…으로 전체 밝기를 다듬으세요.', '하늘과 땅의 밝기를 함께 맞추면 합성한 티가 덜 납니다.'),
    ],
  },
  {
    id: 'basic', group: '보정', title: '사진 보정 기본', min: 7, file: 'dark',
    intro: '어둡게 찍힌 풍경을 Camera Raw로 밝히고, 자르고, 색과 선명도를 다듬는 기본 순서입니다.',
    steps: [
      { t: '고급 개체로 변환', d: '레이어 ▸ 고급 개체 ▸ 고급 개체로 변환을 누르세요.', why: '고급 필터가 되어 Camera Raw 설정을 나중에 다시 열어 고칠 수 있습니다.', path: ['레이어', '고급 개체', '고급 개체로 변환'], done: (s) => s.kind('smart') },
      { t: 'Camera Raw 필터', d: '필터 ▸ Camera Raw 필터…(Ctrl+Shift+A)에서 노출을 올리고, 밝은 영역은 내리고, 어두운 영역은 올린 뒤 확인하세요.', why: '밝은 하늘은 지키면서 어두운 땅을 살립니다.', path: ['필터', 'Camera Raw 필터…'], key: 'Ctrl+Shift+A', done: (s) => s.did(/Camera Raw/) },
      { t: '자르기', d: '자르기 도구(C)를 고르고 모서리를 끌어 구도를 정한 뒤 Enter를 누르세요.', why: '옵션 막대에서 비율(1:1, 16:9)과 똑바르게 하기를 쓸 수 있습니다.', key: 'C', show: { tool: 'crop' }, done: (s) => s.did(/자르기/) },
      adjStep('vibrance', '활기', null, '활기는 덜 진한 색만 올려서 하늘과 피부가 지나치게 진해지지 않습니다.'),
      { t: '선명하게', d: '사진 레이어를 고르고 필터 ▸ 선명 효과 ▸ 언샵 마스크…(양 80%, 반경 1.5)를 적용하세요.', why: '선명하게 하기는 언제나 마지막에 합니다.', path: ['필터', '선명 효과', '언샵 마스크…'], done: (s) => s.did(/언샵 마스크/) },
    ],
  },

  // ------------------------------------------------ compositing
  {
    id: 'cutout', group: '합성', title: '누끼 따기', min: 6, file: 'portraitOutdoor',
    intro: '인물만 남기고 배경을 지운 뒤 새 배경색을 깔아 봅니다. 지우지 않고 마스크로 가려서 언제든 고칠 수 있습니다.',
    steps: [
      { t: '피사체 선택', d: '선택 ▸ 피사체를 누르세요. 개체 선택 도구(W)의 옵션 막대에 있는 \'피사체 선택\' 단추와 같습니다.', why: '사람과 물건을 알아서 찾아 선택합니다.', path: ['선택', '피사체'], done: (s) => s.sel },
      { t: '선택 및 마스크', d: '선택 ▸ 선택 및 마스크…(Ctrl+Alt+R)에서 가장자리 다듬기 브러시로 머리카락 둘레를 칠하고, 출력 위치를 \'레이어 마스크\'로 두고 확인하세요.', why: '머리카락처럼 가는 가장자리를 다듬습니다. 바로 마스크 단추를 눌러도 됩니다.', path: ['선택', '선택 및 마스크…'], key: 'Ctrl+Alt+R', done: (s) => s.layers.some((l) => l.kind !== 'adjust' && l.kind !== 'fill' && l.mask) },
      { t: '새 배경 깔기', d: '레이어 ▸ 새 칠 레이어 ▸ 단색…으로 원하는 배경색 레이어를 만드세요.', why: '칠 레이어는 나중에 두 번 눌러 색을 바꿀 수 있습니다.', path: ['레이어', '새 칠 레이어', '단색…'], done: (s) => s.kind('fill') },
      { t: '배경을 인물 뒤로', d: '칠 레이어를 고른 채 레이어 ▸ 정돈 ▸ 뒤로(Ctrl+[)를 눌러 인물 아래로 내리세요.', path: ['레이어', '정돈', '뒤로'], key: 'Ctrl+[', done: (s) => { const f = s.layers.findIndex((l) => l.kind === 'fill'); const m = s.layers.findIndex((l) => l.kind !== 'fill' && l.kind !== 'adjust' && l.mask); return f >= 0 && m >= 0 && f < m; } },
      { t: '마스크 다듬기', d: '인물 레이어의 마스크 썸네일을 누르고 브러시(B)로 칠해 남은 배경을 가리세요(검정) 또는 지워진 곳을 살리세요(흰색).', key: 'B', show: { tool: 'brush' }, done: (s) => s.did(/브러시/) },
    ],
  },
  {
    id: 'double', group: '합성', title: '이중 노출', min: 8, file: 'double',
    intro: '인물 실루엣 안에 숲 사진을 겹치는 이중 노출 합성입니다.',
    steps: [
      { t: '숲 레이어 숨기기', d: '레이어 패널에서 \'숲\' 레이어의 눈 아이콘을 꺼서 인물이 보이게 하세요.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.layers.some((l) => l.name === '숲' && !l.visible) },
      { t: '인물 선택', d: '\'인물\' 레이어를 고르고 선택 ▸ 피사체를 누르세요.', why: '이 선택 영역이 숲을 보여 줄 모양이 됩니다.', path: ['선택', '피사체'], done: (s) => s.sel },
      { t: '숲에 마스크', d: '\'숲\'을 다시 보이게 하고 고른 뒤, 레이어 패널의 마스크 단추를 누르세요. 숲이 인물 모양 안에만 보입니다.', path: ['레이어', '레이어 마스크', '선택 영역 나타내기'], show: { panel: 'layers', sel: '[aria-label^="레이어 마스크 추가"]' }, done: (s) => s.layers.some((l) => l.name === '숲' && l.visible && l.mask) },
      blendStep('screen', '스크린', '스크린은 어두운 곳을 투명하게 해서 숲의 밝은 하늘 부분에 얼굴이 비쳐 보입니다.'),
      adjStep('gradientMap', '그레이디언트 맵', '맨 위에 레이어 ▸ 새 조정 레이어 ▸ 그레이디언트 맵…을 넣고 어두운 남색에서 밝은 크림색으로 바꿔 보세요.', '전체 색을 한 가지 분위기로 묶어 합성을 하나로 보이게 합니다.'),
      { t: '얼굴 드러내기', d: '\'숲\'의 마스크를 고르고 부드러운 검정 브러시(불투명도 30%)로 눈, 코, 입 둘레를 살짝 칠하세요.', key: 'B', show: { tool: 'brush' }, done: (s) => s.did(/브러시/) },
    ],
  },
  {
    id: 'dispersion', group: '합성', title: '분산 효과', min: 10, file: 'portraitWhite',
    intro: '인물이 조각으로 흩어지는 분산(디스퍼전) 효과입니다. 늘린 복사본과 흩뿌리기 브러시로 만듭니다.',
    steps: [
      { t: '인물만 복사', d: '선택 ▸ 피사체를 누르고 Ctrl+J로 인물만 새 레이어에 복사하세요.', path: ['선택', '피사체'], done: (s) => s.count > s.base.count },
      { t: '배경에서 인물 지우기', d: '\'배경\'을 고르고 Ctrl+A로 모두 선택한 뒤 편집 ▸ 칠…에서 내용: 흰색으로 칠하세요. 사진 배경이면 내용 인식으로 칠합니다.', why: '조각이 날아간 자리에 원래 인물이 비쳐 보이지 않게 합니다.', path: ['편집', '칠…'], key: 'Shift+F5', done: (s) => s.did(/^칠$/) },
      { t: '늘린 복사본', d: '인물 레이어를 Ctrl+J로 한 번 더 복사하고, 필터 ▸ 픽셀 유동화…의 뒤틀기 도구로 몸을 오른쪽으로 길게 끌어 늘이세요.', why: '이 늘어난 모양이 흩어지는 조각의 재료가 됩니다.', path: ['필터', '픽셀 유동화…'], key: 'Ctrl+Shift+X', done: (s) => s.did(/유동화/) },
      { t: '마스크 두 개', d: '늘린 레이어에는 Alt를 누른 채 마스크 단추(모두 숨기기)를, 인물 레이어에는 마스크 단추(모두 나타내기)를 누르세요.', path: ['레이어', '레이어 마스크', '모두 숨기기'], show: { panel: 'layers', sel: '[aria-label^="레이어 마스크 추가"]' }, done: (s) => s.layers.filter((l) => l.mask).length >= 2 },
      { t: '흩뿌리기 브러시', d: '창 ▸ 브러시에서 \'점 무리\'나 \'별 흩뿌리기\'처럼 흩어지는 브러시를 고르세요. 브러시 설정(F5)의 분산을 올려도 됩니다.', path: ['창', '브러시'], show: { panel: 'brushes' }, done: (s) => s.panel('brushes') || s.panel('brushSettings') },
      { t: '조각 칠하기', d: '인물 마스크에는 검정으로 오른쪽 가장자리를 깎고, 늘린 레이어 마스크에는 흰색으로 칠해 조각을 드러내세요.', why: '한쪽은 사라지고 한쪽은 나타나서 조각이 날아가는 것처럼 보입니다.', key: 'B', show: { tool: 'brush' }, done: (s) => s.times(/브러시/) >= 2 },
    ],
  },
  {
    id: 'shadow', group: '합성', title: '그림자 만들기', min: 6, file: 'shadow',
    intro: '제품 사진에 바닥에 드리운 그림자를 직접 만듭니다.',
    steps: [
      { t: '제품 모양 선택', d: '\'제품\' 레이어 썸네일을 Ctrl+클릭하거나 선택 ▸ 레이어 모양대로 선택을 누르세요.', path: ['선택', '레이어 모양대로 선택'], done: (s) => s.sel },
      newLayerStep('그림자 레이어', '그림자를 따로 두면 방향과 진하기를 마음대로 바꿀 수 있습니다.'),
      { t: '검정으로 칠하기', d: '편집 ▸ 칠…(Shift+F5)에서 내용: 검정으로 칠하고 Ctrl+D로 선택을 없애세요.', path: ['편집', '칠…'], key: 'Shift+F5', done: (s) => s.did(/^칠$/) && !s.sel },
      { t: '바닥에 눕히기', d: 'Ctrl+T를 누르고 상자 안을 오른쪽 클릭 ▸ 왜곡을 고른 뒤, 위쪽 모서리를 끌어 그림자를 바닥에 비스듬히 눕히고 Enter를 누르세요.', why: '빛이 오는 반대쪽으로 길게 눕혀야 자연스럽습니다.', path: ['편집', '자유 변형'], key: 'Ctrl+T', done: (s) => !s.transforming && s.did(/변형|왜곡/) },
      { t: '그림자를 제품 뒤로', d: '레이어 ▸ 정돈 ▸ 뒤로(Ctrl+[)로 그림자를 제품 아래로 내리세요.', path: ['레이어', '정돈', '뒤로'], key: 'Ctrl+[', done: (s) => s.did(/레이어 순서/) },
      gaussStep('부드럽게', '필터 ▸ 흐림 효과 ▸ 가우시안 흐림 효과…로 그림자 가장자리를 흐리게 하세요(반경 10쯤).', '실제 그림자는 물건에서 멀어질수록 흐려집니다.'),
      { t: '진하기 맞추기', d: '그림자 레이어 불투명도를 40~60%로 낮추세요.', show: { panel: 'layers', sel: 'input[aria-label="불투명도"]' }, done: (s) => s.layers.some((l) => l.kind === 'raster' && l.opacity < 1) },
    ],
  },

  // ------------------------------------------------ design
  {
    id: 'neon', group: '디자인', title: '네온 글자', min: 7, file: 'bricks',
    intro: '어두운 벽돌 벽에 빛나는 네온 글자를 만듭니다. 레이어 스타일 여러 개를 겹쳐 씁니다.',
    steps: [
      adjStep('brightness', '명도/대비', '레이어 ▸ 새 조정 레이어 ▸ 명도/대비…로 벽을 더 어둡게 하세요(명도 -40쯤).', '배경이 어두울수록 네온이 밝게 보입니다.'),
      { t: '글자 쓰기', d: '수평 문자 도구(T)로 \'NEON\'이나 \'OPEN\'을 쓰고, 문자 패널에서 굵고 둥근 글꼴, 큰 크기, 흰색으로 정하세요.', key: 'T', show: { tool: 'text' }, done: (s) => s.kind('text') },
      { t: '외부 광선', d: '레이어 ▸ 레이어 스타일 ▸ 외부 광선…에서 색을 분홍(또는 하늘색), 크기 30쯤으로 하세요.', why: '글자 둘레로 빛이 번집니다.', path: ['레이어', '레이어 스타일', '외부 광선…'], done: (s) => s.fx('outerGlow') },
      { t: '내부 광선과 획', d: '같은 대화 상자 왼쪽 목록에서 내부 광선과 획도 켜고 같은 색 계열로 맞추세요.', why: '빛 효과를 여러 겹 쌓을수록 진짜 네온관처럼 보입니다.', path: ['레이어', '레이어 스타일', '내부 광선…'], done: (s) => s.fx('innerGlow') || s.fx('stroke') },
      gaussStep('빛 번짐 더하기', '문자 레이어를 Ctrl+J로 복제하고 필터 ▸ 흐림 효과 ▸ 가우시안 흐림 효과…(반경 20쯤)를 적용하세요. 래스터화할지 물으면 고급 개체로 바꾸세요.', '흐린 복사본이 벽에 비친 빛이 됩니다.'),
    ],
  },
  {
    id: 'glitch', group: '디자인', title: '글리치', min: 6, file: 'portraitStudio',
    intro: '빨강·초록·파랑이 어긋난 RGB 글리치 효과입니다. 혼합 옵션의 채널을 씁니다.',
    steps: [
      dupStep('사진 복제', 'Ctrl+J로 배경을 복제하세요.'),
      { t: '빨강 채널만 남기기', d: '레이어 ▸ 레이어 스타일 ▸ 혼합 옵션…의 고급 혼합에서 채널 G와 B를 끄고 확인하세요.', why: '이 레이어는 빨강만 아래에 더해집니다.', path: ['레이어', '레이어 스타일', '혼합 옵션…'], done: (s) => s.channels },
      { t: '옆으로 밀기', d: '이동 도구(V)를 고르고 → 키를 Shift와 함께 한두 번 눌러 오른쪽으로 10~20픽셀 옮기세요.', why: '빨강과 청록이 어긋나 보입니다.', key: 'V', show: { tool: 'move' }, done: (s) => s.did(/이동/) },
      { t: '잘린 띠 만들기', d: '사각형 선택 윤곽 도구(M)로 가로로 긴 띠를 고르고 Ctrl+J로 복사한 뒤, 이동 도구로 좌우로 조금 옮기세요. 두세 번 하면 좋습니다.', key: 'M', show: { tool: 'rect' }, done: (s) => s.count >= s.base.count + 1 },
      { t: '노이즈 더하기', d: '필터 ▸ 노이즈 ▸ 노이즈 추가…(양 5~10%)로 화면 잡음을 넣으세요.', path: ['필터', '노이즈', '노이즈 추가…'], done: (s) => s.did(/노이즈 추가/) },
    ],
  },
  {
    id: 'sketch', group: '디자인', title: '연필 스케치', min: 5, file: 'portraitOutdoor',
    intro: '사진을 연필로 그린 듯한 스케치로 바꾸는 고전 기법입니다.',
    steps: [
      { t: '흑백으로', d: '이미지 ▸ 조정 ▸ 채도 감소(Ctrl+Shift+U)를 누르세요.', path: ['이미지', '조정', '채도 감소'], key: 'Ctrl+Shift+U', done: (s) => s.did(/채도 감소/) },
      dupStep('복제', 'Ctrl+J로 흑백 사진을 복제하세요.'),
      { t: '반전', d: '이미지 ▸ 조정 ▸ 반전(Ctrl+I)으로 복사본을 네거티브로 만드세요.', path: ['이미지', '조정', '반전'], key: 'Ctrl+I', done: (s) => s.did(/^반전$/) },
      blendStep('color dodge', '색상 닷지', '반전한 사진을 색상 닷지로 섞으면 화면이 거의 하얗게 됩니다. 다음 단계에서 선이 나타납니다.'),
      gaussStep('선 나타내기', '필터 ▸ 흐림 효과 ▸ 가우시안 흐림 효과…로 반경을 올려 보세요. 반경이 클수록 선이 굵고 진해집니다.', '흐린 만큼 가장자리만 어둡게 남아 연필 선이 됩니다.'),
      adjStep('levels', '레벨', '레이어 ▸ 새 조정 레이어 ▸ 레벨…에서 검정 삼각형을 오른쪽으로 끌어 선을 진하게 하세요.', '흐린 선을 또렷하게 만듭니다.'),
    ],
  },
  {
    id: 'popart', group: '디자인', title: '팝아트', min: 6, file: 'portraitWhite',
    intro: '굵은 검정 선과 하프톤 점, 강한 색으로 만화 같은 팝아트를 만듭니다.',
    steps: [
      dupStep('사진 복제', 'Ctrl+J로 배경을 복제하세요.'),
      { t: '한계값으로 선 만들기', d: '이미지 ▸ 조정 ▸ 한계값…에서 얼굴 윤곽이 잘 보이게 값을 정하세요.', why: '사진이 검정과 흰색 두 색만 남습니다.', path: ['이미지', '조정', '한계값…'], done: (s) => s.did(/한계값/) },
      blendStep('multiply', '곱하기', '곱하기는 흰색을 투명하게 해서 검정 선만 아래 사진 위에 남깁니다.'),
      { t: '하프톤 점', d: '\'배경\'을 고르고 필터 ▸ 픽셀화 ▸ 색상 하프톤…(최대 반경 8쯤)을 적용하세요.', why: '옛날 만화 인쇄의 망점 느낌을 냅니다.', path: ['필터', '픽셀화', '색상 하프톤…'], done: (s) => s.did(/색상 하프톤/) },
      adjStep('hueSat', '색조/채도', '맨 위 레이어를 고르고 레이어 ▸ 새 조정 레이어 ▸ 색조/채도…로 채도를 크게 올리세요.', '팝아트는 원색처럼 강한 색이 어울립니다.'),
    ],
  },
  {
    id: 'sns', group: '디자인', title: 'SNS 카드', min: 7, file: 'card',
    intro: '1080×1080 인스타그램 카드를 만듭니다. 모양 안에 사진을 넣는 클리핑 마스크와 정렬을 익힙니다.',
    steps: [
      { t: '둥근 사각형 그리기', d: '\'배경\'을 고른 채 사각형 도구(U)를 고르고, 옵션 막대에서 모서리 반경을 40쯤 넣은 뒤 가운데에 상자를 그리세요.', why: '모양 레이어는 벡터라서 크기를 바꿔도 깨지지 않습니다.', key: 'U', show: { tool: 'shape' }, done: (s) => s.kind('shape') },
      { t: '사진을 모양 위로', d: '\'사진\' 레이어가 모양 레이어 바로 위에 오게 레이어 패널에서 끌어 놓으세요.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => { const i = s.layers.findIndex((l) => l.name === '사진'); return i > 0 && s.layers[i - 1].kind === 'shape'; } },
      { t: '클리핑 마스크', d: '\'사진\'을 고른 채 레이어 ▸ 클리핑 마스크 만들기(Ctrl+Alt+G)를 누르세요. 사진이 모양 안에만 보입니다.', why: '레이어 패널에서 두 레이어 사이 경계를 Alt+클릭해도 됩니다.', path: ['레이어', '클리핑 마스크 만들기'], key: 'Ctrl+Alt+G', done: (s) => s.layers.some((l) => l.clip) },
      { t: '제목 넣기', d: '수평 문자 도구(T)로 카드 위나 아래에 제목을 쓰세요.', key: 'T', show: { tool: 'text' }, done: (s) => s.kind('text') },
      { t: '가운데 정렬', d: '레이어 패널에서 Shift를 누른 채 모양과 문자 레이어를 함께 고르고 레이어 ▸ 정렬 ▸ 가로 가운데를 누르세요.', why: '이동 도구의 옵션 막대에도 같은 정렬 단추가 있습니다.', path: ['레이어', '정렬', '가로 가운데'], done: (s) => s.did(/정렬/) },
      { t: '내보내기', d: '파일 ▸ 내보내기 ▸ 내보내기 형식…에서 PNG나 JPG로 저장하세요.', path: ['파일', '내보내기', '내보내기 형식…'], key: 'Ctrl+Alt+Shift+W', done: (s) => s.modal(/내보내기/) },
    ],
  },
  {
    id: 'pattern', group: '디자인', title: '패턴', min: 6, file: 'motif',
    intro: '이음매 없이 반복되는 패턴을 만들고, 패턴으로 넓은 면을 채웁니다.',
    steps: [
      { t: '오프셋으로 이음매 보기', d: '필터 ▸ 기타 ▸ 오프셋…에서 가로 200, 세로 200, \'둘러싸기\'로 두고 확인하세요.', why: '가장자리가 가운데로 모여서 반복될 때 이음매가 어떻게 보일지 미리 볼 수 있습니다.', path: ['필터', '기타', '오프셋…'], done: (s) => s.did(/오프셋/) },
      { t: '빈 곳 채우기', d: '네 모서리의 빈 곳에 브러시(B)로 열매나 잎을 그려 채우세요.', why: '가운데를 건드리지 않으면 이음매가 생기지 않습니다.', key: 'B', show: { tool: 'brush' }, done: (s) => s.did(/브러시|복제 도장/) },
      { t: '패턴 정의', d: '편집 ▸ 패턴 정의…를 누르고 이름을 정하세요.', path: ['편집', '패턴 정의…'], done: (s) => s.patterns > s.base.patterns },
      { t: '새 문서 만들기', newDoc: true, d: '파일 ▸ 새로 만들기…(Ctrl+N)로 1920×1080 문서를 만드세요.', path: ['파일', '새로 만들기…'], key: 'Ctrl+N', done: (s) => s.docs > s.base.docs },
      { t: '패턴으로 채우기', d: '레이어 ▸ 새 칠 레이어 ▸ 패턴…에서 방금 만든 패턴을 고르고 비율을 조절하세요.', path: ['레이어', '새 칠 레이어', '패턴…'], done: (s) => s.layers.some((l) => l.kind === 'fill' && l.fill?.type === 'pattern') },
    ],
  },
  {
    id: 'gif', group: '디자인', title: '움직이는 GIF', min: 6, file: 'gif',
    intro: '공이 통통 튀는 짧은 GIF를 타임라인의 프레임으로 만듭니다.',
    steps: [
      { t: '타임라인 열기', d: '창 ▸ 타임라인을 누르세요.', path: ['창', '타임라인'], show: { panel: 'timeline' }, done: (s) => s.panel('timeline') },
      { t: '프레임 애니메이션 만들기', d: '타임라인 패널의 \'프레임 애니메이션 만들기\' 단추를 누르세요.', why: '\'레이어로 프레임 만들기\'를 누르면 레이어마다 프레임이 한 번에 생깁니다.', show: { panel: 'timeline', text: '프레임 애니메이션 만들기' }, done: (s) => s.frames >= 1 },
      { t: '첫 프레임 정하기', d: '레이어 패널에서 \'공 2\'와 \'공 3\'의 눈을 끄세요. 첫 프레임에는 공 1만 보입니다.', show: { panel: 'layers', sel: '.ph-layers' }, done: (s) => s.layers.filter((l) => /^공 /.test(l.name) && !l.visible).length >= 2 },
      { t: '프레임 더하기', d: '타임라인의 + 단추(선택한 프레임 복제)로 새 프레임을 만들고, 그 프레임에서는 공 2만 보이게 하세요. 공 3도 같은 방법으로 하세요.', why: '프레임마다 레이어의 보이기, 위치, 불투명도를 따로 기억합니다.', show: { panel: 'timeline', sel: '[aria-label="선택한 프레임 복제"]' }, done: (s) => s.frames >= 3 },
      { t: '재생해 보기', d: '타임라인의 재생 단추로 움직임을 확인하고, 프레임 아래 시간(예: 0.2초)을 눌러 속도를 정하세요. 확인했으면 \'다음\'을 누르세요.', show: { panel: 'timeline' } },
      { t: 'GIF로 내보내기', d: '파일 ▸ 내보내기 ▸ 애니메이션 GIF로 내보내기…를 누르세요.', path: ['파일', '내보내기', '애니메이션 GIF로 내보내기…'], done: (s) => s.modal(/GIF/) },
    ],
  },
];

/** The practice document of a lesson: { name, width, height, layers, active }. */
export function practiceFile(lesson) {
  const f = FILES[lesson.file]();
  return { name: `연습 - ${lesson.title}`, ...f };
}
