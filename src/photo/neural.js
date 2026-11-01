// Filter ▸ 뉴럴 필터: Photoshop's Neural Filters window with offline approximations (no AI model, no
// network): 피부를 매끄럽게, 슈퍼 줌, JPEG 아티팩트 제거 and 깊이 흐림 (with a focus point picked on the
// picture). Filters are switched on in the list; their settings show on the right; the output goes
// to the current layer, a new layer, a smart filter or a new document (Super Zoom: a new document).

import { h, clamp } from '../util.js';
import { openModal, toast } from '../ui/common.js';
import { FILTERS, applyFilter, defaultFilterParams } from './adjust.js';
import { makeCanvas, newLayer } from './doc.js';
import { paramEditors, applyToLayer, pickOnPicture } from './pdialogs.js';
import { superZoom } from './resample.js';

const LIST = [
  ['skinSmoothing', '피부를 매끄럽게', '인물'],
  ['superZoom', '슈퍼 줌', '사진 복원'],
  ['jpegArtifacts', 'JPEG 아티팩트 제거', '사진 복원'],
  ['depthBlur', '깊이 흐림', '사진'],
];
const ZOOM_PARAMS = [['scale', '확대', null, null, 2, [[2, '2배'], [3, '3배'], [4, '4배']]], ['detail', '세부 향상', 0, 100, 50], ['noise', '노이즈 감소', 0, 100, 0], ['jpeg', 'JPEG 아티팩트 제거', null, null, false, 'bool']];

let memory = null;

export function neuralFiltersDialog(P) {
  const doc = P.doc;
  const l = doc?.active;
  const smart = l?.kind === 'smart';
  if (!l || (l.kind !== 'raster' && !smart) || (!smart && !l.canvas)) {
    toast('이미지(일반) 레이어나 고급 개체를 선택하세요');
    return;
  }
  // settings and on / off of each filter (kept for the next time, like Photoshop)
  const st = memory ? structuredClone(memory) : Object.fromEntries(LIST.map(([id]) => [id, { on: false, params: id === 'superZoom' ? Object.fromEntries(ZOOM_PARAMS.map(([k, , , , d]) => [k, d])) : defaultFilterParams(id) }]));
  let cur = LIST.find(([id]) => st[id].on)?.[0] || 'skinSmoothing';
  const before = doc.capture();
  const base = smart ? null : l.canvas;
  const src = smart ? doc.rasterizeLayer(l) : l.canvas;
  let applied = false;
  // preview on the picture at a reduced size (these filters are slow)
  const pk = Math.min(1, Math.sqrt(1.6e6 / (src.width * src.height)));
  const small = (() => {
    if (pk >= 0.999) return src;
    const c = makeCanvas(Math.max(1, Math.round(src.width * pk)), Math.max(1, Math.round(src.height * pk)));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  })();
  const status = h('div.note', '');
  const run = (c) => {
    let out = c;
    for (const [id] of LIST) {
      if (!st[id].on || id === 'superZoom') continue;
      out = applyFilter(out, id, st[id].params, { fg: P.fg, bg: P.bg });
    }
    if (st.superZoom.on && st.superZoom.params.jpeg) out = applyFilter(out, 'jpegArtifacts', { strength: 'medium' });
    return out;
  };
  let timer = 0;
  const preview = () => {
    if (smart || !base) return;
    clearTimeout(timer);
    status.textContent = '미리 보기 계산 중…';
    timer = setTimeout(() => {
      try {
        const any = LIST.some(([id]) => st[id].on && id !== 'superZoom') || (st.superZoom.on && st.superZoom.params.jpeg);
        let out = base;
        if (any) {
          const r = run(small);
          out = makeCanvas(base.width, base.height);
          const g = out.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(r, 0, 0, base.width, base.height);
          if (doc.selection) {
            g.globalCompositeOperation = 'destination-in';
            g.drawImage(doc.selection.canvas, -l.x, -l.y);
            g.globalCompositeOperation = 'destination-over';
            g.drawImage(base, 0, 0);
          }
        }
        l.canvas = out;
        l._styled = null;
        doc.touch(l);
        P.redraw();
        status.textContent = st.superZoom.on ? '슈퍼 줌은 확인을 누르면 새 문서로 만들어집니다.' : '';
      } catch (err) {
        status.textContent = String(err.message || err);
      }
    }, 120);
  };

  // ---- the list with on/off switches
  const listEl = h('div.nf-list');
  const settings = h('div.nf-settings');
  const renderList = () => {
    listEl.replaceChildren(...LIST.map(([id, name, cat]) => {
      const box = h('input', { type: 'checkbox', checked: st[id].on, 'aria-label': `${name} 켜기` });
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        st[id].on = box.checked;
        cur = id;
        renderList();
        renderSettings();
        preview();
      });
      return h(`div.nf-item${cur === id ? '.on' : ''}`, { role: 'button', tabindex: 0, onclick: () => { cur = id; renderList(); renderSettings(); } }, h('span', h('b', name), h('small', cat)), box);
    }));
  };
  const renderSettings = () => {
    const s = st[cur];
    const defs = cur === 'superZoom' ? ZOOM_PARAMS : FILTERS[cur].params;
    const extra = [];
    if (cur === 'depthBlur') {
      const pickBtn = h('button.small', { type: 'button', title: '그림에서 초점을 맞출 곳을 누르세요' }, '초점 위치를 그림에서 고르기');
      pickBtn.addEventListener('click', () => {
        pickOnPicture(P, (x, y) => {
          // the layer's own pixels (a smart object is rasterized at document size)
          const ox = smart ? 0 : l.x || 0;
          const oy = smart ? 0 : l.y || 0;
          s.params.fx = clamp(Math.round(((x - ox) / src.width) * 100), 0, 100);
          s.params.fy = clamp(Math.round(((y - oy) / src.height) * 100), 0, 100);
          return [0, 0, 0];
        }, (ok) => {
          if (!ok) return;
          s.on = true;
          renderList();
          renderSettings();
          preview();
        });
      });
      extra.push(h('div.ph-prow', pickBtn));
    }
    settings.replaceChildren(
      h('b', LIST.find((x) => x[0] === cur)[1]),
      ...extra,
      ...paramEditors(defs, s.params, () => {
        if (!s.on) {
          s.on = true;
          renderList();
        }
        preview();
      }, P),
      h('p.note', cur === 'superZoom' ? '사진을 크게 키우고 세부를 살립니다 (새 문서로 만듭니다).' : cur === 'depthBlur' ? '초점에서 비슷한 색으로 이어지는 곳은 선명하게, 멀어질수록 흐리게 합니다 (AI 깊이 추정이 아닌 근사).' : cur === 'skinSmoothing' ? '피부색 부분만 골라 잡티를 매끄럽게 하고 윤곽은 지킵니다.' : '8픽셀 블록 경계와 윤곽 주변의 얼룩을 줄입니다.'));
  };
  renderList();
  renderSettings();

  const output = h('select', { 'aria-label': '출력' },
    h('option', { value: 'layer' }, '현재 레이어'),
    h('option', { value: 'newLayer' }, '새 레이어'),
    ...(smart ? [h('option', { value: 'smart' }, '고급 필터')] : []),
    h('option', { value: 'newDoc' }, '새 문서'));
  output.value = smart ? 'smart' : 'newLayer';

  const finish = () => {
    memory = structuredClone(st);
    const active = LIST.filter(([id]) => st[id].on);
    if (!active.length) return;
    clearTimeout(timer);
    // back to the original before computing the real thing (a smart object was never changed)
    if (!smart) {
      doc.restore(before);
      P.afterHistory();
    }
    // the closing window must not undo what is applied below
    applied = true;
    toast('뉴럴 필터 적용 중…');
    setTimeout(() => {
      const full = run(src);
      const zoomOn = st.superZoom.on;
      const mode = zoomOn ? 'newDoc' : output.value;
      if (mode === 'newDoc') {
        const k = zoomOn ? +st.superZoom.params.scale || 2 : 1;
        const out = zoomOn ? superZoom(full, k, st.superZoom.params) : full;
        P.openCanvas(out, `${doc.name}${zoomOn ? ` 슈퍼 줌 ${k}배` : ' 뉴럴 필터'}`);
        return;
      }
      if (mode === 'smart' && smart) {
        P.run('고급 필터: 뉴럴 필터', () => {
          const add = active.filter(([id]) => id !== 'superZoom').map(([id]) => ({ id, params: { ...st[id].params, _fg: P.fg, _bg: P.bg }, enabled: true }));
          const sl = doc.layers.find((x) => x.id === l.id) || l;
          sl.smart = { ...sl.smart, filters: [...(sl.smart.filters || []), ...add] };
          doc.touch(sl);
        });
      } else if (mode === 'newLayer') {
        P.run('뉴럴 필터', () => {
          const c = makeCanvas(src.width, src.height);
          c.getContext('2d').drawImage(full, 0, 0);
          if (doc.selection) {
            const g = c.getContext('2d');
            g.globalCompositeOperation = 'destination-in';
            g.drawImage(doc.selection.canvas, -(l.x || 0), -(l.y || 0));
          }
          const nl = newLayer('raster', { name: `${l.name} (뉴럴 필터)`, canvas: c, x: smart ? 0 : l.x, y: smart ? 0 : l.y });
          P.addLayer(nl);
        });
      } else {
        P.run('뉴럴 필터', () => applyToLayer(P, () => full));
      }
      for (const [id] of active) if (id !== 'superZoom') P.recordStep?.({ type: 'filter', id, params: structuredClone(st[id].params) });
    }, 40);
  };

  openModal({
    title: '뉴럴 필터',
    width: 'min(760px, 96vw)',
    body: [h('div.nf', listEl, h('div', settings, status)), h('label.ph-prow', h('span', '출력'), output),
      h('div.note', '이 앱의 뉴럴 필터는 인터넷과 AI 모델 없이 동작하는 근사 버전입니다.')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: finish }],
    onClose: () => {
      clearTimeout(timer);
      if (!applied && !smart) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
}
