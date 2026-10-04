// Small stroke icon set (16×16 viewBox). icon(name) returns an inline SVG element.

const P = {
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
  stepBack: '<path d="M11.5 4v8L6 8z" fill="currentColor" stroke="none"/><path d="M4.5 4v8"/>',
  stepForward: '<path d="M4.5 4v8L10 8z" fill="currentColor" stroke="none"/><path d="M11.5 4v8"/>',
  goIn: '<path d="M3.5 3v10M13 4v8L7 8z"/>',
  goOut: '<path d="M12.5 3v10M3 4v8l6-4z"/>',
  markIn: '<path d="M10 3H6v10h4"/>',
  markOut: '<path d="M6 3h4v10H6"/>',
  marker: '<path d="M4 2.5h8v8L8 14l-4-3.5z"/>',
  lift: '<path d="M3 12h10M8 10V3M5 5.5 8 2.5l3 3"/>',
  extract: '<path d="M3 12h3M10 12h3M8 10V3M5 5.5 8 2.5l3 3"/>',
  camera: '<path d="M2.5 5.5h2l1.2-2h4.6l1.2 2h2v7h-11z"/><circle cx="8" cy="9" r="2.3"/>',
  loop: '<path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 3v3h-3M13 8a5 5 0 0 1-8.5 3.5L3 10M3 13v-3h3"/>',
  safe: '<rect x="2" y="3" width="12" height="10"/><rect x="4.5" y="5" width="7" height="6" stroke-dasharray="1.5 1.2"/>',
  insert: '<path d="M8 2.5v7M5 6.5l3 3 3-3M2.5 12.5h4M9.5 12.5h4M6.5 11v3M9.5 11v3"/>',
  overwrite: '<path d="M8 2.5v7M5 6.5l3 3 3-3M2.5 12.5h11"/>',
  magnet: '<path d="M4 3v5a4 4 0 0 0 8 0V3M4 6h2.5M9.5 6H12M6.5 3v5a1.5 1.5 0 0 0 3 0V3"/>',
  link: '<path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M14.2 8h-2M3.8 8h-2M12.4 3.6 11 5M5 11l-1.4 1.4M12.4 12.4 11 11M5 5 3.6 3.6"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  unlock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM2.5 13.5l11-11"/>',
  mic: '<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  up: '<path d="M4 10l4-4 4 4"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
  reset: '<path d="M3.5 6.5A5 5 0 1 1 3 9M3.5 3v3.5H7"/>',
  stopwatch: '<circle cx="8" cy="9" r="5"/><path d="M8 9V6.5M6.5 2h3M8 2v2"/>',
  kfPrev: '<path d="M10 4 6 8l4 4"/>',
  kfNext: '<path d="M6 4l4 4-4 4"/>',
  diamond: '<path d="M8 3l5 5-5 5-5-5z"/>',
  folder: '<path d="M2 4.5h4l1.5 1.5H14v7H2z"/>',
  folderPlus: '<path d="M2 4.5h4l1.5 1.5H14v7H2zM8 8v4M6 10h4"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/>',
  list: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  import: '<path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 11v2.5h11V11"/>',
  export: '<path d="M8 10.5v-8M5 5.5l3-3 3 3M2.5 11v2.5h11V11"/>',
  film: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 3v10M11 3v10M2 6h3M2 10h3M11 6h3M11 10h3"/>',
  audio: '<path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>',
  text: '<path d="M3 3.5h10M8 3.5v9M6 12.5h4"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="6" cy="6.5" r="1.3"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
  sequence: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 7h12M5.5 7v6M10 3v4"/>',
  scissors: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M6 10 12.5 2.5M10 10 3.5 2.5"/>',
  undo: '<path d="M5.5 4 2.5 7l3 3M2.5 7H10a3.5 3.5 0 0 1 0 7H8"/>',
  redo: '<path d="M10.5 4l3 3-3 3M13.5 7H6a3.5 3.5 0 0 0 0 7h2"/>',
  zoomIn: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14M5 7h4M7 5v4"/>',
  zoomOut: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14M5 7h4"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2A1.8 1.8 0 1 1 8 8.3V9.5M8 11.5v.3"/>',
  wand: '<path d="M3 13 10.5 5.5M9.5 4.5l2 2M11 2v1.5M13.5 4.5H15M13 2l-1 1M2.5 4.5l1 1"/>',
  multicam: '<rect x="2" y="2.5" width="5.5" height="4.5"/><rect x="8.5" y="2.5" width="5.5" height="4.5"/><rect x="2" y="9" width="5.5" height="4.5"/><rect x="8.5" y="9" width="5.5" height="4.5"/>',
  record: '<circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none"/>',
  select: '<path d="M4 2l9 6-4 1 3 5-2 1-3-5-3 3z"/>',
  track: '<path d="M2 8h9M8 5l3 3-3 3M13 3v10"/>',
  ripple: '<path d="M3 3v10M3 8h7M8 5l3 3-3 3M13 3v10"/>',
  rolling: '<path d="M8 2v12M2 8h4M10 8h4M4 6l-2 2 2 2M12 6l2 2-2 2"/>',
  razor: '<path d="M3 13l7-7M8 3l5 5-3 3-5-5zM2 14l2-1"/>',
  slip: '<path d="M2 5h12v6H2zM5 8h6M5 8l2-2M5 8l2 2M11 8l-2-2M11 8l-2 2"/>',
  hand: '<path d="M5 14V7M5 7V3.5a1 1 0 0 1 2 0V7M7 7V2.5a1 1 0 0 1 2 0V7M9 7V3.5a1 1 0 0 1 2 0V9c0 3-1.5 5-4 5S3 12 3 10V8"/>',
  zoom: '<circle cx="7" cy="7" r="4"/><path d="M10 10l4 4M5 7h4M7 5v4"/>',
  type: '<path d="M3 3h10M8 3v10M6 13h4"/>',
  pen: '<path d="M3 13l2-5 6-6 3 3-6 6zM5 8l3 3"/>',
};

export function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'ico';
  span.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

/** Button with an icon and an accessible Korean label (title shows the shortcut). */
export function iconButton(name, title, onclick, { label = null, cls = '' } = {}) {
  const b = document.createElement('button');
  b.className = `ibtn ${cls}`.trim();
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(icon(name));
  if (label) {
    const s = document.createElement('span');
    s.className = 'ibtn-label';
    s.textContent = label;
    b.append(s);
  }
  if (onclick) b.addEventListener('click', onclick);
  return b;
}
