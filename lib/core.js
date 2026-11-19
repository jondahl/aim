// Shared by the CLI and the daemon: where things live, the invite format, tokens and the log.
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AIM_HOME || path.join(os.homedir(), '.aim');
export const ROOMS = path.join(HOME, 'rooms');
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Room and member names: lowercase letters, digits and single hyphens, up to 32 characters. */
export function validName(s) {
  return typeof s === 'string' && NAME_RE.test(s) && !s.includes('--') && !s.endsWith('-');
}

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
  };
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
