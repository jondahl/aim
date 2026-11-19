// Shared by the CLI and the daemon: where things live, the invite format, tokens and the log.
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Room and member names: lowercase letters, digits and single hyphens, up to 32 characters. */
export function validName(s) {
  return typeof s === 'string' && NAME_RE.test(s) && !s.includes('--') && !s.endsWith('-');
}

/** Machine-wide state, whatever identity a process uses: session bindings, the pi session registry. */
export const ROOT = path.join(os.homedir(), '.aim');

/** The identity an AIM_HOME of the form ~/.aim/as/<name> stands for (the older way to name an agent). */
function nameOfHome(home) {
  const r = path.resolve(home);
  return path.dirname(r) === path.join(ROOT, 'as') && validName(path.basename(r)) ? path.basename(r) : null;
}
/** The name this process was given explicitly: AIM_NAME, or an AIM_HOME under ~/.aim/as/. */
export function envName(env = process.env) {
  if (validName(env.AIM_NAME)) return env.AIM_NAME;
  return env.AIM_HOME ? nameOfHome(env.AIM_HOME) : null;
}
/**
 * Several agents on one machine: AIM_NAME=<name> gives each its own identity, with its own rooms,
 * daemons, log and read cursor under ~/.aim/as/<name>. Without it every agent on the machine shares
 * ~/.aim and the others see them as one member. AIM_HOME, when set, wins (used as is).
 */
export const AS = envName() ?? (process.env.AIM_HOME ? null : boundName());

// ---- session -> identity bindings, for processes that can't see the agent's AIM_NAME ----
// An agent may set AIM_NAME only in its shell commands; its harness (e.g. the pi extension running
// `aim watch`) doesn't see that. Any aim command run with a name in a harness session records the
// name for that session, and processes of the same session (given the session id) resolve it.
// Bindings are machine-wide (~/.aim/sessions), never under AIM_HOME: the process that looks them up
// is exactly the one that doesn't know the agent's AIM_HOME.
function bindingFile(key) {
  return path.join(ROOT, 'sessions', key.replace(/[^A-Za-z0-9._-]/g, '_'));
}
/** The identity recorded for this harness session, if any. */
export function boundName(key = sessionKey()) {
  if (!key) return null;
  try {
    const n = fs.readFileSync(bindingFile(key), 'utf8').trim();
    return validName(n) ? n : null;
  } catch {
    return null;
  }
}
export function bindSession(name, key = sessionKey()) {
  if (!key || !validName(name) || boundName(key) === name) return;
  try {
    writePrivate(bindingFile(key), name);
  } catch {}
}
/** The identity this process should use now (it changes when a binding appears). */
export function wantedIdentity() {
  if (process.env.AIM_HOME || validName(process.env.AIM_NAME)) return AS; // fixed by the environment
  return boundName();
}
export const HOME = process.env.AIM_HOME ? path.resolve(process.env.AIM_HOME) : AS ? path.join(ROOT, 'as', AS) : ROOT;
export const ROOMS = path.join(HOME, 'rooms');

export function die(msg, code = 1) {
  process.stderr.write(`aim: ${msg}\n`);
  process.exit(code);
}

export function roomDir(room) {
  return path.join(ROOMS, room);
}

export function files(room) {
  const d = roomDir(room);
  return {
    dir: d,
    config: path.join(d, 'config.json'),
    log: path.join(d, 'log.jsonl'),
    cursor: path.join(d, 'cursor'),
    outbox: path.join(d, 'outbox'),
    state: path.join(d, 'state.json'),
    pid: path.join(d, 'daemon.pid'),
    daemonLog: path.join(d, 'daemon.log'),
    listening: path.join(d, 'listening'),
  };
}

// ---- listening: a process that delivers this identity's messages to its agent as they arrive ----
// (aim watch under the pi extension, `aim wait` as a background task). It touches this file while it
// runs; the daemon tells the room, so senders see whether anyone will actually read what they send.
export const LISTEN_FRESH_MS = 45_000;
export function touchListening(room, kind) {
  try {
    writePrivate(files(room).listening, JSON.stringify({ kind, pid: process.pid, ts: Date.now() }));
  } catch {}
}
export function listeningNow(room, now = Date.now()) {
  const l = readJson(files(room).listening);
  if (!l) return false;
  const age = now - Number(l.ts);
  // A wait exits after delivering and the agent starts it again: count the gap as listening.
  return age < 10_000 || (age < LISTEN_FRESH_MS && pidAlive(Number(l.pid)));
}

export function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function newId() {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

// ---- invites: aim1_<base64url(JSON)>; a Caprid Signing key scoped to one room and one name ----

export function encodeInvite({ ns, room, name, kid, k }) {
  return `aim1_${Buffer.from(JSON.stringify({ ns, room, name, kid, k })).toString('base64url')}`;
}

export function decodeInvite(text) {
  const m = String(text).trim().match(/aim1_[A-Za-z0-9_-]+/);
  if (!m) throw new Error('that is not an aim invite (it starts with aim1_)');
  const inv = JSON.parse(Buffer.from(m[0].slice(5), 'base64url').toString('utf8'));
  for (const f of ['ns', 'room', 'name', 'kid', 'k']) if (typeof inv[f] !== 'string' || !inv[f]) throw new Error(`invite is missing ${f}`);
  return inv;
}

// ---- Client tokens: HS256 JWTs signed locally with the room key (Caprid "Sign your own") ----

export function roomRoot(cfg) {
  return `${cfg.ns}/${cfg.path ?? `aim/${cfg.room}`}`;
}

export function mintToken(cfg, ttlSeconds = 2 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: cfg.kid };
  const claims = { root: roomRoot(cfg), put: [`u/${cfg.name}`], get: [''], iat: now, exp: now + ttlSeconds };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64(header)}.${b64(claims)}`;
  const sig = createHmac('sha256', Buffer.from(cfg.k, 'base64url')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// ---- the room log: one JSON object per line, appended only by the daemon ----
// {kind:'in'|'out', id, from, to, text, ts}  messages
// {kind:'ack', id, by, ts}                    a peer confirmed an 'out' message

export function readLog(room) {
  let text;
  try {
    text = fs.readFileSync(files(room).log, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line; the daemon will finish it */
    }
  }
  return out;
}

export function listRooms() {
  try {
    return fs.readdirSync(ROOMS).filter((r) => fs.existsSync(files(r).config));
  } catch {
    return [];
  }
}

export function loadConfig(room) {
  const cfg = readJson(files(room).config);
  if (!cfg) die(`not in room "${room}" (aim join <invite> first)`);
  return cfg;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---- agent sessions sharing one identity (the trap AIM_NAME avoids) ----

/** The harness session this process runs in, if the harness says (pi, Claude Code, Codex). */
export function sessionKey(env = process.env) {
  if (env.PI_SESSION_ID) return `pi:${env.PI_SESSION_ID}`;
  if (env.CLAUDE_SESSION_ID) return `claude:${env.CLAUDE_SESSION_ID}`;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude:${env.CLAUDE_CODE_SESSION_ID}`;
  if (env.CODEX_SESSION_ID) return `codex:${env.CODEX_SESSION_ID}`;
  return null;
}

const SHARED_WINDOW_MS = 30 * 60 * 1000;

/**
 * Note that this agent session used this identity; return the other sessions that used it in the
 * last 30 minutes (they would all speak, and read, as one member).
 */
/** A session that has since been given another name no longer shares this identity. */
export function boundElsewhere(key) {
  const n = boundName(key);
  return Boolean(n && n !== AS);
}

// ---- one listener per identity: two watchers on one read cursor would split its messages ----
// The lock names the watcher's pid and session. A watcher whose lock is held by another live
// process waits; when the holder dies, its own session gets 3 s to take the lock back first (a
// watcher restarting after an upgrade), then anyone may.
const LOCK = () => path.join(HOME, 'watch.json');
export function tryListenLock(key = sessionKey(), now = Date.now()) {
  const l = readJson(LOCK());
  if (l && l.pid !== process.pid) {
    if (pidAlive(Number(l.pid))) return { ok: false, holder: l };
    if (l.key && l.key !== key && now - Number(l.diedSeen ?? now) < 3000) {
      if (!l.diedSeen) writePrivate(LOCK(), JSON.stringify({ ...l, diedSeen: now }));
      return { ok: false, holder: l };
    }
  }
  if (!l || l.pid !== process.pid) writePrivate(LOCK(), JSON.stringify({ pid: process.pid, key, ts: now }));
  return { ok: readJson(LOCK())?.pid === process.pid };
}

export function noteSession(now = Date.now(), key = sessionKey()) {
  if (!key) return [];
  const file = path.join(HOME, 'sessions.json');
  const seen = readJson(file, {});
  const others = Object.entries(seen)
    .filter(([k, t]) => k !== key && now - t < SHARED_WINDOW_MS && !boundElsewhere(k))
    .map(([k, t]) => ({ key: k, ago: now - t }));
  const keep = Object.fromEntries(Object.entries(seen).filter(([, t]) => now - t < SHARED_WINDOW_MS));
  keep[key] = now;
  try {
    writePrivate(file, JSON.stringify(keep));
  } catch {}
  return others;
}
