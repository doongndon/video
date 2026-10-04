// Gradient tool presets / styles / editor, pattern fill for the paint bucket, the pattern stamp
// tool and Edit ▸ Define Pattern (kept in this browser).

import { h } from '../util.js';
import { toast, promptDialog, loadPref, savePref } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, Stroke, brushOpts, needRaster } from './tools.js';
import { GRADIENTS, GRADIENT_STYLES, paintGradient, gradientSwatch, listPatterns, patternCanvas, definePattern, paintPattern, userPatterns } from './resources.js';

const patternList = () => listPatterns().map((p) => [p.id, p.name]);

export function installPaint2(P) {
  const C = P.cmd;

  // ---- gradient tool
  const GR_LIST = [...GRADIENTS.map((g) => [g.id, g.name]), ['custom', '사용자 정의 (편집으로 만들기)']];
  const grad = TOOL_BY_ID.gradient;
  grad.options = [
    ['preset', '그레이디언트', 'select', null, null, 'fgbg', GR_LIST],
    ['style', '모양', 'select', null, null, 'linear', GRADIENT_STYLES],
    ['reverse', '반전', 'bool', null, null, false],
    ['dither', '디더 (띠 없애기)', 'bool', null, null, true],
    ['opacity', '불투명도', 'range', 1, 100, 100, '%'],
  ];
  const current = (o) => (o.preset === 'custom' && o.custom ? o.custom : GRADIENTS.find((g) => g.id === o.preset) || GRADIENTS[0]);
  grad.optionButtons = () => {
    const o = P.opts('gradient');
    const sw = gradientSwatch(current(o), 110, 16, P.fg, P.bg);
    sw.style.cssText = 'display:block;border-radius:3px';
    return [h('button.small.ph-gradbtn', {
      title: '그레이디언트 편집',
      onclick: async () => {
        const D = await import('./pdialogs.js');
        D.gradientEditor(P, current(o), (g) => {
          P.setOpt('gradient', 'custom', g);
          P.setOpt('gradient', 'preset', 'custom');
        });
      },
    }, sw), h('span.ph-opt.ph-hint', 'Shift: 45° 단위')];
  };
  P.gradientCanvas = (a, b, o) => {
    const doc = P.doc;
    const W = doc.width;
    const H = doc.height;
    const opts = { style: o.style || 'linear', fg: P.fg, bg: P.bg, reverse: !!o.reverse, dither: o.dither !== false };
    // while dragging a big picture, a smaller preview keeps up with the pointer
    const k = o.final ? 1 : Math.min(1, Math.sqrt(1.5e6 / (W * H)));
    if (k >= 1) return paintGradient(W, H, current(o), a, b, opts);
    const sw = Math.max(1, Math.round(W * k));
    const sh = Math.max(1, Math.round(H * k));
    const small = paintGradient(sw, sh, current(o), { x: a.x * k, y: a.y * k }, { x: b.x * k, y: b.y * k }, { ...opts, dither: false });
    const c = makeCanvas(W, H);
    c.getContext('2d').drawImage(small, 0, 0, W, H);
    return c;
  };
  const gMove = grad.move;
  grad.move = function move(E, p, e) {
    // Shift: 45° steps
    if (this.d && e?.shiftKey) {
      const a = this.d.a;
      const ang = Math.round(Math.atan2(p.y - a.y, p.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(p.x - a.x, p.y - a.y);
      p = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }
    return gMove.call(this, E, p, e);
  };

  // ---- paint bucket: colour or pattern
  const bucket = TOOL_BY_ID.bucket;
  bucket.options = [['fill', '칠', 'select', null, null, 'fg', [['fg', '전경색'], ['pattern', '패턴']]], ['pattern', '패턴', 'select', null, null, 'checker', patternList], ...bucket.options];
  P.patternStyle = (g, id) => g.createPattern(patternCanvas(id), 'repeat');

  // ---- pattern stamp
  const stamp = {
    id: 'patternStamp', name: '패턴 도장', key: 'S', icon: 'patternStamp', group: 'retouch', cursor: 'brush',
    options: [['size', '크기', 'range', 1, 500, 60], ['hardness', '경도', 'range', 0, 100, 60, '%'], ['opacity', '불투명도', 'range', 1, 100, 100, '%'], ['flow', '흐름', 'range', 1, 100, 100, '%'], ['pattern', '패턴', 'select', null, null, 'checker', patternList], ['scale', '패턴 크기 (%)', 'range', 10, 400, 100]],
    down(E, p, e) {
      if (!needRaster(E, '패턴 도장')) return;
      if (E.maskTarget?.()) return void toast('패턴 도장은 레이어 내용에만 칠합니다');
      const o = E.opts('patternStamp');
      const bo = brushOpts(o, E, { label: '패턴 도장' });
      bo.srcCanvas = paintPattern(E.doc.width, E.doc.height, o.pattern, o.scale);
      bo.cloneOffset = { x: 0, y: 0 };
      this.st = new Stroke(E, 'clone', bo);
      this.st.to(p, e.pressure || 1);
      this.st.flush();
    },
    move(E, p, e) {
      this.st?.to(p, e.pointerType === 'pen' ? e.pressure : 1);
    },
    up() {
      this.st?.end();
      this.st = null;
    },
    cancel(E) {
      if (!this.st) return;
      E.doc.restore(this.st.before);
      this.st = null;
      E.redraw();
    },
  };
  TOOLS.push(stamp);
  TOOL_BY_ID.patternStamp = stamp;
  TOOL_GROUPS.find((g) => g[0] === 'clone').push('patternStamp');

  // ---- define pattern (kept in this browser, up to 24)
  const saved = loadPref('photo.patterns', []);
  for (const sp of saved) {
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      userPatterns.set(sp.id, { name: sp.name, canvas: c });
    };
    img.src = sp.data;
  }
  C.definePattern = async () => {
    const doc = P.doc;
    if (!doc) return;
    const r = doc.selection ? P.selBounds(doc.selection.canvas) : { x: 0, y: 0, w: doc.width, h: doc.height };
    if (!r) return;
    const k = Math.min(1, 512 / Math.max(r.w, r.h));
    const c = makeCanvas(Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k)));
    c.getContext('2d').drawImage(P.composite(), r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const name = await promptDialog('패턴 정의', '이름', `내 패턴 ${saved.length + 1}`);
    if (!name) return;
    const id = definePattern(c, name.slice(0, 30));
    saved.push({ id, name: name.slice(0, 30), data: c.toDataURL('image/png') });
    while (saved.length > 24) {
      const old = saved.shift();
      userPatterns.delete(old.id);
    }
    try {
      savePref('photo.patterns', saved);
    } catch {
      toast('브라우저 저장 공간이 모자라 패턴을 기억하지 못했습니다 (이 문서를 닫기 전까지는 쓸 수 있음)');
    }
    toast(`"${name}" 패턴을 만들었습니다. 페인트 통(칠: 패턴), 패턴 도장, 패턴 칠 레이어에서 쓸 수 있어요.`);
    P.emit('opts');
  };
}
