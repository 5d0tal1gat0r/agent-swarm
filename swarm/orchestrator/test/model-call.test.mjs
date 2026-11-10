import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { commandModel } from '../src/model-call.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => ['node', path.join(FIX, name)];

describe('commandModel', () => {
  it('sends the prompt on stdin and appends --model <id>', async () => {
    const call = commandModel(fixture('echo-model.mjs'));
    const out = JSON.parse(await call({ model: 'claude-sonnet-5-5', prompt: 'REVIEW ME' }));
    assert.equal(out.in, 'REVIEW ME');
    assert.deepEqual(out.argv.slice(-2), ['--model', 'claude-sonnet-5-5']);
  });

  it('rejects an empty or non-array command', () => {
    assert.throws(() => commandModel([]), /non-empty argument array/);
    assert.throws(() => commandModel('node -e x'), /non-empty argument array/);
  });

  it('turns a non-zero exit into an error with the stderr tail', async () => {
    const call = commandModel(fixture('fail-model.mjs'));
    await assert.rejects(call({ model: 'm', prompt: '' }), /exit 4: .*model unavailable/);
  });

  it('kills and rejects a command that runs past the timeout', async () => {
    const call = commandModel(fixture('hang-model.mjs'), { timeoutMs: 200 });
    await assert.rejects(call({ model: 'm', prompt: '' }), /timed out/);
  });

  it('rejects a reply over the size cap', async () => {
    const call = commandModel(fixture('big-model.mjs'), { maxBytes: 1000 });
    await assert.rejects(call({ model: 'm', prompt: '' }), /too large/);
  });

  it('uses the injected spawn for every call (no real process in unit tests)', async () => {
    const seen = [];
    const spawnFn = (cmd, args) => {
      seen.push([cmd, args]);
      const child = new EventEmitter();
      child.stdin = { on() {}, end(p) { child.prompt = p; } };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => { child.stdout.emit('data', 'ok'); child.emit('close', 0); });
      return child;
    };
    assert.equal(await commandModel(['fake', '--flag'], { spawnFn })({ model: 'm1', prompt: 'p' }), 'ok');
    assert.deepEqual(seen[0], ['fake', ['--flag', '--model', 'm1']]);
  });
});
