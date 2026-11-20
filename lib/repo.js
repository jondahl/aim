// Repo rooms: the room is a GitHub repository (optionally one branch of it), and the right to join
// is the right to read the repository. The room's Caprid Signing key lives in the hidden ref
// refs/aim/key (a commit holding key.json): not on any branch, not fetched by ordinary clones, and
// readable by exactly the people and agents who can read the repo. `aim init` (the owner, with a
// Caprid API key) creates it; `aim join` (anyone with git access) fetches it.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME } from './core.js';

const execFileAsync = promisify(execFile);

export const KEY_REF = 'refs/aim/key';

export function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

export async function gitAsync(args, opts = {}) {
  const { stdout } = await execFileAsync('git', args, { encoding: 'utf8', timeout: 15_000, ...opts });
  return stdout.trim();
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

/**
 * Parse a repo argument passed to `aim join`:
 *   owner/repo, gh/owner/repo, github.com/owner/repo (with optional @branch),
 *   or full https:// / ssh:// / git@ URLs.
 */
export function parseRepoArg(text) {
  if (!text) return undefined;
  const s = String(text).trim();
  if (/^(https?|ssh):\/\//.test(s) || /^git@/.test(s)) {
    const id = parseRemote(s);
    return id ? { ...id, remote: s, branch: undefined } : undefined;
  }
  const at = s.indexOf('@');
  const base = at >= 0 ? s.slice(0, at) : s;
  const branch = at >= 0 ? s.slice(at + 1) || undefined : undefined;
  const stripped = base.replace(/^(?:gh|github\.com)\//i, '');
  const parts = stripped.split('/');
  if (parts.length !== 2) return undefined;
  const id = parseRemote(`https://github.com/${parts[0]}/${parts[1]}`);
  if (!id) return undefined;
  return { ...id, remote: `https://github.com/${id.owner}/${id.repo}.git`, branch };
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

/** Non-blocking version of fetchKey for the daemon (so a slow git fetch never freezes the event loop). */
export async function fetchKeyAsync({ top, remote }) {
  let dir = top;
  let source = 'origin';
  if (!dir) {
    dir = path.join(HOME, 'git', createHash('sha256').update(remote).digest('hex').slice(0, 12));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await gitAsync(['init', '--bare', '-q', dir]);
    }
    source = remote;
  }
  try {
    await gitAsync(['-C', dir, 'fetch', '-q', '--no-tags', source, `+${KEY_REF}:${KEY_REF}`]);
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/couldn't find remote ref|not our ref|no such ref/i.test(msg)) return { missing: true };
    throw new Error(`git could not fetch ${KEY_REF}: ${msg.trim().split('\n').pop()}`);
  }
  const key = JSON.parse(await gitAsync(['-C', dir, 'show', `${KEY_REF}:key.json`]));
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

/**
 * Every cloud container would otherwise default to the same "claude-cloud" and collide: name it
 * claude-cloud-worker-<4 hex> from a hash of the harness session id, so it is distinct per session
 * and the same after a container restart (the remote session id outlives the container).
 */
export function cloudWorkerName(env = process.env) {
  const id = env.CLAUDE_CODE_REMOTE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_CONTAINER_ID;
  if (!id) return 'claude-cloud';
  return `claude-cloud-worker-${createHash('sha256').update(String(id)).digest('hex').slice(0, 4)}`;
}

/**
 * A default member name from the environment: AIM_NAME, else BD_ACTOR (the name the agent already
 * uses for beads claims, so it is one name everywhere), else which agent this looks like.
 */
export function defaultName(env = process.env) {
  const e = env;
  if (e.AIM_NAME) return e.AIM_NAME;
  if (e.BD_ACTOR && /^[a-z0-9][a-z0-9-]{0,31}$/.test(e.BD_ACTOR)) return e.BD_ACTOR;
  if (e.CLAUDE_CODE_REMOTE === 'true') return cloudWorkerName(e);
  if (e.CLAUDECODE) return 'claude';
  if (Object.keys(e).some((k) => k.startsWith('PI_'))) return 'pi';
  if (Object.keys(e).some((k) => k.startsWith('CODEX_'))) return 'codex';
  if (e.CURSOR_TRACE_ID || e.CURSOR_AGENT) return 'cursor';
  return undefined;
}
