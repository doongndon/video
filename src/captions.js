// Auto captions: speech recognition with Whisper running in the browser (transformers.js).
// The library and model are downloaded on first use, so this needs an internet connection.

import { store } from './store.js';
import { renderAudioMix } from './export.js';
import { createClip, createTrack, renameTracks } from './model.js';

const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

export const ASR_MODELS = [
  ['onnx-community/whisper-tiny', '작음 (약 40MB · 빠름 · 정확도 낮음)'],
  ['onnx-community/whisper-base', '보통 (약 80MB · 권장)'],
  ['onnx-community/whisper-small', '큼 (약 250MB · 느림 · 더 정확)'],
];

export const ASR_LANGUAGES = [
  ['korean', '한국어'],
  ['english', '영어'],
  ['japanese', '일본어'],
  ['chinese', '중국어'],
  ['spanish', '스페인어'],
  ['french', '프랑스어'],
  ['german', '독일어'],
];

let tfModule = null;
const pipelines = new Map();

async function loadTransformers() {
  if (!tfModule) tfModule = await import(/* webpackIgnore: true */ TF_URL);
  return tfModule;
}

/** Mix the sequence audio between start and end down to 16 kHz mono samples. */
export async function sequenceAudio16k(seq, start, end, onProgress = () => {}) {
  const mix = await renderAudioMix(seq, start, end, 48000, (f) => onProgress(f));
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil((end - start) * 16000)), 16000);
  const src = ctx.createBufferSource();
  src.buffer = mix;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

/**
 * Transcribe the sequence (or its In/Out range) into caption cues in sequence time.
 * onStatus(text, fraction) reports download / recognition progress.
 */
export async function transcribeSequence({ seq, start, end, model, language, onStatus = () => {} }) {
  onStatus('오디오를 모으는 중…', 0);
  const samples = await sequenceAudio16k(seq, start, end, (f) => onStatus('오디오를 모으는 중…', f * 0.1));
  let peak = 0;
  for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 1e-3) throw new Error('이 구간에는 들리는 소리가 없습니다');

  onStatus('음성 인식 엔진을 불러오는 중… (처음 한 번은 시간이 걸립니다)', 0.1);
  let tf;
  try {
    tf = await loadTransformers();
  } catch {
    throw new Error('음성 인식 라이브러리를 내려받지 못했습니다. 인터넷 연결을 확인하세요. (claude.ai 보기 화면에서는 외부 다운로드가 막혀 있어 사용할 수 없습니다)');
  }
  tf.env.allowLocalModels = false;
  let asr = pipelines.get(model);
  if (!asr) {
    try {
      asr = await tf.pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) onStatus(`모델 내려받는 중: ${p.file} (${Math.round(p.progress)}%)`, 0.1 + 0.4 * (p.progress / 100));
        },
      });
    } catch (err) {
      throw new Error(`음성 인식 모델을 불러오지 못했습니다: ${err.message || err}`);
    }
    pipelines.set(model, asr);
  }
  onStatus('음성을 인식하는 중… (영상 길이에 따라 몇 분 걸릴 수 있습니다)', 0.55);
  const out = await asr(samples, { language, task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
  onStatus('자막을 만드는 중…', 0.95);
  const chunks = out?.chunks || [];
  const cues = chunks
    .map((c) => {
      const a = c.timestamp?.[0] ?? 0;
      const b = c.timestamp?.[1] ?? a + 2;
      return { start: start + a, end: start + Math.max(b, a + 0.4), text: String(c.text || '').trim() };
    })
    .filter((c) => c.text && c.end > c.start);
  if (!cues.length && out?.text) cues.push({ start, end, text: out.text.trim() });
  return cues;
}

// (음악), [박수], （笑） — sound descriptions, which Whisper also makes up on shouts and music.
// Music notes are removed but the words between them (lyrics) are kept.
const SOUND_TAGS = /\([^()]*\)|\[[^\[\]]*\]|（[^（）]*）|【[^【】]*】/g;

/** Remove bracketed sound descriptions; cues left without words are dropped. Returns {cues, removed}. */
export function stripSoundTags(cues) {
  let removed = 0;
  const out = [];
  for (const c of cues) {
    const text = c.text
      .replace(SOUND_TAGS, () => { removed++; return ' '; })
      .replace(/[♪♫]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
    if (/[\p{L}\p{N}]/u.test(text)) out.push({ ...c, text });
  }
  return { cues: out, removed };
}

/** Put caption cues on a new video track as styled text clips. Returns the number of clips. */
export function createCaptionTrack(cues, label = '자막') {
  const s = store.seq;
  if (!cues.length) return 0;
  store.transact(label, () => {
    const track = createTrack('video', 0);
    const lastVideoIdx = s.tracks.findLastIndex((t) => t.kind === 'video');
    s.tracks.splice(lastVideoIdx + 1, 0, track);
    renameTracks(s);
    for (const cue of cues) {
      const c = createClip(s, { kind: 'text', trackId: track.id, name: cue.text.split('\n')[0].slice(0, 40), start: cue.start, duration: Math.max(0.2, cue.end - cue.start) });
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
  return cues.length;
}
