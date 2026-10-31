// Free transform's options bar (reference point locator, X / Y / W / H / angle / skew fields with
// the W–H link, interpolation, warp grid, split and presets), its right-click menu, Transform a Copy
// (P.cmd.freeTransformCopy, Ctrl+Alt+T) and Transform Again on a copy (P.cmd.transformAgainCopy,
// Ctrl+Alt+Shift+T), arrow keys while transforming, and Edit ▸ Perspective Warp.

import { h } from '../util.js';
import { toast, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { Transformer, warpDims } from './transform.js';
import { PerspectiveWarp } from './perspwarp.js';

const INTERP = [['nearest', '최단입점'], ['bilinear', '쌍선형'], ['bicubic', '쌍입방']];
const GRIDS = [[1, '기본값'], [3, '3 x 3'], [4, '4 x 4'], [5, '5 x 5']];

export function installTransform2(P) {
  const C = P.cmd;
  P.transformInterp = loadPref('photo.interp', 'bicubic');
  let linked = loadPref('photo.transformLink', true);

  // ---------------------------------------------------------------- commands

  /** Ctrl+Alt+T: transform a copy (of the selected pixels, or of the layer). */
  C.freeTransformCopy = () => {
    const doc = P.doc;
    if (!doc) return toast('먼저 문서를 여세요');
    if (P.transform) return undefined;
    P.finishText?.();
    const l = doc.active;
    try {
      if (doc.selection && l?.kind === 'raster' && !P.editMask) {
        // the selected pixels are copied; the originals stay where they are
        P.transform = new Transformer(P, { mode: 'free', copy: true });
        P.transform.label = '복사본 자유 변형';
        P.emit('transform');
        return undefined;
      }
    } catch (err) {
      return toast(String(err.message || err));
    }
    // a copy of the layer, transformed: one step with the copy
    const before = doc.capture();
    const top = doc.history.undoStack.at(-1);
    C.duplicateLayer();
    if (doc.history.undoStack.at(-1) === top) return undefined;
    doc.history.undoStack.pop();
    try {
      const t = new Transformer(P, { mode: 'free' });
      t.before = before;
      t.keep = true;
      t.label = '복사본 자유 변형';
      P.transform = t;
      P.emit('transform');
    } catch (err) {
      doc.restore(before);
      P.afterHistory();
      toast(String(err.message || err));
    }
    return undefined;
  };

  /** Ctrl+Alt+Shift+T: a copy of the layer with the last transform applied again (step and repeat). */
  C.transformAgainCopy = () => {
    const doc = P.doc;
    if (!doc) return undefined;
    if (!P.lastTransform) return toast('다시 할 변형이 없습니다');
    if (P.transform) P.applyTransform();
    const before = doc.capture();
    const top = doc.history.undoStack.at(-1);
    C.duplicateLayer();
    if (doc.history.undoStack.at(-1) === top) return undefined;
    C.transformAgain();
    while (doc.history.undoStack.length && doc.history.undoStack.at(-1) !== top) doc.history.undoStack.pop();
    P.commit('다시 변형 (복사)', before);
    return undefined;
  };

  /** Edit ▸ Perspective Warp. */
  C.perspectiveWarp = () => {
    const doc = P.doc;
    if (!doc) return toast('먼저 문서를 여세요');
    if (P.transform) P.applyTransform();
    P.finishText?.();
    try {
      P.transform = new PerspectiveWarp(P);
      P.emit('transform');
      toast('레이아웃: 기울어진 면 위에 사각형을 그리세요. 맞닿은 면은 사각형끼리 붙여 그려요.');
    } catch (err) {
      toast(String(err.message || err));
    }
    return undefined;
  };

  // Edit ▸ Transform ▸ Rotate / Flip while a transform is open: they turn the transform box
  const tl = C.transformLayer;
  if (tl) {
    C.transformLayer = (kind) => {
      const T = P.transform;
      if (!T?.flip) return tl(kind);
      if (kind === 'flipH' || kind === 'flipV') T.flip(kind === 'flipH' ? 'h' : 'v');
      else T.rotateBy(kind === 'cw' ? 90 : kind === 'ccw' ? -90 : 180);
      P.emit('transform');
      return undefined;
    };
  }

  /** The right-click menu while transforming (Photoshop's). */
  const transformMenu = () => {
    const T = P.transform;
    if (T.kind === 'perspwarp') {
      return [
        { label: '레이아웃', checked: T.mode === 'layout', action: () => T.setMode('layout') },
        { label: '뒤틀기', checked: T.mode === 'warp', action: () => T.setMode('warp') },
        '-',
        { label: '적용', key: 'Enter', action: () => P.applyTransform() },
        { label: '취소', key: 'Esc', action: () => P.cancelTransform() },
      ];
    }
    const mode = (id, label) => ({ label, checked: T.mode === id, action: () => {
      T.setMode(id);
      P.emit('transform');
    } });
    const custom = T.mode === 'warp' && T.warp?.ctrl;
    const split = (how, label) => ({ label, disabled: !custom, action: () => {
      T.splitMode = how;
      P.emit('transform');
      P.redraw();
    } });
    return [
      mode('free', '자유 변형'),
      mode('skew', '기울이기'),
      mode('distort', '왜곡'),
      mode('perspective', '원근'),
      mode('warp', '뒤틀기'),
      split('h', '뒤틀기 가로로 분할'),
      split('v', '뒤틀기 세로로 분할'),
      split('cross', '뒤틀기 십자형으로 분할'),
      '-',
      { label: '180° 회전', action: () => C.transformLayer('180') },
      { label: '시계 방향으로 90° 회전', action: () => C.transformLayer('cw') },
      { label: '반시계 방향으로 90° 회전', action: () => C.transformLayer('ccw') },
      '-',
      { label: '가로로 뒤집기', action: () => C.transformLayer('flipH') },
      { label: '세로로 뒤집기', action: () => C.transformLayer('flipV') },
      '-',
      { label: '적용', key: 'Enter', action: () => P.applyTransform() },
      { label: '취소', key: 'Esc', action: () => P.cancelTransform() },
    ];
  };

  // P.cmd.freeTransform({ copy: true }) and ({ mode, target }) work too
  const ft = C.freeTransform;
  if (ft) {
    C.freeTransform = (mode = 'free', target = 'auto') => {
      if (mode && typeof mode === 'object') return mode.copy ? C.freeTransformCopy() : ft(mode.mode || 'free', mode.target || 'auto');
      return ft(mode, target);
    };
  }

  // ---------------------------------------------------------------- options bar

  let live = null; // inputs of the bar on screen, kept in step while dragging
  let raf = 0;
  P.transformChanged = (t) => {
    if (!live || live.t !== t || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!live || live.t !== P.transform || !live.inputs) return;
      const n = live.t.numbers();
      for (const [k, inp] of Object.entries(live.inputs)) if (document.activeElement !== inp) inp.value = n[k];
      live.ref?.();
    });
  };

  const togg = (on, label, title, onclick, ic = null) => h(`button.small.ph-tog${on ? '.on' : ''}`, { title: title || label, onclick }, ic ? icon(ic, 16) : null, label ? (ic ? ` ${label}` : label) : null);
  const finish = () => [
    h('button.small.ph-icobtn', { title: '변형 취소 (Esc)', 'aria-label': '변형 취소', onclick: () => P.cancelTransform() }, icon('close', 16)),
    h('button.primary.small.ph-icobtn', { title: '변형 적용 (Enter)', 'aria-label': '변형 적용', onclick: () => P.applyTransform() }, icon('check', 16)),
  ];
  const interpSel = () => {
    const s = h('select', { 'aria-label': '보간', title: '보간: 픽셀을 다시 만드는 방법 (최단입점: 가장자리 유지, 쌍입방: 매끄럽게)' }, INTERP.map(([v, t]) => h('option', { value: v }, t)));
    s.value = P.transformInterp;
    s.addEventListener('change', () => {
      P.transformInterp = s.value;
      savePref('photo.interp', s.value);
      P.transform?.update?.(true);
    });
    return h('label.ph-opt', h('span', '보간'), s);
  };
  const modes = (T, render) => h('span.ph-opt', { style: { gap: '2px' } }, ...P.transformModes.map(([id, name]) => togg(T.mode === id, name, null, () => {
    T.setMode(id);
    render();
  })));

  /** The 9-point reference point locator. */
  const locator = (T, render) => {
    const cells = [];
    const grid = h('span.ph-refloc', { role: 'group', 'aria-label': '참조점 위치', title: '참조점 위치: 돌리고 크기를 바꾸는 기준점', style: { display: 'inline-grid', gridTemplateColumns: 'repeat(3, 7px)', gap: '2px', padding: '2px', border: '1px solid var(--line, #444)', borderRadius: '3px', flexShrink: '0' } });
    const paint = () => {
      const r = T.reference();
      for (const c of cells) {
        const on = r && r[0] === c.u && r[1] === c.v;
        c.el.style.background = on ? 'var(--accent, #4aa3ff)' : 'transparent';
        c.el.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    };
    for (const v of [0, 0.5, 1]) {
      for (const u of [0, 0.5, 1]) {
        const el = h('button', { title: '참조점', 'aria-label': `참조점 ${['왼쪽', '가운데', '오른쪽'][u * 2]} ${['위', '가운데', '아래'][v * 2]}`, style: { width: '7px', height: '7px', minHeight: '0', minWidth: '0', padding: '0', border: '1px solid currentColor', borderRadius: '1px', background: 'transparent', cursor: 'pointer' }, onclick: () => {
          T.setReference(u, v);
          paint();
          render();
        } });
        cells.push({ el, u, v });
        grid.append(el);
      }
    }
    paint();
    return { el: grid, paint };
  };

  const freeBar = (T, render) => {
    const n = T.numbers();
    const inputs = {};
    const num = (key, label, unit, step, title) => {
      const inp = h('input.ph-num', { type: 'number', value: n[key], step, 'aria-label': title || label, title: title || label });
      inp.addEventListener('change', () => {
        const cur = T.numbers();
        const v = { [key]: +inp.value };
        if (key === 'w' && linked) v.h = cur.h * (+inp.value / (cur.w || 1));
        if (key === 'h' && linked) v.w = cur.w * (+inp.value / (cur.h || 1));
        T.setNumbers(v);
        render();
      });
      inputs[key] = inp;
      return h('label.ph-opt', h('span', label), inp, unit ? h('small', unit) : null);
    };
    const link = h(`button.small.ph-icobtn.ph-tog${linked ? '.on' : ''}`, { title: '가로 세로 비율 유지', 'aria-label': '가로 세로 비율 유지', 'aria-pressed': linked ? 'true' : 'false', onclick: () => {
      linked = !linked;
      savePref('photo.transformLink', linked);
      render();
    } }, icon('link', 16));
    const loc = T.mode !== 'free' ? null : locator(T, render);
    live = { t: T, inputs, ref: loc?.paint };
    return [
      h('span.ph-tname', icon('move', 16), '변형'),
      loc?.el,
      num('x', 'X', 'px', 1, '참조점 가로 위치'),
      num('y', 'Y', 'px', 1, '참조점 세로 위치'),
      num('w', 'W', '%', 0.1, '폭 비율'),
      link,
      num('h', 'H', '%', 0.1, '높이 비율'),
      num('angle', '회전', '°', 0.1, '회전 각도'),
      num('skew', '기울기 H', '°', 0.1, '가로 기울이기'),
      num('skewV', 'V', '°', 0.1, '세로 기울이기'),
      T.kind === 'text' || T.kind === 'shape' ? null : interpSel(),
      modes(T, render),
      ...finish(),
    ];
  };

  const warpBar = (T, render) => {
    live = { t: T, inputs: null };
    const w = T.warp;
    const custom = !w || w.style === 'custom';
    const style = h('select', { 'aria-label': '뒤틀기 스타일' }, [['custom', '사용자 정의'], ...P.warpStyles.filter((s) => s[0] !== 'none')].map(([v, t]) => h('option', { value: v }, t)));
    style.value = w?.style || 'custom';
    style.addEventListener('change', () => {
      T.setWarpPreset(style.value, w?.bend ?? 50, w?.h ?? 0, w?.v ?? 0);
      render();
    });
    const out = [h('span.ph-tname', icon('perspWarp', 16), '뒤틀기')];
    if (custom) {
      const split = (how, ic, title) => togg(T.splitMode === how, null, title, () => {
        T.splitMode = T.splitMode === how ? null : how;
        if (T.splitMode) toast('나눌 곳을 누르세요');
        render();
        P.redraw();
      }, ic);
      const { R, C: cols, us, vs } = warpDims(w || { rows: 1, cols: 1 });
      const even = (a) => a.every((x, i) => Math.abs(x - i / (a.length - 1)) < 1e-6);
      const gridVal = R === cols && even(us) && even(vs) && [1, 3, 4, 5].includes(R) ? String(R) : 'custom';
      const grid = h('select', { 'aria-label': '격자', title: '뒤틀기 격자' }, [...GRIDS.map(([v, t]) => h('option', { value: String(v) }, t)), gridVal === 'custom' ? h('option', { value: 'custom' }, `사용자 정의 (${cols} x ${R})`) : null]);
      grid.value = gridVal;
      grid.addEventListener('change', () => {
        if (grid.value === 'custom') return;
        T.setWarpGrid(+grid.value);
        render();
      });
      out.push(
        h('span.ph-opt', { style: { gap: '2px' } },
          split('cross', 'splitCross', '뒤틀기를 십자형으로 분할 (누른 곳에 가로·세로 선)'),
          split('v', 'splitV', '뒤틀기를 세로로 분할 (누른 곳에 세로 선)'),
          split('h', 'splitH', '뒤틀기를 가로로 분할 (누른 곳에 가로 선)')),
        h('label.ph-opt', h('span', '격자'), grid),
        h('label.ph-opt', h('span', '뒤틀기'), style),
        h('button.small', { title: '뒤틀기를 처음 모양으로', onclick: () => {
          T.resetWarp();
          render();
        } }, '재설정'),
      );
    } else {
      const field = (key, label, def) => {
        const inp = h('input.ph-num', { type: 'number', min: -100, max: 100, value: w[key] ?? def, 'aria-label': label });
        inp.addEventListener('change', () => {
          const v = Math.max(-100, Math.min(100, +inp.value || 0));
          T.setWarpPreset(w.style, key === 'bend' ? v : w.bend ?? 50, key === 'h' ? v : w.h ?? 0, key === 'v' ? v : w.v ?? 0);
          render();
        });
        return h('label.ph-opt', h('span', label), inp, h('small', '%'));
      };
      out.push(
        h('label.ph-opt', h('span', '뒤틀기'), style),
        h('button.small.ph-icobtn', { title: '뒤틀기 방향 변경 (가로 ⇄ 세로)', 'aria-label': '뒤틀기 방향 변경', onclick: () => {
          T.setWarpPreset(w.style, w.bend ?? 50, w.h ?? 0, w.v ?? 0, !w.vertical);
          render();
        } }, icon('swap', 16)),
        field('bend', '구부리기', 50),
        field('h', 'H', 0),
        field('v', 'V', 0),
      );
    }
    out.push(T.kind === 'shape' ? null : interpSel(), modes(T, render), ...finish());
    return out;
  };

  const perspBar = (T, render) => {
    live = { t: T, inputs: null };
    const out = [
      h('span.ph-tname', icon('perspWarp', 16), '원근 뒤틀기'),
      h('span.ph-opt', { style: { gap: '2px' } },
        togg(T.mode === 'layout', '레이아웃', '면마다 사각형을 그리고 모서리를 맞춥니다', () => {
          T.setMode('layout');
          render();
        }),
        togg(T.mode === 'warp', '뒤틀기', '사각형 모서리를 끌어 원근을 바꿉니다', () => {
          T.setMode('warp');
          render();
        })),
    ];
    if (T.mode === 'layout') {
      out.push(h('button.small', { disabled: T.sel < 0, title: '선택한 사각형 지우기 (Delete)', onclick: () => {
        T.removeSelected();
        render();
      } }, '사각형 지우기'));
    } else {
      out.push(
        h('button.small', { title: '거의 수평인 선을 모두 수평으로', onclick: () => T.autoStraighten('h') }, '자동 가로 직선화'),
        h('button.small', { title: '거의 수직인 선을 모두 수직으로', onclick: () => T.autoStraighten('v') }, '자동 세로 직선화'),
        h('button.small', { title: '거의 수평·수직인 선을 모두 바로', onclick: () => T.autoStraighten('both') }, '자동 가로·세로 직선화'),
        h('span.ph-opt.ph-hint', 'Shift+클릭: 가장자리 직선화'),
      );
    }
    out.push(interpSel(), ...finish());
    return out;
  };

  P.transformBar = (render) => {
    const T = P.transform;
    if (!T) return [];
    if (T.kind === 'perspwarp') return perspBar(T, render);
    if (T.mode === 'warp') return warpBar(T, render);
    return freeBar(T, render);
  };

  // ---------------------------------------------------------------- keys and menus (after every module)

  const keys = (e, mod) => {
    const T = P.transform;
    if (!T) return false;
    if (!mod && e.key.startsWith('Arrow')) {
      const s = e.shiftKey ? 10 : 1;
      T.nudge?.(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
      return true;
    }
    // Delete never clears pixels under a transform (perspective warp: removes the selected quad)
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      if (T.kind === 'perspwarp' && T.removeSelected()) P.emit('transform');
      return true;
    }
    if (e.key === 'Escape' && T.splitMode) {
      T.splitMode = null;
      P.emit('transform');
      P.redraw();
      return true;
    }
    return false;
  };
  P.extendMenus = [...(P.extendMenus || []), () => {
    const prev = P.viewKeys;
    P.viewKeys = (e, mod) => keys(e, mod) || prev?.(e, mod) || false;
    // the editor sets its right-click menu right after the menus are extended
    setTimeout(() => {
      const ctx = P.contextMenu;
      if (typeof ctx === 'function') P.contextMenu = (...a) => (P.transform ? transformMenu() : ctx(...a));
    }, 0);
    const orig = P.menus?.['편집'];
    if (!orig) return;
    P.menus['편집'] = () => {
      const items = orig();
      const i = items.findIndex((x) => typeof x === 'object' && x?.label?.startsWith('퍼펫 뒤틀기'));
      const item = { label: '원근 뒤틀기', disabled: !P.doc, action: () => C.perspectiveWarp() };
      if (i >= 0) items.splice(i + 1, 0, item);
      else items.push(item);
      return items;
    };
  }];
}
