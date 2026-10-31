// Voice-over recording: records the microphone while the timeline plays and drops the take onto
// the chosen audio track at the position where recording started.

import { store } from './store.js';
import { playback } from './playback.js';
import { importFiles, mediaStatus } from './media.js';
import * as edit from './edit.js';
import { clamp } from './util.js';

let rec = null;

export function recordingTrack() {
  return rec?.trackId || null;
}

export async function toggleVoiceover(trackId) {
  if (rec) return stopRecording();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    store.toast('이 브라우저(또는 보기 화면)에서는 마이크 녹음을 쓸 수 없습니다');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch {
    store.toast('마이크를 사용할 수 없습니다. 브라우저 주소창의 마이크 권한을 확인하세요.');
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  let mr;
  try {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    // the microphone must not stay on when recording cannot start
    stream.getTracks().forEach((t) => t.stop());
    store.toast(`녹음을 시작할 수 없습니다: ${err.message || err}`);
    return;
  }
  if (playback.suspended) {
    stream.getTracks().forEach((t) => t.stop());
    store.toast('내보내는 중에는 녹음할 수 없습니다');
    return;
  }
  const chunks = [];
  mr.addEventListener('dataavailable', (e) => {
    if (e.data.size) chunks.push(e.data);
  });
  const a = playback.ensureAudio();
  const inLatency = stream.getAudioTracks()[0]?.getSettings?.().latency || 0.01;
  const latency = (a.ctx.outputLatency || 0) + (a.ctx.baseLatency || 0) + inLatency;
  rec = { trackId, mr, chunks, start: store.ui.playhead, stream, mime, latency };
  mr.start(250);
  playback.openEnded = true;
  playback.play(1);
  store.emit('recording');
  store.toast('녹음 중입니다. 녹음 버튼을 다시 누르거나 Space로 멈추세요.');
}

async function stopRecording() {
  const r = rec;
  if (!r) return;
  rec = null;
  playback.openEnded = false;
  playback.stop();
  await new Promise((resolve) => {
    r.mr.addEventListener('stop', resolve, { once: true });
    r.mr.stop();
  });
  r.stream.getTracks().forEach((t) => t.stop());
  store.emit('recording');
  const blob = new Blob(r.chunks, { type: r.mime || 'audio/webm' });
  if (!blob.size) {
    store.toast('녹음된 소리가 없습니다');
    return;
  }
  store.ui.voCount = (store.ui.voCount || 0) + 1;
  const ext = (r.mime || '').includes('mp4') ? 'm4a' : 'webm';
  const file = new File([blob], `보이스오버 ${store.ui.voCount}.${ext}`, { type: blob.type });
  const [id] = await importFiles([file]);
  if (id && mediaStatus(id) === 'ready') {
    // what was heard left the speakers late and the voice reached the recording late: skip that much
    // of the take so the words line up with the picture they answered
    const lag = clamp(r.latency, 0, 0.5);
    const dur = store.project.media[id]?.duration;
    const opts = { mode: 'overwrite', start: r.start, aTrackId: r.trackId, video: false };
    if (lag > 0.001 && dur > lag + 0.1) opts.inPoint = lag;
    edit.placeMedia(id, opts);
    store.toast('보이스오버를 타임라인에 넣었습니다');
  }
}

// stopping playback (Space) also ends a take
playback.on('state', () => {
  if (rec && !playback.playing) stopRecording();
});
