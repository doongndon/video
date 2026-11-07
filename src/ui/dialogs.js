// Modal dialogs: speed/duration, markers, sequence settings, export, captions, multicam,
// auto ducking, auto reframe, auto captions, shortcuts and the getting-started guide.

import { store } from '../store.js';
import * as edit from '../edit.js';
import { h, formatTimecode, parseTimecode, formatBytes, downloadBlob, clamp } from '../util.js';
import { openModal, formRow, toast, showPanel } from './common.js';
import { exportRange } from '../export.js';
import { openExportSettings } from './export-dialog.js';
import { createSyntheticMedia, detectScenes, mediaStatus, getRuntime, audioSyncOffsets, AUDIO_FILE_FORMATS, audioFileFormatSupport, extractAudioFile, importFiles, prepareSoundCapture } from '../media.js';
import { clipEnd, clipsOnTrack, videoTracks, audioTracks, isTimed, hasSpeedRamp, sourceOut } from '../model.js';
import { ASR_MODELS, ASR_LANGUAGES, transcribeSequence, createCaptionTrack, stripSoundTags, splitCues } from '../captions.js';
import { geminiSettings, transcribeWithGemini } from '../ai.js';
import { silentIntervals, cutSilence, detectBeats, addBeatMarkers, createSlideshow, soundIntervals } from '../features.js';
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
  // Premiere's 클립 속도/지속 시간 names: 역방향 속도 / 오디오 피치 유지 / 잔물결 편집, 후행 클립 이동
  const reverse = check(!!c.reverse, '역방향 속도 (거꾸로 재생)', { disabled: !timed });
  const pitch = check(c.maintainPitch !== false, '오디오 피치 유지 (빠르게/느리게 해도 목소리 톤 그대로)', { disabled: !timed });
  const hold = check(!!c.hold, '프레임 고정 (시작 프레임에서 멈춘 화면)', { disabled: c.kind !== 'video' });
  const ripple = check(false, '잔물결 편집, 후행 클립 이동');
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
    title: `클립 속도/지속 시간${clips.length > 1 ? ` (${clips.length}개)` : ''}`,
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
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

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
      note('화면 크기를 바꾸면 클립 위치가 비율에 맞게 옮겨집니다. 클립은 기본적으로 화면에 맞춰집니다 (비율 100% = 화면 맞춤). 세로 영상용 복사본이 필요하면 시퀀스 ▸ 자동 리프레임 시퀀스를 쓰세요.'),
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

/** 내보내기 설정 (Ctrl+M): the full Premiere-style export dialog lives in export-dialog.js. */
export function openExportDialog() {
  return openExportSettings();
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

/** 새 시퀀스: name, frame size and frame rate (파일 ▸ 새로 만들기 ▸ 시퀀스). */
export function openNewSequenceDialog() {
  const s = store.seq;
  const name = h('input', { type: 'text', value: `시퀀스 ${String(Object.keys(store.project.sequences).length + 1).padStart(2, '0')}`, style: { width: '100%' } });
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
    title: '새 시퀀스',
    body: [formRow('시퀀스 이름', name), formRow('화면 크기', preset), formRow('', w, '×', hh), formRow('초당 프레임', fps),
      note('새 시퀀스는 프로젝트 패널에 항목으로 생기고 타임라인에 탭으로 열립니다. 클립에 맞춘 시퀀스가 필요하면 프로젝트 패널에서 영상을 오른쪽 클릭 ▸ 클립에서 새 시퀀스를 쓰세요.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const W = clamp(Math.round((parseInt(w.value, 10) || 1920) / 2) * 2, 16, 8192);
        const H = clamp(Math.round((parseInt(hh.value, 10) || 1080) / 2) * 2, 16, 8192);
        edit.newSequence({ name: name.value.trim() || undefined, width: W, height: H, fps: parseFloat(fps.value) });
      },
    }],
  });
}

/** Shared progress UI for items that are rendered into a file (바 및 톤, 카운팅 리더). */
function generateWithProgress(modal, run) {
  const btn = modal.footer.querySelector('button.primary');
  const prog = modal.prog;
  btn.disabled = true;
  modal.status.textContent = '만드는 중…';
  return run({ onProgress: prog.set, token: modal.token }).then((id) => {
    prog.set(1);
    if (id) {
      store.ui.selectedMedia = new Set([id]);
      store.emit('reveal-media', id);
    }
    modal.close();
  }).catch((err) => {
    // closing the dialog (취소 / Esc) stops the job: not an error
    if (modal.token?.cancelled) return;
    console.error(err);
    modal.status.textContent = `만들지 못했습니다: ${err.message || err}`;
    btn.disabled = false;
  });
}

const sizeRow = (s) => {
  const w = h('input', { type: 'number', value: s.width, min: 16, max: 8192, step: 2, style: { width: '86px' } });
  const hh = h('input', { type: 'number', value: s.height, min: 16, max: 8192, step: 2, style: { width: '86px' } });
  const fps = h('select', RATES.map((r) => h('option', { value: r, selected: Math.abs(r - s.fps) < 0.01 }, `${r} fps`)));
  const read = () => ({
    width: clamp(Math.round((parseInt(w.value, 10) || s.width) / 2) * 2, 16, 8192),
    height: clamp(Math.round((parseInt(hh.value, 10) || s.height) / 2) * 2, 16, 8192),
    fps: parseFloat(fps.value) || s.fps,
  });
  return { rows: [formRow('화면 크기', w, '×', hh), formRow('시간 기준', fps)], read };
};

/** 바 및 톤: SMPTE colour bars with a 1 kHz reference tone. */
export function openBarsToneDialog() {
  const s = store.seq;
  const size = sizeRow(s);
  const dur = h('input', { type: 'number', value: 10, min: 1, max: 120, step: 1, style: { width: '72px' } });
  const level = select([['-12', '-12 dB'], ['-18', '-18 dB (EBU)'], ['-20', '-20 dB (SMPTE, 기본)']], '-20');
  const prog = progressBar();
  const status = note('');
  const token = { cancelled: false };
  const modal = openModal({
    title: '새 바 및 톤',
    body: [...size.rows, formRow('길이', dur, '초'), formRow('톤 레벨', level), prog.el, status,
      note('SMPTE HD 컬러 바와 1 kHz 기준음을 영상 파일로 만들어 프로젝트에 넣습니다. 방송·납품용 영상 앞머리나 모니터·소리 크기 맞추기에 씁니다.')],
    buttons: [
      { label: '취소', action: () => { token.cancelled = true; } },
      {
        label: '만들기', primary: true, action: async () => {
          const o = size.read();
          await generateWithProgress(Object.assign(modal, { prog, status, token }), async (cb) => {
            const { createBarsAndTone } = await import('../generated-media.js');
            return createBarsAndTone({ ...o, duration: clamp(parseFloat(dur.value) || 10, 1, 120), toneDb: parseFloat(level.value), ...cb });
          });
          return false;
        },
      },
    ],
    onClose: () => { token.cancelled = true; },
  });
}

/** 범용 카운팅 리더: 8 → 2 countdown with a clock wipe and cue blips. */
export async function openCountingLeaderDialog() {
  const { LEADER_DEFAULTS, LEADER_SECONDS } = await import('../generated-media.js');
  const s = store.seq;
  const size = sizeRow(s);
  const colour = (v) => h('input', { type: 'color', value: v });
  const c = {
    wipe: colour(LEADER_DEFAULTS.wipe), background: colour(LEADER_DEFAULTS.background), line: colour(LEADER_DEFAULTS.line),
    target: colour(LEADER_DEFAULTS.target), numeral: colour(LEADER_DEFAULTS.numeral),
  };
  const blipOut = check(LEADER_DEFAULTS.blipOut, '끝에서 큐 블립');
  const blipOn2 = check(LEADER_DEFAULTS.blipOn2, '2에서 큐 블립 (2-pop)');
  const blipEvery = check(LEADER_DEFAULTS.blipEverySecond, '매 초 시작마다 큐 블립');
  const prog = progressBar();
  const status = note('');
  const token = { cancelled: false };
  const modal = openModal({
    title: '범용 카운팅 리더 설정',
    width: '520px',
    body: [...size.rows,
      formRow('와이프 색상', c.wipe), formRow('배경 색상', c.background), formRow('선 색상', c.line), formRow('대상 색상', c.target), formRow('숫자 색상', c.numeral),
      formRow('', h('div', { style: { display: 'grid', gap: '4px' } }, blipOut.el, blipOn2.el, blipEvery.el)),
      prog.el, status,
      note(`8에서 2까지 1초마다 숫자가 바뀌고 시계 방향 와이프가 돕니다. 뒤에 검은 화면 2초가 붙어 모두 ${LEADER_SECONDS}초입니다. 큐 블립은 1 kHz 짧은 삐 소리입니다.`)],
    buttons: [
      { label: '취소', action: () => { token.cancelled = true; } },
      {
        label: '확인', primary: true, action: async () => {
          const o = { ...size.read(), wipe: c.wipe.value, background: c.background.value, line: c.line.value, target: c.target.value, numeral: c.numeral.value,
            blipOut: blipOut.box.checked, blipOn2: blipOn2.box.checked, blipEverySecond: blipEvery.box.checked };
          await generateWithProgress(Object.assign(modal, { prog, status, token }), async (cb) => {
            const { createCountingLeader } = await import('../generated-media.js');
            return createCountingLeader({ ...o, ...cb });
          });
          return false;
        },
      },
    ],
    onClose: () => { token.cancelled = true; },
  });
}

// ---------------------------------------------------------------- roll / crawl

/**
 * 롤/크롤 옵션 (Premiere's 반응형 디자인 - 시간 ▸ 롤): make the selected text (or any picture) clips
 * roll up the screen or crawl sideways by keyframing their position.
 */
/**
 * measure(clip) for applyRollCrawl: the clip's box in sequence px where it rests (a roll already on
 * it is undone first). Shared by the 롤/크롤 옵션 dialog and the 기본 그래픽 panel.
 */
export async function rollMeasure() {
  const [{ Compositor }, { playback }, { evalEffect }] = await Promise.all([import('../compositor.js'), import('../playback.js'), import('../model.js')]);
  const comp = new Compositor();
  return (c) => {
    const t = clamp(store.ui.playhead, c.start, clipEnd(c) - 1e-3);
    const q = comp.clipQuad(store.seq, c, t, playback.provider);
    const motion = c.effects.find((e) => e.type === 'motion');
    if (!q || !motion) return null;
    const cur = evalEffect(motion, t - c.start);
    const restOf = (k) => (motion.params[k].kf?.length ? (motion.params[k].restValue ?? motion.params[k].value) : motion.params[k].value);
    const dx = restOf('posX') - cur.posX;
    const dy = restOf('posY') - cur.posY;
    const xs = q.map((p) => p[0] + dx);
    const ys = q.map((p) => p[1] + dy);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
}

/** Clips a roll / crawl can move: the selected visual clips with 모션. */
export const rollTargets = () => store.selectedClips().filter((c) => c.kind !== 'audio' && c.kind !== 'adjustment' && c.effects.some((e) => e.type === 'motion'));

export async function openRollCrawlDialog() {
  const [{ applyRollCrawl, clearRollCrawl }, measure] = await Promise.all([import('../features.js'), rollMeasure()]);
  const s = store.seq;
  const clips = rollTargets();
  if (!clips.length) {
    toast('롤이나 크롤을 넣을 텍스트(또는 그림) 클립을 타임라인에서 선택하세요');
    return;
  }
  const prev = clips[0].roll || {};
  const dir = select([['still', '정지 (움직임 없음)'], ['roll', '롤 (아래에서 위로)'], ['crawlLeft', '크롤 왼쪽 (오른쪽에서 왼쪽으로)'], ['crawlRight', '크롤 오른쪽 (왼쪽에서 오른쪽으로)']], prev.dir || 'roll');
  const startOff = check(prev.startOff ?? true, '화면 밖에서 시작');
  const endOff = check(prev.endOff ?? true, '화면 밖에서 끝');
  const tc = (v) => h('input', { type: 'text', value: formatTimecode(v || 0, s.fps), style: { width: '110px' } });
  const pre = tc(prev.preRoll);
  const post = tc(prev.postRoll);
  const easeIn = tc(prev.easeIn);
  const easeOut = tc(prev.easeOut);
  const timing = h('div', { style: { display: 'grid', gap: '6px' } },
    // Premiere's Korean names: 가속 (Ease-In, speeding up at the start), 감속 (Ease-Out, slowing to a stop)
    formRow('사전 롤', pre), formRow('가속', easeIn), formRow('감속', easeOut), formRow('사후 롤', post));
  const sync = () => {
    const still = dir.value === 'still';
    for (const el of [startOff.box, endOff.box, pre, post, easeIn, easeOut]) el.disabled = still;
  };
  dir.addEventListener('change', sync);
  sync();
  const secs = (el) => Math.max(0, parseTimecode(el.value, s.fps) || 0);
  openModal({
    title: `롤/크롤 옵션${clips.length > 1 ? ` (클립 ${clips.length}개)` : ''}`,
    width: '460px',
    body: [
      formRow('유형', dir),
      formRow('', h('div', { style: { display: 'grid', gap: '4px' } }, startOff.el, endOff.el)),
      timing,
      note('클립 길이 동안 위치에 키프레임을 넣어 움직입니다 (엔딩 크레딧, 뉴스 자막 띠 등). 사전 롤·사후 롤은 움직이기 전·후에 멈춰 있는 시간, 가속·감속은 천천히 출발하고 멈추는 시간입니다. 시간은 타임코드나 프레임 수로 넣으세요.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const ids = clips.map((c) => c.id);
          if (dir.value === 'still') {
            clearRollCrawl(ids);
            return true;
          }
          const n = applyRollCrawl(ids, {
            dir: dir.value, startOff: startOff.box.checked, endOff: endOff.box.checked,
            preRoll: secs(pre), postRoll: secs(post), easeIn: secs(easeIn), easeOut: secs(easeOut),
          }, measure);
          if (!n) toast('움직일 수 있는 클립이 없습니다');
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- subclips

/** 하위 클립 만들기: name and trim restriction for a new subclip of the given range. */
export async function openSubclipDialog(sourceId, { inPoint, outPoint } = {}) {
  const { createSubclip, nextSubclipName, itemRange } = await import('../subclips.js');
  const m = store.project.media[sourceId];
  if (!m) return;
  const masterId = m.subclipOf || sourceId;
  const fps = m.fps || store.seq.fps;
  const [lo, hi] = itemRange(m);
  const a = clamp(inPoint ?? lo, lo, hi);
  const b = clamp(outPoint ?? hi, a, hi);
  const name = h('input', { type: 'text', value: nextSubclipName(masterId), style: { width: '100%' } });
  const restrict = check(true, '하위 클립 경계로 트리밍 제한');
  openModal({
    title: '하위 클립 만들기',
    body: [formRow('이름', name), formRow('', restrict.el),
      note(`${formatTimecode(a, fps)} ~ ${formatTimecode(Math.max(a, b - 1 / fps), fps)} (길이 ${formatTimecode(b - a, fps)}) 구간이 프로젝트 패널에 새 항목으로 생깁니다. 원본 파일을 그대로 쓰므로 용량이 늘지 않습니다.`),
      a === lo && b === hi && !m.subclipOf ? h('div.note.warn', '시작·끝 표시가 없어 클립 전체로 만듭니다. 소스 모니터에서 I·O로 구간을 표시하면 그 부분만 하위 클립이 됩니다.') : null],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const id = createSubclip(sourceId, { name: name.value.trim() || undefined, inPoint: a, outPoint: b, restrict: restrict.box.checked });
        if (!id) {
          toast('하위 클립을 만들 수 없습니다 (구간이 너무 짧습니다)');
          return false;
        }
        store.ui.selectedMedia = new Set([id]);
        store.emit('reveal-media', id);
        toast(`하위 클립 "${store.project.media[id].name}"을(를) 만들었습니다`);
        return true;
      },
    }],
  });
}

/** 하위 클립 편집: start / end in master time and the trim restriction. */
export async function openEditSubclipDialog(id) {
  const { editSubclip } = await import('../subclips.js');
  const m = store.project.media[id];
  const master = m?.subclipOf ? store.project.media[m.subclipOf] : null;
  if (!master) {
    toast('하위 클립을 고르세요');
    return;
  }
  const fps = master.fps || store.seq.fps;
  const name = h('input', { type: 'text', value: m.name, style: { width: '100%' } });
  const start = h('input', { type: 'text', value: formatTimecode(m.subIn, fps), style: { width: '120px' } });
  // 끝 is the subclip's last frame (inclusive, as in Premiere); subOut is the time just after it
  const end = h('input', { type: 'text', value: formatTimecode(Math.max(m.subIn, m.subOut - 1 / fps), fps), style: { width: '120px' } });
  const restrict = check(m.restrictTrims !== false, '하위 클립 경계로 트리밍 제한');
  openModal({
    title: '하위 클립 편집',
    body: [
      formRow('이름', name),
      formRow('마스터 클립', h('span', `${master.name} · ${formatTimecode(0, fps)} ~ ${formatTimecode(master.duration || 0, fps)}`)),
      formRow('시작', start), formRow('끝', end), formRow('', restrict.el),
      note('바꾼 구간은 앞으로 타임라인에 놓는 클립부터 적용됩니다. 이미 놓은 클립은 그대로입니다.'),
    ],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const a = parseTimecode(start.value, fps);
        const last = parseTimecode(end.value, fps);
        const b = last == null ? null : last + 1 / fps;
        if (a == null || b == null || b <= a) {
          toast('시작이 끝보다 앞이어야 합니다');
          return false;
        }
        if (!editSubclip(id, { name: name.value.trim() || m.name, subIn: a, subOut: b, restrict: restrict.box.checked })) {
          toast('구간이 너무 짧습니다');
          return false;
        }
        return true;
      },
    }],
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

/** "HH:MM:SS,mmm" (SRT) or "[HH:]MM:SS.mmm" (WebVTT, hours optional); fractions of any length. */
function parseSrtTime(s) {
  const m = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/.exec(s);
  if (!m) return null;
  return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 10 ** m[4].length;
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
  const geminiNote = note('섞인 소리를 Google Gemini로 보내 받아 적습니다(3분씩 나눠 보냄). AI ▸ Gemini API 키 설정에서 키를 넣어야 하고, 사용량에 따라 요금이나 무료 한도가 적용됩니다. 시간 위치가 조금 어긋날 수 있습니다.');
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
      h('div.note.warn', 'claude.ai 보기 화면처럼 외부 연결이 막힌 곳에서는 두 엔진 모두 작동하지 않습니다. 결과가 이상하면 다른 엔진을 쓰거나 SRT 자막 가져오기를 쓰세요. 틀린 글자는 AI ▸ 대본으로 편집에서 고칠 수 있습니다.'),
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
              if (!geminiSettings.key) throw new Error('Gemini API 키가 없습니다. AI ▸ Gemini API 키 설정에서 넣으세요.');
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
              status.textContent = `자막 ${final.length}개를 새 비디오 트랙에 넣었습니다.${tagNote} 틀린 글자는 AI ▸ 대본으로 편집에서 고치세요.`;
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
    // Premiere's 동기화 지점: 오디오 / 시작 표시 (plus the file start)
    ['audio', '오디오 (소리 파형으로 맞추기 · 박수 소리 등)'],
    ['in', '시작 표시 (각 영상의 In 지점 맞추기)'],
    ['start', '파일 시작 지점 맞추기'],
  ], 'audio');
  const name = h('input', { type: 'text', value: `멀티캠 ${Object.values(p.sequences).filter((x) => x.multicam).length + 1}`, style: { width: '100%' } });
  const place = check(true, '현재 시퀀스의 재생헤드 위치에 넣기');
  const status = note(notReady.length ? `아직 준비되지 않은 파일이 ${notReady.length}개 있습니다.` : '');
  openModal({
    title: '멀티 카메라 소스 시퀀스 만들기',
    width: '540px',
    body: [
      formRow('앵글 순서', list),
      formRow('동기화 지점', sync),
      formRow('이름', name),
      formRow('', place.el),
      status,
      note('만든 뒤 창 ▸ 멀티 카메라 패널에서 앵글 화면을 누르거나 숫자 키 1~9로 앵글을 바꿉니다. 재생 중에 누르면 그 위치에서 잘라 바뀌고, 멈춘 상태에서는 현재 구간의 앵글이 바뀝니다. 소리는 앵글 1의 소리를 씁니다.'),
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
  // the Out timecode names the last frame of a range (Premiere includes it)
  const lastFrame = (a, b) => fmtT(Math.max(a, b - 1 / (m.fps || s.fps)));
  const ranges = [['all', `파일 전체 (${fmtT(m.duration || 0)})`]];
  let clipRange = null;
  if (clip) {
    const a = Math.min(clip.inPoint, sourceOut(clip));
    const b = Math.max(clip.inPoint, sourceOut(clip));
    clipRange = [a, b];
    ranges.unshift(['clip', `이 클립이 쓰는 부분 (${fmtT(a)} ~ ${lastFrame(a, b)})`]);
  }
  if (m.inPoint != null || m.outPoint != null) ranges.push(['inout', `소스 시작~끝 표시 (${fmtT(m.inPoint ?? 0)} ~ ${lastFrame(m.inPoint ?? 0, m.outPoint ?? m.duration)})`]);
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
    ['타임라인: 시간 이동 / 트랙 이동 / 확대', '휠 / Shift+휠 / Alt 또는 Ctrl+휠'], ['키보드 단축키', 'F1 / ?'],
  ]],
  ['모니터', [
    ['하위 클립 만들기 (소스 모니터 · 프로젝트)', 'Ctrl+U'], ['포스터 프레임 설정 (소스 모니터)', 'Shift+P'],
    ['안내선 표시 / 프로그램 모니터에서 스냅', 'Ctrl+; / Ctrl+Shift+;'],
    ['프로그램 모니터 확대 / 화면 이동', 'Ctrl+휠 / 휠 · 손 도구(H) 끌기 · 가운데 버튼 끌기'], ['프로그램 모니터에서 프레임 이동', '휠 (맞추기 보기에서)'],
    ['마스크 점 추가 / 곡선·모서리 바꾸기 / 점 지우기', 'Ctrl+클릭 / Alt+클릭 / Delete'],
  ]],
];

/** The keyboard shortcuts list (편집 ▸ 키보드 단축키); SHORTCUTS above fills its 그 밖의 단축키. */
export function openShortcutsDialog() {
  return import('./keymap.js').then((m) => m.openKeyboardShortcuts());
}

// ---------------------------------------------------------------- guide & about

const GUIDE = [
  ['1. 영상 가져오기', '파일을 프로그램 창 아무 곳에나 끌어다 놓거나, 파일 ▸ 가져오기(Ctrl+I)를 누르세요. 영상·소리·사진·LUT(.cube) 파일을 넣을 수 있습니다.'],
  ['2. 타임라인에 놓기', '프로젝트 패널의 항목을 아래 타임라인으로 끌어다 놓습니다. 또는 항목을 두 번 눌러 소스 모니터에서 열고, 시작(I)·종료(O)를 표시한 뒤 쉼표(,) 키로 삽입합니다.'],
  ['3. 자르고 다듬기', '재생헤드를 원하는 곳에 두고 시퀀스 ▸ 편집 추가(Ctrl+K)로 자릅니다. 필요 없는 조각은 선택하고 Shift+Delete(잔물결 삭제)로 지우면 빈자리가 당겨집니다. 클립 끝을 끌면 길이가 바뀝니다.'],
  ['4. 효과와 전환', '효과 패널에서 효과를 클립 위로 끌어다 놓고, 효과 컨트롤 패널에서 값을 바꿉니다. 초시계 아이콘을 누르면 키프레임 애니메이션이 됩니다. 클립 사이에는 시퀀스 ▸ 비디오 전환 적용(Ctrl+D)으로 디졸브를 넣습니다.'],
  ['5. 자막과 그래픽', '문자 도구(T)로 프로그램 모니터를 클릭하거나 그래픽 및 타이틀 ▸ 새 레이어 ▸ 텍스트로 글자를 넣습니다. 창 ▸ 기본 그래픽의 찾아보기에서 하단 자막·오프닝·엔딩 크레딧 같은 템플릿을 타임라인으로 끌어다 놓고, 편집에서 글꼴·색·정렬·롤을 바꿉니다. 그래픽 및 타이틀 ▸ 자동 캡션 만들기는 말소리를 글자로 바꿉니다(인터넷 필요).'],
  ['6. 색과 소리', '창 ▸ 작업 영역 ▸ 색상을 고르면 Lumetri 색상과 Lumetri 범위 패널이 나옵니다(LUT는 Lumetri 색상의 입력 LUT). 창 ▸ 작업 영역 ▸ 오디오를 고르면 믹서와 기본 사운드 패널이 나오고, 기본 사운드의 더킹은 말할 때 배경음악을 자동으로 줄입니다.'],
  ['7. 내보내기', '파일 ▸ 내보내기 ▸ 미디어(Ctrl+M)에서 유튜브·쇼츠·움짤 같은 프리셋을 고르고 내보내기를 누르면 파일이 저장됩니다.'],
  ['사진 편집', '위 막대의 "사진 편집"(휴대폰은 "사진")을 누르면 포토샵처럼 레이어·선택·브러시·보정·필터·글자로 사진을 고칠 수 있습니다. 프로젝트 패널에서 이미지를 오른쪽 클릭 ▸ 사진 편집에서 열기로 가져가고, 다 고친 뒤 사진 편집의 파일 ▸ 영상 편집으로 보내기로 돌려보냅니다.'],
  ['저장에 대해', '작업은 이 브라우저에 자동 저장됩니다. 다른 컴퓨터로 옮기거나 백업하려면 파일 ▸ 저장(Ctrl+S)으로 프로젝트 파일을 받아 두세요. 미디어 파일 자체는 프로젝트 파일에 들어가지 않습니다.'],
  ['화면이 작거나 글씨가 작다면', '창 ▸ 화면 크기에서 크게/아주 크게를 고르세요. 창 ▸ 작업 영역에서 용도에 맞는 패널 배치를 고를 수 있습니다. 모든 단축키는 도움말 ▸ 키보드 단축키(F1)에서 봅니다.'],
];

export function openGuideDialog() {
  openModal({
    title: '시작 가이드',
    width: '620px',
    body: h('div.guide', GUIDE.map(([t, d]) => h('section', h('h4', t), h('p', d)))),
    buttons: [
      { label: '키보드 단축키', action: () => { setTimeout(openShortcutsDialog, 0); } },
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
      h('p', '사진 편집기(위 막대의 "사진 편집")는 레이어·마스크·조정·필터를 갖춘 사진 편집 프로그램으로, PSD 파일은 ag-psd 라이브러리(MIT)로 읽고 씁니다.'),
      h('p', '영상 디코딩/인코딩은 mediabunny 라이브러리(MPL-2.0)로 WebCodecs를 사용합니다. 어도비 프리미어 프로·포토샵과는 관계없는 독립 프로그램입니다.')),
  });
}
