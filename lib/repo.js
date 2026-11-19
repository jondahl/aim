// Repo rooms: the room is a GitHub repository (optionally one branch of it), and the right to join
// is the right to read the repository. The room's Caprid Signing key lives in the hidden ref
// refs/aim/key (a commit holding key.json): not on any branch, not fetched by ordinary clones, and
// readable by exactly the people and agents who can read the repo. `aim init` (the owner, with a
// Caprid API key) creates it; `aim join` (anyone with git access) fetches it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './core.js';

export const KEY_REF = 'refs/aim/key';

export function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

export function gitTry(args, opts) {
  try {
    return git(args, opts);
  } catch {
    return undefined;
  }
}

/**
 * owner/repo from a remote URL: https://github.com/o/r(.git), git@github.com:o/r.git,
 * ssh://git@github.com/o/r, and proxy URLs that end in /o/r (as cloud agent sandboxes use).
 */
export function parseRemote(url) {
  if (!url) return undefined;
  const m = String(url).trim().replace(/\/+$/, '').replace(/\.git$/, '').match(/[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return undefined;
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() };
}

/** The checkout around `cwd`: its top level, origin URL, repo and current branch. */
export function localRepo(cwd = process.cwd()) {
  const top = gitTry(['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (!top) return undefined;
  const remote = gitTry(['-C', top, 'remote', 'get-url', 'origin']);
  const id = parseRemote(remote);
  if (!id) return undefined;
  const branch = gitTry(['-C', top, 'symbolic-ref', '--short', 'HEAD']);
  return { top, remote, ...id, branch };
}

/** A relay path field for a branch name: '/' becomes ':', anything unusual becomes ~hex. */
export function branchField(branch) {
  return branch.replace(/[^A-Za-z0-9._-]/g, (c) => (c === '/' ? ':' : `~${c.codePointAt(0).toString(16)}`));
}

/** Where a repo room lives: relay path (below the Namespace), local id and display name. */
export function repoRoom(owner, repo, branch) {
  const base = `aim/gh/${owner}/${repo}`;
  return {
    path: branch ? `${base}/b/${branchField(branch)}` : base,
    keyPath: base,
    id: branch ? `${owner}~${repo}@${branchField(branch)}` : `${owner}~${repo}`,
    label: branch ? `${owner}/${repo}@${branch}` : `${owner}/${repo}`,
  };
}

/** A short Switchboard label for a repo's key: aimgh-<hash of owner/repo>-<time>. */
export function keyLabel(owner, repo) {
  return `${keyLabelPrefix(owner, repo)}${Date.now().toString(36)}`;
}
export function keyLabelPrefix(owner, repo) {
  return `aimgh-${createHash('sha256').update(`${owner}/${repo}`).digest('hex').slice(0, 10)}-`;
}

/**
 * Fetch refs/aim/key and return the key it holds. `where` is a checkout (uses its origin) or, with
 * no checkout, a URL fetched into a scratch bare repository under ~/.aim/git.
 */
export function fetchKey({ top, remote }) {
  let dir = top;
  let source = 'origin';
  if (!dir) {
    dir = path.join(HOME, 'git', createHash('sha256').update(remote).digest('hex').slice(0, 12));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      git(['init', '--bare', '-q', dir]);
    }
    source = remote;
  }
  try {
    git(['-C', dir, 'fetch', '-q', '--no-tags', source, `+${KEY_REF}:${KEY_REF}`]);
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/couldn't find remote ref|not our ref|no such ref/i.test(msg)) return { missing: true };
    throw new Error(`git could not fetch ${KEY_REF}: ${msg.trim().split('\n').pop()}`);
  }
  const key = JSON.parse(git(['-C', dir, 'show', `${KEY_REF}:key.json`]));
  for (const f of ['ns', 'kid', 'k', 'path']) if (typeof key[f] !== 'string') throw new Error(`${KEY_REF} has no ${f}`);
  return { key, dir };
}

/** Write key.json as a parentless commit and push it to refs/aim/key. */
export function pushKey(top, key) {
  const readme = [
    'This ref holds the Caprid Signing key for this repository\'s aim room (https://github.com/jondahl/aim).',
    'Anyone who can read the repository can join the room with `aim join`. Do not copy it elsewhere.',
    'Rotate it with `aim rotate` (deletes the old key on Caprid).',
    '',
  ].join('\n');
  const blob = (text) => git(['-C', top, 'hash-object', '-w', '--stdin'], { input: text });
  const tree = git(['-C', top, 'mktree'], { input: `100644 blob ${blob(`${JSON.stringify(key, null, 2)}\n`)}\tkey.json\n100644 blob ${blob(readme)}\tREADME.txt\n` });
  const commit = git(['-C', top, 'commit-tree', tree, '-m', 'aim room key'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'aim', GIT_AUTHOR_EMAIL: 'aim@localhost', GIT_COMMITTER_NAME: 'aim', GIT_COMMITTER_EMAIL: 'aim@localhost' },
  });
  git(['-C', top, 'push', '-q', '--force', 'origin', `${commit}:${KEY_REF}`]);
  git(['-C', top, 'update-ref', KEY_REF, commit]);
}

/** true if GitHub serves the repo to anonymous callers (so refs/aim/key would be world-readable). */
export async function isPublic(owner, repo) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'aim' } });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
  } catch {
    /* unknown */
  }
  return undefined;
}

/** A default member name from the environment: AIM_NAME, else which agent this looks like. */
export function defaultName() {
  const e = process.env;
  if (e.AIM_NAME) return e.AIM_NAME;
  if (e.CLAUDE_CODE_REMOTE === 'true') return 'claude-cloud';
  if (e.CLAUDECODE) return 'claude';
  if (Object.keys(e).some((k) => k.startsWith('PI_'))) return 'pi';
  if (Object.keys(e).some((k) => k.startsWith('CODEX_'))) return 'codex';
  if (e.CURSOR_TRACE_ID || e.CURSOR_AGENT) return 'cursor';
  return undefined;
}
