// Agent liveness lease (lib/lease.js): expiry, harness pid, several sessions, and the CLI refreshing
// it on every command (watch/wait keep refreshing; see the daemon test for what peers see).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-lease-test-'));
process.env.AIM_HOME = tmpHome;
const { LEASE_CLI_PID_TTL_MS, LEASE_TTL_MS, harnessPid, leaseFile, leaseState, refreshLease } = await import('../lib/lease.js');

const aim = new URL('../bin/aim.js', import.meta.url).pathname;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aim-lease-'));
const T0 = 1_800_000_000_000;

test('harness pid: AIM_HARNESS_PID, then CLAUDE_PID', () => {
  assert.equal(harnessPid({}), null);
  assert.equal(harnessPid({ CLAUDE_PID: '95' }), 95);
  assert.equal(harnessPid({ AIM_HARNESS_PID: '12', CLAUDE_PID: '95' }), 12);
  assert.equal(harnessPid({ CLAUDE_PID: 'x' }), null);
  assert.equal(harnessPid({ CLAUDE_PID: '1' }), null, 'init is never a harness');
});

test('no lease is unknown; a lease expires after its ttl', () => {
  const home = fresh();
  assert.deepEqual(leaseState({ home, now: T0 }), { agent: 'unknown', leaseAgeMs: null, sessions: 0 });
  refreshLease({ kind: 'watch', home, now: T0, env: { CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.equal(leaseState({ home, now: T0 + 1000 }).agent, 'alive');
  assert.equal(leaseState({ home, now: T0 + LEASE_TTL_MS - 1 }).agent, 'alive');
  const late = leaseState({ home, now: T0 + LEASE_TTL_MS });
  assert.equal(late.agent, 'gone');
  assert.equal(late.leaseAgeMs, LEASE_TTL_MS);
  // Refreshed again (harness restarted): alive.
  refreshLease({ kind: 'cli', home, now: T0 + 10 * 60_000, env: { CLAUDE_CODE_SESSION_ID: 's2' } });
  assert.equal(leaseState({ home, now: T0 + 10 * 60_000 + 5000 }).agent, 'alive');
  assert.equal(leaseState({ home, now: T0 + 10 * 60_000 + 5000 }).leaseAgeMs, 5000);
});

test('a known harness pid: gone as soon as it exits, whatever the ttl; a longer ttl for CLI calls while it runs', () => {
  const home = fresh();
  const env = { CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PID: String(process.pid) };
  const e = refreshLease({ kind: 'cli', home, now: T0, env });
  assert.equal(e.pid, process.pid);
  assert.equal(e.ttlMs, LEASE_CLI_PID_TTL_MS);
  const running = () => true;
  const dead = () => false;
  assert.equal(leaseState({ home, now: T0 + 10 * 60_000, isAlive: running }).agent, 'alive');
  assert.equal(leaseState({ home, now: T0 + 1000, isAlive: dead }).agent, 'gone');
  // A stale pid variable (the process is not running) is not recorded, so it can't mark us gone.
  const home2 = fresh();
  const e2 = refreshLease({ kind: 'cli', home: home2, now: T0, env: { CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PID: '2147483646' } });
  assert.equal(e2.pid, null);
  assert.equal(e2.ttlMs, LEASE_TTL_MS);
});

test('a CLI call does not shorten a watcher lease; any live session keeps the agent alive', () => {
  const home = fresh();
  refreshLease({ kind: 'watch', home, now: T0, env: { PI_SESSION_ID: 'a' }, ttlMs: 10 * 60_000 });
  refreshLease({ kind: 'cli', home, now: T0 + 1000, env: { PI_SESSION_ID: 'a' } });
  assert.equal(leaseState({ home, now: T0 + 5 * 60_000 }).agent, 'alive');
  refreshLease({ kind: 'cli', home, now: T0, env: { PI_SESSION_ID: 'b' } });
  const st = leaseState({ home, now: T0 + 60_000 });
  assert.equal(st.agent, 'alive');
  assert.equal(st.sessions, 2);
  // Long-expired entries are forgotten.
  refreshLease({ kind: 'cli', home, now: T0 + 3 * 24 * 3600_000, env: { PI_SESSION_ID: 'c' } });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(leaseFile(home), 'utf8')).sessions), ['pi:c']);
});

test('every CLI command refreshes the lease with the harness pid; killing the harness reads as gone, a new one as alive', async () => {
  const home = fresh();
  const env = { ...clean, HOME: home, AIM_NO_DAEMON: '1' };
  const harness = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((r) => harness.on('exit', r));
  try {
    execFileSync(process.execPath, [aim, 'rooms'], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'h1', CLAUDE_PID: String(harness.pid) } });
    const file = path.join(home, '.aim', 'lease.json');
    const l = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(l.sessions['claude:h1'].pid, harness.pid);
    assert.equal(l.sessions['claude:h1'].kind, 'cli');
    assert.equal(leaseState({ home: path.join(home, '.aim') }).agent, 'alive');
    harness.kill('SIGKILL');
    await exited;
    assert.equal(leaseState({ home: path.join(home, '.aim') }).agent, 'gone', 'gone once the harness process is gone');
    // The agent comes back in a new harness session.
    const again = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      execFileSync(process.execPath, [aim, 'rooms'], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'h2', CLAUDE_PID: String(again.pid) } });
      assert.equal(leaseState({ home: path.join(home, '.aim') }).agent, 'alive');
    } finally {
      again.kill('SIGKILL');
    }
  } finally {
    harness.kill('SIGKILL');
  }
});

test('daemons never refresh the lease and do not inherit the harness pid', async () => {
  const { daemonEnv } = await import('../lib/core.js');
  const env = daemonEnv({ CLAUDE_PID: '95', AIM_HARNESS_PID: '12', PATH: '/bin' });
  assert.equal(env.CLAUDE_PID, undefined);
  assert.equal(env.AIM_HARNESS_PID, undefined);
  assert.equal(env.PATH, '/bin');
});
