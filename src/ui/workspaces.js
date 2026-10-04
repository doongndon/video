// Workspace presets: which panel tabs are in front and how big the panel areas are.

import { showPanel, savePref } from './common.js';

export const WORKSPACES = [
  { id: 'edit', name: '편집 (기본)', tabs: ['source', 'project', 'program', 'timeline'], vars: { '--tl-w': '500px', '--bl-w': '460px', '--top-h': '52%' } },
  { id: 'color', name: '색상 보정', tabs: ['effectControls', 'effects', 'program', 'timeline'], vars: { '--tl-w': '560px', '--bl-w': '420px', '--top-h': '58%' } },
  { id: 'audio', name: '오디오', tabs: ['mixer', 'effects', 'program', 'timeline'], vars: { '--tl-w': '560px', '--bl-w': '420px', '--top-h': '46%' } },
  { id: 'effects', name: '효과', tabs: ['effectControls', 'effects', 'program', 'timeline'], vars: { '--tl-w': '520px', '--bl-w': '440px', '--top-h': '52%' } },
  { id: 'captions', name: '자막·그래픽', tabs: ['effectControls', 'markers', 'program', 'timeline'], vars: { '--tl-w': '500px', '--bl-w': '440px', '--top-h': '55%' } },
  { id: 'multicam', name: '멀티캠', tabs: ['multicam', 'project', 'program', 'timeline'], vars: { '--tl-w': '620px', '--bl-w': '420px', '--top-h': '58%' } },
  { id: 'review', name: '검토 (모니터 크게)', tabs: ['scopes', 'markers', 'program', 'timeline'], vars: { '--tl-w': '360px', '--bl-w': '420px', '--top-h': '66%' } },
];

export function applyWorkspace(id) {
  const ws = WORKSPACES.find((w) => w.id === id);
  if (!ws) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(ws.vars)) {
    root.style.setProperty(k, v);
    savePref(`split${k}`, v);
  }
  for (const tab of ws.tabs) showPanel(tab);
  savePref('workspace', id);
  window.dispatchEvent(new Event('resize'));
}
