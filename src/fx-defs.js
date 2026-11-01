// Declarative definitions of the Premiere Pro style video effects and transitions added on top of
// the original set in effects.js (which merges these tables in). Renderers live in fx-video.js
// (pixel effects), transitions2.js (transitions) and compositor.js / lumetri.js (Lumetri, keys).
//
// Param conventions: positions and pixel sizes are in SEQUENCE pixels (for a clip that fills the
// frame they are the clip's own pixels, as in Premiere); `group` names the Effect Controls
// sub-section a parameter belongs to (Premiere's "매트 생성", "기본 교정" …).

const num = (key, label, def, opts = {}) => ({ key, label, type: 'number', default: def, animatable: true, step: 1, ...opts });
const pct = (key, label, def, opts = {}) => num(key, label, def, { min: 0, max: 100, unit: '%', ...opts });
const deg = (key, label, def, opts = {}) => num(key, label, def, { unit: '°', ...opts });
const px = (key, label, def, opts = {}) => num(key, label, def, { unit: 'px', ...opts });
const color = (key, label, def, opts = {}) => ({ key, label, type: 'color', default: def, ...opts });
const bool = (key, label, def, opts = {}) => ({ key, label, type: 'bool', default: def, ...opts });
const select = (key, label, def, options, opts = {}) => ({ key, label, type: 'select', default: def, options, ...opts });
const cx = (seq) => seq.width / 2;
const cy = (seq) => seq.height / 2;
/** A point param pair (X / Y) defaulting to fractions of the frame. */
const point = (key, label, fx, fy, opts = {}) => [
  px(`${key}X`, `${label} X`, (seq) => Math.round(seq.width * fx), opts),
  px(`${key}Y`, `${label} Y`, (seq) => Math.round(seq.height * fy), opts),
];

/** Blending modes of Premiere's generate effects (원, 격자, 바둑판, 4색 그레이디언트 …). */
export const GEN_BLEND = [
  ['none', '없음'], ['normal', '표준'], ['add', '추가'], ['multiply', '곱하기'], ['screen', '스크린'],
  ['overlay', '오버레이'], ['soft-light', '소프트 라이트'], ['hard-light', '하드 라이트'], ['color-dodge', '색상 닷지'],
  ['color-burn', '색상 번'], ['darken', '어둡게 하기'], ['lighten', '밝게 하기'], ['difference', '차이'], ['hue', '색조'],
  ['saturation', '채도'], ['color', '색상'], ['luminosity', '광도'],
];

const WAVES = [['sine', '사인'], ['square', '사각형'], ['triangle', '삼각형'], ['saw', '톱니파'], ['circle', '원형'], ['semicircle', '반원'], ['uncircle', '원형 해제'], ['noise', '노이즈'], ['smooth', '매끄러운 노이즈']];
const OUTPUTS = [['composite', '합성'], ['alpha', '알파 채널'], ['color', '색상 채널']];
const BLUR_DIMS = [['both', '가로 및 세로'], ['h', '가로'], ['v', '세로']];
const WIPE_DIRS = [['cw', '시계 방향'], ['ccw', '시계 반대 방향'], ['both', '둘 다']];

export const MORE_EFFECTS = {
  // ---------------------------------------------------------------- 조정 (Adjust)
  procAmp: {
    name: 'ProcAmp', kind: 'video', category: '조정',
    params: [
      num('brightness', '밝기', 0, { min: -100, max: 100 }),
      num('contrast', '대비', 100, { min: 0, max: 200 }),
      deg('hue', '색조', 0, { min: -180, max: 180 }),
      num('saturation', '채도', 100, { min: 0, max: 300 }),
      bool('split', '분할 화면', false),
      pct('splitPct', '분할 비율', 50),
    ],
  },
  channelMixer: {
    name: '채널 혼합', kind: 'video', category: '조정',
    params: [
      num('rr', '빨강-빨강', 100, { min: -200, max: 200 }), num('rg', '빨강-녹색', 0, { min: -200, max: 200 }), num('rb', '빨강-파랑', 0, { min: -200, max: 200 }), num('rc', '빨강-상수', 0, { min: -200, max: 200 }),
      num('gr', '녹색-빨강', 0, { min: -200, max: 200 }), num('gg', '녹색-녹색', 100, { min: -200, max: 200 }), num('gb', '녹색-파랑', 0, { min: -200, max: 200 }), num('gc', '녹색-상수', 0, { min: -200, max: 200 }),
      num('br', '파랑-빨강', 0, { min: -200, max: 200 }), num('bg', '파랑-녹색', 0, { min: -200, max: 200 }), num('bb', '파랑-파랑', 100, { min: -200, max: 200 }), num('bc', '파랑-상수', 0, { min: -200, max: 200 }),
      bool('mono', '단색', false),
    ],
  },
  shadowHighlight: {
    name: '그림자/밝은 영역', kind: 'video', category: '조정',
    params: [
      pct('shadows', '어두운 영역 양', 50),
      pct('highlights', '밝은 영역 양', 0),
      pct('shadowWidth', '어두운 영역 색조 폭', 50, { group: '추가 옵션' }),
      px('shadowRadius', '어두운 영역 반경', 30, { min: 0, max: 500, group: '추가 옵션' }),
      pct('highlightWidth', '밝은 영역 색조 폭', 50, { group: '추가 옵션' }),
      px('highlightRadius', '밝은 영역 반경', 30, { min: 0, max: 500, group: '추가 옵션' }),
      num('colorCorrection', '색상 교정', 20, { min: 0, max: 100, group: '추가 옵션' }),
      num('midContrast', '미드톤 대비', 0, { min: -100, max: 100, group: '추가 옵션' }),
      pct('blend', '원본과 혼합', 0),
    ],
  },

  // ---------------------------------------------------------------- 흐림 및 선명 (Blur & Sharpen)
  directionalBlur: {
    name: '방향 흐림', kind: 'video', category: '흐림 및 선명',
    params: [deg('direction', '방향', 0), px('length', '흐림 길이', 10, { min: 0, max: 1000 })],
  },
  channelBlur: {
    name: '채널 흐림', kind: 'video', category: '흐림 및 선명',
    params: [
      px('red', '빨강 흐림 정도', 0, { min: 0, max: 500 }),
      px('green', '녹색 흐림 정도', 0, { min: 0, max: 500 }),
      px('blue', '파랑 흐림 정도', 0, { min: 0, max: 500 }),
      px('alpha', '알파 흐림 정도', 0, { min: 0, max: 500 }),
      bool('repeatEdges', '가장자리 픽셀 반복', false),
      select('dims', '흐림 차원', 'both', BLUR_DIMS),
    ],
  },
  cameraBlur: {
    name: '카메라 흐림', kind: 'video', category: '흐림 및 선명',
    params: [pct('amount', '흐림 비율', 3)],
  },
  unsharpMask: {
    name: '언샵 마스크', kind: 'video', category: '흐림 및 선명',
    params: [num('amount', '양', 50, { min: 0, max: 500, unit: '%' }), px('radius', '반경', 1, { min: 0.1, max: 100, step: 0.1 }), num('threshold', '한계값', 0, { min: 0, max: 255 })],
  },

  // ---------------------------------------------------------------- 채널 (Channel)
  // (반전 already exists as 'invert')

  // ---------------------------------------------------------------- 색상 교정 (Color Correction)
  colorBalance: {
    name: '색상 균형', kind: 'video', category: '색상 교정',
    params: [
      num('sr', '어두운 영역 빨강 균형', 0, { min: -100, max: 100, group: '어두운 영역' }), num('sg', '어두운 영역 녹색 균형', 0, { min: -100, max: 100, group: '어두운 영역' }), num('sb', '어두운 영역 파랑 균형', 0, { min: -100, max: 100, group: '어두운 영역' }),
      num('mr', '미드톤 빨강 균형', 0, { min: -100, max: 100, group: '미드톤' }), num('mg', '미드톤 녹색 균형', 0, { min: -100, max: 100, group: '미드톤' }), num('mb', '미드톤 파랑 균형', 0, { min: -100, max: 100, group: '미드톤' }),
      num('hr', '밝은 영역 빨강 균형', 0, { min: -100, max: 100, group: '밝은 영역' }), num('hg', '밝은 영역 녹색 균형', 0, { min: -100, max: 100, group: '밝은 영역' }), num('hb', '밝은 영역 파랑 균형', 0, { min: -100, max: 100, group: '밝은 영역' }),
      bool('preserveLum', '광도 유지', false),
    ],
  },
  leaveColor: {
    name: '색상 유지', kind: 'video', category: '색상 교정',
    params: [
      pct('amount', '색상 양 감소', 100),
      color('color', '유지할 색상', '#d0302a', { eyedropper: true }),
      pct('tolerance', '허용치', 15),
      pct('softness', '가장자리 부드럽게', 5),
      select('match', '일치 색상', 'rgb', [['rgb', 'RGB 사용'], ['hue', '색조 사용']]),
    ],
  },
  changeColor: {
    name: '색상 변경', kind: 'video', category: '색상 교정',
    params: [
      select('view', '보기', 'layer', [['layer', '수정된 레이어'], ['mask', '색상 수정 마스크']]),
      deg('hue', '색조 변형', 0, { min: -180, max: 180 }),
      num('lightness', '밝기 변형', 0, { min: -100, max: 100 }),
      num('saturation', '채도 변형', 0, { min: -100, max: 100 }),
      color('color', '변경할 색상', '#d0302a', { eyedropper: true }),
      pct('tolerance', '일치 허용치', 15),
      pct('softness', '일치 유연성', 0),
      select('match', '일치 색상', 'rgb', [['rgb', 'RGB 사용'], ['hue', '색조 사용'], ['chroma', '채도 사용']]),
      bool('invert', '색상 수정 마스크 반전', false),
    ],
  },
  changeToColor: {
    name: '색상 대체', kind: 'video', category: '색상 교정',
    params: [
      color('from', '시작', '#d0302a', { eyedropper: true }),
      color('to', '끝', '#2a6cd0'),
      select('change', '변경', 'hue', [['hue', '색조'], ['hueLight', '색조 및 명도'], ['hueLightSat', '색조, 명도 및 채도'], ['colorize', '색상화']]),
      pct('tolHue', '색조 허용치', 5, { group: '허용치' }),
      pct('tolLight', '명도 허용치', 50, { group: '허용치' }),
      pct('tolSat', '채도 허용치', 50, { group: '허용치' }),
      pct('softness', '부드러움', 50),
      bool('showMatte', '수정 매트 보기', false),
    ],
  },

  // ---------------------------------------------------------------- 왜곡 (Distort)
  transform: {
    name: '변형', kind: 'video', category: '왜곡', frameSpace: true,
    params: [
      px('anchorX', '기준점 X', cx), px('anchorY', '기준점 Y', cy),
      px('posX', '위치 X', cx), px('posY', '위치 Y', cy),
      bool('uniform', '균일 비율', true),
      num('scaleH', '비율 높이', 100, { min: 0, max: 10000, unit: '%', hint: '균일 비율이 켜져 있으면 가로·세로 모두 이 값' }),
      num('scaleW', '비율 폭', 100, { min: 0, max: 10000, unit: '%', hint: '균일 비율을 끄면 쓰입니다' }),
      deg('skew', '기울이기', 0, { min: -85, max: 85 }),
      deg('skewAxis', '기울이기 축', 0),
      deg('rotation', '회전', 0),
      pct('opacity', '불투명도', 100),
      bool('compShutter', '컴포지션의 셔터 각도 사용', true, { hint: '끄고 셔터 각도를 높이면 움직임에 모션 블러가 생깁니다' }),
      deg('shutter', '셔터 각도', 0, { min: 0, max: 720 }),
    ],
  },
  cornerPin: {
    name: '모서리 고정', kind: 'video', category: '왜곡', frameSpace: true,
    params: [
      ...point('ul', '왼쪽 위', 0, 0), ...point('ur', '오른쪽 위', 1, 0),
      ...point('ll', '왼쪽 아래', 0, 1), ...point('lr', '오른쪽 아래', 1, 1),
    ],
  },
  lensDistortion: {
    name: '렌즈 왜곡', kind: 'video', category: '왜곡',
    params: [
      num('curvature', '곡률', 0, { min: -100, max: 100 }),
      num('vDecenter', '세로 편심', 0, { min: -100, max: 100 }),
      num('hDecenter', '가로 편심', 0, { min: -100, max: 100 }),
      num('vPrism', '세로 프리즘 FX', 0, { min: -100, max: 100 }),
      num('hPrism', '가로 프리즘 FX', 0, { min: -100, max: 100 }),
      bool('fillAlpha', '채우기 알파', true),
      color('fillColor', '채우기 색상', '#000000'),
    ],
  },
  mirror: {
    name: '미러', kind: 'video', category: '왜곡', frameSpace: true,
    params: [px('centerX', '반사 중심 X', cx), px('centerY', '반사 중심 Y', cy), deg('angle', '반사 각도', 0)],
  },
  offset: {
    name: '오프셋', kind: 'video', category: '왜곡',
    params: [px('shiftX', '중심 이동 X', cx), px('shiftY', '중심 이동 Y', cy), pct('blend', '원본과 혼합', 0)],
  },
  twirl: {
    name: '돌리기', kind: 'video', category: '왜곡', frameSpace: true,
    params: [deg('angle', '각도', 50), num('radius', '돌리기 반경', 50, { min: 0, max: 100 }), px('centerX', '돌리기 중심 X', cx), px('centerY', '돌리기 중심 Y', cy)],
  },
  waveWarp: {
    name: '파형 비틀기', kind: 'video', category: '왜곡', frameSpace: true,
    params: [
      select('wave', '파형 유형', 'sine', WAVES),
      px('height', '파형 높이', 10, { min: -1000, max: 1000 }),
      px('width', '파형 폭', 40, { min: 1, max: 2000 }),
      deg('direction', '방향', 90),
      num('speed', '파형 속도', 1, { min: -50, max: 50, step: 0.1, hint: '초당 파형 수' }),
      select('pinning', '고정', 'none', [['none', '없음'], ['all', '모든 가장자리'], ['center', '가운데']]),
      deg('phase', '위상', 0),
    ],
  },
  spherize: {
    name: '구형화', kind: 'video', category: '왜곡', frameSpace: true,
    params: [px('radius', '반경', 300, { min: 0, max: 5000 }), px('centerX', '구의 중심 X', cx), px('centerY', '구의 중심 Y', cy)],
  },
  turbulentDisplace: {
    name: '난기류 변위', kind: 'video', category: '왜곡', frameSpace: true,
    params: [
      select('mode', '변위', 'turbulent', [['turbulent', '난기류'], ['bulge', '돌출'], ['twist', '비틀기'], ['horizontal', '수평 난기류'], ['vertical', '수직 난기류'], ['cross', '교차 난기류']]),
      num('amount', '양', 50, { min: -1000, max: 1000 }),
      num('size', '크기', 100, { min: 2, max: 1000 }),
      px('offsetX', '오프셋 (난기류) X', cx), px('offsetY', '오프셋 (난기류) Y', cy),
      num('complexity', '복잡도', 1, { min: 1, max: 10, step: 0.1 }),
      deg('evolution', '진화', 0, { hint: '키프레임을 주면 물결이 움직입니다' }),
      select('pinning', '고정', 'all', [['none', '없음'], ['all', '모두 고정']]),
    ],
  },

  // ---------------------------------------------------------------- 생성 (Generate)
  fourColorGradient: {
    name: '4색 그레이디언트', kind: 'video', category: '생성', frameSpace: true,
    params: [
      ...point('p1', '점 1', 0.1, 0.1, { group: '위치 및 색상' }), color('c1', '색상 1', '#ffff00', { group: '위치 및 색상' }),
      ...point('p2', '점 2', 0.9, 0.1, { group: '위치 및 색상' }), color('c2', '색상 2', '#00ff00', { group: '위치 및 색상' }),
      ...point('p3', '점 3', 0.1, 0.9, { group: '위치 및 색상' }), color('c3', '색상 3', '#ff00ff', { group: '위치 및 색상' }),
      ...point('p4', '점 4', 0.9, 0.9, { group: '위치 및 색상' }), color('c4', '색상 4', '#0000ff', { group: '위치 및 색상' }),
      num('blend', '혼합', 100, { min: 1, max: 1000 }),
      pct('jitter', '지터', 0),
      pct('opacity', '불투명도', 100),
      select('mode', '혼합 모드', 'none', GEN_BLEND),
    ],
  },
  ramp: {
    name: '램프', kind: 'video', category: '생성', frameSpace: true,
    params: [
      ...point('start', '램프 시작', 0.5, 0), color('startColor', '시작 색상', '#000000'),
      ...point('end', '램프 끝', 0.5, 1), color('endColor', '끝 색상', '#ffffff'),
      select('shape', '램프 모양', 'linear', [['linear', '선형 램프'], ['radial', '방사형 램프']]),
      num('scatter', '램프 분산', 0, { min: 0, max: 100 }),
      pct('blend', '원본과 혼합', 0),
    ],
  },
  lensFlare: {
    name: '렌즈 플레어', kind: 'video', category: '생성', frameSpace: true,
    params: [
      ...point('center', '플레어 중심', 0.3, 0.3),
      num('brightness', '플레어 밝기', 100, { min: 0, max: 300, unit: '%' }),
      select('lens', '렌즈 유형', 'zoom', [['zoom', '50-300mm 확대/축소'], ['prime35', '35mm 프라임'], ['prime105', '105mm 프라임']]),
      pct('blend', '원본과 혼합', 0),
    ],
  },
  checkerboard: {
    name: '바둑판', kind: 'video', category: '생성', frameSpace: true,
    params: [
      ...point('anchor', '고정점', 0.5, 0.5),
      px('width', '폭', 64, { min: 1, max: 4000 }),
      px('height', '높이', 64, { min: 1, max: 4000, hint: '0이면 폭과 같은 정사각형' }),
      px('feather', '페더', 0, { min: 0, max: 200 }),
      color('color', '색상', '#ffffff'),
      pct('opacity', '불투명도', 100),
      select('mode', '혼합 모드', 'none', GEN_BLEND),
    ],
  },
  circle: {
    name: '원', kind: 'video', category: '생성', frameSpace: true,
    params: [
      ...point('center', '중심', 0.5, 0.5),
      px('radius', '반경', 150, { min: 0, max: 8000 }),
      select('edge', '가장자리', 'none', [['none', '없음'], ['thickness', '두께'], ['edgeRadius', '가장자리 반경']]),
      px('thickness', '두께', 20, { min: 0, max: 4000 }),
      px('featherOuter', '바깥쪽 가장자리 페더', 0, { min: 0, max: 1000, group: '페더' }),
      px('featherInner', '안쪽 가장자리 페더', 0, { min: 0, max: 1000, group: '페더' }),
      bool('invert', '원 반전', false),
      color('color', '색상', '#ffffff'),
      pct('opacity', '불투명도', 100),
      select('mode', '혼합 모드', 'none', GEN_BLEND),
    ],
  },
  grid: {
    name: '격자', kind: 'video', category: '생성', frameSpace: true,
    params: [
      ...point('anchor', '고정점', 0.5, 0.5),
      px('width', '폭', 120, { min: 2, max: 4000 }),
      px('height', '높이', 120, { min: 2, max: 4000 }),
      px('border', '테두리', 3, { min: 0, max: 500 }),
      px('feather', '페더', 0, { min: 0, max: 200 }),
      bool('invert', '격자 반전', false),
      color('color', '색상', '#ffffff'),
      pct('opacity', '불투명도', 100),
      select('mode', '혼합 모드', 'normal', GEN_BLEND),
    ],
  },
  filmBurn: {
    name: '필름 번 (빛 번짐)', kind: 'video', category: '생성', frameSpace: true,
    params: [
      pct('amount', '양', 70),
      num('speed', '속도', 1, { min: 0, max: 10, step: 0.1 }),
      num('scale', '크기', 100, { min: 10, max: 400, unit: '%' }),
      color('color1', '색상 1', '#ff5a1f'),
      color('color2', '색상 2', '#ffd56b'),
      num('seed', '변형', 1, { min: 0, max: 100 }),
      select('mode', '혼합 모드', 'screen', [['screen', '스크린'], ['add', '추가'], ['overlay', '오버레이'], ['normal', '표준']]),
    ],
  },

  // ---------------------------------------------------------------- 키잉 (Keying)
  ultraKey: {
    name: '울트라 키', kind: 'video', category: '키잉',
    params: [
      select('output', '출력', 'composite', OUTPUTS, { hint: '알파 채널로 매트(흰색 = 보임)를 확인할 수 있습니다' }),
      select('setting', '설정', 'default', [['default', '기본값'], ['relaxed', '완화'], ['aggressive', '강함'], ['custom', '사용자 정의']]),
      color('keyColor', '키 색상', '#00b140', { eyedropper: true, hint: '색상 상자의 스포이드로 배경색을 찍으세요' }),
      pct('transparency', '투명도', 45, { group: '매트 생성' }),
      pct('highlight', '밝은 영역', 10, { group: '매트 생성' }),
      pct('shadow', '어두운 영역', 50, { group: '매트 생성' }),
      pct('tolerance', '허용치', 50, { group: '매트 생성' }),
      pct('pedestal', '받침대', 10, { group: '매트 생성' }),
      pct('choke', '경계 감소', 0, { group: '매트 정리' }),
      pct('soften', '부드럽게', 0, { group: '매트 정리' }),
      pct('contrast', '대비', 0, { group: '매트 정리' }),
      pct('midpoint', '중간점', 50, { group: '매트 정리' }),
      pct('desaturate', '채도 감소', 25, { group: '스필 억제' }),
      pct('range', '범위', 50, { group: '스필 억제' }),
      pct('spill', '스필', 50, { group: '스필 억제' }),
      pct('luma', '루마', 50, { group: '스필 억제' }),
      num('ccSat', '채도', 100, { min: 0, max: 200, group: '색상 교정' }),
      deg('ccHue', '색조', 0, { min: -180, max: 180, group: '색상 교정' }),
      num('ccLum', '광도', 100, { min: 0, max: 200, group: '색상 교정' }),
    ],
  },
  lumaKey: {
    name: '루마 키', kind: 'video', category: '키잉',
    params: [
      select('mode', '키 유형', 'darker', [['darker', '어두운 영역 제거'], ['brighter', '밝은 영역 제거']]),
      pct('threshold', '한계값', 25),
      pct('cutoff', '컷오프', 10, { hint: '경계를 부드럽게 하는 폭' }),
      bool('invert', '반전', false),
      select('output', '출력', 'composite', OUTPUTS.slice(0, 2)),
    ],
  },
  alphaAdjust: {
    name: '알파 조정', kind: 'video', category: '키잉',
    params: [pct('opacity', '불투명도', 100), bool('ignore', '알파 무시', false), bool('invert', '알파 반전', false), bool('maskOnly', '마스크만', false)],
  },

  // ---------------------------------------------------------------- 노이즈 및 그레인 (Noise & Grain)
  noise: {
    name: '노이즈', kind: 'video', category: '노이즈 및 그레인',
    params: [pct('amount', '노이즈 양', 20), bool('colorNoise', '색상 노이즈 사용', true), bool('clip', '결과 값 클리핑', true)],
  },

  // ---------------------------------------------------------------- 원근 (Perspective)
  basic3d: {
    name: '기본 3D', kind: 'video', category: '원근', frameSpace: true,
    params: [
      deg('swivel', '회전', 0, { hint: '세로축을 중심으로 돌립니다' }),
      deg('tilt', '기울기', 0, { hint: '가로축을 중심으로 젖힙니다' }),
      num('distance', '이미지까지 거리', 0, { min: -99, max: 1000 }),
      bool('specular', '반사 강조', false),
    ],
  },

  // ---------------------------------------------------------------- 스타일화 (Stylize)
  replicate: {
    name: '복제', kind: 'video', category: '스타일화',
    params: [num('count', '개수', 2, { min: 1, max: 16 })],
  },
  strobeLight: {
    name: '스트로브 라이트', kind: 'video', category: '스타일화',
    params: [
      color('color', '스트로브 색상', '#ffffff'),
      pct('blend', '원본과 혼합', 0),
      num('duration', '스트로브 지속 시간(초)', 0.05, { min: 0, max: 10, step: 0.01, unit: '초' }),
      num('period', '스트로브 기간(초)', 0.5, { min: 0.02, max: 30, step: 0.01, unit: '초' }),
      pct('random', '임의 스트로브 확률', 0),
      select('strobe', '스트로브', 'color', [['color', '색상에서만 작동'], ['transparent', '레이어 투명하게 만들기']]),
      select('op', '스트로브 연산자', 'copy', [['copy', '복사'], ['add', '추가'], ['subtract', '빼기'], ['multiply', '곱하기'], ['difference', '차이'], ['screen', '스크린'], ['lighten', '밝게'], ['darken', '어둡게']]),
    ],
  },
  rgbSplit: {
    name: 'RGB 분리 (색수차)', kind: 'video', category: '스타일화',
    params: [
      px('amount', '분리 양', 12, { min: 0, max: 500 }),
      deg('angle', '각도', 0),
      bool('radial', '가장자리로 갈수록 크게', false),
      num('jitter', '흔들림', 0, { min: 0, max: 100, hint: '0보다 크면 분리 양이 무작위로 떨립니다' }),
    ],
  },
  glitch: {
    name: '글리치', kind: 'video', category: '스타일화',
    params: [
      pct('amount', '양', 50),
      px('block', '블록 크기', 48, { min: 4, max: 1000 }),
      num('speed', '속도', 12, { min: 0, max: 60, unit: 'Hz', step: 0.5 }),
      px('split', 'RGB 분리', 14, { min: 0, max: 400 }),
      bool('scanlines', '스캔라인', true),
      num('seed', '변형', 1, { min: 0, max: 100 }),
    ],
  },
  vhs: {
    name: 'VHS', kind: 'video', category: '스타일화',
    params: [
      pct('amount', '양', 70),
      px('bleed', '색 번짐', 6, { min: 0, max: 60 }),
      pct('noise', '노이즈', 30),
      pct('tracking', '트래킹 흔들림', 40),
      pct('scanlines', '스캔라인', 35),
      pct('fade', '색 바램', 25),
    ],
  },

  // ---------------------------------------------------------------- 시간 (Time)
  echo: {
    name: '반향', kind: 'video', category: '시간',
    params: [
      num('time', '반향 시간(초)', -0.033, { min: -5, max: 0, step: 0.001, unit: '초', hint: '음수: 지난 프레임을 겹칩니다 (재생·내보내기 중에 보입니다)' }),
      num('count', '반향 수', 1, { min: 0, max: 20 }),
      num('start', '시작 강도', 1, { min: 0, max: 1, step: 0.01 }),
      num('decay', '감쇠', 1, { min: 0, max: 1, step: 0.01 }),
      select('op', '반향 연산자', 'add', [['add', '추가'], ['max', '최대'], ['min', '최소'], ['screen', '스크린'], ['composite-back', '뒤에 합성'], ['composite-front', '앞에 합성'], ['blend', '혼합']]),
    ],
  },
  posterizeTime: {
    name: '포스터화 시간', kind: 'video', category: '시간',
    params: [num('fps', '프레임 속도', 12, { min: 1, max: 99, unit: 'fps' })],
  },

  // ---------------------------------------------------------------- 변형 (Transform)
  edgeFeather: {
    name: '가장자리 페더', kind: 'video', category: '변형',
    params: [px('amount', '양', 30, { min: 0, max: 1000 })],
  },

  // ---------------------------------------------------------------- 전환 (Transition effects)
  linearWipe: {
    name: '선형 지우기', kind: 'video', category: '전환', frameSpace: true,
    params: [pct('completion', '변환 완료', 0), deg('angle', '지우기 각도', 90), px('feather', '페더', 0, { min: 0, max: 2000 })],
  },
  radialWipe: {
    name: '방사형 지우기', kind: 'video', category: '전환', frameSpace: true,
    params: [pct('completion', '변환 완료', 0), deg('start', '시작 각도', 0), px('centerX', '지우기 중심 X', cx), px('centerY', '지우기 중심 Y', cy), select('wipe', '지우기', 'cw', WIPE_DIRS), px('feather', '페더', 0, { min: 0, max: 2000 })],
  },
  gradientWipe: {
    name: '그레이디언트 지우기', kind: 'video', category: '전환', frameSpace: true,
    params: [
      pct('completion', '변환 완료', 0),
      pct('softness', '변환 부드러움', 10),
      select('layer', '그레이디언트 레이어', '', 'gradientLayers'),
      select('placement', '그레이디언트 배치', 'stretch', [['stretch', '맞게 늘이기'], ['center', '중앙에 배치'], ['tile', '타일']]),
      bool('invert', '그레이디언트 반전', false),
    ],
  },
  venetianBlinds: {
    name: '베니션 블라인드', kind: 'video', category: '전환', frameSpace: true,
    params: [pct('completion', '변환 완료', 0), deg('direction', '방향', 0), px('width', '폭', 60, { min: 2, max: 2000 }), px('feather', '페더', 0, { min: 0, max: 500 })],
  },
};

/**
 * Lumetri 색상 parameters (replacing the older curve/wheel grade; old keys are kept so saved
 * projects and one-tap filters keep working). Sections follow Premiere's Lumetri panel.
 */
const WHEEL0 = () => ({ x: 0, y: 0 });
const FLAT = () => [[0, 0.5], [1, 0.5]];
export const LUMETRI_PARAMS = [
  // 기본 교정
  select('inputLut', '입력 LUT', '', 'luts', { group: '기본 교정', hint: '.cube 파일을 가져오기 하면 목록에 나타납니다' }),
  color('wbColor', '흰색 균형 선택기', '#ffffff', { group: '기본 교정', eyedropper: true, hint: '스포이드로 흰색이나 회색이어야 할 곳을 찍으면 그 색이 중립이 되도록 맞춥니다' }),
  num('temperature', '온도', 0, { min: -100, max: 100, group: '기본 교정' }),
  num('tint', '색조', 0, { min: -100, max: 100, group: '기본 교정' }),
  num('exposure', '노출', 0, { min: -5, max: 5, step: 0.05, unit: '스톱', group: '기본 교정' }),
  num('contrast', '대비', 0, { min: -100, max: 100, group: '기본 교정' }),
  num('highlights', '밝은 영역', 0, { min: -100, max: 100, group: '기본 교정' }),
  num('shadows', '어두운 영역', 0, { min: -100, max: 100, group: '기본 교정' }),
  num('whites', '흰색 계열', 0, { min: -100, max: 100, group: '기본 교정' }),
  num('blacks', '검정 계열', 0, { min: -100, max: 100, group: '기본 교정' }),
  // 재설정 / 자동 buttons (src/ui/effect-controls.js, action 'lumetriTone')
  { key: 'toneAuto', label: '톤', type: 'action', action: 'lumetriTone', default: null, animatable: false, group: '기본 교정' },
  num('saturation', '채도', 100, { min: 0, max: 200, unit: '%', group: '기본 교정' }),
  // 크리에이티브
  select('look', 'Look', '', 'looks', { group: '크리에이티브' }),
  num('lookIntensity', '강도', 100, { min: 0, max: 200, unit: '%', group: '크리에이티브' }),
  // Premiere's Korean names: 크리에이티브 ▸ 조정
  num('fadedFilm', '빛바랜 필름', 0, { min: 0, max: 100, group: '크리에이티브' }),
  num('sharpen', '선명', 0, { min: -100, max: 100, group: '크리에이티브' }),
  num('vibrance', '생동감', 0, { min: -100, max: 100, group: '크리에이티브' }),
  num('creativeSat', '채도', 100, { min: 0, max: 200, unit: '%', group: '크리에이티브' }),
  { key: 'shadowTint', label: '어두운 영역 색조', type: 'wheel', default: WHEEL0(), group: '크리에이티브' },
  { key: 'highlightTint', label: '강조 표시 색조', type: 'wheel', default: WHEEL0(), group: '크리에이티브' },
  num('tintBalance', '색조 균형', 0, { min: -100, max: 100, group: '크리에이티브' }),
  // 곡선
  { key: 'curves', label: 'RGB 곡선', type: 'curves', default: { master: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] }, group: '곡선' },
  {
    key: 'hueCurves', label: '색조 채도 곡선', type: 'hueCurves', group: '곡선',
    default: { hueSat: FLAT(), hueHue: FLAT(), hueLuma: FLAT(), lumaSat: FLAT(), satSat: FLAT() },
    hint: '색조 대 채도 · 색조 대 색조 · 색조 대 광도 · 광도 대 채도 · 채도 대 채도 (가운데 선 = 변화 없음)',
  },
  // 색상 휠 및 일치
  { key: 'shadowsWheel', label: '어두운 영역', type: 'wheel', default: WHEEL0(), group: '색상 휠 및 일치' },
  num('shadowsLevel', '어두운 영역 밝기', 0, { min: -100, max: 100, group: '색상 휠 및 일치' }),
  { key: 'midsWheel', label: '미드톤', type: 'wheel', default: WHEEL0(), group: '색상 휠 및 일치' },
  num('midsLevel', '미드톤 밝기', 0, { min: -100, max: 100, group: '색상 휠 및 일치' }),
  { key: 'highlightsWheel', label: '밝은 영역', type: 'wheel', default: WHEEL0(), group: '색상 휠 및 일치' },
  num('highlightsLevel', '밝은 영역 밝기', 0, { min: -100, max: 100, group: '색상 휠 및 일치' }),
  // HSL 보조
  bool('hslOn', 'HSL 보조 사용', false, { group: 'HSL 보조' }),
  color('hslColor', '키 색상', '#d08060', { group: 'HSL 보조', eyedropper: true, hint: '바꾸고 싶은 색을 스포이드로 찍으세요 (예: 피부색)' }),
  num('hslHue', '색조 범위', 30, { min: 0, max: 180, unit: '°', group: 'HSL 보조' }),
  num('hslSat', '채도 범위', 60, { min: 0, max: 100, unit: '%', group: 'HSL 보조' }),
  num('hslLum', '광도 범위', 60, { min: 0, max: 100, unit: '%', group: 'HSL 보조' }),
  num('hslSoft', '부드럽게', 40, { min: 0, max: 100, group: 'HSL 보조' }),
  num('hslDenoise', '노이즈 제거', 10, { min: 0, max: 100, group: 'HSL 보조' }),
  num('hslBlur', '흐림', 0, { min: 0, max: 100, group: 'HSL 보조' }),
  bool('hslShow', '마스크 보기', false, { group: 'HSL 보조' }),
  bool('hslInvert', '마스크 반전', false, { group: 'HSL 보조' }),
  { key: 'hslWheel', label: '교정 색상 휠', type: 'wheel', default: WHEEL0(), group: 'HSL 보조' },
  num('hslTemp', '온도 (교정)', 0, { min: -100, max: 100, group: 'HSL 보조' }),
  num('hslTint', '색조 (교정)', 0, { min: -100, max: 100, group: 'HSL 보조' }),
  num('hslContrast', '대비 (교정)', 0, { min: -100, max: 100, group: 'HSL 보조' }),
  num('hslSharpen', '선명 (교정)', 0, { min: -100, max: 100, group: 'HSL 보조' }),
  num('hslSaturation', '채도 (교정)', 100, { min: 0, max: 200, unit: '%', group: 'HSL 보조' }),
  // 비네팅
  num('vigAmount', '양', 0, { min: -5, max: 5, step: 0.1, group: '비네팅' }),
  num('vigMid', '중간점', 50, { min: 0, max: 100, group: '비네팅' }),
  num('vigRound', '원형률', 0, { min: -100, max: 100, group: '비네팅' }),
  num('vigFeather', '페더', 50, { min: 0, max: 100, group: '비네팅' }),
];

export const MORE_TRANSITIONS = {
  // 3D 동작
  cubeSpin: { name: '큐브 회전', kind: 'video', category: '3D 동작', directional: true },
  flipOver: { name: '뒤집기', kind: 'video', category: '3D 동작', directional: true },
  // 디졸브
  filmDissolve: { name: '필름 디졸브', kind: 'video', category: '디졸브' },
  nonAdditiveDissolve: { name: '비가산 디졸브', kind: 'video', category: '디졸브' },
  // 조리개
  irisBox: { name: '조리개 상자', kind: 'video', category: '조리개' },
  irisCross: { name: '조리개 십자형', kind: 'video', category: '조리개' },
  irisDiamond: { name: '조리개 다이아몬드', kind: 'video', category: '조리개' },
  // 페이지 벗기기
  pageTurn: { name: '페이지 넘기기', kind: 'video', category: '페이지 벗기기', directional: true },
  pagePeel: { name: '페이지 벗기기', kind: 'video', category: '페이지 벗기기', directional: true },
  // 슬라이드
  centerSplit: { name: '가운데 분할', kind: 'video', category: '슬라이드' },
  split: { name: '분할', kind: 'video', category: '슬라이드', directional: true },
  bandSlide: { name: '띠 슬라이드', kind: 'video', category: '슬라이드', directional: true },
  // 지우기
  bandWipe: { name: '띠 지우기', kind: 'video', category: '지우기', directional: true },
  checkerWipe: { name: '바둑판 지우기', kind: 'video', category: '지우기', directional: true },
  gradientWipeTr: { name: '그레이디언트 지우기', kind: 'video', category: '지우기', directional: true },
  inset: { name: '삽입', kind: 'video', category: '지우기', directional: true },
  pinwheel: { name: '바람개비', kind: 'video', category: '지우기' },
  radialWipeTr: { name: '방사형 지우기', kind: 'video', category: '지우기' },
  randomBlocks: { name: '임의 블록', kind: 'video', category: '지우기' },
  randomWipe: { name: '임의 지우기', kind: 'video', category: '지우기', directional: true },
  venetianBlindsTr: { name: '베니션 블라인드', kind: 'video', category: '지우기', directional: true },
  zigZagBlocks: { name: '지그재그 블록', kind: 'video', category: '지우기' },
  // 확대/축소 and popular tutorial transitions
  zoomIn: { name: '줌 인', kind: 'video', category: '확대/축소' },
  zoomOut: { name: '줌 아웃', kind: 'video', category: '확대/축소' },
  spin: { name: '회전 (스핀)', kind: 'video', category: '확대/축소', directional: true },
  glitchTr: { name: '글리치', kind: 'video', category: '스타일' },
  lightLeak: { name: '빛 번짐', kind: 'video', category: '스타일' },
  shake: { name: '흔들기', kind: 'video', category: '스타일' },
};
