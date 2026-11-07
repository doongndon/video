// Smaller panels of the video editor, modelled on Premiere Pro's: Effects (효과 — the 사전 설정,
// Lumetri 사전 설정, 오디오 효과, 오디오 전환, 비디오 효과 and 비디오 전환 bins, search and 즐겨찾기),
// Markers (마커), History (작업 내역), the Audio Track Mixer and Audio Clip Mixer, Lumetri Scopes
// (Lumetri 범위), Multicam, the Audio Meters and the Tools panel.

import { store } from '../store.js';
import { playback } from '../playback.js';
import * as edit from '../edit.js';
import { EFFECTS, TRANSITIONS, DEFAULT_VIDEO_TRANSITION, DEFAULT_AUDIO_TRANSITION } from '../effects.js';
import { audioTracks, videoTracks, clipsOnTrack, clipEnd, mediaTimeAt, clipAt, evalParam, isAnimated, setParamValue, newKey, MARKER_COLORS, MARKER_TYPES } from '../model.js';
import { Compositor } from '../compositor.js';
import { h, clamp, formatTimecode } from '../util.js';
import { fitCanvasToBox, loadPref, savePref, showMenu, showPanel, toast, confirmDialog, openModal } from './common.js';
import { icon, iconButton } from './icons.js';
import { openMarkerEditor as openMarkerDialog } from './timeline-dialogs.js';
import { programApi } from './program-monitor.js';
import { listPresets, deletePreset, getPreset, renamePreset, builtinPresets, lumetriPresets, presetTypes, applyPreset } from './presets.js';
import { extendMenu } from './menubar.js';
import { commands } from '../commands.js';
import { toggleVoiceover, recordingTrack } from '../recorder.js';
import { workspaceMenuItem } from './workspaces.js';
import './fxpanels-css.js';

// 창 ▸ 작업 영역 (Premiere's workspaces and keys) and 창 ▸ 오디오 클립 믹서
extendMenu('창', (items) => {
  items.push(workspaceMenuItem());
  if (!items.some((it) => it && it.label === '오디오 클립 믹서')) {
    items.push({ label: '오디오 클립 믹서', key: 'Shift+9', action: () => showPanel('clipMixer') });
  }
  if (!items.some((it) => it && it.label === 'Lumetri 색상')) items.push({ label: 'Lumetri 색상', action: () => showPanel('lumetri') });
  return items;
});

// ---------------------------------------------------------------- effects panel

/** Premiere's bins, in its order. */
const BINS = ['사전 설정', 'Lumetri 사전 설정', '오디오 효과', '오디오 전환', '비디오 효과', '비디오 전환'];

/** Premiere's folder names for categories other modules may spell differently. */
const FOLDER_ALIAS = {
  video: {
    '키잉 및 합성': '키잉', '색상 보정': '색상 교정', '잡음 및 그레인': '노이즈 및 그레인', '노이즈': '노이즈 및 그레인', '흐림': '흐림 및 선명',
    '흐림 효과 및 선명 효과': '흐림 및 선명', '블러': '흐림 및 선명', '스타일': '스타일화', '변환': '변형', '이미지 제어': '이미지 컨트롤', '유틸': '유틸리티', '생성기': '생성',
  },
  transition: { '와이프': '지우기', '아이리스': '조리개', '줌': '확대/축소', '3D': '3D 동작', '3D 모션': '3D 동작', '페이지 넘기기': '페이지 벗기기', '밀기': '슬라이드' },
  audio: {
    '진폭': '진폭 및 압축', '압축': '진폭 및 압축', '다이내믹': '진폭 및 압축', '딜레이 및 에코': '지연 및 반향', '지연 및 에코': '지연 및 반향', '딜레이': '지연 및 반향',
    '노이즈 감소': '노이즈 감소/복원', '복원': '노이즈 감소/복원', '필터': '필터 및 EQ', 'EQ': '필터 및 EQ', '피치': '시간 및 피치', '스테레오': '스테레오 이미지',
  },
  audioTransition: { '페이드': '크로스페이드' },
};

/** English names (Premiere's English UI), so searches from English tutorials find the effect too. */
const EN_NAMES = {
  gaussianBlur: 'Gaussian Blur', sharpen: 'Sharpen', unsharpMask: 'Unsharp Mask', directionalBlur: 'Directional Blur', channelBlur: 'Channel Blur', cameraBlur: 'Camera Blur',
  censor: 'Mosaic Blur Face', blackWhite: 'Black & White', sepia: 'Sepia', invert: 'Invert', colorKey: 'Color Key Chroma', ultraKey: 'Ultra Key Green Screen Chroma',
  lumaKey: 'Luma Key', alphaAdjust: 'Alpha Adjust', mask: 'Mask', trackMatte: 'Track Matte Key', mosaic: 'Mosaic', vignette: 'Vignette', findEdges: 'Find Edges',
  posterize: 'Posterize', glow: 'Alpha Glow', filmGrain: 'Noise Grain', noise: 'Noise', dropShadow: 'Drop Shadow', crop: 'Crop', blurFill: 'Blur Background Fill',
  hFlip: 'Horizontal Flip', vFlip: 'Vertical Flip', letterbox: 'Letterbox', cameraShake: 'Camera Shake', stabilize: 'Warp Stabilizer', brightnessContrast: 'Brightness & Contrast',
  basicColor: 'Basic Correction', lumetri: 'Lumetri Color', lut: 'LUT Lookup', hueShift: 'Hue', tint: 'Tint', procAmp: 'ProcAmp', channelMixer: 'Channel Mixer',
  shadowHighlight: 'Shadow/Highlight', colorBalance: 'Color Balance', leaveColor: 'Leave Color', changeColor: 'Change Color', changeToColor: 'Change to Color',
  transform: 'Transform', cornerPin: 'Corner Pin', lensDistortion: 'Lens Distortion', mirror: 'Mirror', offset: 'Offset', twirl: 'Twirl', waveWarp: 'Wave Warp',
  spherize: 'Spherize', turbulentDisplace: 'Turbulent Displace', fourColorGradient: '4-Color Gradient', ramp: 'Ramp', lensFlare: 'Lens Flare', checkerboard: 'Checkerboard',
  circle: 'Circle', grid: 'Grid', filmBurn: 'Light Leak', basic3d: 'Basic 3D', replicate: 'Replicate', strobeLight: 'Strobe Light', rgbSplit: 'RGB Split Chromatic',
  glitch: 'Glitch', vhs: 'VHS', echo: 'Echo', posterizeTime: 'Posterize Time', edgeFeather: 'Edge Feather', linearWipe: 'Linear Wipe', radialWipe: 'Radial Wipe',
  gradientWipe: 'Gradient Wipe', venetianBlinds: 'Venetian Blinds',
  crossDissolve: 'Cross Dissolve', additiveDissolve: 'Additive Dissolve', blurDissolve: 'Blur Dissolve', dipToBlack: 'Dip to Black', dipToWhite: 'Dip to White',
  filmDissolve: 'Film Dissolve', nonAdditiveDissolve: 'Non-Additive Dissolve', wipe: 'Wipe', barnDoor: 'Barn Doors', clockWipe: 'Clock Wipe', push: 'Push', slide: 'Slide',
  whip: 'Whip', irisRound: 'Iris Round', irisBox: 'Iris Box', irisCross: 'Iris Cross', irisDiamond: 'Iris Diamond', crossZoom: 'Cross Zoom', cubeSpin: 'Cube Spin',
  flipOver: 'Flip Over', pageTurn: 'Page Turn', pagePeel: 'Page Peel', centerSplit: 'Center Split', split: 'Split', bandSlide: 'Band Slide', bandWipe: 'Band Wipe',
  checkerWipe: 'Checker Wipe', inset: 'Inset', pinwheel: 'Pinwheel', randomBlocks: 'Random Blocks', randomWipe: 'Random Wipe', zigZagBlocks: 'Zig-Zag Blocks',
  zoomIn: 'Zoom In', zoomOut: 'Zoom Out', spin: 'Spin', constantPower: 'Constant Power', constantGain: 'Constant Gain', exponentialFade: 'Exponential Fade',
  gain: 'Amplify Gain', compressor: 'Compressor', noiseGate: 'Noise Gate', humRemove: 'DeHummer Hum', eq3: 'EQ', highpass: 'Highpass', lowpass: 'Lowpass',
  bandpass: 'Bandpass', reverb: 'Reverb', delay: 'Delay Echo', ringMod: 'Ring Modulator Robot',
};

// ---------------------------------------------------------------- default transitions

/** The transition 시퀀스 ▸ 비디오 / 오디오 전환 적용 (Ctrl+D / Ctrl+Shift+D / Shift+D) puts in. */
export function defaultTransition(kind) {
  const id = loadPref(kind === 'audio' ? 'fx.defaultAudioTransition' : 'fx.defaultVideoTransition', null);
  return id && TRANSITIONS[id] && (TRANSITIONS[id].kind === 'audio') === (kind === 'audio') ? id : kind === 'audio' ? DEFAULT_AUDIO_TRANSITION : DEFAULT_VIDEO_TRANSITION;
}

function setDefaultTransition(type) {
  const def = TRANSITIONS[type];
  if (!def) return;
  savePref(def.kind === 'audio' ? 'fx.defaultAudioTransition' : 'fx.defaultVideoTransition', type);
  store.emit('presets');
  toast(`기본 ${def.kind === 'audio' ? '오디오' : '비디오'} 전환: ${def.name} (${def.kind === 'audio' ? 'Ctrl+Shift+D' : 'Ctrl+D'})`);
}

/** Run a built-in "apply default transition" command, then give the new transitions the chosen type. */
function withDefaultTransitions(run) {
  const vid = defaultTransition('video');
  const aud = defaultTransition('audio');
  if (vid === DEFAULT_VIDEO_TRANSITION && aud === DEFAULT_AUDIO_TRANSITION) return run?.();
  const before = new Map(Object.values(store.seq.clips).map((c) => [c.id, `${JSON.stringify(c.transIn)}|${JSON.stringify(c.transOut)}`]));
  const mark = store.undoMark();
  const result = run?.();
  store.transact('기본 전환 적용', () => {
    for (const c of Object.values(store.seq.clips)) {
      const [bIn, bOut] = (before.get(c.id) || 'null|null').split('|');
      for (const [key, was] of [['transIn', bIn], ['transOut', bOut]]) {
        const t = c[key];
        if (!t || JSON.stringify(t) === was) continue;
        if (t.type === DEFAULT_VIDEO_TRANSITION) t.type = vid;
        else if (t.type === DEFAULT_AUDIO_TRANSITION) t.type = aud;
      }
    }
  });
  store.squashSince(mark, '기본 전환 적용');
  return result;
}

let transitionCommandsHooked = false;
/** (Called when the panels are built: commands.js may still be loading when this module runs.) */
function hookTransitionCommands() {
  if (transitionCommandsHooked) return;
  transitionCommandsHooked = true;
  const orig = { v: commands.applyVideoTransition, a: commands.applyAudioTransition, d: commands.applyDefaultTransitions };
  Object.assign(commands, {
    applyVideoTransition: () => withDefaultTransitions(orig.v),
    applyAudioTransition: () => withDefaultTransitions(orig.a),
    applyDefaultTransitions: () => withDefaultTransitions(orig.d),
  });
}

function folderOf(def, family) {
  const c = def.category || '기타';
  return FOLDER_ALIAS[family]?.[c] || c;
}

export function createEffectsPanel() {
  hookTransitionCommands();
  const search = h('input', { type: 'search', placeholder: '검색 (예: 흐림, 디졸브, Gaussian)', style: { flex: 1, minWidth: '80px' }, 'aria-label': '효과 검색' });
  let onlyFav = false;
  const favBtn = iconButton('star', '즐겨찾기만 보기', () => {
    onlyFav = !onlyFav;
    favBtn.classList.toggle('on', onlyFav);
    render();
  });
  const tree = h('div.fx-browser', { role: 'tree', 'aria-label': '효과' });
  const count = h('span.note');
  const body = h('div', h('div.panel-toolbar', search, favBtn), tree,
    h('div.panel-footer', count, h('span.grow'), h('span.note', '클립·효과 컨트롤로 끌어다 놓기 · 두 번 클릭: 적용')));
  const open = new Set(loadPref('fx.openFolders', ['즐겨찾기', ...BINS]));
  const favs = new Set(loadPref('fx.favs', []));
  let selectedKey = null;
  let lastSig = '';

  const sigOf = () => `${Object.keys(EFFECTS).length}:${Object.keys(TRANSITIONS).length}:${listPresets().length}`;

  function entries() {
    const list = [];
    for (const p of listPresets()) {
      const types = presetTypes(p);
      if (!types.length || !types.every((t) => EFFECTS[t])) continue;
      list.push({ key: `pre:${p.id}`, kind: 'preset', preset: p, user: true, name: p.name, bin: '사전 설정', folder: null, desc: p.desc || types.map((t) => EFFECTS[t].name).join(', '), icon: 'presets' });
    }
    for (const p of builtinPresets()) list.push({ key: `pre:${p.id}`, kind: 'preset', preset: p, name: p.name, bin: '사전 설정', folder: p.folder, desc: p.desc, icon: 'presets' });
    for (const p of lumetriPresets()) list.push({ key: `pre:${p.id}`, kind: 'preset', preset: p, name: p.name, bin: 'Lumetri 사전 설정', folder: p.folder, desc: p.desc, icon: 'sparkle' });
    for (const [type, def] of Object.entries(EFFECTS)) {
      if (def.fixed || def.hidden) continue;
      const audio = def.kind === 'audio';
      list.push({ key: `fx:${type}`, kind: 'effect', type, def, name: def.name, bin: audio ? '오디오 효과' : '비디오 효과', folder: folderOf(def, audio ? 'audio' : 'video'), en: def.en || EN_NAMES[type] || '', desc: def.desc || '', icon: audio ? 'audio' : 'wand' });
    }
    for (const [type, def] of Object.entries(TRANSITIONS)) {
      const audio = def.kind === 'audio';
      list.push({
        key: `tr:${type}`, kind: 'transition', type, def, name: def.name, bin: audio ? '오디오 전환' : '비디오 전환', folder: folderOf(def, audio ? 'audioTransition' : 'transition'),
        en: def.en || EN_NAMES[type] || '', desc: def.desc || '', icon: audio ? 'audio' : 'film', isDefault: type === defaultTransition(audio ? 'audio' : 'video'),
      });
    }
    return list;
  }

  function saveFavs() {
    savePref('fx.favs', [...favs]);
    render();
  }

  function toggleFav(key) {
    if (favs.has(key)) favs.delete(key);
    else favs.add(key);
    saveFavs();
  }

  function folderEl(id, label, children, n, forced) {
    const isOpen = forced || open.has(id);
    const el = h(`div.fx-folder${isOpen ? '' : '.collapsed'}`, { role: 'treeitem', 'aria-expanded': String(isOpen) });
    const head = h('div.fx-folder-head', h('span', isOpen ? '▾' : '▸'), icon(id === '즐겨찾기' ? 'starFill' : 'folder'), h('span', label), h('span.count', String(n)));
    head.addEventListener('click', () => {
      if (forced) return;
      if (open.has(id)) open.delete(id);
      else open.add(id);
      savePref('fx.openFolders', [...open]);
      render();
    });
    el.append(head, h('div.fx-folder-body', children));
    return el;
  }

  function itemEl(e) {
    const fav = favs.has(e.key);
    const star = iconButton(fav ? 'starFill' : 'star', fav ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가', (ev) => {
      ev.stopPropagation();
      toggleFav(e.key);
    }, { cls: `star${fav ? ' on' : ''}` });
    const kind = e.kind === 'preset' ? '사전 설정' : e.kind === 'transition' ? '전환' : '효과';
    const title = `${e.name}${e.en ? ` (${e.en})` : ''} — ${kind}${e.desc ? `\n${e.desc}` : ''}\n끌어서 클립이나 효과 컨트롤에 놓기 · 두 번 클릭: 선택한 클립에 적용`;
    const el = h(`div.fx-item${selectedKey === e.key ? '.sel' : ''}`, { draggable: true, title, role: 'treeitem' },
      icon(e.icon), h('span.fx-name', e.name),
      e.isDefault ? h('span.fx-badge', { title: `기본 전환 (${e.def.kind === 'audio' ? 'Ctrl+Shift+D' : 'Ctrl+D'})` }, '기본') : null,
      star,
      e.user ? iconButton('close', '사전 설정 삭제', (ev) => {
        ev.stopPropagation();
        removePreset(e);
      }, { cls: 'del' }) : null);
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/x-montage-effect', JSON.stringify({ type: e.type || null, transition: e.kind === 'transition', preset: e.preset?.id || null }));
      ev.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      selectedKey = e.key;
      tree.querySelectorAll('.fx-item.sel').forEach((x) => x.classList.remove('sel'));
      tree.querySelectorAll('.fx-apply').forEach((x) => x.remove());
      el.classList.add('sel');
      // phones: no double click / drag and drop — a tap shows an apply button
      if (document.body.classList.contains('mobile')) el.append(h('button.fx-apply.primary', { onclick: (be) => { be.stopPropagation(); apply(e); } }, '적용'));
    });
    el.addEventListener('dblclick', () => apply(e));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu([
        { label: '선택한 클립에 적용', action: () => apply(e) },
        { label: fav ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가', action: () => toggleFav(e.key) },
        e.kind === 'transition' ? { label: '선택한 항목을 기본 전환으로 설정', checked: e.isDefault, action: () => setDefaultTransition(e.type) } : null,
        e.user ? '-' : null,
        e.user ? { label: '사전 설정 속성…', action: () => presetProps(e.preset) } : null,
        e.user ? { label: '삭제', action: () => removePreset(e) } : null,
      ], ev.clientX, ev.clientY);
    });
    return el;
  }

  async function removePreset(e) {
    if (await confirmDialog('사전 설정 삭제', `"${e.name}" 사전 설정을 삭제할까요?`)) {
      deletePreset(e.preset.id);
      favs.delete(e.key);
      saveFavs();
    }
  }

  function presetProps(p) {
    const name = h('input', { type: 'text', value: p.name, style: { width: '100%' } });
    const desc = h('textarea', { rows: 3, style: { width: '100%' } }, p.desc || '');
    desc.addEventListener('keydown', (ev) => { if (ev.key !== 'Escape' && ev.key !== 'Tab') ev.stopPropagation(); });
    openModal({
      title: '사전 설정 속성',
      body: h('div', h('div.form-row', h('label', '이름'), name), h('div.form-row', h('label', '설명'), desc)),
      buttons: [{ label: '취소' }, {
        label: '확인',
        primary: true,
        action: () => {
          if (!name.value.trim()) return false;
          renamePreset(p.id, name.value.trim(), desc.value.trim());
          return true;
        },
      }],
    });
  }

  function apply(e) {
    const sel = store.selectedClips();
    if (!sel.length) {
      toast('효과를 넣을 클립을 타임라인에서 먼저 선택하세요');
      return;
    }
    if (e.kind === 'preset') {
      const n = applyPreset(sel.map((c) => c.id), e.preset);
      if (!n) toast('이 사전 설정을 적용할 수 있는 클립이 선택되어 있지 않습니다');
      else store.emit('reveal-effect-controls');
      return;
    }
    if (e.kind === 'transition') {
      const kind = TRANSITIONS[e.type].kind;
      const c = sel.find((x) => (x.kind === 'audio') === (kind === 'audio'));
      if (c) edit.applyTransition(c.id, 'in', e.type, 1);
      else toast(kind === 'audio' ? '오디오 클립을 선택하세요' : '비디오 클립을 선택하세요');
      return;
    }
    edit.addEffect(sel.map((c) => c.id), e.type);
    store.emit('reveal-effect-controls');
  }

  function render() {
    lastSig = sigOf();
    const all = entries();
    const q = search.value.trim().toLowerCase();
    const hit = (e) => !q || [e.name, e.en, e.type, e.folder, e.bin, e.desc].some((s) => s && String(s).toLowerCase().includes(q));
    const shown = all.filter(hit);
    tree.replaceChildren();
    const favList = shown.filter((e) => favs.has(e.key));
    if (favList.length) tree.append(folderEl('즐겨찾기', '즐겨찾기', favList.map(itemEl), favList.length, !!q || onlyFav));
    if (!onlyFav) {
      for (const bin of BINS) {
        const inBin = shown.filter((e) => e.bin === bin);
        if (!inBin.length) continue;
        const folders = new Map();
        for (const e of inBin) {
          if (!e.folder) continue;
          if (!folders.has(e.folder)) folders.set(e.folder, []);
          folders.get(e.folder).push(e);
        }
        const kids = [
          ...inBin.filter((e) => !e.folder).map(itemEl),
          ...[...folders].map(([f, list]) => folderEl(`${bin}/${f}`, f, list.map(itemEl), list.length, !!q)),
        ];
        tree.append(folderEl(bin, bin, kids, inBin.length, !!q));
      }
    }
    const nFx = all.filter((e) => e.kind === 'effect').length;
    const nTr = all.filter((e) => e.kind === 'transition').length;
    count.textContent = q ? `찾은 항목 ${shown.length}개` : `효과 ${nFx}개 · 전환 ${nTr}개`;
    if (!tree.children.length) {
      tree.append(h('div.empty-hint', onlyFav ? '즐겨찾기한 항목이 없습니다.\n효과에 마우스를 올리고 별(★)을 누르세요.' : `"${search.value}"에 맞는 효과가 없습니다`));
    }
  }
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && search.value) {
      search.value = '';
      render();
    }
  });
  store.on('presets', render);
  // effects that modules register later show up the next time the panel is used
  body.addEventListener('pointerenter', () => { if (sigOf() !== lastSig) render(); });
  render();
  return body;
}

/** Resolve an effect drag payload (from the Effects panel) — used by drop handlers. */
export function presetFromPayload(payload) {
  return payload?.preset ? getPreset(payload.preset) : null;
}

// ---------------------------------------------------------------- markers

export function createMarkersPanel() {
  const search = h('input', { type: 'search', placeholder: '마커 검색', style: { flex: 1, minWidth: '70px' }, 'aria-label': '마커 검색' });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const colorOn = new Set(loadPref('markers.colors', MARKER_COLORS.map(([c]) => c)));
  let withClips = loadPref('markers.clips', true) !== false;
  const chips = MARKER_COLORS.map(([c, label]) => {
    const b = h('button.mk-chip', { title: `${label} 마커 보이기/숨기기`, 'aria-label': `${label} 마커 표시`, style: { background: c } });
    b.addEventListener('click', () => {
      if (colorOn.has(c)) colorOn.delete(c);
      else colorOn.add(c);
      savePref('markers.colors', [...colorOn]);
      render(true);
    });
    return b;
  });
  const clipBtn = h('button', { title: '선택한 클립과 모든 클립의 클립 마커도 보기' }, '클립 마커');
  clipBtn.addEventListener('click', () => {
    withClips = !withClips;
    savePref('markers.clips', withClips);
    render(true);
  });
  const list = h('div.list.mk-list');
  const body = h('div',
    h('div.panel-toolbar', search, h('span.mk-chips', chips), clipBtn),
    list,
    h('div.panel-footer',
      iconButton('marker', '재생헤드 위치에 마커 추가 (M)', () => edit.addMarker(), { label: '마커 추가 (M)', cls: 'boxed' }),
      h('span.grow'),
      iconButton('close', '모든 마커 지우기', async () => {
        if (!store.seq.markers.length) return;
        if (await confirmDialog('모든 마커 지우기', `시퀀스 마커 ${store.seq.markers.length}개를 모두 지울까요?`)) store.transact('모든 마커 지우기', () => { store.seq.markers = []; });
      }, { label: '모두 지우기', cls: 'boxed' })));
  let sig = '';

  function gather() {
    const s = store.seq;
    const out = s.markers.map((m) => ({ m, clip: null, at: m.time }));
    if (withClips) {
      for (const c of Object.values(s.clips)) for (const m of c.markers || []) out.push({ m, clip: c, at: c.start + m.time });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  function render(force) {
    const s = store.seq;
    const all = gather();
    const nsig = JSON.stringify(all.map(({ m, at }) => [m, at])) + s.fps + search.value;
    if (!force && nsig === sig) return;
    sig = nsig;
    chips.forEach((b, i) => b.classList.toggle('off', !colorOn.has(MARKER_COLORS[i][0])));
    clipBtn.classList.toggle('on', withClips);
    const q = search.value.trim().toLowerCase();
    const shown = all.filter(({ m }) => (colorOn.has(m.color) || !MARKER_COLORS.some(([c]) => c === m.color)) && (!q || `${m.name} ${m.comment || ''}`.toLowerCase().includes(q)));
    list.replaceChildren();
    if (!all.length) list.append(h('div.empty-hint', '마커가 없습니다.\nM 키를 누르면 재생헤드 위치에 마커가 생깁니다.\n두 번 누르면 이름·색상·길이를 고칠 수 있습니다.'));
    else if (!shown.length) list.append(h('div.empty-hint', '조건에 맞는 마커가 없습니다'));
    const tc = (t) => formatTimecode(t, s.fps);
    for (const { m, clip, at } of shown) {
      const name = h('input', { type: 'text', value: m.name || '', placeholder: '(이름 없음)', 'aria-label': '마커 이름' });
      name.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') name.blur();
      });
      name.addEventListener('change', () => edit.updateMarker(m.id, { name: name.value }));
      const type = MARKER_TYPES.find(([v]) => v === (m.type || 'comment'));
      const range = m.duration > 0 ? `${tc(at)} → ${tc(at + m.duration)}` : tc(at);
      const sub = [clip ? `클립: ${clip.name || clip.kind}` : null, m.duration > 0 ? `길이 ${tc(m.duration)}` : null, type && type[0] !== 'comment' ? type[1] : null, m.comment || null].filter(Boolean).join(' · ');
      const row = h('div.mk-row', { title: '클릭: 이 위치로 이동 · 두 번 클릭: 마커 편집' },
        h('span.dot', { style: { background: m.color || '#4ade80' } }),
        h('div.mk-main', h('div.mk-line', h('span.mono', range), name), sub ? h('div.mk-sub', sub) : null),
        iconButton('close', '마커 삭제', (e) => {
          e.stopPropagation();
          edit.removeMarker(m.id);
        }));
      row.classList.toggle('current', Math.abs(store.ui.playhead - at) < 0.5 / s.fps);
      row.addEventListener('click', (e) => {
        if (e.target === name) return;
        store.setPlayhead(at);
      });
      row.addEventListener('dblclick', (e) => {
        if (e.target === name) return;
        openMarkerDialog(m.id);
      });
      row.dataset.at = String(at);
      list.append(row);
    }
  }
  search.addEventListener('input', () => render(true));
  store.on('change', () => render());
  store.on('sequence', () => render(true));
  store.on('playhead', () => {
    const fps = store.seq.fps;
    for (const r of list.querySelectorAll('.mk-row')) r.classList.toggle('current', Math.abs(store.ui.playhead - Number(r.dataset.at)) < 0.5 / fps);
  });
  render(true);
  return body;
}

// ---------------------------------------------------------------- history

/** Move through the undo history to `depth` undo entries in one step (no intermediate redraws). */
function jumpHistory(depth) {
  if (store.pending) store.commit();
  const cur = store.undoStack.length;
  depth = clamp(depth, 0, cur + store.redoStack.length);
  if (depth === cur) return;
  let snap = store.snapshot();
  if (depth < cur) {
    const moved = store.undoStack.splice(depth);
    for (let i = moved.length - 1; i >= 0; i--) {
      store.redoStack.push({ label: moved[i].label, snapshot: snap });
      snap = moved[i].snapshot;
    }
  } else {
    for (let n = depth - cur; n > 0 && store.redoStack.length; n--) {
      const e = store.redoStack.pop();
      store.undoStack.push({ label: e.label, snapshot: snap });
      snap = e.snapshot;
    }
  }
  store.project = JSON.parse(snap);
  store.pruneSelection();
  store.changed('restore');
  store.emit('history');
}

export function createHistoryPanel() {
  const list = h('div.list');
  const body = h('div', list, h('div.panel-footer',
    iconButton('undo', '실행 취소 (Ctrl+Z)', () => store.undo(), { label: '실행 취소', cls: 'boxed' }),
    iconButton('redo', '다시 실행 (Ctrl+Shift+Z)', () => store.redo(), { label: '다시 실행', cls: 'boxed' }),
    h('span.grow'),
    iconButton('trash', '작업 내역 지우기 (실행 취소할 수 없게 됩니다)', async () => {
      if (!store.undoStack.length && !store.redoStack.length) return;
      if (!(await confirmDialog('작업 내역 지우기', '지금까지의 작업 내역을 모두 지울까요?\n지운 뒤에는 이전 상태로 실행 취소할 수 없습니다.'))) return;
      store.undoStack.length = 0;
      store.redoStack.length = 0;
      store.emit('history');
    })));
  function render() {
    list.replaceChildren();
    const undo = store.undoStack;
    const redo = store.redoStack;
    const row = (label, cls, depth) => {
      const r = h(`div.list-row${cls}`, { style: { gridTemplateColumns: '1fr' }, title: '클릭: 이 단계로 돌아가기' }, label);
      r.addEventListener('click', () => jumpHistory(depth));
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu([
          { label: '이 단계로 돌아가기', action: () => jumpHistory(depth) },
          { label: '작업 내역 지우기…', action: () => body.querySelector('.panel-footer .ibtn:last-child')?.click() },
        ], e.clientX, e.clientY);
      });
      return r;
    };
    list.append(row('처음 상태', undo.length ? '' : '.current', 0));
    undo.forEach((e, i) => list.append(row(e.label, i === undo.length - 1 ? '.current' : '', i + 1)));
    [...redo].reverse().forEach((e, i) => list.append(row(e.label, '.future', undo.length + i + 1)));
    // keep the current step in view (scrolling the list only, never the page)
    const cur = list.querySelector('.current');
    if (cur && list.clientHeight) {
      const lr = list.getBoundingClientRect();
      const cr = cur.getBoundingClientRect();
      if (cr.top < lr.top || cr.bottom > lr.bottom) list.scrollTop += cr.top - lr.top - lr.height / 2;
    }
  }
  store.on('history', render);
  render();
  return body;
}

// ---------------------------------------------------------------- audio mixers

// fader travel: more room near 0 dB, like a console fader
const FADER = [[0, -60], [0.25, -30], [0.5, -12], [0.75, 0], [1, 12]];
const posToDb = (u) => {
  for (let i = 1; i < FADER.length; i++) {
    const [u1, d1] = FADER[i];
    const [u0, d0] = FADER[i - 1];
    if (u <= u1) return d0 + ((u - u0) / (u1 - u0)) * (d1 - d0);
  }
  return FADER[FADER.length - 1][1];
};
const dbToPos = (db) => {
  for (let i = 1; i < FADER.length; i++) {
    const [u1, d1] = FADER[i];
    const [u0, d0] = FADER[i - 1];
    if (db <= d1) return u0 + ((clamp(db, -60, 12) - d0) / (d1 - d0)) * (u1 - u0);
  }
  return 1;
};
const fmtDb = (db) => (db <= -59.95 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

/**
 * A vertical fader whose edits are one undo step per drag. get() reads the live value, set(v) writes it
 * raw; the element is never rebuilt while dragged, so the drag (and its undo step) always finish.
 */
function faderControl({ label, get, set, min = -60, max = 12, undoLabel }) {
  const r = h('input.fader', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': label, title: `${label} (두 번 클릭: 0 dB)` });
  const dbEl = h('span.db', { title: '클릭해서 값 입력' });
  let begun = false;
  const show = (db) => {
    if (!begun) r.value = String(Math.round(dbToPos(db) * 1000));
    dbEl.textContent = `${fmtDb(db)} dB`;
  };
  const finish = () => {
    if (begun) store.commit();
    begun = false;
  };
  r.addEventListener('input', () => {
    if (!begun) {
      store.begin(undoLabel);
      begun = true;
    }
    const db = clamp(Math.round(posToDb(Number(r.value) / 1000) * 10) / 10, min, max);
    set(db);
    dbEl.textContent = `${fmtDb(db)} dB`;
    store.changed();
  });
  r.addEventListener('change', finish);
  r.addEventListener('pointerup', () => setTimeout(finish, 0));
  r.addEventListener('blur', finish);
  r.addEventListener('dblclick', () => {
    finish();
    store.transact(`${undoLabel} 초기화`, () => set(0));
  });
  dbEl.addEventListener('click', () => {
    const input = h('input.db-input', { type: 'text', value: get().toFixed(1) });
    dbEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const end = (ok) => {
      if (done) return;
      done = true;
      input.replaceWith(dbEl);
      const v = parseFloat(input.value);
      if (ok && Number.isFinite(v)) store.transact(undoLabel, () => set(clamp(v, min, max)));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') end(true);
      if (e.key === 'Escape') end(false);
    });
    input.addEventListener('blur', () => end(true));
  });
  return { el: r, dbEl, update: () => show(get()), busy: () => begun };
}

/** A pan knob (−100 왼쪽 … 100 오른쪽) as a horizontal slider; one undo step per drag. */
function panControl({ label, get, set, undoLabel }) {
  const r = h('input.knob', { type: 'range', min: -100, max: 100, step: 1, 'aria-label': label, title: `${label} (두 번 클릭: 가운데)` });
  const txt = h('span.ssub');
  let begun = false;
  const name = (v) => (v === 0 ? '가운데' : v < 0 ? `왼쪽 ${-v}` : `오른쪽 ${v}`);
  const finish = () => {
    if (begun) store.commit();
    begun = false;
  };
  r.addEventListener('input', () => {
    if (!begun) {
      store.begin(undoLabel);
      begun = true;
    }
    set(Number(r.value));
    txt.textContent = name(Number(r.value));
    store.changed();
  });
  r.addEventListener('change', finish);
  r.addEventListener('pointerup', () => setTimeout(finish, 0));
  r.addEventListener('blur', finish);
  r.addEventListener('dblclick', () => {
    finish();
    store.transact(undoLabel, () => set(0));
  });
  return {
    el: r,
    txt,
    update: () => {
      const v = Math.round(get());
      if (!begun) r.value = String(v);
      txt.textContent = name(v);
    },
  };
}

/** Level meter with a peak-hold line and a clip light (click resets it). */
function levelMeter(getLevel) {
  const canvas = h('canvas.mm', { title: '레벨 (빨간 표시: 0 dB 넘음 — 클릭해서 지우기)' });
  const peak = h('span.peak', '-∞');
  let hold = -Infinity;
  let holdT = 0;
  let maxSeen = -Infinity;
  let smooth = -Infinity;
  const reset = () => {
    maxSeen = -Infinity;
    peak.classList.remove('clip');
    peak.textContent = '-∞';
  };
  canvas.addEventListener('click', reset);
  peak.addEventListener('click', reset);
  const yOf = (db, hh) => (1 - clamp((db + 60) / 63, 0, 1)) * hh;
  return {
    el: h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' } }, peak, canvas),
    draw(now) {
      const lvl = getLevel();
      smooth = Math.max(lvl, smooth - 1.5);
      if (lvl > hold || now - holdT > 1500) {
        hold = lvl;
        holdT = now;
      }
      if (lvl > maxSeen) {
        maxSeen = lvl;
        peak.textContent = Number.isFinite(lvl) ? lvl.toFixed(1) : '-∞';
        peak.classList.toggle('clip', lvl > -0.1);
      }
      const { ctx, w, h: hh } = fitCanvasToBox(canvas);
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, w, hh);
      if (Number.isFinite(smooth)) {
        const top = yOf(smooth, hh);
        const grad = ctx.createLinearGradient(0, hh, 0, 0);
        grad.addColorStop(0, '#2fbf71');
        grad.addColorStop(0.78, '#2fbf71');
        grad.addColorStop(0.9, '#e8d44d');
        grad.addColorStop(1, '#e5484d');
        ctx.fillStyle = grad;
        ctx.fillRect(1, top, w - 2, hh - top);
      }
      if (Number.isFinite(hold)) {
        ctx.fillStyle = hold > -0.5 ? '#e5484d' : '#ddd';
        ctx.fillRect(1, yOf(hold, hh) - 1, w - 2, 2);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (const t of [0, -6, -12, -24, -48]) ctx.fillRect(0, Math.round(yOf(t, hh)), 3, 1);
    },
  };
}

/**
 * Audio Track Mixer (오디오 트랙 믹서): per audio track a pan knob, mute / solo / voice-over record,
 * a fader with its dB value and a level meter; the master strip on the right.
 */
export function createMixerPanel() {
  const strips = h('div.mixer');
  const body = h('div.mixer-wrap', strips);
  let sig = '';
  let updaters = [];
  let meters = [];

  function build() {
    const s = store.seq;
    sig = `${s.id}:${audioTracks(s).map((t) => `${t.id}.${t.name}`).join(',')}`;
    updaters = [];
    meters = [];
    strips.replaceChildren();
    for (const t of audioTracks(s)) {
      const tid = t.id;
      const tr = () => store.seq.tracks.find((x) => x.id === tid);
      const pan = panControl({ label: `${t.name} 팬`, get: () => tr()?.pan || 0, set: (v) => edit.setTrackValue(tid, 'pan', v), undoLabel: '트랙 팬' });
      const fader = faderControl({ label: `${t.name} 볼륨`, get: () => tr()?.volume || 0, set: (v) => edit.setTrackValue(tid, 'volume', v), undoLabel: '트랙 볼륨' });
      const mute = h('button.mute', { title: '트랙 음소거', onclick: () => edit.setTrackFlag(tid, 'muted') }, 'M');
      const solo = h('button.solo', { title: '트랙 솔로 (이 트랙만 듣기)', onclick: () => edit.setTrackFlag(tid, 'solo') }, 'S');
      const rec = h('button.rec', { title: '보이스오버 녹음 (이 트랙에 녹음 시작/중지)', onclick: () => toggleVoiceover(tid) }, icon('mic'));
      const meter = levelMeter(() => (playback.playing ? playback.trackLevel(tid) : -Infinity));
      meters.push(meter);
      const name = h('span.sname');
      updaters.push(() => {
        const x = tr();
        if (!x) return;
        name.textContent = x.name;
        pan.update();
        fader.update();
        mute.classList.toggle('on', !!x.muted);
        mute.setAttribute('aria-pressed', String(!!x.muted));
        solo.classList.toggle('on', !!x.solo);
        solo.setAttribute('aria-pressed', String(!!x.solo));
        rec.classList.toggle('on', recordingTrack?.() === tid);
      });
      strips.append(h('div.strip',
        pan.txt, pan.el,
        h('div.btns', mute, solo, rec),
        h('div.meter-box', fader.el, meter.el),
        fader.dbEl, name));
    }
    const mfader = faderControl({ label: '마스터 볼륨', get: () => store.seq.masterVolume || 0, set: (v) => { store.seq.masterVolume = v; }, undoLabel: '마스터 볼륨' });
    const mL = levelMeter(() => (playback.playing ? playback.meterLevels()[0] : -Infinity));
    const mR = levelMeter(() => (playback.playing ? playback.meterLevels()[1] : -Infinity));
    meters.push(mL, mR);
    updaters.push(() => mfader.update());
    strips.append(h('div.strip.master', h('span.ssub', '스테레오'), h('span', { style: { height: '22px' } }), h('div.btns'),
      h('div.meter-box', mfader.el, mL.el, mR.el), mfader.dbEl, h('span.sname', '마스터')));
    update();
  }

  function update() {
    for (const u of updaters) u();
  }

  function onChange() {
    const s = store.seq;
    const nsig = `${s.id}:${audioTracks(s).map((t) => `${t.id}.${t.name}`).join(',')}`;
    if (nsig !== sig) build();
    else update();
  }

  let raf = 0;
  const loop = (now) => {
    raf = 0;
    if (!body.isConnected || !body.classList.contains('active')) return;
    for (const m of meters) m.draw(now);
    if (playback.playing) raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  store.on('change', onChange);
  store.on('sequence', build);
  store.on('recording', update);
  playback.on?.('state', kick);
  playback.addRenderer(kick);
  build();
  return Object.assign(body, { onShow: kick });
}

/**
 * Audio Clip Mixer (오디오 클립 믹서): one strip per audio track for the clip under the playhead —
 * its clip volume (볼륨 ▸ 레벨) and pan (패너 ▸ 밸런스). With 키프레임 쓰기 on, moving a fader
 * writes keyframes at the playhead (also while playing, which records a volume ride).
 */
export function createClipMixerPanel() {
  const strips = h('div.mixer');
  const info = h('span.note', '재생헤드 아래 클립의 볼륨과 팬을 조절합니다');
  const body = h('div.mixer-wrap', h('div.panel-toolbar', icon('mixer'), info), strips);
  let sig = '';
  let updaters = [];
  let meters = [];
  const writeKeys = new Set(loadPref('clipMixer.writeKeys', []));

  const clipOn = (tid) => clipAt(store.seq, tid, store.ui.playhead);
  const fxOf = (c, type) => c?.effects.find((e) => e.type === type);

  /** Write a clip param at the playhead: keyed when animated (or when 키프레임 쓰기 is on). */
  function writeParam(tid, type, key, v) {
    const c = clipOn(tid);
    const fx = fxOf(c, type);
    const p = fx?.params[key];
    if (!p) return;
    const t = clamp(store.ui.playhead - c.start, 0, c.duration);
    if (writeKeys.has(tid) && !isAnimated(p)) p.kf = [newKey(t, evalParam(p, t))];
    if (isAnimated(p)) setParamValue(p, v, t, 1 / store.seq.fps);
    else p.value = v;
  }

  function build() {
    const s = store.seq;
    sig = `${s.id}:${audioTracks(s).map((t) => `${t.id}.${t.name}`).join(',')}`;
    updaters = [];
    meters = [];
    strips.replaceChildren();
    const tracks = audioTracks(s);
    if (!tracks.length) strips.append(h('div.empty-hint.mixer-empty', '오디오 트랙이 없습니다'));
    for (const t of tracks) {
      const tid = t.id;
      const level = () => {
        const c = clipOn(tid);
        const p = fxOf(c, 'volume')?.params.level;
        return p ? evalParam(p, clamp(store.ui.playhead - c.start, 0, c.duration)) : 0;
      };
      const balance = () => {
        const c = clipOn(tid);
        const p = fxOf(c, 'panner')?.params.balance;
        return p ? evalParam(p, clamp(store.ui.playhead - c.start, 0, c.duration)) : 0;
      };
      const fader = faderControl({ label: `${t.name} 클립 볼륨`, get: level, set: (v) => writeParam(tid, 'volume', 'level', v), min: -60, max: 15, undoLabel: '클립 볼륨' });
      const pan = panControl({ label: `${t.name} 클립 팬`, get: balance, set: (v) => writeParam(tid, 'panner', 'balance', v), undoLabel: '클립 팬' });
      const kf = h('button.kfbtn', { title: '키프레임 쓰기: 켜면 페이더를 움직일 때 재생헤드 위치에 키프레임을 만듭니다 (재생 중이면 계속 기록)', 'aria-label': '키프레임 쓰기' }, icon('diamond'));
      kf.addEventListener('click', () => {
        if (writeKeys.has(tid)) writeKeys.delete(tid);
        else writeKeys.add(tid);
        savePref('clipMixer.writeKeys', [...writeKeys]);
        update();
      });
      const mute = h('button.mute', { title: '트랙 음소거', onclick: () => edit.setTrackFlag(tid, 'muted') }, 'M');
      const solo = h('button.solo', { title: '트랙 솔로', onclick: () => edit.setTrackFlag(tid, 'solo') }, 'S');
      const meter = levelMeter(() => (playback.playing && clipOn(tid) ? playback.trackLevel(tid) : -Infinity));
      meters.push(meter);
      const clipName = h('span.ssub');
      const name = h('span.sname');
      const strip = h('div.strip.cm', pan.txt, pan.el, h('div.btns', mute, solo, kf), h('div.meter-box', fader.el, meter.el), fader.dbEl, clipName, name);
      updaters.push(() => {
        const tr = store.seq.tracks.find((x) => x.id === tid);
        const c = clipOn(tid);
        name.textContent = tr?.name || '';
        clipName.textContent = c ? c.name || '오디오 클립' : '(클립 없음)';
        clipName.title = clipName.textContent;
        fader.el.disabled = !c || !!tr?.locked;
        pan.el.disabled = !c || !!tr?.locked;
        strip.classList.toggle('selected', !!c && store.selection.clips.has(c.id));
        fader.update();
        pan.update();
        kf.classList.toggle('on', writeKeys.has(tid));
        mute.classList.toggle('on', !!tr?.muted);
        solo.classList.toggle('on', !!tr?.solo);
      });
      strips.append(strip);
    }
    update();
  }

  function update() {
    for (const u of updaters) u();
  }

  function onChange() {
    const s = store.seq;
    const nsig = `${s.id}:${audioTracks(s).map((t) => `${t.id}.${t.name}`).join(',')}`;
    if (nsig !== sig) build();
    else update();
  }

  let raf = 0;
  const loop = (now) => {
    raf = 0;
    if (!body.isConnected || !body.classList.contains('active')) return;
    for (const m of meters) m.draw(now);
    if (playback.playing) raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  store.on('change', onChange);
  store.on('sequence', build);
  store.on('selection', update);
  store.on('playhead', () => {
    if (body.classList.contains('active')) update();
  });
  playback.addRenderer(kick);
  build();
  return Object.assign(body, { onShow: () => { update(); kick(); } });
}

// ---------------------------------------------------------------- Lumetri scopes

/** Lumetri 범위: the scopes Premiere offers (Lumetri 범위 ▸ 설정). */
const SCOPES = [
  ['vectorYUV', '벡터스코프 YUV'],
  ['vectorHLS', '벡터스코프 HLS'],
  ['histogram', '히스토그램'],
  ['paradeRGB', '퍼레이드 (RGB)'],
  ['paradeYUV', '퍼레이드 (YUV)'],
  ['waveRGB', '파형 (RGB)'],
  ['waveLuma', '파형 (루마)'],
  ['waveYC', '파형 (YC)'],
];
const SCOPE_PRESETS = [
  ['파형 (루마)', ['waveLuma']],
  ['파형 (RGB)', ['waveRGB']],
  ['색 보정 기본: 파형 · 퍼레이드 · 벡터스코프', ['waveLuma', 'paradeRGB', 'vectorYUV']],
  ['모든 범위', ['vectorYUV', 'histogram', 'paradeRGB', 'waveLuma']],
  ['피부톤 확인: 벡터스코프 YUV', ['vectorYUV']],
];
const OLD_MODE = { waveform: 'waveLuma', parade: 'paradeRGB', histogram: 'histogram', vectorscope: 'vectorYUV' };

const SW = 256; // scope resolution (columns / levels); drawn scaled to the panel
const SH = 256;

/** Accumulates scope traces into an RGBA image of SW×SH; returns an offscreen canvas. */
class ScopeRaster {
  constructor() {
    this.acc = [new Float32Array(SW * SH), new Float32Array(SW * SH), new Float32Array(SW * SH)];
    this.canvas = document.createElement('canvas');
    this.canvas.width = SW;
    this.canvas.height = SH;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(SW, SH);
  }

  clear() {
    for (const a of this.acc) a.fill(0);
  }

  /** Turn counts into light: k scales the brightness; colors[c] = [r, g, b] per channel. */
  paint(colors, k) {
    const d = this.img.data;
    const n = SW * SH;
    for (let i = 0; i < n; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let c = 0; c < colors.length; c++) {
        const v = this.acc[c][i];
        if (!v) continue;
        const e = 1 - Math.exp(-v * k);
        r += colors[c][0] * e;
        g += colors[c][1] * e;
        b += colors[c][2] * e;
      }
      const o = i * 4;
      d[o] = r > 255 ? 255 : r;
      d[o + 1] = g > 255 ? 255 : g;
      d[o + 2] = b > 255 ? 255 : b;
      d[o + 3] = r || g || b ? 255 : 0;
    }
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}

export function createScopesPanel() {
  let shown = loadPref('scopes.show', null);
  if (!Array.isArray(shown) || !shown.length) shown = [OLD_MODE[loadPref('scopes.mode', 'waveform')] || 'waveLuma'];
  shown = shown.filter((id) => SCOPES.some(([s]) => s === id));
  if (!shown.length) shown = ['waveLuma'];
  let bright = Number(loadPref('scopes.bright', 60)) || 60;
  const pick = h('button', { title: '보여 줄 범위 고르기 (Lumetri 범위 설정)' }, icon('gear'), ' 범위');
  const slider = h('input', { type: 'range', min: 5, max: 100, step: 1, value: bright, title: '밝기', 'aria-label': '범위 밝기' });
  slider.addEventListener('input', () => {
    bright = Number(slider.value);
    savePref('scopes.bright', bright);
    draw();
  });
  const grid = h('div.scope-grid');
  const body = h('div.scopes', h('div.panel-toolbar', pick, h('span.grow'), h('span.note', '밝기'), slider), grid);
  const sample = document.createElement('canvas');
  const raster = new ScopeRaster();
  let cells = [];
  let last = 0;
  let visible = false;

  pick.addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([
      { group: '범위 (여러 개 고를 수 있음)' },
      ...SCOPES.map(([id, label]) => ({ label, checked: shown.includes(id), action: () => toggleScope(id) })),
      '-',
      { label: '사전 설정', submenu: SCOPE_PRESETS.map(([label, list]) => ({ label, action: () => setShown(list) })) },
    ], r.left, r.bottom + 2);
  });

  function toggleScope(id) {
    const next = shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id];
    setShown(next.length ? next : [id]);
  }

  function setShown(list) {
    shown = SCOPES.map(([id]) => id).filter((id) => list.includes(id));
    savePref('scopes.show', shown);
    layout();
    draw();
  }

  function layout() {
    const n = shown.length;
    grid.style.gridTemplateColumns = n <= 1 ? '1fr' : n === 2 ? '1fr 1fr' : 'repeat(2, minmax(0, 1fr))';
    grid.style.gridTemplateRows = n <= 2 ? '1fr' : 'repeat(2, minmax(0, 1fr))';
    cells = shown.map((id) => {
      const canvas = h('canvas');
      const cell = h('div.scope-cell', canvas, h('span.scope-name', SCOPES.find(([s]) => s === id)[1]));
      return { id, canvas, cell };
    });
    grid.replaceChildren(...cells.map((c) => c.cell));
  }

  /** Program frame pixels at scope resolution. */
  function grab() {
    const src = programApi.canvas;
    if (!src || !src.width || !src.height) return null;
    const sw = 240;
    const sh = clamp(Math.round((sw * src.height) / src.width), 1, 240);
    sample.width = sw;
    sample.height = sh;
    const sctx = sample.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(src, 0, 0, sw, sh);
    return { data: sctx.getImageData(0, 0, sw, sh).data, sw, sh };
  }

  // trace brightness: one hit already shows, dense areas glow (밝기 slider scales it)
  const kWave = () => (bright / 60) * 0.35;
  const kVector = () => (bright / 60) * 0.06;

  function waveform(id, px, ctx, w, hh) {
    const { data, sw, sh } = px;
    raster.clear();
    const [A, B, C] = raster.acc;
    const parade = id.startsWith('parade');
    const colW = parade ? Math.floor(SW / 3) : SW;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const col = Math.min(colW - 1, Math.floor((x * colW) / sw));
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (id === 'waveLuma') A[(255 - (Y | 0)) * SW + col]++;
        else if (id === 'waveRGB') {
          A[(255 - r) * SW + col]++;
          B[(255 - g) * SW + col]++;
          C[(255 - b) * SW + col]++;
        } else if (id === 'waveYC') {
          const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
          const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
          A[(255 - (Y | 0)) * SW + col]++;
          const cmag = Math.min(255, Math.hypot(cb, cr) * 2) | 0;
          B[(255 - cmag) * SW + col]++;
        } else if (id === 'paradeRGB') {
          A[(255 - r) * SW + col]++;
          B[(255 - g) * SW + colW + col]++;
          C[(255 - b) * SW + 2 * colW + col]++;
        } else if (id === 'paradeYUV') {
          const cb = clamp(128 + (-0.1146 * r - 0.3854 * g + 0.5 * b), 0, 255) | 0;
          const cr = clamp(128 + (0.5 * r - 0.4542 * g - 0.0458 * b), 0, 255) | 0;
          A[(255 - (Y | 0)) * SW + col]++;
          B[(255 - cb) * SW + colW + col]++;
          C[(255 - cr) * SW + 2 * colW + col]++;
        }
      }
    }
    const k = kWave();
    const colors = {
      waveLuma: [[150, 255, 170]],
      waveRGB: [[255, 60, 60], [60, 255, 60], [80, 120, 255]],
      waveYC: [[150, 255, 170], [90, 140, 255]],
      paradeRGB: [[255, 70, 70], [70, 255, 70], [90, 130, 255]],
      paradeYUV: [[220, 220, 220], [90, 140, 255], [255, 90, 120]],
    }[id];
    const img = raster.paint(colors, k);
    const L = 30;
    const T = 6;
    const W = w - L - 6;
    const H = hh - T - 6;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, L, T, W, H);
    // graticule: 0 … 100 IRE
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.beginPath();
    for (let lvl = 0; lvl <= 100; lvl += 10) {
      const y = Math.round(T + (1 - lvl / 100) * H) + 0.5;
      ctx.moveTo(L, y);
      ctx.lineTo(L + W, y);
      if (lvl % 20 === 0) ctx.fillText(String(lvl), L - 4, y);
    }
    if (parade) {
      for (let s = 1; s < 3; s++) {
        const x = Math.round(L + (W * s) / 3) + 0.5;
        ctx.moveTo(x, T);
        ctx.lineTo(x, T + H);
      }
    }
    ctx.stroke();
    if (parade) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const names = id === 'paradeRGB' ? ['R', 'G', 'B'] : ['Y', 'Cb', 'Cr'];
      names.forEach((n, s) => ctx.fillText(n, L + (W * (s + 0.5)) / 3, T + 2));
    }
  }

  function histogram(px, ctx, w, hh) {
    const { data } = px;
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < data.length; i += 4) {
      bins[0][data[i]]++;
      bins[1][data[i + 1]]++;
      bins[2][data[i + 2]]++;
    }
    let max = 1;
    for (const b of bins) for (let x = 1; x < 255; x++) max = Math.max(max, b[x]);
    // Premiere draws the histogram on its side: levels upward, counts to the right
    const L = 30;
    const T = 6;
    const W = w - L - 6;
    const H = hh - T - 6;
    ctx.globalCompositeOperation = 'lighter';
    ['rgba(255,60,60,0.75)', 'rgba(60,255,60,0.75)', 'rgba(70,120,255,0.75)'].forEach((col, ch) => {
      ctx.fillStyle = col;
      for (let v = 0; v < 256; v++) {
        const len = Math.min(1, bins[ch][v] / max) * W;
        if (len < 0.3) continue;
        ctx.fillRect(L, T + (1 - (v + 1) / 256) * H, len, H / 256 + 0.6);
      }
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    for (const v of [0, 64, 128, 192, 255]) {
      const y = Math.round(T + (1 - v / 255) * H) + 0.5;
      ctx.moveTo(L, y);
      ctx.lineTo(L + W, y);
      ctx.fillText(String(v), L - 4, y);
    }
    ctx.stroke();
  }

  function vectorscope(id, px, ctx, w, hh) {
    const { data } = px;
    raster.clear();
    const [A, B, C] = raster.acc;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      let x;
      let y;
      if (id === 'vectorYUV') {
        const cb = (-0.1146 * r - 0.3854 * g + 0.5 * b) / 255;
        const cr = (0.5 * r - 0.4542 * g - 0.0458 * b) / 255;
        x = 128 + cb * 2 * 120;
        y = 128 - cr * 2 * 120;
      } else {
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const l = (mx + mn) / 510;
        const d = (mx - mn) / 255;
        const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1);
        let hue = 0;
        if (d) {
          if (mx === r) hue = ((g - b) / (mx - mn)) % 6;
          else if (mx === g) hue = (b - r) / (mx - mn) + 2;
          else hue = (r - g) / (mx - mn) + 4;
          hue *= 60;
        }
        // same orientation as the YUV scope: red at 103°, hues counter-clockwise
        const a = ((103 + hue) * Math.PI) / 180;
        x = 128 + Math.cos(a) * clamp(s, 0, 1) * 120;
        y = 128 - Math.sin(a) * clamp(s, 0, 1) * 120;
      }
      const ix = clamp(x | 0, 0, SW - 1);
      const iy = clamp(y | 0, 0, SH - 1);
      const o = iy * SW + ix;
      // trace in the pixel's own hue, brightened so dark colours still show
      const m = Math.max(r, g, b, 1);
      A[o] += 0.35 + (0.65 * r) / m;
      B[o] += 0.35 + (0.65 * g) / m;
      C[o] += 0.35 + (0.65 * b) / m;
    }
    const k = kVector();
    const img = raster.paint([[255, 0, 0], [0, 255, 0], [0, 0, 255]], k);
    const S = Math.min(w, hh) - 12;
    const ox = (w - S) / 2;
    const oy = (hh - S) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, ox, oy, S, S);
    const cx = ox + S / 2;
    const cy = oy + S / 2;
    const R = (S / SW) * 120;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();
    // targets: 75% colour bars (R, Mg, B, Cy, G, Yl)
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [name, r, g, b] of [['R', 191, 0, 0], ['Mg', 191, 0, 191], ['B', 0, 0, 191], ['Cy', 0, 191, 191], ['G', 0, 191, 0], ['Yl', 191, 191, 0]]) {
      let tx;
      let ty;
      if (id === 'vectorYUV') {
        const cb = (-0.1146 * r - 0.3854 * g + 0.5 * b) / 255;
        const cr = (0.5 * r - 0.4542 * g - 0.0458 * b) / 255;
        tx = cx + cb * 2 * R;
        ty = cy - cr * 2 * R;
      } else {
        const hue = { R: 0, Yl: 60, G: 120, Cy: 180, B: 240, Mg: 300 }[name];
        const a = ((103 + hue) * Math.PI) / 180;
        tx = cx + Math.cos(a) * R * 0.75;
        ty = cy - Math.sin(a) * R * 0.75;
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.strokeRect(tx - 5, ty - 5, 10, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(name, tx + (tx >= cx ? 14 : -14), ty);
    }
    if (id === 'vectorYUV') {
      // skin tone line (I line, about 123°)
      ctx.strokeStyle = 'rgba(255,200,150,0.45)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos((-123 * Math.PI) / 180) * R, cy + Math.sin((-123 * Math.PI) / 180) * R);
      ctx.stroke();
    }
  }

  function draw() {
    if (!visible || !body.isConnected) return;
    const px = grab();
    for (const c of cells) {
      const { ctx, w, h: hh } = fitCanvasToBox(c.canvas);
      ctx.fillStyle = '#07080a';
      ctx.fillRect(0, 0, w, hh);
      if (!px || w < 20 || hh < 20) continue;
      if (c.id === 'histogram') histogram(px, ctx, w, hh);
      else if (c.id.startsWith('vector')) vectorscope(c.id, px, ctx, w, hh);
      else waveform(c.id, px, ctx, w, hh);
    }
  }

  layout();
  playback.addRenderer(() => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    draw();
  });
  window.addEventListener('resize', () => requestAnimationFrame(draw));
  return Object.assign(body, {
    onShow: () => {
      visible = true;
      requestAnimationFrame(draw);
    },
    setVisible: (v) => { visible = v; },
  });
}

// ---------------------------------------------------------------- multicam

const mcVisible = new Set();

export function createMulticamPanel() {
  const grid = h('div.multicam-grid');
  const info = h('span.note');
  const cutBtn = h('button', { title: '켜면 멈춘 상태에서도 재생헤드 위치에서 잘라 앵글을 바꿉니다' }, '멈춤 상태에서도 자르기');
  let cutWhenPaused = loadPref('multicam.cutPaused', false);
  cutBtn.addEventListener('click', () => {
    cutWhenPaused = !cutWhenPaused;
    savePref('multicam.cutPaused', cutWhenPaused);
    refreshCut();
  });
  const refreshCut = () => {
    cutBtn.classList.toggle('on', cutWhenPaused);
    cutBtn.setAttribute('aria-pressed', String(cutWhenPaused));
  };
  refreshCut();
  const body = h('div.multicam', h('div.panel-toolbar', icon('multicam'), info, h('span.grow'), cutBtn), grid,
    h('div.panel-footer', h('span.note', '앵글 화면을 누르거나 숫자 키 1~9로 바꿉니다. 재생 중에 바꾸면 그 위치에서 잘립니다.')));
  const compositor = new Compositor({ onAsyncReady: () => playback.requestRender() });
  let visible = false;
  let cells = [];
  let cellSig = '';
  let last = 0;

  function current() {
    const c = edit.multicamClipAt();
    if (!c) return null;
    const m = store.project.media[c.mediaId];
    const inner = m && store.project.sequences[m.sequenceId];
    return inner ? { clip: c, inner } : null;
  }

  function switchTo(n) {
    edit.switchAngle(n, { cut: playback.playing || cutWhenPaused });
  }

  function build(mc) {
    const tracks = videoTracks(mc.inner);
    const sig = `${mc.inner.id}:${tracks.length}`;
    if (sig === cellSig) return;
    cellSig = sig;
    const cols = Math.ceil(Math.sqrt(tracks.length));
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    cells = tracks.map((tr, i) => {
      const canvas = h('canvas');
      const label = h('span.num', `${i + 1}`);
      const cell = h('div.angle', { title: `앵글 ${i + 1} (${i + 1} 키)`, role: 'button', 'aria-label': `앵글 ${i + 1}` }, canvas, label);
      cell.addEventListener('click', () => switchTo(i + 1));
      return { cell, canvas, label, track: tr };
    });
    grid.replaceChildren(...cells.map((c) => c.cell));
  }

  /** Every angle fits in the panel (rows by height too), as in Premiere's multi-camera view. */
  function fitTiles(inner, n) {
    if (!n) return;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const r = grid.getBoundingClientRect();
    const aw = (r.width - 16 - 6 * (cols - 1)) / cols;
    const ah = (r.height - 16 - 6 * (rows - 1)) / rows;
    const w = Math.max(48, Math.floor(ah > 30 ? Math.min(aw, ((ah - 6) * inner.width) / inner.height + 6) : aw));
    const tpl = `repeat(${cols}, ${w}px)`;
    if (grid.style.gridTemplateColumns !== tpl) {
      grid.style.gridTemplateColumns = tpl;
      grid.style.justifyContent = 'center';
      for (const c of cells) c.cell.style.aspectRatio = `${inner.width} / ${inner.height}`;
    }
  }

  function draw() {
    if (!visible) return;
    const mc = current();
    if (!mc) {
      cellSig = '';
      cells = [];
      info.textContent = '';
      grid.style.gridTemplateColumns = '1fr';
      grid.replaceChildren(h('div.empty-hint', '재생헤드 아래에 멀티캠 클립이 없습니다.\n\n프로젝트 패널에서 같은 장면을 찍은 영상 여러 개를 선택한 뒤\n클립 ▸ 멀티 카메라 소스 시퀀스 만들기를 누르세요.'));
      return;
    }
    build(mc);
    fitTiles(mc.inner, cells.length);
    const { clip, inner } = mc;
    const angle = clip.multicam?.angle || 1;
    const mt = mediaTimeAt(clip, store.ui.playhead);
    info.textContent = `${inner.name} · 현재 앵글 ${angle}`;
    compositor.prefix = `${clip.id}/`;
    cells.forEach((c, i) => {
      c.cell.classList.toggle('active', i + 1 === angle);
      const r = c.cell.getBoundingClientRect();
      const w = Math.max(32, Math.round(r.width));
      const hh = Math.max(18, Math.round((w * inner.height) / inner.width));
      if (c.canvas.width !== w || c.canvas.height !== hh) {
        c.canvas.width = w;
        c.canvas.height = hh;
      }
      compositor.render(c.canvas.getContext('2d'), inner, mt, playback.provider, { scale: w / inner.width, angle: i + 1 });
      const clipOn = clipsOnTrack(inner, c.track.id).find((x) => mt >= x.start && mt < clipEnd(x));
      c.label.textContent = `${i + 1}  ${clipOn ? clipOn.name : '(없음)'}`;
    });
  }

  playback.addRenderer(() => {
    const now = performance.now();
    if (playback.playing && now - last < 60) return;
    last = now;
    draw();
  });
  store.on('change', () => playback.requestRender());
  return Object.assign(body, {
    // the panel and the Program monitor's 멀티 카메라 view are separate copies: angles keep decoding
    // while either is showing
    onShow: () => {
      visible = true;
      mcVisible.add(body);
      playback.multicamPreview = true;
      playback.requestRender();
    },
    onHide: () => {
      visible = false;
      mcVisible.delete(body);
      playback.multicamPreview = mcVisible.size > 0;
    },
  });
}

// ---------------------------------------------------------------- audio meters

export function createMeters(el) {
  const canvas = h('canvas', { 'aria-label': '오디오 레벨 미터', title: '오디오 미터 (클릭: 피크 표시 지우기)' });
  el.append(canvas, h('div.meter-label', 'dB'));
  const peaks = [-Infinity, -Infinity];
  const holds = [{ v: -Infinity, t: 0 }, { v: -Infinity, t: 0 }];
  const clipped = [false, false];
  const ticks = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54];
  const y = (db, hh) => 14 + (1 - clamp((db + 60) / 60, 0, 1)) * (hh - 20);
  canvas.addEventListener('click', () => {
    clipped[0] = clipped[1] = false;
    holds[0] = { v: -Infinity, t: 0 };
    holds[1] = { v: -Infinity, t: 0 };
  });
  let idle = 0;
  let looping = false;
  // the meters sleep once playback has stopped and the bars have fallen; playback wakes them
  const wake = () => {
    idle = 0;
    if (looping) return;
    looping = true;
    requestAnimationFrame(draw);
  };
  function draw(now) {
    looping = false;
    if (!playback.playing && idle > 90) return;
    looping = true;
    requestAnimationFrame(draw);
    idle = playback.playing ? 0 : idle + 1;
    const { ctx, w, h: hh } = fitCanvasToBox(canvas, { cached: true });
    if (w < 4) return;
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, 0, w, hh);
    const levels = playback.playing ? playback.meterLevels() : [-Infinity, -Infinity];
    const barW = 8;
    const x0 = w - barW * 2 - 6;
    for (let ch = 0; ch < 2; ch++) {
      peaks[ch] = Math.max(levels[ch], peaks[ch] - 1.2);
      if (levels[ch] > holds[ch].v || now - holds[ch].t > 1500) holds[ch] = { v: levels[ch], t: now };
      if (levels[ch] > -0.1) clipped[ch] = true;
      const x = x0 + ch * (barW + 2);
      // clip light
      ctx.fillStyle = clipped[ch] ? '#e5484d' : '#2a2a2a';
      ctx.fillRect(x, 3, barW, 6);
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(x, 14, barW, hh - 20);
      const top = y(peaks[ch], hh);
      const grad = ctx.createLinearGradient(0, hh, 0, 0);
      grad.addColorStop(0, '#2fbf71');
      grad.addColorStop(0.75, '#2fbf71');
      grad.addColorStop(0.88, '#e8d44d');
      grad.addColorStop(1, '#e5484d');
      ctx.fillStyle = grad;
      if (Number.isFinite(peaks[ch])) ctx.fillRect(x, top, barW, hh - 6 - top);
      if (Number.isFinite(holds[ch].v)) {
        ctx.fillStyle = holds[ch].v > -0.5 ? '#e5484d' : '#ddd';
        ctx.fillRect(x, y(holds[ch].v, hh) - 1, barW, 2);
      }
    }
    ctx.fillStyle = '#9aa1ad';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (const t of ticks) ctx.fillText(String(t), x0 - 2, y(t, hh) + 3);
  }
  wake();
  playback.on('state', wake);
  canvas.addEventListener('click', wake);
  window.addEventListener('resize', wake);
}

// ---------------------------------------------------------------- tools

export const TOOLS = [
  ['select', '선택 도구 (V)'],
  ['track', '앞으로 트랙 선택 도구 (A)'],
  ['trackBack', '뒤로 트랙 선택 도구 (Shift+A)'],
  ['ripple', '잔물결 편집 도구 (B)'],
  ['rolling', '롤링 편집 도구 (N)'],
  ['rate', '속도 조정 도구 (R)'],
  ['razor', '자르기 도구 (C)'],
  ['slip', '밀어넣기 도구 (Y)'],
  ['slide', '밀기 도구 (U)'],
  ['pen', '펜 도구 (P)'],
  ['hand', '손 도구 (H)'],
  ['zoom', '확대/축소 도구 (Z)'],
  ['type', '문자 도구 (T)'],
];

const TOOL_ICON = { select: 'select', track: 'track', trackBack: 'trackSelectBack', ripple: 'ripple', rolling: 'rolling', rate: 'rateStretch', razor: 'razor', slip: 'slip', slide: 'slide', pen: 'pen', hand: 'hand', zoom: 'zoom', type: 'type' };

/** Premiere's tool groups: one button per group; click and hold (or right-click) lists the others. */
const TOOL_GROUPS = [['select'], ['track', 'trackBack'], ['ripple', 'rolling', 'rate'], ['razor'], ['slip', 'slide'], ['pen'], ['hand', 'zoom'], ['type']];

export function createTools(el) {
  const known = new Map(TOOLS.map(([id, title]) => [id, title]));
  const groups = TOOL_GROUPS.map((g) => g.filter((id) => known.has(id))).filter((g) => g.length);
  // tools another module added to TOOLS get a button of their own
  for (const [id] of TOOLS) if (!groups.some((g) => g.includes(id))) groups.push([id]);
  const current = groups.map((g) => g[0]);
  const buttons = groups.map((g, gi) => {
    const b = h(`button${g.length > 1 ? '.grp' : ''}`, { 'aria-label': known.get(g[0]) });
    b.dataset.group = String(gi);
    const paint = () => {
      const id = current[gi];
      const title = known.get(id) || id;
      b.replaceChildren(icon(TOOL_ICON[id] || id, 18));
      b.title = g.length > 1 ? `${title} — 길게 누르거나 오른쪽 클릭: ${g.map((x) => known.get(x)?.replace(/ \(.*\)$/, '')).join(' · ')}` : title;
      b.setAttribute('aria-label', title);
    };
    const flyout = () => {
      const r = b.getBoundingClientRect();
      showMenu(g.map((id) => {
        const m = String(known.get(id) || id).match(/^(.*?)\s*\(([^()]+)\)\s*$/);
        return { label: m ? m[1] : id, key: m ? m[2] : '', checked: store.ui.tool === id, action: () => store.setTool(id) };
      }), r.right + 4, r.top);
    };
    let holdTimer = 0;
    let held = false;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || g.length < 2) return;
      held = false;
      holdTimer = setTimeout(() => {
        held = true;
        flyout();
      }, 450);
    });
    const cancelHold = () => clearTimeout(holdTimer);
    b.addEventListener('pointerup', cancelHold);
    b.addEventListener('pointerleave', cancelHold);
    b.addEventListener('click', () => {
      if (held) return;
      store.setTool(current[gi]);
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (g.length > 1) flyout();
    });
    b.paint = paint;
    paint();
    el.append(b);
    return b;
  });
  const refresh = () => {
    const tool = store.ui.tool;
    groups.forEach((g, gi) => {
      if (g.includes(tool) && current[gi] !== tool) {
        current[gi] = tool;
        buttons[gi].paint();
      }
      const on = g.includes(tool);
      buttons[gi].classList.toggle('active', on);
      buttons[gi].setAttribute('aria-pressed', String(on));
    });
  };
  store.on('tool', refresh);
  refresh();
}
