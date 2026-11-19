// End to end for the pi extension: the real integrations/pi/aim.ts, loaded with a stand-in for pi,
// running the real `aim watch` from PATH, against rooms on disk (AIM_NO_DAEMON: no relay). Messages
// are put in a room's log the way the daemon writes them, and must come out as pi messages.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const aim = new URL('../bin/aim.js', import.meta.url).pathname;
const harness = new URL('./fixtures/pi-harness.mjs', import.meta.url).pathname;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-pi-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(aim, path.join(bin, 'aim'));
  const env = { ...clean, HOME: home, AIM_NO_DAEMON: '1', PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${clean.PATH ?? ''}` };
  return { home, env };
}

function room(dir, name, label) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 1, kind: 'repo', room: path.basename(dir), label, name, joinedAt: 0 }));
}

let n = 0;
function deliver(dir, from, text) {
  fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ kind: 'in', id: `m${++n}`, from, to: null, text, ts: Date.now(), rx: Date.now() })}\n`);
}

function startPi(env) {
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', harness], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const events = [];
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (line) => proc.stdin.write(`${line}\n`);
  const waitFor = async (pred, what, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const crash = events.find((e) => e.crash);
      if (crash) assert.fail(`pi crashed: ${crash.crash}`);
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}; events: ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { proc, events, send, waitFor };
}

test('a pi agent named only in its own commands gets messages from every room, and survives /reload', async () => {
  const { home, env } = setup();
  // Another session has been using the shared identity: this one must not read its messages.
  fs.mkdirSync(path.join(home, '.aim'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aim', 'sessions.json'), JSON.stringify({ 'pi:other': Date.now() }));
  const me = path.join(home, '.aim', 'as', 'pi-lifter');
  room(path.join(me, 'rooms', 'r1'), 'pi-lifter', 'dl-explorer');
  room(path.join(me, 'rooms', 'r2'), 'pi-lifter', 'darklands-reboot');

  const pi = startPi(env);
  try {
    pi.send(`start ${home} S1`);
    await pi.waitFor((e) => e.status?.includes('another session uses the shared identity'), 'the waiting status');
    // What pi-lifter actually ran: AIM_HOME + AIM_NAME in its shell commands, with pi's session id.
    execFileSync(process.execPath, [aim, 'rooms'], { env: { ...env, PI_SESSION_ID: 'S1', AIM_HOME: me, AIM_NAME: 'pi-lifter' } });
    await pi.waitFor((e) => e.status?.startsWith('aim: pi-lifter in '), 'listening as pi-lifter');
    deliver(path.join(me, 'rooms', 'r1'), 'pi-a', 'hello from dl-explorer');
    deliver(path.join(me, 'rooms', 'r2'), 'claude-cloud', 'hello from darklands-reboot');
    await pi.waitFor((e) => e.sent?.includes('hello from dl-explorer'), 'the dl-explorer message');
    await pi.waitFor((e) => e.sent?.includes('hello from darklands-reboot'), 'the darklands-reboot message');
    assert.ok(pi.events.find((e) => e.sent).opts.triggerTurn, 'wakes an idle session');
    // Others can see it listens.
    const listening = JSON.parse(fs.readFileSync(path.join(me, 'rooms', 'r1', 'listening'), 'utf8'));
    assert.equal(listening.kind, 'watch');
    assert.ok(fs.existsSync(path.join(home, '.aim', 'pi', `${pi.proc.pid}.json`)), 'registered for `aim hooks pi`');

    // /reload: the old ctx goes stale; nothing may touch it (that crashed pi before).
    pi.send('shutdown');
    await pi.waitFor((e) => e.shutdown, 'shutdown');
    const after = pi.events.length;
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(pi.events.slice(after).length, 0, `no events after shutdown: ${JSON.stringify(pi.events.slice(after))}`);
    pi.send(`start ${home} S1`);
    const mark = pi.events.length;
    await pi.waitFor((e) => pi.events.indexOf(e) > mark && e.status?.startsWith('aim: pi-lifter in '), 'listening again after reload');
  } finally {
    pi.proc.kill();
  }
});

test('the watcher waits for a room, and comes back after it is killed', async () => {
  const { home, env } = setup();
  const pi = startPi(env);
  try {
    pi.send(`start ${home} S2`);
    await pi.waitFor((e) => e.started, 'start');
    await new Promise((r) => setTimeout(r, 1500)); // watcher up, not in any room yet
    const r1 = path.join(home, '.aim', 'rooms', 'r1');
    room(r1, 'pi', 'myrepo');
    await pi.waitFor((e) => e.status === 'aim: pi in myrepo', 'listening once a room exists');
    deliver(r1, 'claude', 'first');
    await pi.waitFor((e) => e.sent?.includes('first'), 'the first message');

    const watcher = JSON.parse(fs.readFileSync(path.join(r1, 'listening'), 'utf8')).pid;
    process.kill(watcher, 'SIGKILL');
    await pi.waitFor((e) => e.status?.includes('not listening'), 'the not-listening status');
    const mark = pi.events.length;
    await pi.waitFor((e) => pi.events.indexOf(e) >= mark && e.status === 'aim: pi in myrepo', 'listening again');
    deliver(r1, 'claude', 'second');
    await pi.waitFor((e) => e.sent?.includes('second'), 'the second message');

    // pi dies without a shutdown: its watcher must not live on, reading messages nobody receives.
    const orphan = JSON.parse(fs.readFileSync(path.join(r1, 'listening'), 'utf8')).pid;
    pi.proc.kill('SIGKILL');
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(orphan, 0);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the orphaned watcher exits');
  } finally {
    pi.proc.kill();
  }
});

test('a session start without a shutdown first stops the old watcher (no consumed-but-dropped messages)', async () => {
  const { home, env } = setup();
  const r1 = path.join(home, '.aim', 'rooms', 'r1');
  room(r1, 'pi', 'myrepo');
  const pi = startPi(env);
  try {
    pi.send(`start ${home} A`);
    await pi.waitFor((e) => e.status === 'aim: pi in myrepo', 'first session listening');
    const first = JSON.parse(fs.readFileSync(path.join(r1, 'listening'), 'utf8')).pid;
    pi.send(`start ${home} A`); // session replacement: no shutdown in between
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(first, 0);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the first watcher is stopped');
    for (let i = 0; i < 6; i++) deliver(r1, 'claude', `msg-${i}`);
    for (let i = 0; i < 6; i++) await pi.waitFor((e) => e.sent?.includes(`msg-${i}`), `msg-${i}`);
  } finally {
    pi.proc.kill();
  }
});

test('hooks on the shared identity take only their checkout\'s room; a named agent gets all', () => {
  const { home, env } = setup();
  for (const [base, name] of [[path.join(home, '.aim'), 'claude'], [path.join(home, '.aim', 'as', 'w1'), 'w1']]) {
    room(path.join(base, 'rooms', 'r1'), name, 'repo-one');
    room(path.join(base, 'rooms', 'r2'), name, 'repo-two');
    deliver(path.join(base, 'rooms', 'r1'), 'pi', 'for r1');
    deliver(path.join(base, 'rooms', 'r2'), 'pi', 'for r2');
  }
  const hook = (extra) => execFileSync(process.execPath, [aim, 'hook', 'post-tool-use'], { env: { ...env, ...extra }, input: JSON.stringify({ cwd: home }), encoding: 'utf8' });
  assert.equal(hook({}), '', 'shared identity outside any of its rooms\' checkouts: takes nothing');
  const named = JSON.parse(hook({ AIM_NAME: 'w1' })).hookSpecificOutput.additionalContext;
  assert.match(named, /for r1/);
  assert.match(named, /for r2/);
});
