// Agent liveness: is the agent (its harness session) alive, not just its room daemon?
//
// The agent's own aim commands refresh a per-identity lease file, ~/.aim[/as/<name>]/lease.json:
//
//   { v: 1, sessions: { <sessionKey>: { pid, scope, kind, ts, ttlMs } } }
//
// - sessionKey: the harness session (`claude:<id>`, `pi:<id>`, ...; `cli` when there is none).
// - pid: the harness process (the pi extension's AIM_HARNESS_PID, Claude Code's CLAUDE_PID), or
//   null when it is not known. While the pid is known the session is alive only while that process
//   runs, so killing the harness reads as 'gone' at the daemon's next check (2 s), whatever the ttl.
//   A harness pid that is known but not running never refreshes the lease: a process that outlived
//   its harness (an orphaned watcher) must not bring the agent back.
// - scope: where the pid means something (Linux: boot id + pid namespace; elsewhere: host + boot
//   time). An entry from another scope (a shared HOME, a restarted container) is judged by its ttl
//   alone, capped at LEASE_TTL_MS, never by a pid that may since have been reused.
// - kind: who refreshed it: 'watch' and 'wait' (every LEASE_REFRESH_MS while they run) or 'cli'
//   (send, read, doing, the hooks: see LEASE_COMMANDS in bin/aim.js).
// - ts / ttlMs: the entry counts for ttlMs after ts.
//   - LEASE_TTL_MS (90 s): watch/wait, and CLI calls without a known pid. With no pid, an agent
//     reads as gone at most 90 s (+ the daemon's 2 s check) after its last refresh.
//   - LEASE_CLI_PID_TTL_MS (15 min): a CLI call with a live, known harness pid. Deliberately longer
//     than the bead's 2 min (neon's review): an agent working between aim calls, with no watcher, is
//     still there while its harness runs, and the pid check still reports a killed harness at once.
//
// The daemon never refreshes the lease. It reads it (leaseState) every couple of seconds and
// publishes `agent: 'alive' | 'gone'` plus `leaseAgeMs` in its presence document; ages, not
// timestamps, so another member's clock does not matter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AS, HOME, boundName, readJson, sessionKey, writePrivate } from './core.js';

export const LEASE_TTL_MS = 90_000;
export const LEASE_REFRESH_MS = 10_000;
export const LEASE_CLI_PID_TTL_MS = 15 * 60_000;
const FORGET_MS = 24 * 3600_000; // drop entries this long expired

export const leaseFile = (home = HOME) => path.join(home, 'lease.json');

/** The harness process this aim process runs under, when the harness says: AIM_HARNESS_PID, then Claude Code's CLAUDE_PID. */
export function harnessPid(env = process.env) {
  for (const v of [env.AIM_HARNESS_PID, env.CLAUDE_PID]) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 1) return n;
  }
  return null;
}

/** A process we can signal is running. Unlike core's pidAlive, EPERM (someone else's process: a reused pid) is not ours. */
export function harnessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let scopeCache;
/** Where pids are comparable: the boot and the pid namespace on Linux, the host and its boot time elsewhere. */
export function pidScope() {
  if (scopeCache) return scopeCache;
  let s;
  try {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    let ns = '';
    try {
      ns = fs.readlinkSync('/proc/self/ns/pid');
    } catch {}
    s = `${boot}/${ns}`;
  } catch {
    s = `${os.hostname()}/${Math.round((Date.now() / 1000 - os.uptime()) / 60)}`; // boot time, to the minute
  }
  scopeCache = s;
  return s;
}

/**
 * Whether this process may refresh the lease of the identity it runs as: not when it acts for
 * another identity (AIM_NO_BIND, or a harness session bound to a different name).
 */
export function ownsLease(env = process.env, as = AS) {
  if (env.AIM_NO_BIND) return false;
  const key = sessionKey(env);
  if (!key) return true;
  const bound = boundName(key);
  return !bound || bound === as;
}

/**
 * Record that this agent session is alive now. `kind`: 'watch' | 'wait' | 'cli'. Never throws.
 * Returns the entry written, or undefined when nothing was written (the known harness is not
 * running, or a write failed).
 */
export function refreshLease({ kind = 'cli', ttlMs, now = Date.now(), env = process.env, home = HOME, isAlive = harnessAlive, scope = pidScope() } = {}) {
  try {
    const key = sessionKey(env) ?? 'cli';
    const pid = harnessPid(env);
    if (pid && !isAlive(pid)) return undefined; // the harness is gone: whatever still runs is not the agent
    const ttl = ttlMs ?? (kind === 'cli' && pid ? LEASE_CLI_PID_TTL_MS : LEASE_TTL_MS);
    const file = leaseFile(home);
    const cur = readJson(file, {});
    const sessions = cur && typeof cur.sessions === 'object' && cur.sessions ? { ...cur.sessions } : {};
    const prev = sessions[key];
    // A one-off CLI call must not shorten a longer lease the same harness already holds.
    const keepUntil = prev && prev.pid === pid && prev.scope === scope ? Number(prev.ts) + Number(prev.ttlMs) : 0;
    const entry = { pid, scope, kind, ts: now, ttlMs: Math.max(ttl, keepUntil - now) };
    sessions[key] = entry;
    for (const [k, e] of Object.entries(sessions)) if (now - (Number(e.ts) + Number(e.ttlMs)) > FORGET_MS) delete sessions[k];
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    writePrivate(file, JSON.stringify({ v: 1, sessions }));
    return entry;
  } catch {
    return undefined;
  }
}

/** Is one lease entry live now? */
export function entryAlive(e, now = Date.now(), isAlive = harnessAlive, scope = pidScope()) {
  if (!e || !Number.isFinite(Number(e.ts))) return false;
  const age = now - Number(e.ts);
  const ttl = Number(e.ttlMs || LEASE_TTL_MS);
  if (!e.pid) return age < ttl;
  // A pid from elsewhere (another machine sharing HOME, a container before its restart) says nothing.
  if (e.scope !== scope) return age < Math.min(ttl, LEASE_TTL_MS);
  return age < ttl && isAlive(Number(e.pid));
}

/**
 * The agent's liveness from its lease file:
 *   { agent: 'alive' | 'gone' | 'unknown', leaseAgeMs, sessions }
 * 'alive': some session's entry is live. 'gone': there are entries and none is. 'unknown': no lease
 * file at all (the agent has run no aim command that writes one, e.g. an older aim). leaseAgeMs:
 * time since the newest refresh (null when unknown).
 */
export function leaseState({ now = Date.now(), home = HOME, isAlive = harnessAlive, scope = pidScope() } = {}) {
  const cur = readJson(leaseFile(home));
  const entries = cur && typeof cur.sessions === 'object' && cur.sessions ? Object.entries(cur.sessions) : [];
  if (!entries.length) return { agent: 'unknown', leaseAgeMs: null, sessions: 0 };
  const alive = entries.filter(([, e]) => entryAlive(e, now, isAlive, scope));
  const newest = Math.max(...entries.map(([, e]) => Number(e.ts) || 0));
  return { agent: alive.length ? 'alive' : 'gone', leaseAgeMs: Math.max(0, now - newest), sessions: alive.length };
}
