// swarmctl against stub systemctl, npm, curl and journalctl in a throwaway HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SWARM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(SWARM, 'scripts', 'swarmctl');

function sandbox({ curlOk = true, script = SCRIPT } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmctl-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(home, 'calls.log');
  const stub = (name, body = '') => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  const flag = path.join(home, '.swarm', 'dashboard-maintenance.json');
  const seen = `[[ -f "${flag}" ]] && echo "  flag on during: $*" >> "${log}"`;
  stub('systemctl', `${seen}\n` + '[[ "$2" == is-active ]] && { echo "${STUB_UNIT_STATE:-active}"; [[ "${STUB_UNIT_STATE:-active}" == active ]]; exit; }; exit 0');
  // STUB_NPM_FAIL=all fails every `npm ci`; =first fails only the first one.
  stub('npm', `${seen}
[[ "$1" == ci ]] || exit 0
n="${home}/npm-count"; c=$(( $(cat "$n" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$n"
[[ "\${STUB_NPM_FAIL:-}" == all || ( "\${STUB_NPM_FAIL:-}" == first && "$c" == 1 ) ]] && exit 1
exit 0`);
  stub('journalctl');
  stub('curl', curlOk ? 'exit 0' : 'exit 7');
  stub('tailscale', 'echo 192.0.2.7');
  const runEnv = (extra, ...args) => spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...extra },
  });
  const run = (...args) => runEnv({}, ...args);
  const installUnit = (name) => {
    fs.mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/systemd/user', name), '');
  };
  const installManagerUnit = () => installUnit('swarm-manager.service');
  const installDashboardUnit = () => installUnit('swarm-dashboard.service');
  const readFlag = () => (fs.existsSync(flag) ? JSON.parse(fs.readFileSync(flag, 'utf8')) : null);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { home, run, runEnv, calls, installManagerUnit, installDashboardUnit, readFlag, flag };
}

describe('swarmctl', () => {
  it('is executable and prints help', () => {
    assert.ok(fs.statSync(SCRIPT).mode & 0o100, 'executable bit');
    const r = sandbox().run('help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /upgrade/);
  });

  it('install orchestrator copies the units and writes the env template mode 0600, without starting', () => {
    const s = sandbox();
    const r = s.run('install', 'orchestrator');
    assert.equal(r.status, 0, r.stderr);
    const units = path.join(s.home, '.config/systemd/user');
    for (const u of ['swarm-orchestrator.service', 'swarm-backup.service', 'swarm-backup.timer']) assert.ok(fs.existsSync(path.join(units, u)), u);
    const unit = fs.readFileSync(path.join(units, 'swarm-orchestrator.service'), 'utf8');
    assert.match(unit, new RegExp(`^WorkingDirectory=${path.dirname(SWARM).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/swarm$`, 'm'), 'units point at this checkout');
    assert.doesNotMatch(unit, /swarm-app\/repo/);
    const env = path.join(s.home, '.config/swarm/orchestrator.env');
    assert.equal(fs.statSync(env).mode & 0o777, 0o600);
    assert.ok(s.calls().includes('systemctl --user daemon-reload'));
    assert.ok(!s.calls().some((c) => / (start|enable|restart) /.test(c)), 'nothing started');
  });

  it('start, restart and stop act on the installed units only', () => {
    const s = sandbox();
    s.run('install', 'manager');
    assert.equal(s.run('start').status, 0);
    assert.equal(s.run('reboot').status, 0);
    assert.equal(s.run('stop', 'manager').status, 0);
    const acts = s.calls().filter((c) => /systemctl --user (enable|restart|stop)/.test(c));
    assert.deepEqual(acts, [
      'systemctl --user enable --now swarm-manager.service',
      'systemctl --user restart swarm-manager.service',
      'systemctl --user stop swarm-manager.service',
    ]);
  });

  it('start with nothing installed fails with a hint; an unknown target fails', () => {
    const s = sandbox();
    assert.match(s.run('start').stderr, /swarmctl install/);
    assert.notEqual(s.run('start', 'nope').status, 0);
  });

  it('health exits 1 when an endpoint is down, and status still prints', () => {
    const s = sandbox({ curlOk: false });
    const h = s.run('health');
    assert.equal(h.status, 1);
    assert.match(h.stdout, /FAIL orchestrator/);
    const st = s.run('status');
    assert.equal(st.status, 0);
    assert.match(st.stdout, /orchestrator .* DOWN/);
  });

  it('never sources the token line from the env file', () => {
    const s = sandbox();
    s.run('install', 'orchestrator');
    const env = path.join(s.home, '.config/swarm/orchestrator.env');
    fs.appendFileSync(env, 'GH_TOKEN=$(touch "$HOME/pwned")\nSWARM_PORT=4000\n');
    const r = s.run('health');
    assert.match(r.stdout, /ok   orchestrator/);
    assert.ok(!fs.existsSync(path.join(s.home, 'pwned')));
    assert.ok(s.calls().some((c) => c.includes(':4000/health')), 'reads SWARM_PORT');
  });

  it('install orchestrator writes this machine\'s Tailscale address and a PATH line', () => {
    const s = sandbox();
    s.run('install', 'orchestrator');
    const env = fs.readFileSync(path.join(s.home, '.config/swarm/orchestrator.env'), 'utf8');
    assert.match(env, /^SWARM_HOST=192\.0\.2\.7$/m);
    assert.match(env, /^PATH=.*\/usr\/bin/m);
    assert.equal((env.match(/^SWARM_HOST=/gm) ?? []).length, 1);
  });

  it('export then import moves the DB, tokens and token line, with the new host', () => {
    const a = sandbox();
    a.run('install', 'orchestrator');
    fs.mkdirSync(path.join(a.home, '.swarm'), { recursive: true });
    const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e',
      `const { openStore } = await import(${JSON.stringify(path.join(SWARM, 'orchestrator/src/store.mjs'))});
       const s = openStore({ path: ${JSON.stringify(path.join(a.home, '.swarm/swarm.db'))} });
       s.createEpic({ id: 'E-0001', repo: 'o/r', title: 'moved', body: 'b' }); s.close();`], { encoding: 'utf8', input: '' , env: { ...process.env } });
    assert.equal(seed.status, 0, seed.stderr);
    fs.writeFileSync(path.join(a.home, '.swarm/managers.json'), '{"managers":{}}\n', { mode: 0o600 });
    fs.appendFileSync(path.join(a.home, '.config/swarm/orchestrator.env'), 'GH_TOKEN=github_pat_test\n');
    const bundle = path.join(a.home, 'move.tgz');
    const ex = a.run('export', bundle);
    assert.equal(ex.status, 0, ex.stderr);
    assert.equal(fs.statSync(bundle).mode & 0o777, 0o600);
    assert.notEqual(a.run('export', bundle).status, 0, 'never overwrites');

    const b = sandbox();
    const im = b.run('import', bundle);
    assert.equal(im.status, 0, im.stderr);
    assert.ok(fs.existsSync(path.join(b.home, '.swarm/swarm.db')));
    assert.ok(fs.existsSync(path.join(b.home, '.swarm/managers.json')));
    const env = fs.readFileSync(path.join(b.home, '.config/swarm/orchestrator.env'), 'utf8');
    assert.match(env, /^GH_TOKEN=github_pat_test$/m);
    assert.match(env, /^SWARM_HOST=192\.0\.2\.7$/m);
    assert.notEqual(b.run('import', bundle).status, 0, 'refuses to overwrite an existing DB');
  });

  // A throwaway git repo (origin + clone) holding a copy of the script, at v1 with v2 on origin.
  function gitRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmctl-git-'));
    const git = (cwd, ...a) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    fs.mkdirSync(path.join(work, 'swarm/scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(work, 'swarm/scripts/swarmctl'));
    fs.writeFileSync(path.join(work, 'v'), '1');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'v1'); git(work, 'push', '-q', 'origin', 'HEAD:main');
    const v1 = git(work, 'rev-parse', 'HEAD');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', origin, clone);
    fs.writeFileSync(path.join(work, 'v'), '2');
    git(work, 'commit', '-qam', 'v2'); git(work, 'push', '-q', 'origin', 'HEAD:main');
    return { git, clone, v1, v2: git(work, 'rev-parse', 'HEAD'), script: path.join(clone, 'swarm/scripts/swarmctl') };
  }

  it('upgrade with a failing npm ci ends on the old sha and exits non-zero', () => {
    const g = gitRepo();
    const s = sandbox({ script: g.script });
    s.installManagerUnit();
    const r = s.runEnv({ STUB_NPM_FAIL: 'first' }, 'upgrade');
    assert.notEqual(r.status, 0);
    assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v1);
    assert.equal(s.calls().filter((c) => c === 'npm ci --ignore-scripts --silent').length, 2, 'npm ci for new, then for old');
  });

  it('upgrade rolls back when the manager is not active afterwards', () => {
    const g = gitRepo();
    const s = sandbox({ script: g.script });
    s.installManagerUnit();
    const r = s.runEnv({ STUB_UNIT_STATE: 'failed' }, 'upgrade');
    assert.notEqual(r.status, 0);
    assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v1);
  });

  it('upgrade succeeds onto the new sha when all is well', () => {
    const g = gitRepo();
    const s = sandbox({ script: g.script });
    s.installManagerUnit();
    const r = s.run('upgrade');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v2);
  });

  describe('autodeploy (ARCHITECTURE 76)', () => {
    it('upgrades when origin/main moved, then stays quiet', () => {
      const g = gitRepo();
      const s = sandbox({ script: g.script });
      s.installManagerUnit();
      const r = s.run('autodeploy');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v2);
      const npmRuns = s.calls().filter((c) => c === 'npm ci --ignore-scripts --silent').length;
      const again = s.run('autodeploy');
      assert.equal(again.status, 0, again.stderr);
      assert.equal(again.stdout, '', 'nothing to say when main has not moved');
      assert.equal(s.calls().filter((c) => c === 'npm ci --ignore-scripts --silent').length, npmRuns, 'no second npm ci');
    });

    it('a failed sha is recorded and skipped until main moves', () => {
      const g = gitRepo();
      const s = sandbox({ script: g.script });
      s.installManagerUnit();
      const r = s.runEnv({ STUB_NPM_FAIL: 'first' }, 'autodeploy');
      assert.notEqual(r.status, 0);
      assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v1, 'rolled back');
      assert.equal(fs.readFileSync(path.join(s.home, '.swarm/autodeploy-failed'), 'utf8').trim(), g.v2);
      const npmRuns = s.calls().filter((c) => c.startsWith('npm ci')).length;
      const skip = s.run('autodeploy');
      assert.equal(skip.status, 0, skip.stderr);
      assert.match(skip.stdout, /skip .*failed before/);
      assert.equal(s.calls().filter((c) => c.startsWith('npm ci')).length, npmRuns, 'no retry of the failed sha');
      fs.rmSync(path.join(s.home, '.swarm/autodeploy-failed'));
      assert.equal(s.run('autodeploy').status, 0);
      assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v2, 'retried once the marker is gone');
      assert.ok(!fs.existsSync(path.join(s.home, '.swarm/autodeploy-failed')), 'marker cleared on success');
    });
  });

  it('install autodeploy copies the timer and service with a PATH line, without starting', () => {
    const s = sandbox();
    const r = s.run('install', 'autodeploy');
    assert.equal(r.status, 0, r.stderr);
    const units = path.join(s.home, '.config/systemd/user');
    assert.ok(fs.existsSync(path.join(units, 'swarm-autodeploy.timer')));
    const unit = fs.readFileSync(path.join(units, 'swarm-autodeploy.service'), 'utf8');
    assert.match(unit, /^ExecStart=\/.*\/swarm\/scripts\/swarmctl autodeploy$/m);
    assert.doesNotMatch(unit, /swarm-app\/repo/, 'points at this checkout');
    assert.match(fs.readFileSync(path.join(s.home, '.config/swarm/autodeploy.env'), 'utf8'), /^PATH=.*\/usr\/bin/m);
    assert.ok(!s.calls().some((c) => / (start|enable|restart) /.test(c)), 'nothing started');
  });

  it('rollback with a failing npm ci never stops the services and restores the old sha', () => {
    const g = gitRepo();
    const s = sandbox({ script: g.script });
    s.installManagerUnit();
    const r = s.runEnv({ STUB_NPM_FAIL: 'first' }, 'rollback', g.v2);
    assert.notEqual(r.status, 0);
    assert.ok(!s.calls().some((c) => c.startsWith('systemctl --user stop')), 'no stop');
    assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v1);
  });

  it('rollback works, refuses a dirty tree and an option-like sha', () => {
    const g = gitRepo();
    const s = sandbox({ script: g.script });
    s.installManagerUnit();
    assert.notEqual(s.run('rollback', '--force').status, 0);
    fs.writeFileSync(path.join(g.clone, 'v'), 'dirty');
    assert.match(s.run('rollback', g.v2).stderr, /local changes/);
    g.git(g.clone, 'checkout', '--', 'v');
    g.git(g.clone, 'fetch', '-q', 'origin');
    assert.equal(s.run('rollback', g.v2).status, 0);
    assert.equal(g.git(g.clone, 'rev-parse', 'HEAD'), g.v2);
    assert.ok(s.calls().includes('systemctl --user stop swarm-manager.service'));
  });

  it('backup leaves ~/.swarm and the backups dir at mode 700 and the file private', () => {
    const s = sandbox();
    // swarm.db does not exist, so the real backup command fails; the dirs are made first.
    s.run('backup');
    assert.equal(fs.statSync(path.join(s.home, '.swarm')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(s.home, '.swarm/backups')).mode & 0o777, 0o700);
  });

  it('install dashboard copies the unit and a private env file, without starting', () => {
    const s = sandbox();
    const r = s.run('install', 'dashboard');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(s.home, '.config/systemd/user/swarm-dashboard.service')));
    assert.equal(fs.statSync(path.join(s.home, '.config/swarm/dashboard.env')).mode & 0o777, 0o600);
    assert.ok(!s.calls().some((c) => / (start|enable|restart) /.test(c)), 'nothing started');
    assert.match(r.stdout, /dashboard\.token/);
  });

  it('install manager writes a PATH line for the service', () => {
    const s = sandbox();
    assert.equal(s.run('install', 'manager').status, 0);
    const env = fs.readFileSync(path.join(s.home, '.config/swarm/manager.env'), 'utf8');
    assert.match(env, /^PATH=.*\/usr\/bin/m);
    assert.match(fs.readFileSync(path.join(s.home, '.config/systemd/user/swarm-manager.service'), 'utf8'), /EnvironmentFile=-%h\/\.config\/swarm\/manager\.env/);
  });

  describe('maintenance (ARCHITECTURE 77)', () => {
    it('maintenance on/status/off by hand', () => {
      const s = sandbox();
      const on = s.run('maintenance', 'on', 'moving the server "disk"');
      assert.equal(on.status, 0, on.stderr);
      const f = s.readFlag();
      assert.equal(f.reason, 'moving the server "disk"');
      assert.equal(f.auto, false);
      assert.ok(Date.parse(f.since));
      assert.equal(fs.statSync(s.flag).mode & 0o777, 0o600);
      assert.match(s.run('maintenance', 'status').stdout, /on since .*: moving the server "disk"/);
      assert.equal(s.run('maintenance', 'off').status, 0);
      assert.equal(s.readFlag(), null);
      assert.match(s.run('maintenance', 'status').stdout, /^off/m);
      assert.equal(s.run('maintenance', 'off').status, 0, 'off when already off is fine');
      assert.notEqual(s.run('maintenance', 'sideways').status, 0);
      assert.equal(s.run('maintenance', 'on').status, 0, 'a reason is optional');
      assert.equal(s.readFlag().reason, 'maintenance');
    });

    it('upgrade with the dashboard installed turns maintenance on while it works and off after', () => {
      const g = gitRepo();
      const s = sandbox({ script: g.script });
      s.installDashboardUnit();
      const r = s.run('upgrade');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(s.calls().some((c) => /flag on during: ci /.test(c)), 'on during npm ci');
      assert.ok(s.calls().some((c) => /flag on during: --user restart .*swarm-dashboard/.test(c)), 'on during the restart');
      assert.equal(s.readFlag(), null, 'off after the health check');
    });

    it('a failed upgrade leaves maintenance on with the error', () => {
      const g = gitRepo();
      const s = sandbox({ script: g.script });
      s.installDashboardUnit();
      const r = s.runEnv({ STUB_NPM_FAIL: 'first' }, 'upgrade');
      assert.notEqual(r.status, 0);
      assert.match(s.readFlag().reason, /^upgrade to [0-9a-f]{7} failed/);
    });

    it('upgrade without a dashboard here never writes the flag', () => {
      const g = gitRepo();
      const s = sandbox({ script: g.script });
      s.installManagerUnit();
      assert.equal(s.run('upgrade').status, 0);
      assert.ok(!s.calls().some((c) => /flag on during/.test(c)));
      assert.equal(s.readFlag(), null);
    });

    it('upgrade and restart leave a flag set by hand alone', () => {
      const g = gitRepo();
      const s = sandbox({ script: g.script });
      s.installDashboardUnit();
      s.run('maintenance', 'on', 'by hand');
      assert.equal(s.run('upgrade').status, 0);
      assert.equal(s.readFlag().reason, 'by hand');
      assert.equal(s.run('restart', 'dashboard').status, 0);
      assert.equal(s.readFlag().reason, 'by hand');
    });

    it('restart of the dashboard turns maintenance on around it; other targets do not', () => {
      const s = sandbox();
      s.installDashboardUnit();
      s.installManagerUnit();
      assert.equal(s.run('restart', 'manager').status, 0);
      assert.ok(!s.calls().some((c) => /flag on during/.test(c)));
      assert.equal(s.run('restart', 'dashboard').status, 0);
      assert.ok(s.calls().some((c) => /flag on during: --user restart swarm-dashboard/.test(c)));
      assert.equal(s.readFlag(), null);
    });
  });
});

