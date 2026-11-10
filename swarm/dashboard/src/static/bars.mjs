// Bar sizes under the dashboard CSP (style-src 'self'): the browser ignores inline style=""
// attributes, so renderers put the size in data-w (percent) or data-flex (a flex-grow number)
// and this module applies it through the CSSOM, which the CSP allows.

export const barWidth = (value) => `${Math.max(0, Math.min(100, Math.round(Number(value) || 0)))}%`;

/** Sizes every [data-w] and [data-flex] element under root. */
export function applyBars(root) {
  for (const el of root.querySelectorAll('[data-w]')) el.style.width = barWidth(el.dataset.w);
  for (const el of root.querySelectorAll('[data-flex]')) if (/^\d+(\.\d+)?$/.test(el.dataset.flex)) el.style.flexGrow = el.dataset.flex;
}

/** Keeps bars sized as panels re-render: applies once now, then on every DOM change. */
export function watchBars(root = document.body) {
  applyBars(root);
  new MutationObserver(() => applyBars(root)).observe(root, { childList: true, subtree: true });
}
