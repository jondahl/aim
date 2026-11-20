// Agent liveness lease (lib/lease.js): expiry, harness pid, several sessions, and the CLI refreshing
// it on every command (watch/wait keep refreshing; see the daemon test for what peers see).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-lease-test-'));
process.env.AIM_HOME = tmpHome;
const { LEASE_CLI_PID_TTL_MS, LEASE_TTL_MS, entryAlive, harnessAlive, harnessPid, leaseFile, leaseState, ownsLease, refreshLease } = await import('../lib/lease.js');

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
  // A known harness that is not running never refreshes: whatever outlived it is not the agent.
  const home2 = fresh();
  assert.equal(refreshLease({ kind: 'watch', home: home2, now: T0, env: { CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PID: '2147483646' } }), undefined);
  assert.equal(leaseState({ home: home2, now: T0 }).agent, 'unknown');
  refreshLease({ kind: 'cli', home, now: T0 + 2000, env, isAlive: dead });
  assert.equal(leaseState({ home, now: T0 + 3000, isAlive: dead }).agent, 'gone', 'a dead harness cannot revive its lease');
});

test('a pid from another boot or pid namespace is never checked: the entry counts by ttl, at most LEASE_TTL_MS', () => {
  const home = fresh();
  refreshLease({ kind: 'cli', home, now: T0, env: { CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PID: String(process.pid) }, scope: 'other-boot/ns' });
  const e = JSON.parse(fs.readFileSync(leaseFile(home), 'utf8')).sessions['claude:s1'];
  assert.equal(e.scope, 'other-boot/ns');
  assert.equal(e.ttlMs, LEASE_CLI_PID_TTL_MS);
  const here = 'this-boot/ns';
  const running = () => true;
  const dead = () => false;
  // Its pid may since have been reused here: neither alive nor dead by pid, only by (capped) age.
  assert.equal(leaseState({ home, now: T0 + 1000, isAlive: dead, scope: here }).agent, 'alive');
  assert.equal(leaseState({ home, now: T0 + LEASE_TTL_MS, isAlive: running, scope: here }).agent, 'gone');
  assert.equal(entryAlive(e, T0 + 1000, dead, 'other-boot/ns'), false, 'in its own scope the pid is checked');
});

test('EPERM is not a running harness (someone else\'s process under a reused pid)', () => {
  assert.equal(harnessAlive(process.pid), true);
  assert.equal(harnessAlive(2147483646), false);
  if (process.getuid?.() !== 0) assert.equal(harnessAlive(1), false);
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

/** A home with one room whose daemon state exists, for CLI runs with AIM_NO_DAEMON. */
function roomHome() {
  const home = fresh();
  const dir = path.join(home, '.aim', 'rooms', 'r1');
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 1, kind: 'invite', room: 'r1', label: 'r1', name: 'me', joinedAt: 0 }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: process.pid, room: 'r1', name: 'me', status: 'live', online: [], known: [], updated: Date.now() }));
  return { home, aimHome: path.join(home, '.aim'), env: { ...clean, HOME: home, AIM_NO_DAEMON: '1' } };
}
const fakeHarness = () => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  p.exited = new Promise((r) => p.on('exit', r));
  return p;
};
const run = (args, env) => spawnSync(process.execPath, [aim, ...args], { env, encoding: 'utf8' });

test('the agent\'s active commands refresh the lease with the harness pid; killing the harness reads as gone, a new one as alive', async () => {
  const { aimHome, env } = roomHome();
  const harness = fakeHarness();
  try {
    const r = run(['read'], { ...env, CLAUDE_CODE_SESSION_ID: 'h1', CLAUDE_PID: String(harness.pid) });
    assert.equal(r.status, 0, r.stderr);
    const l = JSON.parse(fs.readFileSync(leaseFile(aimHome), 'utf8'));
    assert.equal(l.sessions['claude:h1'].pid, harness.pid);
    assert.equal(l.sessions['claude:h1'].kind, 'cli');
    assert.equal(leaseState({ home: aimHome }).agent, 'alive');
    harness.kill('SIGKILL');
    await harness.exited;
    assert.equal(leaseState({ home: aimHome }).agent, 'gone', 'gone once the harness process is gone');
    // A command run with the dead harness's pid (a leftover process) does not revive it.
    run(['read'], { ...env, CLAUDE_CODE_SESSION_ID: 'h1', CLAUDE_PID: String(harness.pid) });
    assert.equal(leaseState({ home: aimHome }).agent, 'gone');
    // The agent comes back in a new harness session.
    const again = fakeHarness();
    try {
      run(['send', 'back'], { ...env, CLAUDE_CODE_SESSION_ID: 'h2', CLAUDE_PID: String(again.pid) });
      assert.equal(leaseState({ home: aimHome }).agent, 'alive');
    } finally {
      again.kill('SIGKILL');
    }
  } finally {
    harness.kill('SIGKILL');
  }
});

test('read-only looks and commands run for another identity never refresh the lease', () => {
  const { aimHome, env } = roomHome();
  for (const args of [['who'], ['status'], ['whoami'], ['log'], ['rooms']]) run(args, { ...env, CLAUDE_CODE_SESSION_ID: 'x1' });
  assert.equal(leaseState({ home: aimHome }).agent, 'unknown', 'who/status/whoami/log/rooms do not count as the agent being there');
  run(['read'], { ...env, CLAUDE_CODE_SESSION_ID: 'x1', AIM_NO_BIND: '1' });
  assert.equal(leaseState({ home: aimHome }).agent, 'unknown', 'acting for another identity (AIM_NO_BIND) does not count');
  // A session bound to another name does not refresh this identity's lease.
  assert.equal(ownsLease({ AIM_NO_BIND: '1' }, 'me'), false);
  assert.equal(ownsLease({}, 'me'), true, 'no harness session: a plain terminal');
});

test('an orphaned watcher (its harness killed) exits and does not keep the agent alive', async () => {
  const { aimHome, env } = roomHome();
  const harness = fakeHarness();
  const watch = spawn(process.execPath, [aim, 'watch', '--json'], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'w1', CLAUDE_PID: String(harness.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  watch.stdout.on('data', (d) => (out += d));
  const watchExited = new Promise((r) => watch.on('exit', (code) => r(code)));
  try {
    const t0 = Date.now();
    while (!out.includes('"watching"') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(leaseState({ home: aimHome }).agent, 'alive');
    harness.kill('SIGKILL');
    await harness.exited;
    const how = await Promise.race([watchExited, new Promise((r) => setTimeout(() => r('still running'), 5000))]);
    assert.equal(how, 0, 'the watcher stopped when its harness did');
    assert.match(out, /harness-gone/);
    assert.equal(leaseState({ home: aimHome }).agent, 'gone');
  } finally {
    watch.kill('SIGKILL');
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
