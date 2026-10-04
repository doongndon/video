// Actions: record menu commands, adjustments and filters (with their values), image size and
// crop, then play them back on any picture; File ▸ Automate ▸ Batch runs one on many files and
// downloads the results as a ZIP. Kept in this browser.

import { h } from '../util.js';
import { toast, openModal, formRow, promptDialog, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { FILTERS, ADJUSTMENTS, defaultFilterParams, defaultParams, applyFilter } from './adjust.js';
import { applyToLayer, adjustCanvas } from './pdialogs.js';

// commands that open a file picker, a dialog of their own, or only change the view
const SKIP = new Set(['open', 'placeFiles', 'place', 'openFromVideo', 'savePsd', 'saveProject', 'exportLayers', 'defineBrush', 'definePattern', 'liquify', 'colorRange', 'selectAndMask', 'quickMaskOptions', 'layerStyle', 'renameLayer', 'renamePath', 'rename', 'toggleRulers', 'toggleGuides', 'toggleGrid', 'toggleSnap', 'toggleGuideLock', 'newGuide', 'guideLayout', 'gridSettings', 'editSmart', 'commitSmart', 'replaceSmart', 'exportSmart', 'placeEmbedded', 'view', 'toggle', 'contentAwareScale', 'puppetWarp', 'fade', 'duplicateDoc', 'batch', 'skyReplacement', 'matchColor', 'focusArea', 'findReplace', 'newComp']);

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

export function installActions(P) {
  let actions = loadPref('photo.actions', null) || DEFAULTS();
  const save = () => {
    try {
      savePref('photo.actions', actions);
    } catch {
      toast('브라우저 저장 공간이 모자라 액션을 저장하지 못했습니다');
    }
  };
  let rec = null; // { action } while recording
  let depth = 0;
  let playing = false;
  const stepName = (s) => {
    if (s.label) return s.label;
    if (s.type === 'filter') return `필터: ${FILTERS[s.id]?.name || s.id}`;
    if (s.type === 'adjust') return `조정: ${ADJUSTMENTS[s.id]?.name || s.id}`;
    if (s.type === 'builtin') return s.id === 'fitLong' ? `긴 변 ${s.size}px로 맞추기` : BUILTIN[s.id] || s.id;
    return s.name;
  };
  const push = (step) => {
    if (!rec || playing) return;
    rec.action.steps.push(step);
    save();
    P.emit('actions');
  };
  /** Dialogs report finished adjustments and filters here. */
  P.recordStep = (step) => push(step);

  // wrap every command (and a few direct calls) so a call from the user is recorded once
  const wrap = (obj, name, key = name) => {
    const fn = obj[name];
    if (typeof fn !== 'function') return;
    obj[name] = function wrapped(...args) {
      const top = depth === 0;
      depth++;
      try {
        const before = P.doc?.history.undoStack.length;
        const r = fn.apply(this, args);
        if (top && rec && !playing && !SKIP.has(name)) {
          let ok = true;
          try {
            ok = JSON.stringify(args).length < 20000 && !args.some((a) => a instanceof HTMLCanvasElement || typeof a === 'function');
          } catch {
            ok = false;
          }
          const after = P.doc?.history.undoStack.length;
          // only steps that changed the document count
          if (ok && after !== before) push({ type: 'cmd', name: key, args: JSON.parse(JSON.stringify(args)), label: P.doc.history.undoStack.at(-1)?.label });
        }
        return r;
      } finally {
        depth--;
      }
    };
  };
  for (const name of Object.keys(P.cmd)) wrap(P.cmd, name);
  for (const name of ['resizeImage', 'cropTo', 'fill', 'strokeSelection']) wrap(P, name, `P.${name}`);

  // ---- playback
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const runStep = async (s) => {
    const doc = P.doc;
    if (!doc) throw new Error('열린 문서가 없습니다');
    if (s.type === 'cmd') {
      const fn = s.name.startsWith('P.') ? P[s.name.slice(2)] : P.cmd[s.name];
      if (!fn) throw new Error(`명령을 찾지 못했습니다: ${s.name}`);
      await fn(...(s.args || []));
      await sleep(60);
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
  const play = async (a, { quiet = false } = {}) => {
    if (!P.doc) return toast('먼저 사진을 여세요');
    if (rec) return toast('녹화 중에는 실행할 수 없습니다. 먼저 녹화를 멈추세요.');
    playing = true;
    P.emit('actions');
    try {
      for (const s of a.steps) if (s.on !== false) await runStep(s);
      if (!quiet) toast(`"${a.name}" 실행 완료 (${a.steps.filter((s) => s.on !== false).length}단계, 실행 취소로 한 단계씩 되돌릴 수 있어요)`);
      return true;
    } catch (err) {
      toast(`"${a.name}" 실행 중 멈춤: ${err.message || err}`);
      return false;
    } finally {
      playing = false;
      P.emit('actions');
    }
  };
  P.actions = { list: () => actions, play, isRecording: () => !!rec, isPlaying: () => playing };

  const C = P.cmd;
  C.newAction = async () => {
    const name = await promptDialog('새 액션', '이름', `액션 ${actions.length + 1}`);
    if (!name) return;
    const a = { id: `a-${Date.now().toString(36)}`, name: name.slice(0, 40), steps: [] };
    actions.push(a);
    rec = { action: a };
    save();
    P.emit('actions');
    toast('녹화를 시작했습니다. 메뉴 명령, 조정, 필터, 이미지 크기가 기록됩니다. 다 하면 ■ 멈춤을 누르세요.');
  };
  C.stopRecording = () => {
    if (!rec) return;
    toast(`"${rec.action.name}" 녹화를 마쳤습니다 (${rec.action.steps.length}단계)`);
    rec = null;
    P.emit('actions');
  };
  C.recordInto = (a) => {
    rec = { action: a };
    P.emit('actions');
    toast(`"${a.name}"에 이어서 녹화합니다`);
  };
  C.deleteAction = (a) => {
    actions = actions.filter((x) => x !== a);
    if (rec?.action === a) rec = null;
    save();
    P.emit('actions');
  };
  C.resetActions = () => {
    actions = DEFAULTS();
    rec = null;
    save();
    P.emit('actions');
  };
  C.batch = () => batchDialog(P, actions, play);
  P.actionsChanged = () => {
    save();
    P.emit('actions');
  };
  P.actionStepName = stepName;
}

// ---------------------------------------------------------------- panel

export function buildActionsPanel(P) {
  const el = h('div.ph-panel.ph-actions');
  const open = new Set();
  let sel = null;
  const render = () => {
    const A = P.actions;
    if (!A) return;
    const list = A.list();
    sel = list.includes(sel) ? sel : list[0] || null;
    const recording = A.isRecording();
    const bar = h('div.ph-act-bar',
      h(`button.small${recording ? '.ph-rec-on' : ''}`, { title: recording ? '녹화 멈춤' : '새 액션 녹화', onclick: () => (recording ? P.cmd.stopRecording() : P.cmd.newAction()) }, recording ? icon('stop', 14) : h('i.ph-rec-dot'), recording ? ' 멈춤' : ' 녹화'),
      h('button.small', { title: '고른 액션 실행', disabled: !sel || recording || A.isPlaying(), onclick: () => sel && A.play(sel) }, icon('play', 14), ' 실행'),
      h('button.small', { title: '여러 사진에 한꺼번에', onclick: () => P.cmd.batch() }, '일괄 처리…'));
    const rows = list.map((a) => {
      const on = a === sel;
      const exp = open.has(a.id);
      const head = h(`div.ph-act-row${on ? '.on' : ''}`, { onclick: () => { sel = a; render(); } },
        h('button.ph-act-tw', { 'aria-label': exp ? '접기' : '펼치기', onclick: (e) => { e.stopPropagation(); if (exp) open.delete(a.id); else open.add(a.id); render(); } }, exp ? '▾' : '▸'),
        h('span.ph-act-name', a.name),
        h('small', `${a.steps.length}단계`),
        h('button.ph-act-x', { title: '이 액션 지우기', 'aria-label': '액션 지우기', onclick: (e) => { e.stopPropagation(); P.cmd.deleteAction(a); } }, icon('close', 12)));
      const steps = exp ? h('div.ph-act-steps',
        ...a.steps.map((s, i) => h('div.ph-act-step',
          h('input', { type: 'checkbox', checked: s.on !== false, title: '끄면 실행할 때 건너뜀', onchange: (e) => { s.on = e.target.checked; P.actionsChanged(); } }),
          h('span', P.actionStepName(s)),
          h('button.ph-act-x', { title: '단계 지우기', 'aria-label': '단계 지우기', onclick: () => { a.steps.splice(i, 1); P.actionsChanged(); } }, icon('close', 12)))),
        h('button.small.ph-act-more', { onclick: () => P.cmd.recordInto(a), disabled: recording }, '여기에 이어서 녹화')) : null;
      return h('div', head, steps);
    });
    el.replaceChildren(bar, h('div.ph-act-list', rows), h('div.note', recording ? '녹화 중: 메뉴 명령, 조정·필터(확인을 누른 값), 이미지 크기·자르기·칠이 기록돼요. 붓질은 기록되지 않아요.' : '액션을 고르고 실행을 누르면 지금 사진에 차례로 적용돼요.'), h('button.small', { onclick: () => P.cmd.resetActions() }, '기본 액션으로 되돌리기'));
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
    body: [formRow('액션', act), formRow('사진 고르기', files), formRow('저장 형식', type), formRow('화질 (%)', q), h('div.note', '사진마다 열기 → 액션 실행 → 저장 → 닫기를 반복하고, 결과를 ZIP 파일 하나로 내려받아요.'), status],
    buttons: [{ label: '닫기' }, {
      label: '시작', primary: true, action: async () => {
        const list = [...files.files];
        if (!list.length) {
          toast('사진을 고르세요');
          return false;
        }
        const IO = await IOp;
        const a = actions[+act.value];
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
          await downloadBlob(zip, `${a.name}-일괄처리.zip`);
        }
        toast(`일괄 처리 끝: ${out.length}장 저장${fail ? `, ${fail}장 문제` : ''}`);
        return undefined;
      },
    }],
  });
  return undefined;
}
