// Declarative definitions of every effect and transition. Rendering lives in compositor.js
// (video) and playback.js / export.js / audio-fx.js (audio); this file only describes parameters.

export const BLEND_MODES = [
  ['source-over', '표준'],
  ['darken', '어둡게 하기'],
  ['multiply', '곱하기'],
  ['color-burn', '색상 번'],
  ['lighten', '밝게 하기'],
  ['screen', '스크린'],
  ['color-dodge', '색상 닷지'],
  ['lighter', '선형 닷지(추가)'],
  ['overlay', '오버레이'],
  ['soft-light', '소프트 라이트'],
  ['hard-light', '하드 라이트'],
  ['difference', '차이'],
  ['exclusion', '제외'],
  ['hue', '색조'],
  ['saturation', '채도'],
  ['color', '색상'],
  ['luminosity', '광도'],
];

export const FONTS = [
  ['Noto Sans KR', '본고딕 (Noto Sans KR)'],
  ['Noto Serif KR', '본명조 (Noto Serif KR)'],
  ['Black Han Sans', '검은고딕 (Black Han Sans)'],
  ['Do Hyeon', '도현 (Do Hyeon)'],
  ['Jua', '주아 (Jua)'],
  ['Nanum Pen Script', '나눔손글씨 펜'],
  ['sans-serif', '시스템 고딕'],
  ['serif', '시스템 명조'],
  ['monospace', '시스템 고정폭'],
  ['Arial', 'Arial'],
  ['Georgia', 'Georgia'],
  ['Impact', 'Impact'],
  ['Courier New', 'Courier New'],
];

const DIRECTIONS = [['left', '왼쪽으로'], ['right', '오른쪽으로'], ['up', '위로'], ['down', '아래로']];

const num = (key, label, def, opts = {}) => ({ key, label, type: 'number', default: def, animatable: true, step: 1, ...opts });
const pct = (key, label, def, opts = {}) => num(key, label, def, { min: 0, max: 100, unit: '%', ...opts });

/** Dynamic option lists for selects (resolved against the project when shown). */
export const DYNAMIC_OPTIONS = {
  videoTracks: (project, seq) => seq.tracks.filter((t) => t.kind === 'video').map((t) => [t.id, t.name]),
  luts: (project) => [['', '(LUT 없음)'], ...project.mediaOrder.map((id) => project.media[id]).filter((m) => m?.kind === 'lut').map((m) => [m.id, m.name])],
};

/**
 * Effects. `kind` is the clip family they apply to. `fixed` effects are created automatically
 * with each clip (like Motion/Opacity/Volume) and cannot be removed.
 */
export const EFFECTS = {
  // ---- fixed video ----
  motion: {
    name: '모션', kind: 'video', fixed: true,
    params: [
      num('posX', '위치 X', (seq) => seq.width / 2, { unit: 'px' }),
      num('posY', '위치 Y', (seq) => seq.height / 2, { unit: 'px' }),
      num('scale', '비율', 100, { min: 0, max: 2000, unit: '%' }),
      num('rotation', '회전', 0, { unit: '°' }),
      num('anchorX', '기준점 X', 0, { unit: 'px', hint: '클립 중심에서의 거리' }),
      num('anchorY', '기준점 Y', 0, { unit: 'px' }),
    ],
  },
  opacity: {
    name: '불투명도', kind: 'video', fixed: true,
    params: [
      pct('opacity', '불투명도', 100),
      { key: 'blend', label: '혼합 모드', type: 'select', default: 'source-over', options: BLEND_MODES },
    ],
  },
  timeRemap: {
    name: '시간 다시 매핑', kind: 'any', fixed: true,
    params: [num('speed', '속도', 100, { min: 0, max: 1000, unit: '%', hint: '키프레임을 추가하면 속도 램프가 됩니다' })],
  },
  text: {
    name: '텍스트', kind: 'video', fixed: true,
    params: [
      { key: 'content', label: '내용', type: 'text', default: '여기에 텍스트 입력' },
      { key: 'font', label: '글꼴', type: 'select', default: 'Noto Sans KR', options: FONTS },
      num('size', '글꼴 크기', 96, { min: 4, max: 1000, unit: 'px' }),
      { key: 'bold', label: '굵게', type: 'bool', default: true },
      { key: 'italic', label: '기울임', type: 'bool', default: false },
      { key: 'align', label: '정렬', type: 'select', default: 'center', options: [['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']] },
      num('lineHeight', '행간', 120, { min: 50, max: 400, unit: '%' }),
      num('tracking', '자간', 0, { min: -50, max: 200, unit: 'px' }),
      pct('reveal', '나타내기 (타자기)', 100, { hint: '0 → 100으로 키프레임을 주면 글자가 한 자씩 나타납니다' }),
      { key: 'color', label: '글자 색', type: 'color', default: '#ffffff' },
      { key: 'strokeColor', label: '외곽선 색', type: 'color', default: '#000000' },
      num('strokeWidth', '외곽선 두께', 0, { min: 0, max: 100, unit: 'px' }),
      { key: 'background', label: '배경 상자', type: 'bool', default: false },
      { key: 'bgColor', label: '배경 색', type: 'color', default: '#000000' },
      pct('bgOpacity', '배경 불투명도', 60),
      num('bgPadding', '배경 여백', 24, { min: 0, max: 400, unit: 'px' }),
    ],
  },
  fill: {
    name: '색상 매트', kind: 'video', fixed: true,
    params: [{ key: 'color', label: '색상', type: 'color', default: '#1e3a8a' }],
  },
  shape: {
    name: '도형', kind: 'video', fixed: true,
    params: [
      { key: 'shape', label: '모양', type: 'select', default: 'rectangle', options: [['rectangle', '사각형'], ['ellipse', '타원'], ['triangle', '삼각형'], ['line', '선']] },
      num('width', '너비', 600, { min: 1, max: 8000, unit: 'px' }),
      num('height', '높이', 200, { min: 1, max: 8000, unit: 'px' }),
      num('radius', '모서리 둥글기', 0, { min: 0, max: 2000, unit: 'px' }),
      { key: 'fillOn', label: '채우기', type: 'bool', default: true },
      { key: 'fill', label: '채우기 색', type: 'color', default: '#2d8ceb' },
      { key: 'gradient', label: '그라디언트', type: 'bool', default: false },
      { key: 'fill2', label: '그라디언트 끝 색', type: 'color', default: '#9b5de5' },
      num('gradAngle', '그라디언트 각도', 0, { unit: '°' }),
      { key: 'strokeColor', label: '외곽선 색', type: 'color', default: '#ffffff' },
      num('strokeWidth', '외곽선 두께', 0, { min: 0, max: 200, unit: 'px' }),
    ],
  },

  // ---- user video effects ----
  brightnessContrast: {
    name: '밝기 및 대비', kind: 'video', category: '조정',
    params: [num('brightness', '밝기', 0, { min: -100, max: 100 }), num('contrast', '대비', 0, { min: -100, max: 100 })],
  },
  basicColor: {
    name: '기본 색상 보정', kind: 'video', category: '색상 보정',
    params: [
      num('exposure', '노출', 0, { min: -100, max: 100 }),
      num('contrast', '대비', 0, { min: -100, max: 100 }),
      num('saturation', '채도', 100, { min: 0, max: 300, unit: '%' }),
      num('temperature', '색온도', 0, { min: -100, max: 100 }),
      num('tint', '색조(틴트)', 0, { min: -100, max: 100 }),
    ],
  },
  lumetri: {
    name: '고급 색상 보정 (커브·휠)', kind: 'video', category: '색상 보정',
    params: [
      num('exposure', '노출', 0, { min: -5, max: 5, step: 0.05, unit: '스톱' }),
      num('contrast', '대비', 0, { min: -100, max: 100 }),
      num('highlights', '밝은 영역', 0, { min: -100, max: 100 }),
      num('shadows', '어두운 영역', 0, { min: -100, max: 100 }),
      num('whites', '흰색 계열', 0, { min: -100, max: 100 }),
      num('blacks', '검정 계열', 0, { min: -100, max: 100 }),
      num('temperature', '색온도', 0, { min: -100, max: 100 }),
      num('tint', '색조(틴트)', 0, { min: -100, max: 100 }),
      num('saturation', '채도', 100, { min: 0, max: 200, unit: '%' }),
      num('vibrance', '생동감', 0, { min: -100, max: 100 }),
      { key: 'shadowsWheel', label: '어두운 영역 색상 휠', type: 'wheel', default: { x: 0, y: 0 } },
      { key: 'midsWheel', label: '중간 영역 색상 휠', type: 'wheel', default: { x: 0, y: 0 } },
      { key: 'highlightsWheel', label: '밝은 영역 색상 휠', type: 'wheel', default: { x: 0, y: 0 } },
      { key: 'curves', label: 'RGB 커브', type: 'curves', default: { master: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } },
    ],
  },
  lut: {
    name: 'LUT 적용 (.cube)', kind: 'video', category: '색상 보정',
    params: [
      { key: 'lutId', label: 'LUT', type: 'select', default: '', options: 'luts', hint: '.cube 파일을 가져오기 하면 목록에 나타납니다' },
      pct('intensity', '강도', 100),
    ],
  },
  hueShift: {
    name: '색조 회전', kind: 'video', category: '색상 보정',
    params: [num('hue', '색조', 0, { min: -180, max: 180, unit: '°' })],
  },
  tint: {
    name: '틴트 (두 색 매핑)', kind: 'video', category: '색상 보정',
    params: [
      { key: 'black', label: '검정을 이 색으로', type: 'color', default: '#1a1a40' },
      { key: 'white', label: '흰색을 이 색으로', type: 'color', default: '#ffe8b0' },
      pct('amount', '적용량', 100),
    ],
  },
  gaussianBlur: {
    name: '가우시안 흐림', kind: 'video', category: '흐림 및 선명',
    params: [num('blurriness', '흐림 정도', 10, { min: 0, max: 300, unit: 'px', step: 0.5 })],
  },
  sharpen: {
    name: '선명하게', kind: 'video', category: '흐림 및 선명',
    params: [num('amount', '선명 정도', 50, { min: 0, max: 300 })],
  },
  censor: {
    name: '부분 모자이크/흐림 (얼굴 가리기)', kind: 'video', category: '흐림 및 선명',
    params: [
      { key: 'mode', label: '방식', type: 'select', default: 'mosaic', options: [['mosaic', '모자이크'], ['blur', '흐림']] },
      num('strength', '세기', 30, { min: 1, max: 200 }),
      { key: 'shape', label: '영역 모양', type: 'select', default: 'ellipse', options: [['ellipse', '타원'], ['rectangle', '사각형']] },
      pct('cx', '영역 중심 X', 50),
      pct('cy', '영역 중심 Y', 40),
      pct('w', '영역 너비', 25),
      pct('h', '영역 높이', 35),
      num('feather', '가장자리 페더', 10, { min: 0, max: 200, unit: 'px' }),
    ],
  },
  blackWhite: { name: '흑백', kind: 'video', category: '이미지 컨트롤', params: [] },
  sepia: { name: '세피아', kind: 'video', category: '이미지 컨트롤', params: [pct('amount', '양', 100)] },
  invert: { name: '반전', kind: 'video', category: '이미지 컨트롤', params: [pct('amount', '양', 100)] },
  colorKey: {
    name: '크로마 키 (색상 키)', kind: 'video', category: '키잉 및 합성',
    params: [
      { key: 'keyColor', label: '키 색상', type: 'color', default: '#00ff00' },
      pct('tolerance', '허용치', 30),
      pct('softness', '가장자리 부드럽게', 10),
      pct('spill', '색 번짐 억제', 50),
    ],
  },
  mask: {
    name: '마스크', kind: 'video', category: '키잉 및 합성',
    params: [
      { key: 'shape', label: '모양', type: 'select', default: 'ellipse', options: [['ellipse', '타원'], ['rectangle', '사각형'], ['polygon', '다각형 (펜)']] },
      pct('cx', '중심 X', 50),
      pct('cy', '중심 Y', 50),
      pct('w', '너비', 50, { max: 300 }),
      pct('h', '높이', 50, { max: 300 }),
      num('rotation', '회전', 0, { unit: '°' }),
      num('feather', '페더', 20, { min: 0, max: 500, unit: 'px' }),
      num('expansion', '확장', 0, { min: -500, max: 500, unit: 'px' }),
      pct('opacity', '마스크 불투명도', 100),
      { key: 'invert', label: '반전', type: 'bool', default: false },
      { key: 'points', label: '다각형 점', type: 'points', default: [[30, 25], [70, 25], [78, 70], [22, 70]] },
    ],
  },
  trackMatte: {
    name: '트랙 매트 키', kind: 'video', category: '키잉 및 합성',
    params: [
      { key: 'track', label: '매트 트랙', type: 'select', default: '', options: 'videoTracks', hint: '이 트랙의 내용 모양대로 클립이 보입니다' },
      { key: 'mode', label: '합성 방식', type: 'select', default: 'alpha', options: [['alpha', '알파 매트'], ['luma', '루마 매트']] },
      { key: 'invert', label: '반전', type: 'bool', default: false },
      { key: 'hideMatte', label: '매트 트랙 숨기기', type: 'bool', default: true },
    ],
  },
  mosaic: {
    name: '모자이크 (전체)', kind: 'video', category: '스타일화',
    params: [num('blocks', '가로 블록 수', 40, { min: 1, max: 400 })],
  },
  vignette: {
    name: '비네팅', kind: 'video', category: '스타일화',
    params: [pct('amount', '양', 50), pct('midpoint', '중간점', 50), { key: 'color', label: '색상', type: 'color', default: '#000000' }],
  },
  findEdges: { name: '가장자리 찾기', kind: 'video', category: '스타일화', params: [] },
  posterize: {
    name: '포스터화', kind: 'video', category: '스타일화',
    params: [num('levels', '단계', 6, { min: 2, max: 32 })],
  },
  glow: {
    name: '글로우 (빛 번짐)', kind: 'video', category: '스타일화',
    params: [num('radius', '반경', 20, { min: 0, max: 200, unit: 'px' }), pct('intensity', '강도', 60)],
  },
  filmGrain: {
    name: '필름 그레인', kind: 'video', category: '노이즈 및 그레인',
    params: [pct('amount', '양', 35), num('size', '입자 크기', 1, { min: 1, max: 8, step: 0.5 })],
  },
  dropShadow: {
    name: '그림자', kind: 'video', category: '원근',
    params: [
      { key: 'color', label: '그림자 색', type: 'color', default: '#000000' },
      pct('opacity', '불투명도', 60),
      num('direction', '방향', 135, { unit: '°' }),
      num('distance', '거리', 12, { min: 0, max: 400, unit: 'px' }),
      num('softness', '부드러움', 16, { min: 0, max: 400, unit: 'px' }),
    ],
  },
  crop: {
    name: '자르기', kind: 'video', category: '변형',
    params: [pct('left', '왼쪽', 0), pct('top', '위쪽', 0), pct('right', '오른쪽', 0), pct('bottom', '아래쪽', 0)],
  },
  hFlip: { name: '가로 뒤집기', kind: 'video', category: '변형', params: [] },
  vFlip: { name: '세로 뒤집기', kind: 'video', category: '변형', params: [] },
  letterbox: {
    name: '레터박스 (영화 비율)', kind: 'video', category: '변형',
    params: [
      num('aspect', '화면비', 2.39, { min: 0.5, max: 4, step: 0.01 }),
      { key: 'color', label: '막대 색', type: 'color', default: '#000000' },
    ],
  },
  cameraShake: {
    name: '카메라 흔들림', kind: 'video', category: '왜곡',
    params: [num('amount', '세기', 20, { min: 0, max: 400, unit: 'px' }), num('speed', '빠르기', 8, { min: 0.1, max: 60, unit: 'Hz', step: 0.1 }), num('rotation', '회전 흔들림', 1, { min: 0, max: 45, unit: '°', step: 0.1 })],
  },
  stabilize: {
    name: '손떨림 보정', kind: 'video', category: '왜곡',
    params: [
      { key: 'analyze', label: '분석', type: 'action', default: null, hint: '클립을 분석해 흔들림을 계산합니다' },
      pct('smoothness', '부드러움', 50),
      pct('zoom', '추가 확대', 0, { max: 50, hint: '가장자리가 보이면 높이세요' }),
      { key: 'rotation', label: '회전 보정', type: 'bool', default: true },
    ],
  },

  // ---- fixed audio ----
  volume: {
    name: '볼륨', kind: 'audio', fixed: true,
    params: [num('level', '레벨', 0, { min: -60, max: 15, unit: 'dB', step: 0.1 })],
  },
  panner: {
    name: '패너 (좌우)', kind: 'audio', fixed: true,
    params: [num('balance', '밸런스', 0, { min: -100, max: 100 })],
  },

  // ---- user audio effects ----
  gain: {
    name: '증폭', kind: 'audio', category: '진폭',
    params: [num('gain', '게인', 6, { min: -30, max: 30, unit: 'dB', step: 0.1 })],
  },
  compressor: {
    name: '컴프레서 (다이내믹)', kind: 'audio', category: '진폭',
    params: [
      num('threshold', '임계값', -24, { min: -100, max: 0, unit: 'dB' }),
      num('ratio', '비율', 4, { min: 1, max: 20, step: 0.1 }),
      num('knee', '니', 30, { min: 0, max: 40, unit: 'dB' }),
      num('attack', '어택', 3, { min: 0, max: 1000, unit: 'ms' }),
      num('release', '릴리스', 250, { min: 0, max: 1000, unit: 'ms' }),
      num('makeup', '메이크업 게인', 0, { min: 0, max: 30, unit: 'dB', step: 0.1 }),
    ],
  },
  noiseGate: {
    name: '노이즈 게이트', kind: 'audio', category: '노이즈 감소',
    params: [
      num('threshold', '임계값', -45, { min: -90, max: 0, unit: 'dB' }),
      num('reduction', '감소량', -40, { min: -90, max: 0, unit: 'dB' }),
      num('attack', '어택', 5, { min: 0.1, max: 200, unit: 'ms', step: 0.1 }),
      num('release', '릴리스', 150, { min: 5, max: 2000, unit: 'ms' }),
    ],
  },
  humRemove: {
    name: '험 제거 (전기 잡음)', kind: 'audio', category: '노이즈 감소',
    params: [
      { key: 'freq', label: '주파수', type: 'select', default: '60', options: [['60', '60 Hz (한국·미국)'], ['50', '50 Hz (유럽·일본 동부)']] },
      num('harmonics', '배음 수', 4, { min: 1, max: 8, animatable: false }),
      num('q', '좁기 (Q)', 30, { min: 1, max: 100, animatable: false }),
    ],
  },
  eq3: {
    name: '3밴드 이퀄라이저', kind: 'audio', category: '필터 및 EQ',
    params: [
      num('lowFreq', '저음 주파수', 200, { min: 20, max: 1000, unit: 'Hz' }),
      num('lowGain', '저음', 0, { min: -24, max: 24, unit: 'dB', step: 0.1 }),
      num('midFreq', '중음 주파수', 1000, { min: 100, max: 8000, unit: 'Hz', step: 10 }),
      num('midGain', '중음', 0, { min: -24, max: 24, unit: 'dB', step: 0.1 }),
      num('midQ', '중음 폭 (Q)', 1, { min: 0.1, max: 18, step: 0.1 }),
      num('highFreq', '고음 주파수', 5000, { min: 1000, max: 20000, unit: 'Hz', step: 10 }),
      num('highGain', '고음', 0, { min: -24, max: 24, unit: 'dB', step: 0.1 }),
    ],
  },
  highpass: {
    name: '하이패스 (저음 제거)', kind: 'audio', category: '필터 및 EQ',
    params: [num('frequency', '차단 주파수', 120, { min: 20, max: 20000, unit: 'Hz' }), num('q', 'Q', 0.7, { min: 0.1, max: 18, step: 0.1 })],
  },
  lowpass: {
    name: '로우패스 (고음 제거)', kind: 'audio', category: '필터 및 EQ',
    params: [num('frequency', '차단 주파수', 6000, { min: 20, max: 20000, unit: 'Hz', step: 10 }), num('q', 'Q', 0.7, { min: 0.1, max: 18, step: 0.1 })],
  },
  bandpass: {
    name: '밴드패스 (전화 음성)', kind: 'audio', category: '필터 및 EQ',
    params: [num('frequency', '중심 주파수', 1500, { min: 20, max: 20000, unit: 'Hz', step: 10 }), num('q', 'Q', 1.2, { min: 0.1, max: 18, step: 0.1 })],
  },
  reverb: {
    name: '리버브 (울림)', kind: 'audio', category: '리버브',
    params: [pct('mix', '믹스', 30), num('decay', '잔향 길이', 2, { min: 0.1, max: 10, unit: '초', step: 0.1, animatable: false })],
  },
  delay: {
    name: '딜레이 (메아리)', kind: 'audio', category: '딜레이 및 에코',
    params: [num('time', '지연 시간', 0.3, { min: 0.01, max: 5, unit: '초', step: 0.01 }), pct('feedback', '피드백', 35), pct('mix', '믹스', 30)],
  },
};

export const TRANSITIONS = {
  crossDissolve: { name: '교차 디졸브', kind: 'video', category: '디졸브' },
  additiveDissolve: { name: '가산 디졸브', kind: 'video', category: '디졸브' },
  blurDissolve: { name: '흐림 디졸브', kind: 'video', category: '디졸브' },
  dipToBlack: { name: '검정으로 물들이기', kind: 'video', category: '디졸브' },
  dipToWhite: { name: '흰색으로 물들이기', kind: 'video', category: '디졸브' },
  wipe: { name: '와이프', kind: 'video', category: '와이프', directional: true },
  barnDoor: { name: '반 도어 (가운데서 열기)', kind: 'video', category: '와이프' },
  clockWipe: { name: '시계 방향 와이프', kind: 'video', category: '와이프' },
  push: { name: '밀기', kind: 'video', category: '슬라이드', directional: true },
  slide: { name: '슬라이드 (덮기)', kind: 'video', category: '슬라이드', directional: true },
  whip: { name: '휙 넘기기 (위프)', kind: 'video', category: '슬라이드', directional: true },
  irisRound: { name: '원형 아이리스', kind: 'video', category: '아이리스' },
  crossZoom: { name: '교차 확대', kind: 'video', category: '확대/축소' },
  constantPower: { name: '지속 가속 (자연스러운 페이드)', kind: 'audio', category: '크로스페이드' },
  constantGain: { name: '지속 게인 (직선 페이드)', kind: 'audio', category: '크로스페이드' },
};

export const TRANSITION_DIRECTIONS = DIRECTIONS;
export const DEFAULT_VIDEO_TRANSITION = 'crossDissolve';
export const DEFAULT_AUDIO_TRANSITION = 'constantPower';

/** Fixed effects created for each clip kind, in display order. */
export function fixedEffectsFor(kind) {
  switch (kind) {
    case 'video':
    case 'nest':
      return ['motion', 'opacity', 'timeRemap'];
    case 'image':
      return ['motion', 'opacity'];
    case 'text':
      return ['text', 'motion', 'opacity'];
    case 'color':
      return ['fill', 'motion', 'opacity'];
    case 'shape':
      return ['shape', 'motion', 'opacity'];
    case 'adjustment':
      return ['opacity'];
    case 'audio':
      return ['volume', 'panner', 'timeRemap'];
    default:
      return [];
  }
}

/** Whether an effect type can be applied to a clip kind. */
export function effectFitsClip(type, clipKind) {
  const def = EFFECTS[type];
  if (!def) return false;
  if (def.kind === 'any') return true;
  return (def.kind === 'audio') === (clipKind === 'audio');
}

export function effectFamily(clipKind) {
  return clipKind === 'audio' ? 'audio' : 'video';
}
