// Modal dialogs: speed/duration, markers, sequence settings, export, shortcuts, captions.

import { store } from '../store.js';
import * as edit from '../edit.js';
import { h, formatTimecode, parseTimecode, formatBytes, downloadBlob, clamp } from '../util.js';
import { openModal, formRow, toast } from './common.js';
import { FORMATS, exportRange, exportSequence, exportFrame } from '../export.js';
import { createSyntheticMedia, detectScenes, mediaStatus } from '../media.js';
import { clipEnd, clipsOnTrack, createClip, createTrack, renameTracks, videoTracks, isTimed } from '../model.js';

// ---------------------------------------------------------------- speed / duration

export function openSpeedDialog(ids) {
  const s = store.seq;
  const clips = ids.map((id) => s.clips[id]).filter(Boolean);
  if (!clips.length) return;
  const c = clips[0];
  const timed = isTimed(c);
  const speed = h('input', { type: 'number', value: Math.round(c.speed * 10000) / 100, min: 1, max: 10000, step: 1, style: { width: '90px' }, disabled: !timed });
  const dur = h('input', { type: 'text', value: formatTimecode(c.duration, s.fps), style: { width: '110px' } });
  const linkBox = h('input', { type: 'checkbox', checked: true, disabled: !timed });
  const reverse = h('input', { type: 'checkbox', checked: !!c.reverse, disabled: !timed });
  const ripple = h('input', { type: 'checkbox' });
  const hold = h('input', { type: 'checkbox', checked: !!c.hold, disabled: c.kind !== 'video' });
  const srcLen = c.duration * c.speed;
  speed.addEventListener('input', () => {
    const v = parseFloat(speed.value) / 100;
    if (linkBox.checked && v > 0) dur.value = formatTimecode(srcLen / v, s.fps);
  });
  dur.addEventListener('change', () => {
    const d = parseTimecode(dur.value, s.fps);
    if (linkBox.checked && d > 0 && timed) speed.value = Math.round((srcLen / d) * 10000) / 100;
  });
  openModal({
    title: 'Clip Speed / Duration',
    body: [
      formRow('Speed (%)', speed, h('label', linkBox, ' link speed & duration')),
      formRow('Duration', dur),
      formRow('', h('label', reverse, ' Reverse Speed')),
      formRow('', h('label', hold, ' Frame Hold (freeze the in-point frame)')),
      formRow('', h('label', ripple, ' Ripple Edit, Shifting Trailing Clips')),
      h('div.note', 'Preview keeps pitch; exported audio is resampled (pitch follows speed). Reversed clips are silent in preview.'),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'OK', primary: true, action: () => {
          const sp = clamp((parseFloat(speed.value) || 100) / 100, 0.01, 100);
          const d = parseTimecode(dur.value, s.fps);
          edit.setSpeed(ids, {
            speed: timed ? sp : undefined,
            duration: !timed || !linkBox.checked ? d : undefined,
            ripple: ripple.checked, hold: hold.checked, reverse: reverse.checked,
          });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- markers

const MARKER_COLORS = ['#4ade80', '#f87171', '#a78bfa', '#fb923c', '#facc15', '#ffffff', '#60a5fa', '#22d3ee'];

export function openMarkerDialog(id) {
  const s = store.seq;
  const mk = s.markers.find((m) => m.id === id);
  if (!mk) return;
  const name = h('input', { type: 'text', value: mk.name, style: { width: '100%' } });
  const time = h('input', { type: 'text', value: formatTimecode(mk.time, s.fps) });
  const comment = h('textarea', { rows: 3, style: { width: '100%' } }, mk.comment || '');
  let color = mk.color;
  const swatches = h('div.inline', MARKER_COLORS.map((c) => {
    const b = h('button', { style: { background: c, width: '22px', height: '18px', outline: c === color ? '2px solid #fff' : 'none' } });
    b.addEventListener('click', () => {
      color = c;
      swatches.querySelectorAll('button').forEach((x) => (x.style.outline = 'none'));
      b.style.outline = '2px solid #fff';
    });
    return b;
  }));
  openModal({
    title: 'Marker',
    body: [formRow('Name', name), formRow('Time', time), formRow('Color', swatches), formRow('Comments', comment)],
    buttons: [
      { label: 'Delete', action: () => edit.removeMarker(id) },
      { label: 'Cancel' },
      {
        label: 'OK', primary: true, action: () => {
          store.transact('Edit Marker', () => {
            const m = store.seq.markers.find((x) => x.id === id);
            if (!m) return;
            m.name = name.value;
            m.comment = comment.value;
            m.color = color;
            const t = parseTimecode(time.value, s.fps);
            if (t != null) m.time = Math.max(0, t);
            store.seq.markers.sort((a, b) => a.time - b.time);
          });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- sequence settings

const PRESETS = [
  ['1920x1080', 'HD 1080p (16:9)'],
  ['1280x720', 'HD 720p (16:9)'],
  ['3840x2160', 'UHD 4K (16:9)'],
  ['2560x1440', 'QHD 1440p (16:9)'],
  ['1080x1920', 'Vertical 1080×1920 (9:16)'],
  ['1080x1080', 'Square 1080 (1:1)'],
  ['1080x1350', 'Portrait 1080×1350 (4:5)'],
  ['720x480', 'SD 720×480'],
  ['custom', 'Custom'],
];
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export function openSequenceSettings() {
  const s = store.seq;
  const name = h('input', { type: 'text', value: s.name, style: { width: '100%' } });
  const preset = h('select', PRESETS.map(([v, l]) => h('option', { value: v }, l)));
  const w = h('input', { type: 'number', value: s.width, min: 16, max: 8192, step: 2, style: { width: '80px' } });
  const hh = h('input', { type: 'number', value: s.height, min: 16, max: 8192, step: 2, style: { width: '80px' } });
  const fps = h('select', RATES.map((r) => h('option', { value: r, selected: Math.abs(r - s.fps) < 0.01 }, `${r} fps`)));
  const cur = `${s.width}x${s.height}`;
  preset.value = PRESETS.some(([v]) => v === cur) ? cur : 'custom';
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') return;
    const [a, b] = preset.value.split('x').map(Number);
    w.value = a;
    hh.value = b;
  });
  openModal({
    title: 'Sequence Settings',
    body: [
      formRow('Name', name),
      formRow('Frame Size', preset),
      formRow('', w, '×', hh),
      formRow('Timebase', fps),
      h('div.note', 'Changing the frame size keeps clip positions proportional. Clips fit the frame by default (Scale 100% = fit).'),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'OK', primary: true, action: () => {
          const W = clamp(Math.round((parseInt(w.value, 10) || 1920) / 2) * 2, 16, 8192);
          const H = clamp(Math.round((parseInt(hh.value, 10) || 1080) / 2) * 2, 16, 8192);
          edit.updateSequenceSettings({ width: W, height: H, fps: parseFloat(fps.value), name: name.value || s.name });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- export

export function openExportDialog() {
  const s = store.seq;
  const fileName = h('input', { type: 'text', value: (s.name || 'Sequence').replace(/[\\/:*?"<>|]+/g, '_'), style: { width: '100%' } });
  const format = h('select', Object.entries(FORMATS).map(([k, f]) => h('option', { value: k }, f.label)));
  const range = h('select', h('option', { value: 'all' }, 'Entire Sequence'), h('option', { value: 'inout', selected: s.inPoint != null || s.outPoint != null }, 'Sequence In/Out'));
  const scale = h('select', [[1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%'], [2, '200% (upscale)']].map(([v, l]) => h('option', { value: v }, l)));
  const quality = h('select', [['very-high', 'Very High'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']].map(([v, l]) => h('option', { value: v, selected: v === 'high' }, l)));
  const audio = h('input', { type: 'checkbox', checked: true });
  const summary = h('div.note');
  const bar = h('div');
  const progress = h('div.progress', bar);
  const status = h('div.note', '');
  const update = () => {
    const r = exportRange(range.value);
    const f = FORMATS[format.value];
    const sc = parseFloat(scale.value);
    summary.textContent = f.still
      ? `Exports the frame at ${formatTimecode(store.ui.playhead, s.fps)} as PNG (${s.width}×${s.height}).`
      : `${f.audioOnly ? 'Audio' : `${Math.round((s.width * sc) / 2) * 2}×${Math.round((s.height * sc) / 2) * 2} @ ${s.fps} fps`} · ${formatTimecode(r.start, s.fps)} – ${formatTimecode(r.end, s.fps)} (${(r.end - r.start).toFixed(2)} s)`;
    scale.disabled = quality.disabled = !!(f.audioOnly || f.still);
    audio.disabled = !!(f.audioOnly || f.still);
    range.disabled = !!f.still;
  };
  for (const el of [format, range, scale, quality]) el.addEventListener('change', update);
  update();
  const token = { cancelled: false };
  let running = false;
  const modal = openModal({
    title: 'Export Media',
    width: '560px',
    body: [
      formRow('File Name', fileName),
      formRow('Format', format),
      formRow('Range', range),
      formRow('Output Size', scale),
      formRow('Quality', quality),
      formRow('', h('label', audio, ' Export Audio')),
      summary,
      progress,
      status,
      h('div.note', 'Rendering is frame-accurate and runs in this tab (WebCodecs). Keep the tab open until it finishes. Chrome or Edge recommended for MP4/H.264.'),
    ],
    buttons: [
      { label: 'Close', action: () => { token.cancelled = true; } },
      {
        label: 'Export', primary: true, action: async () => {
          if (running) return false;
          running = true;
          token.cancelled = false;
          const f = FORMATS[format.value];
          const btn = modal.footer.querySelector('button.primary');
          btn.disabled = true;
          try {
            let result;
            if (f.still) {
              status.textContent = 'Rendering frame…';
              result = { blob: await exportFrame(), info: 'PNG' };
            } else {
              result = await exportSequence({
                format: format.value,
                scale: parseFloat(scale.value),
                quality: quality.value,
                range: exportRange(range.value),
                audio: audio.checked,
                token,
                onProgress: (p, label) => {
                  bar.style.width = `${Math.round(p * 100)}%`;
                  status.textContent = label || '';
                },
              });
            }
            const name = `${fileName.value || 'export'}.${f.ext}`;
            bar.style.width = '100%';
            status.textContent = `Rendered ${name} · ${formatBytes(result.blob.size)} · ${result.info}`;
            if (await downloadBlob(result.blob, name)) {
              status.textContent = `Saved ${name} · ${formatBytes(result.blob.size)} · ${result.info}`;
              toast(`Exported ${name}`);
            }
          } catch (err) {
            console.error(err);
            status.textContent = `Export failed: ${err.message || err}`;
          } finally {
            running = false;
            btn.disabled = false;
          }
          return false;
        },
      },
    ],
    onClose: () => { token.cancelled = true; },
  });
}

// ---------------------------------------------------------------- new items

export function openColorMatteDialog() {
  const color = h('input', { type: 'color', value: '#1e3a8a' });
  const name = h('input', { type: 'text', value: 'Color Matte' });
  openModal({
    title: 'New Color Matte',
    body: [formRow('Color', color), formRow('Name', name)],
    buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, action: () => createSyntheticMedia('color', { name: name.value, color: color.value }) }],
  });
}

// ---------------------------------------------------------------- scene edit detection

export function openSceneDetectDialog() {
  const clip = store.selectedClips().find((c) => c.kind === 'video');
  if (!clip || mediaStatus(clip.mediaId) !== 'ready') {
    toast('Select a video clip first');
    return;
  }
  const sens = h('input', { type: 'range', min: 5, max: 95, value: 60 });
  const mode = h('select', h('option', { value: 'cuts' }, 'Apply a cut at each detected cut point'), h('option', { value: 'markers' }, 'Create a marker at each detected cut point'));
  const bar = h('div');
  const status = h('div.note', 'Samples the clip at 10 fps and compares colour histograms.');
  let running = false;
  openModal({
    title: 'Scene Edit Detection',
    body: [formRow('Mode', mode), formRow('Sensitivity', sens), h('div.progress', bar), status],
    buttons: [
      { label: 'Close' },
      {
        label: 'Analyze', primary: true, action: async () => {
          if (running) return false;
          running = true;
          const c = store.seq.clips[clip.id];
          if (!c) return true;
          const a = c.inPoint;
          const b = c.inPoint + c.duration * c.speed;
          const threshold = 0.6 - (parseInt(sens.value, 10) / 100) * 0.5;
          status.textContent = 'Analyzing…';
          const cuts = await detectScenes(c.mediaId, Math.min(a, b), Math.max(a, b), { threshold, onProgress: (p) => { bar.style.width = `${Math.round(p * 100)}%`; } });
          bar.style.width = '100%';
          const seqTimes = cuts.map((mt) => (c.reverse ? c.start + (b - mt) / c.speed : c.start + (mt - a) / c.speed))
            .map((t) => Math.round(t * store.seq.fps) / store.seq.fps)
            .filter((t) => t > c.start + 1e-3 && t < c.start + c.duration - 1e-3);
          if (mode.value === 'cuts') edit.cutClipAt(c.id, seqTimes);
          else store.transact('Scene Markers', () => { for (const t of seqTimes) store.seq.markers.push({ id: `mk_${Math.random().toString(36).slice(2)}`, time: t, name: 'Scene', color: '#fb923c', comment: '' }); store.seq.markers.sort((x, y) => x.time - y.time); });
          status.textContent = `Found ${seqTimes.length} scene change(s).`;
          running = false;
          return false;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- captions (SRT)

function parseSrtTime(s) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function fmtSrtTime(t) {
  const ms = Math.round(t * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

export function parseSrt(text) {
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map((x) => parseSrtTime(x.trim()));
    if (a == null || b == null || b <= a) continue;
    out.push({ start: a, end: b, text: lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '') });
  }
  return out;
}

export async function importSrt(file) {
  const cues = parseSrt(await file.text());
  if (!cues.length) {
    toast('No captions found in that file');
    return;
  }
  const s = store.seq;
  store.transact('Import Captions', () => {
    const track = createTrack('video', 0);
    const lastVideoIdx = s.tracks.findLastIndex((t) => t.kind === 'video');
    s.tracks.splice(lastVideoIdx + 1, 0, track);
    renameTracks(s);
    for (const cue of cues) {
      const c = createClip(s, { kind: 'text', trackId: track.id, name: 'Caption', start: cue.start, duration: cue.end - cue.start });
      const tx = c.effects.find((e) => e.type === 'text');
      tx.params.content.value = cue.text;
      tx.params.size.value = Math.round(s.height * 0.05);
      tx.params.background.value = true;
      tx.params.bgOpacity.value = 55;
      tx.params.bgPadding.value = Math.round(s.height * 0.012);
      tx.params.bold.value = false;
      const motion = c.effects.find((e) => e.type === 'motion');
      motion.params.posY.value = Math.round(s.height * 0.86);
      s.clips[c.id] = c;
    }
  });
  toast(`Imported ${cues.length} captions onto a new track`);
}

export function exportSrt() {
  const s = store.seq;
  // the video track with the most text clips
  let best = null;
  for (const t of videoTracks(s)) {
    const n = clipsOnTrack(s, t.id).filter((c) => c.kind === 'text').length;
    if (n && (!best || n > best.n)) best = { t, n };
  }
  if (!best) {
    toast('No text clips to export as captions');
    return;
  }
  const clips = clipsOnTrack(s, best.t.id).filter((c) => c.kind === 'text');
  const body = clips.map((c, i) => {
    const text = c.effects.find((e) => e.type === 'text').params.content.value;
    return `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(clipEnd(c))}\n${text}\n`;
  }).join('\n');
  downloadBlob(new Blob([body], { type: 'text/plain' }), `${s.name || 'captions'}.srt`).then((ok) => {
    if (ok) toast(`Exported ${clips.length} captions from ${best.t.name}`);
  });
}

// ---------------------------------------------------------------- shortcuts

export const SHORTCUTS = [
  ['Playback', [
    ['Play / Stop', 'Space'], ['Shuttle reverse / stop / forward', 'J / K / L'], ['Play In to Out', 'Ctrl+Shift+Space'],
    ['Step back / forward 1 frame', '← / →'], ['Step 5 frames', 'Shift+← / →'], ['Previous / next edit point', '↑ / ↓'],
    ['Go to start / end', 'Home / End'], ['Go to In / Out', 'Shift+I / Shift+O'], ['Toggle loop playback', 'Ctrl+Shift+L'],
  ]],
  ['Marking', [
    ['Mark In / Out', 'I / O'], ['Mark Clip', 'X'], ['Clear In and Out', 'Ctrl+Shift+X'], ['Clear In / Clear Out', 'Ctrl+Shift+I / O'],
    ['Add Marker', 'M'], ['Next / previous marker', 'Shift+M / Ctrl+Shift+M'],
  ]],
  ['Editing', [
    ['Insert / Overwrite from Source', ', / .'], ['Lift / Extract', '; / \''], ['Add Edit (split)', 'Ctrl+K'], ['Add Edit to all tracks', 'Ctrl+Shift+K'],
    ['Ripple trim previous / next edit to playhead', 'Q / W'], ['Clear', 'Delete / Backspace'], ['Ripple Delete', 'Shift+Delete'],
    ['Cut / Copy / Paste', 'Ctrl+X / C / V'], ['Paste Insert', 'Ctrl+Shift+V'], ['Duplicate (drag)', 'Alt+drag'], ['Insert-move (drag)', 'Ctrl+drag'],
    ['Apply default video / audio transition', 'Ctrl+D / Ctrl+Shift+D'], ['Apply default transitions to selection', 'Shift+D'],
    ['Enable / disable clip', 'Shift+E'], ['Link / unlink', 'Ctrl+L'], ['Speed/Duration', 'Ctrl+R'], ['Nudge clip 1 frame', 'Alt+← / →'],
    ['Match Frame (open source at playhead)', 'F'], ['Volume keyframe on rubber band', 'Ctrl+click'],
    ['Select all / deselect', 'Ctrl+A / Ctrl+Shift+A'], ['Undo / Redo', 'Ctrl+Z / Ctrl+Shift+Z'],
  ]],
  ['Tools', [
    ['Selection', 'V'], ['Track Select Forward', 'A'], ['Ripple Edit', 'B'], ['Rolling Edit', 'N'], ['Razor', 'C'],
    ['Slip', 'Y'], ['Hand', 'H'], ['Zoom', 'Z'], ['Type', 'T'],
  ]],
  ['View', [
    ['Zoom in / out timeline', '= / -'], ['Zoom to sequence', '\\'], ['Toggle snapping', 'S'], ['Maximize panel', '`'],
    ['Import', 'Ctrl+I'], ['Open project file', 'Ctrl+O'], ['Export Media', 'Ctrl+M'], ['Export Frame', 'Ctrl+Shift+E'], ['Save project file', 'Ctrl+S'],
    ['Timeline: scroll time / tracks / zoom', 'Wheel / Shift+wheel / Alt or Ctrl+wheel'], ['Keyboard shortcuts', 'F1 / ?'],
  ]],
];

export function openShortcutsDialog() {
  const table = h('div.kbd-table');
  for (const [group, rows] of SHORTCUTS) {
    table.append(h('h4', group));
    for (const [label, key] of rows) table.append(h('span', label), h('span.k', key));
  }
  openModal({ title: 'Keyboard Shortcuts (⌘ replaces Ctrl on macOS)', body: table, width: '620px' });
}

export function openAboutDialog() {
  openModal({
    title: 'About Montage',
    body: h('div.note', { style: { fontSize: '12px' } },
      h('p', 'Montage is a browser-based non-linear video editor modelled on the workflow of professional NLEs: project bin, source/program monitors, multi-track timeline, effect controls with keyframes, transitions, audio mixing and frame-accurate export.'),
      h('p', 'Everything runs locally in your browser. Media never leaves your machine; the current project and imported files are autosaved to this browser (IndexedDB).'),
      h('p', 'Decoding/encoding uses WebCodecs through the mediabunny library (MPL-2.0).')),
  });
}
