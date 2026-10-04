// Keyframe easing curves. Each maps progress u ∈ [0, 1] between two keyframes to an output
// fraction (back / elastic may go slightly below 0 or above 1 — that is the overshoot).
// Formulas follow Robert Penner's easing equations (as listed on easings.net).

const PI = Math.PI;
const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;
const C4 = (2 * PI) / 3;
const C5 = (2 * PI) / 4.5;

function bounceOut(x) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

const pow = (k) => ({
  in: (x) => x ** k,
  out: (x) => 1 - (1 - x) ** k,
  inOut: (x) => (x < 0.5 ? 2 ** (k - 1) * x ** k : 1 - (-2 * x + 2) ** k / 2),
});

/** Easing families: id, Korean name, short description, in / out / in-out curves. */
export const EASE_FAMILIES = [
  { id: 'Sine', name: '사인', desc: '가장 부드럽고 은은함', in: (x) => 1 - Math.cos((x * PI) / 2), out: (x) => Math.sin((x * PI) / 2), inOut: (x) => -(Math.cos(PI * x) - 1) / 2 },
  { id: 'Quad', name: '2차 (Quad)', desc: '자연스러운 가감속', ...pow(2) },
  { id: 'Cubic', name: '3차 (Cubic)', desc: '조금 더 또렷한 가감속', ...pow(3) },
  { id: 'Quart', name: '4차 (Quart)', desc: '힘 있게 출발·정지', ...pow(4) },
  { id: 'Quint', name: '5차 (Quint)', desc: '아주 힘 있게 출발·정지', ...pow(5) },
  {
    id: 'Expo', name: '지수 (Expo)', desc: '순간적으로 확 빨라지거나 멈춤',
    in: (x) => (x === 0 ? 0 : 2 ** (10 * x - 10)),
    out: (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
    inOut: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2),
  },
  {
    id: 'Circ', name: '원형 (Circ)', desc: '끝에서 급하게 꺾임',
    in: (x) => 1 - Math.sqrt(1 - x * x),
    out: (x) => Math.sqrt(1 - (x - 1) ** 2),
    inOut: (x) => (x < 0.5 ? (1 - Math.sqrt(1 - (2 * x) ** 2)) / 2 : (Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2),
  },
  {
    id: 'Back', name: '백 (Back)', desc: '살짝 넘쳤다가 제자리로',
    in: (x) => C3 * x * x * x - C1 * x * x,
    out: (x) => 1 + C3 * (x - 1) ** 3 + C1 * (x - 1) ** 2,
    inOut: (x) => (x < 0.5 ? ((2 * x) ** 2 * ((C2 + 1) * 2 * x - C2)) / 2 : ((2 * x - 2) ** 2 * ((C2 + 1) * (x * 2 - 2) + C2) + 2) / 2),
  },
  {
    id: 'Elastic', name: '엘라스틱 (Elastic)', desc: '고무줄처럼 출렁임',
    in: (x) => (x === 0 ? 0 : x === 1 ? 1 : -(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * C4)),
    out: (x) => (x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * C4) + 1),
    inOut: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5
      ? -(2 ** (20 * x - 10) * Math.sin((20 * x - 11.125) * C5)) / 2
      : (2 ** (-20 * x + 10) * Math.sin((20 * x - 11.125) * C5)) / 2 + 1),
  },
  {
    id: 'Bounce', name: '바운스 (Bounce)', desc: '공처럼 통통 튐',
    in: (x) => 1 - bounceOut(1 - x),
    out: bounceOut,
    inOut: (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
  },
];

export const EASE_VARIANTS = [
  ['out', 'Out', '끝 부분에 적용 (대부분 자연스러움)'],
  ['in', 'In', '시작 부분에 적용'],
  ['inOut', 'In-Out', '시작과 끝 모두'],
];

const FN = {
  linear: (x) => x,
  ease: (x) => x * x * (3 - 2 * x), // the original "부드럽게" curve (smoothstep)
};
const NAMES = { linear: '직선', ease: '부드럽게', hold: '정지' };
for (const f of EASE_FAMILIES) {
  for (const [v, label] of EASE_VARIANTS) {
    const id = `${v}${f.id}`;
    FN[id] = f[v];
    NAMES[id] = `${f.name.split(' ')[0]} ${label}`;
  }
}

/** Easing function for an id ('linear', 'ease', 'outBack', 'inOutSine', …). Unknown ids are linear. */
export function easeFn(id) {
  return FN[id] || FN.linear;
}

export function easeName(id) {
  return NAMES[id || 'linear'] || NAMES.linear;
}

export function isEaseId(id) {
  return id === 'hold' || !!FN[id];
}

/** True for curves whose speed changes a lot within a segment (needs finer numeric integration). */
export function easeIsWiggly(id) {
  return /Elastic|Bounce|Back|Expo/.test(id || '');
}

/**
 * SVG path data drawing the curve in a 30×20 box: value 0 at y=17, value 1 at y=3, time from
 * x=3 to x=27 (overshoot is drawn outside that band). Used for previews in menus.
 */
export function easePath(id) {
  if (id === 'hold') return 'M3 17H27V3';
  const f = easeFn(id);
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const x = i / 48;
    pts.push(`${(3 + x * 24).toFixed(2)} ${(17 - f(x) * 14).toFixed(2)}`);
  }
  return `M${pts.join('L')}`;
}
