import { describeAction, renderTokens } from '/render.mjs';

const $ = (id) => document.getElementById(id);
let pendingAction = null;
let departments = [];

async function api(path, body) {
  const init = { cache: 'no-store', credentials: 'same-origin' };
  if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await fetch(path, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function showAccess(message, link = '/') {
  $('admin-access').innerHTML = `<h1>Administration</h1><p class="mut">${message}</p><a href="${link}">Return to the control room</a>`;
}

async function loadTokens() {
  const r = await api('/api/operator/tokens');
  if (r.status !== 200) {
    $('admin-result').className = 'down';
    $('admin-result').textContent = r.body.error ?? `Could not load tokens (${r.status}).`;
    return;
  }
  const once = $('token-once')?.innerHTML;
  $('tokens').innerHTML = renderTokens(r.body.tokens, departments);
  if (once) { $('token-once').innerHTML = once; $('token-once').hidden = false; }
}

async function start() {
  const r = await api('/api/snapshot');
  if (r.status === 401) return showAccess('Sign in from the control room to open administration.');
  if (r.status !== 200 || !(r.body.viewerRoles ?? []).includes('owner')) return showAccess('This page is restricted to swarm owners.');
  $('admin-access').hidden = true;
  $('admin').hidden = false;
  $('viewer').textContent = `signed in as ${r.body.viewer}`;
  $('logout').hidden = false;
  departments = r.body.snapshot?.departments ?? [];
  await loadTokens();
}

$('logout').addEventListener('click', async () => {
  await api('/api/logout', {});
  window.location.href = '/';
});

$('tokens').addEventListener('submit', async (e) => {
  if (e.target.id !== 'token-form') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { name: String(f.get('name')).trim(), member: String(f.get('member')).trim(), role: f.get('role'), departments: f.getAll('departments'), reason: String(f.get('reason')).trim() };
  const r = await api('/api/operator/tokens', body);
  await loadTokens();
  const box = $('token-once');
  box.hidden = false;
  if (r.status === 201) {
    $('admin-result').className = 'ok';
    $('admin-result').textContent = `Created ${r.body.name}. Copy the token below now; it will not be shown again.`;
    box.replaceChildren(document.createTextNode('Token'), Object.assign(document.createElement('code'), { textContent: r.body.token }));
  } else {
    $('admin-result').className = 'down';
    $('admin-result').textContent = `Refused (${r.status}): ${r.body.error ?? 'unknown error'}`;
  }
});

const dialog = $('confirm');
document.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action^="tokens/"]');
  if (!button) return;
  e.stopPropagation();
  pendingAction = button.dataset.action;
  $('confirm-what').textContent = describeAction(pendingAction);
  $('confirm-reason').value = '';
  $('confirm-ok').disabled = true;
  dialog.showModal();
  $('confirm-reason').focus();
});
$('confirm-reason').addEventListener('input', (e) => { $('confirm-ok').disabled = e.target.value.trim().length < 3; });
$('confirm-cancel').addEventListener('click', () => { pendingAction = null; dialog.close(); });
$('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const path = pendingAction;
  const reason = $('confirm-reason').value.trim();
  if (!path || reason.length < 3) return;
  pendingAction = null;
  dialog.close();
  const r = await api(`/api/operator/${path}`, { reason });
  $('admin-result').className = r.status === 200 ? 'ok' : 'down';
  $('admin-result').textContent = r.status === 200 ? `Revoked ${path.split('/')[1]}.` : `Refused (${r.status}): ${r.body.error ?? 'unknown error'}`;
  if (r.status === 200) await loadTokens();
});

start().catch(() => showAccess('Administration is unavailable. Return to the control room and try again.'));
