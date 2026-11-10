import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('CI security checks', () => {
  it('limits the workflow token to read-only repository contents', () => {
    assert.match(WORKFLOW, /permissions:\n\s+contents: read/);
  });

  it('runs a pinned tree-only Gitleaks scan in the required check', () => {
    assert.match(WORKFLOW, /zricethezav\/gitleaks:v8\.30\.1/);
    assert.match(WORKFLOW, /detect --source=\/repo --no-git --no-banner --redact/);
    assert.match(WORKFLOW, /Gitleaks secret scan/);
  });

  it('audits swarm dependencies at high severity', () => {
    assert.match(WORKFLOW, /name: Swarm dependency audit[\s\S]*?npm audit --audit-level=high/);
  });
});
