// Agent liveness: is the agent (its harness session) alive, not just its room daemon?
//
// Every aim process an agent runs refreshes a per-identity lease file, ~/.aim[/as/<name>]/lease.json:
//
//   { v: 1, sessions: { <sessionKey>: { pid, kind, ts, ttlMs } } }
//
// - sessionKey: the harness session (`claude:<id>`, `pi:<id>`, ...; `cli` when there is none).
// - pid: the harness process (Claude Code's CLAUDE_PID, the pi extension's AIM_HARNESS_PID), or
//   null when it is not known. While the pid is known the session is alive only while it runs, so
//   killing the harness reads as 'gone' at the daemon's next check (2 s), whatever the ttl says.
// - kind: who refreshed it: 'watch' and 'wait' (continuous: every LEASE_REFRESH_MS while they run)
//   or 'cli' (any other command the agent runs, hooks included).
// - ts / ttlMs: the entry counts for ttlMs after ts. Continuous refreshers use LEASE_TTL_MS (2 min);
//   a one-off CLI call uses LEASE_TTL_MS too, or LEASE_CLI_PID_TTL_MS when it knows a live harness
//   pid (an agent busy for a while between aim calls is still there while its harness runs).
//
// The daemon never refreshes the lease. It reads it (leaseState) every couple of seconds and
// publishes `agent: 'alive' | 'gone'` plus `leaseAgeMs` in its presence document; ages, not
// timestamps, so another member's clock does not matter.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, pidAlive, readJson, sessionKey, writePrivate } from './core.js';

export const LEASE_TTL_MS = 2 * 60_000;
export const LEASE_REFRESH_MS = 15_000;
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

/**
 * Record that this agent session is alive now. `kind`: 'watch' | 'wait' | 'cli'. Never throws.
 * Returns the entry written (or undefined on failure).
 */
export function refreshLease({ kind = 'cli', ttlMs, now = Date.now(), env = process.env, home = HOME } = {}) {
  try {
    const key = sessionKey(env) ?? 'cli';
    let pid = harnessPid(env);
    if (pid && !pidAlive(pid)) pid = null; // a stale variable: don't let it mark us gone
    const ttl = ttlMs ?? (kind === 'cli' && pid ? LEASE_CLI_PID_TTL_MS : LEASE_TTL_MS);
    const file = leaseFile(home);
    const cur = readJson(file, {});
    const sessions = cur && typeof cur.sessions === 'object' && cur.sessions ? { ...cur.sessions } : {};
    const prev = sessions[key];
    // A one-off CLI call must not shorten a longer lease the same session already holds.
    const keepUntil = prev && prev.pid === pid ? Number(prev.ts) + Number(prev.ttlMs) : 0;
    const entry = { pid, kind, ts: now, ttlMs: Math.max(ttl, keepUntil - now) };
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
export function entryAlive(e, now = Date.now(), isAlive = pidAlive) {
  if (!e || !Number.isFinite(Number(e.ts))) return false;
  if (now - Number(e.ts) >= Number(e.ttlMs || LEASE_TTL_MS)) return false;
  return e.pid ? isAlive(Number(e.pid)) : true;
}

/**
 * The agent's liveness from its lease file:
 *   { agent: 'alive' | 'gone' | 'unknown', leaseAgeMs, sessions }
 * 'alive': some session's entry is live. 'gone': there are entries and none is. 'unknown': no lease
 * file at all (the agent has run no aim command that writes one, e.g. an older aim). leaseAgeMs:
 * time since the newest refresh (null when unknown).
 */
export function leaseState({ now = Date.now(), home = HOME, isAlive = pidAlive } = {}) {
  const cur = readJson(leaseFile(home));
  const entries = cur && typeof cur.sessions === 'object' && cur.sessions ? Object.entries(cur.sessions) : [];
  if (!entries.length) return { agent: 'unknown', leaseAgeMs: null, sessions: 0 };
  const alive = entries.filter(([, e]) => entryAlive(e, now, isAlive));
  const newest = Math.max(...entries.map(([, e]) => Number(e.ts) || 0));
  return { agent: alive.length ? 'alive' : 'gone', leaseAgeMs: Math.max(0, now - newest), sessions: alive.length };
}
