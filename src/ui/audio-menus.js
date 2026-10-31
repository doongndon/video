// Commands and menu items of the audio / export / media area: 오디오 게인 (G), 기본 사운드 panel,
// 프레임 내보내기, 푸티지 해석, 미디어 교체, slow shuttle and sequence loudness. Imported once by main.js
// before the menu bar is built.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { commands } from '../commands.js';
import { extendMenu } from './menubar.js';
import { showPanel, toast } from './common.js';
import { openAudioGainDialog } from './audio-gain.js';
import { openExportFrameDialog } from './export-dialog.js';
import { openInterpretFootageDialog, replaceFootage } from './media-dialogs.js';
import { formatTimecode } from '../util.js';

/**
 * Project items a media command works on: selected in the project panel, else the selected clips'
 * media. A subclip stands for its master item (they share the file).
 */
function targetMedia(filter = () => true) {
  const master = (id) => store.project.media[id]?.subclipOf || id;
  const ok = (id) => id && store.project.media[id] && filter(store.project.media[id]);
  const picked = [...new Set([...(store.ui.selectedMedia || [])].map(master))].filter(ok);
  if (picked.length) return picked;
  return [...new Set(store.selectedClips().map((c) => master(c.mediaId)))].filter(ok);
}

Object.assign(commands, {
  audioGain: () => openAudioGainDialog(),
  essentialSound: () => showPanel('essentialSound'),
  exportFrame: () => openExportFrameDialog(),
  interpretFootage: () => {
    const ids = targetMedia((m) => m.kind === 'video' || m.kind === 'image');
    if (!ids.length) return toast('프로젝트 패널이나 타임라인에서 영상 클립을 먼저 선택하세요');
    openInterpretFootageDialog(ids);
  },
  replaceFootage: () => {
    const ids = targetMedia((m) => !['sequence', 'color', 'adjustment'].includes(m.kind));
    if (!ids.length) return toast('바꿀 항목을 프로젝트 패널이나 타임라인에서 먼저 선택하세요');
    replaceFootage(ids[0]);
  },
  shuttleSlowBack: () => playback.shuttleSlow(-1),
  shuttleSlowForward: () => playback.shuttleSlow(1),
  measureLoudness: async () => {
    const s = store.seq;
    const hasIO = s.inPoint != null || s.outPoint != null;
    const { exportRange } = await import('../export.js');
    const r = exportRange(hasIO ? 'inout' : 'all');
    if (r.end - r.start <= 0) return toast('시퀀스가 비어 있습니다');
    toast('시퀀스 음량을 재는 중…');
    const { measureSequence } = await import('../loudness.js');
    const m = await measureSequence(r.start, r.end).catch((err) => {
      toast(`측정 실패: ${err.message || err}`);
      return null;
    });
    if (!m) return;
    const where = hasIO ? `${formatTimecode(r.start, s.fps)}~${formatTimecode(r.end, s.fps)}` : '전체';
    toast(Number.isFinite(m.integrated)
      ? `음량 (${where}): ${m.integrated.toFixed(1)} LUFS · 트루 피크 ${m.truePeak.toFixed(1)} dBTP · 범위 ${m.range.toFixed(1)} LU`
      : '들리는 소리가 없습니다');
  },
});

const hasAudioSel = () => store.selectedClips().some((c) => c.kind === 'audio' || c.linkId);

extendMenu('클립', (items) => [
  ...items,
  { label: '오디오 게인…', key: 'G', disabled: !hasAudioSel(), action: () => commands.audioGain() },
  { label: '미디어 교체 (푸티지 바꾸기)…', action: () => commands.replaceFootage() },
  { label: '푸티지 해석…', action: () => commands.interpretFootage() },
]);

extendMenu('시퀀스', (items) => [
  ...items,
  { label: '시퀀스 음량 측정 (LUFS)', action: () => commands.measureLoudness() },
]);

extendMenu('창', (items) => [
  ...items,
  { label: '기본 사운드', action: () => commands.essentialSound() },
]);
