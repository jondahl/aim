import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
