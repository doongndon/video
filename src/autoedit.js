// "AI 전체 편집": one request that edits the whole sequence — aspect ratio, silence cuts, captions,
// a Gemini pass that reads the captions (trims to a target length, opening title, emphasis
// titles, stickers, caption fixes, chapter markers), then transitions, colour filter, caption
// style and background-music ducking. Without a Gemini key the creative pass falls back to simple
// rules. Everything ends up as one undo step.

import { store } from './store.js';
import * as edit from './edit.js';
import { clipEnd, clipsOnTrack, sequenceDuration, videoTracks } from './model.js';
import { mediaStatus, getRuntime } from './media.js';
import {
  applyFilter, applyTextStyle, applyAnimation, setAspect, setPip, cutSilence, soundIntervals, FILTERS,
} from './features.js';
import { transcribeSequence, createCaptionTrack, stripSoundTags, splitCues } from './captions.js';
import { geminiSettings, runAssistant, transcribeWithGemini, AI_TOOLS } from './ai.js';

export const AUTO_STYLES = [
  { id: 'vlog', name: '브이로그', desc: '따뜻한 색감 · 부드러운 전환 · 손글씨 제목', filter: 'warm', caption: 'subtitle', title: 'note', titleAnim: 'slideUp', transition: 'crossDissolve', stickers: false },
  { id: 'shorts', name: '쇼츠·릴스', desc: '세로 9:16 · 60초 이내 · 큰 예능 자막 · 빠른 전환', aspect: '9:16', targetLen: 60, filter: 'vivid', caption: 'variety', title: 'outline', titleAnim: 'pop', transition: 'whip', stickers: true },
  { id: 'info', name: '정보·강의', desc: '깔끔한 자막 · 장마다 마커 · 효과는 최소로', filter: 'none', caption: 'subtitle', title: 'news', titleAnim: 'fade', transition: 'crossDissolve', stickers: false, chapters: true },
  { id: 'travel', name: '감성·여행', desc: '필름 색감 · 사진은 천천히 확대 · 디졸브', filter: 'film', caption: 'plain', title: 'plain', titleAnim: 'fade', transition: 'crossDissolve', stickers: false, kenBurns: true },
  { id: 'fun', name: '예능·재미', desc: '선명한 색 · 노란 자막 · 강조 문구와 스티커', filter: 'vivid', caption: 'variety', title: 'variety', titleAnim: 'elastic', transition: 'push', stickers: true },
];

export const AUTO_STEPS = [
  ['aspect', '화면 비율 맞추기', '스타일에 정해진 비율이 있을 때(쇼츠는 9:16)'],
  ['silence', '말 없는 구간 잘라내기', '조용한 부분을 잘라 붙입니다 (점프 컷)'],
  ['captions', '자막 만들기', '자막이 없으면 음성 인식으로 만듭니다'],
  ['ai', 'AI 내용 편집', '자막을 읽고 길이 맞추기·제목·강조 문구·스티커·맞춤법 (Gemini 키 필요)'],
  ['transitions', '전환 효과', '컷 사이에 스타일에 맞는 전환'],
  ['filter', '색 필터', '스타일에 맞는 색감'],
  ['captionStyle', '자막 꾸미기', '스타일에 맞는 자막 모양'],
  ['music', '배경음악 정리', '말할 때 음악 줄이기 · 끝에 맞춰 자르고 페이드 아웃'],
];

const visualKinds = new Set(['video', 'image', 'nest']);

/** Audio clips that come with camera footage (speech) vs standalone audio files (music, when both exist). */
function audioRoles(s) {
  const audio = Object.values(s.clips).filter((c) => c.kind === 'audio' && c.enabled !== false);
  const linked = audio.filter((c) => c.linkId);
  const standalone = audio.filter((c) => !c.linkId);
  // only footage-less audio → it is the speech (voice-over, podcast); with footage it is music
  if (!linked.length) return { speech: standalone, music: [] };
  return { speech: linked, music: standalone };
}

/** The video track holding the most text clips (the caption track), or null. */
export function captionTrackId(s) {
  let best = null;
  let n = 1;
  for (const t of videoTracks(s)) {
    const k = clipsOnTrack(s, t.id).filter((c) => c.kind === 'text').length;
    if (k > n) {
      best = t.id;
      n = k;
    }
  }
  return best;
}

function mainVideoTrack(s) {
  let best = null;
  let dur = 0;
  for (const t of videoTracks(s)) {
    const d = clipsOnTrack(s, t.id).filter((c) => visualKinds.has(c.kind)).reduce((a, c) => a + c.duration, 0);
    if (d > dur) {
      best = t.id;
      dur = d;
    }
  }
  return best;
}

function buildPrompt(style, opts, { hasCaptions, hasScenes }) {
  const known = hasCaptions || hasScenes;
  const basis = hasCaptions && hasScenes ? '자막(말 내용)과 장면 사진(화면 내용)' : hasCaptions ? '자막(말 내용)' : '장면 사진(화면 내용)';
  const lines = [`[전체 편집 요청] 스타일: ${style.name} (${style.desc}).`];
  lines.push(`아래 일을 순서대로 해 줘. ${known ? `${basis}을 근거로 판단하고, ` : ''}확실하지 않은 편집은 하지 마.`);
  let n = 1;
  if (!known) lines.push('(자막도 장면 사진도 없어 내용은 알 수 없음. 내용에 따른 자르기·강조는 하지 말고 제목만 넣어.)');
  if (hasCaptions && opts.mistakes) lines.push(`${n++}) 말을 더듬거나 같은 말을 되풀이한 부분, "음/어" 같은 군더더기를 찾아.`);
  if (hasScenes) lines.push(`${n++}) 장면 사진을 보고 흔들리거나 초점이 나갔거나 너무 어둡거나 아무것도 안 나오는(바닥·주머니 등) 구간을 찾아.`);
  if (known && opts.targetLen) lines.push(`${n++}) 덜 중요하거나 지루한 부분을 골라 전체 길이가 약 ${opts.targetLen}초가 되게 해. 지금 길이가 이미 그보다 짧으면 이 단계는 건너뛰어.${hasCaptions ? ' 말 중간을 끊지 말고 자막 경계에 맞춰.' : ''}`);
  if (known && (opts.mistakes || hasScenes || opts.targetLen)) lines.push(`${n++}) 위에서 찾은 잘라 낼 구간을 겹치지 않게 모아 cut_time_ranges 한 번으로 잘라 내.`);
  if (opts.title) lines.push(`${n++}) 영상 맨 앞(0초~3초)에 내용을 요약한 짧은 제목(15자 이내)을 add_title로 넣어. position=${style.aspect === '9:16' ? 'top' : 'center'}, style_id=${style.title}, animation_in=${style.titleAnim}.${hasScenes ? ' 화면에 중요한 것이 가려지지 않는 위치를 골라.' : ''}`);
  if (known && opts.emphasis) {
    lines.push(`${n++}) 강조할 만한 순간 2~4곳에 2~3초짜리 짧은 강조 문구(10자 이내)를 add_title로 넣어. position=top, style_id=${style.caption === 'variety' ? 'marker' : 'outline'}, animation_in=pop.${style.stickers ? ' 그중 1~3곳에는 어울리는 이모지 스티커도 add_sticker로 넣어.' : ''}`);
  }
  if (known && style.chapters) lines.push(`${n++}) 주제나 장면이 바뀌는 곳마다 add_markers로 챕터 마커를 찍어(이름은 짧게).`);
  if (hasCaptions && opts.spelling) lines.push(`${n++}) 자막 맞춤법·띄어쓰기가 틀린 줄만 edit_text로 고쳐. 말투와 뜻은 바꾸지 마.${hasScenes ? ' 화면에 보이는 이름·글자와 다르게 받아 적힌 말도 고쳐.' : ''}`);
  lines.push('잘라 낸 뒤에는 timeline_after의 시간을 써. 화면 비율·필터·전환·자막 모양·배경음악은 편집기가 따로 처리하니 하지 마.');
  lines.push('끝나면 한 일을 짧게 요약하고, 마지막 줄에 "제목 후보: ..." 형식으로 영상 제목 후보 1개를 적어 줘.');
  if (opts.extra) lines.push(`[사용자의 추가 요청] ${opts.extra}`);
  return lines.join('\n');
}

/**
 * Run the whole-video edit. opts: {style, steps:Set, targetLen, extra, mistakes, title, emphasis, spelling}.
 * onStep(id, state, message) with state 'run' | 'done' | 'skip' | 'fail'. Returns {text, results}.
 */
export async function runAutoEdit(opts, { onStep = () => {}, signal } = {}) {
  const s = store.seq;
  const style = AUTO_STYLES.find((x) => x.id === opts.style) || AUTO_STYLES[0];
  const want = (id) => opts.steps.has(id);
  if (!Object.values(s.clips).some((c) => visualKinds.has(c.kind) || c.kind === 'audio')) throw new Error('타임라인에 영상이나 소리 클립을 먼저 넣으세요');
  const results = {};
  let aiText = '';
  const mark = store.undoMark();
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error('멈춤'), { name: 'AbortError' });
  };
  const step = async (id, fn) => {
    check();
    if (!want(id)) {
      onStep(id, 'skip', '');
      return;
    }
    onStep(id, 'run', '');
    try {
      const msg = await fn();
      results[id] = msg;
      onStep(id, msg?.skipped ? 'skip' : 'done', msg?.text ?? msg ?? '');
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      results[id] = { error: String(err?.message || err) };
      onStep(id, 'fail', String(err?.message || err));
    }
  };
  try {
    await step('aspect', () => {
      if (!style.aspect) return { skipped: true, text: '이 스타일은 비율을 바꾸지 않습니다' };
      if (`${s.width}:${s.height}` === '1080:1920' && style.aspect === '9:16') return { skipped: true, text: '이미 9:16입니다' };
      setAspect(style.aspect);
      const vis = Object.values(store.seq.clips).filter((c) => visualKinds.has(c.kind)).map((c) => c.id);
      if (vis.length) setPip(vis, 'fill');
      return `${style.aspect}로 바꾸고 영상이 화면을 채우게 했습니다(가운데 기준으로 잘림)`;
    });

    await step('silence', async () => {
      const seq = store.seq;
      const { speech, music } = audioRoles(seq);
      // waveforms are analysed in the background after import: wait for them a little
      const hasPeaks = (c) => c.mediaId && mediaStatus(c.mediaId) === 'ready' && getRuntime(c.mediaId).peaks;
      for (let i = 0; i < 40 && speech.some((c) => !hasPeaks(c)); i++) {
        onStep('silence', 'run', '소리 파형 분석을 기다리는 중…');
        await new Promise((r) => setTimeout(r, 250));
        check();
      }
      const ready = speech.filter(hasPeaks);
      if (!ready.length) return { skipped: true, text: '말소리 클립이 없거나 파형 분석이 아직 안 끝났습니다' };
      const musicTracks = new Set(music.map((c) => c.trackId));
      const trackIds = seq.tracks.filter((t) => !musicTracks.has(t.id)).map((t) => t.id);
      const r = cutSilence(ready.map((c) => c.id), { thresholdDb: -40, minSilence: 0.8, pad: 0.15, trackIds });
      if (!r) return { skipped: true, text: '파형 분석이 아직 안 끝났습니다' };
      return r.cuts ? `${r.cuts}곳, ${r.removed.toFixed(1)}초를 잘라 냈습니다${music.length ? ' (배경음악은 끊지 않음)' : ''}` : { skipped: true, text: '자를 만큼 긴 침묵이 없습니다' };
    });

    await step('captions', async () => {
      const seq = store.seq;
      if (captionTrackId(seq)) return { skipped: true, text: '이미 자막이 있습니다' };
      if (!Object.values(seq.clips).some((c) => c.kind === 'audio' && c.enabled !== false)) return { skipped: true, text: '소리가 없습니다' };
      const end = sequenceDuration(seq);
      const onStatus = (text) => onStep('captions', 'run', text);
      let cues = geminiSettings.key
        ? await transcribeWithGemini({ seq, start: 0, end, language: opts.language || 'korean', onStatus, signal })
        : await transcribeSequence({ seq, start: 0, end, model: 'onnx-community/whisper-base', language: opts.language || 'korean', onStatus });
      cues = splitCues(stripSoundTags(cues).cues, style.aspect === '9:16' ? 16 : 28);
      if (!cues.length) return { skipped: true, text: '알아들은 말이 없습니다' };
      createCaptionTrack(cues, '자동 자막');
      return `자막 ${cues.length}줄 (${geminiSettings.key ? 'Gemini' : 'Whisper'})`;
    });

    await step('ai', async () => {
      const hasCaptions = !!captionTrackId(store.seq);
      if (geminiSettings.key) {
        const musicTracks = [...new Set(audioRoles(store.seq).music.map((c) => c.trackId))];
        const hasScenes = geminiSettings.scenes !== 'off';
        const res = await runAssistant(buildPrompt(style, opts, { hasCaptions, hasScenes }), {
          signal,
          maxRounds: 12,
          keepTrackIds: musicTracks,
          scenes: hasScenes,
          onStatus: (text) => onStep('ai', 'run', text),
          onEvent: (ev) => onStep('ai', 'run', `${ev.error ? '✗' : '✓'} ${ev.label}${ev.summary ? ` — ${ev.summary}` : ''}`),
        });
        aiText = res.text;
        return `Gemini가 편집 ${res.edits}번을 했습니다`;
      }
      // no key: an opening title from the project name, nothing that needs understanding the content
      const name = store.project.name && !/제목 없는/.test(store.project.name) ? store.project.name : '';
      if (!opts.title || !name) return { skipped: true, text: 'Gemini 키가 없어 내용 편집은 건너뜁니다(설정에서 키를 넣으면 됩니다)' };
      AI_TOOLS.find((t) => t.name === 'add_title').run({ text: name.slice(0, 20), start: 0, end: 3, position: style.aspect === '9:16' ? 'top' : 'center', style_id: style.title, animation_in: style.titleAnim });
      return '키가 없어 프로젝트 이름으로 오프닝 제목만 넣었습니다';
    });

    await step('transitions', () => {
      const seq = store.seq;
      const tid = mainVideoTrack(seq);
      if (!tid) return { skipped: true, text: '영상 트랙이 없습니다' };
      const list = clipsOnTrack(seq, tid).filter((c) => visualKinds.has(c.kind));
      let n = 0;
      for (let i = 1; i < list.length; i++) {
        if (Math.abs(list[i].start - clipEnd(list[i - 1])) > 1 / seq.fps) continue;
        if (list[i].transIn || list[i - 1].transOut) continue;
        // very short pieces (jump cuts) get a short transition
        const d = Math.min(style.transition === 'crossDissolve' ? 0.5 : 0.35, list[i].duration / 3, list[i - 1].duration / 3);
        if (d < 2 / seq.fps) continue;
        edit.applyTransition(list[i].id, 'in', style.transition, d);
        n++;
      }
      if (list.length) {
        if (!list[0].transIn) edit.applyTransition(list[0].id, 'in', 'dipToBlack', Math.min(0.5, list[0].duration / 3));
        const last = store.seq.clips[list[list.length - 1].id];
        if (last && !last.transOut) edit.applyTransition(last.id, 'out', 'dipToBlack', Math.min(0.8, last.duration / 3));
      }
      return `컷 사이 ${n}곳 + 처음·끝 페이드`;
    });

    await step('filter', () => {
      if (style.filter === 'none') return { skipped: true, text: '이 스타일은 필터를 쓰지 않습니다' };
      const ids = Object.values(store.seq.clips).filter((c) => visualKinds.has(c.kind)).map((c) => c.id);
      if (!ids.length) return { skipped: true, text: '영상·사진 클립이 없습니다' };
      applyFilter(ids, style.filter, 80);
      if (style.kenBurns) {
        const imgs = Object.values(store.seq.clips).filter((c) => c.kind === 'image').map((c) => c.id);
        imgs.forEach((id, i) => applyAnimation([id], 'loop', i % 2 ? 'kenOut' : 'kenIn'));
      }
      return `${FILTERS.find((f) => f.id === style.filter)?.name} ${ids.length}개`;
    });

    await step('captionStyle', () => {
      const seq = store.seq;
      const tid = captionTrackId(seq);
      if (!tid) return { skipped: true, text: '자막이 없습니다' };
      const ids = clipsOnTrack(seq, tid).filter((c) => c.kind === 'text').map((c) => c.id);
      applyTextStyle(ids, style.caption);
      store.transact('자막 위치', () => {
        for (const id of ids) {
          const c = seq.clips[id];
          const tx = c.effects.find((e) => e.type === 'text');
          const m = c.effects.find((e) => e.type === 'motion');
          tx.params.size.value = Math.round(Math.min(seq.width, seq.height) * (style.aspect === '9:16' ? 0.075 : 0.05));
          m.params.posY.value = Math.round(seq.height * (style.aspect === '9:16' ? 0.72 : 0.86));
          m.params.posX.value = Math.round(seq.width / 2);
        }
      });
      return `${ids.length}줄`;
    });

    await step('music', () => {
      const seq = store.seq;
      const { speech, music } = audioRoles(seq);
      if (!music.length) return { skipped: true, text: '배경음악(따로 넣은 소리 파일)이 없습니다' };
      const end = Math.max(0, ...Object.values(seq.clips).filter((c) => c.kind !== 'audio' || c.linkId).map(clipEnd));
      let trimmed = 0;
      store.transact('음악 끝 맞추기', () => {
        for (const c of music) {
          const cur = seq.clips[c.id];
          if (!cur) continue;
          if (cur.start >= end - 1e-3) {
            delete seq.clips[c.id];
            trimmed++;
          } else if (clipEnd(cur) > end + 1e-3) {
            cur.duration = end - cur.start;
            trimmed++;
          }
        }
      });
      const left = music.map((c) => seq.clips[c.id]).filter(Boolean);
      const last = left.sort((a, b) => clipEnd(b) - clipEnd(a))[0];
      if (last && !last.transOut) edit.applyTransition(last.id, 'out', 'constantPower', Math.min(2, last.duration / 3));
      const speechTracks = [...new Set(speech.map((c) => c.trackId))];
      let ducked = 0;
      if (speechTracks.length) {
        const iv = soundIntervals(store.seq, speechTracks, -32);
        if (iv.length) ducked = edit.autoDuck(left.map((c) => c.id), iv, { duckDb: -12 });
      }
      return `음악 ${left.length}개${trimmed ? ' · 끝에 맞춰 자름' : ''}${ducked ? ' · 말할 때 줄임' : ''} · 페이드 아웃`;
    });
  } finally {
    store.squashSince(mark, `AI 전체 편집 (${style.name})`);
  }
  return { text: aiText, results };
}

