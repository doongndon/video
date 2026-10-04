// Sample project shown on first launch so the editor opens in a working state. Everything is
// generated locally: colour mattes, titles, shapes and a short synthesized music bed.

import { store } from './store.js';
import * as edit from './edit.js';
import { createSyntheticMedia, importFiles, mediaStatus } from './media.js';
import { createProject, videoTracks, audioTracks, findEffect } from './model.js';
import { encodeWav } from './export.js';

/** A gentle 12-second arpeggio (C – Am – F – G) rendered offline to a WAV file. */
async function synthMusic(seconds = 12, sampleRate = 44100) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);
  const chords = [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]];
  const step = 0.25;
  for (let i = 0; i * step < seconds; i++) {
    const chord = chords[Math.floor((i * step) / 3) % chords.length];
    const f = chord[i % 3] * (i % 6 >= 3 ? 2 : 1);
    const t = i * step;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + step * 1.8);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (i % 3) * 0.5 - 0.5;
    osc.connect(g).connect(pan).connect(master);
    osc.start(t);
    osc.stop(t + step * 2);
  }
  // soft bass on each chord
  for (let k = 0; k * 3 < seconds; k++) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = chords[k % chords.length][0] / 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, k * 3);
    g.gain.linearRampToValueAtTime(0.8, k * 3 + 0.05);
    g.gain.linearRampToValueAtTime(0.0001, k * 3 + 2.9);
    osc.connect(g).connect(master);
    osc.start(k * 3);
    osc.stop(k * 3 + 3);
  }
  const buf = await ctx.startRendering();
  return new File([encodeWav(buf)], 'Sample Music.wav', { type: 'audio/wav' });
}

function setParam(clip, fxType, key, value, kf) {
  const fx = findEffect(clip, fxType);
  if (!fx) return;
  fx.params[key].value = value;
  if (kf) fx.params[key].kf = kf.map(([t, v, ease = 'ease']) => ({ t, v, ease }));
}

export async function loadSampleProject() {
  store.loadProject(createProject('Sample Project'));
  const s = store.seq;
  s.name = 'Sample Sequence';
  const [v1, v2, v3] = videoTracks(s);
  const [a1] = audioTracks(s);

  const blue = createSyntheticMedia('color', { name: 'Night Blue', color: '#14284b' });
  const dusk = createSyntheticMedia('color', { name: 'Dusk', color: '#5b2a4a' });
  const adj = createSyntheticMedia('adjustment', { name: 'Adjustment Layer' });

  let musicId = null;
  try {
    [musicId] = await importFiles([await synthMusic()]);
  } catch (err) {
    console.warn('sample music unavailable', err);
  }

  edit.placeMedia(blue, { mode: 'overwrite', start: 0, vTrackId: v1.id, inPoint: 0, outPoint: 6 });
  edit.placeMedia(dusk, { mode: 'overwrite', start: 6, vTrackId: v1.id, inPoint: 0, outPoint: 6 });
  const bgA = Object.values(s.clips).find((c) => c.mediaId === blue);
  edit.applyTransition(bgA.id, 'out', 'crossDissolve', 1.5);

  const title = edit.addTextClip({ start: 0.5, content: 'Montage', y: s.height * 0.42 });
  const subtitle = edit.addTextClip({ start: 6.5, content: '브라우저에서 동작하는 영상 편집기', y: s.height * 0.42 });
  const bar = edit.addShapeClip('rectangle', { start: 1.5 });
  const dot = edit.addShapeClip('ellipse', { start: 7 });

  store.transact('Sample layout', () => {
    const c = (id) => s.clips[id];
    // title: scales up while fading in, dissolves out
    c(title).duration = 5;
    c(title).transIn = { type: 'crossDissolve', duration: 1 };
    c(title).transOut = { type: 'crossDissolve', duration: 1 };
    setParam(c(title), 'text', 'size', 180);
    setParam(c(title), 'motion', 'scale', 100, [[0, 82], [2, 100]]);
    findEffect(c(title), 'text').params.tracking.value = 6;
    // subtitle: typewriter reveal
    c(subtitle).duration = 5;
    setParam(c(subtitle), 'text', 'size', 84);
    setParam(c(subtitle), 'text', 'reveal', 100, [[0, 0, 'linear'], [2.2, 100, 'linear']]);
    c(subtitle).transOut = { type: 'dipToBlack', duration: 0.8 };
    // lower-third bar slides in from the left
    c(bar).duration = 4;
    c(bar).trackId = v2.id;
    const shape = findEffect(c(bar), 'shape');
    shape.params.width.value = 900;
    shape.params.height.value = 120;
    shape.params.radius.value = 60;
    shape.params.gradient.value = true;
    shape.params.fill.value = '#2d8ceb';
    shape.params.fill2.value = '#9b5de5';
    setParam(c(bar), 'motion', 'posY', s.height * 0.72);
    setParam(c(bar), 'motion', 'posX', s.width / 2, [[0, -500], [1.2, s.width / 2]]);
    c(bar).transOut = { type: 'crossDissolve', duration: 0.6 };
    // a soft glowing circle behind the subtitle
    c(dot).duration = 4.5;
    c(dot).trackId = v2.id;
    const circle = findEffect(c(dot), 'shape');
    circle.params.width.value = 520;
    circle.params.height.value = 520;
    circle.params.fill.value = '#f2a65a';
    setParam(c(dot), 'opacity', 'opacity', 35);
    setParam(c(dot), 'motion', 'posY', s.height * 0.42);
    setParam(c(dot), 'motion', 'scale', 100, [[0, 60], [4.5, 120]]);
    c(dot).transIn = { type: 'crossDissolve', duration: 1 };
    for (const id of [title, subtitle]) c(id).trackId = v3.id;
    s.markers.push({ id: 'mk_sample1', time: 0.5, name: 'Title', color: '#4ade80', comment: '' });
    s.markers.push({ id: 'mk_sample2', time: 6, name: 'Scene 2', color: '#fb923c', comment: '' });
  });

  // a vignette + grain adjustment layer over everything
  const v4 = videoTracks(s)[3] || (edit.addTrack('video'), videoTracks(store.seq)[3]);
  edit.placeMedia(adj, { mode: 'overwrite', start: 0, vTrackId: v4.id, inPoint: 0, outPoint: 12 });
  const adjClip = Object.values(store.seq.clips).find((c) => c.mediaId === adj);
  edit.addEffect([adjClip.id], 'vignette');
  edit.addEffect([adjClip.id], 'filmGrain');
  store.transact('Sample grain', () => {
    const g = adjClip.effects.find((e) => e.type === 'filmGrain');
    if (g) g.params.amount.value = 18;
  });

  if (musicId && mediaStatus(musicId) === 'ready') {
    edit.placeMedia(musicId, { mode: 'overwrite', start: 0, aTrackId: a1.id, video: false });
    const music = Object.values(store.seq.clips).find((c) => c.mediaId === musicId);
    if (music) edit.applyTransition(music.id, 'out', 'constantPower', 2);
  }

  // the sample starts with a clean history and nothing selected
  store.undoStack = [];
  store.redoStack = [];
  store.clearSelection();
  store.setPlayhead(1.5);
  store.emit('history');
  store.changed();
}
