// Modal dialogs: speed/duration, markers, sequence settings, export, captions, multicam,
// auto ducking, auto reframe, auto captions, shortcuts and the getting-started guide.

import { store } from '../store.js';
import * as edit from '../edit.js';
import { h, formatTimecode, parseTimecode, formatBytes, downloadBlob, clamp, dbToGain } from '../util.js';
import { openModal, formRow, toast, showPanel } from './common.js';
import { FORMATS, EXPORT_PRESETS, exportRange, exportSequence, exportFrame } from '../export.js';
import { createSyntheticMedia, detectScenes, mediaStatus, getRuntime, audioSyncOffsets, AUDIO_FILE_FORMATS, audioFileFormatSupport, extractAudioFile, importFiles } from '../media.js';
import { clipEnd, clipsOnTrack, videoTracks, audioTracks, isTimed, mediaTimeAt, hasSpeedRamp, sourceOut } from '../model.js';
import { ASR_MODELS, ASR_LANGUAGES, transcribeSequence, createCaptionTrack, stripSoundTags } from '../captions.js';
import { geminiSettings, transcribeWithGemini } from '../ai.js';
import { silentIntervals, cutSilence, detectBeats, addBeatMarkers, createSlideshow } from '../features.js';
import { TRANSITIONS } from '../effects.js';

const note = (...t) => h('div.note', ...t);
const check = (checked, label, attrs = {}) => {
  const box = h('input', { type: 'checkbox', checked, ...attrs });
  return { box, el: h('label.check', box, ` ${label}`) };
};
const select = (options, value) => h('select', options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
const progressBar = () => {
  const bar = h('div');
  return { bar, el: h('div.progress', bar), set: (f) => { bar.style.width = `${Math.round(clamp(f, 0, 1) * 100)}%`; } };
};

// ---------------------------------------------------------------- speed / duration

export function openSpeedDialog(ids) {
  const s = store.seq;
  const clips = ids.map((id) => s.clips[id]).filter(Boolean);
  if (!clips.length) return;
  const c = clips[0];
  const timed = isTimed(c);
  const speed = h('input', { type: 'number', value: Math.round(c.speed * 10000) / 100, min: 1, max: 10000, step: 1, style: { width: '96px' }, disabled: !timed });
  const dur = h('input', { type: 'text', value: formatTimecode(c.duration, s.fps), style: { width: '120px' } });
  const link = check(true, '속도와 길이를 함께 바꾸기', { disabled: !timed });
  const reverse = check(!!c.reverse, '거꾸로 재생 (역재생)', { disabled: !timed });
  const pitch = check(c.maintainPitch !== false, '음 높이 유지 (빠르게/느리게 해도 목소리 톤 그대로)', { disabled: !timed });
  const hold = check(!!c.hold, '프레임 고정 (시작 프레임에서 멈춘 화면)', { disabled: c.kind !== 'video' });
  const ripple = check(false, '뒤에 있는 클립도 함께 밀거나 당기기 (잔물결 편집)');
  const srcLen = c.duration * c.speed;
  speed.addEventListener('input', () => {
    const v = parseFloat(speed.value) / 100;
    if (link.box.checked && v > 0) dur.value = formatTimecode(srcLen / v, s.fps);
  });
  dur.addEventListener('change', () => {
    const d = parseTimecode(dur.value, s.fps);
    if (link.box.checked && d > 0 && timed) speed.value = Math.round((srcLen / d) * 10000) / 100;
  });
  const quick = h('div.inline', [25, 50, 100, 200, 400].map((p) => h('button.small', {
    onclick: () => {
      speed.value = p;
      speed.dispatchEvent(new Event('input'));
    },
  }, `${p}%`)));
  openModal({
    title: `클립 속도 / 지속 시간${clips.length > 1 ? ` (${clips.length}개)` : ''}`,
    body: [
      formRow('속도 (%)', speed, quick),
      formRow('', link.el),
      formRow('지속 시간', dur),
      formRow('', reverse.el),
      formRow('', pitch.el),
      formRow('', hold.el),
      formRow('', ripple.el),
      clips.some(hasSpeedRamp) ? note('이 클립에는 속도 램프(시간 다시 매핑)가 있습니다. 여기서 정한 속도에 램프 값이 곱해집니다. 램프는 효과 컨트롤 ▸ 시간 다시 매핑에서 바꿉니다.') : null,
      note('100%가 원래 속도입니다. 50%는 절반 속도(슬로 모션), 200%는 두 배 속도입니다.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const sp = clamp((parseFloat(speed.value) || 100) / 100, 0.01, 100);
          const d = parseTimecode(dur.value, s.fps);
          edit.setSpeed(ids, {
            speed: timed ? sp : undefined,
            duration: !timed || !link.box.checked ? d : undefined,
            ripple: ripple.box.checked, hold: hold.box.checked, reverse: reverse.box.checked, maintainPitch: pitch.box.checked,
          });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- markers

const MARKER_COLORS = [['#4ade80', '초록'], ['#f87171', '빨강'], ['#a78bfa', '보라'], ['#fb923c', '주황'], ['#facc15', '노랑'], ['#ffffff', '흰색'], ['#60a5fa', '파랑'], ['#22d3ee', '청록']];

export function openMarkerDialog(id) {
  const s = store.seq;
  const mk = s.markers.find((m) => m.id === id);
  if (!mk) return;
  const name = h('input', { type: 'text', value: mk.name, style: { width: '100%' } });
  const time = h('input', { type: 'text', value: formatTimecode(mk.time, s.fps) });
  const comment = h('textarea', { rows: 3, style: { width: '100%' } }, mk.comment || '');
  let color = mk.color;
  const swatches = h('div.inline.swatches', MARKER_COLORS.map(([c, label]) => {
    const b = h('button.swatch-btn', { title: label, 'aria-label': label, style: { background: c }, 'aria-pressed': String(c === color) });
    b.addEventListener('click', () => {
      color = c;
      swatches.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
    });
    return b;
  }));
  openModal({
    title: '마커',
    body: [formRow('이름', name), formRow('시간', time), formRow('색상', swatches), formRow('메모', comment)],
    buttons: [
      { label: '삭제', action: () => edit.removeMarker(id) },
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          store.transact('마커 편집', () => {
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

const FRAME_PRESETS = [
  ['1920x1080', 'HD 1080p 가로 (16:9)'],
  ['1280x720', 'HD 720p 가로 (16:9)'],
  ['3840x2160', 'UHD 4K 가로 (16:9)'],
  ['2560x1440', 'QHD 1440p 가로 (16:9)'],
  ['1080x1920', '세로 쇼츠·릴스 (9:16)'],
  ['1080x1080', '정사각형 (1:1)'],
  ['1080x1350', '인스타 세로 (4:5)'],
  ['720x480', 'SD 720×480'],
  ['custom', '직접 입력'],
];
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export function openSequenceSettings() {
  const s = store.seq;
  const name = h('input', { type: 'text', value: s.name, style: { width: '100%' } });
  const cur = `${s.width}x${s.height}`;
  const preset = select(FRAME_PRESETS, FRAME_PRESETS.some(([v]) => v === cur) ? cur : 'custom');
  const w = h('input', { type: 'number', value: s.width, min: 16, max: 8192, step: 2, style: { width: '86px' } });
  const hh = h('input', { type: 'number', value: s.height, min: 16, max: 8192, step: 2, style: { width: '86px' } });
  const fps = h('select', RATES.map((r) => h('option', { value: r, selected: Math.abs(r - s.fps) < 0.01 }, `${r} fps`)));
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') return;
    const [a, b] = preset.value.split('x').map(Number);
    w.value = a;
    hh.value = b;
  });
  openModal({
    title: '시퀀스 설정',
    body: [
      formRow('이름', name),
      formRow('화면 크기', preset),
      formRow('', w, '×', hh),
      formRow('초당 프레임', fps),
      note('화면 크기를 바꾸면 클립 위치가 비율에 맞게 옮겨집니다. 클립은 기본적으로 화면에 맞춰집니다 (비율 100% = 화면 맞춤). 세로 영상용 복사본이 필요하면 시퀀스 ▸ 자동 리프레임을 쓰세요.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const W = clamp(Math.round((parseInt(w.value, 10) || 1920) / 2) * 2, 16, 8192);
          const H = clamp(Math.round((parseInt(hh.value, 10) || 1080) / 2) * 2, 16, 8192);
          edit.updateSequenceSettings({ width: W, height: H, fps: parseFloat(fps.value), name: name.value || s.name });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- export

const SCALE_OPTIONS = [['1', '원본 크기 (100%)'], ['0.75', '75%'], ['0.5', '50% (절반)'], ['0.25', '25%'], ['uhd', '4K 폭 (3840)'], ['gif', '480px 폭 (움짤용)'], ['2', '200% (확대)']];

function resolveScale(v, seq) {
  if (v === 'uhd') return 3840 / Math.max(seq.width, seq.height > seq.width ? seq.height * (16 / 9) : seq.width);
  if (v === 'gif') return Math.min(1, 480 / seq.width);
  return parseFloat(v) || 1;
}

export function openExportDialog() {
  const s = store.seq;
  const fileName = h('input', { type: 'text', value: (s.name || '시퀀스').replace(/[\\/:*?"<>|]+/g, '_'), style: { width: '100%' } });
  const format = select(Object.entries(FORMATS).map(([k, f]) => [k, f.label]), 'mp4');
  const hasInOut = s.inPoint != null || s.outPoint != null;
  const range = select([['all', '시퀀스 전체'], ['inout', '시작(In)~끝(Out) 표시 구간']], hasInOut ? 'inout' : 'all');
  const scale = select(SCALE_OPTIONS, '1');
  const quality = select([['very-high', '매우 높음 (파일 큼)'], ['high', '높음 (권장)'], ['medium', '보통'], ['low', '낮음 (파일 작음)']], 'high');
  const fps = select([['', `시퀀스와 같게 (${s.fps} fps)`], ['60', '60 fps'], ['30', '30 fps'], ['24', '24 fps'], ['15', '15 fps'], ['12', '12 fps'], ['10', '10 fps']], '');
  const audio = check(true, '소리 포함');
  const summary = note();
  const warn = h('div.note.warn');
  const prog = progressBar();
  const status = note('');
  let presetId = null;
  const presetBtns = EXPORT_PRESETS.map((p) => {
    const b = h('button.preset', { onclick: () => applyPreset(p) }, h('b', p.name), h('small', p.desc));
    b.dataset.id = p.id;
    return b;
  });
  const applyPreset = (p) => {
    presetId = p.id;
    format.value = p.format;
    scale.value = String(p.scale);
    quality.value = p.quality;
    fps.value = p.fps ? String(p.fps) : '';
    update();
  };
  const update = () => {
    const r = exportRange(range.value);
    const f = FORMATS[format.value];
    const sc = resolveScale(scale.value, s);
    const ow = Math.round((s.width * sc) / 2) * 2;
    const oh = Math.round((s.height * sc) / 2) * 2;
    const rate = parseFloat(fps.value) || s.fps;
    for (const b of presetBtns) b.classList.toggle('on', b.dataset.id === presetId);
    summary.textContent = f.still
      ? `재생헤드 위치(${formatTimecode(store.ui.playhead, s.fps)})의 화면 한 장을 PNG로 저장합니다 (${s.width}×${s.height}).`
      : `${f.audioOnly ? '소리만' : `${ow}×${oh} · ${rate} fps`} · ${formatTimecode(r.start, s.fps)} ~ ${formatTimecode(r.end, s.fps)} (${(r.end - r.start).toFixed(1)}초)`;
    scale.disabled = !!(f.audioOnly || f.still);
    quality.disabled = !!(f.audioOnly || f.still || f.gif);
    fps.disabled = !!(f.audioOnly || f.still);
    audio.box.disabled = !!(f.audioOnly || f.still || f.gif);
    range.disabled = !!f.still;
    const warnings = [];
    if (presetId === 'shorts' && s.width >= s.height) warnings.push('지금 시퀀스는 가로 화면입니다. 세로(9:16) 영상이 필요하면 먼저 시퀀스 ▸ 자동 리프레임으로 세로 시퀀스를 만드세요.');
    if (f.gif && (r.end - r.start) * rate > 600) warnings.push('GIF가 600프레임을 넘습니다. 시간이 오래 걸리고 파일이 매우 커질 수 있습니다. 시작/끝 표시로 구간을 줄이는 것을 권장합니다.');
    if (sc > 1.01 && !f.audioOnly && !f.still) warnings.push('원본보다 크게 내보내면 화질이 좋아지지는 않습니다 (확대만 됩니다).');
    warn.textContent = warnings.join(' ');
    warn.hidden = !warnings.length;
  };
  for (const el of [format, range, scale, quality, fps]) el.addEventListener('change', () => { presetId = null; update(); });
  update();
  const token = { cancelled: false };
  let running = false;
  const modal = openModal({
    title: '내보내기',
    width: '640px',
    body: [
      h('div.preset-grid', presetBtns),
      formRow('파일 이름', fileName),
      formRow('형식', format),
      formRow('범위', range),
      formRow('출력 크기', scale),
      formRow('화질', quality),
      formRow('프레임 속도', fps),
      formRow('', audio.el),
      summary,
      warn,
      prog.el,
      status,
      note('이 탭 안에서 프레임 단위로 렌더링합니다(WebCodecs). 끝날 때까지 탭을 열어 두세요. MP4(H.264)는 Chrome/Edge를 권장합니다.'),
    ],
    buttons: [
      { label: '닫기', action: () => { token.cancelled = true; } },
      {
        label: '내보내기', primary: true, action: async () => {
          if (running) return false;
          running = true;
          token.cancelled = false;
          const f = FORMATS[format.value];
          const btn = modal.footer.querySelector('button.primary');
          btn.disabled = true;
          try {
            let result;
            if (f.still) {
              status.textContent = '프레임을 그리는 중…';
              result = { blob: await exportFrame(), info: 'PNG' };
            } else {
              result = await exportSequence({
                format: format.value,
                scale: resolveScale(scale.value, s),
                quality: quality.value,
                fps: parseFloat(fps.value) || null,
                range: exportRange(range.value),
                audio: audio.box.checked,
                token,
                onProgress: (p, label) => {
                  prog.set(p);
                  status.textContent = label || '';
                },
              });
            }
            const name = `${fileName.value || 'export'}.${f.ext}`;
            prog.set(1);
            status.textContent = `${name} 완성 · ${formatBytes(result.blob.size)} · ${result.info}`;
            if (await downloadBlob(result.blob, name)) {
              status.textContent = `${name} 저장 · ${formatBytes(result.blob.size)} · ${result.info}`;
              toast(`${name} 파일을 내보냈습니다`);
            }
          } catch (err) {
            console.error(err);
            status.textContent = `내보내기 실패: ${err.message || err}`;
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
  const name = h('input', { type: 'text', value: '색상 매트' });
  openModal({
    title: '새 색상 매트 (단색 배경)',
    body: [formRow('색상', color), formRow('이름', name), note('프로젝트 패널에 단색 항목이 생깁니다. 타임라인으로 끌어다 배경으로 쓰세요.')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => createSyntheticMedia('color', { name: name.value || '색상 매트', color: color.value }) }],
  });
}

// ---------------------------------------------------------------- scene edit detection

export function openSceneDetectDialog() {
  const clip = store.selectedClips().find((c) => c.kind === 'video');
  if (!clip || mediaStatus(clip.mediaId) !== 'ready') {
    toast('영상 클립을 먼저 선택하세요');
    return;
  }
  const sens = h('input', { type: 'range', min: 5, max: 95, value: 60 });
  const mode = select([['cuts', '바뀌는 곳마다 클립 자르기'], ['markers', '바뀌는 곳마다 마커만 남기기']], 'cuts');
  const prog = progressBar();
  const status = note('클립을 초당 10장씩 살펴보며 색 분포가 크게 달라지는 곳을 찾습니다.');
  let running = false;
  openModal({
    title: '장면 전환 자동 감지',
    body: [formRow('동작', mode), formRow('민감도', h('span', '둔감'), sens, h('span', '민감')), prog.el, status],
    buttons: [
      { label: '닫기' },
      {
        label: '분석 시작', primary: true, action: async () => {
          if (running) return false;
          running = true;
          const c = store.seq.clips[clip.id];
          if (!c) return true;
          const a = c.inPoint;
          const b = c.inPoint + c.duration * c.speed;
          const threshold = 0.6 - (parseInt(sens.value, 10) / 100) * 0.5;
          status.textContent = '분석 중…';
          try {
            const cuts = await detectScenes(c.mediaId, Math.min(a, b), Math.max(a, b), { threshold, onProgress: prog.set });
            prog.set(1);
            const seqTimes = cuts.map((mt) => (c.reverse ? c.start + (b - mt) / c.speed : c.start + (mt - a) / c.speed))
              .map((t) => Math.round(t * store.seq.fps) / store.seq.fps)
              .filter((t) => t > c.start + 1e-3 && t < c.start + c.duration - 1e-3);
            if (mode.value === 'cuts') edit.cutClipAt(c.id, seqTimes);
            else {
              store.transact('장면 마커', () => {
                for (const t of seqTimes) store.seq.markers.push({ id: `mk_${Math.random().toString(36).slice(2)}`, time: t, name: '장면', color: '#fb923c', comment: '' });
                store.seq.markers.sort((x, y) => x.time - y.time);
              });
            }
            status.textContent = `장면 전환 ${seqTimes.length}곳을 찾았습니다.`;
          } catch (err) {
            status.textContent = `분석 실패: ${err.message || err}`;
          }
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
  for (const block of text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
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
    toast('파일에서 자막을 찾지 못했습니다');
    return;
  }
  createCaptionTrack(cues, '자막 가져오기');
  toast(`자막 ${cues.length}개를 새 트랙에 넣었습니다`);
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
    toast('자막으로 내보낼 텍스트 클립이 없습니다');
    return;
  }
  const clips = clipsOnTrack(s, best.t.id).filter((c) => c.kind === 'text');
  const body = clips.map((c, i) => {
    const text = c.effects.find((e) => e.type === 'text').params.content.value;
    return `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(clipEnd(c))}\n${text}\n`;
  }).join('\n');
  downloadBlob(new Blob([body], { type: 'text/plain;charset=utf-8' }), `${s.name || 'captions'}.srt`).then((ok) => {
    if (ok) toast(`${best.t.name} 트랙의 자막 ${clips.length}개를 내보냈습니다`);
  });
}

// ---------------------------------------------------------------- auto captions (speech recognition)

/** Split long recognised segments into readable caption cues, spreading time by text length. */
export function splitCues(cues, maxChars) {
  const out = [];
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) {
      out.push({ ...cue, text });
      continue;
    }
    const words = text.split(' ');
    const parts = [];
    let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > maxChars) {
        parts.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) parts.push(cur);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = cue.start;
    for (const p of parts) {
      const d = ((cue.end - cue.start) * p.length) / total;
      out.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }
  return out;
}

export function openAutoCaptionDialog() {
  const s = store.seq;
  if (!Object.values(s.clips).some((c) => c.kind === 'audio' || c.kind === 'nest')) {
    toast('타임라인에 소리가 있는 클립이 없습니다');
    return;
  }
  const engine = select([
    ['whisper', 'Whisper — 이 브라우저 안에서 (무료)'],
    ['gemini', `Gemini — 더 정확할 수 있음 (API 키 필요${geminiSettings.key ? '' : ', 아직 없음'})`],
  ], geminiSettings.key ? 'gemini' : 'whisper');
  const model = select(ASR_MODELS, 'onnx-community/whisper-base');
  const modelRow = formRow('인식 모델', model);
  const language = select(ASR_LANGUAGES, 'korean');
  const range = select([['all', '시퀀스 전체'], ['inout', '시작(In)~끝(Out) 표시 구간']], s.inPoint != null || s.outPoint != null ? 'inout' : 'all');
  const maxChars = select([['18', '짧게 (18자)'], ['28', '보통 (28자)'], ['42', '길게 (42자)'], ['999', '나누지 않음']], '28');
  const stripTags = check(true, '괄호 속 소리 설명 빼기 — (음악), [박수], (끝끝)처럼 말이 아닌 괄호 글자');
  const prog = progressBar();
  const status = note('');
  const whisperNote = note('Whisper 음성 인식 모델을 이 브라우저 안에서 실행합니다. 소리는 외부 서버로 보내지 않지만, 처음 한 번은 인터넷에서 라이브러리와 모델(40~250MB)을 내려받아야 합니다. 짧은 외침이나 음악이 섞인 말은 엉뚱하게 받아 적기 쉽습니다.');
  const geminiNote = note('섞인 소리를 Google Gemini로 보내 받아 적습니다(3분씩 나눠 보냄). AI 편집 패널 ▸ 설정에 API 키가 있어야 하고, 사용량에 따라 요금이나 무료 한도가 적용됩니다. 시간 위치가 조금 어긋날 수 있습니다.');
  const syncEngine = () => {
    const g = engine.value === 'gemini';
    modelRow.hidden = g;
    whisperNote.hidden = g;
    geminiNote.hidden = !g;
  };
  engine.addEventListener('change', syncEngine);
  syncEngine();
  let running = false;
  const token = { controller: null };
  openModal({
    title: '자동 자막 (음성 인식)',
    width: '560px',
    onClose: () => token.controller?.abort(),
    body: [
      formRow('인식 엔진', engine),
      formRow('언어', language),
      modelRow,
      formRow('범위', range),
      formRow('자막 한 줄 길이', maxChars),
      formRow('', stripTags.el),
      prog.el,
      status,
      whisperNote,
      geminiNote,
      h('div.note.warn', 'claude.ai 보기 화면처럼 외부 연결이 막힌 곳에서는 두 엔진 모두 작동하지 않습니다. 결과가 이상하면 다른 엔진을 쓰거나 SRT 자막 가져오기를 쓰세요. 틀린 글자는 AI 편집 ▸ 대본에서 고칠 수 있습니다.'),
    ],
    buttons: [
      { label: '닫기' },
      {
        label: '자막 만들기', primary: true, action: async () => {
          if (running) return false;
          running = true;
          const r = exportRange(range.value);
          const onStatus = (text, f) => {
            status.textContent = text;
            prog.set(f);
          };
          try {
            let cues;
            if (engine.value === 'gemini') {
              if (!geminiSettings.key) throw new Error('Gemini API 키가 없습니다. AI 편집 패널 ▸ 설정에서 넣으세요.');
              token.controller = new AbortController();
              cues = await transcribeWithGemini({ seq: store.seq, start: r.start, end: r.end, language: language.value, onStatus, signal: token.controller.signal });
            } else {
              cues = await transcribeSequence({ seq: store.seq, start: r.start, end: r.end, model: model.value, language: language.value, onStatus });
            }
            prog.set(1);
            let removed = 0;
            if (stripTags.box.checked) ({ cues, removed } = stripSoundTags(cues));
            const final = splitCues(cues, parseInt(maxChars.value, 10));
            const tagNote = removed ? ` 괄호 설명 ${removed}개는 뺐습니다.` : '';
            if (!final.length) status.textContent = `알아들은 말이 없습니다.${tagNote}`;
            else {
              createCaptionTrack(final, '자동 자막');
              status.textContent = `자막 ${final.length}개를 새 비디오 트랙에 넣었습니다.${tagNote} 틀린 글자는 AI 편집 ▸ 대본에서 고치세요.`;
            }
          } catch (err) {
            if (err?.name !== 'AbortError') {
              console.error(err);
              status.textContent = `실패: ${err.message || err}`;
            }
          }
          token.controller = null;
          running = false;
          return false;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- auto ducking

/** Sequence-time intervals where the given tracks carry audible sound (from waveform peaks). */
export function soundIntervals(seq, trackIds, thresholdDb, { step = 0.05, minGap = 0.5, minLen = 0.2 } = {}) {
  const thr = dbToGain(thresholdDb);
  const raw = [];
  for (const tid of trackIds) {
    const track = seq.tracks.find((t) => t.id === tid);
    if (!track || track.muted) continue;
    for (const c of clipsOnTrack(seq, tid)) {
      if (c.kind !== 'audio' || c.enabled === false) continue;
      const p = getRuntime(c.mediaId).peaks;
      if (!p) continue;
      let open = null;
      for (let t = c.start; t < clipEnd(c); t += step) {
        const mt = mediaTimeAt(c, t);
        const i0 = Math.max(0, Math.floor(mt * p.rate));
        const i1 = Math.min(p.data.length, i0 + Math.max(1, Math.ceil(step * p.rate * Math.abs(c.speed || 1))));
        let m = 0;
        for (let i = i0; i < i1; i++) m = Math.max(m, p.data[i]);
        if (m >= thr) {
          if (open == null) open = t;
        } else if (open != null) {
          raw.push([open, t]);
          open = null;
        }
      }
      if (open != null) raw.push([open, clipEnd(c)]);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] - last[1] < minGap) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  return merged.filter(([a, b]) => b - a >= minLen);
}

export function openDuckingDialog() {
  const s = store.seq;
  const aTracks = audioTracks(s).filter((t) => clipsOnTrack(s, t.id).some((c) => c.kind === 'audio'));
  if (aTracks.length < 2 && !store.selectedClips().some((c) => c.kind === 'audio')) {
    toast('목소리와 음악이 서로 다른 오디오 트랙에 있어야 합니다');
    return;
  }
  const selectedAudio = store.selectedClips().filter((c) => c.kind === 'audio').map((c) => c.id);
  const musicOptions = [
    ...(selectedAudio.length ? [['sel', `선택한 오디오 클립 ${selectedAudio.length}개`]] : []),
    ...aTracks.map((t) => [t.id, `${t.name} 트랙 전체`]),
  ];
  const music = select(musicOptions, musicOptions[selectedAudio.length ? 0 : musicOptions.length - 1][0]);
  const voiceBoxes = h('div.check-list');
  const renderVoices = () => {
    const selTracks = new Set(music.value === 'sel' ? selectedAudio.map((id) => s.clips[id]?.trackId) : []);
    voiceBoxes.replaceChildren(...aTracks.filter((t) => t.id !== music.value).map((t) => {
      const c = check(!selTracks.has(t.id) && !t.muted, `${t.name}${t.muted ? ' (음소거됨)' : ''}`);
      c.box.dataset.track = t.id;
      return c.el;
    }));
  };
  music.addEventListener('change', renderVoices);
  renderVoices();
  const amount = h('input', { type: 'number', value: -15, min: -40, max: -3, step: 1, style: { width: '72px' } });
  const threshold = h('input', { type: 'number', value: -32, min: -60, max: -6, step: 1, style: { width: '72px' } });
  const fadeIn = h('input', { type: 'number', value: 0.3, min: 0, max: 3, step: 0.1, style: { width: '72px' } });
  const fadeOut = h('input', { type: 'number', value: 0.6, min: 0, max: 5, step: 0.1, style: { width: '72px' } });
  const status = note('');
  openModal({
    title: '자동 더킹 (말할 때 배경음악 줄이기)',
    body: [
      formRow('줄일 음악', music),
      formRow('목소리 트랙', voiceBoxes),
      formRow('줄이는 양', amount, 'dB'),
      formRow('목소리 감지 기준', threshold, 'dB (낮출수록 작은 소리도 목소리로 봄)'),
      formRow('줄어드는 시간', fadeIn, '초 · 돌아오는 시간', fadeOut, '초'),
      status,
      note('목소리 트랙의 파형을 보고 소리가 나는 구간마다 음악 볼륨에 키프레임을 넣습니다. 음악 클립의 기존 볼륨 키프레임은 바뀝니다 (실행 취소 가능).'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '적용', primary: true, action: () => {
          const voiceTracks = [...voiceBoxes.querySelectorAll('input:checked')].map((b) => b.dataset.track);
          if (!voiceTracks.length) {
            status.textContent = '목소리 트랙을 하나 이상 고르세요.';
            return false;
          }
          const musicIds = music.value === 'sel' ? selectedAudio : clipsOnTrack(s, music.value).filter((c) => c.kind === 'audio').map((c) => c.id);
          const missing = voiceTracks.some((tid) => clipsOnTrack(s, tid).some((c) => c.kind === 'audio' && !getRuntime(c.mediaId).peaks));
          const intervals = soundIntervals(s, voiceTracks, parseFloat(threshold.value) || -32);
          if (!intervals.length) {
            status.textContent = missing ? '파형 분석이 아직 끝나지 않았습니다. 잠시 뒤 다시 시도하세요.' : '목소리 트랙에서 기준보다 큰 소리를 찾지 못했습니다. 감지 기준을 낮춰 보세요.';
            return false;
          }
          const n = edit.autoDuck(musicIds, intervals, {
            duckDb: parseFloat(amount.value) || -15,
            fadeIn: Math.max(0, parseFloat(fadeIn.value) || 0),
            fadeOut: Math.max(0, parseFloat(fadeOut.value) || 0),
          });
          toast(n ? `음악 클립 ${n}개에 목소리 구간 ${intervals.length}곳을 반영했습니다` : '목소리와 겹치는 음악 클립이 없습니다');
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- auto reframe

const REFRAME_PRESETS = [
  ['1080x1920', '세로 9:16 (쇼츠·릴스·틱톡)'],
  ['1080x1080', '정사각형 1:1'],
  ['1080x1350', '세로 4:5 (인스타 피드)'],
  ['1920x1080', '가로 16:9'],
];

export function openReframeDialog() {
  const s = store.seq;
  const preset = select(REFRAME_PRESETS, s.width > s.height ? '1080x1920' : '1920x1080');
  const name = h('input', { type: 'text', value: '', style: { width: '100%' }, placeholder: `${s.name} (세로)` });
  openModal({
    title: '자동 리프레임 (화면 비율 바꾼 복사본 만들기)',
    body: [
      formRow('새 화면 비율', preset),
      formRow('새 시퀀스 이름', name),
      note('현재 시퀀스를 복사해 새 크기로 바꾸고, 영상·이미지가 빈틈없이 화면을 채우도록 확대합니다(가운데 기준으로 잘림).'),
      h('div.note.warn', '피사체를 자동으로 따라가지는 않습니다. 중요한 부분이 잘리면 클립을 선택해 효과 컨트롤 ▸ 모션 ▸ 위치를 조절하세요.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '만들기', primary: true, action: () => {
          const [w, hh] = preset.value.split('x').map(Number);
          const id = edit.autoReframe(w, hh, name.value.trim() || undefined);
          if (id) toast(`${w}×${hh} 시퀀스를 만들었습니다`);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- multicam

export function openMulticamDialog() {
  const p = store.project;
  const ids = p.mediaOrder.filter((id) => store.ui.selectedMedia.has(id) && p.media[id]?.kind === 'video');
  if (ids.length < 2) {
    toast('프로젝트 패널에서 영상 파일을 2개 이상 선택하세요 (Ctrl 또는 Shift+클릭)');
    showPanel('project');
    return;
  }
  const notReady = ids.filter((id) => mediaStatus(id) !== 'ready');
  const list = h('ol.angle-list', ids.map((id) => h('li', p.media[id].name)));
  const sync = select([
    ['audio', '소리 파형으로 맞추기 (박수 소리 등)'],
    ['in', '각 영상의 시작(In) 표시 지점 맞추기'],
    ['start', '파일 시작 지점 맞추기'],
  ], 'audio');
  const name = h('input', { type: 'text', value: `멀티캠 ${Object.values(p.sequences).filter((x) => x.multicam).length + 1}`, style: { width: '100%' } });
  const place = check(true, '현재 시퀀스의 재생헤드 위치에 넣기');
  const status = note(notReady.length ? `아직 준비되지 않은 파일이 ${notReady.length}개 있습니다.` : '');
  openModal({
    title: '멀티캠 소스 시퀀스 만들기',
    width: '540px',
    body: [
      formRow('앵글 순서', list),
      formRow('동기화 방법', sync),
      formRow('이름', name),
      formRow('', place.el),
      status,
      note('만든 뒤 창 ▸ 멀티캠 패널에서 앵글 화면을 누르거나 숫자 키 1~9로 앵글을 바꿉니다. 재생 중에 누르면 그 위치에서 잘라 바뀌고, 멈춘 상태에서는 현재 구간의 앵글이 바뀝니다. 소리는 앵글 1의 소리를 씁니다.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '만들기', primary: true, action: () => {
          let offsets;
          if (sync.value === 'audio') {
            const noPeaks = ids.filter((id) => !getRuntime(id).peaks);
            if (noPeaks.length) {
              status.textContent = `소리 파형이 없는 파일이 있습니다: ${noPeaks.map((id) => p.media[id].name).join(', ')} — 다른 동기화 방법을 고르거나 분석이 끝난 뒤 다시 하세요.`;
              return false;
            }
            offsets = audioSyncOffsets(ids);
          } else if (sync.value === 'in') {
            offsets = ids.map((id) => -(p.media[id].inPoint ?? 0));
          } else {
            offsets = ids.map(() => 0);
          }
          edit.createMulticamSequence(ids, offsets, { name: name.value || undefined, place: place.box.checked });
          showPanel('multicam');
          toast(`앵글 ${ids.length}개짜리 멀티캠 시퀀스를 만들었습니다`);
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- audio extraction

/**
 * "오디오 추출": make an audio-only file from a video (or audio) file — the whole file, its source
 * In/Out range, or the part a timeline clip uses. opts: { mediaId, clipId }
 */
export function openExtractAudioDialog({ mediaId, clipId = null } = {}) {
  const s = store.seq;
  const clip = clipId ? s.clips[clipId] : null;
  const id = clip?.mediaId || mediaId;
  const m = store.project.media[id];
  if (!m || !['video', 'audio'].includes(m.kind)) {
    toast('영상이나 소리 파일을 고르세요');
    return;
  }
  if (!m.hasAudio) {
    toast(`"${m.name}"에는 소리가 없습니다`);
    return;
  }
  if (mediaStatus(id) !== 'ready') {
    toast('파일이 아직 준비되지 않았거나 오프라인입니다');
    return;
  }
  const fmtT = (t) => formatTimecode(t, m.fps || s.fps);
  const ranges = [['all', `파일 전체 (${fmtT(m.duration || 0)})`]];
  let clipRange = null;
  if (clip) {
    const a = Math.min(clip.inPoint, sourceOut(clip));
    const b = Math.max(clip.inPoint, sourceOut(clip));
    clipRange = [a, b];
    ranges.unshift(['clip', `이 클립이 쓰는 부분 (${fmtT(a)} ~ ${fmtT(b)})`]);
  }
  if (m.inPoint != null || m.outPoint != null) ranges.push(['inout', `소스 시작~끝 표시 (${fmtT(m.inPoint ?? 0)} ~ ${fmtT(m.outPoint ?? m.duration)})`]);
  const range = select(ranges, ranges[0][0]);
  const format = select(AUDIO_FILE_FORMATS.map((f) => [f.id, f.label]), 'wav');
  const addToProject = check(true, '프로젝트 패널에 오디오 항목으로 추가');
  const save = check(false, '내 컴퓨터에 파일로 저장');
  const plain = clip && clip.speed === 1 && !clip.reverse && !clip.hold && !hasSpeedRamp(clip);
  const place = check(false, '추출한 소리를 원래 클립과 같은 위치의 빈 오디오 트랙에 놓기');
  if (!plain) place.box.disabled = true;
  const syncPlace = () => {
    place.el.hidden = !clip;
    place.box.disabled = !plain || range.value !== 'clip' || !addToProject.box.checked;
    if (place.box.disabled) place.box.checked = false;
  };
  range.addEventListener('change', syncPlace);
  addToProject.box.addEventListener('change', syncPlace);
  syncPlace();
  const prog = progressBar();
  const status = note('');
  audioFileFormatSupport().then((ok) => {
    for (const opt of format.options) {
      if (!ok[opt.value]) {
        opt.disabled = true;
        opt.textContent += ' — 이 브라우저에서 사용 불가';
      }
    }
  });
  const token = {};
  let running = false;
  const modal = openModal({
    title: `오디오 추출 — ${m.name}`,
    width: '560px',
    body: [
      formRow('구간', range),
      formRow('형식', format),
      formRow('결과', h('div', { style: { display: 'grid', gap: '4px' } }, addToProject.el, save.el, clip ? place.el : null)),
      prog.el,
      status,
      note('영상에서 소리만 뽑아 새 오디오 파일을 만듭니다. 원본 소리가 같은 형식(AAC·Opus)이면 다시 압축하지 않고 그대로 복사합니다. 긴 영상은 M4A나 Ogg가 WAV보다 훨씬 작습니다.'),
      clip && !plain ? h('div.note.warn', '이 클립은 속도·역재생·속도 램프가 걸려 있어, 추출한 소리는 원본 속도 그대로입니다 (타임라인 위치 맞추기는 끔).') : null,
    ],
    buttons: [
      { label: '닫기', action: () => { token.cancel?.(); } },
      {
        label: '추출', primary: true, action: async () => {
          if (running) return false;
          if (!addToProject.box.checked && !save.box.checked) {
            status.textContent = '"프로젝트에 추가"나 "파일로 저장" 중 하나는 골라야 합니다.';
            return false;
          }
          running = true;
          const btn = modal.footer.querySelector('button.primary');
          btn.disabled = true;
          const fmt = AUDIO_FILE_FORMATS.find((f) => f.id === format.value);
          let start = 0;
          let end = null;
          if (range.value === 'clip' && clipRange) [start, end] = clipRange;
          if (range.value === 'inout') {
            start = m.inPoint ?? 0;
            end = m.outPoint ?? m.duration;
          }
          const base = m.name.replace(/\.[^.]+$/, '');
          const name = `${base}${range.value === 'all' ? '' : ' (구간)'} 오디오.${fmt.ext}`;
          try {
            status.textContent = '소리를 뽑는 중…';
            const blob = await extractAudioFile(id, { start, end, format: fmt.id, token, onProgress: prog.set });
            prog.set(1);
            const done = [`${name} · ${formatBytes(blob.size)}`];
            if (save.box.checked && (await downloadBlob(blob, name))) done.push('파일 저장');
            if (addToProject.box.checked) {
              const [newId] = await importFiles([new File([blob], name, { type: blob.type })]);
              if (newId) {
                done.push('프로젝트에 추가');
                if (place.box.checked && clip && mediaStatus(newId) === 'ready') {
                  const c = store.seq.clips[clip.id];
                  if (c) {
                    const free = () => audioTracks(store.seq).find((t) => !t.locked && !clipsOnTrack(store.seq, t.id).some((x) => x.start < clipEnd(c) && clipEnd(x) > c.start));
                    if (!free()) edit.addTrack('audio');
                    const tr = free();
                    if (tr) {
                      edit.placeMedia(newId, { mode: 'overwrite', start: c.start, aTrackId: tr.id, video: false });
                      done.push(`${tr.name} 트랙에 배치`);
                    }
                  }
                }
              }
            }
            status.textContent = `완료: ${done.join(' · ')}`;
            toast(`오디오를 추출했습니다: ${name}`);
          } catch (err) {
            console.error(err);
            status.textContent = token.cancelled ? '취소했습니다' : `실패: ${err.message || err}`;
          } finally {
            running = false;
            btn.disabled = false;
          }
          return false;
        },
      },
    ],
    onClose: () => {
      token.cancelled = true;
      token.cancel?.();
    },
  });
}

// ---------------------------------------------------------------- silence cut (jump cut)

export function openSilenceCutDialog() {
  const s = store.seq;
  let ids = store.selectedClips().map((c) => c.id);
  if (!ids.length) {
    // nothing selected: use the clips with sound under the playhead
    const t = store.ui.playhead;
    ids = Object.values(s.clips).filter((c) => c.kind === 'audio' && c.start <= t && clipEnd(c) > t).map((c) => c.id);
  }
  if (!ids.length) {
    toast('말소리가 있는 클립을 먼저 선택하세요');
    return;
  }
  const threshold = h('input', { type: 'range', min: -60, max: -20, step: 1, value: -40 });
  const minSil = h('input', { type: 'range', min: 0.2, max: 3, step: 0.1, value: 0.6 });
  const pad = h('input', { type: 'range', min: 0, max: 0.5, step: 0.02, value: 0.12 });
  const labels = { th: h('span.qp-val'), min: h('span.qp-val'), pad: h('span.qp-val') };
  const allTracks = check(false, '다른 트랙(음악·자막 등)도 함께 당겨서 전체 싱크 유지');
  const preview = note('');
  const opts = () => ({ thresholdDb: +threshold.value, minSilence: +minSil.value, pad: +pad.value });
  const update = () => {
    labels.th.textContent = `${threshold.value} dB`;
    labels.min.textContent = `${(+minSil.value).toFixed(1)}초`;
    labels.pad.textContent = `${(+pad.value).toFixed(2)}초`;
    let n = 0;
    let total = 0;
    let missing = false;
    const seen = new Set();
    for (const id of ids) {
      const c = store.seq.clips[id];
      if (!c) continue;
      for (const a of [c, ...Object.values(store.seq.clips).filter((x) => x.linkId && x.linkId === c.linkId)]) {
        if (a.kind !== 'audio' || seen.has(a.id)) continue;
        seen.add(a.id);
        const iv = silentIntervals(a, opts());
        if (!iv) missing = true;
        else for (const [x, y] of iv) { n++; total += y - x; }
      }
    }
    preview.textContent = missing ? '소리 파형을 분석하는 중입니다. 잠시 뒤 다시 열어 주세요.' : `조용한 구간 ${n}곳, 모두 ${total.toFixed(1)}초를 잘라냅니다.`;
  };
  for (const el of [threshold, minSil, pad]) el.addEventListener('input', update);
  update();
  openModal({
    title: '무음 구간 자동 삭제 (점프 컷)',
    width: '540px',
    body: [
      formRow('조용하다고 볼 크기', threshold, labels.th),
      formRow('최소 길이', minSil, labels.min),
      formRow('앞뒤 여유', pad, labels.pad),
      formRow('', allTracks.el),
      preview,
      note('선택한 클립(연결된 영상·소리 포함)에서 기준보다 작은 소리가 이어지는 구간을 잘라내고 빈자리를 당깁니다. 말이 잘리면 "조용하다고 볼 크기"를 낮추거나 "앞뒤 여유"를 늘리세요. 실행 취소(Ctrl+Z)로 되돌릴 수 있습니다.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '잘라내기', primary: true, action: () => {
          const r = cutSilence(ids, { ...opts(), allTracks: allTracks.box.checked });
          if (!r) {
            preview.textContent = '소리 파형 분석이 아직 끝나지 않았습니다.';
            return false;
          }
          if (r.noAudio) toast('선택한 클립에 소리가 없습니다');
          else toast(r.cuts ? `무음 ${r.cuts}곳 (${r.removed.toFixed(1)}초)을 잘라냈습니다` : '잘라낼 조용한 구간이 없습니다');
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- beat markers

export function openBeatDialog() {
  const s = store.seq;
  const audioClips = Object.values(s.clips).filter((c) => c.kind === 'audio' && c.mediaId && store.project.media[c.mediaId]?.kind !== 'sequence').sort((a, b) => a.start - b.start);
  if (!audioClips.length) {
    toast('타임라인에 음악(소리) 클립이 없습니다');
    return;
  }
  const selAudio = store.selectedClips().find((c) => c.kind === 'audio');
  const source = select(audioClips.map((c) => [c.id, `${s.tracks.find((t) => t.id === c.trackId)?.name} · ${c.name} (${formatTimecode(c.start, s.fps)})`]), selAudio?.id || audioClips[audioClips.length - 1].id);
  const sens = h('input', { type: 'range', min: 5, max: 95, value: 50 });
  const markers = check(true, '박자마다 마커 찍기');
  const selVideo = store.selectedClips().filter((c) => c.kind !== 'audio');
  const cut = check(false, `선택한 영상 클립을 박자마다 자르기${selVideo.length ? ` (${selVideo.length}개)` : ' (먼저 클립 선택)'}`, { disabled: !selVideo.length });
  const preview = note('');
  let beats = [];
  const update = () => {
    const c = store.seq.clips[source.value];
    const b = c ? detectBeats(c, +sens.value) : null;
    beats = b || [];
    if (!b) preview.textContent = '소리 파형을 분석하는 중입니다. 잠시 뒤 다시 열어 주세요.';
    else {
      const bpm = b.length > 3 ? Math.round(60 / ((b[b.length - 1] - b[0]) / (b.length - 1))) : null;
      preview.textContent = `박자 ${b.length}개를 찾았습니다${bpm ? ` (평균 약 ${bpm} BPM)` : ''}.`;
    }
  };
  source.addEventListener('change', update);
  sens.addEventListener('input', update);
  update();
  openModal({
    title: '비트 마커 (음악 박자 맞추기)',
    width: '560px',
    body: [
      formRow('음악 클립', source),
      formRow('민감도', h('span', '강한 박자만'), sens, h('span', '많이')),
      formRow('결과', h('div', { style: { display: 'grid', gap: '4px' } }, markers.el, cut.el)),
      preview,
      note('소리 파형에서 갑자기 커지는 순간(드럼 등)을 찾습니다. 박자가 또렷하지 않은 곡은 잘 맞지 않을 수 있습니다. 마커가 있으면 클립을 끌 때 마커에 달라붙습니다(스냅).'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '적용', primary: true, action: () => {
          if (!beats.length) return false;
          if (markers.box.checked) addBeatMarkers(beats);
          if (cut.box.checked) for (const c of selVideo) edit.cutClipAt(c.id, beats.filter((t) => t > c.start && t < clipEnd(c)));
          toast(`박자 ${beats.length}개를 적용했습니다`);
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- photo slideshow

export function openSlideshowDialog(preselected = null) {
  const p = store.project;
  const pickSelected = () => (preselected || p.mediaOrder.filter((id) => store.ui.selectedMedia.has(id))).filter((id) => ['image', 'video'].includes(p.media[id]?.kind));
  let ids = pickSelected();
  const list = note('');
  const showList = () => {
    list.textContent = ids.length ? `${ids.length}개: ${ids.map((id) => p.media[id].name).slice(0, 6).join(', ')}${ids.length > 6 ? ' …' : ''}` : '아직 고른 사진이 없습니다. 아래 "사진 고르기"를 누르거나, 프로젝트 패널에서 사진을 여러 장 선택한 뒤 다시 여세요.';
  };
  showList();
  const perImage = h('input', { type: 'number', value: 3, min: 0.5, max: 30, step: 0.5, style: { width: '80px' } });
  const trans = select([['', '없음 (바로 넘김)'], ...Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'video').map(([k, d]) => [k, d.name])], 'crossDissolve');
  const transDur = h('input', { type: 'number', value: 0.6, min: 0.1, max: 3, step: 0.1, style: { width: '80px' } });
  const ken = check(true, '사진마다 천천히 확대/축소 (켄 번즈)');
  const fill = check(true, '화면을 꽉 채우기 (가장자리 잘림)');
  const pickBtn = h('button', {
    onclick: async () => {
      const { pickFiles } = await import('./project-panel.js');
      const files = await pickFiles({ accept: 'image/*,video/*', multiple: true });
      if (!files.length) return;
      list.textContent = '가져오는 중…';
      const newIds = await importFiles(files);
      ids = newIds.filter((id) => ['image', 'video'].includes(p.media[id]?.kind) && mediaStatus(id) === 'ready');
      showList();
    },
  }, '사진 고르기…');
  openModal({
    title: '사진 슬라이드쇼 만들기',
    width: '540px',
    body: [
      formRow('사진', h('div', { style: { display: 'grid', gap: '6px' } }, list, h('div.inline', pickBtn))),
      formRow('사진 한 장 길이', perImage, '초'),
      formRow('전환', trans, transDur, '초'),
      formRow('', h('div', { style: { display: 'grid', gap: '4px' } }, ken.el, fill.el)),
      note('재생헤드 위치부터 대상 비디오 트랙에 순서대로 놓습니다. 영상 파일을 섞으면 영상은 원래 길이대로 들어갑니다.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '만들기', primary: true, action: () => {
          if (!ids.length) {
            toast('사진을 먼저 고르세요');
            return false;
          }
          const n = createSlideshow(ids, {
            perImage: clamp(parseFloat(perImage.value) || 3, 0.5, 60),
            transition: trans.value || null,
            transDur: clamp(parseFloat(transDur.value) || 0.6, 0.1, 5),
            kenBurns: ken.box.checked,
            fill: fill.box.checked,
          });
          toast(n ? `${n}개로 슬라이드쇼를 만들었습니다` : '놓을 수 있는 사진이 없습니다');
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- shortcuts

export const SHORTCUTS = [
  ['재생', [
    ['재생 / 정지', 'Space'], ['뒤로 / 정지 / 앞으로 (누를수록 빨라짐)', 'J / K / L'], ['시작~끝 표시 구간 재생', 'Ctrl+Shift+Space'],
    ['1프레임 뒤로 / 앞으로', '← / →'], ['5프레임 이동', 'Shift+← / →'], ['이전 / 다음 편집점', '↑ / ↓'],
    ['처음 / 끝으로', 'Home / End'], ['시작(In) / 끝(Out) 표시로 이동', 'Shift+I / Shift+O'], ['반복 재생 켜기/끄기', 'Ctrl+Shift+L'],
  ]],
  ['표시', [
    ['시작(In) / 끝(Out) 표시', 'I / O'], ['클립 범위 표시', 'X'], ['시작·끝 표시 지우기', 'Ctrl+Shift+X'], ['시작 / 끝 표시만 지우기', 'Ctrl+Shift+I / O'],
    ['마커 추가', 'M'], ['다음 / 이전 마커', 'Shift+M / Ctrl+Shift+M'],
  ]],
  ['편집', [
    ['소스에서 삽입 / 덮어쓰기', ', / .'], ['들어내기 / 추출', '; / \''], ['자르기 (편집점 추가)', 'Ctrl+K'], ['모든 트랙 자르기', 'Ctrl+Shift+K'],
    ['재생헤드까지 앞 / 뒤 잘라내고 당기기', 'Q / W'], ['지우기', 'Delete / Backspace'], ['잔물결 삭제 (빈자리 당김)', 'Shift+Delete'],
    ['잘라내기 / 복사 / 붙여넣기', 'Ctrl+X / C / V'], ['삽입하며 붙여넣기', 'Ctrl+Shift+V'], ['효과만 붙여넣기', 'Ctrl+Alt+V'],
    ['복제하며 끌기', 'Alt+끌기'], ['삽입하며 끌기', 'Ctrl+끌기'],
    ['기본 비디오 / 오디오 전환 넣기', 'Ctrl+D / Ctrl+Shift+D'], ['선택 클립에 기본 전환 넣기', 'Shift+D'],
    ['클립 사용 / 사용 안 함', 'Shift+E'], ['연결 / 연결 해제', 'Ctrl+L'], ['속도/지속 시간', 'Ctrl+R'], ['클립 1프레임 이동', 'Alt+← / →'],
    ['원본 프레임 찾기 (소스 모니터에서 열기)', 'F'], ['볼륨 선에 키프레임 추가', 'Ctrl+클릭'],
    ['멀티캠 앵글 바꾸기', '1 ~ 9'],
    ['모두 선택 / 선택 해제', 'Ctrl+A / Ctrl+Shift+A'], ['실행 취소 / 다시 실행', 'Ctrl+Z / Ctrl+Shift+Z'],
  ]],
  ['도구', [
    ['선택', 'V'], ['앞쪽 트랙 선택', 'A'], ['잔물결 편집', 'B'], ['롤링 편집', 'N'], ['자르기 (면도날)', 'C'],
    ['밀어 넣기 (슬립)', 'Y'], ['손 (화면 이동)', 'H'], ['확대/축소', 'Z'], ['텍스트', 'T'],
  ]],
  ['보기·파일', [
    ['타임라인 확대 / 축소', '= / -'], ['시퀀스 전체 보기', '\\'], ['스냅 켜기/끄기', 'S'], ['패널 크게 보기', '`'],
    ['가져오기', 'Ctrl+I'], ['프로젝트 열기', 'Ctrl+O'], ['내보내기', 'Ctrl+M'], ['현재 프레임 저장', 'Ctrl+Shift+E'], ['프로젝트 파일로 저장', 'Ctrl+S'],
    ['타임라인: 시간 이동 / 트랙 이동 / 확대', '휠 / Shift+휠 / Alt 또는 Ctrl+휠'], ['단축키 보기', 'F1 / ?'],
  ]],
];

export function openShortcutsDialog() {
  const table = h('div.kbd-table');
  for (const [group, rows] of SHORTCUTS) {
    table.append(h('h4', group));
    for (const [label, key] of rows) table.append(h('span', label), h('span.k', key));
  }
  openModal({
    title: '단축키 (macOS는 Ctrl 대신 ⌘)',
    body: [table, note('한글 입력 상태에서도 단축키가 작동합니다 (키 위치 기준).')],
    width: '660px',
  });
}

// ---------------------------------------------------------------- guide & about

const GUIDE = [
  ['1. 영상 가져오기', '파일을 프로그램 창 아무 곳에나 끌어다 놓거나, 파일 ▸ 가져오기(Ctrl+I)를 누르세요. 영상·소리·사진·LUT(.cube) 파일을 넣을 수 있습니다.'],
  ['2. 타임라인에 놓기', '프로젝트 패널의 항목을 아래 타임라인으로 끌어다 놓습니다. 또는 항목을 두 번 눌러 소스 모니터에서 열고, 시작(I)·끝(O)을 표시한 뒤 쉼표(,) 키로 삽입합니다.'],
  ['3. 자르고 다듬기', '재생헤드를 원하는 곳에 두고 Ctrl+K로 자릅니다. 필요 없는 조각은 선택하고 Shift+Delete로 지우면 빈자리가 당겨집니다. 클립 끝을 끌면 길이가 바뀝니다.'],
  ['4. 효과와 전환', '효과 패널에서 효과를 클립 위로 끌어다 놓고, 효과 컨트롤 패널에서 값을 바꿉니다. 초시계 아이콘을 누르면 키프레임 애니메이션이 됩니다. 클립 사이에는 Ctrl+D로 디졸브를 넣습니다.'],
  ['5. 자막과 그래픽', '그래픽 ▸ 텍스트(또는 T 도구로 화면 클릭)로 글자를 넣고, 그래픽 ▸ 타이틀 템플릿에서 하단 자막바 같은 완성된 디자인을 고를 수 있습니다. 그래픽 ▸ 자동 자막은 말소리를 글자로 바꿉니다(인터넷 필요).'],
  ['6. 색과 소리', '효과 ▸ 고급 색상 보정(커브·색상 휠)과 LUT 적용(.cube)으로 색을 맞춥니다. 창 ▸ 작업 영역 ▸ 오디오를 고르면 믹서와 볼륨 조절이 앞으로 나옵니다. 클립 ▸ 자동 더킹은 말할 때 배경음악을 자동으로 줄입니다.'],
  ['7. 내보내기', '파일 ▸ 내보내기(Ctrl+M)에서 유튜브·쇼츠·움짤 같은 프리셋을 고르고 내보내기를 누르면 파일이 저장됩니다.'],
  ['저장에 대해', '작업은 이 브라우저에 자동 저장됩니다. 다른 컴퓨터로 옮기거나 백업하려면 파일 ▸ 프로젝트 파일로 저장(Ctrl+S)을 쓰세요. 미디어 파일 자체는 프로젝트 파일에 들어가지 않습니다.'],
  ['화면이 작거나 글씨가 작다면', '창 ▸ 화면 크기에서 크게/아주 크게를 고르세요. 창 ▸ 작업 영역에서 용도에 맞는 패널 배치를 고를 수 있습니다.'],
];

export function openGuideDialog() {
  openModal({
    title: '시작 가이드',
    width: '620px',
    body: h('div.guide', GUIDE.map(([t, d]) => h('section', h('h4', t), h('p', d)))),
    buttons: [
      { label: '단축키 보기', action: () => { setTimeout(openShortcutsDialog, 0); } },
      { label: '닫기', primary: true },
    ],
  });
}

export function openAboutDialog() {
  openModal({
    title: 'Montage 정보',
    body: h('div.note', { style: { fontSize: 'var(--fs)' } },
      h('p', 'Montage는 브라우저에서 돌아가는 영상 편집기입니다. 프로젝트 패널, 소스·프로그램 모니터, 여러 트랙 타임라인, 키프레임 효과, 전환, 오디오 믹싱, 프레임 단위 내보내기를 제공합니다.'),
      h('p', '모든 처리는 이 브라우저 안에서 이루어지며 미디어 파일은 밖으로 보내지 않습니다. 현재 프로젝트와 가져온 파일은 이 브라우저(IndexedDB)에 자동 저장됩니다. 자동 자막만은 처음 쓸 때 음성 인식 모델을 인터넷에서 내려받습니다.'),
      h('p', '영상 디코딩/인코딩은 mediabunny 라이브러리(MPL-2.0)로 WebCodecs를 사용합니다. 어도비 프리미어 프로와는 관계없는 독립 프로그램입니다.')),
  });
}
