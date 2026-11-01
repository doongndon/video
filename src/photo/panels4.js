// Photoshop's preset panels: Gradients (그레이디언트), Patterns (패턴), Styles (스타일) and Shapes
// (모양). A click uses the preset the way Photoshop does: on a gradient / pattern fill layer it changes
// that layer, otherwise it becomes the tool's current preset; the buttons (and the right-click menu)
// make a fill layer or an overlay style. Styles apply to the active layer (Shift+click adds to its
// effects); shapes pick the custom shape tool's shape or drop a shape layer in the middle.

import { h } from '../util.js';
import { toast, showMenu, promptDialog, confirmDialog, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { PhotoDoc, newLayer, makeCanvas, shapePath } from './doc.js';
import { GRADIENTS, gradientSwatch, resolveStopColor, listPatterns, patternCanvas, userPatterns, definePattern } from './resources.js';
import { FX_DEFAULTS, STYLE_PRESETS, normalizeFx } from './styles.js';
import { paintProps } from './shapes2.js';

const menuAt = (e, items) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(items, r.left, r.bottom + 2);
};
/** Long press on touch screens does what right-click does. */
function onContext(el, fn) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    fn(e.clientX, e.clientY);
  });
  let t = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    t = setTimeout(() => {
      t = null;
      el.dataset.longpress = '1';
      fn(e.clientX, e.clientY);
    }, 550);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointermove']) el.addEventListener(ev, () => clearTimeout(t));
}
const consumeLongpress = (el) => {
  if (!el.dataset.longpress) return false;
  delete el.dataset.longpress;
  return true;
};
/**
 * Drag a preset onto the picture (mouse or pen; on touch screens the menu does it): onDrop(p, layer)
 * gets the document point and the layer under it (null over an empty spot or outside the picture).
 */
function draggable(P, el, label, onDrop) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let ghost = null;
    const stageAt = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ph-stage');
    // a row of the Layers panel (like Photoshop, presets can be dropped onto a layer there)
    const rowAt = (ev) => {
      const id = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ph-layer[data-layer-id]')?.dataset.layerId;
      return (id && P.doc?.layers.find((l) => String(l.id) === id)) || null;
    };
    let lit = null;
    const light = (row) => {
      if (lit === row) return;
      lit?.classList.remove('ph-droprow');
      lit = row;
      lit?.classList.add('ph-droprow');
    };
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!ghost) {
        ghost = h('div.ph-dragghost', label);
        document.body.append(ghost);
      }
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY + 14}px`;
      const row = rowAt(ev) ? document.elementFromPoint(ev.clientX, ev.clientY).closest('.ph-layer') : null;
      light(row);
      ghost.classList.toggle('ok', (!!stageAt(ev) || !!row) && !!P.doc);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      light(null);
      if (!ghost) return;
      ghost.remove();
      const row = P.doc && rowAt(ev);
      if (row) return onDrop(null, row);
      if (!stageAt(ev) || !P.doc) return;
      const p = P.toDoc(ev.clientX, ev.clientY);
      const inside = p.x >= 0 && p.y >= 0 && p.x < P.doc.width && p.y < P.doc.height;
      onDrop(p, inside ? P.layerAt?.(p) || null : null);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  });
}
/** Where a dropped gradient or pattern goes: a layer to style, or null for a new fill layer. */
const dropTarget = (P, layer) => (layer && layer !== P.doc.layers[0] && layer.kind !== 'fill' && !layer.locked ? layer : null);
/** A shape layer takes a gradient or pattern preset as its own fill (Photoshop 2020+), one undo step. */
function fillShape(P, l, def, label) {
  P.run(label, () => {
    l.shape = { ...l.shape, ...paintProps('fill', def, P.fg, P.bg) };
    P.doc.touch(l);
  });
  toast(`모양 칠: ${def.name}`);
}

/** A group header with a twist (folders, like Photoshop 2020's preset panels). */
function folder(name, count, closed, onToggle) {
  return h('div.ph-swhead', h('button.ph-twist', { 'aria-expanded': String(!closed), 'aria-label': `${name} ${closed ? '펼치기' : '접기'}`, onclick: onToggle }, icon(closed ? 'chevronRight' : 'chevronDown', 12)), h('span', name), h('small', ` ${count}`));
}

// ---------------------------------------------------------------- gradient library

const g2 = (a, b) => [{ pos: 0, color: a }, { pos: 1, color: b }];
const g3 = (a, b, c, m = 0.5) => [{ pos: 0, color: a }, { pos: m, color: b }, { pos: 1, color: c }];
const MORE_GRADIENTS = [
  ['파랑', [
    ['g-sky', '하늘', g2('#56ccf2', '#2f80ed')], ['g-deepsea', '깊은 바다', g2('#0f2027', '#2c5364')], ['g-ice', '얼음', g3('#e0f7ff', '#8ec5fc', '#4a90e2')],
    ['g-azure', '청록 물결', g2('#00c6ff', '#0072ff')], ['g-night', '밤하늘', g3('#0b1640', '#1d2f6b', '#4a5fa8')],
  ]],
  ['자주 · 분홍', [
    ['g-violet', '보라', g2('#8e2de2', '#4a00e0')], ['g-lavender', '라벤더', g2('#e0c3fc', '#8ec5fc')], ['g-candy', '캔디', g2('#ff9a9e', '#fad0c4')],
    ['g-magenta', '자홍', g2('#ec008c', '#fc6767')], ['g-dusk', '황혼', g3('#141e30', '#7b4397', '#dc2430')],
  ]],
  ['빨강 · 주황 · 노랑', [
    ['g-fire', '불꽃', g3('#7a0000', '#ff3d00', '#ffd200', 0.55)], ['g-peach', '복숭아', g2('#ffecd2', '#fcb69f')], ['g-mango', '망고', g2('#ffe259', '#ffa751')],
    ['g-cherry', '체리', g2('#eb3349', '#f45c43')], ['g-warmflame', '따뜻한 불빛', g2('#ff9a8b', '#ff6a88')],
  ]],
  ['초록', [
    ['g-forest', '숲', g2('#134e5e', '#71b280')], ['g-lime', '라임', g2('#a8e063', '#56ab2f')], ['g-mint', '민트', g2('#d4fc79', '#96e6a1')],
    ['g-emerald', '에메랄드', g2('#11998e', '#38ef7d')],
  ]],
  ['금속', [
    ['g-silver', '은', [{ pos: 0, color: '#8e9eab' }, { pos: 0.35, color: '#eef2f3' }, { pos: 0.55, color: '#9aa5ad' }, { pos: 1, color: '#e6ebee' }]],
    ['g-rosegold', '로즈 골드', [{ pos: 0, color: '#b76e79' }, { pos: 0.5, color: '#f7d1cd' }, { pos: 1, color: '#a85d6a' }]],
    ['g-bronze', '청동', [{ pos: 0, color: '#5c3a1e' }, { pos: 0.45, color: '#d9a066' }, { pos: 0.7, color: '#7a4b23' }, { pos: 1, color: '#c08a4c' }]],
    ['g-steel', '강철', [{ pos: 0, color: '#4b5560' }, { pos: 0.5, color: '#c9d1d9' }, { pos: 0.52, color: '#56606b' }, { pos: 1, color: '#aab4bf' }]],
  ]],
  ['회색 · 투명', [
    ['g-gray', '회색 단계', g2('#2b2b2b', '#d6d6d6')], ['g-whiteclear', '흰색 → 투명', g2('#ffffff', '#ffffff'), [{ pos: 0, a: 1 }, { pos: 1, a: 0 }]],
    ['g-blackclear', '검정 → 투명', g2('#000000', '#000000'), [{ pos: 0, a: 1 }, { pos: 1, a: 0 }]], ['g-vignette', '비네트', g2('#000000', '#000000'), [{ pos: 0, a: 0 }, { pos: 0.55, a: 0 }, { pos: 1, a: 0.8 }]],
  ]],
];
const GRAD_GROUPS = () => [
  ['기본 사항', GRADIENTS.filter((g) => ['fgbg', 'fgclear', 'bw'].includes(g.id))],
  ['클래식', GRADIENTS.filter((g) => !['fgbg', 'fgclear', 'bw'].includes(g.id))],
  ...MORE_GRADIENTS.map(([name, list]) => [name, list.map(([id, n, stops, alphas]) => ({ id, name: n, stops, ...(alphas ? { alphas } : {}) }))]),
];
const userGradients = () => loadPref('photo.gradients', []);

/** A gradient with real colours (fill layers and styles keep their look when fg/bg change). */
const resolved = (g, P) => ({ ...structuredClone(g), stops: g.stops.map((s) => ({ ...s, color: resolveStopColor(s.color, P.fg, P.bg) })) });

export function buildGradientsPanel(P) {
  const el = h('div.ph-panel.ph-presetp');
  const closed = new Set(loadPref('photo.gradients.closed', []));
  let current = null;
  const toTool = (g) => {
    P.setOpt('gradient', 'custom', structuredClone(g));
    P.setOpt('gradient', 'preset', GRADIENTS.some((x) => x.id === g.id) ? g.id : 'custom');
  };
  const fillLayer = (g) => {
    if (!P.doc) return toast('문서가 없습니다');
    P.cmd.newFillLayer({ type: 'gradient', gradient: resolved(g, P), style: 'linear', angle: 90, scale: 100, reverse: false }, `${g.name} 칠`);
    // stay on the presets (making the layer opens Properties in this column)
    if (!document.body.classList.contains('mobile')) P.showPanel('gradients');
    return undefined;
  };
  const overlay = (g, l = P.doc?.active) => {
    if (!l || l.kind === 'adjust') return toast('스타일을 넣을 레이어를 고르세요');
    P.run('그레이디언트 오버레이', () => {
      l.fx = { ...normalizeFx(l.fx || {}), gradientOverlay: { ...FX_DEFAULTS.gradientOverlay, enabled: true, gradient: resolved(g, P) } };
      l._styled = null;
      P.doc.touch(l);
    });
    return undefined;
  };
  /** A click: change the selected gradient fill layer, or pick the gradient tool's gradient. */
  const use = (g) => {
    current = g;
    const l = P.doc?.active;
    if (l?.kind === 'shape' && l.shape?.type !== 'line') fillShape(P, l, { kind: 'gradient', gradient: resolved(g, P), name: g.name }, '모양 칠: 그레이디언트');
    else if (l?.kind === 'fill' && l.fill?.type === 'gradient') {
      P.run('그레이디언트 칠 바꾸기', () => {
        l.fill = { ...l.fill, gradient: resolved(g, P) };
        P.doc.touch(l);
      });
      toast(`그레이디언트 칠: ${g.name}`);
    } else {
      toTool(g);
      toast(`그레이디언트 도구: ${g.name} (G로 도구 고르기)`);
    }
    render();
  };
  const presetMenu = (g, user, x, y) => showMenu([
    { label: '그레이디언트 도구에 쓰기', action: () => { toTool(g); P.setTool('gradient'); } },
    { label: '새 그레이디언트 칠 레이어', disabled: !P.doc, action: () => fillLayer(g) },
    { label: '그레이디언트 오버레이 (레이어 스타일)', disabled: !P.doc?.active, action: () => overlay(g) },
    ...(user ? ['-',
      { label: '이름 바꾸기…', action: async () => { const v = await promptDialog('그레이디언트 이름', '이름', g.name); if (v?.trim()) { savePref('photo.gradients', userGradients().map((u) => (u.id === g.id ? { ...u, name: v.trim() } : u))); render(); } } },
      { label: '삭제', action: () => { savePref('photo.gradients', userGradients().filter((u) => u.id !== g.id)); render(); } }] : []),
  ], x, y);
  const saveCurrent = async () => {
    const o = P.opts('gradient');
    const g = o.preset === 'custom' && o.custom ? o.custom : GRADIENTS.find((x) => x.id === o.preset) || GRADIENTS[0];
    const name = await promptDialog('새 그레이디언트', '이름 (그레이디언트 도구의 지금 그레이디언트)', `내 그레이디언트 ${userGradients().length + 1}`);
    if (!name?.trim()) return;
    savePref('photo.gradients', [...userGradients(), { ...resolved(g, P), id: `ug${Date.now().toString(36)}`, name: name.trim() }]);
    render();
  };
  const render = () => {
    const groups = [...GRAD_GROUPS()];
    const mine = userGradients();
    if (mine.length) groups.unshift(['내 그레이디언트', mine]);
    el.replaceChildren(
      h('div.ph-swbar',
        h('button.small', { title: '그레이디언트 도구의 지금 그레이디언트를 저장', onclick: saveCurrent }, icon('plus', 13), ' 새 그레이디언트'),
        h('button.small', { disabled: !current, title: '고른 그레이디언트로 새 칠 레이어', onclick: () => current && fillLayer(current) }, '칠 레이어'),
        h('button.small', { disabled: !current, title: '고른 그레이디언트를 지금 레이어의 오버레이 스타일로', onclick: () => current && overlay(current) }, '오버레이')),
      ...groups.map(([name, list]) => {
        const shut = closed.has(name);
        const head = folder(name, list.length, shut, () => {
          if (shut) closed.delete(name);
          else closed.add(name);
          savePref('photo.gradients.closed', [...closed]);
          render();
        });
        const grid = shut ? null : h('div.ph-presetgrid.grad', list.map((g) => {
          const b = h(`button.ph-preset${current?.id === g.id ? '.on' : ''}`, { title: `${g.name}\n클릭: ${P.doc?.active?.fill?.type === 'gradient' ? '고른 칠 레이어에 적용' : '그레이디언트 도구에 쓰기'} · 오른쪽 클릭: 메뉴`, 'aria-label': g.name }, gradientSwatch(g, 64, 24, P.fg, P.bg));
          b.addEventListener('click', () => !consumeLongpress(b) && use(g));
          b.addEventListener('dblclick', () => fillLayer(g));
          // onto the picture: a layer under the pointer gets an overlay, elsewhere a fill layer
          draggable(P, b, g.name, (p, layer) => {
            const t = dropTarget(P, layer);
            if (t?.kind === 'shape' && t.shape?.type !== 'line') fillShape(P, t, { kind: 'gradient', gradient: resolved(g, P), name: g.name }, '모양 칠: 그레이디언트');
            else if (t) overlay(g, t);
            else fillLayer(g);
          });
          onContext(b, (x, y) => presetMenu(g, name === '내 그레이디언트', x, y));
          return b;
        }));
        return h('div.ph-swgroup', head, grid);
      }),
      h('div.note', '클릭: 고른 그레이디언트 칠 레이어를 바꾸거나 그레이디언트 도구에 씀 · 두 번 클릭: 새 칠 레이어 · 그림 속 레이어로 끌어 놓기: 그레이디언트 오버레이 (빈 곳: 칠 레이어) · 오른쪽 클릭(길게 누르기): 메뉴'));
  };
  // swatches that use the foreground / background colours follow them
  P.on('color', () => el.isConnected && render());
  // gradients saved in the Gradient Editor or imported from .grd files (gradedit.js)
  P.on('gradients', render);
  render();
  return el;
}

// ---------------------------------------------------------------- patterns

const IMPORTED = 'photo.patterns.imported';
/** Patterns imported from .pat files in earlier visits (kept in this browser). */
function loadImportedPatterns(P) {
  for (const sp of loadPref(IMPORTED, [])) {
    if (userPatterns.has(sp.id)) continue;
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      userPatterns.set(sp.id, { name: sp.name, canvas: c });
      // fill layers and styles that use it were drawn with a stand-in until now
      for (const d of P.docs || []) {
        for (const l of d.layers) {
          if (l.fill?.pattern === sp.id || Object.values(l.fx || {}).some((e) => e?.pattern === sp.id)) {
            l._fillc = null;
            l._styled = null;
            d.touch(l);
          }
        }
      }
      P.emit('patterns');
      P.redraw?.();
    };
    img.src = sp.data;
  }
}
/** Photoshop pattern files (.pat) into the pattern list (and this browser). */
async function importPatFiles(P) {
  const { pickFiles } = await import('../ui/project-panel.js');
  const files = await pickFiles({ accept: '.pat', multiple: true });
  let n = 0;
  for (const f of files) {
    try {
      const { parsePat } = await import('./psdres.js');
      const list = parsePat(await f.arrayBuffer());
      const saved = loadPref(IMPORTED, []);
      for (const p of list) {
        let c = makeCanvas(p.w, p.h);
        c.getContext('2d').putImageData(new ImageData(Uint8ClampedArray.from(p.rgba), p.w, p.h), 0, 0);
        // kept at most 512 px in the browser's storage
        const k = Math.min(1, 512 / Math.max(p.w, p.h));
        if (k < 1) {
          const t = makeCanvas(Math.max(1, Math.round(p.w * k)), Math.max(1, Math.round(p.h * k)));
          const tg = t.getContext('2d');
          tg.imageSmoothingQuality = 'high';
          tg.drawImage(c, 0, 0, t.width, t.height);
          c = t;
        }
        const name = String(p.name || f.name).slice(0, 40);
        const id = definePattern(c, name);
        saved.push({ id, name, data: c.toDataURL('image/png') });
        n++;
      }
      savePref(IMPORTED, saved.slice(-60));
    } catch (err) {
      toast(`${f.name}: ${err?.message || '패턴 파일로 읽을 수 없습니다'}`);
    }
  }
  if (n) {
    toast(`패턴 ${n}개를 가져왔습니다`);
    P.emit('patterns');
  }
}

export function buildPatternsPanel(P) {
  const el = h('div.ph-panel.ph-presetp');
  loadImportedPatterns(P);
  if (!P.cmd.importPatterns) P.cmd.importPatterns = () => importPatFiles(P);
  let current = null;
  let scale = loadPref('photo.patterns.scale', 100);
  const toTools = (id) => {
    for (const t of ['bucket', 'patternStamp']) {
      try {
        P.setOpt(t, 'pattern', id);
      } catch { /* the tool isn't there */ }
    }
    try {
      P.setOpt('bucket', 'fill', 'pattern');
    } catch { /* no bucket */ }
  };
  const fillLayer = (p) => {
    if (!P.doc) return toast('문서가 없습니다');
    P.cmd.newFillLayer({ type: 'pattern', pattern: p.id, scale }, `${p.name} 칠`);
    if (!document.body.classList.contains('mobile')) P.showPanel('patterns');
    return undefined;
  };
  const overlay = (p, l = P.doc?.active) => {
    if (!l || l.kind === 'adjust') return toast('스타일을 넣을 레이어를 고르세요');
    P.run('패턴 오버레이', () => {
      l.fx = { ...normalizeFx(l.fx || {}), patternOverlay: { ...FX_DEFAULTS.patternOverlay, enabled: true, pattern: p.id, scale } };
      l._styled = null;
      P.doc.touch(l);
    });
    return undefined;
  };
  const use = (p) => {
    current = p;
    const l = P.doc?.active;
    if (l?.kind === 'shape' && l.shape?.type !== 'line') fillShape(P, l, { kind: 'pattern', pattern: p.id, scale, name: p.name }, '모양 칠: 패턴');
    else if (l?.kind === 'fill' && l.fill?.type === 'pattern') {
      P.run('패턴 칠 바꾸기', () => {
        l.fill = { ...l.fill, pattern: p.id };
        P.doc.touch(l);
      });
      toast(`패턴 칠: ${p.name}`);
    } else {
      toTools(p.id);
      toast(`페인트 통·패턴 도장의 패턴: ${p.name}`);
    }
    render();
  };
  const tile = (id) => {
    const src = patternCanvas(id);
    const c = makeCanvas(48, 48);
    const g = c.getContext('2d');
    const k = Math.min(1, 48 / Math.max(src.width, src.height)) * 0.999;
    const t = makeCanvas(Math.max(1, Math.round(src.width * Math.max(k, 0.25))), Math.max(1, Math.round(src.height * Math.max(k, 0.25))));
    t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
    g.fillStyle = g.createPattern(t, 'repeat');
    g.fillRect(0, 0, 48, 48);
    return c;
  };
  const presetMenu = (p, x, y) => showMenu([
    { label: '페인트 통 · 패턴 도장에 쓰기', action: () => toTools(p.id) },
    { label: '새 패턴 칠 레이어', disabled: !P.doc, action: () => fillLayer(p) },
    { label: '패턴 오버레이 (레이어 스타일)', disabled: !P.doc?.active, action: () => overlay(p) },
    ...(p.id.startsWith('user:') ? ['-', { label: '삭제 (이 브라우저에서)', action: async () => {
      if (!(await confirmDialog('패턴 삭제', `"${p.name}" 패턴을 지울까요? 이미 쓴 칠 레이어는 문서를 닫으면 기본 패턴으로 보일 수 있습니다.`))) return;
      userPatterns.delete(p.id);
      savePref('photo.patterns', loadPref('photo.patterns', []).filter((x) => x.id !== p.id));
      savePref(IMPORTED, loadPref(IMPORTED, []).filter((x) => x.id !== p.id));
      render();
    } }] : []),
  ], x, y);
  const scaleIn = h('input.ph-num', { type: 'number', min: 1, max: 1000, value: scale, 'aria-label': '비율 (%)', title: '칠 레이어 · 오버레이의 패턴 크기 (%)' });
  scaleIn.addEventListener('change', () => {
    scale = Math.max(1, Math.min(1000, Math.round(+scaleIn.value || 100)));
    scaleIn.value = scale;
    savePref('photo.patterns.scale', scale);
  });
  const render = () => {
    const all = listPatterns();
    const builtin = all.filter((p) => !p.id.startsWith('user:') && !userPatterns.has(p.id));
    const mine = all.filter((p) => p.id.startsWith('user:') || userPatterns.has(p.id));
    const group = (name, list) => h('div.ph-swgroup', h('div.ph-swhead', h('span', name), h('small', ` ${list.length}`)), h('div.ph-presetgrid', list.map((p) => {
      const b = h(`button.ph-preset.pat${current?.id === p.id ? '.on' : ''}`, { title: `${p.name}\n클릭: 고른 패턴 칠 레이어를 바꾸거나 도구에 씀 · 두 번 클릭: 새 칠 레이어`, 'aria-label': p.name }, tile(p.id));
      b.addEventListener('click', () => !consumeLongpress(b) && use(p));
      b.addEventListener('dblclick', () => fillLayer(p));
      draggable(P, b, p.name, (pt, layer) => {
        const t = dropTarget(P, layer);
        if (t?.kind === 'shape' && t.shape?.type !== 'line') fillShape(P, t, { kind: 'pattern', pattern: p.id, scale, name: p.name }, '모양 칠: 패턴');
        else if (t) overlay(p, t);
        else fillLayer(p);
      });
      onContext(b, (x, y) => presetMenu(p, x, y));
      return b;
    })));
    el.replaceChildren(
      h('div.ph-swbar',
        h('button.small', { title: '선택 영역(없으면 보이는 그림 전체)으로 새 패턴 만들기 (편집 ▸ 패턴 정의)', disabled: !P.doc, onclick: () => P.cmd.definePattern?.() }, icon('plus', 13), ' 패턴 정의'),
        h('button.small', { title: '포토샵 패턴 파일(.pat) 가져오기', onclick: () => P.cmd.importPatterns() }, '가져오기…'),
        h('button.small', { disabled: !current, onclick: () => current && fillLayer(current) }, '칠 레이어'),
        h('button.small', { disabled: !current, onclick: () => current && overlay(current) }, '오버레이'),
        h('label.ph-prow', h('span', '비율'), scaleIn, h('small', '%'))),
      ...(mine.length ? [group('내 패턴', mine)] : []),
      group('기본 패턴', builtin),
      h('div.note', '클릭: 고른 패턴 칠 레이어를 바꾸거나 페인트 통·패턴 도장에 씀 · 두 번 클릭: 새 칠 레이어 · 그림 속 레이어로 끌어 놓기: 패턴 오버레이 (빈 곳: 칠 레이어) · 오른쪽 클릭: 메뉴'));
  };
  // Edit ▸ Define Pattern (and imported .pat files) announce new patterns with 'opts' / 'patterns'
  P.on('opts', () => el.isConnected && render());
  P.on('patterns', render);
  P.on('doc', render);
  render();
  return el;
}

// ---------------------------------------------------------------- styles

const D = FX_DEFAULTS;
const grad = (stops) => ({ stops });
/** A library of layer styles, ready for text and shapes about 60–200 px tall. */
const MORE_STYLES = [
  ['버튼 · 유리', [
    ['glossy-blue', '광택 버튼 (파랑)', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#1e5fbf' }, { pos: 0.5, color: '#3d8bfd' }, { pos: 0.52, color: '#2a74e6' }, { pos: 1, color: '#7fb6ff' }]) }, innerGlow: { ...D.innerGlow, color: '#ffffff', opacity: 0.35, size: 6, blend: 'screen' }, stroke: { ...D.stroke, color: '#0d3d82', size: 2, position: 'inside' }, dropShadow: { ...D.dropShadow, opacity: 0.45, distance: 4, size: 8 } }],
    ['glossy-red', '광택 버튼 (빨강)', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#a3121c' }, { pos: 0.5, color: '#e8333e' }, { pos: 0.52, color: '#cf2330' }, { pos: 1, color: '#ff8a8f' }]) }, innerGlow: { ...D.innerGlow, color: '#ffffff', opacity: 0.3, size: 6, blend: 'screen' }, stroke: { ...D.stroke, color: '#6e0a11', size: 2, position: 'inside' }, dropShadow: { ...D.dropShadow, opacity: 0.45, distance: 4, size: 8 } }],
    ['glossy-green', '광택 버튼 (초록)', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#1d7a2c' }, { pos: 0.5, color: '#3fbf55' }, { pos: 0.52, color: '#2fa845' }, { pos: 1, color: '#9be9a8' }]) }, bevel: { ...D.bevel, size: 6, soften: 2, depth: 120 }, dropShadow: { ...D.dropShadow, opacity: 0.4, distance: 3, size: 6 } }],
    ['glass', '유리', { colorOverlay: { ...D.colorOverlay, color: '#bfe6ff', opacity: 0.25 }, bevel: { ...D.bevel, size: 14, soften: 6, highlightOpacity: 0.95, shadowOpacity: 0.35 }, innerGlow: { ...D.innerGlow, color: '#ffffff', opacity: 0.6, size: 12 }, stroke: { ...D.stroke, color: '#ffffff', size: 1, opacity: 0.6, position: 'inside' }, dropShadow: { ...D.dropShadow, opacity: 0.25, distance: 6, size: 14 } }],
    ['plastic', '플라스틱', { colorOverlay: { ...D.colorOverlay, color: '#ff8c1a' }, bevel: { ...D.bevel, technique: 'smooth', size: 10, soften: 4, depth: 150, highlightOpacity: 0.9 }, satin: { ...D.satin, color: '#ffffff', blend: 'screen', opacity: 0.25 } }],
    ['ice', '얼음', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#bfe9ff' }, { pos: 1, color: '#ffffff' }]) }, bevel: { ...D.bevel, technique: 'chisel hard', size: 8, depth: 200 }, innerShadow: { ...D.innerShadow, color: '#2a7ab0', opacity: 0.5, distance: 2, size: 6 }, outerGlow: { ...D.outerGlow, color: '#9fdcff', size: 10, opacity: 0.6 } }],
  ]],
  ['네온 · 빛', [
    ['neon-pink', '네온 (분홍)', { colorOverlay: { ...D.colorOverlay, color: '#ffe3f4' }, innerGlow: { ...D.innerGlow, color: '#ff2fb3', size: 6, opacity: 0.9, blend: 'normal' }, outerGlow: { ...D.outerGlow, color: '#ff2fb3', size: 26, spread: 8, opacity: 0.95, blend: 'screen' } }],
    ['neon-green', '네온 (초록)', { colorOverlay: { ...D.colorOverlay, color: '#e9ffe6' }, innerGlow: { ...D.innerGlow, color: '#39ff14', size: 6, opacity: 0.9, blend: 'normal' }, outerGlow: { ...D.outerGlow, color: '#39ff14', size: 26, spread: 8, opacity: 0.95, blend: 'screen' } }],
    ['neon-blue', '네온 (파랑)', { colorOverlay: { ...D.colorOverlay, color: '#e6f6ff' }, innerGlow: { ...D.innerGlow, color: '#1fb6ff', size: 6, opacity: 0.9, blend: 'normal' }, outerGlow: { ...D.outerGlow, color: '#1fb6ff', size: 26, spread: 8, opacity: 0.95, blend: 'screen' } }],
    ['fire-glow', '불꽃 광선', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#ff3d00' }, { pos: 1, color: '#ffd200' }]) }, outerGlow: { ...D.outerGlow, color: '#ff6a00', size: 22, spread: 4, opacity: 0.9 }, innerGlow: { ...D.innerGlow, color: '#fff3b0', size: 5, opacity: 0.8 } }],
    ['soft-glow', '부드러운 광선', { outerGlow: { ...D.outerGlow, color: '#ffffff', size: 18, opacity: 0.8 } }],
    ['halo', '후광 (어두운 배경용)', { outerGlow: { ...D.outerGlow, color: '#fff7c2', size: 40, spread: 15, opacity: 0.7 }, stroke: { ...D.stroke, color: '#fff7c2', size: 2 } }],
  ]],
  ['금속', [
    ['gold-bevel', '금 (경사)', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#7a5a12' }, { pos: 0.3, color: '#f7e08a' }, { pos: 0.5, color: '#b8862a' }, { pos: 0.75, color: '#fff2b3' }, { pos: 1, color: '#8c6a1f' }]) }, bevel: { ...D.bevel, technique: 'chisel hard', size: 7, depth: 250, highlightOpacity: 0.85 }, stroke: { ...D.stroke, color: '#5a4010', size: 2 }, dropShadow: { ...D.dropShadow, opacity: 0.5, distance: 5, size: 8 } }],
    ['chrome', '크롬', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#294f6d' }, { pos: 0.45, color: '#f2f2f2' }, { pos: 0.5, color: '#3d2a1b' }, { pos: 0.75, color: '#c7a37d' }, { pos: 1, color: '#ffffff' }]) }, bevel: { ...D.bevel, size: 6, depth: 200 }, stroke: { ...D.stroke, color: '#9aa4ad', size: 2, position: 'inside' }, dropShadow: { ...D.dropShadow, opacity: 0.45 } }],
    ['silver', '은', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#8e9eab' }, { pos: 0.35, color: '#eef2f3' }, { pos: 0.55, color: '#9aa5ad' }, { pos: 1, color: '#e6ebee' }]) }, bevel: { ...D.bevel, size: 5, depth: 150 }, dropShadow: { ...D.dropShadow, opacity: 0.4, distance: 3, size: 5 } }],
    ['bronze', '청동', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#5c3a1e' }, { pos: 0.45, color: '#d9a066' }, { pos: 0.7, color: '#7a4b23' }, { pos: 1, color: '#c08a4c' }]) }, bevel: { ...D.bevel, technique: 'chisel soft', size: 6, depth: 180 }, dropShadow: { ...D.dropShadow, opacity: 0.45 } }],
    ['rose-gold', '로즈 골드', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#b76e79' }, { pos: 0.5, color: '#f7d1cd' }, { pos: 1, color: '#a85d6a' }]) }, bevel: { ...D.bevel, size: 5, depth: 120, soften: 2 }, dropShadow: { ...D.dropShadow, opacity: 0.35, distance: 3, size: 6 } }],
  ]],
  ['글자', [
    ['retro-80s', '레트로 80년대', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#1b1464' }, { pos: 0.48, color: '#00d2ff' }, { pos: 0.5, color: '#ffffff' }, { pos: 0.52, color: '#2b0a3d' }, { pos: 1, color: '#ff2fb3' }]) }, stroke: { ...D.stroke, color: '#ffffff', size: 2 }, outerGlow: { ...D.outerGlow, color: '#ff2fb3', size: 16, opacity: 0.8 } }],
    ['retro-shadow', '레트로 그림자 (두 겹)', { stroke: { ...D.stroke, color: '#1d1d1d', size: 3 }, dropShadow: { ...D.dropShadow, color: '#ffb000', blend: 'normal', opacity: 1, distance: 6, size: 0, angle: 135 }, dropShadow_2: { ...D.dropShadow, color: '#e63946', blend: 'normal', opacity: 1, distance: 12, size: 0, angle: 135 } }],
    ['comic', '만화 (굵은 외곽선)', { colorOverlay: { ...D.colorOverlay, color: '#ffde00' }, stroke: { ...D.stroke, color: '#000000', size: 8 }, dropShadow: { ...D.dropShadow, color: '#000000', blend: 'normal', opacity: 1, distance: 8, size: 0, angle: 135 } }],
    ['double-stroke', '이중 외곽선', { stroke: { ...D.stroke, color: '#ffffff', size: 4 }, stroke_2: { ...D.stroke, color: '#e63946', size: 9 }, dropShadow: { ...D.dropShadow, opacity: 0.4, distance: 4, size: 6 } }],
    ['letterpress', '레터프레스 (찍힌 글자)', { innerShadow: { ...D.innerShadow, opacity: 0.6, distance: 2, size: 3 }, dropShadow: { ...D.dropShadow, color: '#ffffff', blend: 'screen', opacity: 0.55, distance: 1, size: 0, angle: 90 } }],
    ['long-shadow', '긴 그림자', { dropShadow: { ...D.dropShadow, color: '#000000', blend: 'multiply', opacity: 0.35, distance: 18, spread: 60, size: 6, angle: 135 } }],
    ['outline-only', '외곽선만', { stroke: { ...D.stroke, color: '#ffffff', size: 3 } }],
    ['candy', '캔디', { gradientOverlay: { ...D.gradientOverlay, gradient: grad([{ pos: 0, color: '#ff6fb5' }, { pos: 1, color: '#ffd1e8' }]) }, bevel: { ...D.bevel, size: 10, soften: 5, depth: 140 }, stroke: { ...D.stroke, color: '#ffffff', size: 5 }, dropShadow: { ...D.dropShadow, color: '#b3005e', opacity: 0.5, distance: 5, size: 8 } }],
  ]],
  ['외곽선 · 그림자', [
    ['stroke-shadow-white', '흰 외곽선 + 그림자', { stroke: { ...D.stroke, color: '#ffffff', size: 6 }, dropShadow: { ...D.dropShadow, opacity: 0.6, distance: 6, size: 10 } }],
    ['stroke-shadow-black', '검정 외곽선 + 그림자', { stroke: { ...D.stroke, color: '#000000', size: 5 }, dropShadow: { ...D.dropShadow, opacity: 0.5, distance: 5, size: 8 } }],
    ['thumb-yellow', '썸네일 글자 (노랑 + 검정)', { colorOverlay: { ...D.colorOverlay, color: '#ffe600' }, stroke: { ...D.stroke, color: '#000000', size: 10 }, dropShadow: { ...D.dropShadow, opacity: 0.8, distance: 8, size: 12 } }],
    ['hard-shadow', '딱딱한 그림자', { dropShadow: { ...D.dropShadow, blend: 'normal', opacity: 0.85, distance: 8, size: 0, angle: 135 } }],
    ['floating', '떠 있는 그림자', { dropShadow: { ...D.dropShadow, opacity: 0.35, distance: 20, size: 30, angle: 90 } }],
    ['gradient-stroke', '그레이디언트 외곽선', { stroke: { ...D.stroke, size: 6, fillType: 'gradient', gradient: grad([{ pos: 0, color: '#ff6a00' }, { pos: 1, color: '#ee0979' }]) } }],
  ]],
  ['엠보스 · 질감', [
    ['emboss-soft', '부드러운 엠보스', { bevel: { ...D.bevel, size: 8, soften: 4, depth: 100 } }],
    ['emboss-chisel', '조각 (끌)', { bevel: { ...D.bevel, technique: 'chisel hard', size: 6, depth: 300 } }],
    ['stamp', '도장 (안으로 눌린)', { bevel: { ...D.bevel, direction: 'down', size: 6, depth: 150 }, innerShadow: { ...D.innerShadow, opacity: 0.4, distance: 2, size: 4 } }],
    ['stone', '돌', { patternOverlay: { ...D.patternOverlay, pattern: 'noise', blend: 'multiply', opacity: 0.6 }, colorOverlay: { ...D.colorOverlay, color: '#8a8f94' }, bevel: { ...D.bevel, technique: 'chisel soft', size: 6, depth: 200 }, dropShadow: { ...D.dropShadow, opacity: 0.5 } }],
    ['paper-cut', '종이 오리기', { patternOverlay: { ...D.patternOverlay, pattern: 'paper' }, dropShadow: { ...D.dropShadow, opacity: 0.35, distance: 3, size: 6 }, innerShadow: { ...D.innerShadow, color: '#ffffff', blend: 'screen', opacity: 0.4, distance: 1, size: 1 } }],
    ['denim', '청 (줄무늬)', { colorOverlay: { ...D.colorOverlay, color: '#2f4f7f' }, patternOverlay: { ...D.patternOverlay, pattern: 'stripes', blend: 'overlay', opacity: 0.35, scale: 50 }, stroke: { ...D.stroke, color: '#e8c46b', size: 2, position: 'inside' } }],
  ]],
];

/** A small picture of a style on a rounded square, drawn with the real effects engine. */
const styleThumbs = new Map();
// drawing every style's picture when the editor started took most of its start-up time: each one is
// drawn once it first comes into view, a few at a time when the browser is idle
const thumbQueue = [];
let thumbTimer = 0;
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 300 }) : setTimeout(() => fn(null), 16));
function drainThumbs(deadline) {
  thumbTimer = 0;
  const until = performance.now() + 12;
  do {
    const [t, fx] = thumbQueue.shift();
    t.getContext('2d').drawImage(drawStyleThumb(fx), 0, 0);
  } while (thumbQueue.length && (deadline && !deadline.didTimeout ? deadline.timeRemaining() > 2 : performance.now() < until));
  if (thumbQueue.length) thumbTimer = idle(drainThumbs);
}
const thumbSeen = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbSeen.unobserve(e.target);
    thumbQueue.push([e.target, e.target._fx]);
    e.target._fx = null;
  }
  if (thumbQueue.length && !thumbTimer) thumbTimer = idle(drainThumbs);
}) : null;
function styleThumb(key, fx) {
  if (styleThumbs.has(key)) return styleThumbs.get(key);
  if (!thumbSeen) {
    styleThumbs.set(key, drawStyleThumb(fx));
    return styleThumbs.get(key);
  }
  const t = makeCanvas(56, 56);
  t._fx = fx;
  thumbSeen.observe(t);
  styleThumbs.set(key, t);
  return t;
}
function drawStyleThumb(fx) {
  const S = 128;
  const doc = new PhotoDoc({ width: S, height: S, background: '#f0f0f0' });
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#7f7f7f';
  g.beginPath();
  if (g.roundRect) g.roundRect(26, 26, 76, 76, 14);
  else g.rect(26, 26, 76, 76);
  g.fill();
  const l = newLayer('raster', { name: 'thumb', canvas: c, fx: normalizeFx(structuredClone(fx || {})) });
  doc.layers.push(l);
  doc.activeId = l.id;
  let out;
  try {
    out = doc.flatten({ fg: '#000000', bg: '#ffffff' });
  } catch {
    out = c;
  }
  const t = makeCanvas(56, 56);
  const tg = t.getContext('2d');
  tg.imageSmoothingQuality = 'high';
  tg.drawImage(out, 0, 0, 56, 56);
  return t;
}
const userStylesList = () => {
  try {
    return JSON.parse(localStorage.getItem('montage.photo.styles') || '[]');
  } catch {
    return [];
  }
};
const saveUserStyles = (list) => {
  try {
    localStorage.setItem('montage.photo.styles', JSON.stringify(list));
  } catch {
    toast('브라우저 저장 공간이 모자라 스타일을 저장하지 못했습니다');
  }
};
/** Every built-in style: [group name, [{ id, name, fx }]]. */
export const STYLE_LIBRARY = () => [
  ['기본', STYLE_PRESETS.filter((s) => s.id !== 'none')],
  ...MORE_STYLES.map(([name, list]) => [name, list.map(([id, n, fx]) => ({ id: `lib-${id}`, name: n, fx }))]),
];

export function buildStylesPanel(P) {
  const el = h('div.ph-panel.ph-presetp');
  const closed = new Set(loadPref('photo.styles.closed', []));
  /** Click: the layer's effects become the style's; Shift+click adds them to the layer's own. */
  const apply = (st, add = false, l = P.doc?.active) => {
    const doc = P.doc;
    if (!l) return toast('스타일을 넣을 레이어를 고르세요');
    if (l.kind === 'adjust') return toast('조정 레이어에는 스타일을 넣을 수 없습니다');
    if (l.locked) return toast('잠긴 레이어입니다 (레이어 패널에서 잠금 해제)');
    P.run(`스타일: ${st.name}`, () => {
      const fx = normalizeFx(structuredClone(st.fx || {}));
      l.fx = add ? { ...normalizeFx(l.fx || {}), ...fx } : fx;
      // a style saved with "레이어 혼합 옵션 포함" (Layer Style ▸ 새 스타일) also sets those
      if (st.blending && !add) Object.assign(l, structuredClone(st.blending));
      l._styled = null;
      doc.touch(l);
    });
    toast(`스타일 적용: ${st.name}${add ? ' (기존 효과에 더함)' : ''}`);
    return undefined;
  };
  P.applyStylePreset = apply;
  const clear = () => {
    const l = P.doc?.active;
    if (!l || !l.fx || !Object.keys(l.fx).length) return toast('지울 스타일이 없습니다');
    P.run('레이어 스타일 지우기', () => {
      l.fx = {};
      l._styled = null;
      P.doc.touch(l);
    });
    return undefined;
  };
  const saveNew = async () => {
    const l = P.doc?.active;
    if (!l?.fx || !Object.values(l.fx).some((e) => e?.enabled)) return toast('효과가 있는 레이어를 고르세요 (레이어 ▸ 레이어 스타일)');
    const name = await promptDialog('새 스타일', '스타일 이름', `${l.name} 스타일`);
    if (!name?.trim()) return undefined;
    saveUserStyles([...userStylesList(), { id: `u${Date.now()}`, name: name.trim(), fx: structuredClone(l.fx) }]);
    render();
    toast(`스타일 "${name.trim()}"을(를) 저장했습니다`);
    return undefined;
  };
  const render = () => {
    const groups = [...STYLE_LIBRARY()];
    const mine = userStylesList();
    if (mine.length) groups.unshift(['내 스타일', mine]);
    el.replaceChildren(
      h('div.ph-swbar',
        h('button.small', { title: '지금 레이어의 효과를 새 스타일로 저장', onclick: saveNew }, icon('plus', 13), ' 새 스타일'),
        h('button.small', { title: '지금 레이어의 효과를 모두 지움', onclick: clear }, '스타일 지우기'),
        h('button.small', { title: '레이어 스타일 대화 상자 열기', onclick: () => P.cmd.layerStyle?.('blending') }, '레이어 스타일…')),
      ...groups.map(([name, list]) => {
        const shut = closed.has(name);
        const head = folder(name, list.length, shut, () => {
          if (shut) closed.delete(name);
          else closed.add(name);
          savePref('photo.styles.closed', [...closed]);
          render();
        });
        const grid = shut ? null : h('div.ph-presetgrid.styles', list.map((st) => {
          const b = h('button.ph-preset.sty', { title: `${st.name}\n클릭: 지금 레이어에 적용 · Shift+클릭: 기존 효과에 더하기`, 'aria-label': st.name }, styleThumb(`${name}:${st.id}:${JSON.stringify(st.fx).length}`, st.fx), h('span', st.name));
          b.addEventListener('click', (e) => !consumeLongpress(b) && apply(st, e.shiftKey));
          // onto a layer in the picture: that layer takes the style
          draggable(P, b, st.name, (pt, layer) => {
            if (layer && layer !== P.doc.active) P.selectLayer?.(layer.id);
            apply(st, false, layer || P.doc.active);
          });
          onContext(b, (x, y) => showMenu([
            { label: '지금 레이어에 적용', action: () => apply(st) },
            { label: '기존 효과에 더하기', action: () => apply(st, true) },
            ...(name === '내 스타일' ? ['-',
              { label: '이름 바꾸기…', action: async () => { const v = await promptDialog('스타일 이름', '이름', st.name); if (v?.trim()) { saveUserStyles(userStylesList().map((u) => (u.id === st.id ? { ...u, name: v.trim() } : u))); render(); } } },
              { label: '삭제', action: () => { saveUserStyles(userStylesList().filter((u) => u.id !== st.id)); render(); } }] : []),
          ], x, y));
          return b;
        }));
        return h('div.ph-swgroup', head, grid);
      }),
      h('div.note', '클릭: 지금 레이어에 스타일 적용 (기존 효과 대신) · Shift+클릭: 더하기 · 그림 속 레이어로 끌어 놓기: 그 레이어에 적용'));
  };
  // the layer style dialog can save new styles: show them when this panel is drawn again
  P.on('styles', render);
  render();
  return el;
}

// ---------------------------------------------------------------- shapes

export function buildShapesPanel(P) {
  const el = h('div.ph-panel.ph-presetp');
  const thumbs = new Map();
  const thumb = (id) => {
    if (thumbs.has(id)) return thumbs.get(id);
    const c = makeCanvas(40, 40);
    const g = c.getContext('2d');
    try {
      const p = shapePath({ type: 'custom', custom: id, w: 34, h: 34 });
      g.translate(3, 3);
      g.fillStyle = '#d7dbe0';
      if (p) g.fill(p, 'evenodd');
    } catch { /* a shape that can't be drawn: an empty tile */ }
    thumbs.set(id, c);
    return c;
  };
  const pick = (id) => {
    P.setTool('shape');
    P.setOpt('shape', 'type', 'custom');
    P.setOpt('shape', 'custom', id);
    if (P.opts('shape').mode === 'pixels') P.setOpt('shape', 'mode', 'shape');
  };
  /** A shape layer of this shape in the middle of the picture (a third of its size). */
  const place = (id, name, at = null) => {
    const doc = P.doc;
    if (!doc) return toast('문서가 없습니다');
    const s = Math.max(8, Math.round(Math.min(doc.width, doc.height) / 3));
    const o = P.opts('shape');
    const c = at || { x: doc.width / 2, y: doc.height / 2 };
    P.run('모양 추가', () => {
      const l = newLayer('shape', {
        name: name || '모양',
        shape: { type: 'custom', custom: id, sides: o.sides ?? 5, w: s, h: s, fill: P.fg, stroke: null, strokeWidth: 0, radius: o.radius ?? 0 },
        x: Math.round(c.x - s / 2),
        y: Math.round(c.y - s / 2),
      });
      P.addLayer(l);
    });
    return undefined;
  };
  const render = () => {
    const list = P.customShapeList ? P.customShapeList() : [];
    const cur = P.opts('shape');
    el.replaceChildren(
      h('div.ph-presetgrid.shapes', list.map(([id, name]) => {
        const b = h(`button.ph-preset.shp${cur.type === 'custom' && cur.custom === id ? '.on' : ''}`, { title: `${name}\n클릭: 사용자 정의 모양 도구에 쓰기 · 두 번 클릭: 가운데에 모양 레이어 넣기`, 'aria-label': name }, thumb(id));
        b.addEventListener('click', () => {
          if (consumeLongpress(b)) return;
          pick(id);
          render();
        });
        b.addEventListener('dblclick', () => place(id, name));
        draggable(P, b, name, (p) => place(id, name, p));
        onContext(b, (x, y) => showMenu([
          { label: '모양 도구에 쓰기', action: () => { pick(id); render(); } },
          { label: '가운데에 모양 레이어 넣기 (전경색)', disabled: !P.doc, action: () => place(id, name) },
        ], x, y));
        return b;
      })),
      ...(list.length ? [] : [h('div.empty-hint', '모양이 없습니다')]),
      h('div.note', '클릭: 모양 도구(U)로 그릴 모양을 고름 · 두 번 클릭: 전경색으로 가운데에 넣기 · 그림으로 끌어 놓기: 그 자리에 넣기'));
  };
  P.on('tool', () => el.isConnected && render());
  P.on('opts', () => el.isConnected && render());
  render();
  return el;
}

// ---------------------------------------------------------------- install

export function installPanels4(P) {
  P.addPanel('gradients', '그레이디언트', buildGradientsPanel(P), 'top');
  P.addPanel('patterns', '패턴', buildPatternsPanel(P), 'top');
  P.addPanel('styles', '스타일', buildStylesPanel(P), 'top');
  P.addPanel('shapes', '모양', buildShapesPanel(P), 'top');
  // Window menu: next to Swatches, like Photoshop's preset panels
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['창'];
    if (!orig) return;
    P.menus['창'] = () => {
      const items = orig();
      const i = items.findIndex((x) => typeof x === 'object' && x?.label === '견본');
      const add = [['gradients', '그레이디언트'], ['patterns', '패턴'], ['shapes', '모양'], ['styles', '스타일']].map(([id, label]) => ({ label, action: () => P.showPanel(id) }));
      items.splice(i >= 0 ? i + 1 : items.length, 0, ...add);
      return items;
    };
  }];
}
