// 그래픽 및 타이틀 menu additions: 롤/크롤 옵션 (Premiere's roll / crawl) and 캡션 스타일 (a look for a
// whole caption track).

import { store } from '../store.js';
import { extendMenu } from './menubar.js';
import { toast } from './common.js';
import { CAPTION_STYLES, captionTargets, applyCaptionStyle } from '../features.js';
import { openRollCrawlDialog } from './dialogs.js';

/** Apply a caption style to the caption track(s) of the selection (or the main caption track). */
export function captionStyleCommand(styleId) {
  const ids = captionTargets();
  if (!ids.length) {
    toast('캡션(텍스트 클립)이 있는 트랙이 없습니다. 자동 캡션이나 .srt 가져오기로 먼저 캡션을 만드세요.');
    return 0;
  }
  const n = applyCaptionStyle(ids, styleId);
  const st = CAPTION_STYLES.find((x) => x.id === styleId);
  if (n) toast(`캡션 ${n}개에 "${st?.name}" 스타일을 적용했습니다`);
  return n;
}

export const captionStyleMenu = () => CAPTION_STYLES.map((st) => ({ label: st.name, action: () => captionStyleCommand(st.id) }));

extendMenu('그래픽 및 타이틀', (items) => [
  ...items,
  { label: '롤/크롤 옵션…', disabled: !store.selectedClips().some((c) => c.kind !== 'audio'), action: openRollCrawlDialog },
  { label: '캡션 스타일', submenu: captionStyleMenu },
]);
