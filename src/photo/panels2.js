// More photo panels: Paths, Character & Paragraph, and the text warp dialog.

import { h, clamp } from '../util.js';
import { showMenu, openModal } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { openFontPicker } from '../ui/font-picker.js';
import { fontLabel } from '../fonts.js';
import { makeCanvas } from './doc.js';
import { rasterizePath, toPath2D } from './paths.js';
import { WARP_STYLES } from './transform.js';

// ---------------------------------------------------------------- Paths panel

function pathThumb(P, sps) {
  const c = h('canvas.ph-thumb', { width: 40, height: 40 });
  const doc = P.doc;
  const g = c.getContext('2d');
  const s = Math.min(40 / doc.width, 40 / doc.height);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 40, 40);
  g.translate((40 - doc.width * s) / 2, (40 - doc.height * s) / 2);
  g.scale(s, s);
  if (sps?.length) {
    g.fillStyle = '#777';
    g.fill(toPath2D(sps));
  }
  return c;
}

export function buildPathsPanel(P) {
  const list = h('div.ph-layers', { role: 'listbox', 'aria-label': '패스' });
  const foot = h('div.ph-lfoot',
    h('button.small', { title: '전경색으로 패스 칠하기', 'aria-label': '패스 칠하기', onclick: () => P.cmd.fillPath() }, '●'),
    h('button.small', { title: '브러시로 패스 획 그리기', 'aria-label': '패스 획', onclick: () => P.cmd.strokePath('brush') }, '○'),
    h('button.small', { title: '패스를 선택 영역으로 (Ctrl+Enter)', 'aria-label': '선택 영역으로', onclick: () => P.cmd.pathToSelection() }, '⬚'),
    h('button.small', { title: '선택 영역으로 작업 패스 만들기', 'aria-label': '작업 패스 만들기', onclick: () => P.cmd.selectionToPath() }, '⟲'),
    h('button.small', { title: '벡터 마스크 추가', 'aria-label': '벡터 마스크', onclick: () => P.cmd.addVectorMask('path') }, icon('mask', 15)),
    h('button.small', { title: '새 패스', 'aria-label': '새 패스', onclick: () => P.cmd.newPath() }, icon('plus', 15)),
    h('button.small', { title: '패스 삭제', 'aria-label': '패스 삭제', onclick: () => P.cmd.deletePath() }, icon('trash', 15)));
  const el = h('div.ph-panel.layers.paths', list, foot);
  const render = () => {
    const doc = P.doc;
    list.replaceChildren();
    if (!doc) return;
    const t = P.resolvePathTarget?.();
    const row = (label, sps, target, extra = {}) => {
      const on = t && t.kind === target.kind && (t.id === target.id || t.layerId === target.layerId) && (target.kind !== 'work' || t.kind === 'work');
      const r = h(`div.ph-layer${on ? '.on.active' : ''}`, { role: 'option', 'aria-selected': String(!!on) }, pathThumb(P, sps), h('span.ph-lname', extra.italic ? h('i', label) : label));
      r.addEventListener('click', () => {
        P.pathTarget = target;
        P.pathSel = { subs: new Set(), knots: new Set() };
        P.emit('paths');
        P.redraw();
      });
      r.addEventListener('dblclick', () => {
        if (target.kind === 'work') P.cmd.savePath();
        else if (target.kind === 'saved') P.cmd.renamePath(target.id);
      });
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        P.pathTarget = target;
        showMenu([
          target.kind === 'work' ? { label: '패스 저장…', action: () => P.cmd.savePath() } : null,
          target.kind === 'saved' ? { label: '이름 바꾸기…', action: () => P.cmd.renamePath(target.id) } : null,
          { label: '선택 영역 만들기', action: () => P.cmd.pathToSelection() },
          { label: '패스 칠하기 (전경색)', action: () => P.cmd.fillPath() },
          { label: '패스 획 (브러시)', action: () => P.cmd.strokePath('brush') },
          { label: '패스 획 (연필)', action: () => P.cmd.strokePath('pencil') },
          { label: '패스 획 (지우개)', action: () => P.cmd.strokePath('eraser') },
          { label: '패스 획 (압력 흉내)', action: () => P.cmd.strokePath('brush', true) },
          '-',
          { label: '벡터 마스크로', action: () => P.cmd.addVectorMask('path') },
          { label: '패스 삭제', action: () => P.cmd.deletePath() },
        ].filter(Boolean), e.clientX, e.clientY);
      });
      list.append(r);
    };
    const l = doc.active;
    if (l?.kind === 'shape') row(`${l.name} 모양 패스`, P.pathTarget?.kind === 'shape' && P.pathTarget.layerId === l.id ? P.getPath() : null, { kind: 'shape', layerId: l.id }, { italic: true });
    if (l?.vmask) row(`${l.name} 벡터 마스크`, l.vmask.subpaths, { kind: 'vmask', layerId: l.id }, { italic: true });
    for (const p of doc.paths) row(p.name, p.subpaths, { kind: 'saved', id: p.id });
    if (doc.workPath) row('작업 패스', doc.workPath.subpaths, { kind: 'work' }, { italic: true });
    if (!list.children.length) list.append(h('div.empty-hint', '패스가 없습니다.\n펜 도구(P)로 그리거나, 선택 영역을 만든 뒤 ⟲ 버튼으로 작업 패스를 만드세요.'));
  };
  P.on('paths', render);
  P.on('layers', render);
  P.on('doc', render);
  P.on('history', render);
  return el;
}

// ---------------------------------------------------------------- Character & Paragraph panel

export function buildCharacterPanel(P) {
  const el = h('div.ph-panel.char');
  let pending = null;
  const target = () => (P.doc?.active?.kind === 'text' ? P.doc.active : null);
  /** Change the active text layer (or, without one, the type tool defaults). */
  const set = (label, patch, done = true) => {
    const l = target();
    if (!l) {
      const o = P.opts('text');
      for (const [k, v] of Object.entries(patch)) if (k in o) P.setOpt('text', k, v);
      return;
    }
    if (!pending) pending = P.doc.capture();
    l.text = { ...l.text, ...patch };
    P.doc.touch(l);
    P.redraw();
    if (done) {
      P.commit(label, pending);
      pending = null;
    }
  };
  const num = (v, min, max, step, onSet, w = '64px') => {
    const n = h('input.ph-num', { type: 'number', value: v, min, max, step, style: { width: w } });
    n.addEventListener('change', () => onSet(clamp(+n.value, min, max)));
    return n;
  };
  const row = (label, ...ctrls) => h('label.ph-prow', h('span', label), ...ctrls);
  const tog = (key, label, title, t) => h(`button.small.ph-tog${t[key] ? '.on' : ''}`, { title, 'aria-pressed': String(!!t[key]), onclick: () => set(title, { [key]: !t[key] }) }, label);
  const render = () => {
    pending = null;
    const l = target();
    const o = P.opts('text');
    const t = l ? l.text : { font: o.font, size: o.size, bold: o.bold, italic: o.italic, align: o.align, color: P.fg, lineHeight: 1.2, letterSpacing: 0, hScale: 100, vScale: 100, baseline: 0, caps: 'none', indent: {} };
    const fontB = h('button.small', { style: { fontFamily: `"${t.font}", sans-serif`, maxWidth: '100%' } }, fontLabel(t.font));
    fontB.addEventListener('click', () => {
      const orig = t.font;
      openFontPicker(fontB, {
        current: orig, sample: l?.text.content || '가나다 Aa',
        onPreview: (f) => { if (l) set('글꼴', { font: f || orig }, false); },
        onPick: (f) => set('글꼴', { font: f }),
        onCancel: () => { if (l) set('글꼴', { font: orig }, false); pending = null; },
      });
    });
    const color = h('input', { type: 'color', value: t.color || '#000000' });
    color.addEventListener('input', () => set('글자 색', { color: color.value }, false));
    color.addEventListener('change', () => set('글자 색', { color: color.value }, true));
    const tracking = Math.round(((t.letterSpacing || 0) / Math.max(1, t.size)) * 1000);
    const caps = h('select', [['none', '보통'], ['all', '모두 대문자'], ['small', '작은 대문자']].map(([v, n]) => h('option', { value: v }, n)));
    caps.value = t.caps || 'none';
    caps.addEventListener('change', () => set('대문자', { caps: caps.value }));
    const alignBtn = (v, label, title) => h(`button.small.ph-tog${(t.align || 'left') === v ? '.on' : ''}`, { title, onclick: () => set('정렬', { align: v }) }, label);
    const ind = t.indent || {};
    el.replaceChildren(
      h('div.ph-ptitle', l ? `문자: ${l.name}` : '문자 (새 글자에 쓸 설정)'),
      row('글꼴', fontB),
      h('div.ph-prow', tog('bold', 'B', '굵게', t), tog('italic', 'I', '기울임', t), tog('underline', 'U̲', '밑줄', t), tog('strike', 'S̶', '취소선', t), caps),
      row('크기 (px)', num(t.size, 1, 4000, 1, (v) => set('글자 크기', { size: v }))),
      row('행간 (배)', num(t.lineHeight || 1.2, 0.5, 5, 0.05, (v) => set('행간', { lineHeight: v, leading: 0 }))),
      row('자간 (1/1000 em)', num(tracking, -500, 2000, 10, (v) => set('자간', { letterSpacing: (v / 1000) * t.size }))),
      row('장평 / 세로 비율 (%)', num(t.hScale ?? 100, 10, 1000, 1, (v) => set('장평', { hScale: v }), '56px'), num(t.vScale ?? 100, 10, 1000, 1, (v) => set('세로 비율', { vScale: v }), '56px')),
      row('기준선 이동 (px)', num(t.baseline || 0, -1000, 1000, 1, (v) => set('기준선 이동', { baseline: v }))),
      row('색', color),
      h('div.ph-sub', '단락'),
      h('div.ph-prow', alignBtn('left', '⫷', '왼쪽 정렬'), alignBtn('center', '≡', '가운데 정렬'), alignBtn('right', '⫸', '오른쪽 정렬'), alignBtn('justify', '☰', '양쪽 정렬 (마지막 줄 왼쪽)'), alignBtn('justifyAll', '▤', '양쪽 모두 정렬')),
      row('왼쪽 / 오른쪽 들여쓰기', num(ind.left || 0, 0, 2000, 1, (v) => set('들여쓰기', { indent: { ...ind, left: v } }), '56px'), num(ind.right || 0, 0, 2000, 1, (v) => set('들여쓰기', { indent: { ...ind, right: v } }), '56px')),
      row('첫 줄 들여쓰기', num(ind.first || 0, -2000, 2000, 1, (v) => set('첫 줄 들여쓰기', { indent: { ...ind, first: v } }))),
      row('단락 앞 / 뒤 간격', num(t.spaceBefore || 0, 0, 2000, 1, (v) => set('단락 간격', { spaceBefore: v }), '56px'), num(t.spaceAfter || 0, 0, 2000, 1, (v) => set('단락 간격', { spaceAfter: v }), '56px')),
      l ? h('div.ph-prow',
        h('button.small', { onclick: () => warpTextDialog(P) }, '텍스트 뒤틀기…'),
        h('button.small', { onclick: () => set(t.vertical ? '가로 쓰기' : '세로 쓰기', { vertical: !t.vertical }) }, t.vertical ? '가로로 바꾸기' : '세로로 바꾸기'),
        h('button.small', { onclick: () => set(t.box ? '점 문자로' : '단락 문자로', { box: t.box ? null : { w: Math.max(100, Math.round(P.doc.content(l)?.canvas.width || 300)), h: Math.max(60, Math.round((P.doc.content(l)?.canvas.height || 100) * 1.5)) } }) }, t.box ? '점 문자로 변환' : '단락 문자로 변환')) : null,
      l?.text.box ? row('단락 상자 폭 × 높이', num(t.box.w, 4, 20000, 1, (v) => set('상자 크기', { box: { ...t.box, w: v } }), '64px'), num(t.box.h, 4, 20000, 1, (v) => set('상자 크기', { box: { ...t.box, h: v } }), '64px')) : null,
      l ? h('div.ph-prow', h('button.small', { onclick: () => P.cmd.textToShape?.(l) }, '모양으로 변환'), h('button.small', { onclick: () => P.cmd.textToPath?.(l) }, '작업 패스 만들기'), h('button.small', { onclick: () => P.cmd.rasterize() }, '래스터화')) : null,
      h('div.note', '포토샵과 달리 한 레이어 안에서 글자마다 다른 서식을 줄 수는 없습니다 (레이어 전체에 적용).'),
    );
  };
  P.on('layers', render);
  P.on('doc', render);
  P.on('opts', render);
  return el;
}

/** Type ▸ Warp Text with live preview on the active text layer. */
export function warpTextDialog(P) {
  const doc = P.doc;
  const l = doc?.active;
  if (l?.kind !== 'text') return;
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
    P.run('문자에서 작업 패스', () => {
      P.doc.workPath = { subpaths: outline(l) };
      P.pathTarget = { kind: 'work' };
    });
    P.emit('paths');
  };
  P.cmd.textToShape = (l = P.doc?.active) => {
    if (l?.kind !== 'text') return;
    const sps = outline(l);
    if (!sps.length) return;
    P.run('모양으로 변환', () => {
      const b = PT.pathBounds(sps);
      const doc = P.doc;
      const nl = { ...l, kind: 'shape', text: null, rotation: 0, x: b.x, y: b.y, shape: { type: 'path', subpaths: PT.translatePath(sps, -b.x, -b.y), w: b.w, h: b.h, pw: b.w, ph: b.h, fill: l.text.color, stroke: null, strokeWidth: 0 }, _text: null, _shape: null, _styled: null };
      doc.layers[doc.index(l.id)] = nl;
      doc.touch(nl);
    });
  };
  void rasterizePath;
}
