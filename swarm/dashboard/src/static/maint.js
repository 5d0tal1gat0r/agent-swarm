// Maintenance banner (ARCHITECTURE 77), loaded by every dashboard page. Probes /health every PROBE_MS and shows a
// bar at the top while the dashboard is in maintenance or unreachable; reloads the page when it comes back.
import { bannerState, nextProbe } from '/maint.mjs';

const PROBE_MS = 10_000;
let probe = { wasDown: false };
let bar = null;

function show(state) {
  if (!state) { bar?.remove(); bar = null; return; }
  if (!bar) {
    bar = Object.assign(document.createElement('div'), { className: 'maint-bar', role: 'status' });
    bar.setAttribute('aria-live', 'polite');
    document.body.prepend(bar);
  }
  bar.dataset.kind = state.kind;
  bar.textContent = state.text;
}

async function check() {
  let health = null;
  try {
    const res = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.ok) health = await res.json();
  } catch { health = null; }
  probe = nextProbe(probe, Boolean(health));
  if (probe.reload) { location.reload(); return; }
  show(bannerState({ reachable: Boolean(health), maintenance: health?.maintenance ?? null }));
}

check();
setInterval(check, PROBE_MS);
