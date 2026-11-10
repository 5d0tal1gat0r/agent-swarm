// Static checks on the deploy files: required directives, no secrets, every path the units run exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(HERE, '..');
const SWARM = path.resolve(DEPLOY, '..');
const read = (...p) => fs.readFileSync(path.join(DEPLOY, ...p), 'utf8');
const SECRET = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|BEGIN [A-Z ]*PRIVATE KEY|^GH_TOKEN=\S+/m;

describe('deploy units', () => {
  it('the orchestrator unit reads its env file, binds the Tailscale address and runs the review command', () => {
    const u = read('swarm-orchestrator.service');
    assert.match(u, /^EnvironmentFile=%h\/\.config\/swarm\/orchestrator\.env$/m);
    assert.match(u, /--host \$\{SWARM_HOST\} --port \$\{SWARM_PORT\}/);
    assert.match(u, /--review-cmd "claude -p --output-format text"/);
    assert.match(u, /ProtectSystem=strict/);
    assert.match(u, /NoNewPrivileges=yes/);
  });

  it('the server auto-deploy runs swarmctl autodeploy every 5 minutes', () => {
    assert.match(read('server/swarm-autodeploy.timer'), /OnUnitActiveSec=5min/);
    assert.match(read('server/swarm-autodeploy.timer'), /^WantedBy=timers\.target$/m);
    assert.match(read('server/swarm-autodeploy.service'), /^ExecStart=%h\/swarm-app\/repo\/swarm\/scripts\/swarmctl autodeploy$/m);
  });

  it('each ExecStart script path exists in the repo', () => {
    for (const f of ['swarm-orchestrator.service', 'swarm-manager.service', 'swarm-backup.service', 'server/swarm-watchdog.service', 'server/swarm-dashboard.service', 'server/swarm-autodeploy.service']) {
      const exec = read(f).split('\n').find((l) => l.startsWith('ExecStart='));
      const script = /((orchestrator|manager|dashboard)\/bin\/[a-z]+\.mjs|scripts\/[a-z]+(\.mjs)?)/.exec(exec)?.[0];
      assert.ok(script, `${f} runs a bin script`);
      assert.ok(fs.existsSync(path.join(SWARM, script)), `${script} exists`);
    }
  });

  it('the backup timer runs nightly and catches up after downtime', () => {
    const t = read('swarm-backup.timer');
    assert.match(t, /OnCalendar=\*-\*-\* 03:17:00/);
    assert.match(t, /Persistent=true/);
    assert.match(read('swarm-backup.service'), /scripts\/swarmctl backup --nightly/);
  });

  it('the server watchdog runs every 2 minutes and follows the bus location by default', () => {
    assert.match(read('server/swarm-watchdog.timer'), /OnUnitActiveSec=2min/);
    assert.match(read('server/swarm-watchdog.service'), /^EnvironmentFile=%h\/\.config\/swarm\/watchdog\.env$/m);
    assert.match(read('env/watchdog.env.example'), /^SWARM_ORCH_URL=bus$/m);
  });

  it('every unit has a Description and an install section', () => {
    for (const f of ['swarm-orchestrator.service', 'swarm-manager.service', 'swarm-backup.service', 'swarm-backup.timer']) {
      assert.match(read(f), /^Description=/m, f);
    }
    assert.match(read('swarm-orchestrator.service'), /^\[Install\]$/m);
    assert.match(read('swarm-backup.timer'), /^WantedBy=timers\.target$/m);
  });

  it('no secrets in any deploy file, and the token line is a comment in the template', () => {
    for (const f of ['swarm-orchestrator.service', 'swarm-manager.service', 'swarm-backup.service', 'swarm-backup.timer', 'server/swarm-watchdog.service', 'server/swarm-watchdog.timer', 'env/orchestrator.env.example', 'env/manager.env.example', 'env/watchdog.env.example', 'server/swarm-dashboard.service', 'env/dashboard.env.example', 'server/swarm-autodeploy.service', 'server/swarm-autodeploy.timer']) {
      assert.doesNotMatch(read(f), SECRET, f);
    }
    assert.match(read('env/orchestrator.env.example'), /^# GH_TOKEN=$/m);
  });
});
