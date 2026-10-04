// Effect Controls panel: every effect on the selected clip with scrubbable values, stopwatch
// keyframing, keyframe navigation and per-parameter keyframe lanes. Also edits transitions.

import { store } from '../store.js';
import * as edit from '../edit.js';
import { EFFECTS, TRANSITIONS } from '../effects.js';
import { evalParam, isAnimated, toggleAnimation, toggleKeyframeAt, clipEnd } from '../model.js';
import { h, clamp, formatTimecode, parseTimecode } from '../util.js';
import { scrubNumber, showMenu, showPanel } from './common.js';

export function createEffectControls() {
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
    if (tr) return `tr:${tr.clipId}:${tr.edge}:${store.seq.clips[tr.clipId]?.[tr.edge === 'in' ? 'transIn' : 'transOut']?.type}`;
    const c = currentClip();
    if (!c) return `none:${store.selection.clips.size}`;
    return `clip:${c.id}:${c.kind}:${c.effects.map((fx) => `${fx.id}.${fx.enabled}.${collapsed.has(fx.id)}.${Object.entries(fx.params).map(([k, p]) => `${k}${isAnimated(p) ? p.kf.length : 0}`).join(',')}`).join('|')}`;
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
      scroller.append(h('div.empty-hint', store.selection.clips.size > 1 ? 'Multiple clips selected.\nSelect a single clip to edit its effects.' : 'Select a clip in the timeline to edit Motion, Opacity, Volume and applied effects.\nDrag effects from the Effects panel onto clips.'));
      return;
    }
    const tc = (t) => formatTimecode(t, store.seq.fps);
    const head = h('div.ec-head',
      h('span.title', `${c.name || c.kind}`),
      h('span', { style: { color: 'var(--text-faint)' } }, `${tc(c.start)} – ${tc(clipEnd(c))}`));
    scroller.append(head);
    for (const fx of c.effects) scroller.append(buildEffect(c, fx));
    update();
  }

  function buildEffect(c, fx) {
    const def = EFFECTS[fx.type];
    if (!def) return h('div');
    const sec = h(`div.ec-section${collapsed.has(fx.id) ? '.collapsed' : ''}`);
    const toggle = h(`button.fx-toggle${fx.enabled ? '.on' : ''}`, { title: 'Toggle effect on/off' }, 'fx');
    toggle.addEventListener('click', () => store.transact('Toggle Effect', () => {
      const f = findFx(c.id, fx.id);
      if (f) f.enabled = !f.enabled;
    }));
    const twisty = h('span.twisty', collapsed.has(fx.id) ? '▸' : '▾');
    const name = h('span.fxname', def.name);
    const flip = () => {
      if (collapsed.has(fx.id)) collapsed.delete(fx.id);
      else collapsed.add(fx.id);
      rebuild();
    };
    twisty.addEventListener('click', flip);
    name.addEventListener('click', flip);
    const reset = h('button.icon', { title: 'Reset Parameters', onclick: () => edit.resetEffect(c.id, fx.id) }, '↺');
    const tools = [reset];
    if (!def.fixed) {
      tools.push(h('button.icon', { title: 'Move Up', onclick: () => edit.moveEffect(c.id, fx.id, -1) }, '▲'));
      tools.push(h('button.icon', { title: 'Move Down', onclick: () => edit.moveEffect(c.id, fx.id, 1) }, '▼'));
      tools.push(h('button.icon', { title: 'Remove Effect', onclick: () => edit.removeEffect(c.id, fx.id) }, '✕'));
    }
    const head = h('div.ec-sec-head', twisty, toggle, name, ...tools);
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([
        { label: 'Reset', action: () => edit.resetEffect(c.id, fx.id) },
        { label: fx.enabled ? 'Disable' : 'Enable', action: () => toggle.click() },
        { label: 'Remove', disabled: def.fixed, action: () => edit.removeEffect(c.id, fx.id) },
      ], e.clientX, e.clientY);
    });
    const params = h('div.ec-params');
    for (const pdef of def.params) params.append(...buildParam(c, fx, pdef));
    if (!def.params.length) params.append(h('div.ec-param', h('span'), h('span.label', 'No parameters')));
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

  function buildParam(c, fx, pdef) {
    const key = pdef.key;
    const param = fx.params[key];
    const rows = [];
    const label = h('span.label', { title: pdef.hint || pdef.label }, pdef.label);
    let control;
    let stopwatch = h('span');
    let kfnav = h('span');

    if (pdef.type === 'number') {
      const scr = scrubNumber({
        value: evalParam(param, tLocal(c.id)),
        step: pdef.step ?? 1,
        min: pdef.min,
        max: pdef.max,
        unit: pdef.unit,
        decimals: pdef.step && pdef.step < 1 ? 2 : 1,
        onStart: () => store.begin(`Change ${pdef.label}`),
        onChange: (v) => {
          const clip = store.seq.clips[c.id];
          const f = findFx(c.id, fx.id);
          if (!clip || !f) return;
          edit.rawSetParam(clip, f, key, v);
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
        stopwatch = h(`button.stopwatch${isAnimated(param) ? '.on' : ''}`, { title: 'Toggle animation' }, '⏱');
        stopwatch.addEventListener('click', () => store.transact('Toggle Animation', () => {
          const f = findFx(c.id, fx.id);
          if (f) toggleAnimation(f.params[key], tLocal(c.id));
        }));
        if (isAnimated(param)) {
          const prev = h('button', { title: 'Go to Previous Keyframe' }, '◀');
          const add = h('button', { title: 'Add/Remove Keyframe' }, '◆');
          const next = h('button', { title: 'Go to Next Keyframe' }, '▶');
          prev.addEventListener('click', () => gotoKf(c.id, fx.id, key, -1));
          next.addEventListener('click', () => gotoKf(c.id, fx.id, key, 1));
          add.addEventListener('click', () => store.transact('Keyframe', () => {
            const f = findFx(c.id, fx.id);
            if (f) toggleKeyframeAt(f.params[key], tLocal(c.id), fd());
          }));
          kfnav = h('span.kfnav', prev, add, next);
          updaters.push(() => {
            const f = findFx(c.id, fx.id);
            const t = tLocal(c.id);
            const on = !!f?.params[key].kf?.some((k) => Math.abs(k.t - t) < fd() / 2);
            add.classList.toggle('on', on);
          });
        }
      }
    } else if (pdef.type === 'select') {
      control = h('select', pdef.options.map(([v, l]) => h('option', { value: v, selected: v === param.value }, l)));
      control.addEventListener('change', () => store.transact(`Change ${pdef.label}`, () => {
        const f = findFx(c.id, fx.id);
        if (f) f.params[key].value = control.value;
      }));
    } else if (pdef.type === 'color') {
      control = h('input', { type: 'color', value: param.value });
      let begun = false;
      control.addEventListener('input', () => {
        if (!begun) {
          store.begin(`Change ${pdef.label}`);
          begun = true;
        }
        const f = findFx(c.id, fx.id);
        if (f) f.params[key].value = control.value;
        store.changed();
      });
      control.addEventListener('change', () => {
        begun = false;
        store.commit();
      });
    } else if (pdef.type === 'bool') {
      control = h('input', { type: 'checkbox', checked: !!param.value });
      control.addEventListener('change', () => store.transact(`Change ${pdef.label}`, () => {
        const f = findFx(c.id, fx.id);
        if (f) f.params[key].value = control.checked;
      }));
    } else if (pdef.type === 'text') {
      control = h('textarea', { rows: 3 }, param.value);
      textArea = control;
      control.addEventListener('focus', () => store.begin('Edit Text'));
      control.addEventListener('input', () => {
        const f = findFx(c.id, fx.id);
        if (f) f.params[key].value = control.value;
        store.changed();
      });
      control.addEventListener('blur', () => store.commit());
      control.addEventListener('keydown', (e) => e.stopPropagation());
      rows.push(h('div.ec-param', { style: { gridTemplateColumns: '20px 1fr' } }, h('span'), h('div', label, control)));
      return rows;
    }
    rows.push(h('div.ec-param', stopwatch, label, h('span', control), kfnav));
    if (isAnimated(param)) rows.push(buildLane(c, fx, key));
    return rows;
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

  function buildLane(c, fx, key) {
    const lane = h('div.ec-kf-lane', { title: 'Keyframes — click to seek, drag diamonds to move, right-click for interpolation' });
    const ph = h('div.ph');
    lane.append(ph);
    const draw = () => {
      const clip = store.seq.clips[c.id];
      const f = findFx(c.id, fx.id);
      if (!clip || !f) return;
      lane.querySelectorAll('.kf').forEach((x) => x.remove());
      const kfs = f.params[key].kf || [];
      kfs.forEach((k, i) => {
        const d = h(`div.kf${Math.abs(k.t - (store.ui.playhead - clip.start)) < fd() / 2 ? '.sel' : ''}`, { style: { left: `${(clamp(k.t, 0, clip.duration) / clip.duration) * 100}%`, borderRadius: k.ease === 'hold' ? '0' : k.ease === 'ease' ? '50%' : '0' } });
        d.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          d.setPointerCapture(e.pointerId);
          const r = lane.getBoundingClientRect();
          store.begin('Move Keyframe');
          const move = (ev) => {
            const cl = store.seq.clips[c.id];
            const ff = findFx(c.id, fx.id);
            if (!cl || !ff?.params[key].kf) return;
            const t = clamp(((ev.clientX - r.left) / r.width) * cl.duration, 0, cl.duration);
            const kk = ff.params[key].kf[i];
            if (!kk) return;
            kk.t = Math.round(t * store.seq.fps) / store.seq.fps;
            store.setPlayhead(cl.start + kk.t);
            store.changed();
          };
          const up = () => {
            d.removeEventListener('pointermove', move);
            d.removeEventListener('pointerup', up);
            const ff = findFx(c.id, fx.id);
            if (ff?.params[key].kf) ff.params[key].kf.sort((a, b) => a.t - b.t);
            store.commit();
          };
          d.addEventListener('pointermove', move);
          d.addEventListener('pointerup', up);
        });
        d.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const setEase = (ease) => store.transact('Keyframe Interpolation', () => {
            const kk = findFx(c.id, fx.id)?.params[key].kf?.[i];
            if (kk) kk.ease = ease;
          });
          showMenu([
            { label: 'Linear', checked: (k.ease || 'linear') === 'linear', action: () => setEase('linear') },
            { label: 'Ease In/Out (Bezier)', checked: k.ease === 'ease', action: () => setEase('ease') },
            { label: 'Hold', checked: k.ease === 'hold', action: () => setEase('hold') },
            '-',
            { label: 'Delete Keyframe', action: () => store.transact('Delete Keyframe', () => {
              const p = findFx(c.id, fx.id)?.params[key];
              if (!p?.kf) return;
              p.kf.splice(i, 1);
              if (!p.kf.length) {
                p.kf = null;
              }
            }) },
          ], e.clientX, e.clientY);
        });
        lane.append(d);
      });
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
    return lane;
  }

  function buildTransition(tr) {
    const c = store.seq.clips[tr.clipId];
    const key = tr.edge === 'in' ? 'transIn' : 'transOut';
    const t = c?.[key];
    if (!t) {
      scroller.append(h('div.empty-hint', 'Transition not found'));
      return;
    }
    const def = TRANSITIONS[t.type];
    const typeSel = h('select', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === def.kind).map(([k, d]) => h('option', { value: k, selected: k === t.type }, d.name)));
    typeSel.addEventListener('change', () => store.transact('Change Transition', () => {
      const cc = store.seq.clips[tr.clipId];
      if (cc?.[key]) cc[key].type = typeSel.value;
    }));
    const durScrub = scrubNumber({
      value: Math.round(t.duration * store.seq.fps),
      step: 1, min: 1, unit: 'frames', decimals: 0,
      onStart: () => store.begin('Transition Duration'),
      onChange: (v) => {
        edit.setTransitionDuration(tr.clipId, tr.edge, v / store.seq.fps);
        store.changed();
      },
      onCommit: () => store.commit(),
    });
    updaters.push(() => {
      const cc = store.seq.clips[tr.clipId];
      if (cc?.[key]) durScrub.update(Math.round(cc[key].duration * store.seq.fps));
    });
    const tcInput = h('input', { type: 'text', value: formatTimecode(t.duration, store.seq.fps), style: { width: '100px' } });
    tcInput.addEventListener('change', () => {
      const d = parseTimecode(tcInput.value, store.seq.fps);
      if (d) store.transact('Transition Duration', () => edit.setTransitionDuration(tr.clipId, tr.edge, d));
    });
    tcInput.addEventListener('keydown', (e) => e.stopPropagation());
    scroller.append(
      h('div.ec-head', h('span.title', `Transition: ${def.name}`)),
      h('div.ec-section', h('div.ec-params',
        h('div.ec-param', h('span'), h('span.label', 'Type'), typeSel, h('span')),
        h('div.ec-param', h('span'), h('span.label', 'Duration'), durScrub, h('span')),
        h('div.ec-param', h('span'), h('span.label', 'Duration (TC)'), tcInput, h('span')),
        h('div.ec-param', h('span'), h('span.label', 'Placement'), h('span', { style: { color: 'var(--text-dim)' } }, tr.edge === 'in' && hasPrev(c) ? 'Centered on cut' : tr.edge === 'in' ? 'Start of clip (fade in)' : 'End of clip (fade out)'), h('span')))),
      h('div', { style: { padding: '8px' } }, h('button', { onclick: () => edit.deleteSelection() }, 'Remove Transition')),
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
