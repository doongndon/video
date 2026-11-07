// More photo panels: Paths, Character, Paragraph, Character Styles, Paragraph Styles, and the text
// warp dialog.

import { h, clamp } from '../util.js';
import { showMenu, openModal, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { openFontPicker } from '../ui/font-picker.js';
import { fontLabel } from '../fonts.js';
import { makeCanvas } from './doc.js';
import { toPath2D } from './paths.js';
import { WARP_STYLES } from './transform.js';
import { AA_MODES, ALIGNS } from './type.js';
import { installType2 } from './type2.js';

// panel styles of this module (kept here so the shared stylesheet stays untouched)
function injectCss() {
  if (document.getElementById('tp-css')) return;
  const s = document.createElement('style');
  s.id = 'tp-css';
  s.textContent = `
.tp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
.tp-f { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: var(--fs-s); color: var(--text-dim); }
.tp-f > .tp-ic { flex: 0 0 auto; width: 26px; text-align: center; font-size: 11px; color: var(--text-faint); white-space: nowrap; }
.tp-f input.ph-num, .tp-f select { flex: 1; min-width: 0; width: auto; }
.tp-f input[type=color] { flex: 1; min-width: 0; height: 26px; padding: 0 2px; }
.tp-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.tp-row > button.small { min-width: 30px; padding: 0 6px; }
.tp-tog { font-family: Georgia, 'Noto Serif KR', serif; font-size: 13px; }
.tp-tog.on, .tp-al.on { background: var(--accent-soft); border-color: var(--accent); color: var(--value); }
.tp-full { grid-column: 1 / -1; }
.tp-font { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.tp-note { font-size: var(--fs-xs); color: var(--text-faint); }
.tp-styles { display: flex; flex-direction: column; min-height: 120px; }
.tp-slist { flex: 1; overflow: auto; display: flex; flex-direction: column; }
.tp-srow { display: flex; align-items: center; gap: 6px; padding: 5px 10px; cursor: pointer; border-bottom: 1px solid var(--line); font-size: var(--fs-s); }
.tp-srow:hover { background: var(--hover, rgba(255,255,255,.05)); }
.tp-srow.on { background: var(--accent-soft); color: var(--value); }
.tp-srow .tp-sample { margin-left: auto; color: var(--text-faint); max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.mobile .tp-f input.ph-num, body.mobile .tp-f select { height: 34px; }
body.mobile .ph-sheet.open ~ .ph-textedit { top: 52px !important; bottom: auto !important; max-height: 34vh; overflow: auto; }
`;
  document.head.append(s);
}

// ---------------------------------------------------------------- Paths panel

// Panel Options: thumbnail size (0: none)
const PATH_THUMBS = [[0, '없음'], [24, '작게'], [40, '중간'], [64, '크게']];
function pathThumb(P, sps, n = 40) {
  if (!n) return null;
  const c = h('canvas.ph-thumb', { width: n, height: n, style: { width: `${n}px`, height: `${n}px` } });
  const doc = P.doc;
  const g = c.getContext('2d');
  const s = Math.min(n / doc.width, n / doc.height);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, n, n);
  g.translate((n - doc.width * s) / 2, (n - doc.height * s) / 2);
  g.scale(s, s);
  if (sps?.length) {
    g.fillStyle = '#777';
    g.fill(toPath2D(sps));
    g.strokeStyle = '#333';
    g.lineWidth = 1 / s;
    g.stroke(toPath2D(sps));
  }
  return c;
}

export function buildPathsPanel(P) {
  const list = h('div.ph-layers', { role: 'listbox', 'aria-label': '패스' });
  // like Photoshop: a click uses the last settings, Alt+click opens the dialog
  const btn = (ic, title, plain, dialog) => h('button.small', { title: `${title}${dialog ? ' (Alt+클릭: 옵션)' : ''}`, 'aria-label': title, onclick: (e) => (e.altKey && dialog ? dialog() : plain()) }, icon(ic, 15));
  const C = () => P.cmd;
  const foot = h('div.ph-lfoot',
    btn('pathFill', '전경색으로 패스 칠하기', () => C().fillPath(), () => C().fillPathDialog?.()),
    btn('pathStroke', '브러시로 패스 획 그리기', () => C().strokePath(P.lastStrokeTool || 'brush', !!P.lastStrokePressure), () => C().strokePathDialog?.()),
    btn('pathToSel', '패스를 선택 영역으로 불러오기 (Ctrl+Enter)', () => C().pathToSelection(), () => C().makeSelectionDialog?.()),
    btn('selToPath', '선택 영역으로 작업 패스 만들기', () => C().selectionToPath(), () => C().makeWorkPathDialog?.()),
    btn('mask', '벡터 마스크 추가', () => C().addVectorMask('path')),
    btn('plus', '새 패스', () => C().newPath()),
    btn('trash', '패스 삭제', () => C().deletePath()));
  const el = h('div.ph-panel.layers.paths', list, foot);
  let thumbSize = loadPref('photo.pathThumb', 40);
  // the panel menu (≡ on the dock's tab bar), as in Photoshop
  P.panelMenus = P.panelMenus || {};
  P.panelMenus.paths = () => {
    const doc = P.doc;
    const t = doc ? P.resolvePathTarget?.() : null;
    const has = !!(doc && t && P.getPath?.().length);
    return [
      t?.kind === 'work' ? { label: '패스 저장…', action: () => C().savePath() } : { label: '새 패스…', disabled: !doc, action: () => C().newPath() },
      { label: '패스 복제…', disabled: !t || t.kind === 'vmask' || t.kind === 'shape', action: () => C().duplicatePath() },
      { label: '패스 삭제', disabled: !t || t.kind === 'shape', action: () => C().deletePath() },
      '-',
      { label: '작업 패스 만들기…', disabled: !doc?.selection, action: () => C().makeWorkPathDialog() },
      '-',
      { label: '선택 영역 만들기…', disabled: !has, action: () => C().makeSelectionDialog() },
      { label: '패스 칠…', disabled: !has, action: () => C().fillPathDialog() },
      { label: '패스 획…', disabled: !has, action: () => C().strokePathDialog() },
      '-',
      { label: '패널 옵션: 축소판 크기', submenu: PATH_THUMBS.map(([n, label]) => ({ label, checked: thumbSize === n, action: () => {
        thumbSize = n;
        savePref('photo.pathThumb', n);
        render();
      } })) },
    ];
  };
  const menuFor = (target) => [
    target.kind === 'work' ? { label: '패스 저장…', action: () => C().savePath() } : null,
    target.kind === 'saved' ? { label: '패스 복제', action: () => C().duplicatePath?.() } : null,
    target.kind === 'saved' ? { label: '이름 바꾸기…', action: () => C().renamePath(target.id) } : null,
    { label: '패스 삭제', action: () => C().deletePath() },
    '-',
    { label: '작업 패스 만들기…', action: () => C().makeWorkPathDialog?.() },
    { label: '선택 영역 만들기…', action: () => C().makeSelectionDialog?.() },
    { label: '패스 칠…', action: () => C().fillPathDialog?.() },
    { label: '패스 획…', action: () => C().strokePathDialog?.() },
    '-',
    { label: '벡터 마스크로', action: () => C().addVectorMask('path') },
    { label: '모양 레이어로', action: () => C().pathToShape?.() },
    { label: '모양 구성 요소 병합', action: () => C().mergeShapeComponents?.() },
  ].filter(Boolean);
  const render = () => {
    const doc = P.doc;
    list.replaceChildren();
    if (!doc) return;
    const t = P.resolvePathTarget?.();
    const row = (label, sps, target, extra = {}) => {
      const on = t && t.kind === target.kind && (t.id === target.id || t.layerId === target.layerId) && (target.kind !== 'work' || t.kind === 'work');
      const r = h(`div.ph-layer${on ? '.on.active' : ''}`, { role: 'option', 'aria-selected': String(!!on) }, pathThumb(P, sps, thumbSize), h('span.ph-lname', extra.italic ? h('i', label) : label));
      r.addEventListener('click', () => {
        P.pathTarget = target;
        P.pathSel = { subs: new Set(), knots: new Set() };
        P.emit('paths');
        P.redraw();
      });
      r.addEventListener('dblclick', () => {
        if (target.kind === 'work') C().savePath();
        else if (target.kind === 'saved') C().renamePath(target.id);
      });
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        P.pathTarget = target;
        P.emit('paths');
        showMenu(menuFor(target), e.clientX, e.clientY);
      });
      list.append(r);
    };
    const l = doc.active;
    for (const p of doc.paths) row(p.name, p.subpaths, { kind: 'saved', id: p.id });
    if (doc.workPath) row('작업 패스', doc.workPath.subpaths, { kind: 'work' }, { italic: true });
    if (l?.kind === 'shape') row(`${l.name} 모양 패스`, P.shapePathDoc ? P.shapePathDoc(l) : null, { kind: 'shape', layerId: l.id }, { italic: true });
    if (l?.vmask) row(`${l.name} 벡터 마스크`, l.vmask.subpaths, { kind: 'vmask', layerId: l.id }, { italic: true });
    if (!list.children.length) list.append(h('div.empty-hint', '패스가 없습니다.\n펜 도구(P)로 그리거나, 선택 영역을 만든 뒤 아래 "선택 영역으로 작업 패스 만들기" 버튼을 누르세요.'));
  };
  // a click on the empty part of the list deselects the path (it stops showing), like Photoshop
  list.addEventListener('click', (e) => {
    if (e.target.closest('.ph-layer') || !P.pathTarget) return;
    P.pathTarget = null;
    P.pathSel = { subs: new Set(), knots: new Set() };
    P.penDraw = null;
    P.curvDraw = null;
    P.emit('paths');
    P.redraw();
  });
  el.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.ph-layer')) return;
    e.preventDefault();
    showMenu([{ label: '새 패스…', action: () => C().newPath() }, '-', ...menuFor(P.resolvePathTarget?.() || { kind: 'none' })], e.clientX, e.clientY);
  });
  P.on('paths', render);
  P.on('layers', render);
  P.on('doc', render);
  P.on('history', render);
  return el;
}

// ---------------------------------------------------------------- Character and Paragraph panels

const FONT_STYLES = [['regular', '보통'], ['bold', '굵게'], ['italic', '기울임꼴'], ['boldItalic', '굵은 기울임꼴']];
const KERNS = [['metrics', '메트릭'], ['optical', '시각적'], ['none', '0'], ...[-100, -75, -50, -25, -10, -5, 5, 10, 25, 50, 75, 100, 200].map((v) => [String(v), String(v)])];

/** Shared bits of the type panels: re-rendering on type events, numbers, fields. */
function typePanel(P, cls, build) {
  injectCss();
  const el = h(`div.ph-panel.${cls}`);
  let own = false;
  let queued = false;
  const render = () => {
    if (own) return;
    // a field being typed in keeps its focus (the panel draws again when it loses it)
    if (el.contains(document.activeElement) && document.activeElement.matches('input:not([type=color]):not([type=checkbox]), select')) {
      if (!queued) {
        queued = true;
        document.activeElement.addEventListener('blur', () => {
          queued = false;
          render();
        }, { once: true });
      }
      return;
    }
    el.replaceChildren(...build(P.typeState?.() || null, apply).filter(Boolean));
  };
  const apply = (patch, label, opts = {}) => {
    own = true;
    try {
      P.typeApply(patch, label, opts);
    } finally {
      own = false;
    }
    // toggles and selects show the new state (a live colour drag keeps its input)
    if (!opts.live) render();
  };
  for (const ev of ['layers', 'doc', 'opts', 'typesel', 'history', 'textstyles']) P.on(ev, render);
  render();
  return el;
}

const numF = (label, title, v, min, max, step, onSet, { unit = '', placeholder = '' } = {}) => {
  const n = h('input.ph-num', { type: 'number', value: v ?? '', min, max, step, title, 'aria-label': title, placeholder });
  n.addEventListener('change', () => onSet(n.value === '' ? null : clamp(+n.value, min, max)));
  return h('label.tp-f', { title }, h('span.tp-ic', label), n, unit ? h('small', unit) : null);
};

export function buildCharacterPanel(P) {
  return typePanel(P, 'char.tp-char', (st, apply) => {
    if (!st) return [h('div.empty-hint', '문서를 여세요')];
    const c = st.char;
    const fontB = h('button.small.tp-font', { title: '글꼴', style: { fontFamily: `"${c.font}", sans-serif` } }, fontLabel(c.font));
    fontB.addEventListener('click', () => {
      const l = st.layer;
      const orig = c.font;
      let previewing = false;
      openFontPicker(fontB, {
        current: orig, sample: l?.text.content || '가나다 Aa',
        onPreview: (f) => {
          if (!l) return;
          previewing = true;
          apply({ font: f || orig }, '글꼴', { live: true });
        },
        onPick: (f) => apply({ font: f }, '글꼴', { refocus: true }),
        onCancel: () => {
          if (previewing) apply({ font: orig }, '글꼴');
        },
      });
    });
    const fs = h('select', { title: '글꼴 스타일', 'aria-label': '글꼴 스타일' }, FONT_STYLES.map(([v, n]) => h('option', { value: v }, n)));
    fs.value = c.bold && c.italic ? 'boldItalic' : c.bold ? 'bold' : c.italic ? 'italic' : 'regular';
    fs.addEventListener('change', () => apply({ bold: fs.value.startsWith('bold'), italic: /italic/i.test(fs.value) }, '글꼴 스타일', { refocus: true }));
    const kern = h('select', { title: '커닝 (글자 사이 간격 조정)', 'aria-label': '커닝' }, KERNS.map(([v, n]) => h('option', { value: v }, n)));
    const kv = typeof c.kerning === 'number' ? String(c.kerning) : c.kerning || 'metrics';
    if (![...kern.options].some((o) => o.value === kv)) kern.append(h('option', { value: kv }, kv));
    kern.value = kv;
    kern.addEventListener('change', () => apply({ kerning: /^-?\d+$/.test(kern.value) ? +kern.value : kern.value }, '커닝', { refocus: true }));
    const color = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#000000', title: '색상', 'aria-label': '글자 색상' });
    color.addEventListener('input', () => apply({ color: color.value }, '글자 색상', { live: true }));
    color.addEventListener('change', () => apply({ color: color.value }, '글자 색상', { refocus: true }));
    const tog = (key, label, title, on, patch, style = {}) => h(`button.small.tp-tog${on ? '.on' : ''}`, { title, 'aria-label': title, 'aria-pressed': String(!!on), style, onclick: () => apply(patch, title.replace(/ \(.*\)$/, ''), { refocus: true }) }, label);
    const aa = h('select', { title: '앤티 앨리어스', 'aria-label': '앤티 앨리어스' }, AA_MODES.map(([v, n]) => h('option', { value: v }, n)));
    aa.value = st.aa || 'sharp';
    aa.addEventListener('change', () => apply({ aa: aa.value }, '앤티 앨리어스', { refocus: true }));
    const target = !st.layer ? '새 글자에 쓸 설정' : st.editing ? (st.hasSel ? '고른 글자에 적용' : '입력할 자리부터 적용 (글자를 고르면 그 글자만)') : `레이어 전체: ${st.layer.name}`;
    const l = st.layer;
    const t = l?.text;
    return [
      h('div.tp-note', target),
      h('div.tp-grid',
        h('div.tp-f.tp-full', fontB),
        h('label.tp-f.tp-full', h('span.tp-ic', '스타일'), fs),
        numF('크기', '글꼴 크기 (px)', Math.round(c.size * 10) / 10, 0.5, 4000, 1, (v) => v != null && apply({ size: v }, '글꼴 크기', { refocus: true }), { unit: 'px' }),
        numF('행간', '행간 (px, 비우면 자동)', st.leading || '', 0, 8000, 1, (v) => apply({ leading: v || 0 }, '행간', { refocus: true }), { placeholder: '자동' }),
        h('label.tp-f', { title: '커닝' }, h('span.tp-ic', 'V/A'), kern),
        numF('자간', '자간 (1/1000 em)', c.tracking || 0, -1000, 10000, 10, (v) => apply({ tracking: v || 0 }, '자간', { refocus: true })),
        numF('세로', '세로 비율 (%)', c.vScale ?? 100, 1, 1000, 1, (v) => v != null && apply({ vScale: v }, '세로 비율', { refocus: true }), { unit: '%' }),
        numF('가로', '가로 비율 (%)', c.hScale ?? 100, 1, 1000, 1, (v) => v != null && apply({ hScale: v }, '가로 비율', { refocus: true }), { unit: '%' }),
        numF('기준선', '기준선 이동 (px)', c.baseline || 0, -4000, 4000, 1, (v) => apply({ baseline: v || 0 }, '기준선 이동', { refocus: true }), { unit: 'px' }),
        h('label.tp-f', { title: '색상' }, h('span.tp-ic', '색상'), color)),
      h('div.tp-row',
        tog('fauxBold', 'T', '포조 굵게 (Ctrl+Shift+B)', c.fauxBold, { fauxBold: !c.fauxBold }, { fontWeight: 900 }),
        tog('fauxItalic', 'T', '포조 기울임꼴 (Ctrl+Shift+I)', c.fauxItalic, { fauxItalic: !c.fauxItalic }, { fontStyle: 'italic' }),
        tog('all', 'TT', '모두 대문자 (Ctrl+Shift+K)', c.caps === 'all', { caps: c.caps === 'all' ? 'none' : 'all' }),
        tog('small', 'Tᴛ', '작은 대문자 (Ctrl+Shift+H)', c.caps === 'small', { caps: c.caps === 'small' ? 'none' : 'small' }),
        tog('super', 'T¹', '위첨자 (Ctrl+Shift+=)', c.script === 'super', { script: c.script === 'super' ? 'none' : 'super' }),
        tog('sub', 'T₁', '아래첨자 (Ctrl+Shift+Alt+=)', c.script === 'sub', { script: c.script === 'sub' ? 'none' : 'sub' }),
        tog('underline', 'T', '밑줄 (Ctrl+Shift+U)', c.underline, { underline: !c.underline }, { textDecoration: 'underline' }),
        tog('strike', 'T', '취소선 (Ctrl+Shift+/)', c.strike, { strike: !c.strike }, { textDecoration: 'line-through' })),
      h('label.tp-f', h('span.tp-ic', 'aa'), aa),
      l ? h('div.ph-sub', '문자 레이어') : null,
      l ? h('div.tp-row',
        h('button.small', { onclick: () => warpTextDialog(P) }, '텍스트 뒤틀기…'),
        !t.path && !t.area ? h('button.small', { onclick: () => P.cmd.textOrientation(t.vertical ? 'h' : 'v') }, t.vertical ? '가로로' : '세로로') : null,
        !t.path ? h('button.small', { onclick: () => P.cmd.convertTextType() }, t.box || t.area ? '포인트 텍스트로' : '단락 텍스트로') : null,
        t.path ? h('button.small', { onclick: () => P.cmd.flipPathText() }, '패스 반대쪽으로 뒤집기') : null) : null,
      l ? h('div.tp-row',
        h('button.small', { onclick: () => P.cmd.textToShape?.(l) }, '모양으로 변환'),
        h('button.small', { onclick: () => P.cmd.textToPath?.(l) }, '작업 패스 만들기'),
        h('button.small', { onclick: () => P.cmd.rasterize() }, '래스터화')) : null,
    ];
  });
}

const ALIGN_ICONS = { left: 'paraLeft', center: 'paraCenter', right: 'paraRight', justify: 'paraJustLeft', justifyCenter: 'paraJustCenter', justifyRight: 'paraJustRight', justifyAll: 'paraJustAll' };

export function buildParagraphPanel(P) {
  return typePanel(P, 'tp-para', (st, apply) => {
    if (!st) return [h('div.empty-hint', '문서를 여세요')];
    const pa = st.para;
    const ind = pa.indent || {};
    const al = (v, title) => h(`button.small.tp-al${(pa.align || 'left') === v ? '.on' : ''}`, { title, 'aria-label': title, 'aria-pressed': String((pa.align || 'left') === v), onclick: () => apply({ align: v }, title, { refocus: true }) }, icon(ALIGN_ICONS[v], 15));
    const l = st.layer;
    const t = l?.text;
    const target = !l ? '새 글자에 쓸 설정' : st.editing ? '커서가 있는 단락 (여러 단락을 고르면 모두)' : `레이어 전체: ${l.name}`;
    return [
      h('div.tp-note', target),
      h('div.tp-row', ...ALIGNS.slice(0, 3).map(([v, n]) => al(v, n)), h('span', { style: { width: '8px' } }), ...ALIGNS.slice(3).map(([v, n]) => al(v, n))),
      h('div.tp-grid',
        numF('왼쪽', '왼쪽 여백 들여쓰기 (px)', ind.left || 0, -4000, 4000, 1, (v) => apply({ indent: { left: v || 0 } }, '왼쪽 여백 들여쓰기', { refocus: true }), { unit: 'px' }),
        numF('오른쪽', '오른쪽 여백 들여쓰기 (px)', ind.right || 0, -4000, 4000, 1, (v) => apply({ indent: { right: v || 0 } }, '오른쪽 여백 들여쓰기', { refocus: true }), { unit: 'px' }),
        numF('첫 줄', '첫 줄 들여쓰기 (px)', ind.first || 0, -4000, 4000, 1, (v) => apply({ indent: { first: v || 0 } }, '첫 줄 들여쓰기', { refocus: true }), { unit: 'px' }),
        h('span'),
        numF('앞', '단락 앞 공백 (px)', pa.spaceBefore || 0, 0, 4000, 1, (v) => apply({ spaceBefore: v || 0 }, '단락 앞 공백', { refocus: true }), { unit: 'px' }),
        numF('뒤', '단락 뒤 공백 (px)', pa.spaceAfter || 0, 0, 4000, 1, (v) => apply({ spaceAfter: v || 0 }, '단락 뒤 공백', { refocus: true }), { unit: 'px' })),
      t?.box && !t.path ? h('div.ph-sub', t.area ? '영역 문자 상자' : '단락 텍스트 상자') : null,
      t?.box && !t.path ? h('div.tp-grid',
        numF('폭', '상자 폭 (px)', t.box.w, 4, 40000, 1, (v) => v && boxSize(P, l, { w: v }), { unit: 'px' }),
        numF('높이', '상자 높이 (px)', t.box.h, 4, 40000, 1, (v) => v && boxSize(P, l, { h: v }), { unit: 'px' })) : null,
    ];
  });
}

function boxSize(P, l, patch) {
  if (P.editingText) P.finishText();
  P.run('텍스트 상자 크기', () => {
    l.text = { ...l.text, box: { ...l.text.box, ...patch } };
    P.doc.touch(l);
  });
}

/** Character Styles / Paragraph Styles panels. */
export function buildTextStylesPanel(P, kind) {
  injectCss();
  const list = h('div.tp-slist', { role: 'listbox', 'aria-label': kind === 'char' ? '문자 스타일' : '단락 스타일' });
  let selId = null;
  const foot = h('div.ph-lfoot',
    h('button.small', { title: '재정의 지우기 (스타일대로 되돌리기)', 'aria-label': '재정의 지우기', onclick: () => { const s = P.textStyleState(kind); if (s.id) P.applyTextStyle(kind, s.id); } }, icon('reset', 15)),
    h('button.small', { title: '현재 글자로 스타일 재정의', 'aria-label': '스타일 재정의', onclick: () => { const id = selId || P.textStyleState(kind).id; if (id) P.redefineTextStyle(kind, id); } }, icon('check', 15)),
    h('button.small', { title: '새 스타일 (현재 글자의 설정으로)', 'aria-label': '새 스타일', onclick: () => P.newTextStyle(kind) }, icon('plus', 15)),
    h('button.small', { title: '스타일 삭제', 'aria-label': '스타일 삭제', onclick: () => { const id = selId || P.textStyleState(kind).id; if (id) P.deleteTextStyle(kind, id); } }, icon('trash', 15)));
  const el = h('div.ph-panel.tp-styles', list, foot);
  const render = () => {
    list.replaceChildren();
    if (!P.doc) return;
    const cur = P.textStyleState(kind);
    const none = h(`div.tp-srow${!cur.id ? '.on' : ''}`, { role: 'option', title: kind === 'char' ? '스타일 연결 끊기 (모양은 그대로)' : '스타일 연결 끊기 (모양은 그대로)' }, h('i', kind === 'char' ? '없음' : '기본 단락'));
    none.addEventListener('click', () => {
      selId = null;
      P.applyTextStyle(kind, null);
    });
    list.append(none);
    for (const s of P.textStyles(kind)) {
      const p = s.props || {};
      const sample = h('span.tp-sample', { style: { fontFamily: `"${p.font}", sans-serif`, fontWeight: p.bold ? 700 : 400, fontStyle: p.italic ? 'italic' : 'normal', color: p.color } }, `${fontLabel(p.font || '')} ${Math.round(p.size || 0)}px`);
      const r = h(`div.tp-srow${cur.id === s.id ? '.on' : ''}`, { role: 'option', 'aria-selected': String(cur.id === s.id), title: '눌러서 적용 · 두 번 눌러 이름 바꾸기 · 오른쪽 클릭: 메뉴' }, h('span', `${s.name}${cur.id === s.id && cur.override ? '+' : ''}`), sample);
      r.addEventListener('click', () => {
        selId = s.id;
        P.applyTextStyle(kind, s.id);
      });
      r.addEventListener('dblclick', () => P.renameTextStyle(kind, s.id));
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selId = s.id;
        showMenu([
          { label: '적용', action: () => P.applyTextStyle(kind, s.id) },
          { label: '스타일 재정의 (현재 글자로)', action: () => P.redefineTextStyle(kind, s.id) },
          { label: '이름 바꾸기…', action: () => P.renameTextStyle(kind, s.id) },
          { label: '스타일 삭제', action: () => P.deleteTextStyle(kind, s.id) },
        ], e.clientX, e.clientY);
      });
      list.append(r);
    }
    if (!P.textStyles(kind).length) list.append(h('div.empty-hint', kind === 'char' ? '글자를 고른 뒤 + 버튼으로 문자 스타일을 만드세요.\n스타일을 바꾸면(재정의) 그 스타일을 쓰는 글자가 모두 바뀝니다.' : '단락에 커서를 두고 + 버튼으로 단락 스타일을 만드세요.'));
  };
  for (const ev of ['layers', 'doc', 'history', 'typesel', 'textstyles']) P.on(ev, render);
  render();
  return el;
}

/** Type ▸ Warp Text with live preview on the active text layer. */
export function warpTextDialog(P) {
  const doc = P.doc;
  const l = doc?.active;
  if (l?.kind !== 'text') return;
  if (P.editingText) P.finishText();
  if (l.text.path) {
    P.toast?.('패스 위의 문자는 뒤틀 수 없습니다');
    return;
  }
  const before = doc.capture();
  const w = { style: 'arc', bend: 50, h: 0, v: 0, vertical: false, ...(l.text.warp || {}) };
  if (!l.text.warp) w.style = 'arc';
  const apply = () => {
    l.text = { ...l.text, warp: w.style === 'none' ? null : { ...w } };
    doc.touch(l);
    P.redraw();
  };
  const style = h('select', WARP_STYLES.map(([v, n]) => h('option', { value: v }, n)));
  style.value = w.style;
  style.addEventListener('change', () => { w.style = style.value; apply(); });
  const orient = h('select', h('option', { value: 'h' }, '가로'), h('option', { value: 'v' }, '세로'));
  orient.value = w.vertical ? 'v' : 'h';
  orient.addEventListener('change', () => { w.vertical = orient.value === 'v'; apply(); });
  const slider = (key, label) => {
    const r = h('input', { type: 'range', min: -100, max: 100, value: w[key] });
    const n = h('input.ph-num', { type: 'number', min: -100, max: 100, value: w[key] });
    const set = (v) => { w[key] = clamp(+v, -100, 100); r.value = w[key]; n.value = w[key]; apply(); };
    r.addEventListener('input', () => set(r.value));
    n.addEventListener('change', () => set(n.value));
    return h('label.ph-prow', h('span', label), r, n, h('small', '%'));
  };
  let ok = false;
  apply();
  openModal({
    title: '텍스트 뒤틀기',
    width: '420px',
    body: [h('label.ph-prow', h('span', '스타일'), style), h('label.ph-prow', h('span', '방향'), orient), slider('bend', '구부리기'), slider('h', '가로 왜곡'), slider('v', '세로 왜곡')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { ok = true; P.commit('텍스트 뒤틀기', before); } }],
    onClose: () => {
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
}

/** Text → a filled path shape layer / a work path (outlines are traced from the rendered glyphs). */
export function installTypeCommands(P, PT) {
  const outline = (l) => {
    const doc = P.doc;
    const c = doc.content(l);
    if (!c) return [];
    const m = makeCanvas(doc.width, doc.height);
    m.getContext('2d').drawImage(c.canvas, c.x, c.y);
    return PT.pathFromMask(m, 0.6);
  };
  P.cmd.textToPath = (l = P.doc?.active) => {
    if (l?.kind !== 'text') return;
    if (P.editingText) P.finishText();
    P.run('문자에서 작업 패스', () => {
      P.doc.workPath = { subpaths: outline(l) };
      P.pathTarget = { kind: 'work' };
    });
    P.emit('paths');
  };
  P.cmd.textToShape = (l = P.doc?.active) => {
    if (l?.kind !== 'text') return;
    if (P.editingText) P.finishText();
    const sps = outline(l);
    if (!sps.length) return;
    P.run('모양으로 변환', () => {
      const b = PT.pathBounds(sps);
      const doc = P.doc;
      const nl = { ...l, kind: 'shape', text: null, rotation: 0, skewX: 0, x: b.x, y: b.y, shape: { type: 'path', subpaths: PT.translatePath(sps, -b.x, -b.y), w: b.w, h: b.h, pw: b.w, ph: b.h, fill: l.text.color, stroke: null, strokeWidth: 0 }, _text: null, _shape: null, _styled: null };
      doc.layers[doc.index(l.id)] = nl;
      doc.touch(nl);
    });
  };
  installType2(P);
  P.addPanel('para', '단락', buildParagraphPanel(P));
  P.addPanel('charStyles', '문자 스타일', buildTextStylesPanel(P, 'char'));
  P.addPanel('paraStyles', '단락 스타일', buildTextStylesPanel(P, 'para'));
}
