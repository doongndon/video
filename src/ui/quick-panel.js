// "빠른 편집" panel: one-tap animations, filters (with live thumbnails), text styles, stickers,
// framing (aspect ratio, picture-in-picture, background fill), voice effects and automatic edits.
// On phones the same sections open as bottom sheets from the bottom toolbar.

import { store } from '../store.js';
import { playback } from '../playback.js';
import * as edit from '../edit.js';
import { Compositor } from '../compositor.js';
import { clipEnd, evalParam } from '../model.js';
import { h, clamp } from '../util.js';
import { toast, loadPref, savePref } from './common.js';
import { icon } from './icons.js';
import {
  ANIMATIONS, applyAnimation, clearAnimations, FILTERS, applyFilter, clipFilter, previewWithFilter, TEXT_STYLES, applyTextStyle,
  EMOJIS, addSticker, PIP_POSITIONS, setPip, setBackgroundFill, setSequenceBackground, VOICES, applyVoice, clipVoice,
  ASPECTS, setAspect, targetVisualClips, targetAudioClips,
} from '../features.js';
import { openSilenceCutDialog, openBeatDialog, openSlideshowDialog, openExtractAudioDialog, openAutoCaptionDialog, openDuckingDialog, openSceneDetectDialog } from './dialogs.js';

export const QUICK_SECTIONS = [
  ['anim', '애니메이션', 'wand'],
  ['filter', '필터', 'image'],
  ['text', '글자', 'text'],
  ['sticker', '스티커', 'plus'],
  ['frame', '화면', 'grid'],
  ['audio', '소리', 'audio'],
  ['auto', '자동 편집', 'scissors'],
];

export const quickApi = {};

const needClip = (what = '클립') => toast(`${what}을(를) 먼저 선택하거나, 재생헤드를 클립 위에 두세요`);

export function createQuickPanel() {
  let section = loadPref('quick.section', 'anim');
  const tabs = h('div.qp-tabs', QUICK_SECTIONS.map(([id, name, ic]) => {
    const b = h('button.qp-tab', { onclick: () => show(id), title: name }, icon(ic), h('span', name));
    b.dataset.sec = id;
    return b;
  }));
  const content = h('div.qp-content');
  const body = h('div.quick', tabs, content);
  let visible = false;
  let renderers = [];

  function show(id) {
    section = id;
    savePref('quick.section', id);
    tabs.querySelectorAll('.qp-tab').forEach((b) => b.classList.toggle('on', b.dataset.sec === id));
    renderers = [];
    content.replaceChildren(...(SECTIONS[id] || SECTIONS.anim)());
    refresh();
  }

  function refresh() {
    for (const r of renderers) r();
  }

  // ---- helpers
  const grid = (items, cls = '') => h(`div.qp-grid${cls}`, items);
  const title = (t, extra) => h('div.qp-title', h('span', t), extra || null);
  const hint = (t) => h('div.note.qp-hint', t);
  const slider = (label, min, max, step, value, onInput, fmt = (v) => v) => {
    const out = h('span.qp-val', fmt(value));
    const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
    r.addEventListener('input', () => {
      out.textContent = fmt(parseFloat(r.value));
      onInput?.(parseFloat(r.value), false);
    });
    r.addEventListener('change', () => onInput?.(parseFloat(r.value), true));
    const set = (v) => {
      r.value = v;
      out.textContent = fmt(v);
    };
    return { el: h('label.qp-slider', h('span', label), r, out), input: r, set };
  };
  const targetInfo = (kind = 'visual') => {
    const el = hint('');
    renderers.push(() => {
      const ids = kind === 'audio' ? targetAudioClips() : targetVisualClips();
      const names = ids.map((id) => store.seq.clips[id]?.name).filter(Boolean);
      el.textContent = names.length ? `적용 대상: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}개` : ''}` : '적용할 클립을 타임라인에서 선택하세요 (선택이 없으면 재생헤드 아래 클립)';
    });
    return el;
  };

  const SECTIONS = {
    anim() {
      let dur = loadPref('quick.animDur', 0.6);
      const dSlider = slider('길이', 0.2, 2, 0.1, dur, (v) => { dur = v; savePref('quick.animDur', v); }, (v) => `${v.toFixed(1)}초`);
      const run = (kind, id) => {
        const ids = targetVisualClips();
        if (!ids.length) return needClip();
        const n = applyAnimation(ids, kind, id, dur);
        if (!n) toast(kind === 'in' && id === 'typewriter' ? '타자기 효과는 텍스트 클립에만 쓸 수 있습니다' : '적용할 수 있는 클립이 없습니다');
      };
      const btns = (kind) => grid(ANIMATIONS[kind].map((a) => h('button.qp-chip', { onclick: () => run(kind, a.id) }, a.name)));
      return [
        targetInfo(),
        title('등장 (클립 시작)'), btns('in'),
        title('퇴장 (클립 끝)'), btns('out'),
        dSlider.el,
        title('계속 움직이기 (클립 전체)'), btns('loop'),
        hint('계속 움직이기는 같은 값(크기·위치·회전)의 등장/퇴장 움직임을 덮어씁니다. 함께 쓰려면 계속 움직이기를 먼저 넣고 등장/퇴장을 나중에 넣으세요.'),
        h('div.qp-row', h('button', { onclick: () => { const ids = targetVisualClips(); if (!ids.length) return needClip(); clearAnimations(ids); } }, '애니메이션 모두 지우기')),
        hint('움직임은 모션·불투명도 키프레임으로 들어가므로 효과 컨트롤에서 이징과 시간을 더 다듬을 수 있습니다.'),
      ];
    },

    filter() {
      let amount = loadPref('quick.filterAmount', 100);
      const thumbs = [];
      const comp = new Compositor({ onAsyncReady: () => queueThumbs() });
      const off = document.createElement('canvas');
      const tiles = FILTERS.map((f) => {
        const canvas = h('canvas', { width: 112, height: 63 });
        const tile = h('button.qp-filter', { onclick: () => apply(f.id), title: f.name }, canvas, h('span', f.name));
        tile.dataset.id = f.id;
        thumbs.push({ f, canvas });
        return tile;
      });
      const apply = (id) => {
        const ids = targetVisualClips();
        if (!ids.length) return needClip();
        applyFilter(ids, id, amount);
      };
      const aSlider = slider('강도', 10, 100, 5, amount, (v, done) => {
        amount = v;
        savePref('quick.filterAmount', v);
        if (!done) return;
        const ids = targetVisualClips();
        const cur = ids.length ? clipFilter(store.seq.clips[ids[0]]) : 'none';
        if (cur !== 'none') applyFilter(ids, cur, v);
      }, (v) => `${v}%`);
      let thumbTimer = null;
      function queueThumbs() {
        clearTimeout(thumbTimer);
        thumbTimer = setTimeout(drawThumbs, 120);
      }
      function drawThumbs() {
        if (!visible || !thumbs[0].canvas.isConnected) return;
        const ids = targetVisualClips();
        const c = ids.length ? store.seq.clips[ids[0]] : null;
        const s = store.seq;
        const t = c ? clamp(store.ui.playhead, c.start, clipEnd(c) - 1 / s.fps) : store.ui.playhead;
        // the whole frame under the playhead, letterboxed into the tile, with only the target clip filtered
        const W = thumbs[0].canvas.width;
        const H = thumbs[0].canvas.height;
        const sc = Math.min(W / s.width, H / s.height);
        const ow = Math.max(2, Math.round(s.width * sc));
        const oh = Math.max(2, Math.round(s.height * sc));
        if (off.width !== ow || off.height !== oh) {
          off.width = ow;
          off.height = oh;
        }
        const octx = off.getContext('2d');
        for (const { f, canvas } of thumbs) {
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#0b0d10';
          ctx.fillRect(0, 0, W, H);
          if (!c) continue;
          const clip = previewWithFilter(c, f.id);
          const fake = { ...s, clips: { ...s.clips, [clip.id]: clip } };
          try {
            comp.render(octx, fake, t, playback.provider, { scale: sc });
            ctx.drawImage(off, Math.round((W - ow) / 2), Math.round((H - oh) / 2));
          } catch (err) {
            console.warn('filter preview failed', err);
          }
        }
        const cur = c ? clipFilter(c) : null;
        tiles.forEach((tile) => tile.classList.toggle('on', tile.dataset.id === cur));
      }
      renderers.push(queueThumbs);
      return [targetInfo(), grid(tiles, '.filters'), aSlider.el, hint('필터는 "고급 색상 보정" 효과로 들어갑니다. 효과 컨트롤에서 세부 값을 바꿀 수 있습니다.')];
    },

    text() {
      const tiles = TEXT_STYLES.map((st) => {
        const v = st.v;
        const sample = h('span.qp-tsample', {
          style: {
            fontFamily: `"${v.font || 'Noto Sans KR'}", "Noto Sans KR", sans-serif`,
            color: v.color,
            background: v.background ? hexA(v.bgColor, (v.bgOpacity ?? 100) / 100) : 'transparent',
            WebkitTextStroke: v.strokeRel ? `${Math.max(1, Math.round(v.strokeRel * 22))}px ${v.strokeColor}` : '0',
            paintOrder: 'stroke fill',
            fontWeight: v.bold === false ? '400' : '700',
          },
        }, '가나다 Abc');
        return h('button.qp-style', {
          onclick: () => {
            const ids = store.selectedClips().filter((c) => c.kind === 'text').map((c) => c.id);
            if (!ids.length) return toast('글자 스타일은 텍스트 클립을 선택한 뒤 누르세요');
            applyTextStyle(ids, st.id);
          },
        }, sample, h('span.qp-sname', st.name));
      });
      return [
        h('div.qp-row',
          h('button.primary', { onclick: () => { edit.addTextClip(); store.emit('reveal-effect-controls', { focusText: true }); } }, '＋ 텍스트 추가'),
          h('button', { onclick: () => store.emit('reveal-effect-controls', { focusText: true }) }, '내용·글꼴 편집')),
        title('글자 스타일 (텍스트 클립 선택 후)'),
        grid(tiles, '.styles'),
        hint('글꼴은 효과 컨트롤 ▸ 텍스트 ▸ 글꼴에서 74종 중에 고를 수 있습니다. 등장 효과는 "애니메이션"에서 넣으세요.'),
      ];
    },

    sticker() {
      return [
        hint('누르면 재생헤드 위치에 3초짜리 스티커가 톡 튀어나오며 들어갑니다. 위치·크기는 미리보기 화면에서 끌어서 바꾸세요.'),
        grid(EMOJIS.map((e) => h('button.qp-emoji', { onclick: () => addSticker(e), 'aria-label': `스티커 ${e}` }, e)), '.emojis'),
      ];
    },

    frame() {
      let size = loadPref('quick.pipSize', 35);
      const sSlider = slider('크기', 15, 80, 5, size, (v) => { size = v; savePref('quick.pipSize', v); }, (v) => `${v}%`);
      const bg = h('input', { type: 'color', value: store.seq.background || '#000000', 'aria-label': '시퀀스 배경색' });
      bg.addEventListener('change', () => setSequenceBackground(bg.value));
      renderers.push(() => { bg.value = store.seq.background || '#000000'; });
      const ratio = grid(ASPECTS.map(([id, , , label]) => {
        const b = h('button.qp-chip', { onclick: () => setAspect(id), title: label }, h('b', id), h('small', label));
        b.dataset.id = id;
        return b;
      }));
      renderers.push(() => {
        const s = store.seq;
        ratio.querySelectorAll('button').forEach((b) => {
          const a = ASPECTS.find((x) => x[0] === b.dataset.id);
          b.classList.toggle('on', Math.abs(a[1] / a[2] - s.width / s.height) < 0.01);
        });
      });
      const pip = (pos) => {
        const ids = targetVisualClips().filter((id) => ['video', 'image', 'nest'].includes(store.seq.clips[id]?.kind));
        if (!ids.length) return needClip('영상·사진 클립');
        setPip(ids, pos, size);
      };
      const fill = (mode) => {
        const ids = targetVisualClips().filter((id) => ['video', 'image', 'nest'].includes(store.seq.clips[id]?.kind));
        if (!ids.length) return needClip('영상·사진 클립');
        setBackgroundFill(ids, mode, { color: fillColor.value });
      };
      const fillColor = h('input', { type: 'color', value: loadPref('quick.fillColor', '#ffffff'), 'aria-label': '단색 배경 색상', title: '단색 배경 색상' });
      fillColor.addEventListener('change', () => {
        savePref('quick.fillColor', fillColor.value);
        // recolour clips that already use a solid fill
        const ids = targetVisualClips().filter((id) => store.seq.clips[id]?.effects.some((e) => e.type === 'blurFill' && e.params.mode.value === 'color'));
        if (ids.length) setBackgroundFill(ids, 'color', { color: fillColor.value });
      });
      return [
        title('화면 비율'), ratio,
        title('위치 (화면 속 화면)'), targetInfo(),
        grid(PIP_POSITIONS.map(([id, name]) => h('button.qp-chip', { onclick: () => pip(id) }, name))),
        sSlider.el,
        title('빈 곳 채우기 (세로 영상을 가로 화면에 넣을 때 등)'),
        grid([
          h('button.qp-chip', { onclick: () => fill('blur') }, '흐린 배경'),
          h('div.qp-chip.qp-split', h('button', { onclick: () => fill('color') }, '단색 배경'), fillColor),
          h('button.qp-chip', { onclick: () => fill('none') }, '채우기 없음'),
        ]),
        h('label.qp-slider', h('span', '시퀀스 배경색'), bg),
      ];
    },

    audio() {
      const vol = slider('볼륨', -30, 12, 0.5, 0, (v, done) => {
        const ids = targetAudioClips();
        if (!ids.length) return;
        if (!done) {
          if (!store.pending) store.begin('볼륨');
          for (const id of ids) {
            const fx = store.seq.clips[id]?.effects.find((e) => e.type === 'volume');
            if (fx && !fx.params.level.kf) fx.params.level.value = v;
          }
          store.changed();
        } else store.commit();
      }, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`);
      renderers.push(() => {
        const id = targetAudioClips()[0];
        const fx = id ? store.seq.clips[id]?.effects.find((e) => e.type === 'volume') : null;
        if (fx && document.activeElement !== vol.input && !store.pending) vol.set(evalParam(fx.params.level, 0));
      });
      const voiceBtns = grid(VOICES.map((v) => {
        const b = h('button.qp-chip', {
          onclick: () => {
            const ids = targetAudioClips();
            if (!ids.length) return needClip('소리 클립');
            applyVoice(ids, v.id);
          },
        }, v.name);
        b.dataset.id = v.id;
        return b;
      }));
      renderers.push(() => {
        const id = targetAudioClips()[0];
        const cur = id ? clipVoice(store.seq.clips[id]) : null;
        voiceBtns.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === cur));
      });
      const fade = (edge) => {
        const ids = targetAudioClips();
        if (!ids.length) return needClip('소리 클립');
        store.transact(edge === 'in' ? '소리 페이드 인' : '소리 페이드 아웃', () => {
          for (const id of ids) edit.applyTransition(id, edge, 'constantPower', 1);
        });
      };
      const mute = () => {
        const ids = targetAudioClips();
        if (!ids.length) return needClip('소리 클립');
        const on = store.seq.clips[ids[0]]?.enabled !== false;
        edit.setEnabled(ids, !on);
        toast(on ? '클립 소리를 껐습니다' : '클립 소리를 켰습니다');
      };
      return [
        targetInfo('audio'),
        vol.el,
        h('div.qp-row',
          h('button', { onclick: () => fade('in') }, '페이드 인 (1초)'),
          h('button', { onclick: () => fade('out') }, '페이드 아웃 (1초)'),
          h('button', { onclick: mute }, '소리 끄기/켜기')),
        title('목소리 효과'), voiceBtns,
        h('div.qp-row',
          h('button', { onclick: () => window.montage?.commands.voiceover() }, '🎙 보이스오버 녹음'),
          h('button', { onclick: () => { const c = store.selectedClips().find((x) => x.mediaId); if (c) openExtractAudioDialog({ clipId: c.id }); else toast('영상 클립을 먼저 선택하세요'); } }, '영상에서 소리 추출…'),
          h('button', { onclick: openDuckingDialog }, '자동 더킹…')),
      ];
    },

    auto() {
      const item = (label, desc, fn) => h('button.qp-tool', { onclick: fn }, h('b', label), h('span', desc));
      return [
        grid([
          item('무음 구간 자동 삭제', '말 사이 조용한 부분을 잘라 붙입니다 (점프 컷)', () => openSilenceCutDialog()),
          item('비트 마커', '음악의 박자마다 마커를 찍거나 영상을 자릅니다', () => openBeatDialog()),
          item('사진 슬라이드쇼', '사진 여러 장을 전환·천천히 확대와 함께 이어 붙입니다', () => openSlideshowDialog()),
          item('자동 자막', '말소리를 글자로 (인터넷 필요, Whisper 또는 Gemini)', () => openAutoCaptionDialog()),
          item('AI로 전체 편집하기', '자르기·자막·제목·전환·색감·음악을 스타일에 맞춰 한 번에', () => window.montage?.commands.ai('auto')),
          item('AI 편집 도우미', '말로 요청하면 Gemini가 자르고·자막 고치고·꾸밉니다 (API 키 필요)', () => window.montage?.commands.ai('chat')),
          item('대본으로 편집', '자막을 한 줄씩 보며 고치고, 필요 없는 줄을 영상에서 잘라 냅니다', () => window.montage?.commands.ai('script')),
          item('장면 전환 감지', '장면이 바뀌는 곳마다 자르기', () => openSceneDetectDialog()),
          item('손떨림 보정', '선택한 영상에 보정 효과를 넣고 분석합니다', () => {
            const c = store.selectedClips().find((x) => x.kind === 'video');
            if (!c) return toast('영상 클립을 먼저 선택하세요');
            if (!c.effects.some((e) => e.type === 'stabilize')) edit.addEffect([c.id], 'stabilize');
            store.emit('reveal-effect-controls');
          }),
        ], '.tools'),
      ];
    },
  };

  quickApi.show = (id) => show(id);
  store.on('selection', refresh);
  store.on('change', refresh);
  let last = 0;
  store.on('playhead', () => {
    const now = performance.now();
    if (now - last > 250 && !playback.playing) {
      last = now;
      refresh();
    }
  });
  show(section);
  return Object.assign(body, {
    onShow: () => { visible = true; refresh(); },
    onHide: () => { visible = false; },
    setVisible: (v) => { visible = v; if (v) refresh(); },
  });
}

function hexA(hex, a) {
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

