// Screen modes (F), hiding panels (Tab), Edit ▸ Preferences, File ▸ Revert, Layer ▸ Delete Hidden
// Layers, one-click Remove Background, and the HSB/HSL and Picture Frame filters.

import { h, clamp } from '../util.js';
import { toast, openModal, formRow, confirmDialog, savePref } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { FILTERS } from './adjust.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';

const SCREEN_MODES = [['standard', '표준 화면 모드'], ['max', '메뉴 막대가 있는 전체 화면 모드'], ['full', '전체 화면 모드']];

export function installView3(P) {
  const C = P.cmd;
  const body = document.body;

  // ---------------------------------------------------------------- screen modes and panels

  let mode = 'standard';
  C.screenMode = (m) => {
    const i = SCREEN_MODES.findIndex(([k]) => k === mode);
    mode = m || SCREEN_MODES[(i + 1) % SCREEN_MODES.length][0];
    body.classList.toggle('ph-screen-max', mode === 'max');
    body.classList.toggle('ph-screen-full', mode === 'full');
    if (mode === 'full') document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    toast(`${SCREEN_MODES.find(([k]) => k === mode)[1]}${mode === 'standard' ? '' : ' (F: 다음 모드, Esc: 표준으로)'}`);
  };
  // leaving browser full screen (Esc) brings the panels back too
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && mode === 'full') {
      mode = 'standard';
      body.classList.remove('ph-screen-full', 'ph-screen-max');
    }
  });
  C.togglePanels = () => {
    const on = !body.classList.contains('ph-hide-panels');
    body.classList.toggle('ph-hide-panels', on);
    body.classList.remove('ph-hide-side');
    if (on) toast('도구와 패널 숨김 (Tab으로 다시 보기)');
  };
  C.toggleSidePanels = () => {
    body.classList.toggle('ph-hide-side');
    body.classList.remove('ph-hide-panels');
  };
  const prevKeys = P.viewKeys;
  P.viewKeys = (e, mod) => {
    if (!mod && !e.altKey) {
      if (e.code === 'KeyF' && !e.shiftKey && P.doc) return C.screenMode(), true;
      // Tab hides panels only while the picture has the focus; on a button it still moves the focus
      const ae = document.activeElement;
      if (e.code === 'Tab' && (!ae || ae === document.body || ae.closest?.('.ph-stage'))) return (e.shiftKey ? C.toggleSidePanels() : C.togglePanels()), true;
      if (e.code === 'Escape' && mode !== 'standard' && !P.transform && !P.editingText && P.tool !== 'crop') return C.screenMode('standard'), true;
    }
    // Ctrl+Alt+Shift+F: find layers
    if (mod && e.altKey && e.shiftKey && e.code === 'KeyF') return P.focusLayerFilter?.(), true;
    return prevKeys?.(e, mod) || false;
  };

  // ---------------------------------------------------------------- preferences

  C.preferences = () => {
    const pr = P.prefs;
    const sel = (value, opts) => {
      const s = h('select', opts.map(([v, n]) => h('option', { value: v }, n)));
      s.value = String(value);
      return s;
    };
    const paste = sel(pr.pasteboard, [['#1f2125', '어두운 회색 (기본)'], ['#000000', '검정'], ['#535353', '중간 회색'], ['#a0a0a0', '밝은 회색'], ['#ffffff', '흰색']]);
    const checker = sel(pr.checker, [['small', '작게'], ['medium', '보통'], ['large', '크게']]);
    const tone = sel(pr.checkerTone, [['light', '밝게'], ['mid', '중간'], ['dark', '어둡게']]);
    const cursor = sel(pr.cursor, [['outline', '브러시 크기 윤곽'], ['both', '윤곽 + 가운데 십자'], ['cross', '정밀 (십자만)']]);
    const wheel = h('input', { type: 'checkbox', checked: !!pr.wheelZoom });
    const autosave = h('input', { type: 'checkbox', checked: pr.autosave !== false });
    const hist = h('input', { type: 'number', min: 100, max: 4000, step: 50, value: pr.historyMB, style: { width: '90px' } });
    openModal({
      title: '환경 설정',
      width: '460px',
      body: [
        h('div.ph-sub', '화면'),
        formRow('캔버스 바깥 색', paste),
        formRow('투명 격자 크기', checker),
        formRow('투명 격자 색', tone),
        formRow('칠하기 도구 커서', cursor),
        h('label.ph-prow', wheel, h('span', '마우스 휠로 확대·축소 (끄면 휠은 화면 이동, Ctrl+휠로 확대)')),
        h('div.ph-sub', '작업'),
        formRow('작업 내역 메모리 (MB)', hist),
        h('label.ph-prow', autosave, h('span', '열린 문서를 이 브라우저에 자동 저장 (새로 고쳐도 이어서)')),
        h('div.note', '작업 내역 메모리를 늘리면 더 많이 되돌릴 수 있지만 기기 메모리를 더 씁니다. 휴대폰은 350MB 안쪽을 권합니다.'),
      ],
      buttons: [
        { label: '기본값', action: () => {
          Object.assign(P.prefs, { pasteboard: '#1f2125', checker: 'medium', checkerTone: 'light', cursor: 'outline', wheelZoom: false, autosave: true });
          savePref('photo.prefs', P.prefs);
          P.invalidateView();
          toast('환경 설정을 기본값으로 되돌렸습니다');
        } },
        { label: '취소' },
        { label: '확인', primary: true, action: () => {
          Object.assign(P.prefs, {
            pasteboard: paste.value, checker: checker.value, checkerTone: tone.value, cursor: cursor.value,
            wheelZoom: wheel.checked, autosave: autosave.checked, historyMB: clamp(Math.round(+hist.value || 900), 100, 4000),
          });
          savePref('photo.prefs', P.prefs);
          for (const d of P.docs) if (d.history) d.history.budgetBytes = P.prefs.historyMB * 1e6;
          P.invalidateView();
          if (P.prefs.autosave) P.scheduleSave?.();
        } },
      ],
    });
  };

  // ---------------------------------------------------------------- file, layer commands

  /** File ▸ Revert: back to how the document was opened or last saved (one undoable step). */
  C.revert = async () => {
    const d = P.doc;
    if (!d?.openState) return toast('되돌릴 문서가 없습니다');
    if (!(await confirmDialog('되돌리기', `"${d.name}"을(를) 열었을 때(또는 마지막으로 저장했을 때)로 되돌릴까요? 실행 취소로 다시 돌아올 수 있습니다.`))) return undefined;
    P.run('되돌리기', () => d.restore(d.openState));
    P.fit();
    return undefined;
  };

  /** Layer ▸ Delete ▸ Hidden Layers. */
  C.deleteHiddenLayers = () => {
    const d = P.doc;
    if (!d) return;
    const hidden = d.layers.filter((l) => !l.visible && !d.ancestors(l).some((a) => !a.visible));
    if (!hidden.length) return void toast('숨긴 레이어가 없습니다');
    if (d.layers.filter((l) => !l.parent).every((l) => !l.visible)) return void toast('모든 레이어가 숨겨져 있습니다. 하나 이상 보이게 한 뒤 지우세요');
    P.run(`숨긴 레이어 삭제 (${hidden.length}개)`, () => {
      for (const l of hidden) d.removeBlock(l.id);
      if (!d.layer(d.activeId)) d.activeId = d.layers[d.layers.length - 1]?.id || null;
      d.selectedIds = d.activeId ? [d.activeId] : [];
      d.rev++;
    });
    toast(`숨긴 레이어 ${hidden.length}개를 지웠습니다`);
  };

  /** Remove Background (Photoshop's quick action): a layer mask that keeps only the main subject. */
  C.removeBackground = () => {
    const d = P.doc;
    const l = d?.active;
    if (!l || !['raster', 'smart'].includes(l.kind)) return void toast('사진(이미지) 레이어나 고급 개체를 고르세요');
    if (l.locked) return void toast('잠긴 레이어입니다');
    toast('피사체를 찾는 중…');
    setTimeout(() => {
      const src = P.layerAsDocCanvas(l);
      const m = SX.selectSubject(src);
      if (!m) return void toast('피사체를 찾지 못했습니다 (배경이 단순할수록 잘 됩니다). 선택 ▸ 피사체로 먼저 고쳐 볼 수 있습니다.');
      P.run('배경 제거', () => {
        const keep = d.selection;
        d.selection = SEL.combine(d, m, 'new');
        l.mask = null;
        d.addMask(l, 'white', true);
        d.selection = keep;
        l._styled = null;
        d.touch(l);
      });
      P.editMask = false;
      toast('배경을 레이어 마스크로 가렸습니다. 마스크에 흰색·검정으로 칠해 다듬을 수 있습니다.');
      return undefined;
    }, 30);
  };

  P.extendMenus = [...(P.extendMenus || []), () => {
    const wrap = (name, fn) => {
      const orig = P.menus[name];
      if (orig) P.menus[name] = () => fn(orig());
    };
    const at = (items, label) => items.findIndex((x) => typeof x === 'object' && x?.label?.startsWith(label));
    const no = () => !P.doc;
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
    wrap('파일', (items) => {
      const i = at(items, '닫기');
      items.splice(i + 1, 0, { label: '되돌리기 (연 상태로)', disabled: no() || !P.doc?.openState, action: () => C.revert() });
      return items;
    });
    wrap('편집', (items) => {
      items.push('-', { label: '환경 설정…', key: `${mod}K`, action: () => C.preferences() });
      return items;
    });
    wrap('레이어', (items) => {
      const i = at(items, '삭제');
      items.splice(i + 1, 0, { label: '숨긴 레이어 삭제', disabled: no(), action: () => C.deleteHiddenLayers() });
      items.splice(at(items, '이름 바꾸기'), 0, { label: '레이어 찾기', key: `${mod}Alt+Shift+F`, action: () => P.focusLayerFilter?.() });
      const m = at(items, '레이어 마스크');
      items.splice(m >= 0 ? m : items.length, 0, { label: '배경 제거 (피사체만 남기기)', disabled: no(), action: () => C.removeBackground() });
      return items;
    });
    wrap('보기', (items) => {
      items.push('-',
        { label: '화면 모드', submenu: SCREEN_MODES.map(([k, n]) => ({ label: n, key: k === 'standard' ? 'F' : undefined, checked: mode === k, action: () => C.screenMode(k) })) },
        { label: '도구·패널 숨기기 / 보이기', key: 'Tab', action: () => C.togglePanels() },
        { label: '오른쪽 패널만 숨기기 / 보이기', key: 'Shift+Tab', action: () => C.toggleSidePanels() });
      return items;
    });
  }];

  // ---------------------------------------------------------------- filters

  const pixels = (c, fn) => {
    const out = makeCanvas(c.width, c.height);
    const g = out.getContext('2d');
    g.drawImage(c, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    fn(img.data);
    g.putImageData(img, 0, 0);
    return out;
  };
  FILTERS.hsb = {
    name: 'HSB/HSL', group: '기타', params: [['order', '바꿀 방식', null, null, 'hsb', [['hsb', 'RGB → HSB (색조·채도·명도)'], ['hsl', 'RGB → HSL (색조·채도·밝기)']]]],
    fn(c, p) {
      const hsl = p.order === 'hsl';
      return pixels(c, (d) => {
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] / 255;
          const g = d[i + 1] / 255;
          const b = d[i + 2] / 255;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const dl = mx - mn;
          let hh = 0;
          if (dl) hh = mx === r ? ((g - b) / dl + 6) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
          const l = (mx + mn) / 2;
          const s = hsl ? (dl ? dl / (1 - Math.abs(2 * l - 1)) : 0) : mx ? dl / mx : 0;
          d[i] = (hh / 6) * 255;
          d[i + 1] = s * 255;
          d[i + 2] = (hsl ? l : mx) * 255;
        }
      });
    },
  };

  const FRAME_STYLES = [['simple', '단순 테두리'], ['double', '이중선'], ['polaroid', '폴라로이드'], ['film', '필름'], ['wood', '나무 액자'], ['soft', '부드러운 흰 가장자리'], ['rounded', '둥근 모서리 (투명)']];
  FILTERS.pictureFrame = {
    name: '사진 틀', group: '렌더', params: [
      ['style', '스타일', null, null, 'polaroid', FRAME_STYLES],
      ['width', '두께 (짧은 변의 %)', 1, 30, 6],
      ['color', '색', null, null, '#ffffff', 'color'],
    ],
    fn(c, p) {
      const W = c.width;
      const H = c.height;
      const out = makeCanvas(W, H);
      const g = out.getContext('2d');
      g.drawImage(c, 0, 0);
      const t = Math.max(1, Math.round((Math.min(W, H) * p.width) / 100));
      const col = p.color || '#ffffff';
      const band = (x, y, w, hh) => g.fillRect(x, y, w, hh);
      const border = (w, fill) => {
        g.fillStyle = fill;
        band(0, 0, W, w);
        band(0, H - w, W, w);
        band(0, 0, w, H);
        band(W - w, 0, w, H);
      };
      if (p.style === 'simple') border(t, col);
      else if (p.style === 'double') {
        border(Math.round(t * 0.6), col);
        g.strokeStyle = col;
        g.lineWidth = Math.max(1, t * 0.15);
        const k = t * 0.85;
        g.strokeRect(k, k, W - k * 2, H - k * 2);
      } else if (p.style === 'polaroid') {
        g.fillStyle = col;
        band(0, 0, W, t);
        band(0, 0, t, H);
        band(W - t, 0, t, H);
        band(0, H - t * 3.5, W, t * 3.5);
        // a faint line where the print meets the paper
        g.strokeStyle = 'rgba(0,0,0,.18)';
        g.lineWidth = Math.max(1, t * 0.06);
        g.strokeRect(t, t, W - t * 2, H - t * 4.5);
      } else if (p.style === 'film') {
        border(t, '#111111');
        g.fillStyle = col === '#ffffff' ? '#f2f2f2' : col;
        const hole = Math.max(2, t * 0.42);
        for (let x = t * 0.6; x < W - hole; x += hole * 2.2) {
          g.fillRect(x, (t - hole) / 2, hole, hole * 0.75);
          g.fillRect(x, H - (t + hole * 0.75) / 2, hole, hole * 0.75);
        }
      } else if (p.style === 'wood') {
        const wood = makeCanvas(64, 64);
        const wg = wood.getContext('2d');
        const gr = wg.createLinearGradient(0, 0, 64, 0);
        gr.addColorStop(0, '#6b4226');
        gr.addColorStop(0.3, '#8b5a33');
        gr.addColorStop(0.55, '#7a4c2b');
        gr.addColorStop(0.8, '#9c6a3e');
        gr.addColorStop(1, '#6b4226');
        wg.fillStyle = gr;
        wg.fillRect(0, 0, 64, 64);
        wg.strokeStyle = 'rgba(40,20,5,.25)';
        for (let y = 2; y < 64; y += 5) {
          wg.beginPath();
          wg.moveTo(0, y);
          wg.bezierCurveTo(20, y + 2, 40, y - 2, 64, y + 1);
          wg.stroke();
        }
        border(t, g.createPattern(wood, 'repeat'));
        // bevel: light on the top and left, shade on the bottom and right
        g.lineWidth = Math.max(1, t * 0.12);
        g.strokeStyle = 'rgba(255,230,200,.35)';
        g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth);
        g.strokeStyle = 'rgba(0,0,0,.45)';
        g.strokeRect(t - g.lineWidth / 2, t - g.lineWidth / 2, W - t * 2 + g.lineWidth, H - t * 2 + g.lineWidth);
      } else if (p.style === 'soft') {
        const m = makeCanvas(W, H);
        const mg = m.getContext('2d');
        mg.fillStyle = col;
        mg.fillRect(0, 0, W, H);
        mg.globalCompositeOperation = 'destination-out';
        mg.filter = `blur(${t * 0.6}px)`;
        mg.fillStyle = '#000';
        mg.fillRect(t * 1.2, t * 1.2, W - t * 2.4, H - t * 2.4);
        g.drawImage(m, 0, 0);
      } else if (p.style === 'rounded') {
        g.globalCompositeOperation = 'destination-in';
        g.beginPath();
        const r = t * 2;
        g.roundRect ? g.roundRect(0, 0, W, H, r) : g.rect(0, 0, W, H);
        g.fill();
      }
      return out;
    },
  };
}

export { SCREEN_MODES };
