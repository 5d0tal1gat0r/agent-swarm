// "Fix and retry" for a stuck or blocked task (ARCHITECTURE 63). Pure: the task and the snapshot in,
// a form out, and the form's fields back into an amend request. The orchestrator checks every field
// again and only the owner may send it. Used by app.js and the tests.

import { esc, statusLabel } from './render.mjs';

export const FIXABLE = new Set(['escalated', 'needs-human', 'failed', 'blocked']);

/** Why the task is stuck, in one line: the last history reason, or what it waits for. */
export function stuckReason(task, history = [], tasks = []) {
  if (task.status === 'blocked') {
    const waits = task.dependsOn.map((d) => tasks.find((t) => t.id === d) ?? { id: d, status: '?' }).filter((t) => t.status !== 'merged');
    return waits.length ? `waits for ${waits.map((t) => `${t.id} (${statusLabel(t.status)})`).join(', ')}` : 'all dependencies merged; queued on the next change';
  }
  const last = [...history].reverse().find((h) => h.to === task.status || h.to === 'failed');
  return last?.reason ?? 'no reason recorded';
}

/** The form, or '' when the viewer is not the owner or the task is not stuck. */
export function renderFixForm(task, { owner = false, history = [], tasks = [] } = {}) {
  if (!owner || !task || !FIXABLE.has(task.status)) return '';
  const deps = task.dependsOn.map((d) => {
    const t = tasks.find((x) => x.id === d);
    return `<label class="dep"><input type="checkbox" name="drop" value="${esc(d)}"> drop ${esc(d)} <span class="mut">${esc(statusLabel(t?.status ?? '?'))}${t?.title ? ` · ${esc(t.title)}` : ''}</span></label>`;
  }).join('');
  return `<form id="fix-form" class="fix" data-task="${esc(task.id)}">
<h3>Fix and retry ${esc(task.id)}</h3>
<p class="neg">${esc(stuckReason(task, history, tasks))}</p>
<label for="fix-paths">Paths the agent may change, one per line (its department's paths or a contract)</label>
<textarea id="fix-paths" rows="${Math.min(8, task.paths.length + 1)}" spellcheck="false">${esc(task.paths.join('\n'))}</textarea>
<label for="fix-acceptance">Acceptance, one statement per line</label>
<textarea id="fix-acceptance" rows="${Math.min(8, task.acceptance.length + 1)}">${esc(task.acceptance.join('\n'))}</textarea>
${deps ? `<fieldset><legend>Dependencies</legend>${deps}</fieldset>` : ''}
<label for="fix-reason">Reason (recorded in the history and on the swarm channel)</label>
<input id="fix-reason" maxlength="300" required>
<p class="pw-acts"><button type="submit">Save and retry</button> <span id="fix-msg" role="status"></span></p>
</form>`;
}

/** The amend request from the form's values; only fields that changed are sent. */
export function amendRequest(task, { paths, acceptance, drop = [], reason }) {
  const lines = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const body = { reason: String(reason ?? '').trim() };
  const p = lines(paths);
  const a = lines(acceptance);
  if (p.join('\n') !== task.paths.join('\n')) body.paths = p;
  if (a.join('\n') !== task.acceptance.join('\n')) body.acceptance = a;
  if (drop.length) body.dropDependsOn = drop;
  return body;
}
