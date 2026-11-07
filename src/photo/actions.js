// Actions: record menu commands, adjustments and filters (with their values), transforms, image size
// and crop, then play them back on any picture; stops (a message, optionally a pause for manual
// work), playing from a chosen step, saving and loading action sets as files. File ▸ Automate ▸
// Batch runs one on many files and downloads the results as a ZIP. Kept in this browser.

import { h } from '../util.js';
import { toast, openModal, formRow, promptDialog, showMenu, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { FILTERS, ADJUSTMENTS, defaultFilterParams, defaultParams, applyFilter } from './adjust.js';
import { applyToLayer, adjustCanvas } from './pdialogs.js';
import { makeCanvas } from './doc.js';

// commands that open a file picker, a dialog of their own, or only change the view
const SKIP = new Set(['open', 'placeFiles', 'place', 'openFromVideo', 'savePsd', 'saveProject', 'saveAs', 'saveCopy', 'exportLayers', 'defineBrush', 'definePattern', 'liquify', 'colorRange', 'selectAndMask', 'quickMaskOptions', 'layerStyle', 'renameLayer', 'renamePath', 'rename', 'toggleRulers', 'toggleGuides', 'toggleGrid', 'toggleSnap', 'toggleGuideLock', 'newGuide', 'guideLayout', 'gridSettings', 'editSmart', 'commitSmart', 'replaceSmart', 'exportSmart', 'placeEmbedded', 'view', 'toggle', 'contentAwareScale', 'puppetWarp', 'fade', 'duplicateDoc', 'batch', 'skyReplacement', 'matchColor', 'focusArea', 'findReplace', 'newComp', 'keyboardShortcuts', 'brushSettings', 'newLayerDialog', 'trimDialog', 'closeAll', 'closeOthers', 'preferences', 'historyOptions', 'toggleLastState', 'freeTransform', 'freeTransformCopy', 'transformSelection', 'revert']);
// commands whose result depends on the last transform: recorded with it
const WITH_TRANSFORM = new Set(['transformAgain', 'transformAgainCopy']);

const adj = (id, p = {}) => ({ type: 'adjust', id, params: { ...defaultParams(id), ...p } });
const fil = (id, p = {}) => ({ type: 'filter', id, params: { ...defaultFilterParams(id), ...p } });
const DEFAULTS = () => [
  { id: 'a-vintage', name: '빈티지 사진', steps: [adj('colorLookup', { look: 'fadedVintage', amount: 85 }), fil('vignette', { amount: 45 }), fil('noise', { amount: 5 })] },
  { id: 'a-vivid', name: '선명한 풍경', steps: [fil('cameraRaw', { clarity: 35, vibrance: 30, dehaze: 15, contrast: 10 })] },
  { id: 'a-bw', name: '흑백 고대비', steps: [adj('bw'), adj('brightness', { contrast: 35 })] },
  { id: 'a-skin', name: '부드러운 피부', steps: [fil('surfaceBlur', { radius: 6, threshold: 22 })] },
  { id: 'a-square', name: '인스타 정사각형 (가운데 자르기)', steps: [{ type: 'builtin', id: 'squareCrop' }] },
  { id: 'a-web', name: '웹용 (긴 변 1080px)', steps: [{ type: 'builtin', id: 'fitLong', size: 1080 }, fil('unsharp', { amount: 40, radius: 0.8 })] },
];
const BUILTIN = { squareCrop: '가운데를 정사각형으로 자르기', fitLong: '긴 변 맞추기' };
const newId = () => `a-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Playback stopped at a Stop step (not an error). */
class Stopped extends Error {}

export function installActions(P) {
  let actions = loadPref('photo.actions', null) || DEFAULTS();
  const save = () => {
    try {
      savePref('photo.actions', actions);
    } catch {
      toast('브라우저 저장 공간이 모자라 액션을 저장하지 못했습니다');
    }
  };
  let rec = null; // { action, at } while recording (at: insert position, null = at the end)
  let depth = 0;
  let playing = false;
  let recCount = 0;
  const stepName = (s) => {
    if (s.type === 'stop') return `멈춤: ${s.message || '(메시지 없음)'}`;
    if (s.label) return s.label;
    if (s.type === 'filter') return `필터: ${FILTERS[s.id]?.name || s.id}`;
    if (s.type === 'adjust') return `조정: ${ADJUSTMENTS[s.id]?.name || s.id}`;
    if (s.type === 'builtin') return s.id === 'fitLong' ? `긴 변 ${s.size}px로 맞추기` : BUILTIN[s.id] || s.id;
    if (s.type === 'transform') return s.copy ? '복사본 변형' : s.sel ? '선택 영역 변형' : '변형';
    return s.name;
  };
  const push = (step) => {
    if (!rec || playing) return;
    if (rec.at == null) rec.action.steps.push(step);
    else rec.action.steps.splice(rec.at++, 0, step);
    recCount++;
    save();
    P.emit('actions');
  };
  /** Dialogs report finished adjustments and filters here. */
  P.recordStep = (step) => push(step);
  const serial = () => P.doc?.history.serial ?? P.doc?.history.undoStack.length;
  const plain = (args) => {
    try {
      // anything that doesn't survive a trip through JSON (pixels, a layer object, an event) is not replayable
      let bad = false;
      // a command used straight as a click handler gets the click: replayed without it
      while (args.length && args[args.length - 1] instanceof Event) args = args.slice(0, -1);
      const s = JSON.stringify(args, (k, v) => {
        if (typeof v === 'function' || v instanceof HTMLCanvasElement || v instanceof ImageData || v instanceof Event || v instanceof Node || (v && typeof v === 'object' && 'kind' in v && 'id' in v && ('canvas' in v || 'parent' in v))) bad = true;
        return v;
      });
      if (bad || s === undefined || s.length >= 20000) return null;
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // wrap every command (and a few direct calls) so a call from the user is recorded once
  const wrap = (obj, name, key = name) => {
    const fn = obj[name];
    if (typeof fn !== 'function') return;
    obj[name] = function wrapped(...args) {
      const top = depth === 0;
      depth++;
      const before = serial();
      const count = recCount;
      const doc = P.doc;
      const record = () => {
        if (!top || !rec || playing || SKIP.has(name) || recCount !== count || serial() === before || P.doc !== doc) return;
        if (WITH_TRANSFORM.has(name)) {
          const M = Array.isArray(args[0]) ? args[0] : P.lastTransform;
          if (M) push({ type: 'transform', M: [...M], copy: name === 'transformAgainCopy', label: name === 'transformAgainCopy' ? '복사본을 다시 변형' : '다시 변형' });
          return;
        }
        const ok = plain(args);
        // only steps that changed the document count
        if (ok) push({ type: 'cmd', name: key, args: ok, label: P.doc.history.undoStack.at(-1)?.label });
      };
      try {
        const r = fn.apply(this, args);
        // a command that asks first (a prompt, a dialog): recorded once it has finished
        if (r && typeof r.then === 'function') r.then(record, () => {});
        else record();
        return r;
      } finally {
        depth--;
      }
    };
  };
  for (const name of Object.keys(P.cmd)) wrap(P.cmd, name);
  for (const name of ['resizeImage', 'cropTo', 'fill', 'strokeSelection']) wrap(P, name, `P.${name}`);
  // picking a layer (Layers panel, Alt+[ ], the Move tool's auto-select) is recorded by its name
  const selectLayer = P.selectLayer;
  P.selectLayer = function wrappedSelect(id, mode = 'single', ...rest) {
    const r = selectLayer.call(this, id, mode, ...rest);
    const l = P.doc?.layer(id);
    if (rec && !playing && depth === 0 && l) {
      const step = { type: 'select', name: l.name, mode, label: `레이어 선택: ${l.name}` };
      const steps = rec.action.steps;
      const at = rec.at == null ? steps.length - 1 : rec.at - 1;
      // a few clicks in a row: only where it ended up counts
      if (mode === 'single' && steps[at]?.type === 'select' && (steps[at].mode || 'single') === 'single') {
        steps[at] = step;
        save();
        P.emit('actions');
      } else push(step);
    }
    return r;
  };
  // free transforms are recorded as the change they made (moving, turning, scaling)
  const applyTransform = P.applyTransform;
  P.applyTransform = function wrappedApply(...args) {
    const t = P.transform;
    const last = P.lastTransform;
    const before = serial();
    const r = applyTransform.apply(this, args);
    if (rec && !playing && t && depth === 0 && serial() !== before && P.lastTransform && P.lastTransform !== last) {
      const copy = !!(t.copy || t.keep);
      push({ type: 'transform', M: [...P.lastTransform], copy, sel: t.kind === 'selection', label: copy ? '복사본 자유 변형' : t.kind === 'selection' ? '선택 영역 변형' : '자유 변형' });
    }
    return r;
  };

  // ---- playback
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stopDialog = (s) => new Promise((resolve) => {
    let go = false;
    openModal({
      title: '액션 멈춤',
      width: '400px',
      body: [h('div', s.message || '여기서 멈춥니다.'), h('div.note', s.cont ? '계속을 누르면 다음 단계부터 이어서 실행합니다. 중지하면 직접 작업한 뒤 액션 패널의 실행 버튼으로 다음 단계부터 이어서 실행할 수 있어요.' : '직접 작업한 뒤 액션 패널의 실행 버튼으로 다음 단계부터 이어서 실행할 수 있어요.')],
      buttons: s.cont ? [{ label: '중지' }, { label: '계속', primary: true, action: () => { go = true; } }] : [{ label: '확인', primary: true }],
      onClose: () => resolve(go),
    });
  });
  const runStep = async (s) => {
    const doc = P.doc;
    if (!doc) throw new Error('열린 문서가 없습니다');
    if (s.type === 'stop') {
      if (!(await stopDialog(s))) throw new Stopped();
      return;
    }
    if (s.type === 'cmd') {
      const fn = s.name.startsWith('P.') ? P[s.name.slice(2)] : P.cmd[s.name];
      if (!fn) throw new Error(`명령을 찾지 못했습니다: ${s.name}`);
      await fn(...(s.args || []));
      await sleep(60);
      return;
    }
    if (s.type === 'select') {
      const l = [...doc.layers].reverse().find((x) => x.name === s.name);
      if (!l) throw new Error(`레이어를 찾지 못했습니다: ${s.name}`);
      P.selectLayer(l.id, s.mode || 'single');
      return;
    }
    if (s.type === 'transform') {
      if (s.sel) {
        if (!doc.selection) throw new Error('변형할 선택 영역이 없습니다');
        const c = makeCanvas(doc.width, doc.height);
        const g = c.getContext('2d');
        g.setTransform(...s.M);
        g.drawImage(doc.selection.canvas, 0, 0);
        P.run('선택 영역 변형', () => { doc.selection = { canvas: c }; });
      } else if (s.copy) {
        // (Transform Again on a copy uses the last transform)
        P.lastTransform = [...s.M];
        P.cmd.transformAgainCopy(s.M);
      } else {
        P.lastTransform = [...s.M];
        P.cmd.transformAgain(s.M, s.label);
      }
      return;
    }
    if (s.type === 'builtin') {
      if (s.id === 'squareCrop') {
        const n = Math.min(doc.width, doc.height);
        P.cropTo({ x: Math.round((doc.width - n) / 2), y: Math.round((doc.height - n) / 2), w: n, h: n }, true, '정사각형 자르기');
      } else if (s.id === 'fitLong') {
        const k = s.size / Math.max(doc.width, doc.height);
        if (k < 1) P.resizeImage(Math.round(doc.width * k), Math.round(doc.height * k));
      }
      return;
    }
    const l = doc.active;
    if (!l || l.kind !== 'raster' || !l.canvas) throw new Error('이미지(일반) 레이어를 골라야 합니다');
    if (s.type === 'filter') {
      if (!FILTERS[s.id]) throw new Error(`필터를 찾지 못했습니다: ${s.id}`);
      P.run(FILTERS[s.id].name, () => applyToLayer(P, (c) => applyFilter(c, s.id, s.params, { fg: P.fg, bg: P.bg })));
    } else if (s.type === 'adjust') {
      if (!ADJUSTMENTS[s.id]) throw new Error(`조정을 찾지 못했습니다: ${s.id}`);
      P.run(ADJUSTMENTS[s.id].name, () => applyToLayer(P, (c) => adjustCanvas(c, s.id, s.params)));
    }
    await sleep(0);
  };
  /**
   * Play an action: all its steps that are on, from step `from` (Play from a selected step), or only
   * that step (`only`). Resolves true when it ran to the end.
   */
  const play = async (a, { quiet = false, from = 0, only = false } = {}) => {
    if (!P.doc) return toast('먼저 사진을 여세요');
    if (rec) return toast('녹화 중에는 실행할 수 없습니다. 먼저 녹화를 멈추세요.');
    if (playing) return false;
    playing = true;
    P.emit('actions');
    const steps = only ? [a.steps[from]].filter(Boolean) : a.steps.slice(from);
    let i = from;
    try {
      for (const s of steps) {
        P.actions.at = { a, i };
        P.emit('actions');
        if (s.on !== false) await runStep(s);
        i++;
      }
      P.actions.at = null;
      if (!quiet) toast(`"${a.name}" 실행 완료 (${steps.filter((s) => s.on !== false && s.type !== 'stop').length}단계, 실행 취소로 한 단계씩 되돌릴 수 있어요)`);
      return true;
    } catch (err) {
      if (err instanceof Stopped) {
        // stopped at a Stop step: the next step is picked, so Play carries on from there
        P.actions.at = null;
        P.pickActionStep?.(a, i + 1 < a.steps.length ? i + 1 : null);
        if (!quiet) toast('멈췄습니다. 실행 버튼을 누르면 다음 단계부터 이어서 실행합니다.');
        return false;
      }
      P.actions.at = null;
      toast(`"${a.name}" 실행 중 멈춤 (${i + 1}단계 · ${stepName(a.steps[i] || {})}): ${err.message || err}`);
      return false;
    } finally {
      playing = false;
      P.emit('actions');
    }
  };
  P.actions = { list: () => actions, play, isRecording: () => !!rec, recording: () => rec?.action || null, isPlaying: () => playing, at: null };

  const C = P.cmd;
  const changed = () => {
    save();
    P.emit('actions');
  };
  C.newAction = async () => {
    // Photoshop: 액션 1, 액션 2… (the first number no action in the set is named with yet)
    let n = 1;
    while (actions.some((a) => a.name === `액션 ${n}`)) n++;
    const name = await promptDialog('새 액션', '이름', `액션 ${n}`);
    if (!name) return;
    const a = { id: newId(), name: name.slice(0, 40), steps: [] };
    actions.push(a);
    rec = { action: a, at: null };
    changed();
    P.pickActionStep?.(a, null);
    toast('녹화를 시작했습니다. 메뉴 명령, 조정, 필터, 변형, 이미지 크기가 기록됩니다. 다 하면 ■ 멈춤을 누르세요.');
  };
  C.stopRecording = () => {
    if (!rec) return;
    toast(`"${rec.action.name}" 녹화를 마쳤습니다 (${rec.action.steps.length}단계)`);
    rec = null;
    P.emit('actions');
  };
  /** Record more into an action: after step `after` (or at the end). */
  C.recordInto = (a, after = null) => {
    rec = { action: a, at: after == null ? null : after + 1 };
    P.emit('actions');
    toast(`"${a.name}"에 이어서 녹화합니다`);
  };
  C.deleteAction = (a) => {
    actions = actions.filter((x) => x !== a);
    if (rec?.action === a) rec = null;
    changed();
  };
  C.resetActions = () => {
    actions = DEFAULTS();
    rec = null;
    changed();
  };
  C.duplicateAction = (a) => {
    const c = { ...structuredClone(a), id: newId(), name: `${a.name} 복사` };
    actions.splice(actions.indexOf(a) + 1, 0, c);
    changed();
    return c;
  };
  C.renameAction = async (a) => {
    const n = await promptDialog('액션 이름', '이름', a.name);
    if (!n?.trim()) return;
    a.name = n.trim().slice(0, 40);
    changed();
  };
  /** Insert Stop: a message, optionally letting playback carry on. */
  C.insertStop = (a, after = null) => {
    if (!a) return toast('먼저 액션을 고르세요');
    const msg = h('textarea', { rows: 3, style: { width: '100%' }, placeholder: '예: 지금 피사체를 직접 선택한 뒤 계속을 누르세요' });
    const cont = h('input', { type: 'checkbox', checked: true });
    openModal({
      title: '멈춤 삽입',
      width: '420px',
      body: [formRow('메시지', msg), h('label.inline', cont, ' 계속 허용 (멈춘 뒤 바로 이어서 실행할 수 있게)')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const s = { type: 'stop', message: msg.value.trim(), cont: cont.checked };
          const at = after == null ? a.steps.length : after + 1;
          a.steps.splice(at, 0, s);
          if (rec?.action === a && rec.at != null && rec.at >= at) rec.at++;
          changed();
          P.pickActionStep?.(a, at);
        },
      }],
    });
    return undefined;
  };
  /** Save action sets as a file (all, or the given ones). */
  C.exportActions = async (list = actions, name = list.length === 1 ? list[0].name : '내 액션') => {
    if (!list.length) return toast('저장할 액션이 없습니다');
    const blob = new Blob([JSON.stringify({ format: 'montage-actions', version: 1, name, actions: list }, null, 1)], { type: 'application/json' });
    const { downloadBlob } = await import('../util.js');
    if (await downloadBlob(blob, `${name}.actions.json`)) toast(`액션 ${list.length}개를 ${name}.actions.json으로 저장했습니다`);
    return undefined;
  };
  /** Load action sets from a file saved here (added after the ones there are). */
  C.importActions = async (files = null) => {
    let list = files;
    if (!list) {
      const { pickFiles } = await import('../ui/project-panel.js');
      list = await pickFiles({ accept: '.json,application/json', multiple: true });
    }
    let n = 0;
    for (const f of list || []) {
      try {
        const o = JSON.parse(await f.text());
        const items = o?.format === 'montage-actions' ? o.actions : Array.isArray(o) ? o : null;
        if (!Array.isArray(items)) throw new Error('Montage 액션 파일이 아닙니다');
        for (const a of items) {
          if (!a || !Array.isArray(a.steps)) continue;
          const steps = a.steps.filter((s) => s && typeof s === 'object' && ['cmd', 'filter', 'adjust', 'builtin', 'transform', 'stop', 'select'].includes(s.type));
          let nm = String(a.name || '액션').slice(0, 40);
          while (actions.some((x) => x.name === nm)) nm = `${nm} 2`.slice(0, 44);
          actions.push({ id: newId(), name: nm, steps });
          n++;
        }
      } catch (err) {
        toast(`${f.name}: 불러오지 못했습니다 (${err.message || err})`);
      }
    }
    if (n) {
      changed();
      toast(`액션 ${n}개를 불러왔습니다`);
    }
    return n;
  };
  C.batch = () => batchDialog(P, actions, play);
  P.actionsChanged = changed;
  P.actionStepName = stepName;
}

// ---------------------------------------------------------------- panel

export function buildActionsPanel(P) {
  const el = h('div.ph-panel.ph-actions');
  const open = new Set();
  let sel = null;
  // the picked step: { a, i } (Play starts there)
  let pick = null;
  const render = () => {
    const A = P.actions;
    if (!A) return;
    const list = A.list();
    sel = list.includes(sel) ? sel : list[0] || null;
    if (pick && (!list.includes(pick.a) || pick.i >= pick.a.steps.length)) pick = null;
    const recording = A.isRecording();
    const busy = recording || A.isPlaying();
    const C = P.cmd;
    const from = pick && pick.a === sel ? pick.i : 0;
    const menu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu([
        { label: '새 액션…', action: () => C.newAction() },
        { label: recording ? '녹화 멈춤' : '녹화 시작 (고른 액션에 이어서)', disabled: !recording && !sel, action: () => (recording ? C.stopRecording() : C.recordInto(sel, pick?.a === sel ? pick.i : null)) },
        { label: '멈춤 삽입…', disabled: !sel || A.isPlaying(), action: () => C.insertStop(sel, pick?.a === sel ? pick.i : null) },
        '-',
        { label: from ? `${from + 1}단계부터 실행` : '실행', disabled: !sel || busy, action: () => A.play(sel, { from }) },
        { label: '고른 단계만 실행', disabled: !pick || busy, action: () => A.play(pick.a, { from: pick.i, only: true }) },
        '-',
        { label: '액션 복제', disabled: !sel, action: () => { sel = C.duplicateAction(sel); render(); } },
        { label: '이름 바꾸기…', disabled: !sel, action: () => C.renameAction(sel) },
        { label: '삭제', disabled: !sel, action: () => C.deleteAction(sel) },
        '-',
        { label: '액션 저장… (고른 액션)', disabled: !sel, action: () => C.exportActions([sel]) },
        { label: '모든 액션 저장…', action: () => C.exportActions() },
        { label: '액션 불러오기…', action: () => C.importActions() },
        { label: '기본 액션으로 되돌리기', action: () => C.resetActions() },
        '-',
        { label: '일괄 처리…', action: () => C.batch() },
      ], r.left, r.bottom + 2);
    };
    const bar = h('div.ph-act-bar',
      h(`button.small${recording ? '.ph-rec-on' : ''}`, { title: recording ? '녹화 멈춤' : '새 액션 녹화', onclick: () => (recording ? C.stopRecording() : C.newAction()) }, recording ? icon('stop', 14) : h('i.ph-rec-dot'), recording ? ' 멈춤' : ' 녹화'),
      h('button.small', { title: from ? `고른 단계(${from + 1})부터 실행` : '고른 액션 실행', disabled: !sel || busy, onclick: () => sel && A.play(sel, { from }) }, icon('play', 14), from ? ` ${from + 1}단계부터` : ' 실행'),
      h('button.small', { title: '멈춤 삽입: 실행 중 메시지를 보여 주고 기다립니다', disabled: !sel || A.isPlaying(), onclick: () => C.insertStop(sel, pick?.a === sel ? pick.i : null) }, '멈춤 삽입…'),
      h('button.small', { title: '액션 메뉴 (저장 · 불러오기 · 복제 · 일괄 처리)', 'aria-label': '액션 메뉴', onclick: menu }, icon('menu', 14)));
    const rows = list.map((a) => {
      const on = a === sel;
      const exp = open.has(a.id) || A.recording() === a || A.at?.a === a;
      const head = h(`div.ph-act-row${on ? '.on' : ''}`, { onclick: () => { sel = a; if (pick?.a !== a) pick = null; render(); }, ondblclick: () => C.renameAction(a), title: '두 번 클릭: 이름 바꾸기' },
        h('button.ph-act-tw', { 'aria-label': exp ? '접기' : '펼치기', onclick: (e) => { e.stopPropagation(); if (exp) open.delete(a.id); else open.add(a.id); render(); } }, icon(exp ? 'chevDown' : 'chevRight', 12)),
        h('span.ph-act-name', a.name),
        h('small', `${a.steps.length}단계`),
        h('button.ph-act-x', { title: '이 액션 지우기', 'aria-label': '액션 지우기', onclick: (e) => { e.stopPropagation(); C.deleteAction(a); } }, icon('close', 12)));
      const stepMenu = (e, i) => {
        e.preventDefault();
        showMenu([
          { label: '여기부터 실행', disabled: busy, action: () => A.play(a, { from: i }) },
          { label: '이 단계만 실행', disabled: busy, action: () => A.play(a, { from: i, only: true }) },
          '-',
          { label: '이 단계 뒤에 녹화', disabled: busy, action: () => C.recordInto(a, i) },
          { label: '이 단계 뒤에 멈춤 삽입…', disabled: A.isPlaying(), action: () => C.insertStop(a, i) },
          '-',
          { label: '위로', disabled: i === 0, action: () => { a.steps.splice(i - 1, 0, ...a.steps.splice(i, 1)); pick = { a, i: i - 1 }; P.actionsChanged(); } },
          { label: '아래로', disabled: i === a.steps.length - 1, action: () => { a.steps.splice(i + 1, 0, ...a.steps.splice(i, 1)); pick = { a, i: i + 1 }; P.actionsChanged(); } },
          { label: '단계 복제', action: () => { a.steps.splice(i + 1, 0, structuredClone(a.steps[i])); P.actionsChanged(); } },
          { label: '단계 지우기', action: () => { a.steps.splice(i, 1); pick = null; P.actionsChanged(); } },
        ], e.clientX, e.clientY);
      };
      const steps = exp ? h('div.ph-act-steps',
        ...a.steps.map((s, i) => {
          const row = h(`div.ph-act-step${pick?.a === a && pick.i === i ? '.on' : ''}${s.type === 'stop' ? '.stop' : ''}${A.at?.a === a && A.at.i === i ? '.on' : ''}`, {
            title: '누르면 이 단계를 고릅니다 (실행이 여기서 시작) · 오른쪽 클릭: 메뉴',
            onclick: () => { sel = a; pick = pick?.a === a && pick.i === i ? null : { a, i }; render(); },
            oncontextmenu: (e) => stepMenu(e, i),
          },
          h('input', { type: 'checkbox', checked: s.on !== false, title: '끄면 실행할 때 건너뜀', onclick: (e) => e.stopPropagation(), onchange: (e) => { s.on = e.target.checked; P.actionsChanged(); } }),
          h('span', P.actionStepName(s)),
          h('button.ph-act-x', { title: '단계 지우기', 'aria-label': '단계 지우기', onclick: (e) => { e.stopPropagation(); a.steps.splice(i, 1); pick = null; P.actionsChanged(); } }, icon('close', 12)));
          return row;
        }),
        h('button.small.ph-act-more', { onclick: () => C.recordInto(a, pick?.a === a ? pick.i : null), disabled: busy }, pick?.a === a ? `${pick.i + 1}단계 뒤에 이어서 녹화` : '여기에 이어서 녹화')) : null;
      return h('div', head, steps);
    });
    el.replaceChildren(bar, h('div.ph-act-list', rows), h('div.note', recording ? '녹화 중: 메뉴 명령, 조정·필터(확인을 누른 값), 자유 변형, 이미지 크기·자르기·칠이 기록돼요. 붓질은 기록되지 않아요.' : '액션을 고르고 실행을 누르면 지금 사진에 차례로 적용돼요. 단계를 누르면 거기서부터 실행합니다.'));
  };
  /** Pick an action and one of its steps (where Play starts). */
  P.pickActionStep = (a, i) => {
    sel = a;
    pick = i == null ? null : { a, i };
    if (pick) open.add(a.id);
    render();
  };
  P.on('actions', render);
  setTimeout(render, 0);
  return el;
}

// ---------------------------------------------------------------- batch

function batchDialog(P, actions, play) {
  if (!actions.length) return toast('액션이 없습니다');
  const IOp = import('./io.js');
  const act = h('select', actions.map((a, i) => h('option', { value: i }, a.name)));
  const files = h('input', { type: 'file', accept: 'image/*,.psd,.mphoto', multiple: true });
  const type = h('select', h('option', { value: 'jpg' }, 'JPG'), h('option', { value: 'png' }, 'PNG'), h('option', { value: 'webp' }, 'WebP'));
  const q = h('input', { type: 'number', min: 30, max: 100, value: 90, style: { width: '70px' } });
  const status = h('div.note');
  openModal({
    title: '일괄 처리 (여러 사진에 액션 실행)',
    width: '440px',
    body: [formRow('액션', act), formRow('사진 고르기', files), formRow('저장 형식', type), formRow('화질 (%)', q), h('div.note', '사진마다 열기 → 액션 실행 → 저장 → 닫기를 반복하고, 결과를 ZIP 파일 하나로 내려받아요. 멈춤 단계는 건너뜁니다.'), status],
    buttons: [{ label: '닫기' }, {
      label: '시작', primary: true, action: async () => {
        const list = [...files.files];
        if (!list.length) {
          toast('사진을 고르세요');
          return false;
        }
        const IO = await IOp;
        const src = actions[+act.value];
        // stops would wait for an answer on every picture
        const a = { ...src, steps: src.steps.filter((s) => s.type !== 'stop') };
        const out = [];
        let fail = 0;
        for (let i = 0; i < list.length; i++) {
          status.textContent = `${i + 1} / ${list.length} 처리 중: ${list[i].name}`;
          toast(status.textContent);
          try {
            P.openDoc(await IO.openFile(list[i]));
            const ok = await play(a, { quiet: true });
            if (!ok) fail++;
            const blob = await IO.exportBlob(P.doc, type.value, +q.value / 100, 1);
            out.push({ name: `${list[i].name.replace(/\.[^.]+$/, '')}.${type.value}`, blob });
          } catch (err) {
            fail++;
            console.warn(err);
          }
          if (P.doc) {
            P.doc.saved = true;
            await P.closeDoc();
          }
        }
        if (out.length) {
          const zip = await IO.zipFiles(out);
          const { downloadBlob } = await import('../util.js');
          await downloadBlob(zip, `${src.name}-일괄처리.zip`);
        }
        toast(`일괄 처리 끝: ${out.length}장 저장${fail ? `, ${fail}장 문제` : ''}`);
        return undefined;
      },
    }],
  });
  return undefined;
}
