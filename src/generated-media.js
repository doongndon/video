// Generated project items like Premiere's 새 항목: HD 바 및 톤 (SMPTE colour bars + 1 kHz tone),
// 범용 카운팅 리더 (8 → 2 countdown with a clock wipe and cue blips) and 투명 비디오.
// Bars and leaders are rendered into a real video file (WebCodecs via mediabunny: MP4 H.264, else
// WebM VP8) and imported, so playback, export and autosave treat them like any other file.

import { store } from './store.js';
import { importFiles, createSyntheticMedia } from './media.js';

const MB_URL = '../vendor/mediabunny/mediabunny.min.mjs';
const SR = 48000;

/** Largest frame we render generated media at (they are flat graphics; the monitor scales them). */
function fitSize(width, height, maxSide) {
  const k = Math.min(1, maxSide / Math.max(width, height));
  return [Math.max(16, Math.round((width * k) / 2) * 2), Math.max(16, Math.round((height * k) / 2) * 2)];
}

function sliceBuffer(buf, s0, s1) {
  const out = new AudioBuffer({ length: Math.max(1, s1 - s0), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(s0, s1));
  return out;
}

/**
 * Encode frames drawn by drawFrame(ctx, t, i) (plus an optional AudioBuffer) into a video file.
 * Returns a Blob (MP4 H.264 where possible, else WebM).
 */
async function encodeFrames({ width, height, fps, duration, drawFrame, audio = null, onProgress = () => {}, token = {} }) {
  const MB = await import(MB_URL);
  // H.264 or VP8: the browsers' realtime VP9 encoders skip blocks of flat moving graphics (the leader's wipe)
  const videoCodec = await MB.getFirstEncodableVideoCodec(['avc', 'vp8', 'vp9', 'av1'], { width, height, frameRate: fps });
  if (!videoCodec) throw new Error('이 브라우저에서는 영상 파일을 만들 수 없습니다 (최신 Chrome·Edge 권장)');
  const webm = videoCodec !== 'avc';
  const audioCodec = audio ? await MB.getFirstEncodableAudioCodec(webm ? ['opus', 'vorbis'] : ['aac', 'opus'], { numberOfChannels: 2, sampleRate: SR }) : null;
  const output = new MB.Output({
    format: webm ? new MB.WebMOutputFormat() : new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new MB.BufferTarget(),
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const video = new MB.CanvasSource(canvas, { codec: videoCodec, quality: MB.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: fps });
  let sound = null;
  if (audioCodec && audio) {
    sound = new MB.AudioBufferSource({ codec: audioCodec, quality: MB.QUALITY_HIGH });
    output.addAudioTrack(sound);
  }
  await output.start();
  const total = Math.max(1, Math.round(duration * fps));
  let audioPos = 0;
  try {
    for (let i = 0; i < total; i++) {
      if (token.cancelled) throw new Error('취소했습니다');
      // unchanged frames still need a sample (the canvas keeps the last drawing; the encoder makes them tiny)
      drawFrame(ctx, i / fps, i);
      await video.add(i / fps, 1 / fps);
      if (sound) {
        const want = Math.min(audio.length, Math.ceil(((i + 1) / fps + 1) * SR));
        if (want > audioPos) {
          await sound.add(sliceBuffer(audio, audioPos, want));
          audioPos = want;
        }
      }
      if (i % 8 === 0) {
        onProgress((i + 1) / total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (sound && audioPos < audio.length) await sound.add(sliceBuffer(audio, audioPos, audio.length));
    await output.finalize();
  } catch (err) {
    try { await output.cancel(); } catch { /* ignore */ }
    throw err;
  }
  onProgress(1);
  return new Blob([output.target.buffer], { type: webm ? 'video/webm' : 'video/mp4' });
}

/** Import a generated file as one undoable step with its own label. Resolves with the media id. */
async function importGenerated(blob, name, label) {
  const file = new File([blob], name, { type: blob.type });
  const mark = store.undoMark();
  const pending = importFiles([file]);
  // importFiles records its step before it starts analysing: give it a clearer name
  store.squashSince(mark, label);
  const [id] = await pending;
  return id || null;
}

// ---------------------------------------------------------------- bars and tone

/** SMPTE RP 219 style HD colour bars (75% bars, PLUGE and ramp) drawn at any size. */
export function drawBars(ctx, W, H) {
  const d = W / 8; // side pillars
  const c = (W * 3) / 4 / 7; // one bar
  const rows = [0, (H * 7) / 12, (H * 8) / 12, (H * 9) / 12, H];
  const box = (x, y0, w, y1, col) => {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x), Math.round(y0), Math.ceil(w) + 1, Math.ceil(y1 - y0));
  };
  // 1: 40% grey | 75% white, yellow, cyan, green, magenta, red, blue | 40% grey
  box(0, rows[0], d, rows[1], '#666666');
  ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf'].forEach((col, i) => box(d + i * c, rows[0], c, rows[1], col));
  box(W - d, rows[0], d, rows[1], '#666666');
  // 2: 100% cyan | 100% white | 75% white | 100% blue
  box(0, rows[1], d, rows[2], '#00ffff');
  box(d, rows[1], c, rows[2], '#ffffff');
  box(d + c, rows[1], c * 6, rows[2], '#bfbfbf');
  box(W - d, rows[1], d, rows[2], '#0000ff');
  // 3: 100% yellow | black | luminance ramp | white | 100% red
  box(0, rows[2], d, rows[3], '#ffff00');
  box(d, rows[2], c, rows[3], '#000000');
  const g = ctx.createLinearGradient(d + c, 0, d + c * 6, 0);
  g.addColorStop(0, '#000000');
  g.addColorStop(1, '#ffffff');
  box(d + c, rows[2], c * 5, rows[3], g);
  box(d + c * 6, rows[2], c, rows[3], '#ffffff');
  box(W - d, rows[2], d, rows[3], '#ff0000');
  // 4: 15% grey | black | white | black | PLUGE (-2, 0, +2, 0, +4 %) | black | 15% grey
  box(0, rows[3], d, rows[4], '#262626');
  let x = d;
  for (const [w, col] of [[1.5 * c, '#000000'], [2 * c, '#ffffff'], [(5 / 6) * c, '#000000'], [c / 3, '#000000'], [c / 3, '#000000'], [c / 3, '#050505'], [c / 3, '#000000'], [c / 3, '#0a0a0a'], [c, '#000000']]) {
    box(x, rows[3], w, rows[4], col);
    x += w;
  }
  box(W - d, rows[3], d, rows[4], '#262626');
}

function toneBuffer(duration, { freq = 1000, db = -20 } = {}) {
  const n = Math.max(1, Math.round(duration * SR));
  const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
  const amp = 10 ** (db / 20);
  const L = buf.getChannelData(0);
  const w = (2 * Math.PI * freq) / SR;
  for (let i = 0; i < n; i++) L[i] = Math.sin(w * i) * amp;
  buf.getChannelData(1).set(L);
  return buf;
}

/**
 * 바 및 톤: opts { width, height, fps, duration, toneDb, toneHz, onProgress, token }.
 * Resolves with the new media id.
 */
export async function createBarsAndTone({ width = store.seq.width, height = store.seq.height, fps = store.seq.fps, duration = 10, toneDb = -20, toneHz = 1000, onProgress, token } = {}) {
  const [w, h] = fitSize(width, height, 1920);
  const blob = await encodeFrames({
    width: w, height: h, fps, duration, onProgress, token,
    audio: toneBuffer(duration, { freq: toneHz, db: toneDb }),
    drawFrame: (ctx, t, i) => {
      if (i === 0) drawBars(ctx, w, h);
    },
  });
  return importGenerated(blob, width >= 1280 ? 'HD 바 및 톤' : '바 및 톤', '새 바 및 톤');
}

// ---------------------------------------------------------------- universal counting leader

export const LEADER_DEFAULTS = {
  wipe: '#8c8c8c', background: '#3c3c3c', line: '#f2f2f2', target: '#f2f2f2', numeral: '#ffffff',
  blipOn2: true, blipEverySecond: false, blipOut: false,
};
export const LEADER_SECONDS = 9; // 8 → 2 (seven seconds) and two seconds of black

/** One frame of the leader: number n with the wipe at progress p (0..1) of its second. */
export function drawLeaderFrame(ctx, W, H, t, o = LEADER_DEFAULTS) {
  const n = 8 - Math.floor(t);
  if (n < 2) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const p = t - Math.floor(t);
  const cx = W / 2;
  const cy = H / 2;
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, W, H);
  // clock wipe from 12 o'clock, clockwise
  const R = Math.hypot(W, H);
  ctx.fillStyle = o.wipe;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  // cross hair and target circles
  const lw = Math.max(2, Math.round(H / 270));
  ctx.strokeStyle = o.line;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(W, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  ctx.strokeStyle = o.target;
  ctx.lineWidth = lw * 1.5;
  for (const r of [H * 0.3, H * 0.38]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = o.numeral;
  ctx.font = `700 ${Math.round(H * 0.42)}px "Noto Sans KR", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), cx, cy + H * 0.02);
}

function leaderAudio(fps, o) {
  const n = Math.round(LEADER_SECONDS * SR);
  const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
  const L = buf.getChannelData(0);
  const amp = 10 ** (-20 / 20);
  const len = Math.round(SR / fps); // one frame
  const blip = (t) => {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < len && s0 + i < n; i++) {
      // 1 ms fades keep the blip click-free
      const env = Math.min(1, i / 48, (len - i) / 48);
      L[s0 + i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * amp * env;
    }
  };
  if (o.blipEverySecond) for (let s = 0; s <= 6; s++) blip(s);
  else if (o.blipOn2) blip(6);
  if (o.blipOut) blip(LEADER_SECONDS - 1 / fps);
  buf.getChannelData(1).set(L);
  return buf;
}

/** 범용 카운팅 리더: opts { width, height, fps, ...colours, blip flags, onProgress, token }. */
export async function createCountingLeader({ width = store.seq.width, height = store.seq.height, fps = store.seq.fps, onProgress, token, ...colours } = {}) {
  const o = { ...LEADER_DEFAULTS, ...colours };
  const [w, h] = fitSize(width, height, 1280);
  if (document.fonts?.load) await document.fonts.load(`700 ${Math.round(h * 0.42)}px "Noto Sans KR"`, '8765432').catch(() => {});
  const blob = await encodeFrames({
    width: w, height: h, fps, duration: LEADER_SECONDS, onProgress, token,
    audio: leaderAudio(fps, o),
    drawFrame: (ctx, t) => drawLeaderFrame(ctx, w, h, t, o),
  });
  return importGenerated(blob, '범용 카운팅 리더', '새 범용 카운팅 리더');
}

// ---------------------------------------------------------------- transparent video

/** 투명 비디오: a clip that draws nothing on its own (a carrier for effects). */
export function createTransparentVideo() {
  return createSyntheticMedia('color', { name: '투명 비디오', color: 'rgba(0,0,0,0)' });
}
