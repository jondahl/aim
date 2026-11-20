import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const core = new URL('../lib/core.js', import.meta.url).href;

// HOME is fixed when lib/core.js loads, so each case runs in a fresh process with its own env.
function probe(env, code) {
  const home = env.HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aim-id-'));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_)/.test(k)));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as c from ${JSON.stringify(core)}; ${code}`], {
    env: { ...clean, HOME: home, ...env },
    encoding: 'utf8',
  });
  return { home, out: out.trim() };
}

test('without AIM_NAME every agent shares ~/.aim', () => {
  const { home, out } = probe({}, 'console.log(c.HOME, c.AS)');
  assert.equal(out, `${path.join(home, '.aim')} null`);
});

test('AIM_NAME gives an agent its own identity directory', () => {
  const { home, out } = probe({ AIM_NAME: 'pi-a' }, 'console.log(c.HOME, c.AS)');
  assert.equal(out, `${path.join(home, '.aim', 'as', 'pi-a')} pi-a`);
});

test('AIM_HOME wins over AIM_NAME; an invalid AIM_NAME is ignored', () => {
  assert.equal(probe({ AIM_NAME: 'pi-a', AIM_HOME: '/tmp/x' }, 'console.log(c.HOME)').out, '/tmp/x');
  const { home, out } = probe({ AIM_NAME: 'Bad Name' }, 'console.log(c.HOME)');
  assert.equal(out, path.join(home, '.aim'));
});

test('a second agent session on the same identity is noticed', () => {
  const code = `
    const a = c.noteSession(1000, 'pi:one');
    const b = c.noteSession(2000, 'pi:two');
    const again = c.noteSession(3000, 'pi:two');
    const late = c.noteSession(1000 + 31 * 60 * 1000, 'pi:two');
    console.log(JSON.stringify([a, b, again, late]));`;
  const [a, b, again, late] = JSON.parse(probe({}, code).out);
  assert.deepEqual(a, []);
  assert.deepEqual(b, [{ key: 'pi:one', ago: 1000 }]);
  assert.deepEqual(again, [{ key: 'pi:one', ago: 2000 }]);
  assert.deepEqual(late, []); // older than 30 minutes: not a live sharer
});

test('sessions are read from the harness environment', () => {
  assert.equal(probe({ PI_SESSION_ID: 'x1' }, 'console.log(c.sessionKey())').out, 'pi:x1');
  assert.equal(probe({}, 'console.log(c.sessionKey())').out, 'null');
});

test('a session binds its name; an unnamed watcher never reads another session\'s shared identity', async () => {
  const { spawn } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bind-'));
  const aim = new URL('../bin/aim.js', import.meta.url).pathname;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  fs.mkdirSync(path.join(home, '.aim'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aim', 'sessions.json'), JSON.stringify({ 'pi:other': Date.now() }));
  const env = { ...clean, HOME: home, PI_SESSION_ID: 'lifter-session' };
  const watch = spawn(process.execPath, [aim, 'watch', '--json'], { env });
  let out = '';
  watch.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 800));
  assert.match(out, /waiting-identity/);
  execFileSync(process.execPath, [aim, 'rooms'], { env: { ...env, AIM_NAME: 'pi-lifter' } });
  const code = await new Promise((r) => watch.on('exit', r));
  assert.equal(code, 3);
  assert.match(out, /identity-changed/);
  const as = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as c from ${JSON.stringify(core)}; console.log(c.AS)`], { env, encoding: 'utf8' }).trim();
  assert.equal(as, 'pi-lifter');
});

test('an AIM_HOME under ~/.aim/as/ is that name, and binds the session machine-wide', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-home-'));
  const named = path.join(home, '.aim', 'as', 'pi-lifter');
  const r = probe({ HOME: home, AIM_HOME: named }, 'console.log(c.HOME, c.AS)');
  assert.equal(r.out, `${named} pi-lifter`);
  // pi-lifter's real setup: AIM_HOME + AIM_NAME in its commands, nothing in pi's own environment.
  const aim = new URL('../bin/aim.js', import.meta.url).pathname;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  execFileSync(process.execPath, [aim, 'rooms'], { env: { ...clean, HOME: home, PI_SESSION_ID: 's1', AIM_HOME: named, AIM_NAME: 'pi-lifter' } });
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_s1'), 'utf8'), 'pi-lifter');
  const watcher = probe({ HOME: home, PI_SESSION_ID: 's1' }, 'console.log(c.HOME, c.AS, c.wantedIdentity())');
  assert.equal(watcher.out, `${named} pi-lifter pi-lifter`);
});

test('a waiting watcher starts listening once the other session stops using the shared identity', async () => {
  const { spawn } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-free-'));
  const aim = new URL('../bin/aim.js', import.meta.url).pathname;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  const file = path.join(home, '.aim', 'sessions.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ 'pi:other': Date.now() }));
  const watch = spawn(process.execPath, [aim, 'watch', '--json'], { env: { ...clean, HOME: home, PI_SESSION_ID: 'me', AIM_NO_DAEMON: '1' } });
  let out = '';
  watch.stdout.on('data', (d) => (out += d));
  try {
    await new Promise((r) => setTimeout(r, 800));
    assert.match(out, /waiting-identity/);
    fs.writeFileSync(file, JSON.stringify({ 'pi:other': Date.now() - 31 * 60_000 })); // the other went quiet
    for (let i = 0; i < 40 && !/"idle"|"watching"/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
    assert.match(out, /"type":"idle"/); // past the wait (no room here, so idle rather than watching)
  } finally {
    watch.kill();
  }
});

test('one watcher per identity: a second session waits, and takes over when the first stops', async () => {
  const { spawn } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-lock-'));
  const aim = new URL('../bin/aim.js', import.meta.url).pathname;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  const env = { ...clean, HOME: home, AIM_NO_DAEMON: '1', AIM_NAME: 'pi-x' };
  const start = (sid) => {
    const p = spawn(process.execPath, [aim, 'watch', '--json'], { env: { ...env, PI_SESSION_ID: sid } });
    p.out = '';
    p.stdout.on('data', (d) => (p.out += d));
    return p;
  };
  const until = async (pred) => {
    for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 200));
  };
  const a = start('a');
  await until(() => /"idle"/.test(a.out));
  const b = start('b');
  try {
    await until(() => /waiting-identity/.test(b.out));
    assert.match(b.out, /another session listens/);
    assert.doesNotMatch(b.out, /"idle"|"watching"/);
    a.kill('SIGKILL');
    await until(() => /"idle"/.test(b.out));
    assert.match(b.out, /"type":"idle"/, 'takes over once the first is gone');
  } finally {
    a.kill();
    b.kill();
  }
});

test('a session that got its own name no longer counts as sharing the identity', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-else-'));
  fs.mkdirSync(path.join(home, '.aim', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aim', 'sessions', 'pi_art'), 'pi-art');
  fs.writeFileSync(path.join(home, '.aim', 'sessions.json'), JSON.stringify({ 'pi:art': Date.now(), 'pi:other': Date.now() }));
  const { out } = probe({ HOME: home }, `console.log(JSON.stringify(c.noteSession(Date.now(), 'pi:me').map((o) => o.key)))`);
  assert.deepEqual(JSON.parse(out), ['pi:other']);
});

test('daemons never bind a session, and start without the session environment', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-daemon-'));
  const aim = new URL('../bin/aim.js', import.meta.url).pathname;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  const env = { ...clean, HOME: home, AIM_NAME: 'pi-art', PI_SESSION_ID: 'mine' };
  try {
    execFileSync(process.execPath, [aim, '_daemon', 'no-such-room'], { env, stdio: 'ignore' });
  } catch {}
  assert.ok(!fs.existsSync(path.join(home, '.aim', 'sessions', 'pi_mine')), 'a daemon must not rename the session it was started from');
  const { out } = probe({ HOME: home, PI_SESSION_ID: 'mine', CLAUDE_CODE_SESSION_ID: 'c' }, 'const e = c.daemonEnv(); console.log(e.PI_SESSION_ID ?? "-", e.CLAUDE_CODE_SESSION_ID ?? "-", e.HOME ? "home" : "")');
  assert.equal(out, '- - home');
  execFileSync(process.execPath, [aim, 'rooms'], { env: { ...env, AIM_NO_BIND: '1' } });
  assert.ok(!fs.existsSync(path.join(home, '.aim', 'sessions', 'pi_mine')), 'AIM_NO_BIND');
  execFileSync(process.execPath, [aim, 'rooms'], { env });
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_mine'), 'utf8'), 'pi-art');
});

test('a refused join (name held by another online member) leaves no session binding and no empty identity dir, and says who holds it', async () => {
  const { spawn } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-refuse-'));
  const aim = new URL('../bin/aim.js', import.meta.url).pathname;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  // The session already has a name; the join under another one is refused.
  fs.mkdirSync(path.join(home, '.aim', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aim', 'sessions', 'pi_s1'), 'old-name');
  const inv = `aim1_${Buffer.from(JSON.stringify({ ns: 't', room: 'demo', name: 'taken', kid: 'k1', k: 'c2VjcmV0' })).toString('base64url')}`;
  const child = spawn(process.execPath, [aim, 'join', '--bind', inv], {
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', PI_SESSION_ID: 's1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => child.on('exit', r));
  // Play the daemon: once the room exists, report the name as held by someone else (with its presence).
  const rdir = path.join(home, '.aim', 'as', 'taken', 'rooms', 'demo');
  const t0 = Date.now();
  while (!fs.existsSync(path.join(rdir, 'config.json')) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(path.join(rdir, 'config.json')), `join started; stderr=${stderr}`);
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_s1'), 'utf8'), 'old-name', 'not bound before the name is accepted');
  fs.writeFileSync(
    path.join(rdir, 'state.json'),
    JSON.stringify({ status: 'live', name: 'taken', online: [], known: [], duplicate: true, holder: { harness: 'pi', workspace: 'darklands-reboot', lastActive: Date.now() - 120_000 } }),
  );
  const code = await exited;
  assert.notEqual(code, 0);
  assert.match(stderr, /"taken" is already in use.*held by a pi agent in darklands-reboot, last active 2m ago/);
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_s1'), 'utf8'), 'old-name', 'binding not changed by a refused join');
  assert.ok(!fs.existsSync(path.join(home, '.aim', 'as', 'taken')), 'no empty ~/.aim/as/taken left behind');
  // ... so the name is free again for the local name picker.
  const free = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as c from ${JSON.stringify(core)}; console.log(c.nextFreeLocalName('taken'))`], {
    env: { ...clean, HOME: home },
    encoding: 'utf8',
  }).trim();
  assert.equal(free, 'taken');
});

test('cloud containers default to distinct, stable cloud-claude-worker-<hex> names', async () => {
  const { defaultName } = await import('../lib/repo.js');
  const a = defaultName({ CLAUDE_CODE_REMOTE: 'true', CLAUDECODE: '1', CLAUDE_CODE_REMOTE_SESSION_ID: 'session_aaa', CLAUDE_CODE_CONTAINER_ID: 'c1' });
  const a2 = defaultName({ CLAUDE_CODE_REMOTE: 'true', CLAUDECODE: '1', CLAUDE_CODE_REMOTE_SESSION_ID: 'session_aaa', CLAUDE_CODE_CONTAINER_ID: 'c2' });
  const b = defaultName({ CLAUDE_CODE_REMOTE: 'true', CLAUDECODE: '1', CLAUDE_CODE_REMOTE_SESSION_ID: 'session_bbb', CLAUDE_CODE_CONTAINER_ID: 'c1' });
  assert.match(a, /^cloud-claude-worker-[0-9a-f]{4}$/);
  assert.equal(a, a2, 'same session keeps its name across a container restart');
  assert.notEqual(a, b, 'two sessions get different names');
  assert.equal(defaultName({ CLAUDE_CODE_REMOTE: 'true', BD_ACTOR: 'worker-x' }), 'worker-x', 'BD_ACTOR still wins');
  assert.equal(defaultName({ CLAUDE_CODE_REMOTE: 'true' }), 'cloud-claude', 'no session id: no suffix');
});

test('a plain `aim join` keeps the name this identity already has in the repo room (no lock-out by a changed default)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-rejoin-'));
  const aim = new URL('../bin/aim.js', import.meta.url).pathname;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  const repo = path.join(home, 'r');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
  execFileSync('git', ['-C', repo, 'config', 'http.proxy', 'http://127.0.0.1:9']); // the key fetch fails fast, offline
  const rdir = path.join(home, '.aim', 'rooms', 'o~r');
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, 'config.json'), JSON.stringify({ v: 1, kind: 'repo', room: 'o~r', label: 'o/r', name: 'claude-cloud', joinedAt: 0 }));
  const r = spawnSync(process.execPath, [aim, 'join'], {
    cwd: repo,
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', CLAUDECODE: '1', CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'session_x' },
    encoding: 'utf8',
  });
  assert.doesNotMatch(r.stderr, /already in o\/r as/, r.stderr);
  assert.match(r.stderr, /could not fetch/);
});
