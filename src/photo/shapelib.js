// The custom shape library (Photoshop's "사용자 정의 모양" sets), in groups. Each shape is SVG path data
// in a 100×100 box using absolute M L H V C Q A Z only (paths.js parses it into editable knots), and an
// optional ops string: one letter per subpath, c = combine (default), s = subtract (a hole).

const f = (n) => Math.round(n * 100) / 100;
const poly = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z`;
/** A circle as two arcs (ccw: the other way round, for holes drawn with the non-zero rule). */
const circle = (cx, cy, r, ccw = false) => `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 ${ccw ? 0 : 1} ${f(cx + r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 ${ccw ? 0 : 1} ${f(cx - r)} ${f(cy)} Z`;
const ellipse = (cx, cy, rx, ry, ccw = false) => `M${f(cx - rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 ${ccw ? 0 : 1} ${f(cx + rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 ${ccw ? 0 : 1} ${f(cx - rx)} ${f(cy)} Z`;
const rect = (x, y, w, h, ccw = false) => (ccw ? poly([[x, y], [x, y + h], [x + w, y + h], [x + w, y]]) : poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]));
function roundRect(x, y, w, h, r, ccw = false) {
  const p = [
    `M${f(x + r)} ${f(y)}`, `H${f(x + w - r)}`, `A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)}`, `V${f(y + h - r)}`, `A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)}`,
    `H${f(x + r)}`, `A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)}`, `V${f(y + r)}`, `A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)}`, 'Z',
  ].join(' ');
  if (!ccw) return p;
  return [
    `M${f(x + r)} ${f(y)}`, `A${r} ${r} 0 0 0 ${f(x)} ${f(y + r)}`, `V${f(y + h - r)}`, `A${r} ${r} 0 0 0 ${f(x + r)} ${f(y + h)}`, `H${f(x + w - r)}`,
    `A${r} ${r} 0 0 0 ${f(x + w)} ${f(y + h - r)}`, `V${f(y + r)}`, `A${r} ${r} 0 0 0 ${f(x + w - r)} ${f(y)}`, 'Z',
  ].join(' ');
}
const starPts = (cx, cy, R, r, n, rot = -90) => Array.from({ length: n * 2 }, (_, i) => {
  const a = ((rot + (i * 180) / n) * Math.PI) / 180;
  const k = i % 2 ? r : R;
  return [cx + Math.cos(a) * k, cy + Math.sin(a) * k];
});
const ngonPts = (cx, cy, R, n, rot = -90) => Array.from({ length: n }, (_, i) => {
  const a = ((rot + (i * 360) / n) * Math.PI) / 180;
  return [cx + Math.cos(a) * R, cy + Math.sin(a) * R];
});
const star = (...a) => poly(starPts(...a));
const ngon = (...a) => poly(ngonPts(...a));
/** A circle with round bumps round its edge (scalloped). */
function scallop(cx, cy, R, bumps, depth) {
  let d = '';
  for (let i = 0; i < bumps; i++) {
    const a0 = (i * 2 * Math.PI) / bumps - Math.PI / 2;
    const a1 = ((i + 1) * 2 * Math.PI) / bumps - Math.PI / 2;
    const am = (a0 + a1) / 2;
    const p0 = [cx + Math.cos(a0) * R, cy + Math.sin(a0) * R];
    const p1 = [cx + Math.cos(a1) * R, cy + Math.sin(a1) * R];
    const c = [cx + Math.cos(am) * (R + depth * 2), cy + Math.sin(am) * (R + depth * 2)];
    d += `${i ? '' : `M${f(p0[0])} ${f(p0[1])} `}Q${f(c[0])} ${f(c[1])} ${f(p1[0])} ${f(p1[1])} `;
  }
  return `${d}Z`;
}
function gear(cx, cy, R, r, teeth) {
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i * 2 * Math.PI) / teeth;
    const w = Math.PI / teeth;
    for (const [da, k] of [[-w * 0.55, r], [-w * 0.35, R], [w * 0.35, R], [w * 0.55, r]]) pts.push([cx + Math.cos(a + da) * k, cy + Math.sin(a + da) * k]);
  }
  return poly(pts);
}
function sun() {
  const parts = [circle(50, 50, 21)];
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    const tip = [50 + Math.cos(a) * 48, 50 + Math.sin(a) * 48];
    const b1 = [50 + Math.cos(a - 0.13) * 27, 50 + Math.sin(a - 0.13) * 27];
    const b2 = [50 + Math.cos(a + 0.13) * 27, 50 + Math.sin(a + 0.13) * 27];
    parts.push(poly([b1, tip, b2]));
  }
  return parts.join(' ');
}
function flower() {
  // petals round a centre disc; the hole sits inside the disc only (so it stays round)
  const parts = [circle(50, 50, 17)];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 - Math.PI / 2;
    parts.push(circle(50 + Math.cos(a) * 29, 50 + Math.sin(a) * 29, 19));
  }
  parts.push(circle(50, 50, 7, true));
  return parts.join(' ');
}
function snowflake() {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const P = (x, y) => [50 + x * c - y * s, 50 + x * s + y * c];
    parts.push(poly([P(0, -3.5), P(46, -3.5), P(46, 3.5), P(0, 3.5)]));
    parts.push(poly([P(26, -2.5), P(36, -14), P(40, -11), P(31, 0), P(40, 11), P(36, 14), P(26, 2.5)]));
  }
  return parts.join(' ');
}

const G = (name, items) => ({ name, items });
export const SHAPE_LIB = [
  G('화살표', [
    ['arrowRight', '화살표 →', 'M4 36 H60 V14 L96 50 L60 86 V64 H4 Z'],
    ['arrowLeft', '화살표 ←', 'M96 36 H40 V14 L4 50 L40 86 V64 H96 Z'],
    ['arrowUp', '화살표 ↑', 'M36 96 V40 H14 L50 4 L86 40 H64 V96 Z'],
    ['arrowDown', '화살표 ↓', 'M36 4 V60 H14 L50 96 L86 60 H64 V4 Z'],
    ['arrowDouble', '양쪽 화살표', 'M4 50 L28 22 V38 H72 V22 L96 50 L72 78 V62 H28 V78 Z'],
    ['arrowChevron', '꺾쇠', 'M8 10 H52 L92 50 L52 90 H8 L48 50 Z'],
    ['arrowNotched', '홈 파인 화살표', 'M4 30 H56 V10 L96 50 L56 90 V70 H4 L20 50 Z'],
    ['arrowCurved', '굽은 화살표', 'M10 90 C10 50 40 30 70 30 V14 L96 40 L70 66 V50 C48 50 28 62 28 90 Z'],
    ['arrowCircle', '도는 화살표', 'M50 14 A40 40 0 1 0 90 54 H76 A26 26 0 1 1 50 28 L50 38 L72 21 L50 4 Z'],
    ['arrowTurn', '꺾인 화살표', 'M10 96 V50 C10 34 22 26 38 26 H64 V8 L94 36 L64 64 V46 H38 C34 46 30 48 30 54 V96 Z'],
  ]),
  G('말풍선', [
    ['bubble', '말풍선', 'M12 8 H88 C94 8 96 12 96 18 V60 C96 66 94 70 88 70 H40 L20 92 L24 70 H12 C6 70 4 66 4 60 V18 C4 12 6 8 12 8 Z'],
    ['bubbleRound', '둥근 말풍선', 'M50 8 C76 8 96 22 96 42 C96 62 76 76 50 76 C46 76 42 76 38 75 L18 94 L24 71 C12 65 4 54 4 42 C4 22 24 8 50 8 Z'],
    ['thought', '생각 풍선', `M30 70 C10 70 4 56 10 46 C2 36 10 20 26 22 C30 8 52 4 60 16 C74 6 94 16 88 32 C100 40 96 62 78 62 C74 74 50 76 42 68 C38 70 34 70 30 70 Z ${circle(18, 82, 6)} ${circle(8, 94, 3)}`],
    ['bubbleSquare', '네모 말풍선', 'M6 6 H94 V68 H76 L86 94 L56 68 H6 Z'],
    ['bubbleShout', '외침 풍선', star(50, 50, 49, 33, 12)],
  ]),
  G('배너와 상장', [
    ['banner', '리본', 'M2 30 H18 V20 H82 V30 H98 L90 46 L98 62 H82 V72 H18 V62 H2 L10 46 Z'],
    ['bannerWave', '물결 배너', 'M4 24 C24 10 40 38 60 24 C72 16 84 16 96 22 V70 C84 64 72 64 60 72 C40 86 24 58 4 72 Z'],
    ['badge', '배지', 'M50 2 L62 14 L78 10 L82 26 L96 34 L88 50 L96 66 L82 74 L78 90 L62 86 L50 98 L38 86 L22 90 L18 74 L4 66 L12 50 L4 34 L18 26 L22 10 L38 14 Z'],
    ['award', '상장 리본', `${circle(50, 38, 30)} M32 60 L20 96 L33 89 L40 99 L50 66 Z M68 60 L80 96 L67 89 L60 99 L50 66 Z`],
    ['shield', '방패', 'M50 4 L90 16 V44 C90 70 72 88 50 96 C28 88 10 70 10 44 V16 Z'],
    ['tag', '꼬리표', `M4 50 L28 14 H96 V86 H28 Z ${circle(30, 50, 7, true)}`, 'cs'],
    ['ticket', '티켓', 'M4 16 H96 V40 A10 10 0 0 0 96 60 V84 H4 V60 A10 10 0 0 0 4 40 Z'],
    ['bookmark', '책갈피', 'M24 4 H76 V96 L50 74 L24 96 Z'],
  ]),
  G('프레임', [
    ['frame', '사각 틀', 'M4 4 H96 V96 H4 Z M16 16 V84 H84 V16 Z', 'cs'],
    ['frameRound', '둥근 사각 틀', `${roundRect(4, 4, 92, 92, 16)} ${roundRect(16, 16, 68, 68, 8, true)}`, 'cs'],
    ['ring', '고리', 'M50 4 A46 46 0 1 0 50.1 4 Z M50 24 A26 26 0 1 1 49.9 24 Z', 'cs'],
    ['frameOval', '타원 틀', `${ellipse(50, 50, 46, 38)} ${ellipse(50, 50, 36, 28, true)}`, 'cs'],
    ['frameOctagon', '팔각 틀', `${ngon(50, 50, 48, 8, -67.5)} ${poly(ngonPts(50, 50, 36, 8, -67.5).reverse())}`, 'cs'],
    ['frameScallop', '물결 원 틀', `${scallop(50, 50, 42, 16, 2.6)} ${circle(50, 50, 32, true)}`, 'cs'],
    ['frameDouble', '이중 틀', `${rect(4, 4, 92, 92)} ${rect(10, 10, 80, 80, true)} ${rect(16, 16, 68, 68)} ${rect(22, 22, 56, 56, true)}`, 'cscs'],
  ]),
  G('하트와 별', [
    ['heart', '하트', 'M50 88 C20 66 4 50 4 30 C4 14 16 4 30 4 C40 4 47 10 50 18 C53 10 60 4 70 4 C84 4 96 14 96 30 C96 50 80 66 50 88 Z'],
    ['heartFrame', '하트 틀', 'M50 88 C20 66 4 50 4 30 C4 14 16 4 30 4 C40 4 47 10 50 18 C53 10 60 4 70 4 C84 4 96 14 96 30 C96 50 80 66 50 88 Z M50 74 C68 60 84 46 84 31 C84 21 77 15 69 15 C61 15 55 21 50 32 C45 21 39 15 31 15 C23 15 16 21 16 31 C16 46 32 60 50 74 Z', 'cs'],
    ['star5', '별 (다섯 꼭짓점)', star(50, 53, 48, 19, 5)],
    ['star6', '별 (여섯 꼭짓점)', star(50, 50, 48, 26, 6)],
    ['star8', '별 (여덟 꼭짓점)', star(50, 50, 48, 30, 8)],
    ['starburst', '터지는 별', star(50, 50, 48, 37, 16)],
    ['sparkle', '반짝임', 'M50 4 C54 36 64 46 96 50 C64 54 54 64 50 96 C46 64 36 54 4 50 C36 46 46 36 50 4 Z'],
    ['starFrame', '별 틀', `${star(50, 53, 48, 19, 5)} ${poly(starPts(50, 53, 33, 13, 5).reverse())}`, 'cs'],
  ]),
  G('자연', [
    ['leaf', '잎', 'M10 90 C10 40 40 10 92 8 C90 60 60 90 10 90 Z'],
    ['tree', '나무', 'M50 4 L80 44 H66 L88 72 H58 V96 H42 V72 H12 L34 44 H20 Z'],
    ['flower', '꽃', flower(), 'cccccccs'],
    ['cloud', '구름', 'M26 80 C12 80 4 70 4 58 C4 46 14 38 26 40 C28 22 44 12 60 18 C70 8 92 14 92 34 C100 40 98 80 78 80 Z'],
    ['drop', '물방울', 'M50 4 C66 30 84 48 84 66 C84 84 68 96 50 96 C32 96 16 84 16 66 C16 48 34 30 50 4 Z'],
    ['sun', '해', sun()],
    ['moon', '달', 'M62 4 C36 8 18 30 18 54 C18 80 40 98 66 96 C82 95 92 88 96 80 C88 84 78 86 70 84 C48 80 34 62 36 40 C38 22 48 10 62 4 Z'],
    ['lightning', '번개', 'M58 2 L18 56 H44 L36 98 L82 38 H54 Z'],
    ['snowflake', '눈송이', snowflake()],
    ['wave', '물결', 'M4 60 C20 40 34 40 50 60 C66 80 80 80 96 60 V96 H4 Z'],
    ['mountain', '산', 'M4 90 L36 30 L52 54 L66 36 L96 90 Z'],
    ['paw', '발자국', 'M50 52 C66 52 82 70 78 84 C74 96 60 90 50 90 C40 90 26 96 22 84 C18 70 34 52 50 52 Z M24 26 A9 12 0 1 0 24.1 26 Z M42 10 A9 12 0 1 0 42.1 10 Z M60 10 A9 12 0 1 0 60.1 10 Z M78 26 A9 12 0 1 0 78.1 26 Z'],
  ]),
  G('기호', [
    ['check', '체크', 'M8 52 L22 38 L40 56 L80 14 L94 28 L40 84 Z'],
    ['cross', '엑스', 'M18 4 L50 36 L82 4 L96 18 L64 50 L96 82 L82 96 L50 64 L18 96 L4 82 L36 50 L4 18 Z'],
    ['plus', '더하기', 'M38 4 H62 V38 H96 V62 H62 V96 H38 V62 H4 V38 H38 Z'],
    ['minus', '빼기', rect(4, 38, 92, 24)],
    ['music', '음표', 'M36 70 V14 L86 4 V60 C86 70 78 76 70 76 C62 76 56 70 56 64 C56 58 62 52 70 52 C73 52 75 53 78 54 V20 L44 27 V80 C44 90 36 96 28 96 C20 96 14 90 14 84 C14 78 20 72 28 72 C31 72 34 73 36 74 Z'],
    ['phone', '전화', 'M28 6 C34 6 40 22 40 28 C40 34 32 36 32 40 C32 52 48 68 60 68 C64 68 66 60 72 60 C78 60 94 66 94 72 C94 84 84 94 72 94 C34 94 6 66 6 28 C6 16 16 6 28 6 Z'],
    ['mail', '메일', `${rect(6, 20, 88, 60)} M12 26 L20 26 L50 48 L80 26 L88 26 L50 56 Z`, 'cs'],
    ['pin', '위치 핀', `M50 96 C44 88 16 58 16 36 C16 16 32 4 50 4 C68 4 84 16 84 36 C84 58 56 88 50 96 Z ${circle(50, 36, 12, true)}`, 'cs'],
    ['house', '집', 'M50 6 L96 46 H82 V94 H60 V64 H40 V94 H18 V46 H4 Z'],
    ['person', '사람', `${circle(50, 22, 16)} M18 96 C18 64 32 46 50 46 C68 46 82 64 82 96 Z`],
    ['lock', '자물쇠', `${roundRect(18, 44, 64, 50, 6)} M30 46 V32 C30 18 40 8 50 8 C60 8 70 18 70 32 V46 H60 V32 C60 24 56 18 50 18 C44 18 40 24 40 32 V46 Z ${circle(50, 66, 7, true)}`, 'ccs'],
    ['bell', '종', `M50 6 C54 6 56 9 56 12 C70 16 78 28 78 44 V64 L88 78 H12 L22 64 V44 C22 28 30 16 44 12 C44 9 46 6 50 6 Z ${circle(50, 86, 8)}`],
    ['search', '돋보기', `${circle(40, 40, 32)} ${circle(40, 40, 21, true)} M60 66 L66 60 L95 89 L89 95 Z`, 'csc'],
    ['gear', '톱니바퀴', `${gear(50, 50, 48, 36, 10)} ${circle(50, 50, 14, true)}`, 'cs'],
    ['camera', '카메라', `${roundRect(6, 28, 88, 60, 8)} M32 30 L40 14 H60 L68 30 Z ${circle(50, 58, 17, true)}`, 'ccs'],
    ['smile', '웃는 얼굴', `${circle(50, 50, 46)} ${circle(34, 38, 6, true)} ${circle(66, 38, 6, true)} M26 58 C34 80 66 80 74 58 C64 68 36 68 26 58 Z`, 'csss'],
  ]),
  G('장식', [
    ['diamond', '마름모', 'M50 4 L92 50 L50 96 L8 50 Z'],
    ['hexagon', '육각형', ngon(50, 50, 48, 6, -90)],
    ['octagon', '팔각형', ngon(50, 50, 48, 8, -67.5)],
    ['crown', '왕관', `M8 78 L4 24 L28 48 L50 12 L72 48 L96 24 L92 78 Z ${rect(8, 84, 84, 10)}`],
    ['flourish', '물결 장식', 'M4 50 C20 30 34 30 50 50 C66 70 80 70 96 50 C80 62 66 62 50 50 C34 38 20 38 4 50 Z'],
    ['corner', '모서리 장식', 'M4 4 H60 C40 10 26 18 20 30 C34 24 44 26 50 34 C38 34 30 42 30 54 C22 44 12 50 10 60 C8 40 4 24 4 4 Z'],
    ['tulip', '튤립 장식', `M50 4 C62 18 66 34 56 50 C70 40 86 40 94 52 C80 54 66 62 58 76 H42 C34 62 20 54 6 52 C14 40 30 40 44 50 C34 34 38 18 50 4 Z ${rect(46, 74, 8, 22)}`],
    ['scallopBadge', '물결 원', scallop(50, 50, 42, 14, 2.4)],
    ['quote', '따옴표', 'M8 52 C8 30 20 16 40 12 L42 20 C30 24 24 32 24 40 H40 V72 H8 Z M56 52 C56 30 68 16 88 12 L90 20 C78 24 72 32 72 40 H88 V72 H56 Z'],
    ['infinity', '무한대', 'M50 40 C40 24 26 20 16 26 C4 34 4 66 16 74 C26 80 40 76 50 60 C60 76 74 80 84 74 C96 66 96 34 84 26 C74 20 60 24 50 40 Z M50 50 C44 38 36 34 28 36 C20 38 18 46 18 50 C18 54 20 62 28 64 C36 66 44 62 50 50 Z M50 50 C56 62 64 66 72 64 C80 62 82 54 82 50 C82 46 80 38 72 36 C64 34 56 38 50 50 Z', 'css'],
  ]),
];

/** Flat list: [id, Korean name, path data, ops, group]. */
export const SHAPE_LIST = SHAPE_LIB.flatMap((g) => g.items.map(([id, name, d, ops]) => [id, name, d, ops || '', g.name]));
