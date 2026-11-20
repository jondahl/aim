import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultPresenceMeta, editDistance, normalizePresenceMeta } from '../lib/core.js';

const aim = new URL('../bin/aim.js', import.meta.url).pathname;
const harness = new URL('./fixtures/pi-harness.mjs', import.meta.url).pathname;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));

const waitFor = async (pred, what, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

function setupRoom(room = 'r1', name = 'neon', extraHome = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-feat-'));
  const base = extraHome ? path.join(home, '.aim', 'as', extraHome) : path.join(home, '.aim');
  const rdir = path.join(base, 'rooms', room);
  fs.mkdirSync(path.join(rdir, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(rdir, 'config.json'), JSON.stringify({ v: 1, kind: 'repo', room, label: 'jondahl/test', name, joinedAt: 0 }));
  fs.writeFileSync(
    path.join(rdir, 'state.json'),
    JSON.stringify({
      pid: process.pid,
      room,
      name,
      status: 'live',
      online: ['claude-coord', 'pi', 'pi-art'],
      known: ['claude-coord', 'pi', 'pi-art', 'pi-old'],
      peersListening: { 'claude-coord': true, pi: true, 'pi-art': false },
      peers: {
        'claude-coord': { listening: true, v: 2, meta: { harness: 'claude-cloud', role: 'coordinator', task: 'gating PR #83', state: 'busy', aliases: ['coordinator'] } },
        pi: { listening: true, v: 2, meta: { harness: 'pi', workspace: 'darklands-reboot', task: 'dr-63s', state: 'busy' } },
        'pi-art': { listening: false, v: 2, lastActive: Date.now() - 2 * 3600_000, meta: { harness: 'pi', state: 'paused' } },
      },
      aliases: { coordinator: ['claude-coord'] },
      pending: 0,
      updated: Date.now(),
    }),
  );
  const run = (args, { env = {}, input = '' } = {}) =>
    spawnSync(process.execPath, [aim, ...args], {
      env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', ...(extraHome ? { AIM_NAME: extraHome } : {}), ...env },
      input,
      encoding: 'utf8',
    });
  return { home, base, rdir, run };
}

test('presence privacy defaults: invite rooms omit workspace/host; AIM_PRESENCE=minimal emits nothing', () => {
  const invite = defaultPresenceMeta({ kind: 'invite', cwd: '/Users/alice/secret-proj', env: { CLAUDECODE: '1' } });
  assert.deepEqual(invite, { harness: 'claude' });

  const repo = defaultPresenceMeta({ kind: 'repo', cwd: '/Users/alice/darklands-reboot', env: { PI_MODEL: 'm1' } });
  assert.deepEqual(repo, { harness: 'pi', workspace: 'darklands-reboot' });

  const minimal = defaultPresenceMeta({ kind: 'repo', cwd: '/Users/alice/darklands-reboot', env: { PI_MODEL: 'm1', AIM_PRESENCE: 'minimal' } });
  assert.deepEqual(minimal, {});

  const norm = normalizePresenceMeta({ role: '  coord  ', state: 'INVALID', task: 'x'.repeat(200), aliases: ['@coordinator', 'BAD!', 'coordinator'] });
  assert.equal(norm.role, 'coord');
  assert.equal(norm.state, undefined);
  assert.equal(norm.task.length, 120);
  assert.deepEqual(norm.aliases, ['coordinator']);
  assert.equal(editDistance('claude-cooord', 'claude-coord'), 1);
});

test('send supports --file, rejects --file + positional, warns on >512B positional, requires @ for aliases, rejects self, and hints typos', () => {
  const { home, rdir, run } = setupRoom();
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, 'line 1\nline 2\n');

  // --file + positional text must error
  const rBoth = run(['send', '--no-wait', '--file', bodyFile, 'extra']);
  assert.notEqual(rBoth.status, 0);
  assert.match(rBoth.stderr, /not both/);

  // --to @coordinator resolves alias cleanly
  const r1 = run(['send', '--no-wait', '--to', '@coordinator', '--urgent', '--file', bodyFile]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stderr, /resolved @coordinator -> claude-coord/);
  const outFiles = fs.readdirSync(path.join(rdir, 'outbox'));
  assert.equal(outFiles.length, 1);
  const outMsg = JSON.parse(fs.readFileSync(path.join(rdir, 'outbox', outFiles[0]), 'utf8'));
  assert.deepEqual(outMsg.to, ['claude-coord']);
  assert.equal(outMsg.urgent, 1);
  assert.equal(outMsg.text, 'line 1\nline 2');

  // Without '@', coordinator is NOT silently resolved to alias — warns with @coordinator hint
  const rNoAt = run(['send', '--no-wait', '--to', 'coordinator', 'hi']);
  assert.equal(rNoAt.status, 0);
  assert.match(rNoAt.stderr, /Use --to @coordinator/);

  // Soft warning on >512B positional arg
  const rBig = run(['send', '--no-wait', 'a'.repeat(600)]);
  assert.equal(rBig.status, 0);
  assert.match(rBig.stderr, /pass long messages on stdin/);

  // Self-send rejected immediately
  const rSelf = run(['send', '--no-wait', '--to', 'neon', 'self']);
  assert.notEqual(rSelf.status, 0);
  assert.match(rSelf.stderr, /cannot send to yourself/);

  // Typo hint
  const rTypo = run(['send', '--no-wait', '--to', 'claude-cooord', 'ping']);
  assert.equal(rTypo.status, 0);
  assert.match(rTypo.stderr, /Did you mean "claude-coord"\?/);
});

test('aim log deduplicates acks/seen, filters with --from, and never advances cursor past truncated unread messages', () => {
  const { rdir, run } = setupRoom();
  const t0 = Date.now() - 10_000;
  const entries = [
    { kind: 'out', id: 'out1', from: 'neon', to: ['pi'], text: 'please review', ts: t0 + 1000 },
    { kind: 'ack', id: 'out1', by: 'pi', ts: t0 + 1100, rr: 1 },
    { kind: 'ack', id: 'out1', by: 'pi', ts: t0 + 1200, rr: 1 },
    { kind: 'seen', id: 'out1', by: 'pi', ts: t0 + 1300 },
    { kind: 'seen', id: 'out1', by: 'pi', ts: t0 + 1400 },
    { kind: 'in', id: 'in1', from: 'pi', to: ['neon'], text: 'looks good', ts: t0 + 2000 },
    { kind: 'in', id: 'in2', from: 'claude-coord', to: null, text: 'merged', ts: t0 + 3000 },
  ];
  fs.writeFileSync(path.join(rdir, 'log.jsonl'), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const rTrunc = run(['log', '--last', '1']);
  assert.equal(rTrunc.status, 0);
  assert.ok(!fs.existsSync(path.join(rdir, 'cursor')), 'cursor must not advance when unread messages were truncated');

  const rFrom = run(['log', '--from', 'pi']);
  assert.equal(rFrom.status, 0);
  assert.match(rFrom.stdout, /looks good/);
  assert.doesNotMatch(rFrom.stdout, /merged/);
  assert.ok(!fs.existsSync(path.join(rdir, 'cursor')), 'cursor must not advance when filtered');

  const rAll = run(['log', '--all']);
  assert.equal(rAll.status, 0);
  assert.match(rAll.stdout, /\(read by pi\)/);
  assert.doesNotMatch(rAll.stdout, /read by pi, pi/);
  assert.equal(fs.readFileSync(path.join(rdir, 'cursor'), 'utf8'), String(entries.length));
});

test('aim doing, aim alias, and rich aim who preserve saved workspace defaults', () => {
  const { rdir, run } = setupRoom();
  fs.writeFileSync(path.join(rdir, 'presence.json'), JSON.stringify({ harness: 'pi', workspace: 'original-repo' }));

  const rDo = run(['doing', 'reviewing aim', '--state', 'busy', '--role', 'reviewer']);
  assert.equal(rDo.status, 0, rDo.stderr);
  const p = JSON.parse(fs.readFileSync(path.join(rdir, 'presence.json'), 'utf8'));
  assert.equal(p.task, 'reviewing aim');
  assert.equal(p.state, 'busy');
  assert.equal(p.role, 'reviewer');
  assert.equal(p.workspace, 'original-repo', 'workspace preserved across aim doing updates');

  // Invalid state rejected
  const rBad = run(['doing', '--state', 'flying']);
  assert.notEqual(rBad.status, 0);
  assert.match(rBad.stderr, /bad --state/);

  const rAdd = run(['alias', 'add', 'triage']);
  assert.equal(rAdd.status, 0, rAdd.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rdir, 'presence.json'), 'utf8')).aliases, ['triage']);

  const rWho = run(['who']);
  assert.equal(rWho.status, 0, rWho.stderr);
  assert.match(rWho.stdout, /claude-coord: online, listening.*\[busy\] coordinator — gating PR #83.*aliases: @coordinator/);
  assert.match(rWho.stdout, /pi-art: online, not listening, idle 2h.*\[paused\]/);
  assert.match(rWho.stdout, /pi-old: offline/);

  const rClear = run(['doing', '--clear']);
  assert.equal(rClear.status, 0);
  const pCleared = JSON.parse(fs.readFileSync(path.join(rdir, 'presence.json'), 'utf8'));
  assert.equal(pCleared.task, undefined);
  assert.equal(pCleared.workspace, 'original-repo', 'clear preserves auto harness/workspace');
});

test('aim wait guards lock across waiters, releases on exit, and enters peek-only mode when same session watches', async () => {
  const { home, rdir, run } = setupRoom();
  const lockFile = path.join(home, '.aim', 'watch.json');
  const env = { ...clean, HOME: home, AIM_NO_DAEMON: '1' };

  // 1) Start first waiter; wait for lock file (no flaky sleep)
  const w1 = spawn(process.execPath, [aim, 'wait', '--timeout', '15', '--oneline'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out1 = '';
  w1.stdout.on('data', (d) => (out1 += d));
  await waitFor(() => fs.existsSync(lockFile), 'w1 lock file');

  // Second waiter on same identity fails fast
  const w2 = run(['wait', '--timeout', '2']);
  assert.notEqual(w2.status, 0);
  assert.match(w2.stderr, /another listener \(pid \d+, wait\) already listens/);

  // Deliver multi-line message -> w1 prints single line and releases lock
  fs.appendFileSync(path.join(rdir, 'log.jsonl'), `${JSON.stringify({ kind: 'in', id: 'm1', from: 'pi', to: null, text: 'line A\nline B', ts: Date.now() })}\n`);
  const code1 = await new Promise((r) => w1.on('exit', r));
  assert.equal(code1, 0);
  assert.match(out1, /line A ⏎ line B/);
  assert.ok(!fs.existsSync(lockFile), 'lock released after clean exit');

  // 2) Same-session watch holds lock -> aim wait runs in peek-only mode without failing or stealing cursor!
  const sessEnv = { ...env, PI_SESSION_ID: 'same-sess' };
  const watcher = spawn(process.execPath, [aim, 'watch', '--json'], { env: sessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitFor(() => fs.existsSync(lockFile), 'watcher lock');
    const wSame = spawn(process.execPath, [aim, 'wait', '--timeout', '10'], { env: sessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let outSame = '';
    let exited = false;
    wSame.stdout.on('data', (d) => (outSame += d));
    const exitP = new Promise((r) => wSame.on('exit', (c) => ((exited = true), r(c))));
    // Deliver once wSame has booted and entered its poll loop
    let seq = 0;
    const feeder = setInterval(() => {
      if (exited) return;
      fs.appendFileSync(path.join(rdir, 'log.jsonl'), `${JSON.stringify({ kind: 'in', id: `m2-${++seq}`, from: 'pi', to: null, text: 'for same session', ts: Date.now() })}\n`);
    }, 300);
    const codeSame = await exitP;
    clearInterval(feeder);
    assert.equal(codeSame, 0);
    assert.match(outSame, /for same session/);
    assert.ok(fs.existsSync(lockFile), 'watcher still owns lock');
  } finally {
    watcher.kill();
  }
});

test('aim hook honors input.session_id, skips when same-session watch holds lock, and ANY_UNREAD handles AIM_HOME', async () => {
  const { home, base, rdir } = setupRoom('r1', 'claude-showcase', 'claude-showcase');
  fs.mkdirSync(path.join(home, '.aim', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aim', 'sessions', 'claude_sess-123'), 'claude-showcase');
  fs.writeFileSync(path.join(rdir, 'log.jsonl'), `${JSON.stringify({ kind: 'in', id: 'hk1', from: 'pi', to: ['claude-showcase'], text: 'hello showcase', ts: Date.now() })}\n`);

  // Without CLAUDE_CODE_SESSION_ID in env, input.session_id resolves claude-showcase!
  const out = execFileSync(process.execPath, [aim, 'hook', 'post-tool-use'], {
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1' },
    input: JSON.stringify({ session_id: 'sess-123', cwd: home }),
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.match(parsed.hookSpecificOutput.additionalContext, /hello showcase/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /you are claude-showcase/);

  // When same session's live aim watch holds the lock, PostToolUse skips to prevent double delivery!
  fs.writeFileSync(path.join(base, 'watch.json'), JSON.stringify({ pid: process.pid, key: 'claude:sess-123', kind: 'watch', ts: Date.now() }));
  fs.appendFileSync(path.join(rdir, 'log.jsonl'), `${JSON.stringify({ kind: 'in', id: 'hk2', from: 'pi', to: ['claude-showcase'], text: 'no double', ts: Date.now() })}\n`);
  const outSkipped = execFileSync(process.execPath, [aim, 'hook', 'post-tool-use'], {
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1' },
    input: JSON.stringify({ session_id: 'sess-123', cwd: home }),
    encoding: 'utf8',
  });
  assert.equal(outSkipped, '', 'hook skips delivery when same-session watch holds the lock');
});

test('aim join --as <name> auto-isolates under ~/.aim/as/<name> and binds session; aim whoami and revoke work', () => {
  const { home, run } = setupRoom('r1', 'neon', 'neon');
  const rWhoami = run(['whoami', '--json']);
  assert.equal(rWhoami.status, 0, rWhoami.stderr);
  const info = JSON.parse(rWhoami.stdout);
  assert.equal(info.identity, 'neon');
  assert.equal(info.source, 'AIM_NAME');

  const rRev = run(['revoke', 'pi']);
  assert.notEqual(rRev.status, 0);
  assert.match(rRev.stderr, /repo room.*aim rotate/);

  // Auto-isolation on `aim join --as worker-1 <invite>` without AIM_NAME in env!
  const inv = `aim1_${Buffer.from(JSON.stringify({ ns: 't', room: 'demo', name: 'worker-1', kid: 'k1', k: 'c2VjcmV0' })).toString('base64url')}`;
  const rJoin = spawnSync(process.execPath, [aim, 'join', inv], {
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'auto-sess' },
    encoding: 'utf8',
  });
  // ensureDaemon skips spawning with AIM_NO_DAEMON=1, so config & binding are written under ~/.aim/as/worker-1!
  assert.ok(fs.existsSync(path.join(home, '.aim', 'as', 'worker-1', 'rooms', 'demo', 'config.json')), `isolated config created; stderr=${rJoin.stderr}`);
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_auto-sess'), 'utf8'), 'worker-1');
  // Invite room auto-presence omits workspace/host!
  const pres = JSON.parse(fs.readFileSync(path.join(home, '.aim', 'as', 'worker-1', 'rooms', 'demo', 'presence.json'), 'utf8'));
  assert.equal(pres.harness, 'pi');
  assert.equal(pres.workspace, undefined);

  // Blocking #1: already-bound session (worker-1) joining as another name (pi-art) is refused unless --bind or AIM_NO_BIND=1!
  const inv2 = `aim1_${Buffer.from(JSON.stringify({ ns: 't', room: 'demo2', name: 'pi-art', kid: 'k1', k: 'c2VjcmV0' })).toString('base64url')}`;
  const rRefuse = spawnSync(process.execPath, [aim, 'join', inv2], {
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'auto-sess' },
    encoding: 'utf8',
  });
  assert.notEqual(rRefuse.status, 0);
  assert.match(rRefuse.stderr, /already "worker-1", not "pi-art".*--bind.*AIM_NO_BIND=1/);
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_auto-sess'), 'utf8'), 'worker-1');

  // With AIM_NO_BIND=1: joins on pi-art's behalf without renaming calling session!
  const rNoBind = spawnSync(process.execPath, [aim, 'join', inv2], {
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'auto-sess', AIM_NO_BIND: '1' },
    encoding: 'utf8',
  });
  assert.equal(rNoBind.status, 0, rNoBind.stderr);
  assert.ok(fs.existsSync(path.join(home, '.aim', 'as', 'pi-art', 'rooms', 'demo2', 'config.json')));
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_auto-sess'), 'utf8'), 'worker-1', 'session binding untouched');

  // With --bind: intentionally switches session binding to pi-art!
  const rBind = spawnSync(process.execPath, [aim, 'join', '--bind', inv2], {
    env: { ...clean, HOME: home, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'auto-sess' },
    encoding: 'utf8',
  });
  assert.equal(rBind.status, 0, rBind.stderr);
  assert.equal(fs.readFileSync(path.join(home, '.aim', 'sessions', 'pi_auto-sess'), 'utf8'), 'pi-art');

  // Blocking #2: an agent already on shared ~/.aim with name 'pi' joining as 'pi' stays on ~/.aim (no duplicate ~/.aim/as/pi!)
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-shared-'));
  fs.mkdirSync(path.join(home2, '.aim', 'rooms', 'existing'), { recursive: true });
  fs.writeFileSync(path.join(home2, '.aim', 'rooms', 'existing', 'config.json'), JSON.stringify({ v: 1, room: 'existing', name: 'pi', joinedAt: 0 }));
  const invPi = `aim1_${Buffer.from(JSON.stringify({ ns: 't', room: 'demo3', name: 'pi', kid: 'k1', k: 'c2VjcmV0' })).toString('base64url')}`;
  const rShared = spawnSync(process.execPath, [aim, 'join', invPi], {
    env: { ...clean, HOME: home2, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'shared-pi' },
    encoding: 'utf8',
  });
  assert.equal(rShared.status, 0, rShared.stderr);
  assert.ok(fs.existsSync(path.join(home2, '.aim', 'rooms', 'demo3', 'config.json')), 'stayed on shared ~/.aim');
  assert.ok(!fs.existsSync(path.join(home2, '.aim', 'as', 'pi')), 'did not create duplicate ~/.aim/as/pi');

  // Shared-identity session ('pi' active in sessions.json) joining as 'pi-art' must refuse (prevents renaming 'pi'),
  // while a brand-new session on the same machine isolates automatically as 'pi-art'!
  fs.writeFileSync(path.join(home2, '.aim', 'sessions.json'), JSON.stringify({ 'pi:shared-pi': Date.now() }));
  const rSharedRename = spawnSync(process.execPath, [aim, 'join', inv2], {
    env: { ...clean, HOME: home2, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'shared-pi' },
    encoding: 'utf8',
  });
  assert.notEqual(rSharedRename.status, 0);
  assert.match(rSharedRename.stderr, /already "pi", not "pi-art".*--bind.*AIM_NO_BIND=1/);
  assert.ok(!fs.existsSync(path.join(home2, '.aim', 'sessions', 'pi_shared-pi')), 'shared-pi was not renamed');

  // Same call with AIM_NO_BIND=1 succeeds without binding shared-pi
  const rSharedNoBind = spawnSync(process.execPath, [aim, 'join', inv2], {
    env: { ...clean, HOME: home2, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'shared-pi', AIM_NO_BIND: '1' },
    encoding: 'utf8',
  });
  assert.equal(rSharedNoBind.status, 0, rSharedNoBind.stderr);
  assert.ok(fs.existsSync(path.join(home2, '.aim', 'as', 'pi-art', 'rooms', 'demo2', 'config.json')));
  assert.ok(!fs.existsSync(path.join(home2, '.aim', 'sessions', 'pi_shared-pi')), 'shared-pi still unbound');

  // A truly fresh session on the same machine still isolates automatically as 'fresh-agent'
  const invFresh = `aim1_${Buffer.from(JSON.stringify({ ns: 't', room: 'demo4', name: 'fresh-agent', kid: 'k1', k: 'c2VjcmV0' })).toString('base64url')}`;
  const rFresh = spawnSync(process.execPath, [aim, 'join', invFresh], {
    env: { ...clean, HOME: home2, AIM_NO_DAEMON: '1', PI_SESSION_ID: 'brand-new-sess' },
    encoding: 'utf8',
  });
  assert.equal(rFresh.status, 0, rFresh.stderr);
  assert.equal(fs.readFileSync(path.join(home2, '.aim', 'sessions', 'pi_brand-new-sess'), 'utf8'), 'fresh-agent');
});

test('pi extension registers native aim_send tool that pipes text over stdin', async () => {
  const { home, rdir } = setupRoom('r1', 'pi', null);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(aim, path.join(bin, 'aim'));
  const env = { ...clean, HOME: home, AIM_NO_DAEMON: '1', PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${clean.PATH ?? ''}` };

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
  try {
    await waitFor(() => events.some((e) => e.toolRegistered === 'aim_send'), 'aim_send registered');
    proc.stdin.write(`start ${home} S-tool\n`);
    await waitFor(() => events.some((e) => e.started === 'S-tool'), 'session started');
    // Call aim_send with a 1500-char multi-line message (goes over stdin, never argv!)
    const longMsg = `Line 1 with "quotes" and $vars\n${'x'.repeat(1500)}`;
    proc.stdin.write(`tool aim_send ${JSON.stringify({ text: longMsg, to: 'pi-art' })}\n`);
    await waitFor(() => fs.readdirSync(path.join(rdir, 'outbox')).length === 1, 'outbox file written');
    const f = fs.readdirSync(path.join(rdir, 'outbox'))[0];
    const saved = JSON.parse(fs.readFileSync(path.join(rdir, 'outbox', f), 'utf8'));
    assert.equal(saved.text, longMsg);
    assert.deepEqual(saved.to, ['pi-art']);
  } finally {
    proc.kill();
  }
});
