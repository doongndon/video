// Styles of the Effect Controls timeline view and graph editor, the Effects panel extras, the audio
// mixers, the markers list, the tools panel groups and Lumetri Scopes. Injected once when the panels
// load, so these panels keep their look in one place next to their code.

import { injectStyle } from './style-inject.js';

const CSS = `
/* ---------------- effect controls: timeline view */
.ec-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ec { position: relative; --ec-left: 320px; }
.ec-top { position: sticky; top: 0; z-index: 4; background: var(--bg-2); border-bottom: 1px solid var(--line); }
.ec-top .ec-head { position: static; border-bottom: none; }
.ec-head .ibtn.on { color: var(--value); }
.ec-row { position: relative; }
.ec.tlv .ec-row { display: grid; grid-template-columns: var(--ec-left) minmax(0, 1fr); }
.ec.tlv .ec-row > .ec-l { min-width: 0; border-right: 1px solid var(--line); }
.ec.tlv .ec-row > .ec-t { position: relative; min-width: 0; background: #1a1d22; }
.ec.tlv .ec-fullrow > .ec-full { grid-column: 1 / -1; }
.ec:not(.tlv) .ec-row > .ec-t { position: relative; height: calc(26px * var(--ui-scale)); margin: 0 8px 4px calc(32px * var(--ui-scale)); background: var(--bg-2); border-radius: 4px; }
.ec:not(.tlv) .ec-prow:not(.has-kf) > .ec-t, .ec:not(.tlv) .ec-hrow > .ec-t { display: none; }
.ec:not(.tlv) .ec-grow > .ec-l { display: none; }
.ec:not(.tlv) .ec-grow > .ec-t { height: auto; margin-left: 8px; }
.ec-hrow > .ec-t { background: #20242a !important; }
.ec-ruler-row { border-top: 1px solid var(--line); }
.ec-ruler-row > .ec-l { display: flex; align-items: center; gap: 6px; padding: 0 8px; position: relative; }
.ec-ruler-row .ec-tc { color: var(--value); font-variant-numeric: tabular-nums; font-weight: 600; font-size: var(--fs-s); }
.ec-ruler-row .ec-ruler-hint { color: var(--text-faint); font-size: var(--fs-xs); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ec-ruler { height: calc(26px * var(--ui-scale)); cursor: text; touch-action: none; }
.ec-ruler canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ec-divider { position: absolute; top: 0; bottom: 0; right: -4px; width: 8px; cursor: col-resize; z-index: 2; touch-action: none; }
.ec-divider:hover, .ec-divider.dragging { background: var(--accent); opacity: 0.6; }
.ecp { display: grid; grid-template-columns: calc(16px * var(--ui-scale)) calc(22px * var(--ui-scale)) minmax(56px, 1fr) minmax(72px, 1.15fr) auto; align-items: center; gap: 4px; padding: 2px 6px 2px 4px; min-height: calc(30px * var(--ui-scale)); }
.ec-prow:hover > .ecp, .ec-prow:hover > .ec-t { background: var(--bg-4); }
.ecp .label { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ecp .ec-val { min-width: 0; overflow: hidden; }
.ecp select, .ecp textarea { width: 100%; }
.ecp .stopwatch, .ec-twirl, .ec-ptools button { min-width: 0; min-height: 0; padding: 0; background: none; border: none; color: var(--text-faint); width: calc(22px * var(--ui-scale)); height: calc(22px * var(--ui-scale)); display: inline-grid; place-items: center; }
.ecp .stopwatch.on { color: var(--value); }
.ec-twirl { font-size: 11px; width: calc(16px * var(--ui-scale)); }
.ec-twirl.on { color: var(--value); }
.ec-ptools { display: flex; align-items: center; gap: 0; }
.ec-ptools button { color: var(--text-dim); }
.ec-ptools button.on { color: var(--value); }
.ec-ptools .kf-spacer { display: inline-block; width: calc(66px * var(--ui-scale)); }
.ec-section.sel > .ec-hrow > .ec-l, .ec-section.sel > .ec-hrow .ec-sec-head { background: var(--sel); }
.ec-hrow .ec-sec-head .fxname { cursor: default; }
.ec-hrow .ec-sec-head { cursor: grab; }
.ec-hrow .ec-sec-head.fixed { cursor: default; }
.ec-maskbar { display: flex; align-items: center; gap: 2px; padding: 2px 8px 2px calc(42px * var(--ui-scale)); }
.ec-maskbar .note { margin-left: 6px; font-size: var(--fs-xs); color: var(--text-faint); }
.ec-mask-head { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px calc(30px * var(--ui-scale)); color: var(--text-dim); }
.ec-mask-head .mname { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-mask-head.on .mname { color: var(--warn); }
.ec-track-btns { display: inline-flex; gap: 2px; align-items: center; }
.ec-track-btns button { min-height: 0; height: calc(22px * var(--ui-scale)); min-width: calc(24px * var(--ui-scale)); padding: 0 4px; }
.ec-track-btns select { min-height: 0; height: calc(22px * var(--ui-scale)); padding: 0 4px; font-size: var(--fs-xs); }
/* keyframes */
/* the element is a plain square hit target; ::before draws Premiere's keyframe shape */
.ec-t .kfd { position: absolute; top: 50%; width: 15px; height: 15px; margin: -7.5px 0 0 -7.5px; cursor: ew-resize; z-index: 1; touch-action: none; }
.ec-t .kfd::before { content: ""; position: absolute; inset: 2px; background: #c3c9d3; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
.ec-t .kfd.autoBezier::before, .ec-t .kfd.ease::before { clip-path: none; border-radius: 50%; inset: 2.5px; }
.ec-t .kfd.bezier::before, .ec-t .kfd.continuousBezier::before { clip-path: polygon(0 0, 100% 0, 62% 50%, 100% 100%, 0 100%, 38% 50%); }
.ec-t .kfd.hold::before { clip-path: polygon(50% 0, 100% 0, 100% 100%, 50% 100%, 0 50%); }
.ec-t .kfd.easeIn::before { clip-path: polygon(0 0, 38% 50%, 0 100%, 50% 100%, 100% 50%, 50% 0); }
.ec-t .kfd.easeOut::before { clip-path: polygon(50% 0, 0 50%, 50% 100%, 100% 100%, 62% 50%, 100% 0); }
.ec-t .kfd.at::before { background: #fff; }
.ec-t .kfd.sel::before { background: var(--value); }
.ec-t .kfd:hover::before { filter: brightness(1.25); }
body.mobile .ec-t .kfd { width: 24px; height: 24px; margin: -12px 0 0 -12px; }
body.mobile .ec-t .kfd::before { inset: 6px; }
.ec-t .ph { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent); pointer-events: none; z-index: 2; }
.ec-t.ec-graph { padding: 0; }
.ec-t.ec-graph canvas { display: block; width: 100%; touch-action: none; cursor: default; }
.ec-graph-l { padding: 6px 10px 6px calc(42px * var(--ui-scale)); color: var(--text-faint); font-size: var(--fs-xs); line-height: 1.5; display: flex; flex-direction: column; justify-content: space-between; }
.ec-graph-l b { color: var(--text-dim); font-weight: 600; }
.ec-marquee { position: fixed; z-index: 900; border: 1px solid var(--value); background: rgba(108,182,255,0.12); pointer-events: none; }
.ec-dropline { position: fixed; z-index: 900; height: 2px; background: var(--accent); pointer-events: none; box-shadow: 0 0 4px var(--accent); }
.ec.dropping { outline: 2px dashed var(--accent); outline-offset: -3px; }
.ec-foot { display: flex; align-items: center; gap: 8px; padding: 3px 8px; border-top: 1px solid var(--line); background: var(--bg-2); flex-shrink: 0; color: var(--text-faint); font-size: var(--fs-xs); min-height: calc(26px * var(--ui-scale)); }
.ec-foot .ec-foot-tc { color: var(--value); font-variant-numeric: tabular-nums; font-weight: 600; font-size: var(--fs-s); }
.ec-foot .grow { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ec-foot input[type=range] { width: calc(110px * var(--ui-scale)); }
.ec-group.ec-row { display: block !important; }
.ec-fullrow .ec-wide { padding-left: calc(42px * var(--ui-scale)); }
body.mobile .ecp { grid-template-columns: 18px 24px minmax(56px, 1fr) minmax(84px, 1.3fr) auto; min-height: 40px; padding: 3px 4px; }
body.mobile .ec-ptools button, body.mobile .ecp .stopwatch { width: 30px; height: 30px; }
body.mobile .ec-maskbar, body.mobile .ec-mask-head { padding-left: 10px; }

/* ---------------- effects panel extras */
.fx-folder-head .count { margin-left: auto; color: var(--text-faint); font-weight: 400; font-size: var(--fs-xs); }
.fx-item .fx-badge { font-size: 10px; color: var(--text-faint); border: 1px solid var(--line-2); border-radius: 3px; padding: 0 4px; }
.fx-item .star { margin-left: auto; opacity: 0; min-height: 0; height: calc(22px * var(--ui-scale)); }
.fx-item:hover .star, .fx-item .star.on { opacity: 1; }
.fx-item .star.on { color: var(--warn); }
.fx-item .star + .del { margin-left: 0; }
.fx-item.sel { background: var(--sel); }
.fx-item .fx-apply { min-height: 0; height: calc(26px * var(--ui-scale)); padding: 0 10px; }
body.mobile .ec-head .ibtn[aria-label^="타임라인 보기"] { display: none; }

/* ---------------- mixers */
.mixer-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.mixer .strip { position: relative; }
.mixer .strip .meter-box { display: flex; gap: 4px; align-items: stretch; }
.mixer .strip canvas.mm { width: 10px; height: 150px; background: #0d0d0d; border-radius: 2px; }
.mixer .strip .peak { font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums; cursor: pointer; min-height: 14px; }
.mixer .strip .peak.clip { color: #fff; background: var(--danger); border-radius: 3px; padding: 0 3px; }
.mixer .strip .db { cursor: text; }
.mixer .strip .db-input { width: 64px; min-height: 0; padding: 1px 4px; font-size: var(--fs-s); }
.mixer .strip .sname { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mixer .strip .ssub { font-size: var(--fs-xs); color: var(--text-faint); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mixer .strip .btns button.rec.on { background: var(--rec); color: #fff; }
.mixer .strip.cm.selected { border-color: var(--value); }
.mixer .strip .kfbtn { min-width: 0; min-height: 0; width: 26px; height: 24px; padding: 0; }
.mixer .strip .kfbtn.on { color: var(--value); border-color: var(--accent); background: var(--accent-soft); }
.mixer .knob { width: 70px; }
.mixer-empty { margin: auto; }

/* ---------------- markers */
.mk-chips { display: flex; gap: 3px; flex-wrap: wrap; }
.mk-chip { width: 14px; height: 14px; min-width: 0; min-height: 0; padding: 0; border-radius: 3px; border: 1px solid #0007; }
.mk-chip.off { opacity: 0.22; }
.mk-row { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--bg-2); cursor: pointer; }
.mk-row:hover { background: var(--bg-4); }
.mk-row.current { background: var(--sel); }
.mk-row .dot { width: 11px; height: 11px; border-radius: 3px; }
.mk-main { min-width: 0; }
.mk-line { display: flex; gap: 8px; align-items: center; min-width: 0; }
.mk-line .mono { font-variant-numeric: tabular-nums; color: var(--value); font-size: var(--fs-s); white-space: nowrap; }
.mk-line input { flex: 1; min-width: 40px; background: transparent; border-color: transparent; min-height: 0; padding: 1px 4px; }
.mk-line input:focus { border-color: var(--line-2); background: var(--bg); }
.mk-sub { color: var(--text-faint); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 4px; }

/* ---------------- tools panel groups */
#tools button { position: relative; }
#tools button.grp::after { content: ""; position: absolute; right: 2px; bottom: 2px; width: 0; height: 0; border-left: 4px solid transparent; border-bottom: 4px solid currentColor; opacity: 0.55; }

/* ---------------- eyedropper waiting for a Program Monitor click */
.monitor-view.ec-picking, .monitor-view.ec-picking * { cursor: crosshair !important; }

/* ---------------- lumetri scopes */
.scopes .scope-grid { flex: 1; display: grid; gap: 4px; padding: 4px; min-height: 0; background: #050607; }
.scopes .scope-cell { position: relative; min-width: 0; min-height: 0; }
.scopes .scope-cell canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; background: #07080a; }
.scopes .scope-cell .scope-name { position: absolute; left: 6px; bottom: 3px; font-size: 10px; color: rgba(200,206,216,0.7); pointer-events: none; }
.scopes .panel-toolbar input[type=range] { width: calc(90px * var(--ui-scale)); }
`;

injectStyle('montage-fxpanels-css', CSS);
