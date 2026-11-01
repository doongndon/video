// Premiere Pro style video transitions (3D 동작, 디졸브, 조리개, 페이지 벗기기, 슬라이드, 지우기,
// 확대/축소) and popular tutorial transitions (줌 인 / 줌 아웃, 회전, 글리치, 빛 번짐, 흔들기).
//
// A plan (see transitionPlan in compositor.js) is either
//   { a, b, layer?, bFirst? }  options for drawing the outgoing (a) / incoming (b) clip — each may
//                              also be an array of options to draw the clip several times (pieces)
//   { render(r) }              a shader transition: r = { A, B, p, dir, cw, ch, k } with A / B the
//                              two clips each rendered alone into a frame-sized canvas (transparent
//                              when a side is missing); returns the canvas to composite.

import { TRANSITION_PLANS } from './fx-registry.js';
import { shade } from './glfx.js';

const smooth = (p) => p * p * (3 - 2 * p);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Deterministic pseudo-random in [0, 1) for block i. */
const rnd = (i, seed = 0) => {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function dirVec(dir) {
  switch (dir) {
    case 'right': return [1, 0];
    case 'up': return [0, -1];
    case 'down': return [0, 1];
    default: return [-1, 0];
  }
}

// ---------------------------------------------------------------- 조리개 (iris)

TRANSITION_PLANS.irisBox = (p, dir, W, H) => ({
  a: {},
  b: { clipPath: (c) => c.rect((W / 2) * (1 - p), (H / 2) * (1 - p), W * p, H * p) },
});

TRANSITION_PLANS.irisCross = (p, dir, W, H) => {
  const L = Math.min(1, p * 1.6) * Math.hypot(W, H);
  const a = (Math.pow(p, 1.5) * Math.max(W, H)) / 2;
  return {
    a: {},
    b: {
      clipPath: (c) => {
        c.rect(W / 2 - L, H / 2 - a, 2 * L, 2 * a);
        c.rect(W / 2 - a, H / 2 - L, 2 * a, 2 * L);
      },
    },
  };
};

TRANSITION_PLANS.irisDiamond = (p, dir, W, H) => ({
  a: {},
  b: {
    clipPath: (c) => {
      const dx = Math.max(0.01, p * W);
      const dy = Math.max(0.01, p * H);
      c.moveTo(W / 2, H / 2 - dy);
      c.lineTo(W / 2 + dx, H / 2);
      c.lineTo(W / 2, H / 2 + dy);
      c.lineTo(W / 2 - dx, H / 2);
      c.closePath();
    },
  },
});

// ---------------------------------------------------------------- 슬라이드

TRANSITION_PLANS.centerSplit = (p, dir, W, H) => {
  const e = smooth(p);
  const q = (x, y, sx, sy) => ({ clipPath: (c) => c.rect(x, y, W / 2, H / 2), offsetX: sx * e * (W / 2), offsetY: sy * e * (H / 2) });
  return { bFirst: true, b: {}, a: [q(0, 0, -1, -1), q(W / 2, 0, 1, -1), q(0, H / 2, -1, 1), q(W / 2, H / 2, 1, 1)] };
};

TRANSITION_PLANS.split = (p, dir, W, H) => {
  const e = smooth(p);
  const vertical = dir === 'up' || dir === 'down';
  if (vertical) {
    return { bFirst: true, b: {}, a: [{ clipPath: (c) => c.rect(0, 0, W, H / 2), offsetY: (-e * H) / 2 }, { clipPath: (c) => c.rect(0, H / 2, W, H / 2), offsetY: (e * H) / 2 }] };
  }
  return { bFirst: true, b: {}, a: [{ clipPath: (c) => c.rect(0, 0, W / 2, H), offsetX: (-e * W) / 2 }, { clipPath: (c) => c.rect(W / 2, 0, W / 2, H), offsetX: (e * W) / 2 }] };
};

TRANSITION_PLANS.bandSlide = (p, dir, W, H) => {
  const n = 7;
  const e = smooth(p);
  const vertical = dir === 'up' || dir === 'down';
  const bands = [];
  for (let i = 0; i < n; i++) {
    const s = i % 2 ? 1 : -1;
    if (vertical) {
      const x = (i * W) / n;
      bands.push({ clipPath: (c) => c.rect(x, 0, W / n + 0.5, H), offsetY: s * (1 - e) * H });
    } else {
      const y = (i * H) / n;
      bands.push({ clipPath: (c) => c.rect(0, y, W, H / n + 0.5), offsetX: s * (1 - e) * W });
    }
  }
  return { a: {}, b: bands };
};

// ---------------------------------------------------------------- 지우기

TRANSITION_PLANS.bandWipe = (p, dir, W, H) => {
  const n = 7;
  const vertical = dir === 'up' || dir === 'down';
  return {
    a: {},
    b: {
      clipPath: (c) => {
        for (let i = 0; i < n; i++) {
          const fwd = i % 2 === 0;
          if (vertical) {
            const x = (i * W) / n;
            c.rect(x, fwd ? 0 : H * (1 - p), W / n + 0.5, H * p);
          } else {
            const y = (i * H) / n;
            c.rect(fwd ? 0 : W * (1 - p), y, W * p, H / n + 0.5);
          }
        }
      },
    },
  };
};

TRANSITION_PLANS.checkerWipe = (p, dir, W, H) => {
  const cols = 8;
  const rows = 6;
  const cw = W / cols;
  const ch = H / rows;
  const [mx, my] = dirVec(dir);
  return {
    a: {},
    b: {
      clipPath: (c) => {
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const t = clamp01(p * 2 - ((i + j) % 2));
            if (t <= 0) continue;
            const x = i * cw;
            const y = j * ch;
            if (mx > 0) c.rect(x, y, cw * t + 0.5, ch + 0.5);
            else if (mx < 0) c.rect(x + cw * (1 - t), y, cw * t + 0.5, ch + 0.5);
            else if (my > 0) c.rect(x, y, cw + 0.5, ch * t + 0.5);
            else c.rect(x, y + ch * (1 - t), cw + 0.5, ch * t + 0.5);
          }
        }
      },
    },
  };
};

TRANSITION_PLANS.inset = (p, dir, W, H) => {
  const e = smooth(p);
  // one corner per direction, growing the way it points: 오른쪽으로 from the top-left corner,
  // 아래로 from the top-right, 왼쪽으로 from the bottom-right, 위로 from the bottom-left
  const fromRight = dir === 'left' || dir === 'down';
  const fromBottom = dir === 'left' || dir === 'up';
  return {
    a: {},
    b: { clipPath: (c) => c.rect(fromRight ? W * (1 - e) : 0, fromBottom ? H * (1 - e) : 0, W * e, H * e) },
  };
};

TRANSITION_PLANS.pinwheel = (p, dir, W, H) => {
  const n = 8;
  const R = Math.hypot(W, H);
  return {
    a: {},
    b: {
      clipPath: (c) => {
        for (let i = 0; i < n; i++) {
          const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
          c.moveTo(W / 2, H / 2);
          c.arc(W / 2, H / 2, R, a0, a0 + Math.max(1e-4, p) * ((Math.PI * 2) / n));
          c.closePath();
        }
      },
    },
  };
};

TRANSITION_PLANS.radialWipeTr = (p, dir, W, H) => ({
  a: {},
  b: {
    clipPath: (c) => {
      c.moveTo(0, 0);
      c.arc(0, 0, Math.hypot(W, H) * 1.05, -0.01, Math.max(1e-4, p) * (Math.PI / 2) + 0.01);
      c.closePath();
    },
  },
});

function blocks(p, W, H, order) {
  const cols = 16;
  const rows = 9;
  const cw = W / cols;
  const ch = H / rows;
  return {
    a: {},
    b: {
      clipPath: (c) => {
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            if (order(i, j, cols, rows) < p) c.rect(i * cw, j * ch, cw + 0.5, ch + 0.5);
          }
        }
      },
    },
  };
}

TRANSITION_PLANS.randomBlocks = (p, dir, W, H) => blocks(p, W, H, (i, j, cols) => rnd(j * cols + i, 1));

TRANSITION_PLANS.randomWipe = (p, dir, W, H) => {
  const [mx, my] = dirVec(dir === undefined ? 'down' : dir);
  return blocks(p, W, H, (i, j, cols, rows) => {
    const u = mx ? (mx > 0 ? i / (cols - 1) : 1 - i / (cols - 1)) : my > 0 ? j / (rows - 1) : 1 - j / (rows - 1);
    return u * 0.75 + rnd(j * cols + i, 2) * 0.25;
  });
};

TRANSITION_PLANS.zigZagBlocks = (p, dir, W, H) => blocks(p, W, H, (i, j, cols, rows) => {
  const idx = j * cols + (j % 2 ? cols - 1 - i : i);
  return (idx + 0.5) / (cols * rows);
});

TRANSITION_PLANS.venetianBlindsTr = (p, dir, W, H) => {
  const n = 10;
  const vertical = dir === 'left' || dir === 'right';
  return {
    a: {},
    b: {
      clipPath: (c) => {
        for (let i = 0; i < n; i++) {
          if (vertical) {
            const w = W / n;
            c.rect(dir === 'left' ? i * w + w * (1 - p) : i * w, 0, w * p + 0.5, H);
          } else {
            const hh = H / n;
            c.rect(0, dir === 'up' ? i * hh + hh * (1 - p) : i * hh, W, hh * p + 0.5);
          }
        }
      },
    },
  };
};

// ---------------------------------------------------------------- shader transitions

const AB = `
uniform sampler2D B; uniform float p;
vec4 A_(vec2 q){ return texture(src, q / res); }
vec4 B_(vec2 q){ return texture(B, q / res); }
vec4 At(vec2 q){ return (q.x < 0.0 || q.y < 0.0 || q.x > res.x || q.y > res.y) ? vec4(0.0) : A_(q); }
vec4 Bt(vec2 q){ return (q.x < 0.0 || q.y < 0.0 || q.x > res.x || q.y > res.y) ? vec4(0.0) : B_(q); }
vec2 mirrorUV(vec2 q){ vec2 m = mod(q / res, 2.0); return mix(m, 2.0 - m, step(1.0, m)) * res; }
vec4 Am(vec2 q){ return A_(mirrorUV(q)); }
vec4 Bm(vec2 q){ return B_(mirrorUV(q)); }
`;

function run(key, body, r, uniforms = {}, textures = {}) {
  return shade(`tr:${key}`, AB + body, r.A, { textures: { B: r.B, ...textures }, uniforms: { p: r.p, ...uniforms } });
}

const reg = (type, fn) => {
  TRANSITION_PLANS[type] = (p, dir) => ({ render: (r) => fn({ ...r, p, dir }) });
};

reg('filmDissolve', (r) => run('film', `
void main(){
  vec2 q = P();
  vec4 a = unpm(A_(q)); vec4 b = unpm(B_(q));
  vec3 la = pow(a.rgb, vec3(2.2)) * a.a; vec3 lb = pow(b.rgb, vec3(2.2)) * b.a;
  float al = mix(a.a, b.a, p);
  vec3 l = mix(la, lb, p);
  o = al > 1e-5 ? pm(vec4(pow(l / al, vec3(1.0 / 2.2)), al)) : vec4(0.0);
}`, r));

reg('nonAdditiveDissolve', (r) => run('nonadd', `
void main(){
  vec2 q = P();
  vec4 a = A_(q) * clamp(2.0 * (1.0 - p), 0.0, 1.0);
  vec4 b = B_(q) * clamp(2.0 * p, 0.0, 1.0);
  o = max(a, b);
}`, r));

// cube spin / flip over: faces are planar quads drawn with inverse homographies
const FACES = `
uniform vec3 HA0, HA1, HA2, HB0, HB1, HB2; uniform float fa, fb, shA, shB;
vec4 face(vec3 h0, vec3 h1, vec3 h2, float useB){
  vec2 q = P();
  vec3 s = vec3(dot(h0, vec3(q, 1.0)), dot(h1, vec3(q, 1.0)), dot(h2, vec3(q, 1.0)));
  if (s.z <= 1e-6) return vec4(0.0);
  vec2 uv = s.xy / s.z;
  vec2 d = min(uv, 1.0 - uv) * res;
  float cov = clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
  if (cov <= 0.0) return vec4(0.0);
  vec2 c = clamp(uv, vec2(0.0), vec2(1.0)) * res;
  return (useB > 0.5 ? B_(c) : A_(c)) * cov;
}
void main(){
  vec4 a = fa > 0.5 ? face(HA0, HA1, HA2, 0.0) : vec4(0.0);
  vec4 b = fb > 0.5 ? face(HB0, HB1, HB2, 1.0) : vec4(0.0);
  a.rgb *= shA; b.rgb *= shB;
  o = a + b * (1.0 - a.a);
}`;

function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function inv33(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/**
 * Project a 3D quad (corners UL, UR, LR, LL in camera space: x right, y down, z away, camera at
 * z = −f looking at the frame plane z = 0) to the inverse homography stage px → unit square,
 * plus whether it faces the camera and a shading factor.
 */
function projectFace(corners, cw, ch, f) {
  const proj = corners.map(([x, y, z]) => [cw / 2 + (f * x) / (f + z), ch / 2 + (f * y) / (f + z)]);
  const [p0, p1, , p3] = corners;
  const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const v = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  // corners wind so that n points into the cube: the face is seen when n points away from the camera
  const view = [p0[0], p0[1], p0[2] + f];
  const facing = n[0] * view[0] + n[1] * view[1] + n[2] * view[2] > 0;
  const len = Math.hypot(...n) || 1;
  const shadeF = 0.55 + 0.45 * Math.abs(n[2] / len);
  if (corners.some(([, , z]) => z <= -f * 0.95)) return { inv: null, facing: false, shade: 1 };
  return { inv: inv33(squareToQuad(proj)), facing, shade: shadeF };
}

function facesShader(r, A, B) {
  const ok = (x) => x && x.inv;
  return run('faces', FACES, r, {
    HA0: ok(A) ? A.inv.slice(0, 3) : [0, 0, 0], HA1: ok(A) ? A.inv.slice(3, 6) : [0, 0, 0], HA2: ok(A) ? A.inv.slice(6, 9) : [0, 0, 1],
    HB0: ok(B) ? B.inv.slice(0, 3) : [0, 0, 0], HB1: ok(B) ? B.inv.slice(3, 6) : [0, 0, 0], HB2: ok(B) ? B.inv.slice(6, 9) : [0, 0, 1],
    fa: ok(A) && A.facing ? 1 : 0, fb: ok(B) && B.facing ? 1 : 0, shA: A?.shade ?? 1, shB: B?.shade ?? 1,
  });
}

/** Rotate point P about the axis through C (axis 'y' or 'x') by angle t. */
function rot(P, C, axis, t) {
  const [x, y, z] = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
  const c = Math.cos(t);
  const s = Math.sin(t);
  if (axis === 'y') return [C[0] + x * c + z * s, C[1] + y, C[2] - x * s + z * c];
  return [C[0] + x, C[1] + y * c - z * s, C[2] + y * s + z * c];
}

reg('cubeSpin', (r) => {
  const { cw, ch } = r;
  const e = smooth(r.p);
  const horiz = r.dir !== 'up' && r.dir !== 'down';
  const sign = r.dir === 'right' || r.dir === 'down' ? -1 : 1;
  const f = 2.2 * Math.max(cw, ch);
  const hw = cw / 2;
  const hh = ch / 2;
  const depth = horiz ? hw : hh;
  // push the cube back a little in the middle of the turn so it stays inside the frame
  const back = Math.sin(Math.PI * e) * depth * 0.9;
  const C = [0, 0, depth + back];
  const front = [[-hw, -hh, back], [hw, -hh, back], [hw, hh, back], [-hw, hh, back]];
  let side;
  if (horiz) side = sign > 0 ? [[hw, -hh, back], [hw, -hh, back + cw], [hw, hh, back + cw], [hw, hh, back]] : [[-hw, -hh, back + cw], [-hw, -hh, back], [-hw, hh, back], [-hw, hh, back + cw]];
  else side = sign > 0 ? [[-hw, hh, back], [hw, hh, back], [hw, hh, back + ch], [-hw, hh, back + ch]] : [[-hw, -hh, back + ch], [hw, -hh, back + ch], [hw, -hh, back], [-hw, -hh, back]];
  const t = (horiz ? 1 : -1) * sign * e * (Math.PI / 2);
  const axis = horiz ? 'y' : 'x';
  const fa = projectFace(front.map((P) => rot(P, C, axis, t)), cw, ch, f);
  const fb = projectFace(side.map((P) => rot(P, C, axis, t)), cw, ch, f);
  return facesShader(r, fa, fb);
});

reg('flipOver', (r) => {
  const { cw, ch } = r;
  const e = smooth(r.p);
  const horiz = r.dir !== 'up' && r.dir !== 'down';
  const sign = r.dir === 'right' || r.dir === 'down' ? -1 : 1;
  const f = 2.2 * Math.max(cw, ch);
  const hw = cw / 2;
  const hh = ch / 2;
  const back = Math.sin(Math.PI * e) * Math.max(hw, hh) * 0.6;
  const quad = [[-hw, -hh, back], [hw, -hh, back], [hw, hh, back], [-hw, hh, back]];
  const axis = horiz ? 'y' : 'x';
  const t = (horiz ? 1 : -1) * sign * e * Math.PI;
  const C = [0, 0, back];
  if (e < 0.5) return facesShader(r, projectFace(quad.map((P) => rot(P, C, axis, t)), cw, ch, f), null);
  // the back face is B, turned the other way round so it is not mirrored
  const t2 = t - (horiz ? 1 : -1) * sign * Math.PI;
  return facesShader(r, null, projectFace(quad.map((P) => rot(P, C, axis, t2)), cw, ch, f));
});

// page peel / page turn: the outgoing page rolls over a cylinder from a corner (peel) or edge (turn)
const CURL = `
uniform vec2 C0; uniform vec2 dir; uniform float pos; uniform float R; uniform float turn;
vec4 paperBack(vec2 q, float shade){
  vec4 a = At(q);
  if (turn > 0.5) return vec4(a.rgb * shade, a.a);
  vec3 paper = vec3(0.93, 0.92, 0.9) * shade;
  return vec4(mix(paper, unpm(a).rgb, 0.18) * a.a, a.a);
}
void main(){
  vec2 q = P();
  float s = dot(q - C0, dir);
  vec4 col = vec4(0.0);
  // 1) the flat flap lying on top, ahead of the roll (back side up)
  if (s >= pos) {
    float s0 = 2.0 * pos - s - PI * R;
    vec2 q0 = q + dir * (s0 - s);
    vec4 c = paperBack(q0, 0.82);
    if (c.a > 0.0 && s0 >= -0.5) col = c;
  }
  // 2) on the roll: upper half (back side), then lower half (front side)
  if (col.a < 1.0 && s >= pos - R && s <= pos) {
    float th1 = asin(clamp((pos - s) / R, 0.0, 1.0));
    float th2 = PI - th1;
    float s2 = pos - R * th2;
    vec2 q2 = q + dir * (s2 - s);
    vec4 c2 = s2 >= -0.5 ? paperBack(q2, 0.65 + 0.3 * sin(th2)) : vec4(0.0);
    col += c2 * (1.0 - col.a);
    if (col.a < 1.0) {
      float s1 = pos - R * th1;
      vec2 q1 = q + dir * (s1 - s);
      vec4 c1 = s1 >= -0.5 ? At(q1) : vec4(0.0);
      c1.rgb *= 1.0 - 0.35 * sin(th1);
      col += c1 * (1.0 - col.a);
    }
  }
  // 3) the page still lying flat
  if (col.a < 1.0 && s > pos) col += At(q) * (1.0 - col.a);
  // 4) the incoming clip underneath, shadowed near the roll
  if (col.a < 1.0) {
    vec4 b = Bt(q);
    float shadow = s < pos ? 1.0 - 0.45 * exp(-(pos - s) / (R * 1.5)) : 0.55;
    b.rgb *= shadow;
    col += b * (1.0 - col.a);
  }
  o = col;
}`;

function curl(r, turn) {
  const { cw, ch } = r;
  let start;
  let dir;
  if (turn) {
    // page turn: from an edge, straight across
    const d = r.dir || 'left';
    if (d === 'right') [start, dir] = [[0, 0], [1, 0]];
    else if (d === 'up') [start, dir] = [[0, ch], [0, -1]];
    else if (d === 'down') [start, dir] = [[0, 0], [0, 1]];
    else [start, dir] = [[cw, 0], [-1, 0]];
  } else {
    // page peel: from a corner, diagonally
    const d = r.dir || 'left';
    const corner = d === 'right' ? [0, ch] : d === 'down' ? [0, 0] : d === 'up' ? [cw, 0] : [cw, ch];
    const len = Math.hypot(cw, ch);
    start = corner;
    dir = [(cw / 2 - corner[0]) / (len / 2), (ch / 2 - corner[1]) / (len / 2)];
    const l = Math.hypot(...dir) || 1;
    dir = [dir[0] / l, dir[1] / l];
  }
  const R = Math.min(cw, ch) * 0.09;
  const ext = Math.abs(cw * dir[0]) + Math.abs(ch * dir[1]);
  const pos = r.p * (ext + R * 1.2);
  return run('curl', CURL, r, { C0: start, dir, pos, R, turn: turn ? 1 : 0 });
}

reg('pageTurn', (r) => curl(r, true));
reg('pagePeel', (r) => curl(r, false));

reg('gradientWipeTr', (r) => {
  const [mx, my] = dirVec(r.dir || 'right');
  return run('gradwipe', `
uniform vec2 d; uniform float soft;
void main(){
  vec2 q = P();
  vec2 uv = q / res;
  float g = dot(uv - 0.5, d) * 0.7 + 0.5;
  g = clamp(g + (fbm3(vec3(uv * 3.0, 0.5), 4.0) - 0.5) * 0.45, 0.0, 1.0);
  float e = p * (1.0 + 2.0 * soft) - soft;
  float m = smoothstep(g - soft, g + soft, e);
  vec4 a = A_(q); vec4 b = B_(q);
  o = mix(a, b, m);
}`, r, { d: [mx, my], soft: 0.12 });
});

// zoom / spin with radial and rotational motion blur (the clips are mirrored to fill the frame)
const ZOOM = `
uniform float sA, sB, blurA, blurB, mixAB;
vec4 zoomed(float which, float sc, float bl){
  vec2 c = res * 0.5;
  vec2 q = P() - c;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float f = float(i) / 23.0 - 0.5;
    vec2 u = q / (sc * (1.0 + bl * f)) + c;
    acc += which > 0.5 ? Bm(u) : Am(u);
  }
  return acc / 24.0;
}
void main(){
  vec4 a = mixAB < 1.0 ? zoomed(0.0, sA, blurA) : vec4(0.0);
  vec4 b = mixAB > 0.0 ? zoomed(1.0, sB, blurB) : vec4(0.0);
  o = mix(a, b, mixAB);
}`;

function zoomPlan(r, from, to) {
  // first half: A goes 1 → from; second half: B comes from → to 1 (continuous motion)
  const p = r.p;
  const e1 = smooth(clamp01(p * 2));
  const e2 = smooth(clamp01(p * 2 - 1));
  const sA = 1 + (from - 1) * e1;
  const sB = to + (1 - to) * e2;
  const speed = Math.sin(Math.PI * p);
  const mixAB = smooth(clamp01((p - 0.45) / 0.1));
  return run('zoom', ZOOM, r, { sA, sB, blurA: 0.45 * speed, blurB: 0.45 * speed, mixAB });
}

reg('zoomIn', (r) => zoomPlan(r, 2.6, 0.4));
reg('zoomOut', (r) => zoomPlan(r, 0.4, 2.6));

reg('spin', (r) => {
  const p = r.p;
  const sign = r.dir === 'right' || r.dir === 'down' ? -1 : 1;
  const e = smooth(p);
  const ang = sign * e * Math.PI * 2;
  const speed = Math.sin(Math.PI * p);
  return run('spin', `
uniform float ang; uniform float spd; uniform float zoom; uniform float mixAB;
vec4 spun(float which){
  vec2 c = res * 0.5;
  vec2 q = P() - c;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float f = float(i) / 23.0 - 0.5;
    float a = ang + f * spd;
    vec2 u = mat2(cos(a), sin(a), -sin(a), cos(a)) * q / zoom + c;
    acc += which > 0.5 ? Bm(u) : Am(u);
  }
  return acc / 24.0;
}
void main(){
  vec4 a = mixAB < 1.0 ? spun(0.0) : vec4(0.0);
  vec4 b = mixAB > 0.0 ? spun(1.0) : vec4(0.0);
  o = mix(a, b, mixAB);
}`, r, { ang, spd: 0.6 * speed * sign, zoom: 1 - 0.25 * speed, mixAB: smooth(clamp01((p - 0.45) / 0.1)) });
});

reg('glitchTr', (r) => run('glitch', `
void main(){
  vec2 q = P();
  float k = sin(PI * p);
  float slice = floor(p * 18.0);
  float band = floor(q.y / (res.y / 18.0));
  float r1 = hash(vec2(band, slice));
  float sh = (hash(vec2(band * 1.7, slice * 3.1)) - 0.5) * res.x * 0.25 * k * step(0.55, r1);
  vec2 u = q + vec2(sh, 0.0);
  float sp = res.x * 0.012 * k;
  float useB = step(0.5, p + (hash(vec2(band, slice * 5.0)) - 0.5) * 0.35 * k);
  vec4 cr = useB > 0.5 ? B_(u + vec2(sp, 0.0)) : A_(u + vec2(sp, 0.0));
  vec4 cg = useB > 0.5 ? B_(u) : A_(u);
  vec4 cb = useB > 0.5 ? B_(u - vec2(sp, 0.0)) : A_(u - vec2(sp, 0.0));
  vec4 c = vec4(cr.r, cg.g, cb.b, max(cg.a, max(cr.a, cb.a)));
  c.rgb *= 1.0 - 0.15 * k * step(0.5, fract(q.y / 3.0));
  o = c;
}`, r));

reg('lightLeak', (r) => run('leak', `
void main(){
  vec2 q = P();
  vec4 a = A_(q); vec4 b = B_(q);
  float m = smoothstep(0.25, 0.75, p);
  vec4 base = mix(a, b, m);
  vec2 u = (q - res * 0.5) / max(res.x, res.y);
  float n = fbm3(vec3(u * 2.0 + 3.1, p * 1.5), 4.0);
  float k = sin(PI * p);
  float blob = 1.0 - smoothstep(0.0, 0.9, length(u - vec2(mix(-0.6, 0.6, p), -0.1)) - n * 0.4);
  vec3 leak = mix(vec3(1.0, 0.35, 0.1), vec3(1.0, 0.85, 0.45), n) * blob * k * 1.4;
  vec3 col = base.rgb + leak * (1.0 - base.rgb * 0.5);
  o = vec4(min(col, vec3(max(base.a, max(leak.r, max(leak.g, leak.b))))), max(base.a, min(1.0, max(leak.r, max(leak.g, leak.b)))));
}`, r));

reg('shake', (r) => run('shake', `
void main(){
  vec2 q = P();
  float k = sin(PI * p);
  float t = p * 24.0;
  vec2 off = (vec2(vnoise(vec2(t, 1.3)), vnoise(vec2(t, 7.9))) - 0.5) * res.x * 0.08 * k;
  vec2 vel = (vec2(vnoise(vec2(t + 0.2, 1.3)), vnoise(vec2(t + 0.2, 7.9))) - 0.5) * res.x * 0.08 * k - off;
  float m = smoothstep(0.45, 0.55, p);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i) / 11.0 - 0.5;
    vec2 u = q + off + vel * f * 2.0;
    acc += mix(Am(u), Bm(u), m);
  }
  o = acc / 12.0;
}`, r));
