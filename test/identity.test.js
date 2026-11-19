import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const core = new URL('../lib/core.js', import.meta.url).href;

// HOME is fixed when lib/core.js loads, so each case runs in a fresh process with its own env.
function probe(env, code) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-id-'));
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
