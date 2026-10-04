// AI editing with Google Gemini, using the person's own API key. The browser talks to
// generativelanguage.googleapis.com directly (there is no server of ours in between).
// What is sent: for the assistant, a text summary of the timeline (clip names and times, caption
// and title text); for Gemini speech recognition, the mixed sequence audio. Video frames are not sent.

import { store } from './store.js';
import * as edit from './edit.js';
import { EFFECTS, TRANSITIONS } from './effects.js';
import { clipEnd, clipsOnTrack, createClip, createTrack, renameTracks, sequenceDuration, videoTracks, linkedClips } from './model.js';
import { clamp, snapFrame, uid } from './util.js';
import {
  FILTERS, applyFilter, ANIMATIONS, applyAnimation, TEXT_STYLES, applyTextStyle, addSticker, ASPECTS, setAspect,
} from './features.js';
import { sequenceAudio16k, createCaptionTrack, ASR_LANGUAGES } from './captions.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const PREF = 'montage.gemini';
export const API_KEY_PAGE = 'https://aistudio.google.com/apikey';

// ---------------------------------------------------------------- settings (key, model)

export const geminiSettings = loadSettings();

function readJSON(storage) {
  try {
    return JSON.parse(storage.getItem(PREF) || '{}') || {};
  } catch {
    return {};
  }
}

function loadSettings() {
  const saved = readJSON(globalThis.localStorage || { getItem: () => null });
  const session = readJSON(globalThis.sessionStorage || { getItem: () => null });
  return { key: saved.key || session.key || '', model: saved.model || session.model || '', remember: !!saved.key, models: [] };
}

/** remember: keep the key in this browser (localStorage); otherwise only until the tab closes. */
export function saveGeminiSettings({ key = geminiSettings.key, model = geminiSettings.model, remember = geminiSettings.remember } = {}) {
  Object.assign(geminiSettings, { key: String(key || '').trim(), model: model || '', remember: !!remember });
  try {
    const all = JSON.stringify({ key: geminiSettings.key, model: geminiSettings.model });
    if (geminiSettings.remember) {
      localStorage.setItem(PREF, all);
      sessionStorage.removeItem(PREF);
    } else {
      sessionStorage.setItem(PREF, all);
      localStorage.setItem(PREF, JSON.stringify({ model: geminiSettings.model }));
    }
  } catch {
    /* storage unavailable: settings last until the page closes */
  }
  store.emit('gemini-settings');
}

// ---------------------------------------------------------------- REST calls

async function call(path, { method = 'GET', body, signal } = {}) {
  if (!geminiSettings.key) throw new Error('Gemini API 키를 먼저 넣으세요 (AI 편집 패널 ▸ 설정)');
  let res;
  try {
    res = await fetch(`${API}/${path}`, {
      method,
      signal,
      headers: { 'x-goog-api-key': geminiSettings.key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('Gemini 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요. claude.ai 아티팩트 보기 화면에서는 외부 연결이 막혀 있어 쓸 수 없습니다 — GitHub Pages 주소나 내 컴퓨터에서 여세요.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || '';
    const detail = JSON.stringify(data?.error?.details || '');
    if (/API_KEY_INVALID|API key not valid/i.test(msg + detail)) throw new Error('API 키가 올바르지 않습니다. Google AI Studio에서 받은 키를 다시 확인하세요.');
    if (res.status === 429) throw new Error(`사용 한도를 넘었습니다. 잠시 뒤 다시 하거나 설정에서 다른 모델을 고르세요. (${msg})`);
    if (res.status === 404) throw new Error(`모델을 찾을 수 없습니다. 설정에서 모델 목록을 다시 불러오세요. (${msg})`);
    if (res.status === 403) throw new Error(`이 API 키로는 쓸 수 없습니다: ${msg}`);
    throw new Error(`Gemini 오류 (${res.status}): ${msg}`);
  }
  return data;
}

const versionOf = (id) => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
/** Higher is better: stable before preview, Flash before Pro before Lite, newer before older. */
function modelRank(id) {
  const stable = /(preview|exp|latest)/.test(id) ? 0 : 1;
  const tier = /flash/.test(id) && !/lite/.test(id) ? 3 : /pro/.test(id) ? 2 : /lite/.test(id) ? 1 : 0;
  return stable * 1e5 + tier * 1e4 + versionOf(id) * 10;
}

/** Text models this key can use, best first. */
export async function listGeminiModels(signal) {
  const all = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const d = await call(`models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { signal });
    all.push(...(d?.models || []));
    token = d?.nextPageToken;
    if (!token) break;
  }
  const models = all
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini/.test(m.name || ''))
    .filter((m) => !/(tts|image|embedding|live|native-audio|robotics|computer-use|aqa)/i.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, '') }))
    .sort((a, b) => modelRank(b.id) - modelRank(a.id));
  geminiSettings.models = models;
  return models;
}

async function ensureModel(signal) {
  if (geminiSettings.model) return geminiSettings.model;
  const models = await listGeminiModels(signal);
  if (!models.length) throw new Error('이 API 키로 쓸 수 있는 Gemini 모델이 없습니다');
  saveGeminiSettings({ model: models[0].id });
  return geminiSettings.model;
}

export async function generate(body, signal) {
  const model = await ensureModel(signal);
  return call(`models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', body, signal });
}

function firstCandidate(d) {
  const c = d?.candidates?.[0];
  if (!c?.content) {
    const why = d?.promptFeedback?.blockReason || c?.finishReason;
    throw new Error(why ? `Gemini가 답하지 않았습니다 (${why})` : 'Gemini가 빈 응답을 보냈습니다');
  }
  return c;
}

const textOf = (content) => (content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();

// ---------------------------------------------------------------- speech recognition (captions)

const CHUNK_SECONDS = 180; // 16 kHz mono 16-bit WAV ≈ 5.8 MB per request
const CUE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { start: { type: 'NUMBER' }, end: { type: 'NUMBER' }, text: { type: 'STRING' } },
    required: ['start', 'end', 'text'],
  },
};

function wav16k(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, clamp(samples[i], -1, 1) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function transcribePrompt(seconds, langName) {
  return [
    `이 오디오는 영상의 소리이고 길이는 ${seconds.toFixed(1)}초입니다. 들리는 말을 ${langName}로 받아 적어 자막을 만들어 주세요.`,
    '- 들리는 그대로 적으세요. 지어내거나 요약하거나 고쳐 쓰지 마세요. 외래어·감탄사·유행어도 들리는 소리대로 적으세요.',
    '- 자막 하나는 한 문장, 또는 2~6초 분량으로 나누세요.',
    '- start와 end는 이 오디오 시작부터의 시간(초, 소수점 둘째 자리까지)입니다. 실제로 말하는 순간에 맞추세요.',
    '- 말소리가 없으면 빈 배열 []을 돌려주세요. 음악·효과음 설명이나 괄호 설명은 쓰지 마세요.',
  ].join('\n');
}

/** Gemini speech recognition of the sequence (start..end) → caption cues in sequence time. */
export async function transcribeWithGemini({ seq, start, end, language = 'korean', onStatus = () => {}, signal }) {
  onStatus('오디오를 모으는 중…', 0);
  const samples = await sequenceAudio16k(seq, start, end, (f) => onStatus('오디오를 모으는 중…', f * 0.15));
  let peak = 0;
  for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 1e-3) throw new Error('이 구간에는 들리는 소리가 없습니다');
  const langName = (ASR_LANGUAGES.find(([id]) => id === language) || [null, '원래 언어'])[1];
  const total = samples.length / 16000;
  const n = Math.max(1, Math.ceil(total / CHUNK_SECONDS));
  const cues = [];
  for (let i = 0; i < n; i++) {
    const a = i * CHUNK_SECONDS;
    const b = Math.min(total, a + CHUNK_SECONDS);
    onStatus(`Gemini가 듣고 받아 적는 중… (${i + 1}/${n})`, 0.15 + 0.8 * (i / n));
    const data = await blobToBase64(wav16k(samples.subarray(Math.round(a * 16000), Math.round(b * 16000))));
    const d = await generate({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data } }, { text: transcribePrompt(b - a, langName) }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: CUE_SCHEMA },
    }, signal);
    let arr;
    try {
      arr = JSON.parse(textOf(firstCandidate(d).content) || '[]');
    } catch {
      throw new Error('Gemini 응답을 자막으로 읽지 못했습니다. 다시 시도해 보세요.');
    }
    for (const c of Array.isArray(arr) ? arr : []) {
      const s0 = clamp(Number(c.start) || 0, 0, b - a);
      const e0 = clamp(Number(c.end) || 0, 0, b - a);
      const text = String(c.text || '').trim();
      if (!text) continue;
      cues.push({ start: start + a + s0, end: start + a + Math.max(e0, s0 + 0.4), text });
    }
  }
  cues.sort((x, y) => x.start - y.start);
  for (let i = 0; i + 1 < cues.length; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = Math.max(cues[i].start + 0.2, cues[i + 1].start);
  }
  onStatus('자막을 만드는 중…', 0.97);
  return cues;
}

// ---------------------------------------------------------------- timeline summary for the assistant

const r2 = (t) => Math.round(t * 100) / 100;

export function timelineContext() {
  const s = store.seq;
  const trackName = Object.fromEntries(s.tracks.map((t) => [t.id, t.name]));
  const order = Object.fromEntries(s.tracks.map((t, i) => [t.id, i]));
  const clips = Object.values(s.clips)
    .sort((a, b) => a.start - b.start || order[a.trackId] - order[b.trackId])
    .slice(0, 800)
    .map((c) => {
      const o = { id: c.id, track: trackName[c.trackId], kind: c.kind, name: c.name, start: r2(c.start), end: r2(clipEnd(c)) };
      const tx = c.effects.find((e) => e.type === 'text');
      if (tx) o.text = String(tx.params.content.value ?? '').slice(0, 300);
      if (c.speed && c.speed !== 1) o.speed = c.speed;
      if (c.reverse) o.reverse = true;
      if (c.linkId) o.link = c.linkId;
      if (c.enabled === false) o.disabled = true;
      const fx = c.effects.filter((e) => !EFFECTS[e.type]?.fixed).map((e) => EFFECTS[e.type]?.name || e.type);
      if (fx.length) o.effects = fx;
      return o;
    });
  return {
    sequence: {
      name: s.name, width: s.width, height: s.height, fps: s.fps, duration: r2(sequenceDuration(s)), playhead: r2(store.ui.playhead),
      in: s.inPoint, out: s.outPoint, selected_clip_ids: [...store.selection.clips],
    },
    tracks: s.tracks.map((t) => ({ name: t.name, kind: t.kind, ...(t.locked ? { locked: true } : {}), ...(t.hidden || t.muted ? { off: true } : {}) })),
    clips,
    markers: s.markers.map((m) => ({ time: r2(m.time), name: m.name })),
    omitted_clips: Math.max(0, Object.keys(s.clips).length - clips.length),
  };
}

// ---------------------------------------------------------------- tools the assistant can call

const S = (description, extra = {}) => ({ type: 'STRING', description, ...extra });
const N = (description) => ({ type: 'NUMBER', description });
const B = (description) => ({ type: 'BOOLEAN', description });
const A = (items, description) => ({ type: 'ARRAY', items, description });
const O = (properties, required = [], description) => ({ type: 'OBJECT', properties, required, ...(description ? { description } : {}) });
const IDS = A({ type: 'STRING' }, '클립 id 목록 (타임라인 정보의 clips[].id)');

const VIDEO_TRANSITIONS = Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'video').map(([k]) => k);
const ANIM_IDS = Object.fromEntries(Object.entries(ANIMATIONS).map(([k, list]) => [k, list.map((a) => a.id)]));

function seqOf() {
  return store.seq;
}
function needClips(ids, kinds = null) {
  const s = seqOf();
  const list = (ids || []).map((id) => s.clips[id]).filter(Boolean).filter((c) => !kinds || kinds.includes(c.kind));
  if (!list.length) throw new Error(`해당하는 클립이 없습니다: ${(ids || []).join(', ') || '(없음)'}`);
  return list;
}
function timeIn(t, name = '시간') {
  const v = Number(t);
  if (!Number.isFinite(v)) throw new Error(`${name} 값이 숫자가 아닙니다`);
  return Math.max(0, v);
}
function unlockedTracks() {
  return seqOf().tracks.filter((t) => !t.locked).map((t) => t.id);
}
/** A video track (not V1) free over [a, b], created above the others when none is. */
function freeVideoTrack(a, b) {
  const s = seqOf();
  let track = videoTracks(s).find((t, i) => i > 0 && !t.locked && !clipsOnTrack(s, t.id).some((c) => c.start < b - 1e-6 && clipEnd(c) > a + 1e-6));
  if (!track) {
    track = createTrack('video', videoTracks(s).length);
    s.tracks.splice(s.tracks.findLastIndex((t) => t.kind === 'video') + 1, 0, track);
    renameTracks(s);
  }
  return track;
}
const POS_Y = { top: 0.14, center: 0.5, bottom: 0.84 };

export const AI_TOOLS = [
  {
    name: 'cut_time_ranges',
    label: '구간 잘라내기',
    description: '시퀀스 시간의 구간들을 모든 트랙(잠긴 트랙 제외)에서 잘라 냅니다. close_gaps가 true(기본)이면 뒤쪽을 당겨 빈자리를 없앱니다. 말 실수·침묵·지루한 부분 삭제, 하이라이트 만들기에 씁니다.',
    parameters: O({ ranges: A(O({ start: N('시작(초)'), end: N('끝(초)') }, ['start', 'end']), '잘라 낼 구간들'), close_gaps: B('빈자리를 당길지 (기본 true)') }, ['ranges']),
    run({ ranges, close_gaps = true }) {
      const s = seqOf();
      const fd = 1 / s.fps;
      let rs = (ranges || []).map((r) => [snapFrame(timeIn(r.start, 'start'), s.fps), snapFrame(timeIn(r.end, 'end'), s.fps)]).filter(([a, b]) => b - a >= fd).sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const r of rs) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
      }
      rs = merged.reverse();
      if (!rs.length) throw new Error('잘라 낼 구간이 없습니다 (1프레임보다 짧거나 잘못된 구간)');
      const tids = unlockedTracks();
      let removed = 0;
      store.transact('AI: 구간 잘라내기', () => {
        for (const [a, b] of rs) {
          edit.rawClearRangeMulti(tids, a, b);
          if (close_gaps !== false) edit.rawRipple(tids, b, -(b - a));
          removed += b - a;
        }
      });
      return { cuts: rs.length, removed_seconds: r2(removed), new_duration: r2(sequenceDuration(s)) };
    },
    summary: (r) => `${r.cuts}곳, ${r.removed_seconds}초`,
  },
  {
    name: 'delete_clips',
    label: '클립 지우기',
    description: '클립을 지웁니다(연결된 영상/소리 짝도 함께). close_gaps가 true면 빈자리를 당깁니다.',
    parameters: O({ clip_ids: IDS, close_gaps: B('빈자리를 당길지 (기본 false)') }, ['clip_ids']),
    run({ clip_ids, close_gaps = false }) {
      const list = needClips(clip_ids);
      store.selectClips(list.map((c) => c.id));
      edit.deleteSelection({ ripple: !!close_gaps });
      return { deleted: list.length };
    },
    summary: (r) => `${r.deleted}개`,
  },
  {
    name: 'split_at',
    label: '자르기(분할)',
    description: '주어진 시간들에서 클립을 둘로 나눕니다. clip_ids를 주면 그 클립(과 연결된 짝)만, 없으면 그 시간에 걸친 모든 트랙의 클립을 나눕니다.',
    parameters: O({ times: A({ type: 'NUMBER' }, '나눌 시간(초)'), clip_ids: IDS }, ['times']),
    run({ times, clip_ids }) {
      const ts = (times || []).map((t) => timeIn(t)).filter((t) => t > 0);
      if (!ts.length) throw new Error('나눌 시간이 없습니다');
      if (clip_ids?.length) for (const c of needClips(clip_ids)) edit.cutClipAt(c.id, ts);
      else for (const t of ts) edit.addEdit({ allTracks: true, t });
      return { splits: ts.length };
    },
    summary: (r) => `${r.splits}곳`,
  },
  {
    name: 'edit_text',
    label: '자막·글자 고치기',
    description: '텍스트 클립(자막·제목)의 내용을 바꿉니다. 맞춤법 교정, 번역 바꿔 넣기, 잘못 들은 말 고치기에 씁니다.',
    parameters: O({ edits: A(O({ clip_id: S('텍스트 클립 id'), text: S('새 내용') }, ['clip_id', 'text']), '바꿀 내용') }, ['edits']),
    run({ edits }) {
      const s = seqOf();
      const ok = (edits || []).filter((e) => s.clips[e.clip_id]?.kind === 'text' && typeof e.text === 'string');
      if (!ok.length) throw new Error('바꿀 텍스트 클립이 없습니다');
      store.transact('AI: 자막 고치기', () => {
        for (const e of ok) {
          const c = s.clips[e.clip_id];
          c.effects.find((x) => x.type === 'text').params.content.value = e.text;
          c.name = e.text.split('\n')[0].slice(0, 40) || c.name;
        }
      });
      return { changed: ok.length, skipped: (edits || []).length - ok.length };
    },
    summary: (r) => `${r.changed}개`,
  },
  {
    name: 'add_captions',
    label: '자막 트랙 추가',
    description: '새 비디오 트랙에 자막(화면 아래, 반투명 배경)을 넣습니다. 번역 자막이나 직접 만든 자막에 씁니다.',
    parameters: O({ cues: A(O({ start: N('시작(초)'), end: N('끝(초)'), text: S('자막 글자') }, ['start', 'end', 'text']), '자막들') }, ['cues']),
    run({ cues }) {
      const list = (cues || [])
        .map((c) => ({ start: timeIn(c.start), end: timeIn(c.end), text: String(c.text || '').trim() }))
        .filter((c) => c.text && c.end > c.start)
        .sort((a, b) => a.start - b.start);
      if (!list.length) throw new Error('넣을 자막이 없습니다');
      createCaptionTrack(list, 'AI: 자막 추가');
      return { added: list.length };
    },
    summary: (r) => `${r.added}개`,
  },
  {
    name: 'add_title',
    label: '제목·글자 넣기',
    description: '화면에 글자(제목, 강조 문구 등)를 넣습니다.',
    parameters: O({
      text: S('글자'), start: N('시작(초)'), end: N('끝(초)'),
      position: S('위치', { enum: ['top', 'center', 'bottom'] }),
      style_id: S('글자 스타일', { enum: TEXT_STYLES.map((t) => t.id) }),
      animation_in: S('등장 애니메이션 (없으면 생략)', { enum: ANIM_IDS.in }),
    }, ['text', 'start', 'end']),
    run({ text, start, end, position = 'center', style_id, animation_in }) {
      const s = seqOf();
      const a = snapFrame(timeIn(start, 'start'), s.fps);
      const b = Math.max(a + 0.5, snapFrame(timeIn(end, 'end'), s.fps));
      let id = null;
      store.transact('AI: 글자 넣기', () => {
        const track = freeVideoTrack(a, b);
        const c = createClip(s, { kind: 'text', trackId: track.id, name: String(text).split('\n')[0].slice(0, 40), start: a, duration: b - a });
        c.effects.find((e) => e.type === 'text').params.content.value = String(text);
        c.effects.find((e) => e.type === 'motion').params.posY.value = Math.round(s.height * (POS_Y[position] ?? 0.5));
        s.clips[c.id] = c;
        id = c.id;
        if (style_id) applyTextStyle([c.id], style_id);
        if (animation_in) applyAnimation([c.id], 'in', animation_in, 0.6);
      });
      return { clip_id: id };
    },
    summary: () => '',
  },
  {
    name: 'add_markers',
    label: '마커 찍기',
    description: '시퀀스에 마커(표시)를 찍습니다. 중요한 순간, 하이라이트 후보, 확인할 곳 표시에 씁니다.',
    parameters: O({ markers: A(O({ time: N('시간(초)'), name: S('이름'), comment: S('설명') }, ['time', 'name']), '마커들') }, ['markers']),
    run({ markers }) {
      const s = seqOf();
      const list = (markers || []).filter((m) => Number.isFinite(Number(m.time)));
      if (!list.length) throw new Error('찍을 마커가 없습니다');
      store.transact('AI: 마커', () => {
        for (const m of list) s.markers.push({ id: uid('mk'), time: snapFrame(timeIn(m.time), s.fps), name: String(m.name || 'AI').slice(0, 60), color: '#a78bfa', comment: String(m.comment || '') });
        s.markers.sort((x, y) => x.time - y.time);
      });
      return { added: list.length };
    },
    summary: (r) => `${r.added}개`,
  },
  {
    name: 'apply_filter',
    label: '필터',
    description: `영상·사진 클립에 색 필터를 입힙니다. filter_id: ${FILTERS.map((f) => `${f.id}(${f.name})`).join(', ')}. none은 필터 지우기.`,
    parameters: O({ clip_ids: IDS, filter_id: S('필터', { enum: FILTERS.map((f) => f.id) }), amount: N('강도 10~100 (기본 100)') }, ['clip_ids', 'filter_id']),
    run({ clip_ids, filter_id, amount = 100 }) {
      if (!FILTERS.some((f) => f.id === filter_id)) throw new Error(`없는 필터입니다: ${filter_id}`);
      const list = needClips(clip_ids, ['video', 'image', 'nest', 'text', 'shape', 'color']);
      applyFilter(list.map((c) => c.id), filter_id, clamp(Number(amount) || 100, 10, 100));
      return { clips: list.length };
    },
    summary: (r) => `${r.clips}개`,
  },
  {
    name: 'apply_animation',
    label: '애니메이션',
    description: `클립에 움직임을 넣습니다. kind=in(등장): ${ANIM_IDS.in.join(', ')} / out(퇴장): ${ANIM_IDS.out.join(', ')} / loop(계속): ${ANIM_IDS.loop.join(', ')}`,
    parameters: O({ clip_ids: IDS, kind: S('종류', { enum: ['in', 'out', 'loop'] }), preset_id: S('움직임 id'), duration: N('등장/퇴장 길이(초, 기본 0.6)') }, ['clip_ids', 'kind', 'preset_id']),
    run({ clip_ids, kind, preset_id, duration = 0.6 }) {
      if (!ANIM_IDS[kind]?.includes(preset_id)) throw new Error(`없는 움직임입니다: ${kind}/${preset_id}`);
      const list = needClips(clip_ids);
      const n = applyAnimation(list.map((c) => c.id), kind, preset_id, clamp(Number(duration) || 0.6, 0.1, 5));
      return { clips: n };
    },
    summary: (r) => `${r.clips}개`,
  },
  {
    name: 'set_volume',
    label: '볼륨',
    description: '소리 클립(영상의 소리 포함)의 볼륨을 dB로 정합니다. 0은 원래 크기, -6은 절반쯤, -60은 거의 안 들림.',
    parameters: O({ clip_ids: IDS, gain_db: N('볼륨 (dB, -60~15)') }, ['clip_ids', 'gain_db']),
    run({ clip_ids, gain_db }) {
      const s = seqOf();
      const audio = new Set();
      for (const c of needClips(clip_ids)) {
        if (c.kind === 'audio') audio.add(c);
        for (const l of linkedClips(s, c)) if (l.kind === 'audio') audio.add(l);
      }
      if (!audio.size) throw new Error('소리가 있는 클립이 없습니다');
      const db = clamp(Number(gain_db) || 0, -60, 15);
      store.transact('AI: 볼륨', () => {
        for (const c of audio) {
          const p = c.effects.find((e) => e.type === 'volume')?.params.level;
          if (p) {
            p.value = db;
            p.kf = null;
          }
        }
      });
      return { clips: audio.size, gain_db: db };
    },
    summary: (r) => `${r.clips}개 → ${r.gain_db} dB`,
  },
  {
    name: 'set_speed',
    label: '속도',
    description: '클립 속도를 바꿉니다(100 = 원래 속도, 200 = 2배 빠르게, 50 = 슬로모션). close_gaps가 true면 길이 변화에 맞춰 뒤쪽을 당기거나 밉니다.',
    parameters: O({ clip_ids: IDS, speed_percent: N('속도 % (10~1000)'), close_gaps: B('뒤쪽 클립을 따라 움직일지 (기본 true)') }, ['clip_ids', 'speed_percent']),
    run({ clip_ids, speed_percent, close_gaps = true }) {
      const list = needClips(clip_ids, ['video', 'audio', 'nest']);
      const speed = clamp(Number(speed_percent) || 100, 10, 1000) / 100;
      edit.setSpeed(list.map((c) => c.id), { speed, ripple: close_gaps !== false });
      return { clips: list.length, speed_percent: Math.round(speed * 100) };
    },
    summary: (r) => `${r.clips}개 → ${r.speed_percent}%`,
  },
  {
    name: 'add_transition',
    label: '전환',
    description: `영상 클립의 시작(start) 또는 끝(end)에 전환 효과를 넣습니다. type: ${VIDEO_TRANSITIONS.join(', ')}`,
    parameters: O({ clip_id: S('영상 클립 id'), side: S('위치', { enum: ['start', 'end'] }), type: S('전환', { enum: VIDEO_TRANSITIONS }), duration: N('길이(초, 기본 0.6)') }, ['clip_id', 'side', 'type']),
    run({ clip_id, side, type, duration = 0.6 }) {
      const [c] = needClips([clip_id], ['video', 'image', 'nest', 'text', 'shape', 'color']);
      if (!VIDEO_TRANSITIONS.includes(type)) throw new Error(`없는 전환입니다: ${type}`);
      edit.applyTransition(c.id, side === 'end' ? 'out' : 'in', type, clamp(Number(duration) || 0.6, 0.1, 5));
      return { ok: true };
    },
    summary: () => '',
  },
  {
    name: 'add_sticker',
    label: '스티커',
    description: '이모지 스티커를 화면에 3초 동안 띄웁니다.',
    parameters: O({ emoji: S('이모지 한 개'), time: N('시작(초)') }, ['emoji', 'time']),
    run({ emoji, time }) {
      const id = addSticker(String(emoji).slice(0, 8), timeIn(time));
      return { clip_id: id };
    },
    summary: () => '',
  },
  {
    name: 'set_aspect_ratio',
    label: '화면 비율',
    description: '시퀀스 화면 비율을 바꿉니다 (세로 쇼츠는 9:16).',
    parameters: O({ ratio: S('비율', { enum: ASPECTS.map((a) => a[0]) }) }, ['ratio']),
    run({ ratio }) {
      if (!ASPECTS.some((a) => a[0] === ratio)) throw new Error(`없는 비율입니다: ${ratio}`);
      setAspect(ratio);
      return { ratio };
    },
    summary: (r) => r.ratio,
  },
  {
    name: 'move_playhead',
    label: '재생헤드 이동',
    description: '재생헤드를 옮깁니다(사용자에게 특정 위치를 보여 줄 때).',
    parameters: O({ time: N('시간(초)') }, ['time']),
    run({ time }) {
      store.setPlayhead(timeIn(time));
      return { ok: true };
    },
    summary: () => '',
  },
];

const TOOL_BY_NAME = Object.fromEntries(AI_TOOLS.map((t) => [t.name, t]));
const DECLARATIONS = [{ functionDeclarations: AI_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })) }];

const SYSTEM = [
  '당신은 브라우저 영상 편집기 "Montage" 안의 편집 도우미입니다. 사용자는 한국어로 요청합니다.',
  '- 당신은 영상 화면과 소리를 직접 보거나 듣지 못합니다. 매 요청에 함께 오는 타임라인 정보(트랙, 클립 이름·시간, 자막·글자 내용, 마커)만 압니다. 장면 내용이 필요한 요청인데 자막이 없으면, 먼저 "자동 자막"을 만들라고 안내하세요.',
  '- 편집은 반드시 도구(함수)로 하세요. 시간은 모두 시퀀스 시간(초)입니다. 클립은 clips[].id로 가리킵니다.',
  '- 하이라이트·요약 편집은 자막 내용을 근거로 남길 부분을 정하고, 나머지를 cut_time_ranges로 잘라 내세요. 잘라 낼 구간은 서로 겹치지 않게, 말 중간을 끊지 않게 자막 경계에 맞추세요.',
  '- 여러 도구를 차례로 써도 됩니다. 이번 요청의 모든 편집은 실행 취소(Ctrl+Z) 한 번으로 되돌릴 수 있습니다.',
  '- 할 수 없는 일(영상 생성, 화면 속 물체 인식, 소리 분리 등)은 할 수 없다고 말하고 편집기에서 직접 할 방법을 알려 주세요.',
  '- 끝나면 무엇을 했는지 짧게 한국어로 알려 주세요. 제목·설명·해시태그처럼 글만 필요한 요청은 도구 없이 답하세요. 확실하지 않은 내용은 확실하지 않다고 말하세요.',
].join('\n');

/**
 * Run one assistant request. history: [{role:'user'|'model', text}] of earlier turns.
 * onEvent({type:'tool', name, label, args, result|error}) for each tool call.
 * Returns {text}. All edits made during the request are merged into one undo step.
 */
export async function runAssistant(prompt, { history = [], onEvent = () => {}, signal, maxRounds = 10 } = {}) {
  const contents = history.slice(-8).map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  contents.push({ role: 'user', parts: [{ text: `[현재 타임라인 정보]\n${JSON.stringify(timelineContext())}\n\n[요청]\n${prompt}` }] });
  const mark = store.undoMark();
  let edits = 0;
  try {
    for (let round = 0; round < maxRounds; round++) {
      const d = await generate({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools: DECLARATIONS, generationConfig: { temperature: 0.2 } }, signal);
      const cand = firstCandidate(d);
      // keep the model turn exactly as returned (Gemini needs its thought signatures back)
      contents.push(cand.content);
      const calls = (cand.content.parts || []).filter((p) => p.functionCall);
      if (!calls.length) return { text: textOf(cand.content) || '(답이 비어 있습니다)', edits };
      const responses = [];
      for (const { functionCall: fc } of calls) {
        const tool = TOOL_BY_NAME[fc.name];
        let response;
        if (!tool) response = { error: `없는 도구입니다: ${fc.name}` };
        else {
          try {
            const result = tool.run(fc.args || {}) || {};
            edits++;
            response = { result };
            onEvent({ type: 'tool', name: fc.name, label: tool.label, args: fc.args, result, summary: tool.summary(result) });
          } catch (err) {
            response = { error: String(err?.message || err) };
            onEvent({ type: 'tool', name: fc.name, label: tool.label, args: fc.args, error: response.error });
          }
        }
        responses.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response } });
      }
      // the edits changed the timeline: hand the new picture back with the last result
      if (edits) responses[responses.length - 1].functionResponse.response.timeline_after = timelineContext();
      contents.push({ role: 'user', parts: responses });
    }
    return { text: '요청이 길어져 중간에 멈췄습니다. 지금까지 한 편집은 남아 있습니다.', edits };
  } finally {
    store.squashSince(mark, `AI 편집: ${prompt.slice(0, 24)}`);
  }
}
