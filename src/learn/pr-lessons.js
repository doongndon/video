// Premiere Learn panel lessons (pr-learn.js runs them). Lessons are data: the practice media they
// need (practice-media.js keys), a setup that builds the practice sequence, and steps.
// A step: t (what), d (how), why, path (menu path, shown and pointed at), key (shortcut),
// show (what '보여 주기' points at when it is not the menu path: { tool } · { panel, sel, text } ·
// { clip: (s) => clip, edge } · { time }), done(s) (true when the project shows the step is done;
// none: '다음' only). `s` (see pr-learn.js ctx): seq, clips, base, tool, usedTool(id), sel, playhead, playing,
// source, project, media(key), of(key, 'video' | 'audio'), onTrack('V1'), vIndex(clip), did(re),
// fx(clip, type), panel(id), modal(re), toast(re), dur(), seqCount().

import { PRACTICE } from './practice-media.js';

const UMS = PRACTICE.interview.notes.ums;
const FX_FIXED = new Set(['motion', 'opacity', 'timeRemap', 'volume', 'channelVolume', 'panner', 'text', 'fill', 'shape']);

// ---------------------------------------------------------------- shared checks

const end = (c) => c.start + c.duration;
/** Clips on a track have no holes between the first and the last (a frame of slack). */
const gapless = (list) => list.every((c, i) => !i || c.start - end(list[i - 1]) < 0.05);
/** A clip that shows media time `mt` (seconds of its file). */
const shows = (c, mt) => c.inPoint <= mt && mt < c.inPoint + c.duration * (c.speed || 1);
/** The "음…" at `um` is gone, the words around it stay and nothing is left open. */
const cleanCut = (s, um) => {
  const v = s.of('interview', 'video');
  return !v.some((c) => shows(c, um + 0.3)) && v.some((c) => shows(c, um - 0.6)) && v.some((c) => shows(c, um + 1.2)) && gapless(s.onTrack('V1'));
};
const param = (c, type, key) => c?.effects?.find((e) => e.type === type)?.params?.[key];
const val = (c, type, key) => param(c, type, key)?.value;
const kfs = (c, type, key) => param(c, type, key)?.kf || [];
const transitions = (s, audio) => s.clips.filter((c) => (c.kind === 'audio') === audio).reduce((n, c) => n + (c.transIn ? 1 : 0) + (c.transOut ? 1 : 0), 0);
const linked = (s, c) => s.clips.find((x) => x !== c && x.linkId && x.linkId === c.linkId);
const textClips = (s) => s.clips.filter((c) => c.kind === 'text');
const userFx = (c) => (c?.effects || []).filter((e) => !FX_FIXED.has(e.type) && !e.essential);
const masksOf = (fx) => fx?.masks || [];

// ---------------------------------------------------------------- shared steps

const toolStep = (tool, t, d, key, why) => ({ t, d, why, key, show: { tool }, done: (s) => s.usedTool(tool) });
const panelStep = (id, name, path, key, d, why) => ({
  t: `${name} 패널 열기`, d: d || `창 ▸ ${name}${key ? ` (${key})` : ''}를 누르세요.`, why, path, key, show: { panel: id }, done: (s) => s.panel(id),
});
const playStep = (d = '스페이스바로 재생해 결과를 확인하세요. 한 번 더 누르면 멈춥니다.') => ({
  t: '재생해서 확인하기', d, key: 'Space', show: { sel: '#pg-top-right .monitor-view' }, done: (s) => s.playing,
});
const selectStep = (key, t, d, kind = 'video') => ({
  t, d: d || '타임라인에서 클립을 한 번 클릭해 선택하세요.', show: { clip: (s) => s.of(key, kind)[0] },
  done: (s) => s.sel.some((c) => c.mediaId === s.media(key) && (kind === 'audio' ? c.kind === 'audio' : c.kind !== 'audio')),
});
const effectStep = (type, name, where, key, kind = 'video') => ({
  t: `'${name}' 효과 넣기`,
  d: `효과 패널 위쪽 검색 칸에 '${name}'을(를) 입력하고, 나온 효과를 ${where} 클립 위로 끌어다 놓으세요. 클립을 선택한 채 효과를 두 번 클릭해도 됩니다.`,
  show: { panel: 'effects', sel: '.panel-body[data-panel="effects"] input[type="search"], .panel-body[data-panel="effects"] input' },
  done: (s) => s.of(key, kind).some((c) => s.fx(c, type)),
});

// ---------------------------------------------------------------- lessons

export const LESSON_GROUPS = ['기초', '편집 기술', '효과', '색과 소리'];

export const LESSONS = [
  // ------------------------------------------------ basics
  {
    id: 'import', group: '기초', title: '가져오기와 시퀀스 만들기', min: 5, media: ['interview', 'brollCity', 'brollLandscape'],
    intro: '촬영한 파일을 가져와 소스 모니터에서 보고, 클립으로 시퀀스를 만든 뒤 필요한 부분만 골라 타임라인에 넣습니다.',
    steps: [
      {
        t: '파일 가져오기', d: '강의에서는 먼저 촬영 파일을 가져옵니다. 연습 파일은 이미 프로젝트 패널의 \'연습 파일\' 저장소에 있으니, 내 파일이 있으면 지금 가져와 보세요 (파일을 창으로 끌어다 놓아도 됩니다).',
        path: ['파일', '가져오기…'], key: 'Ctrl+I', done: (s) => s.project.mediaOrder.length > s.base.media,
      },
      panelStep('project', '프로젝트', ['창', '프로젝트'], 'Shift+1', '왼쪽 아래 프로젝트 패널에서 \'연습 파일\' 저장소를 펼치세요.', '프로젝트 패널은 가져온 파일을 모아 두는 곳입니다. 저장소(폴더)로 나눠 두면 찾기 쉽습니다.'),
      {
        t: '소스 모니터에서 보기', d: '프로젝트 패널에서 \'인터뷰.webm\'을 두 번 클릭하세요. 왼쪽 위 소스 모니터에 열립니다.',
        why: '타임라인에 넣기 전에 소스 모니터에서 내용을 확인하고 쓸 부분을 고릅니다.',
        show: { panel: 'project', text: '인터뷰' }, done: (s) => s.source === s.media('interview'),
      },
      {
        t: '클립에서 새 시퀀스 만들기', d: '\'인터뷰.webm\'을 오른쪽 클릭하고 \'클립에서 새 시퀀스\'를 고르세요. 클립과 같은 크기·프레임 속도의 시퀀스가 만들어집니다.',
        why: '시퀀스 설정을 촬영 파일에 맞추면 화질 손실이나 검은 테두리가 생기지 않습니다.',
        path: ['파일', '새로 만들기', '클립에서 새 시퀀스'], show: { panel: 'project', text: '인터뷰' },
        done: (s) => s.seqCount() > s.base.seqs && s.of('interview').length > 0,
      },
      {
        t: '시작과 종료 표시하기', d: '\'B롤 - 도시.webm\'을 두 번 클릭해 소스 모니터에 열고, 1초쯤에서 I(시작 표시), 5초쯤에서 O(종료 표시)를 누르세요.',
        why: '필요한 부분만 표시해 두면 그 구간만 타임라인에 들어갑니다.', key: 'I · O', show: { panel: 'source' },
        done: (s) => {
          const m = s.project.media[s.media('brollCity')];
          return m?.inPoint != null && m?.outPoint != null;
        },
      },
      {
        t: '타임라인에 넣기', d: '타임라인의 재생 헤드를 인터뷰 끝으로 옮기고 소스 모니터 아래의 덮어쓰기 단추(또는 . 키)를 누르세요. 소스 모니터 화면을 타임라인으로 끌어다 놓아도 됩니다.',
        why: '삽입(,)은 뒤 클립을 밀어내고, 덮어쓰기(.)는 그 자리를 덮습니다.', key: '. (덮어쓰기) · , (삽입)', path: ['클립', '덮어쓰기'],
        done: (s) => s.of('brollCity').length > 0,
      },
      playStep(),
    ],
  },
  {
    id: 'trim', group: '기초', title: '자르고 다듬기', min: 7, media: ['interview'],
    intro: '인터뷰의 "음…" 하는 곳을 자르기 도구와 잔물결 삭제로 들어내고, 잔물결 편집 도구로 끝을 다듬습니다.',
    async setup(L) {
      L.sequence('연습 - 자르고 다듬기');
      L.place('interview');
      UMS.forEach((t, i) => L.marker(t - 0.1, `음… ${i + 1}`, 'yellow'));
    },
    steps: [
      playStep('스페이스바로 재생해 들어 보세요. 노란 마커 두 곳에서 "음…" 소리가 납니다.'),
      toolStep('razor', '자르기 도구 고르기', '왼쪽 도구 막대에서 면도날 모양 자르기 도구를 누르거나 C를 누르세요.', 'C', '클릭한 곳에서 클립이 둘로 나뉩니다.'),
      {
        t: '두 번째 "음…" 앞뒤 자르기', d: `두 번째 노란 마커(${UMS[1].toFixed(1)}초 무렵) 바로 앞과, "음…" 소리가 끝나는 곳(약 0.8초 뒤)을 V1 클립 위에서 한 번씩 클릭하세요.`,
        why: '뒤쪽부터 지우면 앞쪽 마커 위치가 그대로라서 다음 작업이 쉽습니다.', show: { time: UMS[1] - 0.1, note: '이 마커 앞뒤를 자르세요' },
        done: (s) => s.onTrack('V1').length >= 3,
      },
      toolStep('select', '선택 도구로 돌아가기', '도구 막대 맨 위 화살표를 누르거나 V를 누르세요.', 'V'),
      {
        t: '잔물결 삭제로 들어내기', d: '잘라 낸 "음…" 조각을 클릭해 선택하고 Shift+Delete를 누르세요. 조각이 빠지고 뒤 클립이 당겨져 빈틈이 생기지 않습니다.',
        why: 'Delete만 누르면 빈 공간이 남습니다. 잔물결 삭제는 빈 공간까지 함께 없앱니다.', path: ['편집', '잔물결 삭제'], key: 'Shift+Delete',
        done: (s) => cleanCut(s, UMS[1]),
      },
      {
        t: '첫 번째 "음…"는 단축키로', d: `Home을 누르고 Shift+M(다음 마커로 이동)으로 재생 헤드를 첫 마커(${UMS[0].toFixed(1)}초)에 옮겨 Ctrl+K(편집 추가)를 누른 뒤, "음…"가 끝나는 곳(약 0.8초 뒤)으로 옮겨 Q를 누르세요. Q는 앞 편집점부터 재생 헤드까지를 잔물결로 들어냅니다.`,
        why: '강의에서 자주 쓰는 빠른 컷 편집 방법입니다. W는 재생 헤드부터 다음 편집점까지를 들어냅니다.',
        path: ['시퀀스', '이전 편집 지점을 재생 헤드로 잔물결 트리밍'], key: 'Ctrl+K · Q · W', show: { time: UMS[0] - 0.1, note: '여기에서 Ctrl+K' },
        done: (s) => cleanCut(s, UMS[0]) && cleanCut(s, UMS[1]),
      },
      toolStep('ripple', '잔물결 편집 도구 고르기', '도구 막대의 잔물결 편집 도구를 누르거나 B를 누르세요 (같은 칸을 길게 누르면 롤링·속도 조정 도구도 있습니다).', 'B'),
      {
        t: '끝부분 다듬기', d: '마지막 클립의 오른쪽 끝을 왼쪽으로 1초쯤 끌어 짧게 만드세요. 잔물결 편집 도구로 끌면 뒤쪽이 따라와 빈틈이 생기지 않습니다.',
        show: { clip: (s) => s.onTrack('V1').slice(-1)[0], edge: 'out', note: '이 끝을 왼쪽으로 끄세요' },
        done: (s) => s.dur() < s.base.dur - 0.4 && gapless(s.onTrack('V1')),
      },
    ],
  },
  {
    id: 'transitions', group: '기초', title: '전환 넣기', min: 5, media: ['brollLandscape', 'brollCity', 'brollWaves'],
    intro: '세 장면 사이에 교차 디졸브를 넣고, 기본 전환 단축키와 길이 조정, 오디오 전환까지 해 봅니다.',
    async setup(L) {
      L.sequence('연습 - 전환');
      ['brollLandscape', 'brollCity', 'brollWaves'].forEach((k, i) => L.place(k, { start: i * 4, inPoint: 1.5, outPoint: 5.5 }));
    },
    steps: [
      panelStep('effects', '효과', ['창', '효과'], 'Shift+7', null, '효과 패널에는 비디오 효과, 비디오 전환, 오디오 효과, 오디오 전환이 폴더별로 있습니다.'),
      {
        t: '교차 디졸브 끌어다 놓기', d: '효과 패널에서 비디오 전환 ▸ 디졸브 ▸ 교차 디졸브를 찾아 (검색 칸에 \'교차\'를 입력해도 됩니다) 첫 번째 편집점(4초) 위로 끌어다 놓으세요.',
        why: '두 클립 모두 앞뒤로 여분(핸들)이 있어야 전환이 가운데에 놓입니다. 연습 클립은 여분을 두고 넣었습니다.',
        show: { panel: 'effects', text: '교차 디졸브' }, done: (s) => transitions(s, false) >= 1,
      },
      {
        t: '단축키로 기본 전환 넣기', d: '타임라인에서 재생 헤드를 두 번째 편집점(8초) 가까이에 두고 Ctrl+D를 누르세요. 가장 가까운 편집점에 기본 전환(교차 디졸브)이 들어갑니다.',
        path: ['시퀀스', '비디오 전환 적용'], key: 'Ctrl+D', show: { time: 8, note: '재생 헤드를 여기 두고 Ctrl+D' },
        done: (s) => transitions(s, false) >= 2,
      },
      {
        t: '전환 길이 바꾸기', d: '타임라인에서 전환(보라색 막대)을 클릭해 선택하고, 효과 컨트롤 패널의 길이 (타임코드)를 00:00:02:00(2초)으로 바꾸세요. 타임라인에서 전환의 끝을 끌어도 됩니다.',
        why: '보통 0.5~1초가 자연스럽고, 길면 느긋한 분위기가 됩니다.', show: { panel: 'effectControls', text: '길이 (타임코드)' },
        done: (s) => s.clips.some((c) => [c.transIn, c.transOut].some((t) => t && Math.abs(t.duration - 1) > 0.1)),
      },
      {
        t: '오디오 전환 넣기', d: '재생 헤드를 편집점 가까이에 두고 Ctrl+Shift+D를 누르세요. 소리에 지속 가감속(크로스페이드)이 들어가 툭 끊기지 않습니다.',
        path: ['시퀀스', '오디오 전환 적용'], key: 'Ctrl+Shift+D', done: (s) => transitions(s, true) >= 1,
      },
      playStep(),
    ],
  },
  {
    id: 'text', group: '기초', title: '텍스트와 자막', min: 6, media: ['brollLandscape', 'brollWaves'],
    intro: '문자 도구로 제목을 쓰고 기본 그래픽 패널에서 꾸민 뒤, 하단 자막 템플릿을 넣고 길이를 맞춥니다.',
    async setup(L) {
      L.sequence('연습 - 텍스트');
      L.place('brollLandscape', { start: 0 });
      L.place('brollWaves', { start: 8 });
    },
    steps: [
      toolStep('type', '문자 도구 고르기', '도구 막대에서 T 모양 문자 도구를 누르거나 T를 누르세요.', 'T'),
      {
        t: '프로그램 모니터에 글자 쓰기', d: '프로그램 모니터(오른쪽 위 화면)의 하늘 부분을 클릭하고 \'여름 여행\'처럼 제목을 입력한 뒤 Esc를 누르세요. 타임라인 빈 트랙에 텍스트 클립이 생기고, 도구는 선택 도구로 돌아옵니다.',
        show: { sel: '#pg-top-right .monitor-view' }, done: (s) => textClips(s).some((c) => val(c, 'text', 'content') !== '여기에 텍스트 입력'),
      },
      {
        t: '기본 그래픽에서 꾸미기', d: '텍스트 클립을 선택한 채 창 ▸ 기본 그래픽 패널의 편집 탭에서 글꼴 크기나 글자 색을 바꾸세요. 효과 컨트롤 ▸ 텍스트에서도 같은 값을 바꿀 수 있습니다.',
        path: ['창', '기본 그래픽'],
        done: (s) => textClips(s).some((c) => val(c, 'text', 'size') !== 96 || val(c, 'text', 'color') !== '#ffffff'),
      },
      {
        t: '하단 자막 템플릿 넣기', d: '재생 헤드를 8초 뒤로 옮기고 그래픽 및 타이틀 ▸ 타이틀 템플릿 ▸ 하단 자막에서 하나를 고르세요. 이름과 직함이 들어간 자막이 생깁니다.',
        why: '하단 자막(로어서드)은 인터뷰에서 사람 이름을 보여 줄 때 씁니다.', path: ['그래픽 및 타이틀', '타이틀 템플릿', '하단 자막'],
        done: (s) => s.did(/템플릿/),
      },
      {
        t: '자막 길이 맞추기', d: '선택 도구로 텍스트 클립의 오른쪽 끝을 끌어 장면이 바뀌는 8초에 맞추세요. 스냅(S)이 켜져 있으면 편집점에 착 붙습니다.',
        show: { clip: (s) => textClips(s).sort((a, b) => a.start - b.start)[0], edge: 'out', note: '이 끝을 8초까지 끄세요' },
        done: (s) => textClips(s).some((c) => c.start < 1 && Math.abs(end(c) - 8) < 0.3),
      },
      {
        t: '자동 캡션 (말소리가 있는 영상)', d: '말소리가 있는 영상은 그래픽 및 타이틀 ▸ 자동 캡션 만들기(음성 인식)로 자막을 한 번에 만들 수 있습니다. 처음 한 번 음성 인식 모델을 내려받습니다. 이 단계는 읽고 \'다음\'을 누르세요.',
        path: ['그래픽 및 타이틀', '자동 캡션 만들기 (음성 인식)…'],
      },
    ],
  },
  {
    id: 'export', group: '기초', title: '내보내기', min: 4, media: ['brollCity', 'music'],
    intro: '시작과 종료 표시로 내보낼 범위를 정하고, 내보내기 설정에서 형식을 골라 영상 파일로 저장합니다.',
    async setup(L) {
      L.sequence('연습 - 내보내기');
      L.place('brollCity', { start: 0 });
      L.place('music', { start: 0, audioTrack: 'A2', outPoint: 8 });
    },
    steps: [
      {
        t: '내보낼 범위 표시하기', d: '타임라인을 클릭하고 재생 헤드를 1초에 두고 I, 6초에 두고 O를 누르세요. 시간 눈금에 범위가 표시됩니다.',
        path: ['마커', '시작 표시'], key: 'I · O', done: (s) => s.seq.inPoint != null && s.seq.outPoint != null,
      },
      {
        t: '내보내기 설정 열기', d: '파일 ▸ 내보내기 ▸ 미디어…를 고르거나 Ctrl+M을 누르세요. 오른쪽 위 \'내보내기\' 단추도 같습니다.',
        path: ['파일', '내보내기', '미디어…'], key: 'Ctrl+M', done: (s) => s.modal(/내보내기 설정/),
      },
      {
        t: '형식과 범위 고르기', d: '형식은 강의처럼 H.264(MP4)를 고르세요. 이 브라우저가 만들 수 없는 형식은 고를 수 없으니 그때는 VP9(WebM)을 고릅니다. 범위가 \'시작에서 종료까지\'인지 확인하세요.',
        why: 'H.264(MP4)는 거의 모든 기기와 SNS에서 재생됩니다.', show: { sel: '.modal' },
      },
      {
        t: '내보내기', d: '대화 상자 아래의 \'내보내기\' 단추를 누르세요. 다 되면 파일이 내려받기 폴더에 저장됩니다.',
        show: { sel: '.modal .modal-buttons button.primary, .modal button.primary' }, done: (s) => s.toast(/내보냈습니다/),
      },
    ],
  },

  // ------------------------------------------------ editing techniques
  {
    id: 'jlcut', group: '편집 기술', title: 'J컷과 L컷', min: 6, media: ['interview', 'brollCity'],
    intro: '소리가 화면보다 먼저 들리거나(J컷) 화면이 바뀐 뒤에도 이어지게(L컷) 해서 장면을 자연스럽게 잇습니다.',
    async setup(L) {
      L.sequence('연습 - J컷 L컷');
      L.place('interview', { start: 0, inPoint: 0, outPoint: 8 });
      L.place('brollCity', { start: 8, inPoint: 1, outPoint: 7 });
      L.place('interview', { start: 14, inPoint: 8, outPoint: 16 });
    },
    steps: [
      toolStep('rolling', '롤링 편집 도구 고르기', '도구 막대의 잔물결 편집 도구 칸을 길게 누르거나 오른쪽 클릭해 롤링 편집 도구를 고르세요. N을 눌러도 됩니다.', 'N', '롤링 편집은 두 클립의 경계만 옮기고 전체 길이는 그대로 둡니다.'),
      {
        t: 'L컷: 인터뷰 소리를 B롤 밑으로 늘이기', d: 'Alt 키를 누른 채 A1 트랙의 첫 편집점(8초)을 오른쪽으로 2초쯤 끄세요. Alt를 누르면 연결된 영상은 그대로 두고 소리만 움직입니다.',
        why: '화면은 도시로 바뀌었는데 말소리가 이어지면 이야기가 끊기지 않습니다.', key: 'Alt+끌기',
        show: { clip: (s) => s.of('interview', 'audio')[0], edge: 'out', note: 'Alt를 누른 채 이 편집점을 오른쪽으로' },
        done: (s) => s.of('interview', 'audio').some((a) => { const v = linked(s, a); return v && end(a) > end(v) + 0.3; }),
      },
      {
        t: 'J컷: 다음 말소리를 먼저 들려주기', d: 'Alt 키를 누른 채 A1 트랙의 두 번째 편집점(14초)을 왼쪽으로 2초쯤 끄세요. 인터뷰 화면이 나오기 전에 말소리가 먼저 들립니다.',
        key: 'Alt+끌기', show: { clip: (s) => s.of('interview', 'audio').slice(-1)[0], edge: 'in', note: 'Alt를 누른 채 이 편집점을 왼쪽으로' },
        done: (s) => s.of('interview', 'audio').some((a) => { const v = linked(s, a); return v && a.start < v.start - 0.3; }),
      },
      toolStep('select', '선택 도구로 돌아가기', 'V를 누르세요.', 'V'),
      playStep(),
    ],
  },
  {
    id: 'threepoint', group: '편집 기술', title: '3점 편집과 덮어쓰기', min: 6, media: ['interview', 'brollLandscape'],
    intro: '소스의 시작·종료와 타임라인의 시작, 세 점만 정해 B롤 화면을 인터뷰 위에 덮어씁니다. 인터뷰 소리는 그대로 둡니다.',
    async setup(L) {
      L.sequence('연습 - 3점 편집');
      L.place('interview');
    },
    steps: [
      {
        t: '소스 모니터에 B롤 열기', d: '프로젝트 패널에서 \'B롤 - 풍경.webm\'을 두 번 클릭하세요.', show: { panel: 'project', text: 'B롤 - 풍경' },
        done: (s) => s.source === s.media('brollLandscape'),
      },
      {
        t: '소스에 시작·종료 표시 (1·2번째 점)', d: '소스 모니터에서 2초쯤에 I, 5초쯤에 O를 누르세요.', key: 'I · O', show: { panel: 'source' },
        done: (s) => { const m = s.project.media[s.media('brollLandscape')]; return m?.inPoint != null && m?.outPoint != null; },
      },
      {
        t: '타임라인에 시작 표시 (3번째 점)', d: '타임라인을 클릭하고 재생 헤드를 3초에 둔 뒤 I를 누르세요.', key: 'I', show: { time: 3 },
        done: (s) => s.seq.inPoint != null,
      },
      {
        t: '소스 오디오 패치 끄기', d: '타임라인 왼쪽 트랙 머리글에서 A1 옆의 파란 소스 패치 단추를 눌러 끄세요. 그러면 B롤의 소리는 들어가지 않고 인터뷰 소리가 남습니다.',
        why: '소스 패치는 소스의 영상·소리가 어느 트랙에 들어갈지 정합니다.', show: { sel: '.track-header button.src-patch.on' },
        done: (s) => !!s.seq.patchOff?.audio,
      },
      {
        t: '덮어쓰기', d: '. 키를 누르거나 소스 모니터 아래 덮어쓰기 단추를 누르세요. 3초부터 B롤 화면이 인터뷰 화면을 덮습니다.',
        path: ['클립', '덮어쓰기'], key: '.',
        done: (s) => s.of('brollLandscape', 'video').length > 0 && !s.of('brollLandscape', 'audio').length,
      },
      playStep(),
    ],
  },
  {
    id: 'multicam', group: '편집 기술', title: '멀티캠 편집', min: 7, media: ['cam1', 'cam2', 'cam3'],
    intro: '세 대의 카메라로 찍은 같은 장면을 박수 소리로 맞추고, 재생하면서 카메라를 바꿔 편집합니다.',
    panel: 'project',
    steps: [
      {
        t: '세 카메라 클립 선택', d: '프로젝트 패널에서 \'멀티캠 - 카메라 1\'을 클릭하고 Ctrl(맥: Cmd)을 누른 채 카메라 2, 3도 클릭하세요.',
        show: { panel: 'project', text: '멀티캠 - 카메라 1' }, done: (s) => ['cam1', 'cam2', 'cam3'].every((k) => s.selectedMedia.includes(s.media(k))),
      },
      {
        t: '멀티 카메라 소스 시퀀스 만들기', d: '선택한 클립을 오른쪽 클릭하고 \'멀티 카메라 소스 시퀀스 만들기…\'를 고르세요. 동기화 지점을 \'오디오\'로 두고 확인을 누르면 박수 소리로 세 앵글이 맞춰집니다.',
        why: '촬영을 시작한 때가 카메라마다 달라도 같은 소리를 찾아 맞춥니다. 슬레이트 박수가 그래서 필요합니다.',
        path: ['클립', '멀티 카메라 소스 시퀀스 만들기…'], done: (s) => Object.values(s.project.sequences).some((q) => q.multicam),
      },
      {
        t: '멀티캠 시퀀스를 타임라인에', d: '프로젝트 패널에 생긴 멀티캠 시퀀스를 오른쪽 클릭하고 \'클립에서 새 시퀀스\'를 고르세요.',
        path: ['파일', '새로 만들기', '클립에서 새 시퀀스'], done: (s) => s.clips.some((c) => c.kind === 'nest' && c.multicam),
      },
      panelStep('multicam', '멀티 카메라', ['창', '멀티 카메라'], null, '창 ▸ 멀티 카메라를 누르면 왼쪽에 앵글이 나란히 보입니다.'),
      {
        t: '재생하며 카메라 바꾸기', d: '스페이스바로 재생하면서 숫자 키 1, 2, 3을 눌러 보세요 (멀티 카메라 패널의 앵글을 클릭해도 됩니다). 누를 때마다 그 자리에서 컷이 나뉘고 앵글이 바뀝니다.',
        why: '실제 방송 스위처처럼 보면서 고르는 편집입니다. 고친 곳은 클립 ▸ 멀티 카메라에서 앵글을 다시 고르면 됩니다.',
        key: '1 · 2 · 3', done: (s) => new Set(s.clips.filter((c) => c.kind === 'nest' && c.multicam).map((c) => c.multicam.angle)).size >= 2,
      },
    ],
  },
  {
    id: 'nest', group: '편집 기술', title: '중첩', min: 4, media: ['brollLandscape', 'brollCity'],
    intro: '여러 클립을 하나의 중첩 시퀀스로 묶어 한꺼번에 효과를 주고, 안으로 들어가 고칩니다.',
    async setup(L) {
      L.sequence('연습 - 중첩');
      L.place('brollLandscape', { start: 0, inPoint: 1, outPoint: 5 });
      L.place('brollCity', { start: 4, inPoint: 1, outPoint: 5 });
    },
    steps: [
      {
        t: '두 클립 선택', d: '선택 도구로 빈 곳에서 두 클립을 감싸도록 끌거나, 첫 클립을 클릭하고 Shift를 누른 채 두 번째 클립을 클릭하세요.',
        done: (s) => s.sel.filter((c) => c.kind === 'video').length >= 2,
      },
      {
        t: '중첩하기', d: '선택한 클립을 오른쪽 클릭하고 \'중첩…\'을 고른 뒤 이름을 정하고 확인을 누르세요.',
        path: ['클립', '중첩…'], done: (s) => s.clips.some((c) => c.kind === 'nest' && !c.multicam),
      },
      {
        t: '중첩 안으로 들어가기', d: '초록색 중첩 클립을 두 번 클릭하세요. 타임라인에 중첩 시퀀스 탭이 열리고 원래 클립들이 보입니다.',
        show: { clip: (s) => s.clips.find((c) => c.kind === 'nest') }, done: (s) => s.seq.id !== s.base.seqId,
      },
      {
        t: '원래 시퀀스로 돌아가기', d: '타임라인 위쪽의 \'연습 - 중첩\' 탭을 클릭하세요.', show: { sel: '.timeline .seq-tab, .timeline .tl-tabs button' },
        done: (s) => s.clips.some((c) => c.kind === 'nest'),
      },
      {
        t: '중첩 클립에 효과 한 번에', d: '효과 패널에서 \'흑백\'을 찾아 중첩 클립에 끌어다 놓으세요. 안의 두 클립에 모두 적용됩니다.',
        show: { panel: 'effects' }, done: (s) => s.clips.some((c) => c.kind === 'nest' && userFx(c).length),
      },
    ],
  },

  // ------------------------------------------------ effects
  {
    id: 'zoom', group: '효과', title: '부드러운 줌 (키프레임)', min: 6, media: ['interview'],
    intro: '효과 컨트롤의 비율에 키프레임을 두 개 찍어 천천히 다가가는 줌을 만들고, 베지어로 부드럽게 합니다.',
    async setup(L) {
      L.sequence('연습 - 부드러운 줌');
      L.place('interview', { inPoint: 0, outPoint: 8 });
    },
    panel: 'effectControls',
    steps: [
      selectStep('interview', '클립 선택', '타임라인에서 인터뷰 클립을 클릭하세요.'),
      panelStep('effectControls', '효과 컨트롤', ['창', '효과 컨트롤'], 'Shift+5', '창 ▸ 효과 컨트롤(Shift+5)을 열면 모션 ▸ 위치·비율·회전이 보입니다.'),
      {
        t: '시작 키프레임', d: '재생 헤드를 클립 처음(0초)에 두고, 모션 ▸ 비율 왼쪽의 스톱워치를 누르세요. 지금 값(100)으로 키프레임이 생깁니다.',
        why: '스톱워치를 켜면 그 뒤로 바꾸는 값마다 키프레임이 찍힙니다.', show: { panel: 'effectControls', text: '비율' },
        done: (s) => s.of('interview', 'video').some((c) => kfs(c, 'motion', 'scale').length >= 1),
      },
      {
        t: '끝 키프레임', d: '재생 헤드를 4초로 옮기고 비율을 130으로 바꾸세요 (숫자를 끌거나 클릭해 입력). 두 번째 키프레임이 생깁니다.',
        show: { panel: 'effectControls', text: '비율' },
        done: (s) => s.of('interview', 'video').some((c) => { const k = kfs(c, 'motion', 'scale'); return k.length >= 2 && new Set(k.map((x) => x.v)).size >= 2; }),
      },
      {
        t: '베지어로 부드럽게', d: '효과 컨트롤 오른쪽 타임라인의 키프레임(◇)을 오른쪽 클릭하고 시간 보간 ▸ 베지어 (또는 감속·가속)를 고르세요. 모래시계 모양이 되면서 시작과 끝이 부드러워집니다.',
        why: '선형은 기계처럼 일정하게, 베지어는 카메라맨이 줌하듯 천천히 시작하고 멈춥니다.', show: { panel: 'effectControls', sel: '.panel-body[data-panel="effectControls"] .kf, .panel-body[data-panel="effectControls"] canvas' },
        done: (s) => s.of('interview', 'video').some((c) => kfs(c, 'motion', 'scale').some((k) => k.interp && k.interp !== 'linear' && k.interp !== 'hold')),
      },
      playStep(),
    ],
  },
  {
    id: 'speedramp', group: '효과', title: '속도 램프 (시간 다시 매핑)', min: 6, media: ['brollCity'],
    intro: '클립 키프레임을 시간 다시 매핑 ▸ 속도로 바꾸고, 키프레임을 나눠 빨라졌다 느려지는 속도 램프를 만듭니다.',
    async setup(L) {
      L.sequence('연습 - 속도 램프');
      L.place('brollCity');
    },
    steps: [
      {
        t: '트랙 높이 넓히기', d: 'V1 트랙 머리글의 빈 곳을 두 번 클릭하거나 Shift+=를 눌러 트랙을 넓히세요. 클립 가운데에 고무줄 같은 선이 보여야 합니다.',
        path: ['시퀀스', '모든 트랙 확장'], key: 'Shift+=',
      },
      {
        t: '속도 선 보이기', d: '클립을 오른쪽 클릭하고 클립 키프레임 표시 ▸ 시간 다시 매핑 ▸ 속도를 고르세요. 선이 속도(100%)를 나타냅니다.',
        show: { clip: (s) => s.of('brollCity', 'video')[0] },
      },
      {
        t: '속도 키프레임 두 개', d: 'Ctrl(맥: Cmd)을 누른 채 속도 선을 3초와 5초쯤에서 한 번씩 클릭하세요 (펜 도구 P로 클릭해도 됩니다).',
        key: 'Ctrl+클릭', show: { clip: (s) => s.of('brollCity', 'video')[0] },
        done: (s) => s.of('brollCity', 'video').some((c) => kfs(c, 'timeRemap', 'speed').length >= 2),
      },
      {
        t: '가운데를 빠르게', d: '선택 도구로 두 키프레임 사이의 선을 위로 끌어 300%쯤으로 만드세요. 그 구간만 빨라지고 클립이 짧아집니다.',
        done: (s) => s.of('brollCity', 'video').some((c) => kfs(c, 'timeRemap', 'speed').some((k) => k.v > 150)),
      },
      {
        t: '램프로 부드럽게', d: '키프레임의 반쪽을 옆으로 끌면 둘로 나뉘며 속도가 서서히 바뀝니다. 두 키프레임 모두 해 보세요.',
        why: '갑자기 빨라지는 것보다 서서히 바뀌어야 자연스럽습니다.', done: (s) => s.did(/속도 램프 전환/),
      },
      playStep(),
    ],
  },
  {
    id: 'blurface', group: '효과', title: '얼굴 흐리게 (마스크 추적)', min: 7, media: ['face'],
    intro: '모자이크 효과에 타원 마스크를 씌워 얼굴만 가리고, 마스크 경로 추적으로 움직이는 얼굴을 따라가게 합니다.',
    async setup(L) {
      L.sequence('연습 - 얼굴 흐리게');
      L.place('face');
    },
    panel: 'effects',
    steps: [
      effectStep('mosaic', '모자이크', '움직이는 얼굴', 'face'),
      {
        t: '타원 마스크 만들기', d: '클립을 선택한 채 효과 컨트롤의 모자이크 아래에 있는 타원 마스크 단추(○)를 누르세요. 화면 전체가 아니라 타원 안에만 모자이크가 생깁니다.',
        show: { panel: 'effectControls', text: '모자이크' },
        done: (s) => s.of('face', 'video').some((c) => masksOf(s.fx(c, 'mosaic')).length > 0),
      },
      {
        t: '마스크를 얼굴에 맞추기', d: '재생 헤드를 0초에 두고, 프로그램 모니터에서 타원 안쪽을 끌어 왼쪽의 얼굴 위로 옮기고 점을 끌어 크기를 맞추세요.',
        show: { sel: '#pg-top-right .monitor-view' },
        done: (s) => s.of('face', 'video').some((c) => masksOf(s.fx(c, 'mosaic')).some((m) => {
          const p = m.params?.path?.kf?.[0]?.v || m.params?.path?.value || [];
          if (!p.length) return false;
          const cx = p.reduce((a, v) => a + v[0], 0) / p.length;
          const cy = p.reduce((a, v) => a + v[1], 0) / p.length;
          return Math.abs(cx - 15) < 12 && Math.abs(cy - 48) < 15;
        })),
      },
      {
        t: '마스크 경로 추적', d: '효과 컨트롤의 마스크 경로 옆 ▶(선택한 마스크를 앞으로 추적) 단추를 누르세요. 프레임마다 키프레임이 찍히며 마스크가 얼굴을 따라갑니다.',
        why: '얼굴이 움직여도 손으로 키프레임을 찍을 필요가 없습니다. 어긋난 곳은 그 프레임에서 마스크를 옮겨 고칩니다.',
        show: { panel: 'effectControls', text: '마스크 경로' },
        done: (s) => s.of('face', 'video').some((c) => masksOf(s.fx(c, 'mosaic')).some((m) => (m.params?.path?.kf?.length || 0) > 10)),
      },
      playStep(),
    ],
  },
  {
    id: 'textbehind', group: '효과', title: '피사체 뒤 글자', min: 7, media: ['interview'],
    intro: '같은 클립을 위 트랙에 하나 더 놓고 사람만 마스크로 남겨, 글자가 사람 뒤에 있는 것처럼 보이게 합니다.',
    async setup(L) {
      L.sequence('연습 - 피사체 뒤 글자');
      L.place('interview', { inPoint: 0, outPoint: 8, audio: true });
    },
    steps: [
      {
        t: '클립을 V3에 복제', d: 'Alt(맥: Option)를 누른 채 V1의 인터뷰 클립을 V3 트랙으로 끌어 올리세요. 같은 클립이 하나 더 생깁니다.',
        why: '아래 클립은 배경, 위 클립은 사람만 잘라 낸 앞쪽 층이 됩니다.', key: 'Alt+끌기', show: { clip: (s) => s.of('interview', 'video')[0] },
        done: (s) => new Set(s.of('interview', 'video').map((c) => c.trackId)).size >= 2,
      },
      {
        t: 'V2에 글자 넣기', d: '타임라인 왼쪽의 V2 트랙 머리글을 클릭해 대상으로 정하고, 문자 도구(T)로 프로그램 모니터 왼쪽을 클릭해 큰 글자(예: \'안녕\')를 쓰세요. 글자가 V2에 없으면 클립을 V2로 끌어 내리세요.',
        show: { tool: 'type' },
        done: (s) => {
          const ys = s.of('interview', 'video').map((c) => s.vIndex(c));
          return textClips(s).some((t) => { const i = s.vIndex(t); return i > Math.min(...ys) && i < Math.max(...ys); });
        },
      },
      {
        t: '위 클립에 펜 마스크', d: '선택 도구로 V3의 인터뷰 클립을 선택하고, 효과 컨트롤 ▸ 불투명도 아래 펜 마스크(✒) 단추를 누른 뒤 프로그램 모니터에서 사람 둘레를 클릭해 감싸세요. 처음 점을 다시 누르면 닫힙니다. 타원 마스크(○)로 해도 됩니다.',
        why: '불투명도 마스크는 마스크 안만 보이게 합니다. 그래서 사람만 글자 앞에 남습니다.', show: { panel: 'effectControls', text: '불투명도' },
        done: (s) => {
          const list = s.of('interview', 'video');
          const top = list.reduce((a, c) => (s.vIndex(c) > s.vIndex(a) ? c : a), list[0]);
          return masksOf(top?.effects?.find((e) => e.type === 'opacity')).length > 0;
        },
      },
      {
        t: '마스크 페더로 가장자리 다듬기', d: '마스크 페더 값을 조금 올려 경계를 부드럽게 하세요.', show: { panel: 'effectControls', text: '마스크 페더' },
        done: (s) => s.of('interview', 'video').some((c) => masksOf(c.effects.find((e) => e.type === 'opacity')).some((m) => (m.params?.feather?.value ?? 10) !== 10)),
      },
    ],
  },
  {
    id: 'greenscreen', group: '효과', title: '그린 스크린 (울트라 키)', min: 6, media: ['greenscreen', 'brollCity'],
    intro: '초록 배경 앞에서 찍은 인물에 울트라 키를 넣어 배경을 빼고, 도시 장면과 합성합니다.',
    async setup(L) {
      L.sequence('연습 - 그린 스크린');
      L.place('brollCity', { track: 'V1' });
      L.place('greenscreen', { track: 'V2' });
    },
    panel: 'effects',
    steps: [
      effectStep('ultraKey', '울트라 키', 'V2의 그린 스크린', 'greenscreen'),
      {
        t: '키 색상 찍기', d: '효과 컨트롤 ▸ 울트라 키 ▸ 키 색상의 스포이드를 누르고 프로그램 모니터의 초록 배경을 클릭하세요. 배경이 빠지고 도시가 보입니다.',
        show: { panel: 'effectControls', text: '키 색상' },
        done: (s) => s.of('greenscreen', 'video').some((c) => {
          const v = String(s.fx(c, 'ultraKey')?.params?.keyColor?.value || '').toLowerCase();
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
          return v !== '#00b140' && g > r + 60 && g > b + 40;
        }),
      },
      {
        t: '알파 채널로 매트 보기', d: '출력을 \'알파 채널\'로 바꾸세요. 흰색은 보이는 곳, 검정은 빠진 곳입니다. 회색이 남은 곳이 없는지 봅니다.',
        show: { panel: 'effectControls', text: '출력' },
        done: (s) => s.of('greenscreen', 'video').some((c) => (s.fx(c, 'ultraKey')?.params?.output?.value || 'composite') !== 'composite'),
      },
      {
        t: '매트 정리 후 합성으로', d: '매트 정리 ▸ 경계 감소나 부드럽게를 조금 올리고, 출력을 다시 \'합성\'으로 바꾸세요.',
        why: '초록 테두리(스필)가 남으면 경계 감소와 스필 억제로 정리합니다.', show: { panel: 'effectControls', text: '매트 정리' },
        done: (s) => s.of('greenscreen', 'video').some((c) => {
          const p = s.fx(c, 'ultraKey')?.params;
          return p && p.output.value === 'composite' && (p.choke.value > 0 || p.soften.value > 0);
        }),
      },
    ],
  },

  // ------------------------------------------------ color and sound
  {
    id: 'lumetri', group: '색과 소리', title: 'Lumetri 기본 교정과 Look', min: 6, media: ['brollLandscape'],
    intro: 'Lumetri 색상 패널의 기본 교정으로 흰색 균형과 밝기를 맞추고, 크리에이티브 Look으로 분위기를 입힙니다.',
    async setup(L) {
      L.sequence('연습 - Lumetri');
      L.place('brollLandscape');
    },
    steps: [
      {
        t: '색상 작업 영역', d: '창 ▸ 작업 영역 ▸ 색상(Alt+Shift+4)을 고르세요. Lumetri 범위와 Lumetri 색상 패널이 앞으로 나옵니다.',
        path: ['창', '작업 영역', '색상'], key: 'Alt+Shift+4', done: (s) => s.panel('lumetri') || s.panel('scopes'),
      },
      selectStep('brollLandscape', '클립 선택'),
      {
        t: '흰색 균형 (온도·색조)', d: 'Lumetri 색상 ▸ 기본 교정에서 온도를 왼쪽(파랗게)이나 오른쪽(노랗게)으로 옮겨 보세요. 흰색 균형 선택기 스포이드로 흰 구름을 찍어도 됩니다.',
        show: { panel: 'lumetri', text: '온도' },
        done: (s) => s.of('brollLandscape', 'video').some((c) => (val(c, 'lumetri', 'temperature') || 0) !== 0 || (val(c, 'lumetri', 'tint') || 0) !== 0 || (val(c, 'lumetri', 'wbColor') || '#ffffff') !== '#ffffff'),
      },
      {
        t: '노출과 대비', d: '노출을 조금 올리고 대비를 올려 보세요. Lumetri 범위의 파형이 위아래로 넓게 퍼지면 좋습니다.',
        show: { panel: 'lumetri', text: '노출' },
        done: (s) => s.of('brollLandscape', 'video').some((c) => (val(c, 'lumetri', 'exposure') || 0) !== 0 || (val(c, 'lumetri', 'contrast') || 0) !== 0),
      },
      {
        t: '크리에이티브 Look', d: '크리에이티브 ▸ Look 목록에서 하나를 고르세요.', show: { panel: 'lumetri', text: '크리에이티브' },
        done: (s) => s.of('brollLandscape', 'video').some((c) => !!val(c, 'lumetri', 'look')),
      },
      {
        t: '강도 조절', d: 'Look 아래의 강도를 낮춰 너무 진하지 않게 맞추세요.', show: { panel: 'lumetri', text: '강도' },
        done: (s) => s.of('brollLandscape', 'video').some((c) => (val(c, 'lumetri', 'lookIntensity') ?? 100) !== 100),
      },
    ],
  },
  {
    id: 'dialogue', group: '색과 소리', title: '대화 정리 (기본 사운드)', min: 5, media: ['interview'],
    intro: '기본 사운드 패널에서 인터뷰 소리를 \'대화\'로 지정하고, 음량을 맞추고 잡음과 험을 줄입니다.',
    async setup(L) {
      L.sequence('연습 - 대화 정리');
      L.place('interview');
    },
    steps: [
      {
        t: '오디오 작업 영역', d: '창 ▸ 작업 영역 ▸ 오디오(Alt+Shift+6)를 고르세요. 기본 사운드 패널이 앞으로 나옵니다.',
        path: ['창', '작업 영역', '오디오'], key: 'Alt+Shift+6', done: (s) => s.panel('essentialSound'),
      },
      selectStep('interview', '오디오 클립 선택', 'A1 트랙의 인터뷰 소리 클립을 클릭하세요.', 'audio'),
      {
        t: '\'대화\'로 지정', d: '기본 사운드 패널에서 \'대화\'를 누르세요. 대화에 맞는 도구(음량, 복구, 명료도)가 나옵니다.',
        show: { panel: 'essentialSound', text: '대화' }, done: (s) => s.of('interview', 'audio').some((c) => c.essential?.type === 'dialogue'),
      },
      {
        t: '음량 자동 일치', d: '음량 ▸ \'자동 일치\'를 누르세요. 방송 기준(-23 LUFS 무렵)에 맞게 게인이 정해집니다.',
        why: '클립마다 소리 크기가 다르면 보는 사람이 볼륨을 계속 만져야 합니다.', show: { panel: 'essentialSound', text: '자동 일치' },
        done: (s) => s.did(/음량 자동 일치/) || s.of('interview', 'audio').some((c) => c.gain),
      },
      {
        t: '잡음 줄이기', d: '복구를 펼치고 \'노이즈 감소\'와 \'험 제거\'를 켜세요. 쉬는 구간의 "쉬—" 소리와 낮은 "웅—" 소리가 줄어듭니다.',
        show: { panel: 'essentialSound', text: '복구' },
        done: (s) => s.of('interview', 'audio').some((c) => c.effects.some((e) => e.essential && /denoise|humRemove/.test(e.type))),
      },
      playStep('재생하며 차이를 들어 보세요. 효과 컨트롤의 효과 이름 옆 fx 단추로 켜고 끄며 비교할 수 있습니다.'),
    ],
  },
  {
    id: 'ducking', group: '색과 소리', title: '음악 더킹과 음량', min: 6, media: ['interview', 'music'],
    intro: '말소리가 나올 때만 배경 음악이 저절로 작아지게(더킹) 하고, 음악 음량을 맞춥니다.',
    async setup(L) {
      L.sequence('연습 - 음악 더킹');
      L.place('interview');
      L.place('music', { audioTrack: 'A2', outPoint: 16 });
    },
    steps: [
      {
        t: '인터뷰 소리를 \'대화\'로', d: 'A1의 인터뷰 소리 클립을 선택하고 기본 사운드 패널(창 ▸ 기본 사운드)에서 \'대화\'를 누르세요.',
        path: ['창', '기본 사운드'], show: { clip: (s) => s.of('interview', 'audio')[0] },
        done: (s) => s.of('interview', 'audio').some((c) => c.essential?.type === 'dialogue'),
      },
      {
        t: '음악 클립을 \'음악\'으로', d: 'A2의 음악 클립을 선택하고 기본 사운드 패널에서 \'음악\'을 누르세요.',
        show: { clip: (s) => s.of('music', 'audio')[0] }, done: (s) => s.of('music', 'audio').some((c) => c.essential?.type === 'music'),
      },
      {
        t: '더킹 켜고 키프레임 생성', d: '음악 클립을 선택한 채 기본 사운드 ▸ 더킹을 켜고 \'대화\'에 맞춰 줄이기를 확인한 뒤 \'키프레임 생성\'을 누르세요.',
        why: '말이 나오는 곳마다 음악 볼륨에 키프레임이 찍혀 작아졌다가, 말이 끝나면 돌아옵니다.', show: { panel: 'essentialSound', text: '더킹' },
        done: (s) => s.of('music', 'audio').some((c) => kfs(c, 'volume', 'level').length >= 4 || kfs(c, 'volume', 'gain').length >= 4 || c.effects.some((e) => e.type === 'volume' && Object.values(e.params).some((p) => (p.kf?.length || 0) >= 4))),
      },
      {
        t: '음악 음량 맞추기', d: '기본 사운드 ▸ 클립 볼륨 ▸ 수준을 내리거나, 타임라인에서 음악 클립의 볼륨 선을 아래로 끌어 말소리가 잘 들리게 하세요.',
        done: (s) => s.changed(),
      },
      playStep(),
    ],
  },
  {
    id: 'gain', group: '색과 소리', title: '오디오 게인', min: 4, media: ['interview', 'sfxDing'],
    intro: '작게 녹음된 소리를 오디오 게인으로 키우고, 효과음은 최대 피크 노멀라이즈로 맞춥니다.',
    async setup(L) {
      L.sequence('연습 - 오디오 게인');
      L.place('interview');
      L.place('sfxDing', { start: 3, audioTrack: 'A2' });
    },
    steps: [
      selectStep('interview', '인터뷰 소리 선택', 'A1의 인터뷰 소리 클립을 클릭하세요.', 'audio'),
      {
        t: '오디오 게인 열기', d: 'G를 누르거나 클립 ▸ 오디오 옵션 ▸ 오디오 게인…을 고르세요.', path: ['클립', '오디오 옵션', '오디오 게인…'], key: 'G',
        done: (s) => s.modal(/오디오 게인/),
      },
      {
        t: '게인 올리기', d: '\'게인 조정\'에 6을 입력하고 확인을 누르세요. 클립의 파형이 커집니다.', show: { sel: '.modal' },
        done: (s) => s.of('interview', 'audio').some((c) => (c.gain || 0) > 0),
      },
      {
        t: '효과음 노멀라이즈', d: 'A2의 효과음 클립을 선택하고 G를 눌러 \'최대 피크 노멀라이즈\'를 -1 dB로 두고 확인을 누르세요.',
        why: '노멀라이즈는 가장 큰 소리가 그 값이 되도록 게인을 정해 줍니다.', key: 'G', show: { clip: (s) => s.of('sfxDing', 'audio')[0] },
        done: (s) => s.of('sfxDing', 'audio').some((c) => c.gain),
      },
    ],
  },
];
