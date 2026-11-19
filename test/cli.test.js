import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultName } from '../lib/repo.js';

const aim = new URL('../bin/aim.js', import.meta.url).pathname;

function run(args, { env = {}, input = '' } = {}) {
  const home = env.HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aim-cli-'));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIM_|PI_|CLAUDE|CODEX_|BD_)/.test(k)));
  return { home, out: execFileSync(process.execPath, [aim, ...args], { env: { ...clean, HOME: home, ...env }, input, encoding: 'utf8' }) };
}

test('names: AIM_NAME, then BD_ACTOR, then the harness', () => {
  assert.equal(defaultName({ AIM_NAME: 'a', BD_ACTOR: 'b', CLAUDECODE: '1' }), 'a');
  assert.equal(defaultName({ BD_ACTOR: 'b', CLAUDECODE: '1' }), 'b');
  assert.equal(defaultName({ BD_ACTOR: 'Not Valid', CLAUDECODE: '1' }), 'claude');
  assert.equal(defaultName({}), undefined);
});

test('hooks never deliver inside a subagent', () => {
  const { out } = run(['hook', 'post-tool-use'], { input: JSON.stringify({ agent_id: 'w1', agent_type: 'general-purpose', cwd: '/' }) });
  assert.equal(out, '');
});

test('aim hooks claude installs pinned hooks and --remove takes out only its own', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-cli-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { type: 'command', command: 'echo user-hook' };
  fs.writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [mine] }] } }));
  run(['hooks', 'claude'], { env: { HOME: home } });
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(installed.hooks.PostToolUse.length, 2);
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.match(installed.hooks.SessionStart[0].hooks[0].command, new RegExp(`--branch v${version.replace(/\./g, '\\.')} `));
  run(['hooks', 'claude', '--remove'], { env: { HOME: home } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'x', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [mine] }] } });
});
