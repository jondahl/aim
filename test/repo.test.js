import assert from 'node:assert/strict';
import test from 'node:test';
import { branchField, parseRemote, parseRepoArg, repoRoom } from '../lib/repo.js';

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

test('parseRepoArg accepts owner/repo, gh/owner/repo, github.com/owner/repo, @branch and URLs', () => {
  assert.deepEqual(parseRepoArg('jondahl/aim'), { owner: 'jondahl', repo: 'aim', remote: 'https://github.com/jondahl/aim.git', branch: undefined });
  assert.deepEqual(parseRepoArg('gh/jondahl/aim'), { owner: 'jondahl', repo: 'aim', remote: 'https://github.com/jondahl/aim.git', branch: undefined });
  assert.deepEqual(parseRepoArg('github.com/JonDahl/darklands-reboot'), { owner: 'jondahl', repo: 'darklands-reboot', remote: 'https://github.com/jondahl/darklands-reboot.git', branch: undefined });
  assert.deepEqual(parseRepoArg('gh/jondahl/darklands-reboot@feat/ui'), { owner: 'jondahl', repo: 'darklands-reboot', remote: 'https://github.com/jondahl/darklands-reboot.git', branch: 'feat/ui' });
  assert.deepEqual(parseRepoArg('git@github.com:jondahl/aim.git'), { owner: 'jondahl', repo: 'aim', remote: 'git@github.com:jondahl/aim.git', branch: undefined });
  assert.equal(parseRepoArg('just-a-word'), undefined);
});
