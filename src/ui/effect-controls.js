// Effect Controls panel (효과 컨트롤), laid out like Premiere Pro's: every effect of the selected clip
// with scrubbable values and stopwatch keyframing on the left and, when the panel is wide enough, a
// timeline view (타임라인 보기) on the right with the keyframes of every property. Keyframes can be
// marquee-selected, dragged (Alt: copies them), copied / pasted at the playhead, deleted, and given
// Premiere's temporal interpolations (선형 · 베지어 · 자동 베지어 · 연속 베지어 · 정지 · 감속 · 가속)
// or one of 32 easing curves; the twirl next to a property opens its value graph and velocity graph
// with draggable bezier handles. Effects can be selected, reordered by dragging, copied onto other
// clips, reset, switched off, saved as presets and given masks (타원 / 4점 다각형 / 펜). Colour
// curves / wheels, mask points, stabilization analysis and speed-ramp shortcuts live here too, and
// the panel edits the selected transition.
//
// UI state shared with the Program Monitor: store.ui.maskFxId (the 마스크 / 모자이크 effect whose
// shape is edited on the monitor) and store.ui.maskSel = { clipId, fxId, maskId } | null (the
// per-effect mask selected here, see src/masks.js); both announce changes with 'mask-target'.

import { store } from '../store.js';
import * as edit from '../edit.js';
import { commands } from '../commands.js';
import { EFFECTS, TRANSITIONS, TRANSITION_DIRECTIONS, DYNAMIC_OPTIONS, effectFitsClip } from '../effects.js';
import {
  evalParam, isAnimated, toggleAnimation, toggleKeyframeAt, clipEnd, sourceOut, EFFECT_FIXED_TYPES, keyframeDefaults,
  KF_INTERP, kfInterp, setKeyInterp, setKeyHandle, defaultParamValue, setParamValue, createEffect,
} from '../model.js';
import { EASE_FAMILIES, EASE_VARIANTS, easeName, easePath, isEaseId } from '../easing.js';
import { h, clamp, formatTimecode, parseTimecode, deepClone, uid, isMac } from '../util.js';
import { scrubNumber, showMenu, showPanel, fitCanvasToBox, confirmDialog, promptDialog, toast, loadPref, savePref } from './common.js';
import { icon, iconButton } from './icons.js';
import { extendMenu } from './menubar.js';
import { curveTable, Compositor } from '../compositor.js';
import { playback } from '../playback.js';
import { autoTone, whiteBalanceFrom } from '../lumetri.js';
import { analyzeMotion, mediaStatus } from '../media.js';
import { openSavePresetDialog, getPreset, applyPreset } from './presets.js';
import { openFontPicker } from './font-picker.js';
import { fontLabel, loadFontFor } from '../fonts.js';
import { drawGraph, graphScale, graphGeom, hitGraph, sideHandle, GRAPH_HEIGHT, PAD_X } from './ec-graph.js';
import { MASKABLE, addMask, removeMask, duplicateMask, editMask, evalMaskPath, toggleMaskPathAnimation, TRACK_METHODS } from '../masks.js';
import './fxpanels-css.js';

/** Stabilization analyses in progress, keyed by clip id (survive panel rebuilds). */
const analyses = new Map();
/** Mask tracking jobs in progress, keyed by mask id. */
const trackJobs = new Map();
/** Curve channel shown per effect id. */
const curveChannel = new Map();
/** Offscreen compositor for eyedroppers and Lumetri 자동 (created on first use). */
let probeCompositor = null;
/** Cancels the eyedropper waiting for a Program Monitor click, if any. */
let pickCancel = null;

const MASK_TYPES = new Set(['mask', 'censor']);
const mod = isMac ? '⌘' : 'Ctrl+';
const fps = () => store.seq.fps;
const fd = () => 1 / store.seq.fps;
const snapT = (t) => Math.round(t * store.seq.fps) / store.seq.fps;
/** Id of a keyframed property: effect id + param key ('m:<maskId>:<key>' for a mask's params). */
const pid = (fxId, key) => `${fxId}|${key}`;
const namedEase = (k) => !!k?.ease && k.ease !== 'linear' && k.ease !== 'hold';
const interpName = (id) => KF_INTERP.find(([k]) => k === id)?.[1] || '선형';

/** The param object for an effect key or a mask key ('m:<maskId>:<key>') of a clip. */
function resolveParam(clip, fxId, key) {
  const fx = clip?.effects.find((e) => e.id === fxId);
  if (!fx) return null;
  if (key.startsWith('m:')) {
    const [, maskId, pkey] = key.split(':');
    return fx.masks?.find((m) => m.id === maskId)?.params?.[pkey] || null;
  }
  return fx.params[key] || null;
}

/**
 * Clipboard of the panel: copied keyframes ({ kind: 'keys', items: [{ fxId, fxType, key, keys }] },
 * key times relative to the earliest one) or effects ({ kind: 'effects', items: [effect] }).
 * `active` while it is newer than the timeline's clip clipboard, so Edit ▸ 붙여넣기 pastes it.
 */
const ecClip = { kind: null, items: null, active: false };
/**
 * Edit commands each panel instance handles (Effect Controls and the Lumetri 색상 panel register
 * when built); each returns true when it handled the command.
 */
const ecApis = [];
const ecRun = (cmd) => ecApis.some((a) => a[cmd]());

// 편집 ▸ 잘라내기 / 복사 / 붙여넣기 / 지우기 act on the selected keyframes or effects while the
// Effect Controls panel has focus, like Premiere; anywhere else they keep working on clips.
{
  const orig = { copy: commands.copy, cut: commands.cut, paste: commands.paste, clear: commands.clear };
  Object.assign(commands, {
    copy: () => {
      if (ecRun('copy')) return;
      ecClip.active = false;
      orig.copy?.();
    },
    cut: () => {
      if (ecRun('cut')) return;
      ecClip.active = false;
      orig.cut?.();
    },
    paste: () => {
      if (ecClip.active && ecRun('paste')) return;
      orig.paste?.();
    },
    clear: () => {
      if (ecRun('clear')) return;
      orig.clear?.();
    },
  });
  extendMenu('편집', (items) => {
    for (const it of items) if (it && typeof it === 'object' && it.action === commands.paste && ecClip.active) it.disabled = false;
    return items;
  });
}

/** Params whose row only shows for some settings of their effect: type → keys. */
const CONDITIONAL = {
  motion: new Set(['scaleW']),
  transform: new Set(['scaleW']),
  mask: new Set(['points', 'cx', 'cy', 'w', 'h', 'rotation']),
  text: new Set(['bgColor', 'bgOpacity', 'bgPadding', 'bgRadius', 'color2', 'gradAngle', 'shadowColor', 'shadowOpacity', 'shadowAngle', 'shadowDistance', 'shadowSize', 'shadowBlur', 'maskInvert']),
  shape: new Set(['fill2', 'gradAngle', 'gradient', 'fill', 'radius']),
};

/** Parameters that only make sense for some settings of their effect. */
function paramVisible(type, key, v) {
  // 비율 폭 only applies with 균일 비율 off (Premiere greys it out)
  if ((type === 'motion' || type === 'transform') && key === 'scaleW') return v.uniform === false;
  if (type === 'mask') {
    if (key === 'points') return v.shape === 'polygon';
    if (['cx', 'cy', 'w', 'h', 'rotation'].includes(key)) return v.shape !== 'polygon';
  }
  if (type === 'text') {
    if (['bgColor', 'bgOpacity', 'bgPadding', 'bgRadius'].includes(key)) return !!v.background;
    if (['color2', 'gradAngle'].includes(key)) return v.fillType !== undefined && v.fillType !== 'solid';
    if (key.startsWith('shadow') && key !== 'shadowOn') return !!v.shadowOn;
    if (key === 'maskInvert') return !!v.textMask;
  }
  if (type === 'shape') {
    if (['fill2', 'gradAngle'].includes(key)) return !!v.gradient && v.fillOn !== false;
    if (key === 'gradient' || key === 'fill') return v.fillOn !== false;
    if (key === 'radius') return v.shape === 'rectangle';
  }
  return true;
}

/**
 * The Effect Controls panel. With `only` (an effect type) it is a single-effect panel instead, used
 * for Premiere's Lumetri 색상 panel: just that effect of the selected clip, with its sections.
 */
export function createEffectControls({ only = null } = {}) {
  const savedEase = loadPref('kfDefaultEase', 'linear');
  if (isEaseId(savedEase)) keyframeDefaults.ease = savedEase;
  const savedInterp = loadPref('kfDefaultInterp', 'linear');
  if (KF_INTERP.some(([id]) => id === savedInterp)) keyframeDefaults.interp = savedInterp;

  const body = h('div.ec-panel');
  const scroller = h('div.ec');
  const foot = h('div.ec-foot');
  body.append(scroller, foot);
  const collapsed = new Set();
  /** Open property graphs (pid). */
  const expanded = new Set();
  /** Parameter sub-sections ('기본 교정' …) the user opened or closed: `${fxId}§${group}` → open. */
  const groupOpen = new Map();
  /** Selected keyframes: pid → times (indices change as keys move, times identify them). */
  const selKeys = new Map();
  /** Selected effects (ids). */
  const selFx = new Set();
  let showTimeline = !only && loadPref('ec.timeline', true) !== false;
  let leftFrac = clamp(Number(loadPref('ec.leftFrac', 0.6)) || 0.6, 0.3, 0.8);
  let zoom = 1;
  let viewStart = 0;
  let wide = false;
  let sig = '';
  let updaters = [];
  let textArea = null;
  /** True while a drag edits the store: rebuilds wait until it ends (they would drop the drag). */
  let dragging = false;
  let lastClipId = null;

  const tc = (t) => formatTimecode(t, fps());
  const currentClip = () => {
    const sel = store.selectedClips();
    if (sel.length !== 1) {
      // linked pair: prefer the video clip
      if (sel.length === 2 && sel[0].linkId && sel[0].linkId === sel[1].linkId) return sel.find((c) => c.kind !== 'audio');
      return null;
    }
    return sel[0];
  };
  /** The audio clip of a selected linked video + audio pair (its effects show under the video's, like Premiere). */
  const linkedAudio = () => {
    const sel = store.selectedClips();
    if (sel.length !== 2 || !sel[0].linkId || sel[0].linkId !== sel[1].linkId) return null;
    const v = sel.find((c) => c.kind !== 'audio');
    return v ? sel.find((c) => c.kind === 'audio') || null : null;
  };
  const findFx = (clipId, fxId) => store.seq.clips[clipId]?.effects.find((e) => e.id === fxId);
  const tLocal = (clipId) => {
    const c = store.seq.clips[clipId];
    return c ? clamp(store.ui.playhead - c.start, 0, c.duration) : 0;
  };
  function currentValues(clipId, fxId) {
    const f = findFx(clipId, fxId);
    if (!f) return {};
    const t = tLocal(clipId);
    return Object.fromEntries(Object.entries(f.params).map(([k, p]) => [k, evalParam(p, t)]));
  }

  // ---------------------------------------------------------------- keyframe selection

  const isKeySel = (fxId, key, t) => !!selKeys.get(pid(fxId, key))?.some((x) => Math.abs(x - t) < 1e-6);
  function addKeySel(fxId, key, t) {
    const id = pid(fxId, key);
    const list = selKeys.get(id) || [];
    if (!list.some((x) => Math.abs(x - t) < 1e-6)) list.push(t);
    selKeys.set(id, list);
  }
  function removeKeySel(fxId, key, t) {
    const id = pid(fxId, key);
    const list = (selKeys.get(id) || []).filter((x) => Math.abs(x - t) >= 1e-6);
    if (list.length) selKeys.set(id, list);
    else selKeys.delete(id);
  }
  /** The clips the panel shows: the selected clip and, for a linked pair, its audio clip. */
  const shownClips = (clipId) => {
    const main = store.seq.clips[clipId] || currentClip();
    const a = only ? null : linkedAudio();
    return [main, a && a.id !== main?.id ? a : null].filter(Boolean);
  };
  /**
   * Selected keyframes that still exist, on the clip shown (and its linked audio):
   * [{ clip, fx, fxId, key, p, k, i }] resolved in the live project.
   */
  function selectedKeys(clipId) {
    const out = [];
    const clips = shownClips(clipId);
    for (const [id, times] of selKeys) {
      const [fxId, key] = id.split('|');
      const clip = clips.find((c) => c.effects.some((e) => e.id === fxId));
      const fx = clip?.effects.find((e) => e.id === fxId);
      const p = clip && resolveParam(clip, fxId, key);
      if (!fx || !p?.kf) continue;
      p.kf.forEach((k, i) => {
        if (times.some((x) => Math.abs(x - k.t) < 1e-6)) out.push({ clip, fx, fxId, key, p, k, i });
      });
    }
    return out;
  }
  const selectedEffects = (clipId) => (store.seq.clips[clipId]?.effects || []).filter((e) => selFx.has(e.id));
  function selectAllKeys(clipId) {
    selKeys.clear();
    selFx.clear();
    for (const clip of shownClips(clipId)) {
      for (const fx of clip.effects) {
        for (const [k, p] of Object.entries(fx.params)) for (const kk of p.kf || []) addKeySel(fx.id, k, kk.t);
        for (const m of fx.masks || []) for (const [k, p] of Object.entries(m.params || {})) for (const kk of p.kf || []) addKeySel(fx.id, `m:${m.id}:${k}`, kk.t);
      }
    }
    update();
  }

  // ---------------------------------------------------------------- timeline view geometry

  /** Time range [t0, t1] (clip-local seconds) shown by the timeline view. */
  function viewOf(clip) {
    const D = Math.max(fd(), clip.duration);
    const len = D / zoom;
    const s = clamp(viewStart, 0, Math.max(0, D - len));
    return [s, s + len];
  }
  const leftCss = (t0, t1, t) => `calc(${PAD_X}px + ${((t - t0) / Math.max(1e-9, t1 - t0)).toFixed(6)} * (100% - ${PAD_X * 2}px))`;
  function cellGeom(cell, clip) {
    const r = cell.getBoundingClientRect();
    const [t0, t1] = viewOf(clip);
    const iw = Math.max(1, r.width - PAD_X * 2);
    const pxPerSec = iw / Math.max(1e-9, t1 - t0);
    return { r, t0, t1, pxPerSec, x: (t) => r.left + PAD_X + (t - t0) * pxPerSec, t: (cx) => t0 + (cx - r.left - PAD_X) / pxPerSec };
  }
  function setZoom(z, anchor = null) {
    const clip = currentClip();
    if (!clip) return;
    const D = Math.max(fd(), clip.duration);
    const [t0, t1] = viewOf(clip);
    const a = anchor ?? clamp(store.ui.playhead - clip.start, t0, t1);
    const frac = (a - t0) / Math.max(1e-9, t1 - t0);
    zoom = clamp(z, 1, Math.max(1, (D * fps()) / 8));
    const len = D / zoom;
    viewStart = clamp(a - frac * len, 0, Math.max(0, D - len));
    update();
  }

  /** Width-dependent layout; returns true when the timeline view appears or disappears. */
  function layout() {
    const w = scroller.clientWidth;
    if (!w) return false;
    const left = Math.round(clamp(w * leftFrac, 250, Math.max(250, w - 150)));
    scroller.style.setProperty('--ec-left', `${left}px`);
    // the timeline view needs room: narrower panels list keyframes under each property instead
    const next = showTimeline && w >= 540;
    if (next === wide) return false;
    wide = next;
    return true;
  }
  // (on the next frame: a rebuild can toggle the scrollbar, which would resize the panel again)
  let resizeQueued = false;
  new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      if (layout()) rebuild();
      else update();
    });
  }).observe(scroller);

  function setTimelineView(on) {
    showTimeline = on;
    savePref('ec.timeline', on);
    layout();
    rebuild();
  }

  /** Window-level drag: keeps working when the pressed element is re-rendered. */
  function dragWindow(move, up) {
    const mv = (ev) => move(ev);
    const end = (ev) => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      up?.(ev);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- build

  function maskSig(fx) {
    if (!fx.masks?.length) return '';
    return fx.masks.map((m) => `${m.id}.${m.name}.${!!m.inverted}.${m.track}.${collapsed.has(m.id)}.${Object.entries(m.params || {}).map(([k, p]) => `${k}${isAnimated(p) ? '*' : ''}${expanded.has(pid(fx.id, `m:${m.id}:${k}`)) ? '+' : ''}`).join(',')}.${trackJobs.has(m.id)}`).join('/');
  }

  function signature() {
    const tr = store.selection.transition;
    if (tr) {
      const t = store.seq.clips[tr.clipId]?.[tr.edge === 'in' ? 'transIn' : 'transOut'];
      return `tr:${tr.clipId}:${tr.edge}:${t?.type}:${t?.direction}`;
    }
    const c = currentClip();
    if (!c) return `none:${store.selection.clips.size}`;
    const ctx = `${store.project.mediaOrder.length}:${store.seq.tracks.length}:${c.stab ? c.stab.x.length : 0}:${analyses.has(c.id)}:${wide}:${c.label || ''}`;
    const fxSig = (clip) => clip.effects.map((fx) => `${fx.id}.${fx.type}.${fx.enabled}.${collapsed.has(fx.id)}.${maskSig(fx)}.${Object.entries(fx.params).map(([k, p]) => `${k}${isAnimated(p) ? '*' : ''}${expanded.has(pid(fx.id, k)) ? '+' : ''}`).join(',')}`).join('|');
    const a = only ? null : linkedAudio();
    return `clip:${c.id}:${c.kind}:${ctx}:${fxSig(c)}:${a ? `${a.id}:${fxSig(a)}` : ''}:${[...groupOpen].map(([k, v]) => `${k}${v}`).join(',')}`;
  }

  function rebuild() {
    if (dragging) return;
    layout();
    sig = signature();
    updaters = [];
    textArea = null;
    const top = scroller.scrollTop;
    scroller.replaceChildren();
    const tr = store.selection.transition;
    const c = tr ? null : currentClip();
    if ((c?.id ?? null) !== lastClipId) {
      lastClipId = c?.id ?? null;
      selKeys.clear();
      selFx.clear();
      zoom = 1;
      viewStart = 0;
    }
    scroller.classList.toggle('tlv', !!c && wide);
    if (tr) {
      buildTransition(tr);
      buildFoot(null);
      update();
      return;
    }
    if (!c) {
      scroller.append(h('div.empty-hint', store.selection.clips.size > 1
        ? '클립이 여러 개 선택되어 있습니다.\n효과를 편집하려면 클립 하나만 선택하세요.'
        : only
          ? `타임라인에서 영상 클립을 선택하면\n${EFFECTS[only]?.name || '효과'}을(를) 여기서 바로 조절할 수 있습니다.`
          : '타임라인에서 클립을 선택하면 모션·불투명도·볼륨과\n적용한 효과를 여기서 바꿀 수 있습니다.\n\n효과 패널의 효과를 클립 위로 끌어다 놓으세요.'));
      buildFoot(null);
      return;
    }
    if (only) {
      buildOnly(c);
      buildFoot(null);
      update();
      scroller.scrollTop = top;
      return;
    }
    scroller.append(buildTop(c));
    const fixed = c.effects.filter((fx) => EFFECT_FIXED_TYPES.has(fx.type));
    const added = c.effects.filter((fx) => !EFFECT_FIXED_TYPES.has(fx.type));
    scroller.append(h('div.ec-group.ec-row', c.kind === 'audio' ? '오디오 효과' : '비디오 효과'));
    for (const fx of fixed) scroller.append(buildEffect(c, fx));
    scroller.append(h('div.ec-group.ec-row', added.length ? '추가한 효과 — 위에서 아래 순서로 적용 (머리글을 끌어 순서 바꾸기)' : '추가한 효과 없음 — "효과 추가" 또는 효과 패널에서 여기로 끌어다 놓기'));
    for (const fx of added) scroller.append(buildEffect(c, fx));
    // a linked pair: the audio clip's effects follow, as in Premiere's Effect Controls
    const audio = linkedAudio();
    if (audio) {
      scroller.append(h('div.ec-group.ec-row', `오디오 효과 — ${audio.name || '연결된 오디오'}`));
      for (const fx of audio.effects) scroller.append(buildEffect(audio, fx));
    }
    // default mask target: the last mask-like effect on the clip
    const masks = c.effects.filter((fx) => MASK_TYPES.has(fx.type));
    if (masks.length && !masks.some((fx) => fx.id === store.ui.maskFxId)) setMaskTarget(masks[masks.length - 1].id);
    const ms = store.ui.maskSel;
    if (ms && (ms.clipId !== c.id || !findFx(c.id, ms.fxId)?.masks?.some((m) => m.id === ms.maskId))) selectMask(null);
    buildFoot(c);
    update();
    scroller.scrollTop = top;
  }

  /** Single-effect panel (Lumetri 색상): the clip's effect of type `only`, or a button that adds it. */
  function buildOnly(c) {
    const def = EFFECTS[only];
    const list = c.effects.filter((fx) => fx.type === only);
    const title = h('span.title', c.name || c.kind);
    const addBtn = iconButton('plus', `${def?.name || only} 추가`, () => addEffectAt(c.id, only, Infinity), { label: list.length ? '하나 더 추가' : '효과 추가', cls: 'boxed' });
    scroller.append(h('div.ec-top', h('div.ec-head', title, def && effectFitsClip(only, c.kind) ? addBtn : null)));
    if (!def || !effectFitsClip(only, c.kind)) {
      scroller.append(h('div.empty-hint', `${def?.name || only}은(는) 영상 클립에만 쓸 수 있습니다`));
      return;
    }
    if (!list.length) {
      scroller.append(h('div.empty-hint', `이 클립에는 아직 ${def.name} 효과가 없습니다.\n"효과 추가"를 누르면 기본 교정 · 크리에이티브 · 곡선 ·\n색상 휠 · HSL 보조 · 비네팅을 여기서 조절할 수 있습니다.`));
      return;
    }
    for (const fx of list) scroller.append(buildEffect(c, fx));
  }

  function setMaskTarget(fxId) {
    if (store.ui.maskFxId === fxId) return;
    store.ui.maskFxId = fxId;
    store.emit('mask-target');
  }

  function selectMask(sel) {
    const cur = store.ui.maskSel || null;
    if ((cur?.maskId || null) === (sel?.maskId || null) && (cur?.fxId || null) === (sel?.fxId || null)) return;
    store.ui.maskSel = sel;
    store.emit('mask-target');
  }

  function buildTop(c) {
    const title = h('span.title');
    const range = h('span.sub');
    const dot = c.label ? h('span.label-dot', { style: { background: c.label } }) : null;
    updaters.push(() => {
      const cl = store.seq.clips[c.id];
      if (!cl) return;
      title.textContent = cl.name || cl.kind;
      title.title = cl.name || '';
      range.textContent = `${tc(cl.start)} ~ ${tc(clipEnd(cl))}`;
    });
    const addBtn = iconButton('plus', '효과 추가', (e) => openAddMenu(c, e), { label: '효과 추가', cls: 'boxed' });
    const tlBtn = iconButton('tlview', showTimeline ? '타임라인 보기 숨기기' : '타임라인 보기 표시', () => setTimelineView(!showTimeline));
    tlBtn.classList.toggle('on', showTimeline);
    const menuBtn = iconButton('more', '효과 컨트롤 메뉴', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(panelMenuItems(c), r.left, r.bottom + 2);
    });
    const top = h('div.ec-top', h('div.ec-head', dot, title, range, addBtn, tlBtn, menuBtn));
    if (wide) top.append(buildRuler(c));
    return top;
  }

  function panelMenuItems(c) {
    const clip = store.seq.clips[c.id];
    return [
      { label: '타임라인 보기 표시', checked: showTimeline, action: () => setTimelineView(!showTimeline) },
      '-',
      { label: '모든 효과 펼치기', action: () => { collapsed.clear(); rebuild(); } },
      { label: '모든 효과 접기', action: () => { for (const fx of clip?.effects || []) collapsed.add(fx.id); rebuild(); } },
      { label: '열린 그래프 모두 닫기', disabled: !expanded.size, action: () => { expanded.clear(); rebuild(); } },
      '-',
      { label: '키프레임 모두 선택', action: () => selectAllKeys(c.id) },
      { label: '키프레임 붙여넣기 (재생헤드 위치)', key: `${mod}V`, disabled: ecClip.kind !== 'keys', action: () => pasteKeys(c.id) },
      { label: '효과 붙여넣기', key: `${mod}V`, disabled: ecClip.kind !== 'effects', action: () => pasteEffects([c.id]) },
      '-',
      { label: '새 키프레임 기본 보간', submenu: () => KF_INTERP.map(([id, name, en]) => ({ label: name, hint: en, checked: keyframeDefaults.interp === id, action: () => setDefaultInterp(id) })) },
      { label: `새 키프레임 기본 이징 (지금: ${easeName(keyframeDefaults.ease)})`, submenu: () => easeMenu(keyframeDefaults.ease, setDefaultEase) },
      '-',
      { label: selFx.size > 1 ? `사전 설정 저장… (선택한 효과 ${selFx.size}개)` : '사전 설정 저장…', disabled: !selFx.size, action: () => openSavePresetDialog(store.seq.clips[c.id], selectedEffects(c.id)) },
    ];
  }

  function openAddMenu(c, e) {
    const groups = new Map();
    for (const [type, def] of Object.entries(EFFECTS)) {
      if (def.fixed || def.hidden || !effectFitsClip(type, c.kind)) continue;
      const cat = def.category || '기타';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push({ label: def.name, action: () => edit.addEffect([c.id], type) });
    }
    const r = e.currentTarget.getBoundingClientRect();
    const cats = [...groups].sort(([a], [b]) => a.localeCompare(b, 'ko'));
    showMenu(cats.map(([cat, items]) => ({ label: cat, submenu: items.sort((a, b) => a.label.localeCompare(b.label, 'ko')) })), r.left, r.bottom + 2);
  }

  /** Run a mutation of one effect as an undo step, keeping linked time remapping in sync. */
  function mutate(label, c, fx, fn) {
    store.transact(label, () => {
      const f = findFx(c.id, fx.id);
      if (!f) return;
      fn(f, store.seq.clips[c.id]);
      if (f.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
    });
  }

  // ---------------------------------------------------------------- ruler (timeline view header)

  function buildRuler(c) {
    const tcEl = h('span.ec-tc');
    const divider = h('div.ec-divider', { title: '끌어서 속성 목록과 타임라인 보기의 너비 바꾸기' });
    const canvas = h('canvas');
    const cell = h('div.ec-t.ec-ruler', { title: '클릭하거나 끌어서 재생헤드 이동 · Ctrl+휠: 확대/축소' }, canvas);
    const row = h('div.ec-row.ec-ruler-row', h('div.ec-l', tcEl, h('span.ec-ruler-hint', '타임라인 보기'), divider), cell);
    const draw = () => {
      const clip = store.seq.clips[c.id];
      if (!clip || !canvas.isConnected) return;
      tcEl.textContent = tc(store.ui.playhead);
      const { ctx, w, h: hh } = fitCanvasToBox(canvas);
      if (w < 4) return;
      ctx.clearRect(0, 0, w, hh);
      ctx.fillStyle = '#1b1e23';
      ctx.fillRect(0, 0, w, hh);
      const [t0, t1] = viewOf(clip);
      const pps = Math.max(1, w - PAD_X * 2) / Math.max(1e-9, t1 - t0);
      const X = (t) => PAD_X + (t - t0) * pps;
      // the clip
      ctx.fillStyle = '#34507a';
      ctx.fillRect(X(Math.max(0, t0)), hh - 5, Math.max(1, X(Math.min(clip.duration, t1)) - X(Math.max(0, t0))), 4);
      const f = fps();
      const steps = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
      const major = steps.find((s) => s * pps >= 84) || 1800;
      const minor = [major / 10, major / 5, major / 2, major].find((s) => s * pps >= 7 && (s >= 1 / f - 1e-9)) || major;
      ctx.strokeStyle = '#59606c';
      ctx.fillStyle = '#9aa1ad';
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'top';
      ctx.beginPath();
      const n0 = Math.ceil(t0 / minor - 1e-6);
      for (let n = n0; n * minor <= t1 + 1e-6; n++) {
        const t = n * minor;
        const x = Math.round(X(t)) + 0.5;
        const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-4;
        ctx.moveTo(x, hh - 6);
        ctx.lineTo(x, hh - 6 - (isMajor ? 9 : 4));
        if (isMajor) ctx.fillText(tc(clip.start + t), x + 3, 2);
      }
      ctx.stroke();
      const tl = store.ui.playhead - clip.start;
      if (tl >= t0 - 1e-6 && tl <= t1 + 1e-6) {
        const x = X(tl);
        ctx.fillStyle = '#3b8ff0';
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x + 5, 6);
        ctx.lineTo(x, 11);
        ctx.lineTo(x - 5, 6);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(x - 1, 10, 2, hh - 10);
      }
    };
    cell.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const seek = (ev) => {
        const clip = store.seq.clips[c.id];
        if (!clip) return;
        const g = cellGeom(cell, clip);
        store.setPlayhead(clip.start + clamp(snapT(g.t(ev.clientX)), 0, Math.max(0, clip.duration - fd())));
      };
      seek(e);
      dragWindow(seek);
    });
    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      divider.classList.add('dragging');
      const r = scroller.getBoundingClientRect();
      dragWindow((ev) => {
        leftFrac = clamp((ev.clientX - r.left) / r.width, 0.3, 0.8);
        layout();
        update();
      }, () => {
        divider.classList.remove('dragging');
        savePref('ec.leftFrac', leftFrac);
      });
    });
    updaters.push(draw);
    return row;
  }

  // ---------------------------------------------------------------- effects

  function buildEffect(c, fx) {
    const def = EFFECTS[fx.type];
    if (!def) return h('div');
    const fixed = EFFECT_FIXED_TYPES.has(fx.type);
    const sec = h(`div.ec-section${collapsed.has(fx.id) ? '.collapsed' : ''}`);
    sec.dataset.fx = fx.id;
    if (fixed) sec.dataset.fixed = '1';
    const toggle = h(`button.fx-toggle${fx.enabled ? '.on' : ''}`, { title: fx.enabled ? '효과 끄기 (바이패스)' : '효과 켜기', 'aria-pressed': String(fx.enabled) }, 'fx');
    toggle.addEventListener('click', () => mutate(fx.enabled ? '효과 끄기' : '효과 켜기', c, fx, (f) => { f.enabled = !f.enabled; }));
    const twisty = h('span.twisty', { title: '접기/펴기' }, collapsed.has(fx.id) ? '▸' : '▾');
    twisty.addEventListener('click', () => {
      if (collapsed.has(fx.id)) collapsed.delete(fx.id);
      else collapsed.add(fx.id);
      rebuild();
    });
    const name = h('span.fxname', { title: fixed ? def.name : `${def.name} — 끌어서 순서 바꾸기 · 오른쪽 클릭: 메뉴` }, def.name);
    name.addEventListener('dblclick', () => twisty.click());
    const tools = [iconButton('reset', '효과 재설정', () => resetEffect(c, fx))];
    if (MASK_TYPES.has(fx.type)) {
      const pen = iconButton('pen', '프로그램 모니터에서 이 영역 편집', () => {
        setMaskTarget(fx.id);
        showPanel('program');
      });
      pen.classList.toggle('on', store.ui.maskFxId === fx.id);
      updaters.push(() => pen.classList.toggle('on', store.ui.maskFxId === fx.id));
      tools.unshift(pen);
    }
    if (!fixed) {
      tools.push(iconButton('up', '위로 (먼저 적용)', () => edit.moveEffect(c.id, fx.id, -1)));
      tools.push(iconButton('down', '아래로 (나중에 적용)', () => edit.moveEffect(c.id, fx.id, 1)));
      tools.push(iconButton('close', '효과 제거', () => edit.removeEffect(c.id, fx.id)));
    }
    const head = h(`div.ec-sec-head${fixed ? '.fixed' : ''}`, twisty, toggle, name, ...tools);
    head.addEventListener('pointerdown', (e) => headPointerDown(e, c, fx, sec));
    head.addEventListener('contextmenu', (e) => effectMenu(e, c, fx));
    sec.append(h('div.ec-row.ec-hrow', h('div.ec-l', head), h('div.ec-t')));
    if (collapsed.has(fx.id)) {
      updaters.push(() => sec.classList.toggle('sel', selFx.has(fx.id)));
      return sec;
    }
    const params = h('div.ec-params');
    if (fx.type !== 'mask' && MASKABLE(fx.type)) params.append(...buildMasks(c, fx));
    // effects with many sections (Lumetri 색상) start with only the first one open
    const many = new Set(def.params.map((p) => p.group).filter(Boolean)).size >= 3;
    let group = null;
    let groupIndex = -1;
    let open = true;
    for (const pdef of def.params) {
      if ((pdef.group || null) !== group) {
        group = pdef.group || null;
        groupIndex++;
        if (group) {
          const gk = `${fx.id}§${group}`;
          open = groupOpen.has(gk) ? groupOpen.get(gk) : !(many && groupIndex > 0);
          params.append(subHead(group, open, () => { groupOpen.set(gk, !open); rebuild(); }));
        } else open = true;
      }
      if (open) params.append(...buildParam(c, fx, pdef));
    }
    if (fx.type === 'timeRemap') params.append(fullRow(buildRampTools(c, fx)));
    // an effect may bring its own editor above its values (EQ curves: audio-fx2.js)
    if (def.widget) params.prepend(fullRow(def.widget({ clipId: c.id, fxId: fx.id })));
    if (!def.params.length) params.append(fullRow(h('div.ec-wide', h('span.note', '조절할 값이 없는 효과입니다'))));
    sec.append(params);
    updaters.push(() => sec.classList.toggle('sel', selFx.has(fx.id)));
    return sec;
  }

  function subHead(label, open, onToggle) {
    const tw = h('span.twisty', open ? '▾' : '▸');
    const head = h('div.ec-mask-head', { style: { cursor: 'pointer' } }, tw, h('span.mname', label));
    head.addEventListener('click', onToggle);
    return h('div.ec-row.ec-hrow.ec-subhead', h('div.ec-l', head), h('div.ec-t'));
  }

  const fullRow = (el) => h('div.ec-row.ec-fullrow', h('div.ec-full', el));

  function headPointerDown(e, c, fx, sec) {
    if (e.button !== 0 || e.target.closest('button, .twisty')) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const was = selFx.has(fx.id);
    if (additive) {
      if (was) selFx.delete(fx.id);
      else selFx.add(fx.id);
    } else if (!was) {
      selFx.clear();
      selFx.add(fx.id);
    }
    selKeys.clear();
    if (MASK_TYPES.has(fx.type)) setMaskTarget(fx.id);
    update();
    if (EFFECT_FIXED_TYPES.has(fx.type) || e.pointerType === 'touch') return;
    // drag the header to reorder the added effects
    const y0 = e.clientY;
    let line = null;
    let target = -1;
    dragWindow((ev) => {
      if (!line && Math.abs(ev.clientY - y0) < 5) return;
      if (!line) {
        line = h('div.ec-dropline');
        document.body.append(line);
        sec.style.opacity = '0.55';
      }
      const pos = dropIndex(ev.clientY, fx.id);
      target = pos.index;
      Object.assign(line.style, { left: `${pos.left}px`, width: `${pos.width}px`, top: `${pos.y - 1}px` });
    }, () => {
      if (!line) {
        if (!additive && was && selFx.size > 1) {
          selFx.clear();
          selFx.add(fx.id);
          update();
        }
        return;
      }
      line.remove();
      sec.style.opacity = '';
      if (target >= 0) moveEffectTo(c.id, fx.id, target);
    });
  }

  /** Where a dragged effect lands among the added effects (index without `excludeId`) and its line. */
  function dropIndex(y, excludeId = null) {
    const secs = [...scroller.querySelectorAll('.ec-section[data-fx]')].filter((s) => !s.dataset.fixed && s.dataset.fx !== excludeId);
    const sr = scroller.getBoundingClientRect();
    let index = secs.length;
    for (let i = 0; i < secs.length; i++) {
      const r = secs[i].getBoundingClientRect();
      if (y < r.top + Math.min(r.height, 60) / 2) {
        index = i;
        break;
      }
    }
    let lineY;
    if (!secs.length) {
      const groups = scroller.querySelectorAll('.ec-group');
      lineY = groups.length ? groups[groups.length - 1].getBoundingClientRect().bottom : sr.top;
    } else if (index < secs.length) lineY = secs[index].getBoundingClientRect().top;
    else lineY = secs[secs.length - 1].getBoundingClientRect().bottom;
    return { index, y: clamp(lineY, sr.top, sr.bottom), left: sr.left + 4, width: Math.max(10, sr.width - 8) };
  }

  function moveEffectTo(clipId, fxId, index) {
    store.transact('효과 순서 변경', () => {
      const clip = store.seq.clips[clipId];
      const moving = clip?.effects.find((e) => e.id === fxId);
      if (!moving || EFFECT_FIXED_TYPES.has(moving.type)) return;
      const fixed = clip.effects.filter((e) => EFFECT_FIXED_TYPES.has(e.type));
      const others = clip.effects.filter((e) => !EFFECT_FIXED_TYPES.has(e.type) && e.id !== fxId);
      others.splice(clamp(index, 0, others.length), 0, moving);
      clip.effects = [...fixed, ...others];
    });
  }

  function addEffectAt(clipId, type, index) {
    const def = EFFECTS[type];
    const clip = store.seq.clips[clipId];
    if (!def || !clip || def.fixed) return;
    if (!effectFitsClip(type, clip.kind)) {
      toast(`${def.name}은(는) ${def.kind === 'audio' ? '오디오' : '영상'} 클립에만 쓸 수 있습니다`);
      return;
    }
    store.transact(`${def.name} 추가`, () => {
      const cl = store.seq.clips[clipId];
      const fixed = cl.effects.filter((e) => EFFECT_FIXED_TYPES.has(e.type));
      const others = cl.effects.filter((e) => !EFFECT_FIXED_TYPES.has(e.type));
      others.splice(clamp(index, 0, others.length), 0, createEffect(type, store.seq));
      cl.effects = [...fixed, ...others];
    });
  }

  function effectMenu(e, c, fx) {
    e.preventDefault();
    if (!selFx.has(fx.id)) {
      selFx.clear();
      selFx.add(fx.id);
      selKeys.clear();
      update();
    }
    const clip = store.seq.clips[c.id];
    if (!clip) return;
    const sel = selectedEffects(c.id);
    const anyAdded = sel.some((f) => !EFFECT_FIXED_TYPES.has(f.type));
    const fixed = EFFECT_FIXED_TYPES.has(fx.type);
    const added = clip.effects.filter((f) => !EFFECT_FIXED_TYPES.has(f.type));
    const at = added.findIndex((f) => f.id === fx.id);
    const f = findFx(c.id, fx.id);
    showMenu([
      { label: '효과 재설정', action: () => resetEffect(c, fx) },
      { label: f?.enabled ? '효과 끄기' : '효과 켜기', action: () => mutate(f?.enabled ? '효과 끄기' : '효과 켜기', c, fx, (x) => { x.enabled = !x.enabled; }) },
      '-',
      { label: '잘라내기', key: `${mod}X`, disabled: !anyAdded, action: () => copyEffects(c.id) && deleteEffects(c.id) },
      { label: '복사', key: `${mod}C`, action: () => copyEffects(c.id) },
      { label: '붙여넣기', key: `${mod}V`, disabled: ecClip.kind !== 'effects', action: () => pasteEffects([c.id]) },
      { label: '지우기', key: 'Delete', disabled: !anyAdded, action: () => deleteEffects(c.id) },
      '-',
      { label: '위로 이동 (먼저 적용)', disabled: fixed || at <= 0, action: () => edit.moveEffect(c.id, fx.id, -1) },
      { label: '아래로 이동 (나중에 적용)', disabled: fixed || at < 0 || at >= added.length - 1, action: () => edit.moveEffect(c.id, fx.id, 1) },
      '-',
      { label: sel.length > 1 ? `사전 설정 저장… (효과 ${sel.length}개)` : '사전 설정 저장…', action: () => openSavePresetDialog(store.seq.clips[c.id], selectedEffects(c.id)) },
    ], e.clientX, e.clientY);
  }

  /** Premiere's 효과 재설정: values back to defaults; animated values get a default keyframe at the playhead. */
  function resetEffect(c, fx) {
    const def = EFFECTS[fx.type];
    if (!def) return;
    mutate('효과 재설정', c, fx, (f, clip) => {
      const t = clamp(store.ui.playhead - clip.start, 0, clip.duration);
      for (const pdef of def.params) {
        const p = f.params[pdef.key];
        if (!p) continue;
        const v = defaultParamValue(pdef, store.seq);
        const val = v && typeof v === 'object' ? deepClone(v) : v;
        if (isAnimated(p) && typeof val === 'number') setParamValue(p, val, t, fd());
        else {
          p.value = val;
          p.kf = null;
        }
      }
    });
  }

  function resetParam(c, fx, pdef) {
    mutate(`${pdef.label} 재설정`, c, fx, (f, clip) => {
      const p = f.params[pdef.key];
      if (!p) return;
      const v = defaultParamValue(pdef, store.seq);
      const val = v && typeof v === 'object' ? deepClone(v) : v;
      if (isAnimated(p) && typeof val === 'number') setParamValue(p, val, clamp(store.ui.playhead - clip.start, 0, clip.duration), fd());
      else {
        p.value = val;
        if (typeof val !== 'number') p.kf = null;
      }
    });
  }

  function resetButton(c, fx, pdef) {
    if (['action', 'points', 'text'].includes(pdef.type)) return h('span');
    const b = h('button', { title: '매개변수 재설정', 'aria-label': `${pdef.label} 재설정` }, icon('reset'));
    b.addEventListener('click', () => resetParam(c, fx, pdef));
    return b;
  }

  // ---------------------------------------------------------------- parameters

  function buildParam(c, fx, pdef) {
    const key = pdef.key;
    const param = fx.params[key];
    // action rows are buttons: they need no stored value (older effects may lack the key)
    if (!param && pdef.type !== 'action') return [];
    const label = h('span.label', { title: pdef.hint ? `${pdef.label} — ${pdef.hint}` : pdef.label }, pdef.label);
    switch (pdef.type) {
      case 'number':
        return buildNumber(c, fx, pdef, key, label);
      case 'font':
        return [paramRow(c, fx, pdef, label, buildFont(c, fx, key))];
      case 'select': {
        const opts = selectOptions(pdef, c);
        const control = h('select', { 'aria-label': pdef.label }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(param.value) }, l)));
        if (!opts.some(([v]) => String(v) === String(param.value))) control.prepend(h('option', { value: param.value, selected: true }, '(없음 — 다시 고르세요)'));
        control.addEventListener('change', () => mutate(`${pdef.label} 변경`, c, fx, (f) => { f.params[key].value = control.value; }));
        updaters.push(() => {
          const v = findFx(c.id, fx.id)?.params[key]?.value;
          if (v != null && document.activeElement !== control && control.value !== String(v) && [...control.options].some((o) => o.value === String(v))) control.value = String(v);
        });
        return [paramRow(c, fx, pdef, label, control)];
      }
      case 'color': {
        const control = h('input', { type: 'color', value: param.value, 'aria-label': pdef.label });
        let begun = false;
        control.addEventListener('input', () => {
          if (!begun) {
            store.begin(`${pdef.label} 변경`);
            begun = true;
          }
          const f = findFx(c.id, fx.id);
          if (f) f.params[key].value = control.value;
          store.changed();
        });
        control.addEventListener('change', () => {
          if (begun) store.commit();
          begun = false;
        });
        updaters.push(() => {
          const f = findFx(c.id, fx.id);
          if (f && !begun && control.value !== f.params[key].value) control.value = f.params[key].value;
        });
        const wrap = pdef.eyedropper ? h('span.inline', control, eyedropperButton(c, fx, pdef)) : control;
        return [paramRow(c, fx, pdef, label, wrap)];
      }
      case 'bool': {
        const control = h('input', { type: 'checkbox', checked: !!param.value, 'aria-label': pdef.label });
        control.addEventListener('change', () => mutate(`${pdef.label} 변경`, c, fx, (f) => { f.params[key].value = control.checked; }));
        updaters.push(() => {
          const v = !!findFx(c.id, fx.id)?.params[key]?.value;
          if (control.checked !== v) control.checked = v;
        });
        return [paramRow(c, fx, pdef, label, control)];
      }
      case 'text': {
        const control = h('textarea', { rows: 3, 'aria-label': pdef.label }, param.value);
        textArea = control;
        let begun = false;
        control.addEventListener('focus', () => {
          store.begin('텍스트 편집');
          begun = true;
        });
        control.addEventListener('input', () => {
          const f = findFx(c.id, fx.id);
          if (f) f.params[key].value = control.value;
          store.changed();
        });
        control.addEventListener('blur', () => {
          if (begun) store.commit();
          begun = false;
        });
        control.addEventListener('keydown', (e) => {
          e.stopPropagation();
          // Esc ends typing, as in Premiere (the shortcuts work again)
          if (e.key === 'Escape') control.blur();
        });
        updaters.push(() => {
          const v = findFx(c.id, fx.id)?.params[key]?.value;
          if (!begun && typeof v === 'string' && control.value !== v) control.value = v;
        });
        return [fullRow(h('div.ec-wide', label, control))];
      }
      case 'curves':
        return [fullRow(h('div.ec-wide', label, buildCurves(c, fx, key)))];
      case 'hueCurves':
        return [fullRow(h('div.ec-wide', label, buildHueCurves(c, fx, key)))];
      case 'wheel':
        return [fullRow(h('div.ec-wide', label, buildWheel(c, fx, key)))];
      case 'points': {
        const row = fullRow(h('div.ec-wide', label, buildPoints(c, fx, key)));
        updaters.push(() => { row.hidden = !paramVisible(fx.type, key, currentValues(c.id, fx.id)); });
        return [row];
      }
      case 'action': {
        const el = buildActionRow(pdef.action || (fx.type === 'stabilize' ? 'stabilize' : 'button'), c, fx, pdef);
        return el ? [fullRow(h('div.ec-wide', label, el))] : [];
      }
      default:
        return [];
    }
  }

  function paramRow(c, fx, pdef, label, control) {
    const left = h('div.ec-l.ecp', h('span'), h('span'), label, h('span.ec-val', control), h('span.ec-ptools', h('span.kf-spacer'), resetButton(c, fx, pdef)));
    const row = h('div.ec-row.ec-prow', left, h('div.ec-t'));
    if (CONDITIONAL[fx.type]?.has(pdef.key)) updaters.push(() => { row.hidden = !paramVisible(fx.type, pdef.key, currentValues(c.id, fx.id)); });
    return row;
  }

  function selectOptions(pdef, c) {
    if (typeof pdef.options !== 'string') return pdef.options;
    const fn = DYNAMIC_OPTIONS[pdef.options];
    let opts = fn ? fn(store.project, store.seq) : [];
    if (pdef.options === 'videoTracks') opts = [['', '(트랙 고르기)'], ...opts.filter(([id]) => id !== c.trackId)];
    return opts;
  }

  /**
   * A numeric property row: stopwatch, scrubbable value, keyframe navigator, reset, its keyframes in
   * the timeline view and (twirl open) its value / velocity graph. `key` may address a mask param.
   */
  function buildNumber(c, fx, pdef, key, label, { onReset = null } = {}) {
    const id = pid(fx.id, key);
    const getP = () => resolveParam(store.seq.clips[c.id], fx.id, key);
    const param = getP();
    if (!param) return [];
    const animated = isAnimated(param);
    const isMaskKey = key.startsWith('m:');
    const scr = scrubNumber({
      value: evalParam(param, tLocal(c.id)),
      step: pdef.step ?? 1,
      min: pdef.min,
      max: pdef.max,
      unit: pdef.unit,
      decimals: pdef.step && pdef.step < 1 ? 2 : 1,
      onStart: () => {
        dragging = true;
        store.begin(`${pdef.label} 변경`);
      },
      onChange: (v) => {
        const clip = store.seq.clips[c.id];
        const f = findFx(c.id, fx.id);
        const p = getP();
        if (!clip || !f || !p) return;
        if (isMaskKey) setParamValue(p, v, tLocal(c.id), fd());
        else edit.rawSetParam(clip, f, key, v);
        if (f.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
        store.changed();
      },
      onCommit: () => {
        dragging = false;
        store.commit();
        afterDrag();
      },
    });
    updaters.push(() => {
      const p = getP();
      if (p) scr.update(evalParam(p, tLocal(c.id)));
    });
    let twirl = h('span');
    let stopwatch = h('span');
    let tools = null;
    const reset = onReset ? h('button', { title: '매개변수 재설정', 'aria-label': `${pdef.label} 재설정`, onclick: onReset }, icon('reset')) : resetButton(c, fx, pdef);
    if (pdef.animatable !== false) {
      const open = expanded.has(id);
      twirl = h(`button.ec-twirl${open ? '.on' : ''}`, { title: open ? '그래프 닫기' : '값 그래프 · 속도 그래프 보기', 'aria-expanded': String(open), 'aria-label': `${pdef.label} 그래프` }, open ? '▾' : '▸');
      twirl.addEventListener('click', () => {
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        rebuild();
      });
      stopwatch = h(`button.stopwatch${animated ? '.on' : ''}`, { title: animated ? '애니메이션 끄기 (키프레임 모두 삭제)' : '애니메이션 켜기 (키프레임 만들기)', 'aria-label': `${pdef.label} 애니메이션 켜기/끄기` }, icon('stopwatch'));
      stopwatch.addEventListener('click', () => toggleStopwatch(c, fx, key, pdef.label));
      if (animated) tools = h('span.ec-ptools', ...kfNav(c, fx, key), reset);
    }
    if (!tools) tools = h('span.ec-ptools', h('span.kf-spacer'), reset);
    // 비율 reads 비율 높이 while 균일 비율 is off (비율 폭 is then the width)
    if ((fx.type === 'motion' && key === 'scale') || (fx.type === 'transform' && key === 'scaleH')) {
      updaters.push(() => {
        const name = findFx(c.id, fx.id)?.params.uniform?.value === false ? '비율 높이' : '비율';
        if (label.textContent !== name) label.textContent = name;
      });
    }
    const left = h('div.ec-l.ecp', twirl, stopwatch, label, h('span.ec-val', scr), tools);
    const cell = h('div.ec-t');
    const row = h(`div.ec-row.ec-prow${animated ? '.has-kf' : ''}`, left, cell);
    buildLane(c, fx, key, cell);
    const rows = [row];
    if (pdef.animatable !== false && expanded.has(id)) rows.push(buildGraphRow(c, fx, key, pdef));
    if (!isMaskKey && CONDITIONAL[fx.type]?.has(key)) {
      updaters.push(() => {
        const vis = paramVisible(fx.type, key, currentValues(c.id, fx.id));
        for (const r of rows) r.hidden = !vis;
      });
    }
    return rows;
  }

  /** ◀ ◆ ▶ (previous / add-remove / next keyframe) and the interpolation menu button. */
  function kfNav(c, fx, key) {
    const prev = h('button', { title: '이전 키프레임으로 이동', 'aria-label': '이전 키프레임으로 이동' }, icon('kfPrev'));
    const add = h('button', { title: '키프레임 추가/제거', 'aria-label': '키프레임 추가/제거' }, icon('diamond'));
    const next = h('button', { title: '다음 키프레임으로 이동', 'aria-label': '다음 키프레임으로 이동' }, icon('kfNext'));
    const easeBtn = h('button.ease-btn', { title: '보간: 선택한 키프레임 (없으면 재생헤드 위치 구간)의 움직임 고르기', 'aria-label': '키프레임 보간' }, icon('ease'));
    prev.addEventListener('click', () => gotoKf(c.id, fx.id, key, -1));
    next.addEventListener('click', () => gotoKf(c.id, fx.id, key, 1));
    add.addEventListener('click', () => store.transact('키프레임 추가/제거', () => {
      const p = resolveParam(store.seq.clips[c.id], fx.id, key);
      if (!p) return;
      if (key.endsWith(':path')) toggleMaskPathKey(p, tLocal(c.id));
      else toggleKeyframeAt(p, tLocal(c.id), fd());
      if (findFx(c.id, fx.id)?.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
    }));
    easeBtn.addEventListener('click', (e) => {
      const p = resolveParam(store.seq.clips[c.id], fx.id, key);
      const kf = p?.kf || [];
      if (!kf.length) return;
      if (!selKeys.get(pid(fx.id, key))?.length) {
        const t = tLocal(c.id);
        let i = kf.findIndex((k) => Math.abs(k.t - t) < fd() / 2);
        if (i < 0) i = Math.max(0, kf.filter((k) => k.t < t).length - 1);
        selKeys.clear();
        selFx.clear();
        addKeySel(fx.id, key, kf[i].t);
        update();
      }
      const r = e.currentTarget.getBoundingClientRect();
      const first = selectedKeys(c.id)[0];
      if (first) keyMenu(r.left, r.bottom + 2, c.id, first.fxId, first.key, first.k.t);
    });
    updaters.push(() => {
      const p = resolveParam(store.seq.clips[c.id], fx.id, key);
      const t = tLocal(c.id);
      add.classList.toggle('on', !!p?.kf?.some((k) => Math.abs(k.t - t) < fd() / 2));
    });
    return [prev, add, next, easeBtn];
  }

  async function toggleStopwatch(c, fx, key, label) {
    const p = resolveParam(store.seq.clips[c.id], fx.id, key);
    if (!p) return;
    const on = isAnimated(p);
    if (on && !(await confirmDialog('키프레임 삭제', `이 작업을 하면 "${label}"의 기존 키프레임이 모두 삭제됩니다. 계속하시겠습니까?`))) return;
    store.transact(on ? '애니메이션 끄기' : '애니메이션 켜기', () => {
      const pp = resolveParam(store.seq.clips[c.id], fx.id, key);
      if (!pp) return;
      if (key.endsWith(':path')) {
        const m = findFx(c.id, fx.id)?.masks?.find((x) => x.id === key.split(':')[1]);
        if (m) toggleMaskPathAnimation(m, tLocal(c.id));
      } else toggleAnimation(pp, tLocal(c.id));
      if (findFx(c.id, fx.id)?.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
    });
    if (on) selKeys.delete(pid(fx.id, key));
  }

  function toggleMaskPathKey(p, t) {
    const i = p.kf?.findIndex((k) => Math.abs(k.t - t) < fd() / 2) ?? -1;
    if (i >= 0) {
      if (p.kf.length === 1) {
        p.value = p.kf[0].v;
        p.kf = null;
      } else p.kf.splice(i, 1);
    } else if (p.kf) {
      p.kf.push({ t, v: deepClone(evalMaskPath(p, t)), ease: 'linear' });
      p.kf.sort((a, b) => a.t - b.t);
    }
  }

  function gotoKf(clipId, fxId, key, dir) {
    const c = store.seq.clips[clipId];
    const p = resolveParam(c, fxId, key);
    if (!c || !p?.kf) return;
    const t = store.ui.playhead - c.start;
    const list = p.kf.map((k) => k.t);
    const target = dir < 0 ? list.filter((x) => x < t - fd() / 2).pop() : list.find((x) => x > t + fd() / 2);
    if (target != null) store.setPlayhead(c.start + target);
  }

  // ---------------------------------------------------------------- keyframes in the timeline view

  function keyTitle(clip, k) {
    const kind = namedEase(k) ? `이징: ${easeName(k.ease)}` : interpName(kfInterp(k));
    const v = typeof k.v === 'number' ? ` · 값 ${Math.round(k.v * 100) / 100}` : '';
    return `${kind} · ${tc(clip.start + k.t)}${v}\n끌기: 이동 · Alt+끌기: 복제 · Shift/Ctrl+클릭: 여러 개 선택 · 오른쪽 클릭: 보간`;
  }

  function buildLane(c, fx, key, cell) {
    const ph = h('div.ph');
    cell.append(ph);
    let last = '';
    cell.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.kfd')) return;
      startMarquee(e, c.id, cell);
    });
    updaters.push(() => {
      const clip = store.seq.clips[c.id];
      const p = resolveParam(clip, fx.id, key);
      if (!clip || !p || !cell.isConnected) return;
      const kf = p.kf || [];
      const [t0, t1] = viewOf(clip);
      const tl = store.ui.playhead - clip.start;
      const half = fd() / 2;
      const s = `${t0},${t1}|${kf.map((k) => `${k.t}:${kfInterp(k)}:${k.ease || ''}:${isKeySel(fx.id, key, k.t) ? 1 : 0}:${Math.abs(k.t - tl) < half ? 1 : 0}`).join(';')}`;
      if (s !== last) {
        last = s;
        cell.querySelectorAll('.kfd').forEach((d) => d.remove());
        for (const k of kf) {
          if (k.t < t0 - 1e-6 || k.t > t1 + 1e-6) continue;
          const d = h(`div.kfd.${namedEase(k) ? 'ease' : kfInterp(k)}`, { title: keyTitle(clip, k), style: { left: leftCss(t0, t1, k.t) } });
          if (isKeySel(fx.id, key, k.t)) d.classList.add('sel');
          if (Math.abs(k.t - tl) < half) d.classList.add('at');
          d.dataset.fx = fx.id;
          d.dataset.key = key;
          d.dataset.t = String(k.t);
          const kt = k.t;
          d.addEventListener('pointerdown', (e) => keyPointerDown(e, c.id, fx.id, key, kt, cell));
          d.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            keyMenu(e.clientX, e.clientY, c.id, fx.id, key, kt);
          });
          cell.append(d);
        }
      }
      const on = tl >= t0 - 1e-6 && tl <= t1 + 1e-6;
      ph.style.display = on ? '' : 'none';
      if (on) ph.style.left = leftCss(t0, t1, tl);
    });
  }

  /** Rebuild each touched property from its original keys with the selected ones moved by dt. */
  function applyKeyMove(clipId, groups, dt, dup) {
    const half = fd() / 2;
    for (const g of groups) {
      const p = resolveParam(store.seq.clips[g.cid], g.fid, g.k);
      if (!p) continue;
      const moved = [];
      const still = [];
      for (const k of g.kf) {
        if (g.sel.some((x) => Math.abs(x - k.t) < 1e-6)) {
          moved.push({ ...deepClone(k), t: snapT(k.t + dt) });
          if (dup) still.push(deepClone(k));
        } else still.push(deepClone(k));
      }
      const kept = still.filter((k) => !moved.some((m) => Math.abs(m.t - k.t) < half));
      p.kf = [...kept, ...moved].sort((a, b) => a.t - b.t);
    }
    for (const cid of new Set(groups.map((g) => g.cid))) {
      if (store.seq.clips[cid]?.effects.some((e) => e.type === 'timeRemap' && groups.some((g) => g.fid === e.id))) edit.rawSyncLinkedRemap(cid);
    }
  }

  function keyPointerDown(e, clipId, fxId, key, t, cell) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const wasSel = isKeySel(fxId, key, t);
    if (!wasSel) {
      if (!additive) selKeys.clear();
      addKeySel(fxId, key, t);
      selFx.clear();
      update();
    }
    const clip = store.seq.clips[clipId];
    if (!clip) return;
    const geo = cellGeom(cell, clip);
    const groups = [];
    let minT = Infinity;
    let maxT = -Infinity;
    const clips = shownClips(clipId);
    for (const [id, times] of selKeys) {
      const [fid, k] = id.split('|');
      const owner = clips.find((cc) => cc.effects.some((e) => e.id === fid));
      const p = owner && resolveParam(owner, fid, k);
      if (!p?.kf) continue;
      groups.push({ cid: owner.id, fid, k, kf: deepClone(p.kf), sel: times.slice() });
      for (const x of times) {
        minT = Math.min(minT, x);
        maxT = Math.max(maxT, x);
      }
    }
    const tl0 = store.ui.playhead - clip.start;
    const D = clip.duration;
    const x0 = e.clientX;
    const dup = e.altKey;
    let moved = false;
    let lastDt = 0;
    const reselect = (dt) => {
      selKeys.clear();
      for (const g of groups) for (const x of g.sel) addKeySel(g.fid, g.k, snapT(x + dt));
    };
    dragWindow((ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) {
        moved = true;
        dragging = true;
        store.begin(dup ? '키프레임 복제' : '키프레임 이동');
      }
      let dt = dx / geo.pxPerSec;
      // the grabbed key snaps to the playhead
      if (Math.abs(t + dt - tl0) * geo.pxPerSec < 6) dt = tl0 - t;
      dt = Math.round(dt * fps()) / fps();
      dt = clamp(dt, Math.min(0, -minT), Math.max(0, D - maxT));
      lastDt = dt;
      applyKeyMove(clipId, groups, dt, dup);
      reselect(dt);
      store.changed();
    }, () => {
      if (moved) {
        reselect(lastDt);
        dragging = false;
        store.commit();
        afterDrag();
        return;
      }
      if (wasSel && additive) removeKeySel(fxId, key, t);
      else if (wasSel) {
        selKeys.clear();
        addKeySel(fxId, key, t);
      }
      update();
    });
  }

  function startMarquee(e, clipId, cell) {
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Map([...selKeys].map(([k, v]) => [k, v.slice()])) : new Map();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let box = null;
    dragWindow((ev) => {
      if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      if (!box) {
        box = h('div.ec-marquee');
        document.body.append(box);
        selFx.clear();
      }
      const l = Math.min(x0, ev.clientX);
      const r = Math.max(x0, ev.clientX);
      const tp = Math.min(y0, ev.clientY);
      const b = Math.max(y0, ev.clientY);
      Object.assign(box.style, { left: `${l}px`, top: `${tp}px`, width: `${r - l}px`, height: `${b - tp}px` });
      selKeys.clear();
      for (const [k, v] of base) selKeys.set(k, v.slice());
      for (const d of scroller.querySelectorAll('.ec-t .kfd')) {
        const dr = d.getBoundingClientRect();
        const cx = dr.left + dr.width / 2;
        const cy = dr.top + dr.height / 2;
        if (cx >= l && cx <= r && cy >= tp && cy <= b) addKeySel(d.dataset.fx, d.dataset.key, Number(d.dataset.t));
      }
      update();
    }, (ev) => {
      if (box) {
        box.remove();
        return;
      }
      // a click on empty space: deselect and put the playhead there
      if (!additive) {
        selKeys.clear();
        selFx.clear();
      }
      const clip = store.seq.clips[clipId];
      if (clip && ev?.type === 'pointerup') {
        const g = cellGeom(cell, clip);
        store.setPlayhead(clip.start + clamp(snapT(g.t(ev.clientX)), 0, Math.max(0, clip.duration - fd())));
      }
      update();
    });
  }

  // ---------------------------------------------------------------- keyframe menu, interpolation, clipboard

  /** Easing menu items; `current` marks the active one (null = mixed). */
  function easeMenu(current, apply) {
    return [
      { group: '기본' },
      { label: '직선', hint: '일정한 속도', curve: easePath('linear'), checked: current === 'linear', action: () => apply('linear') },
      { label: '부드럽게', hint: '천천히 출발·멈춤', curve: easePath('ease'), checked: current === 'ease', action: () => apply('ease') },
      { label: '정지', hint: '다음 키프레임에서 뚝 바뀜', curve: easePath('hold'), checked: current === 'hold', action: () => apply('hold') },
      { group: '이징 곡선 (마우스를 올리면 In / Out 선택)' },
      ...EASE_FAMILIES.map((f) => ({
        label: f.name,
        hint: f.desc,
        curve: easePath(`out${f.id}`),
        checked: !!current && current.endsWith(f.id) && current !== 'linear',
        submenu: EASE_VARIANTS.map(([v, lab, desc]) => ({
          label: lab, hint: desc, curve: easePath(`${v}${f.id}`), checked: current === `${v}${f.id}`, action: () => apply(`${v}${f.id}`),
        })),
      })),
    ];
  }

  function keyMenu(x, y, clipId, fxId, key, t) {
    if (!isKeySel(fxId, key, t)) {
      selKeys.clear();
      selFx.clear();
      addKeySel(fxId, key, t);
      update();
    }
    const list = selectedKeys(clipId);
    if (!list.length) return;
    const numeric = list.filter(({ k }) => typeof k.v === 'number');
    const kinds = new Set(list.map(({ k }) => (namedEase(k) ? 'ease' : kfInterp(k))));
    const cur = kinds.size === 1 ? [...kinds][0] : null;
    const eases = new Set(list.map(({ k }) => (namedEase(k) ? k.ease : kfInterp(k) === 'hold' ? 'hold' : 'linear')));
    const curEase = eases.size === 1 ? [...eases][0] : null;
    const bezierOk = numeric.length > 0 || list.every(({ key: kk }) => kk.endsWith(':path'));
    showMenu([
      { group: list.length > 1 ? `시간 보간 — 선택한 키프레임 ${list.length}개` : '시간 보간' },
      ...KF_INTERP.map(([id, name, en]) => ({
        label: name, hint: en, checked: cur === id, disabled: id !== 'linear' && id !== 'hold' && !bezierOk,
        action: () => setInterpForSelection(clipId, id),
      })),
      { label: '이징 곡선 (32가지)', submenu: () => easeMenu(curEase, (ease) => setEaseForSelection(clipId, ease)) },
      '-',
      { label: '잘라내기', key: `${mod}X`, action: () => copyKeys(clipId) && deleteKeys(clipId) },
      { label: '복사', key: `${mod}C`, action: () => copyKeys(clipId) },
      { label: '붙여넣기', key: `${mod}V`, hint: '재생헤드 위치', disabled: ecClip.kind !== 'keys', action: () => pasteKeys(clipId) },
      { label: '지우기', key: 'Delete', action: () => deleteKeys(clipId) },
      '-',
      { label: '새 키프레임 기본 보간', submenu: () => KF_INTERP.map(([id, name, en]) => ({ label: name, hint: en, checked: keyframeDefaults.interp === id, action: () => setDefaultInterp(id) })) },
      { label: `새 키프레임 기본 이징 (지금: ${easeName(keyframeDefaults.ease)})`, submenu: () => easeMenu(keyframeDefaults.ease, setDefaultEase) },
    ], x, y);
  }

  function syncRemap(clipId) {
    for (const c of shownClips(clipId)) if (c.effects.some((e) => e.type === 'timeRemap')) edit.rawSyncLinkedRemap(c.id);
  }

  function setInterpForSelection(clipId, type) {
    store.transact(`키프레임 보간: ${interpName(type)}`, () => {
      for (const { p, i, k } of selectedKeys(clipId)) {
        if (typeof k.v === 'number') setKeyInterp(p, i, type);
        else {
          // non-numeric keys (mask paths): only the timing type applies
          if (k.ease && k.ease !== 'linear') k.ease = 'linear';
          if (type === 'linear') delete k.interp;
          else k.interp = type;
        }
      }
      syncRemap(clipId);
    });
  }

  function setEaseForSelection(clipId, ease) {
    store.transact(`이징: ${easeName(ease)}`, () => {
      for (const { p, i, k } of selectedKeys(clipId)) {
        if (ease === 'hold') {
          if (typeof k.v === 'number') setKeyInterp(p, i, 'hold');
          else k.interp = 'hold';
          continue;
        }
        if (kfInterp(k) === 'hold') {
          if (typeof k.v === 'number') setKeyInterp(p, i, 'linear');
          else delete k.interp;
          if (k.ease === 'hold') k.ease = 'linear';
        }
        k.ease = ease;
      }
      syncRemap(clipId);
    });
  }

  function setDefaultEase(ease) {
    keyframeDefaults.ease = ease;
    savePref('kfDefaultEase', ease);
    toast(`새로 만드는 키프레임은 "${easeName(ease)}" 이징으로 시작합니다`);
  }

  function setDefaultInterp(id) {
    keyframeDefaults.interp = id;
    savePref('kfDefaultInterp', id);
    toast(`새로 만드는 키프레임은 "${interpName(id)}" 보간으로 시작합니다`);
  }

  function copyKeys(clipId) {
    const list = selectedKeys(clipId);
    if (!list.length) return false;
    const t0 = Math.min(...list.map(({ k }) => k.t));
    const groups = new Map();
    for (const { fx, fxId, key, k } of list) {
      const id = pid(fxId, key);
      if (!groups.has(id)) groups.set(id, { fxId, fxType: fx.type, key, keys: [] });
      groups.get(id).keys.push({ ...deepClone(k), t: k.t - t0 });
    }
    ecClip.kind = 'keys';
    ecClip.items = [...groups.values()];
    ecClip.active = true;
    toast(`키프레임 ${list.length}개를 복사했습니다 — 재생헤드를 옮기고 ${mod}V로 붙여 넣으세요`);
    return true;
  }

  function pasteKeys(clipId) {
    const c = store.seq.clips[clipId];
    if (!c || ecClip.kind !== 'keys') return false;
    const pasted = [];
    store.transact('키프레임 붙여넣기', () => {
      const clips = shownClips(clipId);
      for (const it of ecClip.items) {
        const byId = clips.find((cc) => cc.effects.some((e) => e.id === it.fxId));
        const clip = byId || clips.find((cc) => cc.effects.some((e) => e.type === it.fxType));
        const f = clip && (clip.effects.find((e) => e.id === it.fxId) || clip.effects.find((e) => e.type === it.fxType));
        if (!f) continue;
        const tl = clamp(store.ui.playhead - clip.start, 0, clip.duration);
        let key = it.key;
        if (key.startsWith('m:') && !f.masks?.some((m) => m.id === key.split(':')[1])) {
          // a mask of another clip: the mask with the same position in the list
          const src = it.key.split(':');
          const m = f.masks?.[0];
          if (!m) continue;
          key = `m:${m.id}:${src[2]}`;
        }
        const p = resolveParam(clip, f.id, key);
        if (!p || !it.keys.length || typeof p.value !== typeof it.keys[0].v) continue;
        const kf = p.kf ? p.kf.slice() : [];
        for (const k0 of it.keys) {
          const t = snapT(tl + k0.t);
          for (let j = kf.length - 1; j >= 0; j--) if (Math.abs(kf[j].t - t) < fd() / 2) kf.splice(j, 1);
          kf.push({ ...deepClone(k0), t });
          pasted.push({ fxId: f.id, key, t });
        }
        kf.sort((a, b) => a.t - b.t);
        p.kf = kf;
      }
      syncRemap(clipId);
    });
    if (!pasted.length) {
      toast('이 클립에는 복사한 키프레임을 붙여 넣을 속성이 없습니다');
      return true;
    }
    selKeys.clear();
    selFx.clear();
    for (const x of pasted) addKeySel(x.fxId, x.key, x.t);
    update();
    return true;
  }

  function deleteKeys(clipId) {
    const list = selectedKeys(clipId);
    if (!list.length) return false;
    store.transact(list.length > 1 ? `키프레임 ${list.length}개 지우기` : '키프레임 지우기', () => {
      const byParam = new Map();
      for (const it of selectedKeys(clipId)) {
        const id = pid(it.fxId, it.key);
        if (!byParam.has(id)) byParam.set(id, { p: it.p, clip: it.clip, times: [] });
        byParam.get(id).times.push(it.k.t);
      }
      for (const { p, clip, times } of byParam.values()) {
        const t = clamp(store.ui.playhead - clip.start, 0, clip.duration);
        const keep = p.kf.filter((k) => !times.some((x) => Math.abs(x - k.t) < 1e-6));
        if (keep.length) p.kf = keep;
        else {
          const v = Array.isArray(p.kf[0]?.v) ? deepClone(evalMaskPath(p, t)) : evalParam(p, t);
          p.value = v;
          p.kf = null;
        }
      }
      syncRemap(clipId);
    });
    selKeys.clear();
    update();
    return true;
  }

  function copyEffects(clipId) {
    const list = selectedEffects(clipId);
    if (!list.length) return false;
    ecClip.kind = 'effects';
    ecClip.items = deepClone(list);
    ecClip.active = true;
    toast(`효과 ${list.length}개를 복사했습니다 — 다른 클립을 선택하고 ${mod}V로 붙여 넣으세요`);
    return true;
  }

  function pasteEffects(ids) {
    if (ecClip.kind !== 'effects') return false;
    let n = 0;
    store.transact('효과 붙여넣기', () => {
      for (const id of ids) {
        const clip = store.seq.clips[id];
        if (!clip) continue;
        let any = false;
        for (const src of ecClip.items) {
          if (!EFFECTS[src.type] || !effectFitsClip(src.type, clip.kind)) continue;
          if (EFFECT_FIXED_TYPES.has(src.type)) {
            const ex = clip.effects.find((e) => e.type === src.type);
            if (!ex) continue;
            ex.params = deepClone(src.params);
            ex.enabled = src.enabled;
            if (src.masks) ex.masks = deepClone(src.masks);
          } else clip.effects.push({ ...deepClone(src), id: uid('fx') });
          any = true;
        }
        if (any) {
          n++;
          edit.rawSyncLinkedRemap(id);
        }
      }
    });
    toast(n ? `효과를 클립 ${n}개에 붙여 넣었습니다` : '선택한 클립에는 이 효과를 붙여 넣을 수 없습니다');
    return true;
  }

  function deleteEffects(clipId) {
    const list = selectedEffects(clipId);
    const removable = list.filter((f) => !EFFECT_FIXED_TYPES.has(f.type));
    if (!removable.length) {
      if (list.length) toast('모션·불투명도 같은 기본 효과는 지울 수 없습니다 (효과 재설정으로 되돌리세요)');
      return !!list.length;
    }
    const ids = new Set(removable.map((f) => f.id));
    store.transact(removable.length > 1 ? `효과 ${removable.length}개 지우기` : '효과 지우기', () => {
      const clip = store.seq.clips[clipId];
      if (clip) clip.effects = clip.effects.filter((f) => !ids.has(f.id));
    });
    for (const id of ids) selFx.delete(id);
    return true;
  }

  const ecFocused = () => store.ui.focusPanel === (only ? 'lumetri' : 'effectControls') && body.classList.contains('active') && body.isConnected;
  const api = {};
  ecApis.push(api);
  api.copy = () => {
    if (!ecFocused()) return false;
    const c = currentClip();
    if (!c) return false;
    if (selectedKeys(c.id).length) return copyKeys(c.id);
    if (selFx.size) return copyEffects(c.id);
    return false;
  };
  api.cut = () => {
    if (!ecFocused()) return false;
    const c = currentClip();
    if (!c) return false;
    if (selectedKeys(c.id).length) return copyKeys(c.id) && deleteKeys(c.id);
    if (selFx.size && selectedEffects(c.id).some((f) => !EFFECT_FIXED_TYPES.has(f.type))) return copyEffects(c.id) && deleteEffects(c.id);
    return false;
  };
  api.paste = () => {
    // the Lumetri 색상 panel pastes only while it has focus; Effect Controls also from elsewhere
    if (only && !ecFocused()) return false;
    if (ecClip.kind === 'keys') {
      const c = currentClip();
      return c ? pasteKeys(c.id) : false;
    }
    if (ecClip.kind === 'effects') {
      const ids = ecFocused() && currentClip() ? [currentClip().id] : [...store.selection.clips];
      return ids.length ? pasteEffects(ids) : false;
    }
    return false;
  };
  api.clear = () => {
    if (!ecFocused()) return false;
    const c = currentClip();
    if (!c) return false;
    if (selectedKeys(c.id).length) return deleteKeys(c.id);
    if (selFx.size) return deleteEffects(c.id);
    // Delete with the panel focused never removes the clip itself
    return true;
  };

  // ---------------------------------------------------------------- value / velocity graph

  function buildGraphRow(c, fx, key, pdef) {
    const canvas = h('canvas', { 'aria-label': `${pdef.label} 값 그래프와 속도 그래프` });
    canvas.style.height = `${GRAPH_HEIGHT}px`;
    const cell = h('div.ec-t.ec-graph', canvas);
    const left = h('div.ec-l.ec-graph-l',
      h('div', h('b', '값 그래프'), h('div', '키프레임을 위아래로 끌면 값, 옆으로 끌면 시간이 바뀝니다')),
      h('div', h('b', '속도 그래프'), h('div', '흰 점(핸들)을 끌어 가속·감속을 조절합니다. Ctrl+끌기: 양쪽 핸들 따로')));
    const row = h('div.ec-row.ec-grow', left, cell);
    let scale = null;
    let frozen = null;
    const getP = () => resolveParam(store.seq.clips[c.id], fx.id, key);
    const selSet = (kf) => {
      const s = new Set();
      kf.forEach((k, i) => { if (isKeySel(fx.id, key, k.t)) s.add(i); });
      return s;
    };
    const shownSet = (kf) => {
      const s = selSet(kf);
      if (!s.size) kf.forEach((k, i) => s.add(i));
      return s;
    };
    const draw = () => {
      const clip = store.seq.clips[c.id];
      const p = getP();
      if (!clip || !p || !canvas.isConnected) return;
      const { ctx, w } = fitCanvasToBox(canvas);
      if (w < 10) return;
      const [t0, t1] = viewOf(clip);
      const kf = p.kf || [];
      const shown = shownSet(kf);
      scale = frozen || graphScale(p, t0, t1, w, shown);
      drawGraph(ctx, w, { param: p, t0, t1, tNow: store.ui.playhead - clip.start, sel: selSet(kf), shown, scale, unit: pdef.unit === '%' ? '%' : '', decimals: pdef.step && pdef.step < 1 ? 2 : 1 });
    };
    updaters.push(draw);
    const hitAt = (e) => {
      const clip = store.seq.clips[c.id];
      const p = getP();
      if (!clip || !p || !scale) return null;
      const r = canvas.getBoundingClientRect();
      const [t0, t1] = viewOf(clip);
      return { clip, p, r, t0, t1, hit: hitGraph(e.clientX - r.left, e.clientY - r.top, { param: p, t0, t1, w: r.width, scale, shown: shownSet(p.kf || []) }) };
    };
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const res = hitAt(e);
      canvas.style.cursor = res?.hit ? (res.hit.kind === 'handle' ? 'grab' : 'move') : 'default';
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const res = hitAt(e);
      if (res?.hit?.kind === 'key' || res?.hit?.kind === 'handle') {
        const k = res.p.kf?.[res.hit.i];
        if (k) keyMenu(e.clientX, e.clientY, c.id, fx.id, key, k.t);
      }
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const res = hitAt(e);
      if (!res) return;
      e.preventDefault();
      e.stopPropagation();
      const { clip, p, r, t0, t1, hit } = res;
      const g = graphGeom(r.width, t0, t1, scale);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (!hit) {
        if (!additive) {
          selKeys.clear();
          selFx.clear();
        }
        store.setPlayhead(clip.start + clamp(snapT(g.t(e.clientX - r.left)), 0, Math.max(0, clip.duration - fd())));
        update();
        return;
      }
      const k0 = { ...p.kf[hit.i] };
      if (!isKeySel(fx.id, key, k0.t)) {
        if (!additive) selKeys.clear();
        addKeySel(fx.id, key, k0.t);
        selFx.clear();
      }
      frozen = scale;
      let begun = false;
      const begin = (label) => {
        if (begun) return;
        begun = true;
        dragging = true;
        store.begin(label);
      };
      const end = () => {
        frozen = null;
        if (begun) {
          dragging = false;
          store.commit();
          afterDrag();
        } else update();
      };
      if (hit.kind === 'handle') {
        update();
        dragWindow((ev) => {
          begin('베지어 핸들 조정');
          const f2 = findFx(c.id, fx.id);
          const p2 = getP();
          const k = p2?.kf?.[hit.i];
          if (!k) return;
          const hd = sideHandle(p2.kf, hit.i, hit.side);
          if (!hd) return;
          const px = ev.clientX - r.left;
          const py = ev.clientY - r.top;
          const tp = g.t(px);
          let speed;
          let inf;
          if (hit.graph === 'value') {
            const dt = clamp(hit.side === 'out' ? tp - k.t : k.t - tp, hd.T * 0.01, hd.T);
            inf = (dt / hd.T) * 100;
            const vp = g.v(py);
            speed = hit.side === 'out' ? (vp - k.v) / dt : (k.v - vp) / dt;
          } else {
            inf = clamp((Math.abs(tp - k.t) / hd.T) * 100, 0.1, 100);
            speed = g.s(py);
          }
          setKeyHandle(p2, hit.i, hit.side, { speed, inf }, { broken: ev.ctrlKey || ev.metaKey });
          if (f2?.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
          store.changed();
        }, end);
        return;
      }
      if (hit.graph !== 'value') {
        frozen = null;
        update();
        return;
      }
      // a key in the value graph: up/down changes its value, left/right its time (Shift: one direction)
      const orig = deepClone(p.kf);
      const x0 = e.clientX;
      const y0 = e.clientY;
      const pps = g.x(1) - g.x(0);
      let newT = k0.t;
      const decimals = pdef.step && pdef.step < 1 ? 100 : 10;
      update();
      dragWindow((ev) => {
        let dx = ev.clientX - x0;
        let dy = ev.clientY - y0;
        if (!begun && Math.hypot(dx, dy) < 3) return;
        begin('키프레임 값 변경');
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const f2 = findFx(c.id, fx.id);
        const p2 = getP();
        if (!p2?.kf) return;
        const prev = orig[hit.i - 1];
        const next = orig[hit.i + 1];
        let t = dx ? snapT(k0.t + dx / pps) : k0.t;
        t = clamp(t, prev ? prev.t + fd() : -Infinity, next ? next.t - fd() : Infinity);
        let v = dy ? g.v(g.yv(k0.v) + dy) : k0.v;
        v = clamp(Math.round(v * decimals) / decimals, pdef.min ?? -Infinity, pdef.max ?? Infinity);
        const list = deepClone(orig);
        list[hit.i].t = t;
        list[hit.i].v = v;
        p2.kf = list;
        if (!isAnimated(p2)) p2.value = v;
        newT = t;
        if (f2?.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
        store.changed();
      }, () => {
        if (begun) {
          removeKeySel(fx.id, key, k0.t);
          addKeySel(fx.id, key, newT);
        }
        end();
      });
    });
    return row;
  }

  function afterDrag() {
    if (signature() !== sig) rebuild();
    else update();
  }

  // ---------------------------------------------------------------- masks (per effect, src/masks.js)

  function buildMasks(c, fx) {
    const rows = [];
    const make = (kind) => {
      const id = addMask(c.id, fx.id, kind);
      if (!id) return;
      selectMask({ clipId: c.id, fxId: fx.id, maskId: id });
      if (kind === 'pen') toast('프로그램 모니터를 클릭해 점을 찍어 마스크를 그리세요 (처음 점을 다시 누르면 닫힘)');
      showPanel('program', { quiet: true });
    };
    const bar = h('div.ec-maskbar',
      iconButton('maskEllipse', '타원 마스크 만들기', () => make('ellipse')),
      iconButton('maskPoly', '4점 다각형 마스크 만들기', () => make('polygon')),
      iconButton('pen', '자유 그리기 베지어 (펜 마스크)', () => make('pen')),
      h('span.note', fx.masks?.length ? '' : '마스크: 효과를 화면 일부에만 적용'));
    rows.push(fullRow(bar));
    for (const m of fx.masks || []) rows.push(...buildMask(c, fx, m));
    return rows;
  }

  function buildMask(c, fx, m) {
    const rows = [];
    const sel = () => store.ui.maskSel?.maskId === m.id;
    const twisty = h('span.twisty', collapsed.has(m.id) ? '▸' : '▾');
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsed.has(m.id)) collapsed.delete(m.id);
      else collapsed.add(m.id);
      rebuild();
    });
    const name = h('span.mname', { title: '클릭: 프로그램 모니터에서 편집 · 두 번 클릭: 이름 바꾸기' }, m.name);
    const invBtn = iconButton('eyeOff', '반전 (마스크 밖에 효과 적용)', () => editMask(c.id, fx.id, m.id, '마스크 반전', (mm) => { mm.inverted = !mm.inverted; }));
    invBtn.classList.toggle('on', !!m.inverted);
    const delBtn = iconButton('trash', '마스크 삭제', () => {
      removeMask(c.id, fx.id, m.id);
      if (sel()) selectMask(null);
    });
    const head = h('div.ec-mask-head', twisty, icon('mask'), name, invBtn, delBtn);
    head.addEventListener('click', (e) => {
      if (e.target.closest('button, .twisty')) return;
      selectMask(sel() ? null : { clipId: c.id, fxId: fx.id, maskId: m.id });
      showPanel('program', { quiet: true });
    });
    name.addEventListener('dblclick', async () => {
      const n = await promptDialog('마스크 이름 바꾸기', '이름', m.name);
      if (n) editMask(c.id, fx.id, m.id, '마스크 이름 바꾸기', (mm) => { mm.name = n; });
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([
        { label: '프로그램 모니터에서 편집', action: () => { selectMask({ clipId: c.id, fxId: fx.id, maskId: m.id }); showPanel('program'); } },
        { label: '이름 바꾸기…', action: () => name.dispatchEvent(new Event('dblclick')) },
        { label: '반전됨', checked: !!m.inverted, action: () => invBtn.click() },
        { label: '복제', action: () => duplicateMask(c.id, fx.id, m.id) },
        '-',
        { label: '삭제', action: () => delBtn.click() },
      ], e.clientX, e.clientY);
    });
    updaters.push(() => head.classList.toggle('on', sel()));
    rows.push(h('div.ec-row.ec-hrow.ec-subhead', h('div.ec-l', head), h('div.ec-t')));
    if (collapsed.has(m.id)) return rows;
    // 마스크 경로: stopwatch, key navigator, tracking
    const pathKey = `m:${m.id}:path`;
    const pathP = m.params?.path;
    const animated = isAnimated(pathP);
    const stopwatch = h(`button.stopwatch${animated ? '.on' : ''}`, { title: animated ? '마스크 경로 애니메이션 끄기' : '마스크 경로 애니메이션 켜기 (추적하면 자동으로 켜집니다)', 'aria-label': '마스크 경로 애니메이션' }, icon('stopwatch'));
    stopwatch.addEventListener('click', () => toggleStopwatch(c, fx, pathKey, '마스크 경로'));
    const job = trackJobs.get(m.id);
    const trackBtns = h('span.ec-track-btns',
      trackButton(c, fx, m, -1, true, '선택한 마스크를 한 프레임 뒤로 추적', '◂|'),
      trackButton(c, fx, m, -1, false, '선택한 마스크를 뒤로 추적', '◂'),
      trackButton(c, fx, m, 1, false, '선택한 마스크를 앞으로 추적', '▸'),
      trackButton(c, fx, m, 1, true, '선택한 마스크를 한 프레임 앞으로 추적', '|▸'));
    const method = h('select', { title: '추적 방법', 'aria-label': '추적 방법' }, TRACK_METHODS.map(([v, l]) => h('option', { value: v, selected: v === (m.track || 'posScaleRot') }, l)));
    method.addEventListener('change', () => editMask(c.id, fx.id, m.id, '추적 방법', (mm) => { mm.track = method.value; }));
    const stopBtn = job ? h('button', { title: '추적 중지', onclick: () => { job.cancelled = true; } }, `중지 ${Math.round((job.progress || 0) * 100)}%`) : null;
    if (stopBtn) updaters.push(() => { stopBtn.textContent = `중지 ${Math.round((trackJobs.get(m.id)?.progress || 0) * 100)}%`; });
    const tools = animated ? h('span.ec-ptools', ...kfNav(c, fx, pathKey)) : h('span.ec-ptools', h('span.kf-spacer'));
    const left = h('div.ec-l.ecp', h('span'), stopwatch, h('span.label', '마스크 경로'), h('span.ec-val.inline', trackBtns, method, stopBtn), tools);
    const cell = h('div.ec-t');
    rows.push(h(`div.ec-row.ec-prow${animated ? '.has-kf' : ''}`, left, cell));
    buildLane(c, fx, pathKey, cell);
    const P = [
      ['feather', '마스크 페더', { min: 0, max: 1000, unit: 'px', step: 1 }, 10],
      ['opacity', '마스크 불투명도', { min: 0, max: 100, unit: '%', step: 1 }, 100],
      ['expansion', '마스크 확장', { min: -1000, max: 1000, unit: 'px', step: 1 }, 0],
    ];
    for (const [k, lab, opts, def] of P) {
      const pdef = { key: k, label: lab, type: 'number', animatable: true, ...opts };
      const key = `m:${m.id}:${k}`;
      rows.push(...buildNumber(c, fx, pdef, key, h('span.label', lab), {
        onReset: () => store.transact(`${lab} 재설정`, () => {
          const p = resolveParam(store.seq.clips[c.id], fx.id, key);
          if (!p) return;
          if (isAnimated(p)) setParamValue(p, def, tLocal(c.id), fd());
          else p.value = def;
        }),
      }));
    }
    const inv = h('input', { type: 'checkbox', checked: !!m.inverted, 'aria-label': '반전됨' });
    inv.addEventListener('change', () => editMask(c.id, fx.id, m.id, '마스크 반전', (mm) => { mm.inverted = inv.checked; }));
    rows.push(h('div.ec-row.ec-prow', h('div.ec-l.ecp', h('span'), h('span'), h('span.label', '반전됨'), h('span.ec-val', inv), h('span.ec-ptools')), h('div.ec-t')));
    return rows;
  }

  function trackButton(c, fx, m, dir, one, title, text) {
    const b = h('button', { title, 'aria-label': title }, text);
    b.disabled = trackJobs.has(m.id);
    b.addEventListener('click', () => runTrack(c, fx, m, dir, one));
    return b;
  }

  async function runTrack(c, fx, m, dir, one) {
    if (trackJobs.has(m.id)) return;
    let mod2;
    try {
      mod2 = await import('../masktrack.js');
    } catch {
      toast('마스크 추적을 불러오지 못했습니다');
      return;
    }
    if (typeof mod2.trackMask !== 'function') {
      toast('마스크 추적을 아직 쓸 수 없습니다');
      return;
    }
    const job = { cancelled: false, progress: 0 };
    trackJobs.set(m.id, job);
    store.changed();
    selectMask({ clipId: c.id, fxId: fx.id, maskId: m.id });
    try {
      await mod2.trackMask({
        clipId: c.id, fxId: fx.id, maskId: m.id, direction: dir, oneFrame: one, token: job,
        onProgress: (p) => {
          job.progress = p;
          update();
        },
      });
    } catch (err) {
      if (!job.cancelled) toast(`마스크 추적 실패: ${err?.message || err}`);
    } finally {
      trackJobs.delete(m.id);
      store.changed();
    }
  }

  // ---------------------------------------------------------------- special controls

  function buildFont(c, fx, key) {
    const btn = h('button.font-btn', { title: '글꼴 고르기 — 목록에서 미리 보고 고를 수 있습니다' });
    const paint = () => {
      const fam = findFx(c.id, fx.id)?.params[key].value || '';
      btn.replaceChildren(h('span.fname', { style: { fontFamily: `"${fam}", "Noto Sans KR", sans-serif` } }, fontLabel(fam)), h('span.caret', '▾'));
      loadFontFor(fam, fontLabel(fam)).catch(() => {});
    };
    let shown = null;
    paint();
    updaters.push(() => {
      const fam = findFx(c.id, fx.id)?.params[key].value || '';
      if (fam !== shown) {
        shown = fam;
        paint();
      }
    });
    btn.addEventListener('click', () => {
      const f0 = findFx(c.id, fx.id);
      if (!f0) return;
      const original = f0.params[key].value;
      const sample = String(f0.params.content?.value || '');
      store.begin('글꼴 변경');
      const set = (fam) => {
        const f = findFx(c.id, fx.id);
        if (!f) return;
        f.params[key].value = fam;
        store.changed();
      };
      openFontPicker(btn, {
        current: original,
        sample,
        onPreview: (fam) => set(fam || original),
        onPick: (fam) => {
          set(fam);
          store.commit();
        },
        onCancel: () => store.cancel(),
      });
    });
    return btn;
  }

  /**
   * Eyedropper for colours with `eyedropper`: click it, then click the Program Monitor. The colour
   * is read from the clip with this effect off (so a key colour or a colour cast is the source's).
   * Lumetri's 흰색 균형 선택기 sets 온도 / 색조 from it, as in Premiere.
   */
  function eyedropperButton(c, fx, pdef) {
    const btn = iconButton('eyedropper', '스포이드: 프로그램 모니터에서 색 고르기', async () => {
      const spot = pickOnProgram();
      if (!spot) {
        if (!window.EyeDropper) {
          toast('프로그램 모니터를 열고 다시 누르세요');
          return;
        }
        try {
          const { sRGBHex } = await new window.EyeDropper().open();
          if (sRGBHex) mutate(`${pdef.label} 변경`, c, fx, (f) => { f.params[pdef.key].value = sRGBHex.slice(0, 7); });
        } catch { /* cancelled */ }
        return;
      }
      btn.classList.add('on');
      const at = await spot;
      btn.classList.remove('on');
      if (!at) return;
      const frame = renderClipFrame(c.id, fx.id, 960);
      const rgb = frame && sampleCanvas(frame, at.u, at.v);
      if (!rgb) {
        toast('그 자리에는 이 클립의 화면이 없습니다');
        return;
      }
      if (fx.type === 'lumetri' && pdef.key === 'wbColor') {
        setValues(c, fx, { ...whiteBalanceFrom(rgb), wbColor: '#ffffff' }, '흰색 균형');
        return;
      }
      const hex = `#${rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
      mutate(`${pdef.label} 변경`, c, fx, (f) => { f.params[pdef.key].value = hex; });
    });
    return btn;
  }

  // ---- colour curves
  function buildCurves(c, fx, key) {
    const CH = [['master', '전체', '#e8ecf2'], ['r', '빨강', '#ff6b6b'], ['g', '초록', '#4ade80'], ['b', '파랑', '#60a5fa']];
    let ch = curveChannel.get(fx.id) || 'master';
    const canvas = h('canvas', { 'aria-label': 'RGB 커브 편집기' });
    const tabs = h('div.curve-tabs', CH.map(([id, name]) => {
      const b = h('button', { onclick: () => { ch = id; curveChannel.set(fx.id, id); syncTabs(); draw(); } }, name);
      b.dataset.ch = id;
      return b;
    }));
    const syncTabs = () => tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.ch === ch));
    syncTabs();
    const resetBtn = h('button', {
      onclick: () => mutate('커브 초기화', c, fx, (f) => { f.params[key].value[ch] = [[0, 0], [1, 1]]; }),
    }, '이 채널 초기화');
    const pts = () => findFx(c.id, fx.id)?.params[key].value?.[ch] || [[0, 0], [1, 1]];
    const PAD = 8;
    const draw = () => {
      if (!canvas.isConnected) return;
      const { ctx, w, h: hh } = fitCanvasToBox(canvas);
      const S = Math.min(w, hh) - PAD * 2;
      if (S < 8) return;
      ctx.clearRect(0, 0, w, hh);
      ctx.strokeStyle = '#2b3038';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const p = PAD + (S * i) / 4 + 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD, p);
        ctx.lineTo(PAD + S, p);
        ctx.moveTo(p, PAD);
        ctx.lineTo(p, PAD + S);
        ctx.stroke();
      }
      ctx.strokeStyle = '#3d4450';
      ctx.beginPath();
      ctx.moveTo(PAD, PAD + S);
      ctx.lineTo(PAD + S, PAD);
      ctx.stroke();
      const all = findFx(c.id, fx.id)?.params[key].value || {};
      // other channels faintly, the edited one on top
      for (const [id, , color] of CH) {
        if (id === ch) continue;
        const p = all[id];
        if (!p || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1)) continue;
        drawCurve(ctx, curveTable(p), color, 0.35, S);
      }
      const color = CH.find(([id]) => id === ch)[2];
      drawCurve(ctx, curveTable(pts()), color, 1, S);
      ctx.fillStyle = color;
      for (const [x, y] of pts()) {
        ctx.beginPath();
        ctx.arc(PAD + x * S, PAD + (1 - y) * S, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const drawCurve = (ctx, table, color, alpha, S) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 256; i++) {
        const x = PAD + (i / 255) * S;
        const y = PAD + (1 - table[i]) * S;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const toUnit = (e) => {
      const r = canvas.getBoundingClientRect();
      const S = Math.min(r.width, r.height) - PAD * 2;
      return [clamp((e.clientX - r.left - PAD) / S, 0, 1), clamp(1 - (e.clientY - r.top - PAD) / S, 0, 1), S];
    };
    const hitIndex = (e) => {
      const [x, y, S] = toUnit(e);
      let best = -1;
      let bd = 10 / S;
      pts().forEach(([px, py], i) => {
        const d = Math.hypot(px - x, py - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      let i = hitIndex(e);
      const [x, y] = toUnit(e);
      store.begin('커브 조정');
      const f = findFx(c.id, fx.id);
      if (!f) return store.cancel();
      const value = f.params[key].value;
      if (!value[ch]) value[ch] = [[0, 0], [1, 1]];
      if (i < 0) {
        // keep the points sorted by x: insert before the first point to the right
        const arr = value[ch];
        i = arr.findIndex(([px]) => px > x);
        if (i < 0) i = arr.length;
        arr.splice(i, 0, [x, y]);
        store.changed();
      }
      dragging = true;
      dragWindow((ev) => {
        const ff = findFx(c.id, fx.id);
        const arr = ff?.params[key].value[ch];
        if (!arr?.[i]) return;
        const [nx, ny] = toUnit(ev);
        const lo = i > 0 ? arr[i - 1][0] + 0.01 : 0;
        const hi = i < arr.length - 1 ? arr[i + 1][0] - 0.01 : 1;
        arr[i] = [Math.round(clamp(nx, lo, hi) * 1000) / 1000, Math.round(ny * 1000) / 1000];
        store.changed();
      }, () => {
        dragging = false;
        store.commit();
        afterDrag();
      });
    });
    const removeAt = (e) => {
      e.preventDefault();
      const i = hitIndex(e);
      const n = pts().length;
      if (i <= 0 || i >= n - 1) return; // keep the end points
      mutate('커브 점 삭제', c, fx, (f) => { f.params[key].value[ch].splice(i, 1); });
    };
    canvas.addEventListener('dblclick', removeAt);
    canvas.addEventListener('contextmenu', removeAt);
    updaters.push(draw);
    requestAnimationFrame(draw);
    return h('div.curve-editor', tabs, canvas, h('div.inline', resetBtn, h('span.note', '클릭: 점 추가 · 끌기: 이동 · 두 번 클릭: 점 삭제')));
  }

  // ---- Lumetri 색조 채도 곡선 (hue / luma / saturation keyed curves; 0.5 = no change)
  function buildHueCurves(c, fx, key) {
    const CURVES = [
      ['hueSat', '색조 대 채도', 'hue'], ['hueHue', '색조 대 색조', 'hue'], ['hueLuma', '색조 대 광도', 'hue'],
      ['lumaSat', '광도 대 채도', 'luma'], ['satSat', '채도 대 채도', 'sat'],
    ];
    let cur = curveChannel.get(`${fx.id}:hue`) || 'hueSat';
    const canvas = h('canvas', { 'aria-label': '색조 채도 곡선 편집기' });
    const tabs = h('div.curve-tabs', { style: { flexWrap: 'wrap' } }, CURVES.map(([id, name]) => {
      const b = h('button', { onclick: () => { cur = id; curveChannel.set(`${fx.id}:hue`, id); syncTabs(); draw(); } }, name);
      b.dataset.ch = id;
      return b;
    }));
    const syncTabs = () => tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.ch === cur));
    syncTabs();
    const FLAT = () => [[0, 0.5], [1, 0.5]];
    const pts = () => findFx(c.id, fx.id)?.params[key].value?.[cur] || FLAT();
    const isHue = () => CURVES.find(([id]) => id === cur)[2] === 'hue';
    const PADX = 6;
    const PADY = 8;
    const geom = () => {
      const r = canvas.getBoundingClientRect();
      return { r, w: r.width - PADX * 2, hh: r.height - PADY * 2 - 10 };
    };
    const draw = () => {
      if (!canvas.isConnected) return;
      const { ctx, w: W, h: H } = fitCanvasToBox(canvas);
      const w = W - PADX * 2;
      const hh = H - PADY * 2 - 10;
      if (w < 8 || hh < 8) return;
      ctx.clearRect(0, 0, W, H);
      // the input axis as a colour band
      const kind = CURVES.find(([id]) => id === cur)[2];
      for (let x = 0; x < w; x++) {
        const u = x / w;
        ctx.fillStyle = kind === 'hue' ? `hsl(${u * 360},80%,50%)` : kind === 'luma' ? `hsl(0,0%,${u * 100}%)` : `hsl(200,${u * 100}%,50%)`;
        ctx.fillRect(PADX + x, PADY + hh + 2, 1.5, 8);
      }
      ctx.strokeStyle = '#2b3038';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) {
        const y = PADY + (hh * i) / 4 + 0.5;
        ctx.moveTo(PADX, y);
        ctx.lineTo(PADX + w, y);
      }
      ctx.stroke();
      ctx.strokeStyle = '#59606c';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(PADX, PADY + hh / 2 + 0.5);
      ctx.lineTo(PADX + w, PADY + hh / 2 + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const table = curveTable(pts());
      ctx.strokeStyle = '#e8ecf2';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 256; i++) {
        const x = PADX + (i / 255) * w;
        const y = PADY + (1 - table[i]) * hh;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const [x, y] of pts()) {
        ctx.beginPath();
        ctx.arc(PADX + x * w, PADY + (1 - y) * hh, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const toUnit = (e) => {
      const { r, w, hh } = geom();
      return [clamp((e.clientX - r.left - PADX) / w, 0, 1), clamp(1 - (e.clientY - r.top - PADY) / hh, 0, 1), w, hh];
    };
    const hitIndex = (e) => {
      const [x, y, w, hh] = toUnit(e);
      let best = -1;
      let bd = 9;
      pts().forEach(([px, py], i) => {
        const d = Math.hypot((px - x) * w, (py - y) * hh);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      let i = hitIndex(e);
      const [x, y] = toUnit(e);
      store.begin('색조 채도 곡선 조정');
      const f = findFx(c.id, fx.id);
      if (!f) return store.cancel();
      const value = f.params[key].value || (f.params[key].value = {});
      if (!value[cur]) value[cur] = FLAT();
      const arr0 = value[cur];
      if (i < 0) {
        i = arr0.findIndex(([px]) => px > x);
        if (i < 0) i = arr0.length;
        arr0.splice(i, 0, [x, y]);
        store.changed();
      }
      dragging = true;
      dragWindow((ev) => {
        const arr = findFx(c.id, fx.id)?.params[key].value?.[cur];
        if (!arr?.[i]) return;
        const [nx, ny] = toUnit(ev);
        const last = arr.length - 1;
        const lo = i > 0 ? arr[i - 1][0] + 0.01 : 0;
        const hi = i < last ? arr[i + 1][0] - 0.01 : 1;
        const xx = i === 0 ? 0 : i === last ? 1 : clamp(nx, lo, hi);
        arr[i] = [Math.round(xx * 1000) / 1000, Math.round(ny * 1000) / 1000];
        // hue curves wrap around: both ends share one value
        if (isHue() && (i === 0 || i === last)) arr[i === 0 ? last : 0][1] = arr[i][1];
        store.changed();
      }, () => {
        dragging = false;
        store.commit();
        afterDrag();
      });
    });
    const removeAt = (e) => {
      e.preventDefault();
      const i = hitIndex(e);
      const n = pts().length;
      if (i <= 0 || i >= n - 1) return;
      mutate('곡선 점 삭제', c, fx, (f) => { f.params[key].value[cur].splice(i, 1); });
    };
    canvas.addEventListener('dblclick', removeAt);
    canvas.addEventListener('contextmenu', removeAt);
    canvas.style.width = '100%';
    canvas.style.maxWidth = '320px';
    canvas.style.height = '150px';
    canvas.style.background = '#0e1013';
    canvas.style.border = '1px solid var(--line-2)';
    canvas.style.borderRadius = '6px';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'crosshair';
    updaters.push(draw);
    requestAnimationFrame(draw);
    const resetBtn = h('button', { onclick: () => mutate('곡선 초기화', c, fx, (f) => { (f.params[key].value || (f.params[key].value = {}))[cur] = FLAT(); }) }, '이 곡선 초기화');
    return h('div.curve-editor', tabs, canvas, h('div.inline', resetBtn, h('span.note', '가운데 선 = 변화 없음 · 클릭: 점 추가 · 끌기: 이동 · 두 번 클릭: 삭제')));
  }

  // ---- colour wheel (lift / gamma / gain style offset)
  function buildWheel(c, fx, key) {
    const canvas = h('canvas', { 'aria-label': '색상 휠' });
    const val = h('div.wheel-val');
    const get = () => findFx(c.id, fx.id)?.params[key].value || { x: 0, y: 0 };
    const draw = () => {
      if (!canvas.isConnected) return;
      const { ctx, w, h: hh } = fitCanvasToBox(canvas);
      const R = Math.min(w, hh) / 2 - 3;
      if (R < 4) return;
      const cx = w / 2;
      const cy = hh / 2;
      ctx.clearRect(0, 0, w, hh);
      for (let a = 0; a < 360; a += 4) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, (-(a + 2.5) * Math.PI) / 180, (-(a - 2.5) * Math.PI) / 180);
        ctx.closePath();
        ctx.fillStyle = `hsl(${a},75%,50%)`;
        ctx.fill();
      }
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, 'rgba(60,62,68,1)');
      g.addColorStop(1, 'rgba(60,62,68,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy);
      ctx.lineTo(cx + 6, cy);
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy + 6);
      ctx.stroke();
      const v = get();
      const px = cx + (v.x || 0) * R;
      const py = cy - (v.y || 0) * R;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
      const amt = Math.round(Math.min(1, Math.hypot(v.x || 0, v.y || 0)) * 100);
      const hue = Math.round(((Math.atan2(v.y || 0, v.x || 0) * 180) / Math.PI + 360) % 360);
      val.replaceChildren(h('div', amt ? `색상 ${hue}°` : '색상 없음'), h('div', `세기 ${amt}%`), h('div', '두 번 클릭: 초기화'));
    };
    const setFrom = (e) => {
      const r = canvas.getBoundingClientRect();
      const R = Math.min(r.width, r.height) / 2 - 3;
      let x = (e.clientX - r.left - r.width / 2) / R;
      let y = -(e.clientY - r.top - r.height / 2) / R;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      const f = findFx(c.id, fx.id);
      if (f) f.params[key].value = { ...f.params[key].value, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
      store.changed();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      store.begin('색상 휠 조정');
      dragging = true;
      setFrom(e);
      dragWindow(setFrom, () => {
        dragging = false;
        store.commit();
        afterDrag();
      });
    });
    canvas.addEventListener('dblclick', () => mutate('색상 휠 초기화', c, fx, (f) => { f.params[key].value = { ...f.params[key].value, x: 0, y: 0 }; }));
    updaters.push(draw);
    requestAnimationFrame(draw);
    return h('div.wheel-wrap', canvas, val);
  }

  // ---- polygon mask points (the older 마스크 effect)
  function buildPoints(c, fx, key) {
    const info = h('span.note');
    const add = h('button', {
      onclick: () => mutate('마스크 점 추가', c, fx, (f) => {
        const arr = f.params[key].value;
        // split the longest edge
        let best = 0;
        let bl = -1;
        arr.forEach((p, i) => {
          const q = arr[(i + 1) % arr.length];
          const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (l > bl) {
            bl = l;
            best = i;
          }
        });
        const p = arr[best];
        const q = arr[(best + 1) % arr.length];
        arr.splice(best + 1, 0, [Math.round((p[0] + q[0]) * 5) / 10, Math.round((p[1] + q[1]) * 5) / 10]);
      }),
    }, '점 추가');
    const del = h('button', {
      onclick: () => mutate('마스크 점 삭제', c, fx, (f) => {
        if (f.params[key].value.length > 3) f.params[key].value.pop();
      }),
    }, '마지막 점 삭제');
    const edit2 = h('button', {
      onclick: () => {
        setMaskTarget(fx.id);
        showPanel('program');
      },
    }, '모니터에서 편집');
    updaters.push(() => {
      const n = findFx(c.id, fx.id)?.params[key].value?.length || 0;
      info.textContent = `점 ${n}개 · 프로그램 모니터에서 점을 끌어 옮기세요. Ctrl+클릭: 점 추가, Alt+클릭: 점 삭제`;
      del.disabled = n <= 3;
    });
    return h('div.ec-action', add, del, edit2, info);
  }

  // ---- action params (type 'action'): pdef.action picks the builder; 'button' runs pdef.run

  /**
   * The content of an action row, by pdef.action. 'button' is the generic one: a button labelled
   * pdef.button (or pdef.label) calling pdef.run({ clipId, fxId, values, set }), where
   * set(values, label) writes params as one undo step.
   */
  function buildActionRow(action, c, fx, pdef) {
    if (action === 'stabilize') return buildStabilize(c, fx, pdef);
    if (action === 'lumetriTone') return buildLumetriTone(c, fx, pdef);
    if (action !== 'button') return null;
    const b = h('button', pdef.button || pdef.label);
    b.addEventListener('click', () => pdef.run?.({
      clipId: c.id,
      fxId: fx.id,
      values: currentValues(c.id, fx.id),
      set: (vals, label = pdef.label) => setValues(c, fx, vals, label),
    }));
    return h('div.ec-action', b, pdef.hint ? h('span.note', pdef.hint) : null);
  }

  /** Write several numeric / plain values of one effect as one undo step (animated ones get a key). */
  function setValues(c, fx, vals, label) {
    mutate(label, c, fx, (f, clip) => {
      const t = clamp(store.ui.playhead - clip.start, 0, clip.duration);
      for (const [k, v] of Object.entries(vals)) {
        const p = f.params[k];
        if (!p) continue;
        if (isAnimated(p) && typeof v === 'number') setParamValue(p, v, t, fd());
        else p.value = v;
      }
    });
  }

  /** Lumetri 기본 교정 ▸ 톤: 재설정 and 자동 (analyses the frame at the playhead, like Premiere). */
  function buildLumetriTone(c, fx) {
    const TONE = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];
    const reset = h('button', { title: '노출·대비·밝은 영역·어두운 영역·흰색 계열·검정 계열을 0으로' }, '재설정');
    reset.addEventListener('click', () => setValues(c, fx, Object.fromEntries(TONE.map((k) => [k, 0])), '톤 재설정'));
    const auto = h('button.primary', { title: '재생헤드 위치의 프레임을 분석해 톤을 자동으로 맞춥니다' }, '자동');
    auto.addEventListener('click', () => {
      const frame = renderClipFrame(c.id, fx.id);
      const vals = frame ? autoTone(frame) : {};
      if (!Object.keys(vals).length) {
        toast('분석할 화면이 없습니다. 재생헤드를 클립 위에 두세요');
        return;
      }
      setValues(c, fx, vals, '자동 톤');
    });
    return h('div.ec-action', reset, auto);
  }

  /**
   * The clip alone at the playhead (or its nearest frame; an adjustment layer with what is under
   * it), with effect `skipFxId` switched off, as a canvas of about `width` px: what eyedroppers and
   * 자동 analyse, like Premiere does with the source.
   */
  function renderClipFrame(clipId, skipFxId, width = 480) {
    const clip = store.seq.clips[clipId];
    if (!clip || clip.kind === 'audio') return null;
    const seq = store.seq;
    const copy = {
      ...clip,
      transIn: null,
      transOut: null,
      effects: clip.effects.map((e) => (e.id === skipFxId ? { ...e, enabled: false } : e)),
    };
    const t = clamp(store.ui.playhead, clip.start, clipEnd(clip) - 1 / seq.fps / 2);
    const scale = Math.min(1, width / seq.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(seq.width * scale));
    canvas.height = Math.max(2, Math.round(seq.height * scale));
    probeCompositor ||= new Compositor();
    try {
      // an adjustment layer has no picture of its own: it works on everything under it
      const clips = clip.kind === 'adjustment' ? { ...seq.clips, [clipId]: copy } : { [clipId]: copy };
      probeCompositor.render(canvas.getContext('2d'), { ...seq, clips }, t, playback.provider, { scale, background: null });
    } catch (err) {
      console.warn('frame probe failed', err);
      return null;
    }
    return canvas;
  }

  /**
   * Wait for a click on the Program Monitor's picture; resolves to its spot as fractions of the
   * frame ({ u, v }), or null when cancelled (Esc, a click elsewhere).
   */
  function pickOnProgram() {
    const frame = document.querySelector('.pm-refbar')?.parentElement?.querySelector('canvas.frame:not(.pm-ref)');
    const r0 = frame?.getBoundingClientRect();
    if (!r0 || r0.width < 4 || r0.height < 4) return null;
    pickCancel?.();
    const view = frame.parentElement;
    return new Promise((resolve) => {
      const done = (val) => {
        window.removeEventListener('pointerdown', down, true);
        window.removeEventListener('keydown', key, true);
        view.classList.remove('ec-picking');
        pickCancel = null;
        resolve(val);
      };
      const down = (e) => {
        const r = frame.getBoundingClientRect();
        const vr = view.getBoundingClientRect();
        const inside = (x, y, b) => x >= b.left && x < b.right && y >= b.top && y < b.bottom;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        // swallow the click that follows so it does not select anything underneath
        window.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
        if (!inside(e.clientX, e.clientY, r) || !inside(e.clientX, e.clientY, vr)) return done(null);
        done({ u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height });
      };
      const key = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        done(null);
      };
      pickCancel = () => done(null);
      window.addEventListener('pointerdown', down, true);
      window.addEventListener('keydown', key, true);
      view.classList.add('ec-picking');
      toast('프로그램 모니터에서 색을 클릭하세요 (Esc: 취소)');
    });
  }

  /** Average colour (0..255) of a small square around a spot of a canvas. */
  function sampleCanvas(canvas, u, v, radius = 2) {
    const x = clamp(Math.round(u * canvas.width), 0, canvas.width - 1);
    const y = clamp(Math.round(v * canvas.height), 0, canvas.height - 1);
    const x0 = Math.max(0, x - radius);
    const y0 = Math.max(0, y - radius);
    const w = Math.min(canvas.width, x + radius + 1) - x0;
    const hh = Math.min(canvas.height, y + radius + 1) - y0;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, hh).data;
    const sum = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 16) continue;
      sum[0] += d[i];
      sum[1] += d[i + 1];
      sum[2] += d[i + 2];
      n++;
    }
    return n ? sum.map((s) => Math.round(s / n)) : null;
  }

  // ---- stabilization analysis
  function buildStabilize(c, fx, pdef) {
    const status = h('span.note');
    const prog = h('div.progress', h('div'));
    const run = h('button.primary', '분석 시작');
    const cancel = h('button', '취소');
    const refresh = () => {
      const job = analyses.get(c.id);
      const clip = store.seq.clips[c.id];
      run.hidden = !!job;
      cancel.hidden = !job;
      prog.hidden = !job;
      if (job) {
        prog.firstChild.style.width = `${Math.round(job.progress * 100)}%`;
        status.textContent = `분석 중… ${Math.round(job.progress * 100)}%`;
        return;
      }
      if (!clip) return;
      if (clip.kind !== 'video') {
        status.textContent = '영상 클립에서만 쓸 수 있습니다.';
        run.disabled = true;
        return;
      }
      const st = clip.stab;
      if (!st) {
        status.textContent = pdef.hint || '아직 분석하지 않았습니다.';
        run.textContent = '분석 시작';
        return;
      }
      const lo = Math.min(clip.inPoint, sourceOut(clip));
      const hi = Math.max(clip.inPoint, sourceOut(clip));
      const end = st.t0 + (st.x.length - 1) / st.fps;
      const stale = st.t0 > lo + 0.1 || end < hi - 0.2;
      status.textContent = stale ? '클립 길이가 바뀌어 일부 구간이 분석되지 않았습니다. 다시 분석하세요.' : `분석 완료 (${st.x.length}프레임). 부드러움·추가 확대로 조절하세요.`;
      run.textContent = '다시 분석';
    };
    run.addEventListener('click', async () => {
      const clip = store.seq.clips[c.id];
      if (!clip || clip.kind !== 'video') return;
      if (mediaStatus(clip.mediaId) !== 'ready') {
        toast('미디어가 준비되지 않았습니다');
        return;
      }
      const lo = Math.max(0, Math.min(clip.inPoint, sourceOut(clip)));
      const hi = Math.max(clip.inPoint, sourceOut(clip));
      const job = { token: { cancelled: false }, progress: 0 };
      analyses.set(c.id, job);
      store.changed();
      try {
        const result = await analyzeMotion(clip.mediaId, lo, hi + 0.05, {
          token: job.token,
          onProgress: (p) => {
            job.progress = p;
            refresh();
          },
        });
        analyses.delete(c.id);
        store.transact('손떨림 분석', () => {
          const cc = store.seq.clips[c.id];
          if (cc) cc.stab = result;
        });
        toast('손떨림 분석을 마쳤습니다');
      } catch (err) {
        analyses.delete(c.id);
        store.changed();
        if (!job.token.cancelled) toast(`분석 실패: ${err.message || err}`);
      }
    });
    cancel.addEventListener('click', () => {
      const job = analyses.get(c.id);
      if (job) job.token.cancelled = true;
    });
    updaters.push(refresh);
    return h('div', { style: { display: 'grid', gap: '6px' } }, h('div.ec-action', run, cancel, status), prog);
  }

  // ---- speed ramp shortcuts (time remapping)
  function buildRampTools(c, fx) {
    const ramp = (label, low) => mutate(label, c, fx, (f, clip) => {
      const p = f.params.speed;
      const t = tLocal(c.id);
      const D = clip.duration;
      const base = 100;
      // 가속 away from each speed and 감속 into the next one: smooth ramps, like Premiere's speed ramp handles
      const pts = [[t - 0.5, base, 'easeOut'], [t, low, 'easeIn'], [t + 1, low, 'easeOut'], [t + 1.5, base, 'easeIn']];
      const kf = [];
      const types = [];
      for (const [tt, v, interp] of pts) {
        const time = Math.round(clamp(tt, 0, D) * store.seq.fps) / store.seq.fps;
        if (kf.length && time - kf[kf.length - 1].t <= 1e-6) continue;
        kf.push({ t: time, v, ease: 'linear' });
        types.push(interp);
      }
      p.kf = kf;
      types.forEach((type, i) => setKeyInterp(p, i, type));
      p.value = base;
    });
    return h('div.ec-wide',
      h('span.label', '속도 램프 빠른 설정 (재생헤드 위치 기준)'),
      h('div.ec-action',
        h('button', { onclick: () => ramp('슬로모션 구간', 30) }, '슬로모션 구간 넣기'),
        h('button', { onclick: () => ramp('빨리 감기 구간', 300) }, '빨리 감기 구간 넣기'),
        h('button', { onclick: () => mutate('속도 램프 지우기', c, fx, (f) => { f.params.speed.kf = null; f.params.speed.value = 100; }) }, '램프 지우기')),
      h('div.note', '키프레임 사이에서 속도가 부드럽게 바뀝니다 (속도 그래프에서 핸들로 조절). 클립 길이는 그대로이며, 영상이 원본 끝에 닿으면 마지막 프레임에서 멈춥니다. 연결된 오디오에도 같은 램프가 적용됩니다.'));
  }

  // ---------------------------------------------------------------- transition

  function buildTransition(tr) {
    const c = store.seq.clips[tr.clipId];
    const key = tr.edge === 'in' ? 'transIn' : 'transOut';
    const t = c?.[key];
    if (!t || !TRANSITIONS[t.type]) {
      scroller.append(h('div.empty-hint', '전환을 찾을 수 없습니다'));
      return;
    }
    const def = TRANSITIONS[t.type];
    const typeSel = h('select', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === def.kind).map(([k, d]) => h('option', { value: k, selected: k === t.type }, d.name)));
    typeSel.addEventListener('change', () => store.transact('전환 종류 변경', () => {
      const cc = store.seq.clips[tr.clipId];
      if (cc?.[key]) cc[key].type = typeSel.value;
    }));
    const dirSel = h('select', TRANSITION_DIRECTIONS.map(([v, l]) => h('option', { value: v, selected: v === (t.direction || 'left') }, l)));
    dirSel.addEventListener('change', () => store.transact('전환 방향 변경', () => {
      const cc = store.seq.clips[tr.clipId];
      if (cc?.[key]) cc[key].direction = dirSel.value;
    }));
    const durScrub = scrubNumber({
      value: Math.round(t.duration * store.seq.fps),
      step: 1, min: 1, unit: '프레임', decimals: 0,
      onStart: () => store.begin('전환 길이'),
      onChange: (v) => {
        edit.setTransitionDuration(tr.clipId, tr.edge, v / store.seq.fps);
        store.changed();
      },
      onCommit: () => store.commit(),
    });
    const tcInput = h('input', { type: 'text', value: formatTimecode(t.duration, store.seq.fps), style: { width: '110px' } });
    updaters.push(() => {
      const cc = store.seq.clips[tr.clipId];
      if (!cc?.[key]) return;
      durScrub.update(Math.round(cc[key].duration * store.seq.fps));
      if (document.activeElement !== tcInput) tcInput.value = formatTimecode(cc[key].duration, store.seq.fps);
    });
    tcInput.addEventListener('change', () => {
      const d = parseTimecode(tcInput.value, store.seq.fps);
      if (d) store.transact('전환 길이', () => edit.setTransitionDuration(tr.clipId, tr.edge, d));
    });
    tcInput.addEventListener('keydown', (e) => e.stopPropagation());
    const row = (label, ctl) => h('div.ec-param', h('span'), h('span.label', label), ctl, h('span'));
    scroller.append(
      h('div.ec-head', h('span.title', `전환: ${def.name}`)),
      h('div.ec-section', h('div.ec-params',
        row('종류', typeSel),
        def.directional ? row('방향', dirSel) : null,
        row('길이', durScrub),
        row('길이 (타임코드)', tcInput),
        row('위치', h('span', { style: { color: 'var(--text-dim)' } }, tr.edge === 'in' && hasPrev(c) ? '편집점 가운데' : tr.edge === 'in' ? '클립 시작 (페이드 인)' : '클립 끝 (페이드 아웃)')))),
      h('div', { style: { padding: '8px' } }, iconButton('close', '전환 삭제', () => edit.deleteSelection(), { label: '전환 삭제', cls: 'boxed' })),
    );
  }

  function hasPrev(c) {
    return Object.values(store.seq.clips).some((x) => x.trackId === c.trackId && Math.abs(x.start + x.duration - c.start) < 1e-4 && x.id !== c.id);
  }

  // ---------------------------------------------------------------- footer, updates, drops

  function buildFoot(c) {
    foot.replaceChildren();
    foot.hidden = !c;
    if (!c) return;
    const tcEl = h('span.ec-foot-tc', { title: '재생헤드 위치' });
    const hint = h('span.grow', wide
      ? '빈 곳을 끌어 키프레임 여러 개 선택 · Alt+끌기: 복제 · 오른쪽 클릭: 보간 · ▸: 그래프'
      : '키프레임을 끌어 옮기기 · 오른쪽 클릭(길게 누르기): 보간 · ▸: 그래프');
    foot.append(tcEl, hint);
    updaters.push(() => { tcEl.textContent = tc(store.ui.playhead); });
    if (wide) {
      const toSlider = (z) => Math.round((Math.log2(z) / 6) * 100);
      const slider = h('input', { type: 'range', min: 0, max: 100, step: 1, value: toSlider(zoom), 'aria-label': '타임라인 보기 확대/축소', title: '타임라인 보기 확대/축소 (Ctrl+휠)' });
      slider.addEventListener('input', () => setZoom(2 ** ((Number(slider.value) / 100) * 6)));
      foot.append(
        iconButton('zoomOut', '타임라인 보기 축소', () => setZoom(zoom / 2)),
        slider,
        iconButton('zoomIn', '타임라인 보기 확대', () => setZoom(zoom * 2)));
      updaters.push(() => {
        if (document.activeElement !== slider) slider.value = String(toSlider(zoom));
      });
    }
  }

  function update() {
    // a zoomed view pages along to keep the playhead in sight
    const clip = lastClipId && store.seq.clips[lastClipId];
    if (clip && zoom > 1 && !dragging) {
      const [t0, t1] = viewOf(clip);
      const tl = store.ui.playhead - clip.start;
      if (tl >= 0 && tl <= clip.duration && (tl < t0 || tl > t1)) viewStart = clamp(tl - (t1 - t0) * 0.1, 0, Math.max(0, clip.duration - (t1 - t0)));
    }
    for (const u of updaters) u();
  }

  function onChange() {
    if (dragging) {
      update();
      return;
    }
    if (signature() !== sig) rebuild();
    else update();
  }

  scroller.addEventListener('wheel', (e) => {
    if (!wide) return;
    const cell = e.target.closest?.('.ec-t');
    const clip = currentClip();
    if (!cell || !clip) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), cellGeom(cell, clip).t(e.clientX));
    } else if (zoom > 1 && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
      e.preventDefault();
      const [t0, t1] = viewOf(clip);
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / 400) * (t1 - t0);
      viewStart = clamp(t0 + d, 0, Math.max(0, clip.duration - (t1 - t0)));
      update();
    }
  }, { passive: false });

  // effects and presets dragged from the Effects panel land at the drop position
  let dropLine = null;
  const isFxDrag = (e) => [...(e.dataTransfer?.types || [])].includes('application/x-montage-effect');
  const clearDrop = () => {
    dropLine?.remove();
    dropLine = null;
    scroller.classList.remove('dropping');
  };
  scroller.addEventListener('dragover', (e) => {
    if (!isFxDrag(e) || !currentClip() || store.selection.transition) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const pos = dropIndex(e.clientY);
    if (!dropLine) {
      dropLine = h('div.ec-dropline');
      document.body.append(dropLine);
      scroller.classList.add('dropping');
    }
    Object.assign(dropLine.style, { left: `${pos.left}px`, width: `${pos.width}px`, top: `${pos.y - 1}px` });
  });
  scroller.addEventListener('dragleave', (e) => {
    if (!scroller.contains(e.relatedTarget)) clearDrop();
  });
  window.addEventListener('dragend', clearDrop);
  scroller.addEventListener('drop', (e) => {
    if (!isFxDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = dropIndex(e.clientY);
    clearDrop();
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer.getData('application/x-montage-effect')); } catch { /* ignore */ }
    const c = currentClip();
    if (!payload || !c) return;
    if (payload.transition) {
      toast('전환은 타임라인의 클립 사이 편집점에 끌어다 놓으세요');
      return;
    }
    if (payload.preset) {
      const preset = getPreset(payload.preset);
      if (!preset || !applyPreset([c.id], preset)) toast('이 클립에는 그 사전 설정을 적용할 수 없습니다');
      return;
    }
    addEffectAt(c.id, payload.type, pos.index);
  });

  store.on('selection', rebuild);
  store.on('change', onChange);
  store.on('playhead', update);
  store.on('mask-target', update);
  window.addEventListener('montage:uiscale', () => requestAnimationFrame(update));
  if (!only) store.on('reveal-effect-controls', (opts) => {
    showPanel('effectControls');
    rebuild();
    if (opts?.focusText && textArea) {
      const ta = textArea;
      ta.focus();
      ta.select();
      // a press that created the title (문자 도구) may still move the focus when it ends: take it back
      setTimeout(() => {
        if (ta.isConnected && document.activeElement !== ta) {
          ta.focus();
          ta.select();
        }
      }, 0);
    }
  });
  rebuild();
  return body;
}
