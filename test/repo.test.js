import assert from 'node:assert/strict';
import test from 'node:test';
import { branchField, parseRemote, repoRoom } from '../lib/repo.js';

test('remotes of every shape name the same repo', () => {
  const want = { owner: 'jondahl', repo: 'darklands-reboot' };
  for (const url of [
    'https://github.com/jondahl/darklands-reboot.git',
    'https://github.com/JonDahl/darklands-reboot',
    'git@github.com:jondahl/darklands-reboot.git',
    'ssh://git@github.com/jondahl/darklands-reboot',
    'http://local_proxy@127.0.0.1:43123/git/jondahl/darklands-reboot',
  ]) assert.deepEqual(parseRemote(url), want, url);
  assert.equal(parseRemote('not a url'), undefined);
});

test('branch rooms are one relay path field', () => {
  assert.equal(branchField('claude/m5-travel'), 'claude:m5-travel');
  assert.equal(branchField('a b'), 'a~20b');
  assert.deepEqual(repoRoom('o', 'r', 'feat/x'), { path: 'aim/gh/o/r/b/feat:x', keyPath: 'aim/gh/o/r', id: 'o~r@feat:x', label: 'o/r@feat/x' });
});
