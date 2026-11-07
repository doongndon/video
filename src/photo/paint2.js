// Gradient tool presets / styles / editor, pattern fill for the paint bucket, the pattern stamp
// tool and Edit ▸ Define Pattern (kept in this browser).

import { h, clamp } from '../util.js';
import { toast, promptDialog, loadPref, savePref } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, Stroke, brushOpts, needRaster, sampleColor, rgbHex } from './tools.js';
import { GRADIENTS, GRADIENT_STYLES, paintGradient, gradientLut, gradientSwatch, listPatterns, patternCanvas, definePattern, paintPattern, userPatterns, userGradients } from './resources.js';
import { colorPickerDialog } from './colorpicker.js';
import { gradientEditorDialog, importGradientFiles } from './gradedit.js';
import { keepImportedPatterns } from './resources.js';
import { BRUSH_BAR } from './brushpanel.js';

const patternList = () => listPatterns().map((p) => [p.id, p.name]);

/**
 * The pattern stamp's 인상파 효과: the pattern repainted as short daubs, each the colour of the
 * pattern where it starts, laid at a random slant (a quick painterly look, like Photoshop's). The
 * daubs are laid block by block, only where the brush goes; returns the source canvas and the
 * function that prepares a document area of it.
 */
function impressionistSource(plain, r) {
  const W = plain.width;
  const H = plain.height;
  const out = makeCanvas(W, H);
  const g = out.getContext('2d');
  // the pattern's own colours under the daubs, so no gaps show
  g.drawImage(plain, 0, 0);
  const pg = plain.getContext('2d', { willReadFrequently: true });
  const B = 192;
  const done = new Set();
  let seed = 9;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  g.lineCap = 'round';
  const block = (bx, by) => {
    const x0 = bx * B;
    const y0 = by * B;
    const w = Math.min(B, W - x0);
    const hh = Math.min(B, H - y0);
    if (w <= 0 || hh <= 0) return;
    const d = pg.getImageData(x0, y0, w, hh).data;
    const step = Math.max(2, Math.round(r * 0.8));
    for (let y = 0; y < hh; y += step) {
      for (let x = 0; x < w; x += step) {
        const px = Math.min(w - 1, Math.max(0, Math.round(x + (rnd() - 0.5) * step)));
        const py = Math.min(hh - 1, Math.max(0, Math.round(y + (rnd() - 0.5) * step)));
        const i = (py * w + px) * 4;
        if (!d[i + 3]) continue;
        const a = rnd() * Math.PI;
        const len = r * (1 + rnd() * 1.5);
        g.strokeStyle = `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3] / 255})`;
        g.lineWidth = r * (0.8 + rnd() * 0.6);
        g.beginPath();
        g.moveTo(x0 + px - Math.cos(a) * len, y0 + py - Math.sin(a) * len);
        g.lineTo(x0 + px + Math.cos(a) * len, y0 + py + Math.sin(a) * len);
        g.stroke();
      }
    }
  };
  const prepare = (rc) => {
    // daubs reach about 3r past their block
    const m = r * 3;
    for (let by = Math.max(0, Math.floor((rc.y - m) / B)); by <= Math.floor((rc.y + rc.h + m) / B); by++) {
      for (let bx = Math.max(0, Math.floor((rc.x - m) / B)); bx <= Math.floor((rc.x + rc.w + m) / B); bx++) {
        const k = `${bx},${by}`;
        if (done.has(k)) continue;
        done.add(k);
        block(bx, by);
      }
    }
  };
  return { canvas: out, prepare };
}


export function installPaint2(P) {
  const C = P.cmd;

  // ---- Photoshop's Color Picker for the foreground / background colour (the toolbar swatches)
  P.colorPicker = (which = 'fg') => colorPickerDialog({
    title: which === 'bg' ? '색상 피커 (배경색)' : '색상 피커 (전경색)',
    value: which === 'bg' ? P.bg : P.fg,
    onOk: (hex) => P.setColor(hex, which === 'bg'),
    onAddSwatch: P.addSwatch ? (hex) => {
      P.addSwatch(hex);
      toast('견본 패널의 "내 견본"에 추가했습니다');
    } : null,
    // the picture behind the dialog: the eyedropper's sample size and layers
    sample: (x, y) => {
      if (!P.doc || !document.elementsFromPoint(x, y).some((el) => el.matches?.('.ph-stage canvas.ph-view, .ph-stage canvas.ph-over'))) return null;
      const c = sampleColor(P, P.toDoc(x, y));
      return c ? rgbHex(...c) : null;
    },
  });

  // ---- gradient tool
  // the presets, the user's gradients (saved in the editor or imported from .grd files) and the
  // edited one, under its name
  const GR_LIST = () => [...GRADIENTS.map((g) => [g.id, g.name]), ...userGradients().map((g) => [g.id, g.name]), ['custom', P.opts('gradient').custom?.name || '사용자 정의 (편집으로 만들기)']];
  // picking one of the user's gradients uses a copy of it (what the gradient tool paints with)
  const setOpt = P.setOpt;
  P.setOpt = (id, key, v) => {
    if (id === 'gradient' && key === 'preset' && v !== 'custom' && !GRADIENTS.some((g) => g.id === v)) {
      const ug = userGradients().find((g) => g.id === v);
      if (ug) {
        setOpt('gradient', 'custom', structuredClone(ug));
        v = 'custom';
      }
    }
    return setOpt(id, key, v);
  };
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
      onclick: () => P.gradientEditor(current(o), (g) => {
        P.setOpt('gradient', 'custom', g);
        P.setOpt('gradient', 'preset', 'custom');
      }),
    }, sw), h('span.ph-opt.ph-hint', 'Shift: 45° 단위')];
  };
  let preview = null;
  /**
   * While dragging: the browser's own (GPU) gradients with stops sampled from the gradient, drawn
   * into one reused canvas. Returns null for styles it can't draw (diamond).
   */
  const fastGradient = (W, H, gr, a, b, opts, s = 1) => {
    const style = opts.style;
    if (style === 'diamond') return null;
    const cw = Math.max(1, Math.round(W * s));
    const ch = Math.max(1, Math.round(H * s));
    if (!preview || preview.width !== cw || preview.height !== ch) preview = makeCanvas(cw, ch);
    const g = preview.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, cw, ch);
    g.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    const lut = gradientLut(gr, { fg: opts.fg, bg: opts.bg, reverse: opts.reverse });
    const at = (t) => {
      const k = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
      return `rgba(${lut[k]},${lut[k + 1]},${lut[k + 2]},${lut[k + 3] / 255})`;
    };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    let grad;
    const N = 32;
    if (style === 'radial') grad = g.createRadialGradient(a.x, a.y, 0, a.x, a.y, len);
    else if (style === 'angle') {
      if (!g.createConicGradient) return null;
      grad = g.createConicGradient(Math.atan2(dy, dx), a.x, a.y);
    } else if (style === 'reflected') {
      grad = g.createLinearGradient(a.x - dx, a.y - dy, b.x, b.y);
      for (let k = 0; k <= N; k++) grad.addColorStop(k / N, at(Math.abs((2 * k) / N - 1)));
    } else grad = g.createLinearGradient(a.x, a.y, b.x, b.y);
    if (style !== 'reflected') for (let k = 0; k <= N; k++) grad.addColorStop(k / N, at(k / N));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return preview;
  };
  P.gradientCanvas = (a, b, o) => {
    const doc = P.doc;
    const W = doc.width;
    const H = doc.height;
    const opts = { style: o.style || 'linear', fg: P.fg, bg: P.bg, reverse: !!o.reverse, dither: o.dither !== false };
    if (!o.final) {
      const s = Math.min(1, o.scale || 1);
      const fast = fastGradient(W, H, current(o), a, b, opts, s);
      if (fast) return fast;
      if (s < 1) {
        // diamond: computed straight at screen size
        const sw = Math.max(1, Math.round(W * s));
        const sh = Math.max(1, Math.round(H * s));
        return paintGradient(sw, sh, current(o), { x: a.x * (sw / W), y: a.y * (sh / H) }, { x: b.x * (sw / W), y: b.y * (sh / H) }, { ...opts, dither: false });
      }
    }
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

  // ---- the Gradient Editor (gradedit.js) for every gradient in the app (pdialogs.js hands over to it)
  P.gradientEditor = (gr, onApply) => gradientEditorDialog(P, gr, onApply);

  // ---- Photoshop gradient (.grd) and pattern (.pat) files
  C.importGradients = async (files = null) => {
    if (!files) {
      const { pickFiles } = await import('../ui/project-panel.js');
      files = await pickFiles({ accept: '.grd', multiple: true });
    }
    const n = await importGradientFiles(P, files);
    if (n) P.showPanel('gradients');
    return n;
  };
  C.importPatterns = async (files = null) => {
    if (!files) {
      const { pickFiles } = await import('../ui/project-panel.js');
      files = await pickFiles({ accept: '.pat', multiple: true });
    }
    const { parsePat } = await import('./psdres.js');
    let total = 0;
    for (const f of files) {
      try {
        const list = parsePat(await f.arrayBuffer()).map((p) => {
          const c = makeCanvas(p.w, p.h);
          c.getContext('2d').putImageData(new ImageData(Uint8ClampedArray.from(p.rgba), p.w, p.h), 0, 0);
          return { canvas: c, name: p.name || f.name.replace(/\.[^.]+$/, '') };
        });
        keepImportedPatterns(list);
        total += list.length;
        toast(list.length ? `${f.name}: 패턴 ${list.length}개를 가져왔습니다 (패턴 패널)` : `${f.name}: 가져올 패턴이 없습니다`);
      } catch (err) {
        toast(`${f.name}: 패턴 파일을 읽을 수 없습니다 (${err.message || err})`);
      }
    }
    if (total) {
      P.emit('patterns');
      P.emit('opts');
      P.showPanel('patterns');
    }
    return total;
  };
  // opened or dropped .grd / .pat files go into the gradient and pattern lists, like Photoshop
  const openFiles = P.openFiles;
  P.openFiles = async (files) => {
    const list = [...files];
    const grd = list.filter((f) => /\.grd$/i.test(f.name));
    const pat = list.filter((f) => /\.pat$/i.test(f.name));
    if (grd.length) await C.importGradients(grd);
    if (pat.length) await C.importPatterns(pat);
    const rest = list.filter((f) => !grd.includes(f) && !pat.includes(f));
    return rest.length ? openFiles(rest) : undefined;
  };
  // Edit ▸ Presets: import brushes, patterns and gradients
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['편집'];
    if (!orig) return;
    P.menus['편집'] = () => {
      const items = orig();
      const at = items.findIndex((it) => typeof it === 'object' && /^패턴 정의/.test(it?.label || ''));
      const add = { label: '사전 설정', submenu: [
        { label: '브러시 가져오기… (.abr)', action: () => C.importBrushes?.() },
        { label: '패턴 가져오기… (.pat)', action: () => C.importPatterns() },
        { label: '그레이디언트 가져오기… (.grd)', action: () => C.importGradients() },
      ] };
      if (at < 0) return [...items, '-', add];
      return [...items.slice(0, at + 1), add, ...items.slice(at + 1)];
    };
  }];

  // ---- paint bucket: colour or pattern
  const bucket = TOOL_BY_ID.bucket;
  bucket.options = [['fill', '칠', 'select', null, null, 'fg', [['fg', '전경색'], ['pattern', '패턴']]], ['pattern', '패턴', 'select', null, null, 'bricks', patternList], ...bucket.options];
  P.patternStyle = (g, id) => g.createPattern(patternCanvas(id), 'repeat');

  // ---- pattern stamp
  const stamp = {
    id: 'patternStamp', name: '패턴 도장', key: 'S', icon: 'patternStamp', group: 'retouch', cursor: 'brush',
    // Photoshop's order: brush, mode, opacity, flow, airbrush, pattern, aligned, impressionist
    options: [...BRUSH_BAR.filter((x) => x[0] !== 'pressureSize'), ['pattern', '패턴', 'select', null, null, 'bricks', patternList], ['scale', '패턴 크기 (%)', 'range', 10, 400, 100],
      ['aligned', '정렬', 'bool', null, null, true], ['impressionist', '인상파 효과', 'bool', null, null, false], ['pressureSize', '압력: 크기', 'bool', null, null, false]],
    leadButtons() {
      return P.brushOptionButtons?.('patternStamp') || [];
    },
    down(E, p, e) {
      if (!needRaster(E, '패턴 도장')) return;
      if (E.maskTarget?.()) return void toast('패턴 도장은 레이어 내용에만 칠합니다');
      const o = E.opts('patternStamp');
      const bo = brushOpts(o, E, { label: '패턴 도장' });
      // 정렬: the tiles stay put on the document; off: each stroke starts the pattern where it starts
      const at = o.aligned === false ? p : { x: 0, y: 0 };
      const ox = Math.round(at.x);
      const oy = Math.round(at.y);
      bo.srcCanvas = paintPattern(E.doc.width, E.doc.height, o.pattern, o.scale, ox, oy);
      if (o.impressionist) {
        const src = impressionistSource(bo.srcCanvas, clamp(Math.round((o.size || 60) / 12), 2, 24));
        bo.srcCanvas = src.canvas;
        bo.cloneSrcPrepare = src.prepare;
      }
      bo.cloneOffset = { x: 0, y: 0 };
      // brush tips and brush settings (brushengine.js) paint the pattern through
      bo.cloneSrc = bo.srcCanvas;
      bo.cloneXf = new DOMMatrix();
      bo.engine = E.brushEngine?.('patternStamp', o, bo, 'clone') || null;
      this.st = new Stroke(E, 'clone', bo);
      this.st.to(p, e.pointerType === 'pen' ? e.pressure || 1 : 1);
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
  for (const sp of loadPref('photo.patterns', [])) {
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      userPatterns.set(sp.id, { name: sp.name, canvas: c });
      P.emit('patterns');
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
    // the list as kept now (the Patterns panel renames and deletes patterns in it)
    const saved = loadPref('photo.patterns', []);
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
