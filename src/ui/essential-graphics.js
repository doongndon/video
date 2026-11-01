// 기본 그래픽 (Essential Graphics) panel, like Premiere Pro's. 찾아보기 lists the title templates with
// previews that play on hover; double-click, 추가 or drag one to the timeline / Program monitor to
// insert it. 편집 works on the selected text or shape clip: new layers, 정렬 및 변형 (align to the
// video frame), its text / shape properties (the Effect Controls rows) and 반응형 디자인 - 시간 (롤).

import { store } from '../store.js';
import { playback } from '../playback.js';
import { Compositor } from '../compositor.js';
import * as edit from '../edit.js';
import { clipEnd } from '../model.js';
import { h, clamp, uid, formatTimecode, parseTimecode } from '../util.js';
import { showPanel, dnd, loadPref, savePref, showMenu, toast, promptDialog, confirmDialog } from './common.js';
import { icon, iconButton } from './icons.js';
import { extendMenu } from './menubar.js';
import { injectStyle } from './style-inject.js';
import { TEMPLATES, TEMPLATE_CATEGORIES, insertTemplate, drawTemplate, templateThumbTime } from '../templates.js';
import { createEffectControls } from './effect-controls.js';
import { applyRollCrawl, clearRollCrawl } from '../features.js';
import { rollMeasure, rollTargets } from './dialogs.js';

/** Drag type of a template card (the timeline and the Program monitor accept it). */
export const TEMPLATE_MIME = 'application/x-montage-template';

const THUMB_W = 320;
const THUMB_H = 180;

/** 정렬 및 변형: [id, icon, label] (aligned to the video frame, like Premiere with one layer). */
const ALIGN = [
  ['left', 'alignLeft', '왼쪽 정렬'], ['hcenter', 'alignHCenter', '가로 가운데 정렬'], ['right', 'alignRight', '오른쪽 정렬'],
  ['top', 'alignTop', '위쪽 정렬'], ['vcenter', 'alignVCenter', '세로 가운데 정렬'], ['bottom', 'alignBottom', '아래쪽 정렬'],
];

injectStyle('eg-style', `
.eg { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.eg-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.eg-tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--text-dim); padding: 4px 12px; min-height: 0; }
.eg-tabs button.on { color: var(--text); border-bottom-color: var(--accent); }
.eg-pane { display: none; flex: 1; min-height: 0; flex-direction: column; }
.eg-pane.on { display: flex; }
.eg-bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; flex-shrink: 0; flex-wrap: wrap; }
.eg-bar input[type=search] { flex: 1; min-width: 120px; }
.eg-grid { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; padding: 4px 8px 8px; align-content: start; }
.eg-card { display: flex; flex-direction: column; gap: 4px; padding: 4px; border-radius: 6px; border: 1px solid transparent; cursor: grab; user-select: none; }
.eg-card:hover { background: var(--bg-4); }
.eg-card.sel { border-color: var(--accent); background: var(--sel); }
.eg-thumb { aspect-ratio: 16 / 9; background: #000; border-radius: 4px; display: grid; place-items: center; overflow: hidden; }
.eg-thumb canvas { max-width: 100%; max-height: 100%; display: block; }
.eg-card .eg-name { font-size: var(--fs-xs); color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.eg-card .eg-cat { font-size: 10px; color: var(--text-faint); }
.eg-foot { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-top: 1px solid var(--line); flex-shrink: 0; }
.eg-foot .note { flex: 1; margin: 0; }
.eg-sec { padding: 6px 8px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.eg-sec h4 { margin: 0 0 6px; font-size: var(--fs-xs); color: var(--text-dim); font-weight: 600; }
.eg-sec .row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.eg-sec .row + .row { margin-top: 6px; }
.eg-sec label.check { white-space: nowrap; }
.eg-sec input.tc { width: 13ch; }
.eg-sel { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.eg-pane.eg-edit.on { display: block; overflow: auto; }
.eg-ec .ec-panel { flex: none; min-height: 0; }
.eg-ec .ec { flex: none; overflow: visible; }
.eg-ec .ec-top, .eg-ec .ec-foot { display: none; }
.eg-empty { padding: 16px; color: var(--text-dim); white-space: pre-line; text-align: center; }
.eg-layers { display: flex; flex-direction: column; gap: 1px; margin-top: 6px; max-height: calc(132px * var(--ui-scale)); overflow: auto; }
.eg-layer { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; cursor: pointer; color: var(--text-dim); }
.eg-layer:hover { background: var(--bg-4); }
.eg-layer.sel { background: var(--sel); color: var(--text); }
.eg-layer span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.eg-layers .note { margin: 0; padding: 2px 6px; }
.eg-sec[aria-disabled=true] { opacity: 0.5; pointer-events: none; }
`);

export const graphicsApi = {};

export function createEssentialGraphicsPanel() {
  let tab = loadPref('eg.tab', 'browse');
  let visible = false;
  const tabBtns = [['browse', '찾아보기'], ['edit', '편집']].map(([id, label]) => {
    const b = h('button', { onclick: () => setTab(id) }, label);
    b.dataset.tab = id;
    return b;
  });
  const browse = h('div.eg-pane.eg-browse');
  const editPane = h('div.eg-pane.eg-edit');
  const body = h('div.eg', h('div.eg-tabs', tabBtns), browse, editPane);

  function setTab(id) {
    tab = id;
    savePref('eg.tab', id);
    for (const b of tabBtns) b.classList.toggle('on', b.dataset.tab === id);
    browse.classList.toggle('on', id === 'browse');
    editPane.classList.toggle('on', id === 'edit');
    if (id === 'edit') buildEdit();
    refresh();
  }

  // ---------------------------------------------------------------- 찾아보기 (templates)

  const comp = new Compositor({ onAsyncReady: () => renderVisible() });
  let cat = loadPref('eg.cat', 'all');
  let query = '';
  let selId = null;
  const search = h('input', { type: 'search', placeholder: '템플릿 검색', 'aria-label': '템플릿 검색' });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const catSel = h('select', { 'aria-label': '분류' }, h('option', { value: 'all' }, '모든 템플릿'), TEMPLATE_CATEGORIES.map((c) => h('option', { value: c, selected: c === cat }, c)));
  const grid = h('div.eg-grid', { role: 'listbox', 'aria-label': '타이틀 템플릿' });
  const addBtn = h('button.primary', { onclick: () => insertSelected() }, icon('plus'), ' 재생헤드에 추가');
  browse.append(
    h('div.eg-bar', search, catSel),
    grid,
    h('div.eg-foot', h('div.note', '두 번 클릭하거나 타임라인으로 끌어다 놓으세요'), addBtn));

  const cards = TEMPLATES.map((tpl) => {
    const canvas = h('canvas', { width: THUMB_W, height: THUMB_H });
    const card = h('div.eg-card', { role: 'option', tabindex: 0, draggable: true, title: `${tpl.name} (${tpl.duration}초)` },
      h('div.eg-thumb', canvas), h('div.eg-name', tpl.name), h('div.eg-cat', `${tpl.category} · ${tpl.duration}초`));
    card.dataset.id = tpl.id;
    const entry = { tpl, card, canvas, key: '', anim: 0 };
    card.addEventListener('click', () => select(tpl.id));
    card.addEventListener('dblclick', () => insertAt(tpl.id, store.ui.playhead));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        insertAt(tpl.id, store.ui.playhead);
      }
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      select(tpl.id);
      showMenu([
        { label: '재생헤드 위치에 추가', action: () => insertAt(tpl.id, store.ui.playhead) },
        { label: '시작 표시 위치에 추가', disabled: store.seq.inPoint == null, action: () => insertAt(tpl.id, store.seq.inPoint ?? 0) },
      ], e.clientX, e.clientY);
    });
    card.addEventListener('dragstart', (e) => {
      stopAnim(entry);
      dnd.payload = { template: tpl.id };
      e.dataTransfer.setData(TEMPLATE_MIME, tpl.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dragend', () => { dnd.payload = null; });
    // the preview plays while the pointer rests on it (like Premiere's browser)
    card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') startAnim(entry); });
    card.addEventListener('pointerleave', () => stopAnim(entry));
    return entry;
  });
  grid.append(...cards.map((x) => x.card));

  const sizeKey = () => `${store.seq.width}x${store.seq.height}`;

  function drawAt(entry, t) {
    const s = store.seq;
    const k = Math.min(THUMB_W / s.width, THUMB_H / s.height);
    const w = Math.max(16, Math.round(s.width * k));
    const hh = Math.max(16, Math.round(s.height * k));
    if (entry.canvas.width !== w || entry.canvas.height !== hh) {
      entry.canvas.width = w;
      entry.canvas.height = hh;
    }
    try {
      drawTemplate(entry.canvas.getContext('2d'), entry.tpl, t, comp, playback.provider);
    } catch (err) {
      console.warn('template preview failed', entry.tpl.id, err);
    }
  }

  function drawThumb(entry, force = false) {
    const key = sizeKey();
    if (!force && entry.key === key) return;
    entry.key = key;
    drawAt(entry, templateThumbTime(entry.tpl));
  }

  function startAnim(entry) {
    stopAnim(entry);
    const t0 = performance.now();
    const step = () => {
      const t = ((performance.now() - t0) / 1000) % entry.tpl.duration;
      drawAt(entry, t);
      entry.anim = requestAnimationFrame(step);
    };
    entry.anim = requestAnimationFrame(step);
  }

  function stopAnim(entry) {
    if (!entry.anim) return;
    cancelAnimationFrame(entry.anim);
    entry.anim = 0;
    drawThumb(entry, true);
  }

  const shown = new Set();
  const io = new IntersectionObserver((list) => {
    for (const en of list) {
      const entry = cards.find((x) => x.card === en.target);
      if (!entry) continue;
      if (en.isIntersecting) {
        shown.add(entry);
        if (visible) drawThumb(entry);
      } else shown.delete(entry);
    }
  }, { root: grid, rootMargin: '80px' });
  for (const x of cards) io.observe(x.card);

  let redrawTimer = 0;
  function renderVisible(force = false) {
    if (!visible || tab !== 'browse') return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      for (const x of shown) if (!x.anim) drawThumb(x, force);
    }, 60);
  }
  // web fonts arrive after the first previews: draw them again with the real faces
  document.fonts?.addEventListener?.('loadingdone', () => renderVisible(true));

  function filterCards() {
    const q = query.trim().toLowerCase();
    for (const x of cards) {
      const ok = (cat === 'all' || x.tpl.category === cat) && (!q || x.tpl.name.toLowerCase().includes(q) || x.tpl.category.includes(q));
      x.card.hidden = !ok;
    }
  }
  search.addEventListener('input', () => {
    query = search.value;
    filterCards();
  });
  catSel.addEventListener('change', () => {
    cat = catSel.value;
    savePref('eg.cat', cat);
    filterCards();
  });
  filterCards();

  function select(id) {
    selId = id;
    for (const x of cards) {
      x.card.classList.toggle('sel', x.tpl.id === id);
      x.card.setAttribute('aria-selected', String(x.tpl.id === id));
    }
    addBtn.disabled = !id;
  }
  select(null);

  function insertAt(id, t) {
    playback.stop();
    const ids = insertTemplate(id, t);
    if (ids.length) select(id);
  }

  function insertSelected() {
    if (!selId) return toast('넣을 템플릿을 먼저 고르세요');
    insertAt(selId, store.ui.playhead);
  }

  // ---------------------------------------------------------------- 편집 (selected graphic)

  let built = false;
  let ecText = null;
  let ecShape = null;
  const selName = h('span.eg-sel');
  const ecWrap = h('div.eg-ec');
  const emptyHint = h('div.eg-empty', '타임라인에서 텍스트나 도형 클립을 선택하면\n여기에서 글꼴·크기·칠·선·그림자와 정렬을 바꿀 수 있습니다.\n\n새 레이어 버튼이나 문자 도구(T)로 그래픽을 만드세요.');
  const alignSec = h('div.eg-sec');
  const styleSec = h('div.eg-sec');
  const rollSec = h('div.eg-sec');

  // 반응형 디자인 - 시간 ▸ 롤
  const ck = (label) => {
    const box = h('input', { type: 'checkbox' });
    return { box, el: h('label.check', box, ` ${label}`) };
  };
  const rollOn = ck('롤');
  const rollDir = h('select', { 'aria-label': '롤 방향' }, [['roll', '롤 (위로)'], ['crawlLeft', '크롤 왼쪽'], ['crawlRight', '크롤 오른쪽']].map(([v, l]) => h('option', { value: v }, l)));
  const startOff = ck('화면 밖에서 시작');
  const endOff = ck('화면 밖에서 끝');
  const tcInput = (label) => h('input.tc', { type: 'text', 'aria-label': label, title: `${label} (타임코드 또는 프레임 수)` });
  const preRoll = tcInput('사전 롤');
  const postRoll = tcInput('사후 롤');
  const easeIn = tcInput('감속');
  const easeOut = tcInput('가속');
  for (const el of [preRoll, postRoll, easeIn, easeOut]) el.addEventListener('keydown', (e) => e.stopPropagation());
  let measure = null;

  async function applyRoll() {
    const ids = rollTargets().map((c) => c.id);
    if (!ids.length) return;
    if (!rollOn.box.checked) {
      clearRollCrawl(ids);
      return;
    }
    measure = measure || (await rollMeasure());
    const fps = store.seq.fps;
    const secs = (el) => Math.max(0, parseTimecode(el.value, fps) || 0);
    const n = applyRollCrawl(ids, {
      dir: rollDir.value, startOff: startOff.box.checked, endOff: endOff.box.checked,
      preRoll: secs(preRoll), postRoll: secs(postRoll), easeIn: secs(easeIn), easeOut: secs(easeOut),
    }, measure);
    if (!n) toast('움직일 수 있는 클립이 없습니다');
  }
  for (const el of [rollOn.box, rollDir, startOff.box, endOff.box, preRoll, postRoll, easeIn, easeOut]) el.addEventListener('change', applyRoll);

  function buildEdit() {
    if (built) return;
    built = true;
    ecText = createEffectControls({ only: 'text' });
    ecShape = createEffectControls({ only: 'shape' });
    ecWrap.append(ecText, ecShape, emptyHint);
    const layerBar = h('div.eg-sec', layerList, h('div.row', selName,
      iconButton('text', '새 레이어: 텍스트 (재생헤드 위치)', () => edit.addTextClip(), { label: '텍스트' }),
      iconButton('rectShape', '새 레이어: 사각형', () => edit.addShapeClip('rectangle')),
      iconButton('ellipseShape', '새 레이어: 타원', () => edit.addShapeClip('ellipse'))));
    alignSec.append(h('h4', '정렬 및 변형 (비디오 프레임 기준)'), h('div.row', ALIGN.map(([id, ic, label]) => iconButton(ic, label, () => alignClips(id)))));
    rollSec.append(h('h4', '반응형 디자인 - 시간'),
      h('div.row', rollOn.el, rollDir),
      h('div.row', startOff.el, endOff.el),
      h('div.row', h('span', '사전 롤'), preRoll, h('span', '사후 롤'), postRoll),
      h('div.row', h('span', '감속'), easeIn, h('span', '가속'), easeOut));
    styleSec.append(h('h4', '마스터 스타일'), h('div.row', styleSel,
      iconButton('up', '스타일 속성을 마스터 스타일로 보내기 (이 스타일을 쓴 모든 텍스트가 바뀝니다)', pushMasterStyle),
      iconButton('reset', '마스터 스타일과 동기화 (바꾼 모양을 스타일대로 되돌리기)', syncMasterStyle),
      iconButton('trash', '고른 마스터 스타일 지우기 (적용한 텍스트는 그대로)', deleteMasterStyle)));
    editPane.append(layerBar, alignSec, styleSec, rollSec, ecWrap);
  }

  const alignComp = new Compositor();
  /** Move the selected graphics so their box lines up with the video frame (keyframes move along). */
  function alignClips(which) {
    const s = store.seq;
    const clips = store.selectedClips().filter((c) => c.kind !== 'audio' && c.kind !== 'adjustment' && c.effects.some((e) => e.type === 'motion'));
    if (!clips.length) return toast('정렬할 클립을 타임라인에서 선택하세요');
    const moves = [];
    for (const c of clips) {
      const t = clamp(store.ui.playhead, c.start, clipEnd(c) - 1e-3);
      const q = alignComp.clipQuad(s, c, t, playback.provider);
      if (!q) continue;
      const xs = q.map((p) => p[0]);
      const ys = q.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const dx = { left: -x0, hcenter: s.width / 2 - (x0 + x1) / 2, right: s.width - x1 }[which] || 0;
      const dy = { top: -y0, vcenter: s.height / 2 - (y0 + y1) / 2, bottom: s.height - y1 }[which] || 0;
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) moves.push([c.id, dx, dy]);
    }
    if (!moves.length) return;
    const r = (v) => Math.round(v * 10) / 10;
    store.transact(ALIGN.find(([id]) => id === which)[2], () => {
      for (const [id, dx, dy] of moves) {
        const motion = store.seq.clips[id]?.effects.find((e) => e.type === 'motion');
        if (!motion) continue;
        for (const [k, d] of [['posX', dx], ['posY', dy]]) {
          if (!d) continue;
          const p = motion.params[k];
          p.value = r(p.value + d);
          if (p.kf?.length) p.kf = p.kf.map((kf) => ({ ...kf, v: r(kf.v + d) }));
          if (p.restValue != null) p.restValue = r(p.restValue + d);
        }
      }
    });
  }

  // the graphics under the playhead, top track first, like the layer list of Premiere's 편집 tab
  const layerList = h('div.eg-layers', { role: 'listbox', 'aria-label': '재생헤드 위치의 그래픽 레이어' });
  let layerSig = '';
  function renderLayers() {
    const s = store.seq;
    const t = store.ui.playhead;
    const order = s.tracks.filter((tr) => tr.kind === 'video').map((tr) => tr.id);
    const list = Object.values(s.clips)
      .filter((c) => (c.kind === 'text' || c.kind === 'shape') && c.start <= t + 1e-6 && clipEnd(c) > t + 1e-6)
      .sort((a, b) => order.indexOf(b.trackId) - order.indexOf(a.trackId) || a.start - b.start);
    const sig = list.map((c) => `${c.id}:${c.name}:${store.selection.clips.has(c.id) ? 1 : 0}`).join('|');
    if (sig === layerSig) return;
    layerSig = sig;
    layerList.replaceChildren(...(list.length ? list.map((c) => h(`div.eg-layer${store.selection.clips.has(c.id) ? '.sel' : ''}`, {
      role: 'option', 'aria-selected': String(store.selection.clips.has(c.id)), title: '클릭해서 이 레이어 선택',
      onclick: (e) => {
        if (modKeyEvent(e)) store.selectClips([...new Set([...store.selection.clips, c.id])]);
        else store.selectClips([c.id]);
      },
    }, icon(c.kind === 'text' ? 'text' : 'rectShape', 14), h('span', c.name || (c.kind === 'text' ? '텍스트' : '도형')))) : [h('div.note', '재생헤드 위치에 그래픽 레이어가 없습니다')]));
  }
  const modKeyEvent = (e) => e.ctrlKey || e.metaKey || e.shiftKey;

  // ---- 마스터 스타일: a text look saved in the project and applied to other text clips
  const styleSel = h('select', { 'aria-label': '마스터 스타일' });
  const LOOK_SKIP = new Set(['content', 'reveal']);
  const textFx = (c) => c?.effects.find((e) => e.type === 'text');
  const masterStyles = () => store.project.textStyles || [];
  const selectedTexts = () => store.selectedClips().filter((c) => textFx(c));

  styleSel.addEventListener('change', async () => {
    const v = styleSel.value;
    if (v === '__new') await createMasterStyle();
    else if (v) applyMasterStyle(v);
    styleSig = '';
    refreshEdit();
  });

  async function createMasterStyle() {
    const c = selectedTexts()[0];
    if (!c) return toast('스타일로 저장할 텍스트 클립을 선택하세요');
    const name = await promptDialog('마스터 텍스트 스타일 만들기', '스타일 이름', `텍스트 스타일 ${masterStyles().length + 1}`);
    if (!name?.trim()) return;
    const id = uid('ts');
    const look = lookOf(c);
    store.transact('마스터 텍스트 스타일 만들기', () => {
      store.project.textStyles = [...masterStyles(), { id, name: name.trim(), look }];
      const x = store.seq.clips[c.id];
      if (x) x.textStyle = id;
    });
    toast(`마스터 스타일 "${name.trim()}"을(를) 만들었습니다. 다른 텍스트를 선택하고 목록에서 고르면 같은 모양이 됩니다.`);
  }

  const lookOf = (c) => {
    const look = {};
    for (const [k, p] of Object.entries(textFx(c).params)) if (!LOOK_SKIP.has(k)) look[k] = structuredClone(p.kf?.length ? p.kf[0].v : p.value);
    return look;
  };
  /** Write a style's look onto a text clip (inside a transaction). */
  const writeStyle = (c, st) => {
    const fx = textFx(c);
    if (!fx) return;
    for (const [k, v] of Object.entries(st.look)) {
      const p = fx.params[k];
      if (!p) continue;
      p.value = structuredClone(v);
      p.kf = null;
    }
    c.textStyle = st.id;
  };

  function applyMasterStyle(id) {
    const st = masterStyles().find((x) => x.id === id);
    const clips = selectedTexts();
    if (!st || !clips.length) return;
    store.transact(`마스터 스타일: ${st.name}`, () => {
      for (const c0 of clips) if (store.seq.clips[c0.id]) writeStyle(store.seq.clips[c0.id], st);
    });
  }

  /** 스타일 속성을 마스터 스타일로 보내기: the selected text's look becomes the style, on every text using it. */
  function pushMasterStyle() {
    const c = selectedTexts()[0];
    const st = c && masterStyles().find((x) => x.id === c.textStyle);
    if (!st) return toast('마스터 스타일을 쓰는 텍스트 클립을 선택하세요');
    const look = lookOf(c);
    let n = 0;
    store.transact(`마스터 스타일 업데이트: ${st.name}`, () => {
      store.project.textStyles = masterStyles().map((x) => (x.id === st.id ? { ...x, look } : x));
      const next = store.project.textStyles.find((x) => x.id === st.id);
      for (const seq of Object.values(store.project.sequences)) {
        for (const x of Object.values(seq.clips)) {
          if (x.textStyle !== st.id) continue;
          writeStyle(x, next);
          n++;
        }
      }
    });
    toast(`"${st.name}" 스타일을 쓰는 텍스트 ${n}개를 바꿨습니다`);
  }

  /** 마스터 스타일과 동기화: put the style's look back on the selected texts. */
  function syncMasterStyle() {
    const clips = selectedTexts().filter((c) => masterStyles().some((x) => x.id === c.textStyle));
    if (!clips.length) return toast('마스터 스타일을 쓰는 텍스트 클립을 선택하세요');
    store.transact('마스터 스타일과 동기화', () => {
      for (const c0 of clips) {
        const c = store.seq.clips[c0.id];
        const st = masterStyles().find((x) => x.id === c?.textStyle);
        if (st) writeStyle(c, st);
      }
    });
  }

  async function deleteMasterStyle() {
    const c = selectedTexts()[0];
    const st = masterStyles().find((x) => x.id === (styleSel.value || c?.textStyle));
    if (!st) return toast('지울 마스터 스타일을 목록에서 고르세요');
    if (!(await confirmDialog('마스터 스타일 지우기', `"${st.name}" 스타일을 지울까요? 이 스타일을 쓴 텍스트의 모양은 그대로 남습니다.`))) return;
    store.transact('마스터 스타일 지우기', () => {
      store.project.textStyles = masterStyles().filter((x) => x.id !== st.id);
      for (const seq of Object.values(store.project.sequences)) for (const x of Object.values(seq.clips)) if (x.textStyle === st.id) delete x.textStyle;
    });
  }

  let styleSig = '';
  function renderStyles(c) {
    const list = masterStyles();
    const cur = c?.textStyle && list.some((x) => x.id === c.textStyle) ? c.textStyle : '';
    const sig = `${list.map((x) => `${x.id}:${x.name}`).join('|')}#${cur}`;
    if (sig === styleSig) return;
    styleSig = sig;
    styleSel.replaceChildren(
      h('option', { value: '' }, list.length ? '없음' : '저장한 스타일 없음'),
      ...list.map((x) => h('option', { value: x.id }, x.name)),
      h('option', { value: '__new' }, '마스터 텍스트 스타일 만들기…'));
    styleSel.value = cur;
  }

  function refreshEdit() {
    if (!built) return;
    renderLayers();
    const one = store.selectedClips().length === 1 ? store.selectedClips()[0] : null;
    styleSec.hidden = !selectedTexts().length;
    renderStyles(one);
    const sel = store.selectedClips();
    const c = sel.length === 1 ? sel[0] : null;
    const kind = c?.kind;
    selName.textContent = sel.length > 1 ? `클립 ${sel.length}개` : c ? (c.name || (kind === 'text' ? '텍스트' : '그래픽')) : '선택한 그래픽 없음';
    ecText.style.display = kind === 'text' ? '' : 'none';
    ecShape.style.display = kind === 'shape' ? '' : 'none';
    emptyHint.style.display = kind === 'text' || kind === 'shape' ? 'none' : '';
    const visual = rollTargets();
    alignSec.setAttribute('aria-disabled', String(!visual.length));
    rollSec.setAttribute('aria-disabled', String(!visual.length));
    // the roll fields show the (first) selected clip's settings
    const r = visual[0]?.roll || null;
    const fps = store.seq.fps;
    const focused = rollSec.contains(document.activeElement) ? document.activeElement : null;
    rollOn.box.checked = !!r;
    if (rollDir !== focused) rollDir.value = r?.dir || 'roll';
    startOff.box.checked = r ? !!r.startOff : true;
    endOff.box.checked = r ? !!r.endOff : true;
    for (const [el, key] of [[preRoll, 'preRoll'], [postRoll, 'postRoll'], [easeIn, 'easeIn'], [easeOut, 'easeOut']]) {
      if (el !== focused) el.value = formatTimecode(r?.[key] || 0, fps);
    }
  }

  function refresh() {
    if (!visible) return;
    if (tab === 'browse') renderVisible();
    else refreshEdit();
  }

  let raf = 0;
  const later = () => {
    if (!visible || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refresh();
    });
  };
  store.on('selection', later);
  store.on('change', later);
  store.on('sequence', later);
  // the layer list follows the playhead (cheap: it rebuilds only when its rows change)
  store.on('playhead', () => { if (visible && tab === 'edit' && built) renderLayers(); });

  body.onShow = () => {
    visible = true;
    setTab(tab);
  };
  body.onHide = () => {
    visible = false;
    for (const x of cards) if (x.anim) stopAnim(x);
  };
  Object.assign(graphicsApi, { setTab, insertAt, select: (id) => select(id), alignClips, applyRoll });
  return body;
}

// 창 ▸ 기본 그래픽 (Premiere's Window ▸ Essential Graphics)
extendMenu('창', (items) => [...items, { label: '기본 그래픽', action: () => showPanel('essentialGraphics') }]);
