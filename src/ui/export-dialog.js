// 내보내기 설정 (Export Settings, Ctrl+M) and 프레임 내보내기 (Export Frame, Ctrl+Shift+E), after
// Premiere Pro: format, source range, frame size and rate, bitrate encoding (CBR / VBR), target and
// maximum bitrate, key frame distance, audio sample rate / channels / bitrate, loudness normalisation,
// maximum render quality, import into project, and an estimated file size.

import { store } from '../store.js';
import { h, formatTimecode, parseTimecode, formatBytes, downloadBlob, clamp } from '../util.js';
import { openModal, formRow, toast, loadPref, savePref } from './common.js';
import {
  FORMATS, EXPORT_PRESETS, formatId, exportRange, exportSequence, exportFrame, estimateExportSize, suggestedBitrate,
  outputSize, encodableVideoCodecs, encodableAudioCodecs,
} from '../export.js';
import { importFiles, prepareSoundCapture } from '../media.js';
import { sequenceDuration } from '../model.js';

const SCALE_OPTIONS = [['1', '시퀀스 설정과 같게 (100%)'], ['0.75', '75%'], ['0.5', '50% (절반)'], ['0.25', '25%'], ['uhd', '4K 폭 (3840)'], ['gif', '480px 폭 (움짤용)'], ['2', '200% (확대)']];
const LOUDNESS_TARGETS = [[-14, '-14 LUFS (유튜브·스트리밍)'], [-16, '-16 LUFS (팟캐스트·애플)'], [-23, '-23 LUFS (EBU R128 방송)'], [-24, '-24 LUFS (ATSC A/85 방송)']];

function resolveScale(v, seq) {
  if (v === 'uhd') return 3840 / Math.max(seq.width, seq.height > seq.width ? seq.height * (16 / 9) : seq.width);
  if (v === 'gif') return Math.min(1, 480 / seq.width);
  return parseFloat(v) || 1;
}

const note = (...t) => h('div.note', ...t);
const select = (options, value) => h('select', options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
const check = (checked, label) => {
  const box = h('input', { type: 'checkbox', checked });
  return { box, el: h('label.check', box, ` ${label}`) };
};
const numberInput = (value, { min, max, step = 1, width = '84px' } = {}) => h('input', { type: 'number', value, min, max, step, style: { width } });
const heading = (text) => h('div', { style: { fontWeight: '700', margin: '12px 0 4px', borderBottom: '1px solid var(--line-2, #333)', paddingBottom: '3px' } }, text);

let support = null; // encodable codecs, checked once
const supportReady = () => support || (support = Promise.all([encodableVideoCodecs(1920, 1080), encodableAudioCodecs()]).then(([v, a]) => ({ v, a })).catch(() => ({ v: {}, a: {} })));

/**
 * Render with exportSequence, then save the file (and import it when asked). The progress bar,
 * status line and missing-sound note are elements of the calling dialog or pop-up.
 */
async function runExport({ o, fmt, baseName, token, setProg, status, silentNote, importAfter = false }) {
  const result = await exportSequence({
    ...o,
    baseName,
    token,
    onProgress: (p, label) => {
      setProg(p);
      status.textContent = label || '';
    },
  });
  const name = `${baseName}.${fmt.ext}`;
  setProg(1);
  status.textContent = `${name} 완성 · ${formatBytes(result.blob.size)} · ${result.info}`;
  if (result.warnings?.length) {
    silentNote.textContent = `소리를 풀지 못해 이 파일은 소리 없이 들어갔습니다 — ${result.warnings.join(' / ')}. 다른 브라우저(예: Chrome)에서 내보내면 소리가 들어갈 수 있습니다.`;
    silentNote.hidden = false;
  }
  if (importAfter && fmt.ext !== 'zip') {
    const file = new File([result.blob], name, { type: result.blob.type });
    importFiles([file]).then((ids) => { if (ids.length) toast(`${name}을(를) 프로젝트에 가져왔습니다`); });
  }
  if (await downloadBlob(result.blob, name)) {
    status.textContent = `${name} 저장 · ${formatBytes(result.blob.size)} · ${result.info}`;
    toast(result.warnings?.length ? `${name} 파일을 내보냈습니다 (일부 소리 빠짐)` : `${name} 파일을 내보냈습니다`);
  }
  return result;
}

/** mount: lay the settings into that element (the 내보내기 mode page) instead of a dialog. */
export function openExportSettings({ mount = null } = {}) {
  const s = store.seq;
  const saved = loadPref('export.settings', {});
  const fileName = h('input', { type: 'text', value: (s.name || '시퀀스').replace(/[\\/:*?"<>|]+/g, '_'), style: { width: '100%' } });
  const format = select(Object.entries(FORMATS).map(([k, f]) => [k, f.label]), formatId(saved.format || 'h264'));
  const hasInOut = s.inPoint != null || s.outPoint != null;
  const range = select([['all', '전체 시퀀스'], ['inout', '시퀀스 시작/끝 (In~Out)'], ['custom', '사용자 지정']], hasInOut ? 'inout' : 'all');
  const tc = (t) => formatTimecode(t, s.fps);
  const r0 = exportRange(hasInOut ? 'inout' : 'all');
  const customStart = h('input', { type: 'text', value: tc(r0.start), style: { width: '112px' }, 'aria-label': '시작 타임코드' });
  const customEnd = h('input', { type: 'text', value: tc(r0.end), style: { width: '112px' }, 'aria-label': '끝 타임코드' });
  const customRow = formRow('시작 ~ 끝', customStart, h('span', '~'), customEnd);
  const scale = select(SCALE_OPTIONS, saved.scale || '1');
  const fps = select([['', `시퀀스와 같게 (${s.fps} fps)`], ['120', '120 fps'], ['60', '60 fps'], ['59.94', '59.94 fps'], ['50', '50 fps'], ['30', '30 fps'], ['29.97', '29.97 fps'], ['25', '25 fps'], ['24', '24 fps'], ['23.976', '23.976 fps'], ['15', '15 fps'], ['12', '12 fps'], ['10', '10 fps']], saved.fps || '');
  const encoding = select([['quality', '화질 기준 (자동, 권장)'], ['variable', 'VBR (가변 비트레이트)'], ['constant', 'CBR (고정 비트레이트)']], saved.encoding || 'quality');
  const quality = select([['very-high', '매우 높음 (파일 큼)'], ['high', '높음 (권장)'], ['medium', '보통'], ['low', '낮음 (파일 작음)']], saved.quality || 'high');
  const target = numberInput(saved.target || 10, { min: 0.2, max: 200, step: 0.1 });
  const maxRate = numberInput(saved.maxRate || 16, { min: 0.2, max: 300, step: 0.1 });
  const kfOn = check(!!saved.kfOn, '키프레임 간격 지정');
  const kfFrames = numberInput(saved.kfFrames || 60, { min: 1, max: 1000, step: 1, width: '72px' });
  const maxQ = check(!!saved.maxQuality, '최대 렌더링 품질 사용 (크기를 줄일 때 더 선명, 느림)');
  const audio = check(saved.audio !== false, '오디오 내보내기');
  const sampleRate = select([['48000', '48000 Hz'], ['44100', '44100 Hz'], ['32000', '32000 Hz']], saved.sampleRate || '48000');
  const channels = select([['2', '스테레오'], ['1', '모노']], saved.channels || '2');
  const audioBitrate = select([['320', '320 kbps'], ['256', '256 kbps'], ['192', '192 kbps'], ['160', '160 kbps'], ['128', '128 kbps'], ['96', '96 kbps']], saved.audioBitrate || '192');
  const loudOn = check(!!saved.loudOn, '음량 정규화');
  const loudTarget = select(LOUDNESS_TARGETS, saved.loudTarget ?? -14);
  const truePeak = select([['-1', '-1 dBTP (권장)'], ['-2', '-2 dBTP (방송)'], ['-0.1', '-0.1 dBTP']], saved.truePeak || '-1');
  const measureBtn = h('button', '음량 측정');
  const measureOut = h('span.note', '');
  const measureRow = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, measureBtn, measureOut);
  const importAfter = check(!!saved.importAfter, '프로젝트로 가져오기 (내보낸 파일을 프로젝트 패널에 추가)');
  const codecNote = note();
  const summary = note();
  const sizeEl = h('b');
  const warn = h('div.note.warn');
  const prog = h('div.progress', h('div'));
  const status = note('');
  const silentNote = h('div.note.warn', { hidden: true });
  let presetId = null;
  let codecs = null;

  const presetBtns = EXPORT_PRESETS.map((p) => {
    const b = h('button.preset', { onclick: () => applyPreset(p) }, h('b', p.name), h('small', p.desc));
    b.dataset.id = p.id;
    return b;
  });
  const applyPreset = (p) => {
    presetId = p.id;
    format.value = formatId(p.format);
    scale.value = String(p.scale);
    quality.value = p.quality;
    encoding.value = 'quality';
    fps.value = p.fps ? String(p.fps) : '';
    loudOn.box.checked = !!p.loudness;
    if (p.loudness) loudTarget.value = String(p.loudness);
    maxQ.box.checked = !!p.maxQuality;
    update();
  };

  const currentRange = () => {
    if (range.value !== 'custom') return exportRange(range.value);
    const a = parseTimecode(customStart.value, s.fps);
    const b = parseTimecode(customEnd.value, s.fps);
    return exportRange('custom', { start: a ?? 0, end: b ?? sequenceDuration(s) });
  };

  const options = () => {
    const f = FORMATS[format.value];
    const rate = parseFloat(fps.value) || s.fps;
    const sc = resolveScale(scale.value, s);
    const enc = encoding.value;
    let bitrate = null;
    if (enc !== 'quality') {
      bitrate = clamp(parseFloat(target.value) || 8, 0.2, 300);
      if (enc === 'variable') bitrate = Math.min(bitrate, Math.max(0.2, parseFloat(maxRate.value) || bitrate));
    }
    return {
      format: format.value,
      scale: sc,
      fps: parseFloat(fps.value) || null,
      quality: quality.value,
      bitrate,
      bitrateMode: enc === 'quality' ? undefined : enc,
      keyframeInterval: kfOn.box.checked ? Math.max(1, Math.round(parseFloat(kfFrames.value) || 0)) : 0,
      maxQuality: maxQ.box.checked,
      range: currentRange(),
      audio: f.audioOnly ? true : audio.box.checked,
      sampleRate: Number(sampleRate.value),
      channels: Number(channels.value),
      audioBitrate: Number(audioBitrate.value),
      loudness: loudOn.box.checked ? { target: Number(loudTarget.value), truePeak: Number(truePeak.value) } : null,
      _rate: rate,
    };
  };

  const persist = () => savePref('export.settings', {
    format: format.value, scale: scale.value, fps: fps.value, encoding: encoding.value, quality: quality.value,
    target: parseFloat(target.value) || 10, maxRate: parseFloat(maxRate.value) || 16, kfOn: kfOn.box.checked, kfFrames: parseFloat(kfFrames.value) || 60,
    maxQuality: maxQ.box.checked, audio: audio.box.checked, sampleRate: sampleRate.value, channels: channels.value, audioBitrate: audioBitrate.value,
    loudOn: loudOn.box.checked, loudTarget: Number(loudTarget.value), truePeak: truePeak.value, importAfter: importAfter.box.checked,
  });

  const show = (el, on) => {
    // the first update runs before the fields are placed in their rows: it hid the field itself, so
    // once it is in a row, show or hide the row and clear the field's own flag (목표 음량 stayed hidden)
    const row = el.closest('.form-row');
    if (row) el.hidden = false;
    (row || el).hidden = !on;
  };

  const update = () => {
    const f = FORMATS[format.value];
    const o = options();
    const video = !f.audioOnly;
    const encoded = !!f.video;
    const { w, h: hh } = outputSize(s, o.scale);
    for (const b of presetBtns) b.classList.toggle('on', b.dataset.id === presetId);
    customRow.hidden = range.value !== 'custom';
    show(scale, video);
    show(fps, video);
    show(encoding, encoded);
    show(quality, encoded && encoding.value === 'quality');
    show(target, encoded && encoding.value !== 'quality');
    show(maxRate, encoded && encoding.value === 'variable');
    show(kfFrames, encoded);
    maxQ.el.hidden = !video;
    audio.el.hidden = !encoded;
    const withAudio = f.audioOnly || (encoded && audio.box.checked);
    show(sampleRate, withAudio);
    show(channels, withAudio);
    show(audioBitrate, withAudio && (f.audioOnly ? !!f.codec : true));
    loudOn.el.hidden = !withAudio;
    show(loudTarget, withAudio && loudOn.box.checked);
    show(truePeak, withAudio && loudOn.box.checked);
    measureRow.hidden = !withAudio;
    kfFrames.disabled = !kfOn.box.checked;
    // codec line
    const parts = [];
    if (encoded) parts.push(`비디오: ${f.video === 'avc' ? 'H.264' : f.video.toUpperCase()}`);
    if (withAudio) {
      const ac = f.audioOnly ? (f.codec ? f.codec.toUpperCase() : 'PCM 16비트') : f.audio.map((c) => c.toUpperCase()).join(' 또는 ');
      parts.push(`오디오: ${ac}`);
      if ((f.codec === 'opus' || (encoded && f.audio[0] === 'opus')) && o.sampleRate !== 48000) parts.push('Opus는 48000 Hz로 만듭니다');
    }
    codecNote.textContent = parts.join(' · ');
    // availability
    const warnings = [];
    if (codecs && encoded && codecs.v[f.video] === false) warnings.push(`이 브라우저는 ${f.label} 인코딩을 지원하지 않습니다. H.264나 VP9를 고르세요.`);
    if (presetId === 'shorts' && s.width >= s.height) warnings.push('지금 시퀀스는 가로 화면입니다. 세로(9:16) 영상이 필요하면 먼저 시퀀스 ▸ 자동 리프레임으로 세로 시퀀스를 만드세요.');
    if (f.gif && (o.range.end - o.range.start) * o._rate > 600) warnings.push('GIF가 600프레임을 넘습니다. 시간이 오래 걸리고 파일이 매우 커질 수 있습니다.');
    if (f.seq && (o.range.end - o.range.start) * o._rate > 3000) warnings.push('이미지가 3000장을 넘습니다. 시간이 오래 걸리고 ZIP 파일이 매우 커질 수 있습니다.');
    if (o.scale > 1.01 && video) warnings.push('원본보다 크게 내보내면 화질이 좋아지지는 않습니다 (확대만 됩니다).');
    const srcFps = Math.max(0, ...Object.values(s.clips).filter((c) => c.kind === 'video').map((c) => store.project.media[c.mediaId]?.fps || 0));
    if (video && srcFps && o._rate > srcFps + 0.5) warnings.push(`영상 원본이 ${Math.round(srcFps)} fps라 ${o._rate} fps로 내보내도 영상 장면은 같은 프레임이 반복됩니다.`);
    if (encoding.value === 'variable' && (parseFloat(maxRate.value) || 0) < (parseFloat(target.value) || 0)) warnings.push('최대 비트레이트가 목표보다 작아 목표를 최대값으로 맞춥니다.');
    if (o.range.end - o.range.start <= 0) warnings.push('내보낼 구간이 비어 있습니다.');
    warn.textContent = warnings.join(' ');
    warn.hidden = !warnings.length;
    // summary + estimate
    const range0 = `${tc(o.range.start)} ~ ${tc(o.range.end)} (${(o.range.end - o.range.start).toFixed(1)}초)`;
    const vDesc = encoded
      ? (encoding.value === 'quality' ? `화질 ${quality.selectedOptions[0]?.textContent.split(' ')[0]} (약 ${suggestedBitrate(f.video, w, hh, o._rate, quality.value).toFixed(1)} Mbps)` : `${encoding.value === 'constant' ? 'CBR' : 'VBR'} ${o.bitrate} Mbps`)
      : '';
    summary.textContent = f.audioOnly ? `소리만 · ${range0}` : `${w}×${hh} · ${o._rate} fps${vDesc ? ` · ${vDesc}` : ''} · ${range0}`;
    sizeEl.textContent = `약 ${formatBytes(estimateExportSize(o, s))}`;
    measureOut.textContent = '';
    persist();
  };

  for (const el of [format, range, scale, quality, fps, encoding, sampleRate, channels, audioBitrate, loudTarget, truePeak]) el.addEventListener('change', () => { if (el !== loudTarget && el !== truePeak) presetId = null; update(); });
  for (const el of [target, maxRate, kfFrames, customStart, customEnd]) el.addEventListener('input', update);
  for (const c of [kfOn, maxQ, audio, loudOn, importAfter]) c.box.addEventListener('change', update);
  // Esc (close) and Tab (move inside the dialog) still reach the dialog
  for (const el of [fileName, customStart, customEnd]) el.addEventListener('keydown', (e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); });
  encoding.addEventListener('change', () => {
    // a sensible starting bitrate for the chosen size and quality
    if (encoding.value !== 'quality') {
      const f = FORMATS[format.value];
      const o = options();
      const { w, h: hh } = outputSize(s, o.scale);
      if (f.video) {
        const b = suggestedBitrate(f.video, w, hh, o._rate, quality.value);
        target.value = String(Math.round(b * 10) / 10);
        maxRate.value = String(Math.round(b * 1.6 * 10) / 10);
        update();
      }
    }
  });

  measureBtn.addEventListener('click', async () => {
    const o = options();
    measureBtn.disabled = true;
    measureOut.textContent = '측정 중…';
    try {
      const { measureSequence } = await import('../loudness.js');
      const m = await measureSequence(o.range.start, o.range.end, (f) => { measureOut.textContent = `측정 중… ${Math.round(f * 100)}%`; });
      measureOut.textContent = m && Number.isFinite(m.integrated)
        ? `현재 ${m.integrated.toFixed(1)} LUFS · 트루 피크 ${m.truePeak.toFixed(1)} dBTP · 음량 범위 ${m.range.toFixed(1)} LU`
        : '들리는 소리가 없습니다';
    } catch (err) {
      measureOut.textContent = `측정 실패: ${err.message || err}`;
    } finally {
      measureBtn.disabled = false;
    }
  });

  update();
  supportReady().then((sup) => {
    codecs = sup;
    for (const opt of format.options) {
      const f = FORMATS[opt.value];
      const bad = (f.video && sup.v[f.video] === false) || (f.audioOnly && f.codec && sup.a[f.codec] === false);
      opt.disabled = bad;
      if (bad && !opt.textContent.endsWith(' — 이 브라우저 미지원')) opt.textContent += ' — 이 브라우저 미지원';
    }
    if (format.selectedOptions[0]?.disabled) format.value = Object.keys(FORMATS).find((k) => !format.querySelector(`option[value="${k}"]`).disabled) || 'vp9';
    update();
  });

  const token = { cancelled: false };
  let running = false;
  const modal = openModal({
    title: '내보내기 설정',
    width: '660px',
    body: [
      h('div.preset-grid', presetBtns),
      heading('설정'),
      formRow('파일 이름', fileName),
      formRow('형식', format),
      codecNote,
      formRow('소스 범위', range),
      customRow,
      heading('비디오'),
      formRow('프레임 크기', scale),
      formRow('프레임 속도', fps),
      formRow('비트레이트 인코딩', encoding),
      formRow('화질', quality),
      formRow('목표 비트레이트', target, h('span', 'Mbps')),
      formRow('최대 비트레이트', maxRate, h('span', 'Mbps (VBR)')),
      formRow('키프레임 간격', kfOn.el, kfFrames, h('span', '프레임')),
      maxQ.el,
      heading('오디오'),
      audio.el,
      formRow('샘플 속도', sampleRate),
      formRow('채널', channels),
      formRow('오디오 비트레이트', audioBitrate),
      heading('효과'),
      loudOn.el,
      formRow('목표 음량 (ITU BS.1770)', loudTarget),
      formRow('최대 트루 피크', truePeak),
      measureRow,
      heading('일반'),
      importAfter.el,
      summary,
      h('div.note', '예상 파일 크기: ', sizeEl),
      warn,
      prog,
      status,
      silentNote,
      note('이 탭 안에서 프레임 단위로 렌더링합니다 (WebCodecs). 끝날 때까지 탭을 열어 두세요.'),
    ],
    buttons: [
      { label: '닫기', action: () => { token.cancelled = true; } },
      {
        label: '내보내기', primary: true, action: async () => {
          if (running) return false;
          const o = options();
          if (o.range.end - o.range.start <= 0) {
            status.textContent = '내보낼 구간이 비어 있습니다.';
            return false;
          }
          running = true;
          token.cancelled = false;
          silentNote.hidden = true;
          // must run inside the tap: phone browsers only start audio/media from a gesture
          if (o.audio) prepareSoundCapture();
          const f = FORMATS[format.value];
          const btn = modal.footer.querySelector('button.primary');
          btn.disabled = true;
          const setProg = (p) => { prog.firstChild.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`; };
          try {
            await runExport({ o, fmt: f, baseName: fileName.value || 'export', token, setProg, status, silentNote, importAfter: importAfter.box.checked });
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
    mount,
  });
  return modal;
}

// ---------------------------------------------------------------- export frame

/** 프레임 내보내기: the program frame at the playhead as PNG or JPEG, optionally imported into the project. */
export function openExportFrameDialog() {
  const s = store.seq;
  const t = store.ui.playhead;
  const saved = loadPref('exportFrame', {});
  const base = `${s.name || 'frame'}_${formatTimecode(t, s.fps).replace(/:/g, '-')}`.replace(/[\\/:*?"<>|]+/g, '_');
  const name = h('input', { type: 'text', value: base, style: { width: '100%' } });
  name.addEventListener('keydown', (e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); });
  const type = select([['image/png', 'PNG (무손실)'], ['image/jpeg', 'JPEG (작은 파일)']], saved.type || 'image/png');
  const quality = numberInput(saved.quality ?? 92, { min: 10, max: 100, step: 1, width: '72px' });
  const qRow = formRow('JPEG 품질', quality, h('span', '%'));
  const importAfter = check(!!saved.importAfter, '프로젝트로 가져오기');
  const status = note(`${formatTimecode(t, s.fps)} · ${s.width}×${s.height}`);
  const sync = () => { qRow.hidden = type.value !== 'image/jpeg'; };
  type.addEventListener('change', sync);
  sync();
  openModal({
    title: '프레임 내보내기',
    width: '420px',
    body: [formRow('이름', name), formRow('형식', type), qRow, importAfter.el, status],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: async () => {
          savePref('exportFrame', { type: type.value, quality: parseFloat(quality.value) || 92, importAfter: importAfter.box.checked });
          status.textContent = '프레임을 그리는 중…';
          const blob = await exportFrame(t, { type: type.value, quality: clamp((parseFloat(quality.value) || 92) / 100, 0.1, 1) });
          if (!blob) {
            status.textContent = '프레임을 만들지 못했습니다';
            return false;
          }
          const file = `${name.value || base}.${type.value === 'image/png' ? 'png' : 'jpg'}`;
          if (importAfter.box.checked) {
            importFiles([new File([blob], file, { type: type.value })]).then((ids) => { if (ids.length) toast(`${file}을(를) 프로젝트에 가져왔습니다`); });
          }
          if (await downloadBlob(blob, file)) toast(`${file} 저장`);
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- quick export

/** Premiere's 빠른 내보내기 사전 설정: H.264 at the sequence's size and frame rate. */
const QUICK_PRESETS = [
  { id: 'high', name: '소스 일치 - 적응형 고속 비트레이트', quality: 'high', audioBitrate: 320 },
  { id: 'medium', name: '소스 일치 - 적응형 중간 비트레이트', quality: 'medium', audioBitrate: 192 },
  { id: 'low', name: '소스 일치 - 적응형 낮은 비트레이트', quality: 'low', audioBitrate: 128 },
];
let quickPop = null;

/**
 * 빠른 내보내기 (the header's share button): a small pop-up under the button with 파일 이름 및 위치,
 * 사전 설정, 예상 파일 크기 and 내보내기; moreSettings() opens the full 내보내기 settings.
 */
export function openQuickExport(anchor, { moreSettings } = {}) {
  if (quickPop) {
    quickPop.close();
    return;
  }
  const s = store.seq;
  const tc = (t) => formatTimecode(t, s.fps);
  const fileName = h('input', { type: 'text', value: (s.name || '시퀀스').replace(/[\\/:*?"<>|]+/g, '_'), 'aria-label': '파일 이름' });
  const ext = h('span.qe-ext', '.mp4');
  const preset = select(QUICK_PRESETS.map((p) => [p.id, p.name]), loadPref('export.quick', 'high'));
  preset.setAttribute('aria-label', '사전 설정');
  const summary = note();
  const sizeEl = h('b');
  const prog = h('div.progress', { hidden: true }, h('div'));
  const status = note('');
  const silentNote = h('div.note.warn', { hidden: true });
  const token = { cancelled: false };
  let running = false;
  let format = 'h264';

  const options = () => {
    const p = QUICK_PRESETS.find((x) => x.id === preset.value) || QUICK_PRESETS[0];
    return {
      format, scale: 1, fps: null, quality: p.quality, bitrate: null, keyframeInterval: 0, maxQuality: false,
      // like Premiere, a marked In / Out range is what gets exported
      range: exportRange('inout'),
      audio: true, sampleRate: 48000, channels: 2, audioBitrate: p.audioBitrate, loudness: null,
    };
  };
  const update = () => {
    const o = options();
    const f = FORMATS[format];
    const { w, h: hh } = outputSize(s, 1);
    ext.textContent = `.${f.ext}`;
    summary.textContent = `${f.label} · ${w}×${hh} · ${s.fps} fps · ${tc(o.range.start)} ~ ${tc(o.range.end)}`;
    sizeEl.textContent = `약 ${formatBytes(estimateExportSize(o, s))}`;
    savePref('export.quick', preset.value);
  };
  preset.addEventListener('change', update);
  // typing a file name must not reach the editor's shortcuts
  fileName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go.click();
    if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
  });

  const more = h('button', { type: 'button', title: '형식, 프레임 크기, 비트레이트, 오디오 등 모든 설정' }, '내보내기 설정 열기…');
  const go = h('button.primary', { type: 'button' }, '내보내기');
  const el = h('div.qe-pop', { role: 'dialog', 'aria-label': '빠른 내보내기' },
    h('div.qe-title', '빠른 내보내기'),
    h('div.qe-sub', s.name || '시퀀스'),
    h('label.qe-label', '파일 이름 및 위치'),
    h('div.qe-file', fileName, ext),
    note('브라우저의 다운로드 폴더에 저장됩니다'),
    h('label.qe-label', '사전 설정'),
    preset,
    summary,
    h('div.note', '예상 파일 크기: ', sizeEl),
    prog, status, silentNote,
    h('div.qe-buttons', more, go));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.left = `${clamp(r.right - w, 4, window.innerWidth - w - 4)}px`;
  el.style.top = `${r.bottom + 4}px`;

  const close = () => {
    if (running) return;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    quickPop = null;
  };
  // a press outside closes it (not while a file is being made)
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (running) token.cancelled = true;
    else close();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  quickPop = { close };

  more.addEventListener('click', () => {
    if (running) {
      token.cancelled = true;
      return;
    }
    close();
    moreSettings ? moreSettings() : openExportSettings();
  });
  go.addEventListener('click', async () => {
    if (running) return;
    const o = options();
    if (o.range.end - o.range.start <= 0) {
      status.textContent = '내보낼 구간이 비어 있습니다. 타임라인에 클립을 놓으세요.';
      return;
    }
    running = true;
    token.cancelled = false;
    silentNote.hidden = true;
    prepareSoundCapture();
    go.disabled = preset.disabled = fileName.disabled = true;
    more.textContent = '취소';
    prog.hidden = false;
    const setProg = (p) => { prog.firstChild.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`; };
    try {
      await runExport({ o, fmt: FORMATS[format], baseName: fileName.value.trim() || 'export', token, setProg, status, silentNote });
    } catch (err) {
      console.error(err);
      status.textContent = `내보내기 실패: ${err.message || err}`;
    } finally {
      running = false;
      go.disabled = preset.disabled = fileName.disabled = false;
      more.textContent = '내보내기 설정 열기…';
    }
  });

  update();
  fileName.focus();
  fileName.select();
  // a browser that cannot make H.264 makes WebM (VP9) instead
  supportReady().then((sup) => {
    if (sup.v.avc !== false || !el.isConnected) return;
    format = sup.v.vp9 !== false ? 'vp9' : format;
    update();
  });
}
