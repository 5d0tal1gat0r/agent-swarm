// Crash-safe manager journal for checkpointed dashboard interventions. The
// orchestrator cursor is only an optimization; this file is the local proof
// that a directive was delivered or applied.
import fs from 'node:fs';
import path from 'node:path';

function atomicWrite(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(rows), { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

export function createDirectiveJournal({ file, manager, client, clock = { now: () => Date.now() } }) {
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) rows = [];
  } catch { rows = []; }
  let polling = null;
  const controls = new Map();
  const persist = () => atomicWrite(file, rows);
  persist();

  const acknowledgement = (row) => {
    if (row.localStatus === 'applied') return { status: 'applied', result: row.result, replacementSessionId: row.replacementSessionId };
    if (row.localStatus === 'failed') return { status: 'failed', result: row.result };
    return { status: 'delivered' };
  };

  const pollOnce = async () => {
    const incoming = await client.directives(manager);
    for (const directive of incoming) {
      let row = rows.find((item) => item.directive.id === directive.id);
      if (!row) {
        row = { directive, localStatus: 'delivered', result: null, replacementSessionId: null, updatedAt: new Date(clock.now()).toISOString() };
        rows.push(row);
        persist(); // durable before the delivered acknowledgement
      }
      await client.ackDirective(manager, directive.id, acknowledgement(row));
      if (row.localStatus === 'delivered' && ['interrupt', 'stop'].includes(directive.kind)) {
        const control = controls.get(directive.taskId);
        if (directive.kind === 'interrupt') control?.interrupt?.();
        else control?.stop?.();
      }
      if (['applied', 'failed'].includes(row.localStatus)) {
        rows = rows.filter((item) => item.directive.id !== directive.id);
        persist();
      }
    }
    return incoming;
  };

  const poll = () => {
    if (polling) return polling;
    polling = pollOnce().finally(() => { polling = null; });
    return polling;
  };
  const pendingFor = ({ taskId, assignmentId }) => rows
    .filter((row) => row.localStatus === 'delivered'
      && (taskId === undefined || row.directive.taskId === taskId)
      && (assignmentId === undefined || row.directive.target === assignmentId))
    .map((row) => structuredClone(row.directive));

  const resolve = async (id, localStatus, { result = null, replacementSessionId = null } = {}) => {
    const row = rows.find((item) => item.directive.id === id);
    if (!row) throw new Error(`unknown local directive ${id}`);
    row.localStatus = localStatus;
    row.result = result;
    row.replacementSessionId = replacementSessionId;
    row.updatedAt = new Date(clock.now()).toISOString();
    persist();
    await client.ackDirective(manager, id, acknowledgement(row));
    rows = rows.filter((item) => item.directive.id !== id);
    persist();
    return { id, status: localStatus, result, replacementSessionId };
  };

  return {
    poll,
    pendingFor,
    markApplied: (id, details) => resolve(id, 'applied', details),
    markFailed: (id, details) => resolve(id, 'failed', details),
    register(taskId, control) {
      controls.set(taskId, control);
      return () => { if (controls.get(taskId) === control) controls.delete(taskId); };
    },
  };
}
