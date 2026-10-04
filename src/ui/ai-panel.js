// "AI 편집" panel: a Gemini editing assistant (ask in words, it edits the timeline with tools),
// a transcript view for text-based editing (fix caption text, cut lines out of the video), and
// the Gemini API key / model settings.

import { store } from '../store.js';
import { h, formatTimecode } from '../util.js';
import { toast, loadPref, savePref } from './common.js';
import { icon } from './icons.js';
import { clipEnd, clipsOnTrack, videoTracks } from '../model.js';
import {
  geminiSettings, saveGeminiSettings, listGeminiModels, runAssistant, AI_TOOLS, API_KEY_PAGE,
} from '../ai.js';
import { openAutoCaptionDialog } from './dialogs.js';
import { AUTO_STYLES, AUTO_STEPS, runAutoEdit } from '../autoedit.js';

export const aiApi = {};

const SECTIONS = [['auto', '전체 편집', 'ai'], ['chat', '도우미', 'sparkle'], ['script', '대본', 'text'], ['settings', '설정', 'gear']];

const PROMPTS = [
  ['자막 맞춤법 고치기', '자막(텍스트 클립)의 맞춤법과 띄어쓰기를 고쳐 줘. 뜻과 말투는 바꾸지 마.'],
  ['말 실수·반복 잘라내기', '자막을 보고 말을 더듬거나 같은 말을 되풀이한 부분, "음", "어" 같은 군더더기만 찾아서 잘라 줘. 확실하지 않은 곳은 자르지 말고 마커만 찍어 줘.'],
  ['30초 하이라이트', '자막을 보고 가장 재미있거나 중요한 부분만 남겨서 약 30초 길이로 줄여 줘.'],
  ['중요한 순간 마커', '자막을 보고 중요한 순간마다 마커를 찍어 줘. 마커 이름은 짧게.'],
  ['영어 자막 추가', '지금 자막을 자연스러운 영어로 번역해서 새 자막 트랙으로 추가해 줘. 시간은 원래 자막과 같게.'],
  ['제목·설명·해시태그', '이 영상의 유튜브 제목 후보 3개, 설명 3줄, 해시태그 10개를 만들어 줘. 편집은 하지 마.'],
  ['강조 문구 넣기', '자막 내용 중 강조할 만한 순간 2~3곳에 짧은 강조 문구(제목)와 어울리는 스티커를 넣어 줘.'],
  ['쇼츠로 바꾸기', '세로 쇼츠(9:16)로 바꾸고, 가장 흥미로운 부분만 남겨 60초 이내로 줄여 줘.'],
];

const keyHint = () => h('div.note', 'Gemini API 키는 Google AI Studio에서 무료로 만들 수 있습니다: ', h('a', { href: API_KEY_PAGE, target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'));

export function createAiPanel() {
  let section = loadPref('ai.section', 'auto');
  const tabs = h('div.qp-tabs', SECTIONS.map(([id, name, ic]) => {
    const b = h('button.qp-tab', { onclick: () => show(id), title: name }, icon(ic), h('span', name));
    b.dataset.sec = id;
    return b;
  }));
  const content = h('div.ai-content');
  const body = h('div.quick.ai', tabs, content);
  let visible = false;
  let refreshers = [];

  function show(id) {
    section = SECTIONS.some(([s]) => s === id) ? id : 'auto';
    savePref('ai.section', section);
    tabs.querySelectorAll('.qp-tab').forEach((b) => b.classList.toggle('on', b.dataset.sec === section));
    refreshers = [];
    content.replaceChildren(...VIEWS[section]());
    refresh();
  }
  function refresh() {
    if (visible) for (const r of refreshers) r();
  }

  // ---------------------------------------------------------------- whole-video edit
  const auto = { running: false, controller: null, states: {}, summary: null };

  function autoView() {
    const prefs = loadPref('ai.auto', {});
    let style = prefs.style || 'vlog';
    const steps = new Set(prefs.steps || AUTO_STEPS.map(([id]) => id));
    const sub = { mistakes: true, title: true, emphasis: true, spelling: true, ...(prefs.sub || {}) };
    const save = () => savePref('ai.auto', { style, steps: [...steps], sub, len: lenSel.value, open: details.open });

    const styleBtns = h('div.ai-styles', AUTO_STYLES.map((st) => {
      const b = h('button.ai-style', { onclick: () => { style = st.id; save(); syncStyles(); }, 'aria-pressed': 'false' }, h('b', st.name), h('small', st.desc));
      b.dataset.id = st.id;
      return b;
    }));
    const syncStyles = () => styleBtns.querySelectorAll('.ai-style').forEach((b) => { const on = b.dataset.id === style; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const lenSel = h('select', { 'aria-label': '목표 길이' },
      [['style', '스타일 기본 (쇼츠는 60초)'], ['0', '줄이지 않음'], ['30', '약 30초'], ['60', '약 60초'], ['90', '약 90초'], ['180', '약 3분'], ['300', '약 5분']].map(([v, t]) => h('option', { value: v }, t)));
    lenSel.value = prefs.len || 'style';
    lenSel.addEventListener('change', save);
    const stepRows = AUTO_STEPS.map(([id, name, desc]) => {
      const box = h('input', { type: 'checkbox', checked: steps.has(id) });
      box.addEventListener('change', () => { if (box.checked) steps.add(id); else steps.delete(id); save(); });
      const state = h('span.ai-st');
      const msg = h('span.ai-st-msg');
      const row = h('div.ai-step-row', h('label.inline', box, h('span', h('b', name), h('small', desc))), h('div.ai-st-line', state, msg));
      row.dataset.id = id;
      return { id, row, state, msg };
    });
    const subBox = (key, label) => {
      const b = h('input', { type: 'checkbox', checked: !!sub[key] });
      b.addEventListener('change', () => { sub[key] = b.checked; save(); });
      return h('label.inline', b, label);
    };
    const subOpts = h('div.ai-subopts', subBox('mistakes', '말 실수·반복 잘라내기'), subBox('title', '오프닝 제목'), subBox('emphasis', '강조 문구·스티커'), subBox('spelling', '자막 맞춤법'));
    const extra = h('textarea.ai-input', { rows: 2, placeholder: '추가로 바라는 점 (선택) 예) 고양이 나오는 부분 위주로 / 마지막에 구독 문구', 'aria-label': '추가 요청' });
    const details = h('details.ai-details', h('summary', '세부 설정 · 진행 상황 (할 일 고르기, 추가 요청)'),
      h('div.ai-steps', stepRows.map((r) => r.row)), subOpts, extra);
    details.open = !!prefs.open;
    details.addEventListener('toggle', () => { prefs.open = details.open; savePref('ai.auto', { ...loadPref('ai.auto', {}), open: details.open }); });
    const startBtn = h('button.primary.ai-go', { onclick: start }, '✨ 전체 편집 시작');
    const stopBtn = h('button', { onclick: () => auto.controller?.abort(), hidden: true }, '멈추기');
    const keyNote = h('div.note');
    const result = h('div.ai-result');

    function paint() {
      for (const r of stepRows) {
        const st = auto.states[r.id];
        r.row.classList.toggle('off', !steps.has(r.id));
        r.state.textContent = !st ? '' : { run: '⏳', done: '✓', skip: '–', fail: '✗' }[st.state];
        r.state.className = `ai-st ${st?.state || ''}`;
        r.msg.textContent = st?.msg || '';
      }
      startBtn.hidden = auto.running;
      stopBtn.hidden = !auto.running;
      startBtn.disabled = !steps.size;
      keyNote.textContent = geminiSettings.key
        ? `Gemini(${geminiSettings.model || '자동 선택'})가 자막을 읽고 내용 편집을 합니다. 자막이 없으면 Gemini로 만듭니다.`
        : 'Gemini 키가 없습니다: 자막은 Whisper(처음 한 번 약 80MB 내려받기)로 만들고, 내용 편집(길이 맞추기·강조 문구 등)은 건너뜁니다. 설정 탭에서 키를 넣으면 전부 됩니다.';
      result.replaceChildren();
      if (auto.summary) {
        result.append(h('div.ai-msg.model', auto.summary.text || '전체 편집을 마쳤습니다.'),
          h('div.inline', h('button.small', {
            onclick: () => {
              if (store.undoStack.at(-1)?.label === auto.summary.undoLabel) store.undo();
              else toast('그 뒤에 다른 편집이 있어 여기서 되돌릴 수 없습니다. 작업 내역 패널을 쓰세요.');
            },
          }, '전체 편집 되돌리기'), h('span.note', '마음에 안 드는 부분은 도우미에게 말로 고쳐 달라고 할 수 있습니다.')));
      }
    }

    async function start() {
      if (auto.running) return;
      const st = AUTO_STYLES.find((x) => x.id === style);
      const len = lenSel.value === 'style' ? st.targetLen || 0 : parseInt(lenSel.value, 10) || 0;
      auto.running = true;
      auto.summary = null;
      auto.states = {};
      auto.controller = new AbortController();
      details.open = true; // show the progress of each step
      paint();
      try {
        const res = await runAutoEdit({ style, steps, targetLen: len, extra: extra.value.trim(), ...sub }, {
          signal: auto.controller.signal,
          onStep: (id, state, msg) => {
            const prev = auto.states[id];
            auto.states[id] = { state, msg: state === 'run' && !msg ? prev?.msg || '진행 중…' : msg };
            paint();
          },
        });
        const failed = Object.values(auto.states).filter((x) => x.state === 'fail').length;
        auto.summary = { text: [res.text, failed ? `${failed}단계는 실패했습니다(위 ✗ 표시). 나머지는 적용됐습니다.` : ''].filter(Boolean).join('\n\n'), undoLabel: store.undoStack.at(-1)?.label };
      } catch (err) {
        auto.summary = { text: err?.name === 'AbortError' ? '멈췄습니다. 그때까지 한 편집은 남아 있습니다(실행 취소 한 번으로 되돌리기).' : `실패: ${err?.message || err}`, undoLabel: store.undoStack.at(-1)?.label };
      }
      auto.running = false;
      auto.controller = null;
      paint();
    }

    syncStyles();
    refreshers.push(paint);
    return [
      h('div.ai-card',
        h('b', 'AI로 전체 편집하기'),
        h('div.note', '타임라인에 촬영한 영상(과 음악)을 넣고 스타일을 고른 뒤 시작하세요. 자르기·자막·제목·전환·색감·음악을 한 번에 하고, 결과는 실행 취소 한 번으로 모두 되돌릴 수 있습니다.')),
      h('div.qp-title', h('span', '스타일')), styleBtns,
      h('label.ai-field', h('span', '목표 길이 (AI가 덜 중요한 부분을 잘라 맞춤)'), lenSel),
      details,
      keyNote,
      result,
      h('div.ai-row.ai-gobar', startBtn, stopBtn),
    ];
  }

  // ---------------------------------------------------------------- assistant chat
  const chat = { log: [], history: [], running: false, controller: null };

  function chatView() {
    const logEl = h('div.ai-log', { 'aria-live': 'polite' });
    const input = h('textarea.ai-input', { rows: 2, placeholder: '예) 앞의 3초 잘라 줘 / 자막 맞춤법 고쳐 줘 / 30초 하이라이트 만들어 줘', 'aria-label': 'AI에게 요청' });
    const send = h('button.primary', { onclick: () => submit() }, '보내기');
    const stop = h('button', { onclick: () => chat.controller?.abort(), hidden: true }, '멈추기');
    const clear = h('button.small', { onclick: () => { chat.log = []; chat.history = []; renderLog(); }, title: '대화 지우기' }, '대화 지우기');
    const chips = h('div.ai-chips', PROMPTS.map(([label, text]) => h('button.small', { onclick: () => submit(text, label), title: text }, label)));
    const noKey = h('div.ai-card',
      h('b', 'Gemini API 키가 필요합니다'),
      h('div', '설정 탭에서 키를 넣으면, 말로 요청해서 편집할 수 있습니다. AI는 영상 화면과 소리를 직접 보지 못하고 타임라인 정보와 자막 글자만 봅니다.'),
      h('div.inline', h('button.primary', { onclick: () => show('settings') }, '설정 열기')), keyHint());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });

    function renderLog() {
      logEl.replaceChildren(...(chat.log.length ? chat.log.map(renderEntry) : [h('div.empty-hint', '아래에 원하는 편집을 말로 적거나, 위의 버튼을 누르세요.\n편집은 실행 취소(Ctrl+Z) 한 번으로 되돌릴 수 있습니다.')]));
      logEl.scrollTop = logEl.scrollHeight;
    }
    function renderEntry(m) {
      if (m.role === 'user') return h('div.ai-msg.user', m.text);
      if (m.role === 'tool') return h(`div.ai-step${m.error ? '.err' : ''}`, m.error ? '✗ ' : '✓ ', h('b', m.label), m.error ? ` — ${m.error}` : m.summary ? ` — ${m.summary}` : '');
      if (m.role === 'error') return h('div.ai-msg.err', m.text);
      if (m.role === 'pending') return h('div.ai-msg.pending', '생각하는 중…');
      const msg = h('div.ai-msg.model', m.text);
      if (m.edits && m.undoLabel) {
        msg.append(h('div.inline', h('button.small', {
          onclick: () => {
            if (store.undoStack.at(-1)?.label === m.undoLabel) store.undo();
            else toast('그 뒤에 다른 편집이 있어 여기서 되돌릴 수 없습니다. 작업 내역 패널을 쓰세요.');
          },
        }, '이 편집 되돌리기')));
      }
      return msg;
    }

    async function submit(text = input.value.trim(), shown = null) {
      if (!text || chat.running) return;
      if (!geminiSettings.key) {
        show('settings');
        toast('Gemini API 키를 먼저 넣으세요');
        return;
      }
      input.value = '';
      chat.running = true;
      chat.controller = new AbortController();
      send.hidden = true;
      stop.hidden = false;
      chat.log.push({ role: 'user', text: shown || text });
      const pending = { role: 'pending' };
      chat.log.push(pending);
      renderLog();
      try {
        const res = await runAssistant(text, {
          history: chat.history,
          signal: chat.controller.signal,
          onEvent: (ev) => {
            chat.log.splice(chat.log.indexOf(pending), 0, { role: 'tool', ...ev });
            renderLog();
          },
        });
        chat.log.splice(chat.log.indexOf(pending), 1);
        const undoLabel = res.edits ? store.undoStack.at(-1)?.label : null;
        chat.log.push({ role: 'model', text: res.text, edits: res.edits, undoLabel });
        chat.history.push({ role: 'user', text }, { role: 'model', text: res.text });
      } catch (err) {
        chat.log.splice(chat.log.indexOf(pending), 1);
        chat.log.push({ role: 'error', text: err?.name === 'AbortError' ? '멈췄습니다. 그때까지 한 편집은 남아 있습니다(실행 취소 가능).' : String(err?.message || err) });
      }
      chat.running = false;
      chat.controller = null;
      send.hidden = false;
      stop.hidden = true;
      renderLog();
    }
    aiApi.ask = (text) => {
      show('chat');
      return submit(text);
    };

    const status = h('div.ai-status');
    const compose = h('div.ai-compose', input, h('div.ai-compose-btns', send, stop));
    refreshers.push(() => {
      noKey.hidden = !!geminiSettings.key;
      for (const el of [chips, logEl, compose]) el.hidden = !geminiSettings.key && !chat.log.length;
      status.textContent = geminiSettings.key ? `Gemini · ${geminiSettings.model || '모델 자동 선택'}` : '';
      send.hidden = chat.running;
      stop.hidden = !chat.running;
    });
    renderLog();
    return [noKey, chips, logEl, compose, h('div.ai-foot', status, clear)];
  }

  // ---------------------------------------------------------------- transcript (text-based editing)
  let scriptTrack = null;
  const checked = new Set();

  function captionTracks() {
    const s = store.seq;
    return videoTracks(s)
      .map((t) => ({ t, n: clipsOnTrack(s, t.id).filter((c) => c.kind === 'text').length }))
      .filter((x) => x.n > 0);
  }

  function scriptView() {
    const trackSel = h('select', { 'aria-label': '자막 트랙' });
    const list = h('div.ai-script', { role: 'list' });
    const findIn = h('input', { type: 'search', placeholder: '찾을 말', 'aria-label': '찾을 말' });
    const repIn = h('input', { type: 'text', placeholder: '바꿀 말', 'aria-label': '바꿀 말' });
    const repBtn = h('button.small', { onclick: replaceAll }, '모두 바꾸기');
    const cutBtn = h('button.primary', { onclick: cutChecked, title: '체크한 줄의 시간 구간을 영상·소리까지 모든 트랙에서 잘라 내고 빈자리를 당깁니다' }, '영상에서 잘라내기');
    const delBtn = h('button', { onclick: deleteChecked, title: '영상은 그대로 두고 체크한 자막만 지웁니다' }, '자막만 지우기');
    const selInfo = h('span.ai-selinfo');
    const empty = h('div.ai-card',
      h('b', '자막이 없습니다'),
      h('div', '대본 편집은 자막(텍스트 클립)을 한 줄씩 보여 줍니다. 먼저 자동 자막을 만들거나 SRT 자막을 가져오세요.'),
      h('div.inline', h('button.primary', { onclick: () => openAutoCaptionDialog() }, '자동 자막 만들기…')));
    const wrap = h('div.ai-script-wrap',
      h('div.ai-row', h('span', '자막 트랙'), trackSel, h('button.small', { onclick: () => openAutoCaptionDialog(), title: '말소리를 글자로 바꿔 새 자막 트랙 만들기' }, '자동 자막…')),
      h('div.ai-row', findIn, repIn, repBtn),
      list,
      h('div.ai-row.ai-cutbar', selInfo, h('button.small', { onclick: () => { checked.clear(); renderList(); } }, '선택 해제'), delBtn, cutBtn),
      h('div.note', '시간을 누르면 그 위치로 갑니다. 글자를 고치면 자막이 바로 바뀝니다. "자막만 지우기"는 잘못 받아 적은 줄을 없애고, "영상에서 잘라내기"는 그 말을 한 구간을 영상·소리까지 잘라 내고 빈자리를 당깁니다.'));

    trackSel.addEventListener('change', () => {
      scriptTrack = trackSel.value;
      checked.clear();
      renderList();
    });

    function cues() {
      const s = store.seq;
      return scriptTrack ? clipsOnTrack(s, scriptTrack).filter((c) => c.kind === 'text') : [];
    }
    const textOfClip = (c) => String(c.effects.find((e) => e.type === 'text')?.params.content.value ?? '');

    let rows = [];
    function renderList() {
      const tracks = captionTracks();
      empty.hidden = tracks.length > 0;
      wrap.hidden = !tracks.length;
      if (!tracks.some((x) => x.t.id === scriptTrack)) scriptTrack = tracks.sort((a, b) => b.n - a.n)[0]?.t.id || null;
      trackSel.replaceChildren(...tracks.map(({ t, n }) => h('option', { value: t.id, selected: t.id === scriptTrack }, `${t.name} (${n}줄)`)));
      const s = store.seq;
      const list2 = cues();
      for (const id of [...checked]) if (!s.clips[id]) checked.delete(id);
      rows = list2.map((c) => {
        const box = h('input', { type: 'checkbox', checked: checked.has(c.id), 'aria-label': '이 줄 선택' });
        box.addEventListener('change', () => {
          if (box.checked) checked.add(c.id);
          else checked.delete(c.id);
          updateSel();
        });
        const time = h('button.ai-time', { onclick: () => store.setPlayhead(c.start + 1e-3), title: '이 위치로 이동' }, formatTimecode(c.start, s.fps).slice(3));
        const text = h('textarea.ai-line', { rows: 1, 'aria-label': '자막 글자' });
        text.value = textOfClip(c);
        text.addEventListener('focus', () => store.setPlayhead(c.start + 1e-3));
        text.addEventListener('change', () => {
          const cur = store.seq.clips[c.id];
          if (!cur || textOfClip(cur) === text.value) return;
          store.transact('자막 고치기', () => {
            cur.effects.find((e) => e.type === 'text').params.content.value = text.value;
            cur.name = text.value.split('\n')[0].slice(0, 40) || cur.name;
          });
        });
        const row = h('div.ai-line-row', { role: 'listitem' }, box, time, text);
        row.dataset.id = c.id;
        return row;
      });
      list.replaceChildren(...rows);
      updateSel();
      markCurrent();
    }
    function updateSel() {
      selInfo.textContent = checked.size ? `${checked.size}줄 선택` : '';
      cutBtn.disabled = !checked.size;
      delBtn.disabled = !checked.size;
    }
    function deleteChecked() {
      const s = store.seq;
      const ids = [...checked].filter((id) => s.clips[id]);
      if (!ids.length) return;
      store.transact('자막 지우기', () => {
        for (const id of ids) delete s.clips[id];
      });
      store.pruneSelection?.();
      checked.clear();
      toast(`자막 ${ids.length}줄을 지웠습니다`);
    }
    function markCurrent() {
      const t = store.ui.playhead;
      for (const r of rows) {
        const c = store.seq.clips[r.dataset.id];
        r.classList.toggle('now', !!c && c.start <= t && clipEnd(c) > t);
      }
    }
    function replaceAll() {
      const a = findIn.value;
      if (!a) return toast('찾을 말을 적으세요');
      const b = repIn.value;
      let n = 0;
      store.transact(`찾아 바꾸기: ${a} → ${b}`, () => {
        for (const c of cues()) {
          const p = c.effects.find((e) => e.type === 'text').params.content;
          const v = String(p.value ?? '');
          if (!v.includes(a)) continue;
          n += v.split(a).length - 1;
          p.value = v.split(a).join(b);
          c.name = p.value.split('\n')[0].slice(0, 40) || c.name;
        }
      });
      toast(n ? `${n}곳을 바꿨습니다` : '찾는 말이 없습니다');
    }
    function cutChecked() {
      const s = store.seq;
      const ranges = [...checked].map((id) => s.clips[id]).filter(Boolean).map((c) => ({ start: c.start, end: clipEnd(c) }));
      if (!ranges.length) return;
      try {
        const r = AI_TOOLS.find((t) => t.name === 'cut_time_ranges').run({ ranges, close_gaps: true });
        toast(`${r.cuts}곳, ${r.removed_seconds}초를 잘라 냈습니다 (Ctrl+Z로 되돌리기)`);
      } catch (err) {
        toast(String(err.message || err));
      }
      checked.clear();
    }
    refreshers.push(() => {
      // keep typing undisturbed: only rebuild when the caption set changed
      const ids = cues().map((c) => `${c.id}:${c.start}:${textOfClip(c)}`).join('|');
      if (ids !== list.dataset.sig || !captionTracks().some((x) => x.t.id === scriptTrack)) {
        const focused = document.activeElement?.closest?.('.ai-line-row')?.dataset.id;
        renderList();
        list.dataset.sig = cues().map((c) => `${c.id}:${c.start}:${textOfClip(c)}`).join('|');
        if (focused) list.querySelector(`.ai-line-row[data-id="${focused}"] textarea`)?.focus({ preventScroll: true });
      } else markCurrent();
    });
    return [empty, wrap];
  }

  // ---------------------------------------------------------------- settings
  function settingsView() {
    const key = h('input', { type: 'password', value: geminiSettings.key, placeholder: 'AIza…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Gemini API 키' });
    const showKey = h('button.small', { onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, '보기');
    const remember = h('input', { type: 'checkbox', checked: geminiSettings.remember });
    const model = h('select', { 'aria-label': 'Gemini 모델' });
    const status = h('div.note');
    const fillModels = () => {
      const list = geminiSettings.models.length ? geminiSettings.models : geminiSettings.model ? [{ id: geminiSettings.model, label: geminiSettings.model }] : [];
      model.replaceChildren(h('option', { value: '' }, '자동 선택 (가장 알맞은 Flash 모델)'), ...list.map((m) => h('option', { value: m.id, selected: m.id === geminiSettings.model }, m.label === m.id ? m.id : `${m.label} (${m.id})`)));
      model.value = geminiSettings.model || '';
    };
    fillModels();
    const save = () => {
      saveGeminiSettings({ key: key.value, model: model.value, remember: remember.checked });
      status.textContent = key.value.trim() ? (remember.checked ? '저장했습니다 (이 브라우저에 기억)' : '저장했습니다 (이 탭을 닫으면 지워짐)') : '키를 지웠습니다';
    };
    const load = async () => {
      save();
      if (!geminiSettings.key) return;
      status.textContent = '모델 목록을 불러오는 중…';
      try {
        const list = await listGeminiModels();
        fillModels();
        status.textContent = `연결됐습니다. 쓸 수 있는 모델 ${list.length}개`;
      } catch (err) {
        status.textContent = `실패: ${err.message || err}`;
      }
    };
    model.addEventListener('change', save);
    remember.addEventListener('change', save);
    return [
      h('div.ai-card',
        h('b', 'Gemini 연결'),
        h('label.ai-field', h('span', 'API 키'), h('div.inline', key, showKey)),
        h('label.inline', remember, '이 브라우저에 기억하기 (끄면 탭을 닫을 때 지워짐)'),
        h('div.inline', h('button.primary', { onclick: load }, '저장하고 연결 확인'), h('button', { onclick: () => { key.value = ''; save(); } }, '키 지우기')),
        h('label.ai-field', h('span', '모델'), model),
        status,
        keyHint()),
      h('div.ai-card',
        h('b', '무엇이 보내지나요?'),
        h('ul.ai-list',
          h('li', 'AI 도우미: 타임라인 정보(트랙, 클립 이름·시간, 자막·글자 내용, 마커)와 요청 글. 영상 화면은 보내지 않습니다.'),
          h('li', 'Gemini 자동 자막: 섞인 소리(오디오).'),
          h('li', '키와 요청은 이 브라우저에서 Google(generativelanguage.googleapis.com)로 바로 갑니다. 이 편집기에는 따로 서버가 없습니다.')),
        h('div.note.warn', 'Gemini API 약관상 무료 등급에서 보낸 내용은 Google이 서비스 개선에 쓰고 사람이 검토할 수 있다고 되어 있습니다(약관은 바뀔 수 있으니 원문을 확인하세요). 민감한 영상에는 주의하세요. 키가 기억된 브라우저를 쓰는 사람은 누구나 키를 쓸 수 있습니다.'),
        h('div.note', 'claude.ai 아티팩트 보기 화면에서는 외부 연결이 막혀 Gemini를 쓸 수 없습니다. GitHub Pages 주소나 내 컴퓨터에서 여세요.')),
    ];
  }

  const VIEWS = { auto: autoView, chat: chatView, script: scriptView, settings: settingsView };

  aiApi.show = (id) => show(id);
  store.on('change', refresh);
  store.on('gemini-settings', refresh);
  let last = 0;
  store.on('playhead', () => {
    const now = performance.now();
    if (now - last > 120) {
      last = now;
      refresh();
    }
  });
  show(section);
  return Object.assign(body, {
    onShow: () => { visible = true; refresh(); },
    onHide: () => { visible = false; },
  });
}
