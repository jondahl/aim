// dr-den.14: renaming and session bindings (leave's room forms, join --bind ghosts, rename,
// AIM_NAME on other commands, and the identity a spawned daemon serves).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const aim = new URL('../bin/aim.js', import.meta.url).pathname;
const core = new URL('../lib/core.js', import.meta.url).href;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_|GIT_)/.test(k)));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const invite = (room, name) => `aim1_${Buffer.from(JSON.stringify({ ns: 't', room, name, kid: 'k1', k: 'c2VjcmV0' })).toString('base64url')}`;
const binding = (home, sid) => {
  try {
    return fs.readFileSync(path.join(home, '.aim', 'sessions', `pi_${sid}`), 'utf8');
  } catch {
    return null;
  }
};
function bind(home, sid, name) {
  fs.mkdirSync(path.join(home, '.aim', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aim', 'sessions', `pi_${sid}`), name);
}
function room(home, as, id, cfg) {
  const dir = as ? path.join(home, '.aim', 'as', as, 'rooms', id) : path.join(home, '.aim', 'rooms', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 1, kind: 'invite', ns: 't', room: id, label: id, kid: 'k1', k: 'c2VjcmV0', joinedAt: 0, ...cfg }));
  return dir;
}
/** A process standing in for a room's daemon: its pid in daemon.pid, ended by SIGTERM. */
function fakeDaemon(dir) {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'daemon.pid'), String(p.pid));
  return p;
}
const exited = (p) => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise((r) => p.on('exit', r)));

test('leave (and every --room) accepts owner/repo, owner/repo@branch and the owner~repo id', () => {
  const home = tmp('aim-leave-');
  room(home, 'w', 'acme~proj', { kind: 'repo', label: 'acme/proj', repo: 'acme/proj', name: 'w' });
  room(home, 'w', 'acme~proj@dev', { kind: 'repo', label: 'acme/proj@dev', repo: 'acme/proj', branch: 'dev', name: 'w' });
  room(home, 'w', 'acme~other', { kind: 'repo', label: 'acme/other', repo: 'acme/other', name: 'w' });
  const run = (args) => spawnSync(process.execPath, [aim, ...args], { env: { ...clean, HOME: home, AIM_NAME: 'w', AIM_NO_DAEMON: '1' }, encoding: 'utf8' });
  const rooms = path.join(home, '.aim', 'as', 'w', 'rooms');

  const st = run(['status', '--room', 'acme/proj@dev', '--json']);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(JSON.parse(st.stdout).room, 'acme~proj@dev');

  const bad = run(['leave', '--room', 'acme/nope']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not in room "acme\/nope" \(rooms: .*acme\/proj/);

  let r = run(['leave', '--room', 'acme/proj']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(rooms, 'acme~proj')), 'owner/repo form');
  assert.ok(fs.existsSync(path.join(rooms, 'acme~proj@dev')), 'only that room');
  r = run(['leave', '--room', 'acme/proj@dev']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(rooms, 'acme~proj@dev')), 'owner/repo@branch form');
  r = run(['leave', '--room', 'acme~other']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(rooms, 'acme~other')), 'id form');
});

test('join --bind to a new name leaves the room under the old name (no ghost); AIM_NO_BIND keeps both', async () => {
  const home = tmp('aim-ghost-');
  bind(home, 's1', 'old');
  const oldDir = room(home, 'old', 'demo', { name: 'old' });
  const ghost = fakeDaemon(oldDir);
  const keep = room(home, 'old', 'elsewhere', { name: 'old' });
  try {
    const r = spawnSync(process.execPath, [aim, 'join', '--bind', invite('demo', 'new')], {
      env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', PI_SESSION_ID: 's1' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Left demo as "old"/);
    assert.equal(binding(home, 's1'), 'new');
    assert.ok(fs.existsSync(path.join(home, '.aim', 'as', 'new', 'rooms', 'demo', 'config.json')));
    assert.ok(!fs.existsSync(oldDir), "the old name's membership of that room is gone");
    await exited(ghost);
    assert.ok(fs.existsSync(keep), 'other rooms of the old name are untouched');

    // Acting on another agent's behalf (AIM_NO_BIND) renames nothing and leaves nothing.
    bind(home, 's2', 'third');
    const third = room(home, 'third', 'demo2', { name: 'third' });
    const r2 = spawnSync(process.execPath, [aim, 'join', invite('demo2', 'helper')], {
      env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', PI_SESSION_ID: 's2', AIM_NO_BIND: '1' },
      encoding: 'utf8',
    });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(binding(home, 's2'), 'third');
    assert.ok(fs.existsSync(third));
  } finally {
    ghost.kill('SIGKILL');
  }
});

test('AIM_NAME on a non-join command does not change an existing session binding (it still names an unbound one)', () => {
  const home = tmp('aim-nobind-');
  bind(home, 's1', 'mine');
  const env = { ...clean, HOME: home, PI_SESSION_ID: 's1', AIM_NO_DAEMON: '1' };
  for (const cmd of [['rooms'], ['whoami'], ['read']]) {
    spawnSync(process.execPath, [aim, ...cmd], { env: { ...env, AIM_NAME: 'pi' }, encoding: 'utf8' });
    assert.equal(binding(home, 's1'), 'mine', `aim ${cmd[0]} with AIM_NAME=pi`);
  }
  spawnSync(process.execPath, [aim, 'rooms'], { env: { ...env, PI_SESSION_ID: 's2', AIM_NAME: 'fresh' } });
  assert.equal(binding(home, 's2'), 'fresh', 'a session without a name still takes one');
});

test("a spawned daemon serves the session-bound identity (no AIM_NAME, e.g. after a container restart)", async () => {
  const home = tmp('aim-dmn-');
  bind(home, 's1', 'bound');
  const dir = room(home, 'bound', 'demo', { name: 'bound' });
  // The environment a daemon gets carries the resolved name, though not the session id.
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as c from ${JSON.stringify(core)}; const e = c.daemonEnv(); console.log(c.AS, e.AIM_NAME, e.PI_SESSION_ID ?? '-')`], {
    env: { ...clean, HOME: home, PI_SESSION_ID: 's1' },
    encoding: 'utf8',
  }).trim();
  assert.equal(out, 'bound bound -');
  // End to end: a command that starts the daemon, run by a new process of the same session.
  const r = spawnSync(process.execPath, [aim, 'alias', 'add', 'coordinator'], {
    env: { ...clean, HOME: home, PI_SESSION_ID: 's1' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8'));
  try {
    assert.ok(pid > 0);
    const log = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8');
    assert.doesNotMatch(log, /not in room/);
    assert.ok(!fs.existsSync(path.join(home, '.aim', 'rooms')), 'nothing started under the shared ~/.aim');
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});

/** A local stand-in for github.com/acme/proj with an aim room key, and a checkout of it. */
function repoFixture(home) {
  const base = tmp('aim-repo-');
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'keysrc');
  const checkout = path.join(base, 'proj');
  const git = (args, cwd = base) => execFileSync('git', args, { cwd, env: { ...clean, HOME: home }, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(home, '.gitconfig'),
    `[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[url "${bare}"]\n\tinsteadOf = https://github.com/acme/proj.git\n`,
  );
  git(['init', '-q', '--bare', bare]);
  fs.mkdirSync(work);
  git(['init', '-q'], work);
  fs.writeFileSync(path.join(work, 'key.json'), JSON.stringify({ ns: 't', kid: 'k1', k: 'c2VjcmV0', path: 'aim/gh/acme/proj' }));
  git(['add', 'key.json'], work);
  git(['commit', '-q', '-m', 'key'], work);
  git(['push', '-q', bare, 'HEAD:refs/aim/key'], work);
  fs.mkdirSync(checkout);
  git(['init', '-q'], checkout);
  git(['remote', 'add', 'origin', 'https://github.com/acme/proj.git'], checkout);
  return checkout;
}

test('aim rename moves name, role, task, state and aliases in one step, rebinds the session and leaves no ghost', () => {
  const home = tmp('aim-rename-');
  const checkout = repoFixture(home);
  const env = { ...clean, HOME: home, PI_SESSION_ID: 's1', AIM_NO_DAEMON: '1' };
  const run = (args, extra = {}) => spawnSync(process.execPath, [aim, ...args], { cwd: checkout, env: { ...env, ...extra }, encoding: 'utf8' });

  let r = run(['join', '--as', 'old']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(binding(home, 's1'), 'old');
  // (git reports the origin with insteadOf applied, so the room is named after the local fixture.)
  const [id] = fs.readdirSync(path.join(home, '.aim', 'as', 'old', 'rooms'));
  const label = JSON.parse(fs.readFileSync(path.join(home, '.aim', 'as', 'old', 'rooms', id, 'config.json'), 'utf8')).label;
  r = run(['doing', 'dr-1: the thing', '--role', 'builder', '--state', 'busy']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['alias', 'add', 'coordinator']);
  assert.equal(r.status, 0, r.stderr);

  r = run(['rename', 'Bad Name']);
  assert.notEqual(r.status, 0);
  assert.equal(binding(home, 's1'), 'old');

  r = run(['rename', 'mac-pi-new']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Left ${label} as "old"`), r.stdout);
  assert.match(r.stdout, /Renamed to "mac-pi-new"/);
  assert.equal(binding(home, 's1'), 'mac-pi-new');
  assert.ok(!fs.existsSync(path.join(home, '.aim', 'as', 'old', 'rooms', id)), 'no ghost');
  const dir = path.join(home, '.aim', 'as', 'mac-pi-new', 'rooms', id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).name, 'mac-pi-new');
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'presence.json'), 'utf8'));
  assert.equal(p.task, 'dr-1: the thing');
  assert.equal(p.role, 'builder');
  assert.equal(p.state, 'busy');
  assert.deepEqual(p.aliases, ['coordinator']);

  // The bound session needs no AIM_NAME afterwards.
  r = run(['whoami', '--json']);
  assert.equal(JSON.parse(r.stdout).identity, 'mac-pi-new');
  // Invite rooms are issued to one name: refused, nothing changed.
  room(home, 'mac-pi-new', 'inv', { name: 'mac-pi-new' });
  r = run(['rename', 'other']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invite rooms can't be renamed: inv/);
  assert.equal(binding(home, 's1'), 'mac-pi-new');
});
