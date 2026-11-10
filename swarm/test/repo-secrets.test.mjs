// Tracked-file secret check: no file in the repo may look like a secret,
// by name or by content. PR diffs are checked separately by the machine gate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { SECRET_PATTERNS } from '../orchestrator/src/gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BYTES = 1024 * 1024;

// The machine gate's patterns (one source) plus other common key formats.
const EXTRA = [/gh[ousr]_[A-Za-z0-9]{30,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/];
export const SECRET_CONTENT = new RegExp([...SECRET_PATTERNS.map(([, re]) => re), ...EXTRA].map((re) => re.source).join('|'), 'm');
// .env.example is the one allowed env file; *.pub keys are public.
export const SECRET_NAME = /(^|\/)\.env(\.(?!example$)[^/]+)?$|\.(pem|key|p12|pfx|token|db|sqlite3?)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/;

// Private infrastructure patterns. Tailscale addresses (the 100.64/10 CGNAT range) are always checked.
// Names that are private to your deployment (people, host names, home paths) never belong in
// the repo, not even as test patterns: list them one regex per line in an untracked file named
// by SWARM_PRIVATE_PATTERNS (default ~/.swarm/private-patterns.txt) and this check uses them too.
const TAILSCALE_IP = new RegExp(`\\b${'100'}\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.[0-9]{1,3}\\.[0-9]{1,3}\\b`);

export function loadPrivatePatterns(file = process.env.SWARM_PRIVATE_PATTERNS ?? path.join(os.homedir(), '.swarm', 'private-patterns.txt')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new RegExp(l, 'i'));
}

const PRIVATE_PATTERNS = [TAILSCALE_IP, ...loadPrivatePatterns()];

export function findPrivateDetails(files, read, patterns = PRIVATE_PATTERNS) {
  const hits = [];
  for (const file of files) {
    const text = read(file);
    if (text !== null && patterns.some((pattern) => pattern.test(text))) {
      hits.push(`${file}: private infrastructure or identity detail`);
    }
  }
  return hits;
}

export function findSecrets(files, read) {
  const hits = [];
  for (const file of files) {
    if (SECRET_NAME.test(file)) hits.push(`${file}: secret-like file name`);
    const text = read(file);
    if (text !== null && SECRET_CONTENT.test(text)) hits.push(`${file}: secret-like content`);
  }
  return hits;
}

function readTracked(file) {
  const full = path.join(ROOT, file);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(full);
    return buf.includes(0) ? null : buf.toString('utf8'); // skip binaries
  } catch {
    return null; // deleted in the working tree
  }
}

describe('repo secret check', () => {
  // Fake secrets are assembled at run time so this file never matches itself.
  const fake = { gh: 'ghp' + '_' + 'a'.repeat(36), key: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----' };

  it('flags secret-like names and contents, and allows .env.example and public keys', () => {
    const files = { '.env': '', 'a/.env.local': '', '.env.example': 'X=1', 'k/id_ed25519': '', 'k/id_ed25519.pub': 'ssh-ed25519 AAAA',
      'x/state.db': '', 'notes.md': `token ${fake.gh}`, 'deploy/key.txt': fake.key, 'ok.md': 'GH_TOKEN is set in the env file' };
    const hits = findSecrets(Object.keys(files), (f) => files[f]);
    assert.deepEqual(hits.sort(), [
      '.env: secret-like file name',
      'a/.env.local: secret-like file name',
      'deploy/key.txt: secret-like content',
      'k/id_ed25519: secret-like file name',
      'notes.md: secret-like content',
      'x/state.db: secret-like file name',
    ]);
  });

  it('no tracked file in the repo looks like a secret', () => {
    const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.ok(files.length > 50, 'git ls-files listed the repo');
    assert.deepEqual(findSecrets(files, readTracked), []);
  });

  it('no tracked file exposes private infrastructure or personal identities', () => {
    const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.deepEqual(findPrivateDetails(files, readTracked), []);
  });

  it('flags Tailscale addresses and the deployment private patterns', () => {
    const tailnetIp = ['100', '64', '0', '1'].join('.');
    const files = {
      'docs/example.md': `server ${tailnetIp}`,
      'config/path.env': 'HOME=/home/example-user/.swarm',
      'notes.md': 'deployed on example-host',
      'ok.md': 'documentation address 192.0.2.1 and 100.200.1.1 (outside the Tailscale range)',
    };
    const patterns = [TAILSCALE_IP, /\/home\/example-user/i, /example-host/i];
    assert.deepEqual(findPrivateDetails(Object.keys(files), (file) => files[file], patterns).sort(),
      ['config/path.env', 'docs/example.md', 'notes.md'].map((file) => `${file}: private infrastructure or identity detail`));
  });

  it('loadPrivatePatterns reads one regex per line and skips comments; a missing file is fine', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-patterns-'));
    const file = path.join(dir, 'p.txt');
    fs.writeFileSync(file, '# people\nexample-user\n\nexample-host\n');
    assert.deepEqual(loadPrivatePatterns(file).map((re) => re.source), ['example-user', 'example-host']);
    assert.deepEqual(loadPrivatePatterns(path.join(dir, 'missing.txt')), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
