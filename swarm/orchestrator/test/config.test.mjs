import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { checkDepartmentModels, loadDepartments, loadPolicy, parseDepartments, parsePolicy, validateModel } from '../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const realDepts = () => parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'));
const realPolicy = () => parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8'));

describe('config: real files', () => {
  it('loads departments.yaml and policy.yaml from the repo', () => {
    const d = loadDepartments(path.join(SWARM, 'departments.yaml'));
    const p = loadPolicy(path.join(SWARM, 'policy.yaml'));
    assert.deepEqual(Object.keys(d.departments).sort(), ['core', 'docs', 'platform', 'qa', 'runtime']);
    assert.equal(p.limits.leaseMinutes, 10);
    checkDepartmentModels(d, p);
  });
});

describe('config: departments', () => {
  it('stops start-up naming both departments when paths overlap', () => {
    const doc = realDepts();
    doc.departments.docs.paths.push('swarm/orchestrator/**');
    assert.throws(() => parseDepartments(doc), /paths overlap: core "swarm\/orchestrator\/\*\*" vs docs "swarm\/orchestrator\/\*\*"/);
  });

  it('keeps disjoint sibling files apart', () => {
    const doc = realDepts();
    doc.departments.docs.paths.push('*.md');
    assert.doesNotThrow(() => parseDepartments(doc));
  });

  it('rejects standby equal to host and unknown fields', () => {
    const doc = realDepts();
    doc.departments.qa.standby = doc.departments.qa.host;
    assert.throws(() => parseDepartments(doc), /standby and host are the same/);
    const doc2 = realDepts();
    doc2.departments.qa.extra = true;
    assert.throws(() => parseDepartments(doc2), /extra/);
  });

  it('rejects concurrency out of range and bad agent', () => {
    const doc = realDepts();
    doc.departments.core.concurrency = 99;
    assert.throws(() => parseDepartments(doc), /\/departments\/core\/concurrency/);
    const doc2 = realDepts();
    doc2.departments.core.agent = 'copilot';
    assert.throws(() => parseDepartments(doc2), /\/agent/);
  });

  it('rejects an absolute glob', () => {
    const doc = realDepts();
    doc.departments.docs.paths.push('/etc/**');
    assert.throws(() => parseDepartments(doc), /stay inside the repo/);
  });
});

describe('config: policy', () => {
  it('rejects a model id with a leading dash', () => {
    const p = realPolicy();
    p.models.claude.push('--dangerously-skip-permissions');
    assert.throws(() => parsePolicy(p), /\/models\/claude\/3/);
  });

  it('rejects a review model that is not on any allow-list', () => {
    const p = realPolicy();
    p.reviewModel.default = 'claude-unknown-1';
    assert.throws(() => parsePolicy(p), /reviewModel\.default claude-unknown-1 is not on the model allow-list/);
  });

  it('validateModel refuses unknown ids and non-strings', () => {
    const p = realPolicy();
    assert.equal(validateModel(p, 'claude', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
    assert.throws(() => validateModel(p, 'claude', 'claude-opus-9'), /not on the claude allow-list/);
    assert.throws(() => validateModel(p, 'claude', ['x']), /not a plain string/);
    assert.throws(() => validateModel(p, 'claude', '-x'), /not a plain string/);
  });

  it('an agent with no allowed models cannot own a department', () => {
    const d = realDepts();
    d.departments.qa.agent = 'gemini';
    const p = JSON.parse(JSON.stringify(realPolicy()));
    p.models.gemini = [];
    assert.throws(() => checkDepartmentModels(parseDepartments(d), p), /qa: agent gemini has no models/);
  });

  it('loads from a temporary file too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cfg-'));
    const file = path.join(dir, 'departments.yaml');
    fs.writeFileSync(file, 'version: 1\nrepo: o/r\ncontracts: []\ndepartments: {}\n');
    assert.throws(() => loadDepartments(file), /departments/);
  });
});

describe('department id length (channel names)', () => {
  const withId = (id) => {
    const d = realDepts();
    d.departments[id] = { ...d.departments.docs, paths: [`x-${id}/**`] };
    return d;
  };
  it('an id of 59 characters loads: dept-<id> is exactly 64', () => {
    const id = `a${'b'.repeat(58)}`;
    assert.equal(id.length, 59);
    assert.doesNotThrow(() => parseDepartments(withId(id)));
  });
  it('an id of 60 characters is refused by the schema', () => {
    const id = `a${'b'.repeat(59)}`;
    assert.throws(() => parseDepartments(withId(id)), /departments/);
  });
});
