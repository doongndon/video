// Effect Controls panel: every effect on the selected clip with scrubbable values, stopwatch
// keyframing, keyframe lanes, colour curves / wheels, mask points, stabilization analysis,
// speed-ramp shortcuts and effect presets. Also edits the selected transition.

import { store } from '../store.js';
import * as edit from '../edit.js';
import { EFFECTS, TRANSITIONS, TRANSITION_DIRECTIONS, DYNAMIC_OPTIONS, effectFitsClip } from '../effects.js';
import { evalParam, isAnimated, toggleAnimation, toggleKeyframeAt, clipEnd, sourceOut, EFFECT_FIXED_TYPES, keyframeDefaults } from '../model.js';
import { EASE_FAMILIES, EASE_VARIANTS, easeName, easePath, isEaseId } from '../easing.js';
import { h, clamp, formatTimecode, parseTimecode } from '../util.js';
import { scrubNumber, showMenu, showPanel, fitCanvasToBox, promptDialog, toast, loadPref, savePref } from './common.js';
import { icon, iconButton } from './icons.js';
import { curveTable } from '../compositor.js';
import { analyzeMotion, mediaStatus } from '../media.js';
import { savePreset } from './presets.js';
import { openFontPicker } from './font-picker.js';
import { fontLabel, loadFontFor } from '../fonts.js';

/** Stabilization analyses in progress, keyed by clip id (survive panel rebuilds). */
const analyses = new Map();
/** Curve channel shown per effect id. */
const curveChannel = new Map();

const MASK_TYPES = new Set(['mask', 'censor']);

/** Parameters that only make sense for some settings of their effect. */
function paramVisible(type, key, v) {
  if (type === 'mask') {
    if (key === 'points') return v.shape === 'polygon';
    if (['cx', 'cy', 'w', 'h', 'rotation'].includes(key)) return v.shape !== 'polygon';
  }
  if (type === 'text' && ['bgColor', 'bgOpacity', 'bgPadding'].includes(key)) return !!v.background;
  if (type === 'shape') {
    if (['fill2', 'gradAngle'].includes(key)) return !!v.gradient && v.fillOn !== false;
    if (key === 'gradient' || key === 'fill') return v.fillOn !== false;
    if (key === 'radius') return v.shape === 'rectangle';
  }
  return true;
}

export function createEffectControls() {
  const savedEase = loadPref('kfDefaultEase', 'linear');
  if (isEaseId(savedEase)) keyframeDefaults.ease = savedEase;
  const body = h('div');
  const scroller = h('div.ec');
  body.append(scroller);
  const collapsed = new Set();
  let sig = '';
  let updaters = [];
  let textArea = null;

  const fd = () => 1 / store.seq.fps;
  const currentClip = () => {
    const sel = store.selectedClips();
    if (sel.length !== 1) {
      // linked pair: prefer the video clip
      if (sel.length === 2 && sel[0].linkId && sel[0].linkId === sel[1].linkId) return sel.find((c) => c.kind !== 'audio');
      return null;
    }
    return sel[0];
  };

  function signature() {
    const tr = store.selection.transition;
    if (tr) {
      const t = store.seq.clips[tr.clipId]?.[tr.edge === 'in' ? 'transIn' : 'transOut'];
      return `tr:${tr.clipId}:${tr.edge}:${t?.type}:${t?.direction}`;
    }
    const c = currentClip();
    if (!c) return `none:${store.selection.clips.size}`;
    const ctx = `${store.project.mediaOrder.length}:${store.seq.tracks.length}:${c.stab ? c.stab.x.length : 0}:${analyses.has(c.id)}`;
    return `clip:${c.id}:${c.kind}:${c.name}:${ctx}:${c.effects.map((fx) => `${fx.id}.${fx.enabled}.${collapsed.has(fx.id)}.${Object.entries(fx.params).map(([k, p]) => `${k}${isAnimated(p) ? p.kf.length : 0}`).join(',')}`).join('|')}`;
  }

  function rebuild() {
    sig = signature();
    updaters = [];
    textArea = null;
    scroller.replaceChildren();
    const tr = store.selection.transition;
    if (tr) return buildTransition(tr);
    const c = currentClip();
    if (!c) {
      scroller.append(h('div.empty-hint', store.selection.clips.size > 1
        ? '클립이 여러 개 선택되어 있습니다.\n효과를 편집하려면 클립 하나만 선택하세요.'
        : '타임라인에서 클립을 선택하면 모션·불투명도·볼륨과\n적용한 효과를 여기서 바꿀 수 있습니다.\n\n효과 패널의 효과를 클립 위로 끌어다 놓으세요.'));
      return;
    }
    const tc = (t) => formatTimecode(t, store.seq.fps);
    const addBtn = iconButton('plus', '효과 추가', (e) => openAddMenu(c, e), { label: '효과 추가', cls: 'boxed' });
    const head = h('div.ec-head',
      c.label ? h('span.label-dot', { style: { background: c.label } }) : null,
      h('span.title', { title: c.name }, c.name || c.kind),
      h('span.sub', `${tc(c.start)} ~ ${tc(clipEnd(c))}`),
      addBtn);
    scroller.append(head);
    const fixed = c.effects.filter((fx) => EFFECT_FIXED_TYPES.has(fx.type));
    const added = c.effects.filter((fx) => !EFFECT_FIXED_TYPES.has(fx.type));
    scroller.append(h('div.ec-group', '기본 효과'));
    for (const fx of fixed) scroller.append(buildEffect(c, fx));
    scroller.append(h('div.ec-group', added.length ? `추가한 효과 (위에서 아래 순서로 적용)` : '추가한 효과 없음 — 위의 "효과 추가" 또는 효과 패널에서 끌어다 놓기'));
    for (const fx of added) scroller.append(buildEffect(c, fx));
    // default mask target: the last mask-like effect on the clip
    const masks = c.effects.filter((fx) => MASK_TYPES.has(fx.type));
    if (masks.length && !masks.some((fx) => fx.id === store.ui.maskFxId)) setMaskTarget(masks[masks.length - 1].id);
    update();
  }

  function setMaskTarget(fxId) {
    if (store.ui.maskFxId === fxId) return;
    store.ui.maskFxId = fxId;
    store.emit('mask-target');
  }

  function openAddMenu(c, e) {
    const groups = new Map();
    for (const [type, def] of Object.entries(EFFECTS)) {
      if (def.fixed || !effectFitsClip(type, c.kind)) continue;
      if (!groups.has(def.category)) groups.set(def.category, []);
      groups.get(def.category).push({ label: def.name, action: () => edit.addEffect([c.id], type) });
    }
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([...groups].map(([cat, items]) => ({ label: cat, submenu: items })), r.left, r.bottom + 2);
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

  function buildEffect(c, fx) {
    const def = EFFECTS[fx.type];
    if (!def) return h('div');
    const sec = h(`div.ec-section${collapsed.has(fx.id) ? '.collapsed' : ''}`);
    const toggle = h(`button.fx-toggle${fx.enabled ? '.on' : ''}`, { title: fx.enabled ? '효과 끄기' : '효과 켜기', 'aria-pressed': String(fx.enabled) }, 'fx');
    toggle.addEventListener('click', () => mutate(fx.enabled ? '효과 끄기' : '효과 켜기', c, fx, (f) => { f.enabled = !f.enabled; }));
    const twisty = h('span.twisty', { title: '접기/펴기' }, collapsed.has(fx.id) ? '▸' : '▾');
    const name = h('span.fxname', def.name);
    const flip = () => {
      if (collapsed.has(fx.id)) collapsed.delete(fx.id);
      else collapsed.add(fx.id);
      rebuild();
    };
    twisty.addEventListener('click', flip);
    name.addEventListener('click', flip);
    const tools = [iconButton('reset', '값 초기화', () => edit.resetEffect(c.id, fx.id))];
    if (MASK_TYPES.has(fx.type)) {
      const pen = iconButton('pen', '프로그램 모니터에서 이 영역 편집', () => {
        setMaskTarget(fx.id);
        showPanel('program');
      });
      pen.classList.toggle('on', store.ui.maskFxId === fx.id);
      updaters.push(() => pen.classList.toggle('on', store.ui.maskFxId === fx.id));
      tools.unshift(pen);
    }
    if (!def.fixed) {
      tools.push(iconButton('up', '위로 (먼저 적용)', () => edit.moveEffect(c.id, fx.id, -1)));
      tools.push(iconButton('down', '아래로 (나중에 적용)', () => edit.moveEffect(c.id, fx.id, 1)));
      tools.push(iconButton('close', '효과 제거', () => edit.removeEffect(c.id, fx.id)));
    }
    const head = h('div.ec-sec-head', twisty, toggle, name, ...tools);
    const menu = (e) => {
      e.preventDefault();
      showMenu([
        { label: '값 초기화', action: () => edit.resetEffect(c.id, fx.id) },
        { label: fx.enabled ? '효과 끄기' : '효과 켜기', action: () => toggle.click() },
        { label: '프리셋으로 저장…', action: async () => {
          const n = await promptDialog('효과 프리셋 저장', '프리셋 이름', `${def.name} 프리셋`);
          const f = findFx(c.id, fx.id);
          if (n && f) {
            savePreset(n, f);
            toast(`"${n}" 프리셋을 저장했습니다 (효과 패널 ▸ 사용자 프리셋)`);
          }
        } },
        '-',
        { label: '효과 제거', disabled: def.fixed, action: () => edit.removeEffect(c.id, fx.id) },
      ], e.clientX, e.clientY);
    };
    head.addEventListener('contextmenu', menu);
    if (MASK_TYPES.has(fx.type)) sec.addEventListener('pointerdown', () => setMaskTarget(fx.id));
    const params = h('div.ec-params');
    for (const pdef of def.params) params.append(...buildParam(c, fx, pdef));
    if (fx.type === 'timeRemap') params.append(buildRampTools(c, fx));
    if (!def.params.length) params.append(h('div.ec-param', h('span'), h('span.label', '조절할 값이 없는 효과입니다')));
    sec.append(head, params);
    return sec;
  }

  function findFx(clipId, fxId) {
    return store.seq.clips[clipId]?.effects.find((e) => e.id === fxId);
  }

  function tLocal(clipId) {
    const c = store.seq.clips[clipId];
    return c ? clamp(store.ui.playhead - c.start, 0, c.duration) : 0;
  }

  function currentValues(clipId, fxId) {
    const f = findFx(clipId, fxId);
    if (!f) return {};
    const t = tLocal(clipId);
    return Object.fromEntries(Object.entries(f.params).map(([k, p]) => [k, evalParam(p, t)]));
  }

  function selectOptions(pdef, c) {
    if (typeof pdef.options !== 'string') return pdef.options;
    const fn = DYNAMIC_OPTIONS[pdef.options];
    let opts = fn ? fn(store.project, store.seq) : [];
    if (pdef.options === 'videoTracks') opts = [['', '(트랙 고르기)'], ...opts.filter(([id]) => id !== c.trackId)];
    return opts;
  }

  function buildParam(c, fx, pdef) {
    const key = pdef.key;
    const param = fx.params[key];
    if (!param) return [];
    const rows = [];
    const label = h('span.label', { title: pdef.hint ? `${pdef.label} — ${pdef.hint}` : pdef.label }, pdef.label);
    let control;
    let stopwatch = h('span');
    let kfnav = h('span');

    switch (pdef.type) {
      case 'number': {
        const scr = scrubNumber({
          value: evalParam(param, tLocal(c.id)),
          step: pdef.step ?? 1,
          min: pdef.min,
          max: pdef.max,
          unit: pdef.unit,
          decimals: pdef.step && pdef.step < 1 ? 2 : 1,
          onStart: () => store.begin(`${pdef.label} 변경`),
          onChange: (v) => {
            const clip = store.seq.clips[c.id];
            const f = findFx(c.id, fx.id);
            if (!clip || !f) return;
            edit.rawSetParam(clip, f, key, v);
            if (f.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
            store.changed();
          },
          onCommit: () => store.commit(),
        });
        control = scr;
        updaters.push(() => {
          const f = findFx(c.id, fx.id);
          if (f) scr.update(evalParam(f.params[key], tLocal(c.id)));
        });
        if (pdef.animatable) {
          stopwatch = h(`button.stopwatch${isAnimated(param) ? '.on' : ''}`, { title: isAnimated(param) ? '애니메이션 끄기 (키프레임 모두 삭제)' : '애니메이션 켜기 (키프레임 만들기)' }, icon('stopwatch'));
          stopwatch.addEventListener('click', () => mutate('애니메이션 켜기/끄기', c, fx, (f) => toggleAnimation(f.params[key], tLocal(c.id))));
          if (isAnimated(param)) {
            const prev = h('button', { title: '이전 키프레임으로' }, icon('kfPrev'));
            const add = h('button', { title: '키프레임 추가/삭제' }, icon('diamond'));
            const next = h('button', { title: '다음 키프레임으로' }, icon('kfNext'));
            const easeBtn = h('button.ease-btn', { title: '이징: 재생헤드가 있는 구간의 움직임 곡선 고르기' }, icon('ease'));
            prev.addEventListener('click', () => gotoKf(c.id, fx.id, key, -1));
            next.addEventListener('click', () => gotoKf(c.id, fx.id, key, 1));
            easeBtn.addEventListener('click', (e) => {
              const kf = findFx(c.id, fx.id)?.params[key].kf || [];
              const t = tLocal(c.id);
              let i = kf.findIndex((k) => Math.abs(k.t - t) < fd() / 2);
              if (i < 0) i = Math.max(0, kf.filter((k) => k.t < t).length - 1);
              if (i === kf.length - 1 && i > 0 && Math.abs(kf[i].t - t) >= fd() / 2) i -= 1;
              const r = e.currentTarget.getBoundingClientRect();
              keyframeMenu(c, fx, key, i, r.left, r.bottom + 2);
            });
            add.addEventListener('click', () => mutate('키프레임', c, fx, (f) => toggleKeyframeAt(f.params[key], tLocal(c.id), fd())));
            kfnav = h('span.kfnav', prev, add, next, easeBtn);
            updaters.push(() => {
              const f = findFx(c.id, fx.id);
              const t = tLocal(c.id);
              add.classList.toggle('on', !!f?.params[key].kf?.some((k) => Math.abs(k.t - t) < fd() / 2));
            });
          }
        }
        break;
      }
      case 'font': {
        const btn = h('button.font-btn', { title: '글꼴 고르기 — 목록에서 미리 보고 고를 수 있습니다' });
        const paint = () => {
          const fam = findFx(c.id, fx.id)?.params[key].value || '';
          btn.replaceChildren(h('span.fname', { style: { fontFamily: `"${fam}", "Noto Sans KR", sans-serif` } }, fontLabel(fam)), h('span.caret', '▾'));
          loadFontFor(fam, fontLabel(fam)).catch(() => {});
        };
        paint();
        updaters.push(paint);
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
        control = btn;
        break;
      }
      case 'select': {
        const opts = selectOptions(pdef, c);
        control = h('select', opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(param.value) }, l)));
        if (!opts.some(([v]) => String(v) === String(param.value))) {
          control.prepend(h('option', { value: param.value, selected: true }, '(없음 — 다시 고르세요)'));
        }
        control.addEventListener('change', () => mutate(`${pdef.label} 변경`, c, fx, (f) => { f.params[key].value = control.value; }));
        break;
      }
      case 'color': {
        control = h('input', { type: 'color', value: param.value });
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
        break;
      }
      case 'bool': {
        control = h('input', { type: 'checkbox', checked: !!param.value, 'aria-label': pdef.label });
        control.addEventListener('change', () => mutate(`${pdef.label} 변경`, c, fx, (f) => { f.params[key].value = control.checked; }));
        break;
      }
      case 'text': {
        control = h('textarea', { rows: 3, 'aria-label': pdef.label }, param.value);
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
        control.addEventListener('keydown', (e) => e.stopPropagation());
        rows.push(h('div.ec-wide', label, control));
        return rows;
      }
      case 'curves':
        rows.push(h('div.ec-wide', label, buildCurves(c, fx, key)));
        return rows;
      case 'wheel':
        rows.push(h('div.ec-wide', label, buildWheel(c, fx, key)));
        return rows;
      case 'points': {
        const row = h('div.ec-wide', label, buildPoints(c, fx, key));
        updaters.push(() => { row.hidden = !paramVisible(fx.type, key, currentValues(c.id, fx.id)); });
        rows.push(row);
        return rows;
      }
      case 'action':
        rows.push(h('div.ec-wide', label, buildAction(c, fx, pdef)));
        return rows;
      default:
        return rows;
    }
    const row = h('div.ec-param', stopwatch, label, h('span', control), kfnav);
    rows.push(row);
    let lane = null;
    if (isAnimated(param)) {
      lane = buildLane(c, fx, key);
      rows.push(lane);
    }
    updaters.push(() => {
      const vis = paramVisible(fx.type, key, currentValues(c.id, fx.id));
      row.hidden = !vis;
      if (lane) lane.hidden = !vis;
    });
    return rows;
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
        const arr = value[ch];
        i = arr.findIndex(([px]) => px > x);
        if (i <= 0) i = arr.length - 1;
        arr.splice(i, 0, [x, y]);
        store.changed();
      }
      canvas.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const ff = findFx(c.id, fx.id);
        const arr = ff?.params[key].value[ch];
        if (!arr?.[i]) return;
        const [nx, ny] = toUnit(ev);
        const lo = i > 0 ? arr[i - 1][0] + 0.01 : 0;
        const hi = i < arr.length - 1 ? arr[i + 1][0] - 0.01 : 1;
        arr[i] = [Math.round(clamp(nx, lo, hi) * 1000) / 1000, Math.round(ny * 1000) / 1000];
        store.changed();
      };
      const up = () => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        store.commit();
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
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
      const px = cx + v.x * R;
      const py = cy - v.y * R;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
      const amt = Math.round(Math.min(1, Math.hypot(v.x, v.y)) * 100);
      const hue = Math.round(((Math.atan2(v.y, v.x) * 180) / Math.PI + 360) % 360);
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
      if (f) f.params[key].value = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
      store.changed();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      store.begin('색상 휠 조정');
      setFrom(e);
      const up = () => {
        canvas.removeEventListener('pointermove', setFrom);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        store.commit();
      };
      canvas.addEventListener('pointermove', setFrom);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    });
    canvas.addEventListener('dblclick', () => mutate('색상 휠 초기화', c, fx, (f) => { f.params[key].value = { x: 0, y: 0 }; }));
    updaters.push(draw);
    requestAnimationFrame(draw);
    return h('div.wheel-wrap', canvas, val);
  }

  // ---- polygon mask points
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

  // ---- stabilization analysis
  function buildAction(c, fx, pdef) {
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
      const pts = [[t - 0.5, base, 'ease'], [t, low, 'linear'], [t + 1, low, 'ease'], [t + 1.5, base, 'linear']]
        .map(([tt, v, ease]) => ({ t: Math.round(clamp(tt, 0, D) * store.seq.fps) / store.seq.fps, v, ease }));
      const kf = [];
      for (const k of pts) if (!kf.length || k.t - kf[kf.length - 1].t > 1e-6) kf.push(k);
      p.kf = kf;
      p.value = base;
    });
    return h('div.ec-wide',
      h('span.label', '속도 램프 빠른 설정 (재생헤드 위치 기준)'),
      h('div.ec-action',
        h('button', { onclick: () => ramp('슬로모션 구간', 30) }, '슬로모션 구간 넣기'),
        h('button', { onclick: () => ramp('빨리 감기 구간', 300) }, '빨리 감기 구간 넣기'),
        h('button', { onclick: () => mutate('속도 램프 지우기', c, fx, (f) => { f.params.speed.kf = null; f.params.speed.value = 100; }) }, '램프 지우기')),
      h('div.note', '키프레임 사이에서 속도가 바뀝니다. 클립 길이는 그대로이며, 영상이 원본 끝에 닿으면 마지막 프레임에서 멈춥니다. 연결된 오디오에도 같은 램프가 적용됩니다.'));
  }

  function gotoKf(clipId, fxId, key, dir) {
    const c = store.seq.clips[clipId];
    const f = findFx(clipId, fxId);
    if (!c || !f?.params[key].kf) return;
    const t = store.ui.playhead - c.start;
    const list = f.params[key].kf.map((k) => k.t);
    const target = dir < 0 ? list.filter((x) => x < t - fd() / 2).pop() : list.find((x) => x > t + fd() / 2);
    if (target != null) store.setPlayhead(c.start + target);
  }

  /** Menu items to pick an easing; `current` marks the active one (null = mixed). */
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

  /** Set the easing of keyframes: which = index, 'param' (every keyframe of this value) or 'clip'. */
  function applyEase(c, fx, key, which, ease) {
    const label = `이징: ${easeName(ease)}`;
    if (which === 'clip') {
      store.transact(label, () => {
        const clip = store.seq.clips[c.id];
        if (!clip) return;
        for (const f of clip.effects) {
          for (const p of Object.values(f.params)) {
            if (p.kf?.length && typeof p.kf[0].v === 'number') for (const k of p.kf) k.ease = ease;
          }
        }
        edit.rawSyncLinkedRemap(c.id);
      });
      return;
    }
    mutate(label, c, fx, (f) => {
      const kf = f.params[key].kf;
      if (!kf) return;
      if (which === 'param') for (const k of kf) k.ease = ease;
      else if (kf[which]) kf[which].ease = ease;
    });
  }

  function setDefaultEase(ease) {
    keyframeDefaults.ease = ease;
    savePref('kfDefaultEase', ease);
    toast(`새로 만드는 키프레임은 "${easeName(ease)}" 이징으로 시작합니다`);
  }

  function keyframeMenu(c, fx, key, i, x, y) {
    const f = findFx(c.id, fx.id);
    const kf = f?.params[key].kf;
    const k = kf?.[i];
    if (!k) return;
    const last = i === kf.length - 1;
    showMenu([
      { group: last ? '마지막 키프레임 — 다음 키프레임이 없어 이징이 쓰이지 않습니다' : `이 키프레임 → 다음 키프레임: ${easeName(k.ease)}` },
      ...easeMenu(k.ease || 'linear', (e) => applyEase(c, fx, key, i, e)).slice(1),
      '-',
      { label: '이 값의 모든 키프레임에 적용', submenu: () => easeMenu(null, (e) => applyEase(c, fx, key, 'param', e)) },
      { label: '이 클립의 모든 키프레임에 적용', submenu: () => easeMenu(null, (e) => applyEase(c, fx, key, 'clip', e)) },
      { label: `새 키프레임 기본 이징 (지금: ${easeName(keyframeDefaults.ease)})`, submenu: () => easeMenu(keyframeDefaults.ease, setDefaultEase) },
      '-',
      { label: '키프레임 삭제', action: () => mutate('키프레임 삭제', c, fx, (f2) => {
        const p = f2.params[key];
        if (!p?.kf) return;
        const removed = p.kf.splice(i, 1)[0];
        if (!p.kf.length) {
          p.kf = null;
          if (removed) p.value = removed.v;
        }
      }) },
    ], x, y);
  }

  function buildLane(c, fx, key) {
    const lane = h('div.ec-kf-lane', { title: '키프레임 — 클릭: 재생헤드 이동 · 마름모 끌기: 시간 변경 · 마름모 오른쪽 클릭: 이징 선택' });
    const graph = h('canvas.kf-graph');
    const ph = h('div.ph');
    lane.append(graph, ph);
    const drawGraph = (clip, p) => {
      if (!graph.isConnected) return;
      const { ctx, w, h: hh } = fitCanvasToBox(graph);
      ctx.clearRect(0, 0, w, hh);
      if (!p.kf?.length || typeof p.kf[0].v !== 'number' || w < 4) return;
      const N = Math.min(400, Math.max(40, Math.round(w)));
      const vals = [];
      for (let n = 0; n <= N; n++) vals.push(evalParam(p, (n / N) * clip.duration));
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (hi - lo < 1e-9) {
        lo -= 1;
        hi += 1;
      }
      ctx.strokeStyle = 'rgba(108,182,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      vals.forEach((v, n) => {
        const x = (n / N) * w;
        const y = hh - 3 - ((v - lo) / (hi - lo)) * (hh - 6);
        if (n) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    };
    const draw = () => {
      const clip = store.seq.clips[c.id];
      const f = findFx(c.id, fx.id);
      if (!clip || !f) return;
      lane.querySelectorAll('.kf').forEach((x) => x.remove());
      const kfs = f.params[key].kf || [];
      kfs.forEach((k, i) => {
        const ease = k.ease || 'linear';
        const shape = ease === 'linear' ? '.linear' : ease === 'hold' ? '.hold' : '.eased';
        const d = h(`div.kf${shape}${Math.abs(k.t - (store.ui.playhead - clip.start)) < fd() / 2 ? '.sel' : ''}`, {
          title: `${easeName(ease)} — 오른쪽 클릭: 이징 바꾸기`,
          style: { left: `${(clamp(k.t, 0, clip.duration) / clip.duration) * 100}%` },
        });
        d.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          d.setPointerCapture(e.pointerId);
          const r = lane.getBoundingClientRect();
          store.begin('키프레임 이동');
          const move = (ev) => {
            const cl = store.seq.clips[c.id];
            const ff = findFx(c.id, fx.id);
            if (!cl || !ff?.params[key].kf) return;
            const t = clamp(((ev.clientX - r.left) / r.width) * cl.duration, 0, cl.duration);
            const kk = ff.params[key].kf[i];
            if (!kk) return;
            kk.t = Math.round(t * store.seq.fps) / store.seq.fps;
            if (ff.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
            store.setPlayhead(cl.start + kk.t);
            store.changed();
          };
          const up = () => {
            d.removeEventListener('pointermove', move);
            d.removeEventListener('pointerup', up);
            const ff = findFx(c.id, fx.id);
            if (ff?.params[key].kf) ff.params[key].kf.sort((a, b) => a.t - b.t);
            if (ff?.type === 'timeRemap') edit.rawSyncLinkedRemap(c.id);
            store.commit();
          };
          d.addEventListener('pointermove', move);
          d.addEventListener('pointerup', up);
        });
        d.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          keyframeMenu(c, fx, key, i, e.clientX, e.clientY);
        });
        lane.append(d);
      });
      drawGraph(clip, f.params[key]);
      const tl = (store.ui.playhead - clip.start) / clip.duration;
      ph.style.display = tl >= 0 && tl <= 1 ? 'block' : 'none';
      ph.style.left = `${tl * 100}%`;
    };
    lane.addEventListener('pointerdown', (e) => {
      const clip = store.seq.clips[c.id];
      if (!clip) return;
      const r = lane.getBoundingClientRect();
      store.setPlayhead(clip.start + clamp((e.clientX - r.left) / r.width, 0, 1) * clip.duration);
    });
    updaters.push(draw);
    draw();
    requestAnimationFrame(draw);
    return lane;
  }


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

  function update() {
    for (const u of updaters) u();
  }

  function onChange() {
    if (signature() !== sig) rebuild();
    else update();
  }

  store.on('selection', rebuild);
  store.on('change', onChange);
  store.on('playhead', update);
  store.on('mask-target', update);
  window.addEventListener('montage:uiscale', () => requestAnimationFrame(update));
  store.on('reveal-effect-controls', (opts) => {
    showPanel('effectControls');
    rebuild();
    if (opts?.focusText && textArea) {
      textArea.focus();
      textArea.select();
    }
  });
  rebuild();
  return body;
}

