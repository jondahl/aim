// 0.6.6: a daemon that lives but stopped working is replaced; `who` doesn't report an empty roster
// from a daemon that is not connected yet. A sleeping node process stands in for the daemon.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const aim = new URL('../bin/aim.js', import.meta.url).pathname;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));

function roomWithFakeDaemon(stateAgeMs, status = 'live') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-health-'));
  const dir = path.join(home, '.aim', 'rooms', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 1, room: 'r1', label: 'r1', name: 'me', joinedAt: 0 }));
  const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'daemon.pid'), String(fake.pid));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: fake.pid, room: 'r1', name: 'me', status, online: [], known: ['peer'], updated: Date.now() - stateAgeMs }));
  return { home, fake, env: { ...clean, HOME: home, AIM_NO_DAEMON: '1' } };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a daemon whose state has not moved for a minute is ended so a fresh one can start', async () => {
  const { fake, env } = roomWithFakeDaemon(60_000);
  // The stand-in is our child: once ended it is a zombie until reaped, so watch its exit event.
  const ended = new Promise((r) => fake.on('exit', (code, sig) => r(sig ?? code)));
  try {
    execFileSync(process.execPath, [aim, 'read'], { env }); // anything that uses the daemon
    const how = await Promise.race([ended, new Promise((r) => setTimeout(() => r('still running'), 5000))]);
    assert.equal(how, 'SIGTERM', 'the hung daemon was ended');
  } finally {
    fake.kill('SIGKILL');
  }
});

test('a daemon that writes its state is left alone', () => {
  const { fake, env } = roomWithFakeDaemon(1000);
  try {
    execFileSync(process.execPath, [aim, 'read'], { env });
    assert.equal(alive(fake.pid), true);
  } finally {
    fake.kill('SIGKILL');
  }
});

test('who from a daemon that is not connected says so instead of listing everyone offline', () => {
  const { fake, env } = roomWithFakeDaemon(1000, 'connecting (publisher connecting)');
  try {
    const json = JSON.parse(execFileSync(process.execPath, [aim, 'who', '--json'], { env, encoding: 'utf8' }));
    assert.equal(json.loading, true);
    const text = execFileSync(process.execPath, [aim, 'who'], { env, encoding: 'utf8' });
    assert.match(text, /not connected yet/);
  } finally {
    fake.kill('SIGKILL');
  }
});
