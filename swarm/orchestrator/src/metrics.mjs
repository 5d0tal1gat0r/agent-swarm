import { createHash } from 'node:crypto';
// Swarm metrics from the task store. computeMetrics is pure: tasks in, numbers out.
// Lead time: task created to merged. Tokens per merged task: usedTokens at merge.
const MIN = 60_000;

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { median: Math.round(median), mean: Math.round(mean), count: sorted.length };
}

export function computeMetrics(tasks, { now, budgetWarn = 0.8 } = {}) {
  const statusCounts = {};
  const queueDepth = {};
  let leasesHeld = 0;
  let totalTokens = 0;
  let reviewRounds = 0;
  let tasksWithRounds = 0;
  let overBudget = 0;
  const leadMinutes = [];
  const tokensPerMerged = [];
  for (const t of tasks) {
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
    if (t.status === 'queued') queueDepth[t.department] = (queueDepth[t.department] ?? 0) + 1;
    if (t.lease) leasesHeld += 1;
    totalTokens += t.usedTokens;
    if (t.review?.rounds) {
      reviewRounds += t.review.rounds;
      tasksWithRounds += 1;
    }
    if (t.budget?.tokens && t.usedTokens / t.budget.tokens >= budgetWarn) overBudget += 1;
    if (t.status === 'merged') {
      const at = [...t.history].reverse().find((h) => h.to === 'merged')?.at ?? t.updatedAt;
      leadMinutes.push((Date.parse(at) - Date.parse(t.createdAt)) / MIN);
      tokensPerMerged.push(t.usedTokens);
    }
  }
  return {
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    tasks: tasks.length,
    statusCounts,
    queueDepth,
    leasesHeld,
    totalTokens,
    overBudget,
    reviewRounds: { total: reviewRounds, tasks: tasksWithRounds },
    merged: {
      count: leadMinutes.length,
      leadTimeMinutes: summarize(leadMinutes),
      tokensPerMerged: summarize(tokensPerMerged),
    },
  };
}

/** One line for #swarm once a day. */
export function dailySummary(m) {
  const queued = Object.values(m.queueDepth).reduce((s, n) => s + n, 0);
  const lead = m.merged.leadTimeMinutes ? `${m.merged.leadTimeMinutes.median} min` : 'n/a';
  const tokens = m.merged.tokensPerMerged ? `${m.merged.tokensPerMerged.median}` : 'n/a';
  return `daily: ${m.merged.count} merged, median lead ${lead}, median tokens/merged ${tokens}, queued ${queued}, leases ${m.leasesHeld}, over budget ${m.overBudget}, review rounds ${m.reviewRounds.total}`;
}

/** Dashboard page. No data inside: it asks for a token and reads /metrics with a bearer header. No external resources. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm dashboard</title>
<style>
  :root { --bg: #fff; --fg: #111; --muted: #666; --card: #f4f4f5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #999; --card: #1d1d20; } }
  body { margin: 0; padding: 16px; font: 15px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .card { background: var(--card); border-radius: 8px; padding: 12px; }
  .label { color: var(--muted); font-size: 12px; }
  .value { font-size: 22px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--card); }
  [hidden] { display: none !important; }
  form { display: flex; gap: 8px; margin-bottom: 12px; }
  input { flex: 1; padding: 8px; font: inherit; }
  button { padding: 8px 12px; font: inherit; }
  #status { color: var(--muted); margin: 8px 0; }
</style>
</head>
<body>
<h1>Swarm</h1>
<form id="auth" hidden>
  <input id="token" type="password" autocomplete="off" placeholder="manager token" aria-label="manager token">
  <button type="submit">Load</button>
</form>
<div id="status" role="status">Loading...</div>
<div id="cards" class="grid"></div>
<table id="queue" hidden><thead><tr><th>Department</th><th>Queued</th></tr></thead><tbody></tbody></table>
<table id="states" hidden><thead><tr><th>Status</th><th>Tasks</th></tr></thead><tbody></tbody></table>
<script>
(function () {
  var KEY = 'swarm-dashboard-token';
  var statusEl = document.getElementById('status');
  var cards = document.getElementById('cards');
  var form = document.getElementById('auth');
  function token() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function forget() { try { sessionStorage.removeItem(KEY); } catch (e) { /* nothing stored */ } }
  function remember(t) { try { sessionStorage.setItem(KEY, t); } catch (e) { /* private window: keep in memory only */ } }
  function card(label, value) {
    var c = document.createElement('div'); c.className = 'card';
    var l = document.createElement('div'); l.className = 'label'; l.textContent = label;
    var v = document.createElement('div'); v.className = 'value'; v.textContent = value;
    c.appendChild(l); c.appendChild(v); cards.appendChild(c);
  }
  function rows(table, data) {
    var body = table.querySelector('tbody'); body.textContent = '';
    Object.keys(data).sort().forEach(function (k) {
      var tr = document.createElement('tr');
      var a = document.createElement('td'); a.textContent = k;
      var b = document.createElement('td'); b.textContent = String(data[k]);
      tr.appendChild(a); tr.appendChild(b); body.appendChild(tr);
    });
    table.hidden = Object.keys(data).length === 0;
  }
  function show(m) {
    statusEl.textContent = 'Updated ' + m.generatedAt;
    cards.textContent = '';
    card('Merged', m.merged.count);
    card('Median lead time (min)', m.merged.leadTimeMinutes ? m.merged.leadTimeMinutes.median : 'n/a');
    card('Median tokens per merged', m.merged.tokensPerMerged ? m.merged.tokensPerMerged.median : 'n/a');
    card('Leases held', m.leasesHeld);
    card('Over budget', m.overBudget);
    card('Review rounds', m.reviewRounds.total);
    card('Total tokens', m.totalTokens);
    rows(document.getElementById('queue'), m.queueDepth);
    rows(document.getElementById('states'), m.statusCounts);
  }
  function load(t, save) {
    statusEl.textContent = 'Loading...';
    fetch('/metrics', { headers: { authorization: 'Bearer ' + t } }).then(function (r) {
      if (r.status === 401 || r.status === 403) { statusEl.textContent = 'Token refused (' + r.status + ').'; forget(); form.hidden = false; return null; }
      if (!r.ok) { statusEl.textContent = 'Failed (' + r.status + ').'; return null; }
      return r.json();
    }).then(function (m) { if (m) { if (save) remember(t); form.hidden = true; show(m); } }).catch(function () { statusEl.textContent = 'Network error.'; });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = document.getElementById('token').value.trim();
    if (t) load(t, true);
  });
  var t = token();
  if (t) load(t); else { form.hidden = false; statusEl.textContent = 'Enter a manager token.'; }
})();
</script>
</body>
</html>
`;

/**
 * CSP with hashes of the one inline script and the one inline style, so no 'unsafe-inline'.
 * Any other inline code (injected or edited without updating the page) is blocked.
 */
const sha = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const inline = (tag) => DASHBOARD_HTML.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
export const DASHBOARD_CSP = `default-src 'none'; script-src ${sha(inline('script'))}; style-src ${sha(inline('style'))}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
