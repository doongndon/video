// Styles that belong to one UI module are added by that module (keeps styles/app.css untouched).

export function injectStyle(id, css) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.append(el);
}
