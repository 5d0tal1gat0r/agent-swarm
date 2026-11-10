// M0 smoke: the three runtime pieces the swarm depends on work on this Node.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import Ajv from 'ajv';
import { parse } from 'yaml';

describe('runtime smoke', () => {
  it('node:sqlite opens an in-memory database and runs a query', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('ok');
    assert.equal(db.prepare('SELECT v FROM t').get().v, 'ok');
    db.close();
  });

  it('ajv compiles a schema and rejects bad input with a readable error', () => {
    const ajv = new Ajv({ allErrors: false });
    const validate = ajv.compile({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', pattern: '^T-[0-9]+$' } },
      additionalProperties: false,
    });
    assert.equal(validate({ id: 'T-1' }), true);
    assert.equal(validate({ id: 'x' }), false);
    assert.match(ajv.errorsText(validate.errors), /pattern/);
  });

  it('yaml parses a departments-style document', () => {
    const doc = parse('version: 1\ndepartments:\n  core:\n    paths: ["swarm/orchestrator/**"]\n');
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.departments.core.paths, ['swarm/orchestrator/**']);
  });
});
