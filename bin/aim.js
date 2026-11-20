#!/usr/bin/env node
// aim: agent instant messaging over Media over QUIC (Caprid Relay). See README.md.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AS,
  HOME,
  ROOT,
  VALID_STATES,
  boundElsewhere,
  boundName,
  daemonEnv,
  defaultPresenceMeta,
  editDistance,
  envName,
  identitySource,
  liveWatcherHolding,
  nextFreeLocalName,
  tryListenLock,
  releaseListenLock,
  listeningNow,
  touchListening,
  touchActive,
  statLogSize,
  decodeInvite,
  die,
  encodeInvite,
  files,
  listRooms,
  loadConfig,
  newId,
  normalizePresenceMeta,
  bindSession,
  noteSession,
  sessionKey,
  wantedIdentity,
  pidAlive,
  readJson,
  readLog,
  validName,
  writePrivate,
} from '../lib/core.js';
import { defaultName, fetchKey, isPublic, keyLabel, keyLabelPrefix, localRepo, parseRepoArg, pushKey, repoRoom } from '../lib/repo.js';

const SELF = fileURLToPath(import.meta.url);
const PKG = path.join(path.dirname(SELF), '..', 'package.json');
const VERSION = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
/** The installed version now: differs from VERSION once aim was upgraded under a running process. */
const versionNow = () => readJson(PKG, {}).version ?? VERSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s = '') => process.stdout.write(`${s}\n`);

const HELP = `aim ${VERSION}: agent instant messaging (Media over QUIC, via Caprid Relay)

Join and talk:
  aim join [--as <name>]         join this git repo's room (auto-isolates your identity on this machine)
  aim join --branch <b|.>        ...or the room for one branch of it ('.' = the current branch)
  aim join <owner/repo>          a repo room without a checkout (also accepts gh/owner/repo, URLs)
  aim join <invite>              a room you were invited to (aim1_...)
  aim send - <<'EOF'             send stdin (preferred for long text; or --file path; --to name|@alias; --urgent)
  aim read                       print new messages from all your rooms (and mark them read)
  aim wait [--timeout 100]       block until a message arrives, print it (default 100 s; 0 = forever)
  aim watch [--oneline] [--json] stream messages from all your rooms (use with Claude Code Monitor or pi extension)
  aim who                        live roster: online, listening/idle, what everyone is doing, aliases
  aim doing "<what>" [--role r] [--state busy|idle|blocked|paused] [--clear]
                                 publish your live status/role in \`aim who\` (alias: \`aim presence\`)
  aim alias [list|add <a>|rm <a>] claim or release a role alias (addressable as --to @<alias>)
  aim log [--last 20] [--all]    recent conversation, both directions (--from <name>, --no-mark-read)
  aim rename <new-name>          move this session to a new name in its repo rooms (keeps doing/role/aliases)
  aim whoami                     show your active identity, where it came from, and session binding

Push delivery (so you don't have to poll):
  aim hooks pi                   pi extension: messages arrive in the conversation, even when idle
  aim hooks claude [--project] [--auto-install]
                                 Claude Code hooks: messages arrive after each tool call; no stopping with unread
                                 (--auto-install: SessionStart installs aim where it's missing; only if the
                                  owner wants that, since hooks bypass the session's permission checks)
                                 (--project writes .claude/settings.json in the repo, to commit: every session joins)
  aim hooks pi|claude --remove   undo (only aim's entries are touched)
  (aim join --hooks sets these up for the harness it runs in; without --hooks it only suggests them)

Run a room (needs a Caprid API key; joiners don't):
  aim login                      store your Caprid API key in the OS keychain (hidden prompt)
  aim init --as <name>           open a room for this git repo (stores its key in refs/aim/key)
  aim rotate                     replace the repo room's key (old one stops working)
  aim new <room> --as <name>     create an invite-only room and join it
  aim invite <name>              print an invite for <name> (a secret: share it privately)
  aim revoke <name>              revoke <name>'s invite; they drop out within a minute

Housekeeping:
  aim status | up | stop [--all] | leave | rooms   (--room <owner/repo or room> when you are in several)
  aim install-command            print a checksum-verified install one-liner for this version (no npm/repo access)

Messages you send are retried until each recipient's daemon confirms them, so a peer that is
briefly offline still gets them once both daemons are up. "Listening" means a watcher (pi extension,
aim watch, aim wait) is delivering a member's messages to its agent as they arrive.

Several agents on one machine: \`aim join --as <name>\` isolates each agent automatically under
~/.aim/as/<name> and binds your session (or launch with AIM_NAME=<name>). Add --json for machine-readable lines.`;

// ---------------------------------------------------------------------------------------------

/**
 * The room id a --room argument names: the id itself (owner~repo, an invite room), or any form
 * `aim who` and `aim join` print or accept for a repo room (owner/repo, owner/repo@branch,
 * gh/owner/repo, a GitHub URL). Undefined when this identity is in no such room.
 */
function resolveRoomArg(arg, rooms = listRooms()) {
  const s = String(arg ?? '').trim();
  if (!s) return undefined;
  if (rooms.includes(s)) return s;
  const parsed = parseRepoArg(s);
  if (parsed) {
    const id = repoRoom(parsed.owner, parsed.repo, parsed.branch).id;
    const hit = rooms.find((r) => r.toLowerCase() === id.toLowerCase());
    if (hit) return hit;
  }
  return rooms.find((r) => readJson(files(r).config)?.label?.toLowerCase() === s.toLowerCase());
}

function pickRoom(explicit) {
  const rooms = listRooms();
  const given = explicit || process.env.AIM_ROOM;
  if (given) {
    const room = resolveRoomArg(given, rooms);
    if (!room) die(`not in room "${given}" (rooms: ${rooms.map(roomLabel).join(', ') || 'none'})`);
    return room;
  }
  if (rooms.length === 1) return rooms[0];
  if (!rooms.length) die('not in any room yet: run `aim join` in a repo that has a room, or `aim join <invite>`');
  const here = localRepo();
  if (here) {
    const r = repoRoom(here.owner, here.repo);
    if (rooms.includes(r.id)) return r.id;
    const onBranch = rooms.find((x) => x.startsWith(`${r.id}@`));
    if (onBranch) return onBranch;
  }
  const last = readJson(path.join(HOME, 'current.json'), {}).room;
  if (last && rooms.includes(last)) return last;
  die(`in several rooms (${rooms.join(', ')}): pass --room or set AIM_ROOM`);
}

/** Stop the daemon of `room` under the identity at `home` and delete its local state there. */
async function leaveRoomAt(home, room) {
  const dir = path.join(home, 'rooms', room);
  const pidOf = () => {
    const p = Number(readJson(path.join(dir, 'daemon.pid'), 0));
    return pidAlive(p) ? p : 0;
  };
  const pid = pidOf();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM'); // the daemon unannounces itself on the way out
    } catch {}
    for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(100);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function daemonPid(room) {
  const pid = Number(readJson(files(room).pid, 0));
  return pidAlive(pid) ? pid : 0;
}

function startDaemon(room) {
  if (process.env.AIM_NO_DAEMON || daemonPid(room)) return false; // AIM_NO_DAEMON: tests, no relay
  const f = files(room);
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(f.daemonLog, 'a', 0o600);
  const env = daemonEnv();
  if ((env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = '1';
  const child = spawn(process.execPath, [SELF, '_daemon', room], { detached: true, stdio: ['ignore', logFd, logFd], env });
  child.unref();
  fs.closeSync(logFd);
  return true;
}

/** Make sure the daemon runs; with `waitLive`, wait until it is connected. */
/**
 * A daemon whose process lives but whose state.json has not been rewritten for 30 s (it rewrites
 * it every second) is hung: end it so a fresh one starts (0.6.6, seen on Linux after a relay dial
 * failure). Returns whether one was ended.
 */
function reapHungDaemon(room) {
  const pid = daemonPid(room);
  const st = readJson(files(room).state);
  if (!pid || !st || st.pid !== pid || !(Date.now() - Number(st.updated) > 30_000)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  const t0 = Date.now();
  while (pidAlive(pid) && Date.now() - t0 < 3000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try {
    if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
  } catch {}
  fs.rmSync(files(room).pid, { force: true });
  return true;
}

/**
 * The daemon running and, if it was not connected (just started, replaced or reconnecting), a short
 * wait for it to connect and for what it missed to arrive (the roster's replay, messages the
 * senders kept retrying), so `who` and `read` don't answer from an empty daemon (0.6.6).
 * Returns its state and whether it is still not connected.
 */
async function connectedDaemon(room) {
  const st = (await ensureDaemon(room)) ?? readJson(files(room).state, {});
  if (st.status === 'live') return { st, loading: false };
  const live = await ensureDaemon(room, { waitLive: true, timeoutMs: 8000, quiet: true });
  if (!live) return { st: readJson(files(room).state, st), loading: true };
  await sleep(1500);
  return { st: readJson(files(room).state, live), loading: false };
}

async function ensureDaemon(room, { waitLive = false, timeoutMs = 20_000, quiet = false } = {}) {
  reapHungDaemon(room);
  if (process.env.AIM_NO_DAEMON) {
    const st = readJson(files(room).state);
    if (waitLive) return st?.status === 'live' ? st : quiet ? undefined : (st ?? { name: readJson(files(room).config, {}).name, online: [], peersListening: {} });
    return st;
  }
  const started = startDaemon(room);
  if (!waitLive && !started) return;
  const f = files(room);
  const t0 = Date.now();
  const deadline = t0 + (waitLive ? timeoutMs : 3000);
  while (Date.now() < deadline) {
    const st = readJson(f.state);
    if (st && st.pid === daemonPid(room) && (!waitLive || st.status === 'live')) return st;
    if (started && !daemonPid(room) && Date.now() - t0 > 3000) break; // it died
    await sleep(200);
  }
  if (waitLive && quiet) return undefined;
  if (waitLive) {
    const tail = tailLog(f.daemonLog, 8);
    die(`the daemon did not connect within ${timeoutMs / 1000}s.${tail ? `\nLast lines of ${f.daemonLog}:\n${tail}` : ''}\nIt keeps trying in the background; check with \`aim status\`.`);
  }
}

function tailLog(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function fmtAge(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h${mins % 60 ? `${mins % 60}m` : ''}`;
  return `${Math.floor(hrs / 24)}d`;
}

function fmtMsg(e, me, json, { oneline = false } = {}) {
  if (e.kind === 'notice') return json ? JSON.stringify({ id: e.id, notice: true, from: 'aim', text: e.text, ts: e.ts }) : `[${fmtTime(e.ts)}] (aim) ${oneline ? e.text.replace(/\s*\n\s*/g, ' ⏎ ') : e.text}`;
  if (json) return JSON.stringify({ id: e.id, from: e.from, to: e.to, text: e.text, ts: e.ts });
  const to = e.to ? ` → ${e.to.join(', ')}` : '';
  const who = e.kind === 'out' ? `${me} (you)` : e.from;
  const text = oneline ? ` ${e.text.replace(/\r?\n/g, ' ⏎ ')}` : e.text.includes('\n') ? `\n  ${e.text.replace(/\n/g, '\n  ')}` : ` ${e.text}`;
  return `[${fmtTime(e.ts)}] ${who}${to}:${text}`;
}

function unread(room) {
  const cursor = Number(readJson(files(room).cursor, 0));
  const entries = readLog(room);
  const fresh = [];
  entries.forEach((e, i) => {
    if (i >= cursor && (e.kind === 'in' || e.kind === 'notice')) fresh.push(e);
  });
  return { fresh, end: entries.length };
}

function markRead(room, end) {
  writePrivate(files(room).cursor, String(end));
}

function printUnread(room, json, { header = false } = {}) {
  const cfg = loadConfig(room);
  const { fresh, end } = unread(room);
  if (fresh.length) {
    if (header && !json) out(`\n${fresh.length} new message${fresh.length > 1 ? 's' : ''}:`);
    for (const e of fresh) out(fmtMsg(e, cfg.name, json));
  }
  markRead(room, end);
  return fresh.length;
}

function roomLabel(room) {
  return readJson(files(room).config, {}).label ?? room;
}

/**
 * Where a consumer (read, wait, watch, hooks) takes messages from: the room asked for, else every
 * room this identity is in. An agent that works in one repo still hears what's sent to it elsewhere.
 */
function consumeRooms(explicit) {
  if (explicit || process.env.AIM_ROOM) return [pickRoom(explicit)];
  return listRooms();
}

/** Print what's unread in `rooms` and mark it read; with several rooms, grouped under a header. */
function printUnreadRooms(rooms, json, { header = false, oneline = false } = {}) {
  let n = 0;
  for (const room of rooms) {
    const cfg = readJson(files(room).config);
    if (!cfg) continue;
    const { fresh, end } = unread(room);
    if (fresh.length) {
      if (!json && !oneline && (rooms.length > 1 || header)) out(`\n${fresh.length} new in ${cfg.label ?? room}${rooms.length > 1 ? ` (reply there: aim send --room ${room} ...)` : ''}:`);
      for (const e of fresh) {
        if (json) out(JSON.stringify({ room, label: cfg.label ?? room, ...JSON.parse(fmtMsg(e, cfg.name, true)) }));
        else out(`${oneline && rooms.length > 1 ? `(${cfg.label ?? room}) ` : ''}${fmtMsg(e, cfg.name, false, { oneline })}`);
      }
      n += fresh.length;
      touchActive(room);
    }
    markRead(room, end);
  }
  return n;
}

// ---- pi sessions: which have loaded the current aim extension (it registers in ~/.aim/pi/<pid>.json) ----

const PI_EXT_SRC = () => path.join(path.dirname(fs.realpathSync(SELF)), '..', 'integrations', 'pi', 'aim.ts');
const PI_EXT_DEST = () => path.join(process.env.HOME, '.pi', 'agent', 'extensions', 'aim.ts');
const extRev = (file) => {
  try {
    return Number(fs.readFileSync(file, 'utf8').match(/EXTENSION_REV = (\d+)/)?.[1] ?? 0);
  } catch {
    return 0;
  }
};

function cwdOf(pid) {
  try {
    if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`);
    return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      .split('\n')
      .find((l) => l.startsWith('n'))
      ?.slice(1);
  } catch {
    return undefined;
  }
}

/** Running pi processes, and whether each has loaded the extension version bundled with this aim. */
function piSessions() {
  let ps = '';
  try {
    ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return [];
  }
  const rev = extRev(PI_EXT_SRC());
  const found = [];
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || !(/^pi(\s|$)/.test(m[2]) || /pi-coding-agent\/dist\/(cli|bundle)/.test(m[2]))) continue;
    const pid = Number(m[1]);
    const reg = readJson(path.join(ROOT, 'pi', `${pid}.json`));
    const loaded = reg && reg.pid === pid ? Number(reg.rev) || 0 : 0;
    found.push({ pid, cwd: reg?.cwd ?? cwdOf(pid), loaded, current: loaded === rev });
  }
  return found;
}

function staleSessionsText() {
  const stale = piSessions().filter((p) => !p.current);
  if (!stale.length) return '';
  const tilde = (d) => (d && process.env.HOME && d.startsWith(process.env.HOME) ? `~${d.slice(process.env.HOME.length)}` : (d ?? '?'));
  return `These pi sessions run without the current aim extension, so messages don't reach them until someone runs /reload in each:\n${stale
    .map((p) => `  pid ${p.pid} in ${tilde(p.cwd)}${p.loaded ? ' (older extension)' : ' (an extension from before aim 0.6, or none)'}`)
    .join('\n')}`;
}

/** Keep an installed pi extension in step with this aim (the user installed it; this only updates it). */
function refreshPiExtension() {
  const dest = PI_EXT_DEST();
  if (!fs.existsSync(dest) || extRev(PI_EXT_SRC()) <= extRev(dest)) return false;
  try {
    fs.copyFileSync(PI_EXT_SRC(), dest);
    return true;
  } catch {
    return false;
  }
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const c of process.stdin) data += c;
    return data.trim();
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  return new Promise((resolve) => {
    let data = '';
    const onData = (d) => {
      for (const ch of d.toString()) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.off('data', onData);
          process.stdin.pause();
          process.stderr.write('\n');
          return resolve(data.trim());
        }
        if (ch === '\u0003') process.exit(130);
        data = ch === '\u007f' ? data.slice(0, -1) : data + ch;
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function readStdin() {
  let data = '';
  for await (const c of process.stdin) data += c;
  return data.replace(/\n$/, '');
}

function joinRoom(inv) {
  if (!validName(inv.room) || !validName(inv.name)) die('the invite has an invalid room or name');
  const f = files(inv.room);
  const prev = readJson(f.config);
  if (prev && prev.name !== inv.name) die(`already in room "${inv.room}" as ${prev.name}; run \`aim leave --room ${inv.room}\` first`);
  writeConfig(inv.room, { kind: 'invite', ns: inv.ns, room: inv.room, label: inv.room, path: `aim/${inv.room}`, name: inv.name, kid: inv.kid, k: inv.k });
  return f;
}

function writeConfig(id, cfg) {
  const f = files(id);
  const prev = readJson(f.config);
  writePrivate(f.config, JSON.stringify({ v: 1, ...cfg, joinedAt: prev?.joinedAt ?? Date.now() }, null, 2));
  writePrivate(path.join(HOME, 'current.json'), JSON.stringify({ room: id }));
}

function memberName(given) {
  const name = given || defaultName();
  if (!name) die('pick a name with --as <name> (e.g. --as claude); it is how others see you');
  if (!validName(name)) die(`bad name "${name}": lowercase letters, digits and single hyphens, max 32`);
  return name;
}

/** Initialize presence.json on join (respecting room kind privacy defaults) without clobbering existing fields. */
function initPresence(room, kind, extra = {}) {
  const f = files(room);
  const existing = readJson(f.presence);
  const base = existing ?? defaultPresenceMeta({ kind });
  const next = normalizePresenceMeta({ ...base, ...extra, updatedAt: Date.now() });
  writePrivate(f.presence, JSON.stringify(next, null, 2));
  touchActive(room);
  return next;
}

/** Update presence.json without overwriting saved harness/workspace defaults from another cwd. */
function updatePresence(room, patch, { clear = false } = {}) {
  const f = files(room);
  const prev = readJson(f.presence, {});
  const next = clear
    ? normalizePresenceMeta({ harness: prev.harness, workspace: prev.workspace, host: prev.host, model: prev.model, updatedAt: Date.now() })
    : normalizePresenceMeta({ ...prev, ...patch, updatedAt: Date.now() });
  writePrivate(f.presence, JSON.stringify(next, null, 2));
  touchActive(room);
  return next;
}

/** Format presence metadata cleanly for `aim who` and `welcome`. */
function fmtMeta(m) {
  if (!m || !Object.keys(m).length) return '';
  const bits = [];
  if (m.state) bits.push(`[${m.state}]`);
  if (m.role && m.task) bits.push(`${m.role} — ${m.task}`);
  else if (m.role) bits.push(m.role);
  else if (m.task) bits.push(m.task);
  const where = [m.harness, m.host ? `@ ${m.host}` : '', m.workspace].filter(Boolean).join(', ');
  const aliasStr = m.aliases?.length ? `aliases: ${m.aliases.map((a) => `@${a}`).join(', ')}` : '';
  const tail = [where, aliasStr].filter(Boolean).join('; ');
  if (tail) bits.push(`(${tail})`);
  return bits.length ? `  ${bits.join(' ')}` : '';
}

/** Join a repo room: fetch refs/aim/key with git, write the config, start the daemon. */
async function joinRepo({ owner, repo, top, remote, branch, name, hooks = false, meta = {}, explicitName = false, rawArgs = [] }) {
  const r = repoRoom(owner, repo, branch);
  const prev = readJson(files(r.id).config);
  if (prev && prev.name !== name) die(`already in ${r.label} as ${prev.name}; run \`aim leave --room ${r.id}\` first`);
  let got;
  try {
    got = fetchKey({ top, remote });
  } catch (e) {
    die(`${e.message}\nIf git can't reach the repo from here, ask for an invite instead (aim invite <name>).`);
  }
  if (got.missing) {
    if (owner === 'jondahl' && repo === 'aim') {
      const here = localRepo();
      if (here && !(here.owner === 'jondahl' && here.repo === 'aim')) {
        die(`jondahl/aim is the aim tool repo itself (not a chat room). To join this checkout's room (${here.owner}/${here.repo}), run \`aim join\`.`);
      }
      die('jondahl/aim is the aim tool repo itself (not a chat room). Run `aim join` inside the repo you want to collaborate on, or `aim join <owner/repo>`.');
    }
    die(`${owner}/${repo} has no aim room yet. Someone with a Caprid API key opens one with \`aim init\` in a checkout.`);
  }
  const { key } = got;
  writeConfig(r.id, { kind: 'repo', ns: key.ns, room: r.id, label: r.label, repo: `${owner}/${repo}`, branch: branch ?? null, path: r.path, name, kid: key.kid, k: key.k, gitDir: top ?? got.dir, remote: remote ?? null });
  initPresence(r.id, 'repo', meta);
  const st = await ensureDaemon(r.id, { waitLive: true });
  await welcome(r.id, st, { hooks, fresh: !prev, explicitName, rawArgs });
}

/** What to suggest when push delivery isn't set up: one harness-specific command, never editing settings unasked. */
function integrationHint() {
  if (process.env.CLAUDECODE) {
    return hasClaudeHooks()
      ? 'To hear messages while idle: stream `aim watch --oneline` under your Monitor tool (or run `aim wait --timeout 0` as a background task).'
      : 'To receive messages live right now (no restart): stream `aim watch --oneline` under your Monitor tool (or run `aim wait --timeout 0` as a background task). Optional mid-task hooks: `aim hooks claude` (ask your user first).';
  }
  if (Object.keys(process.env).some((k) => k.startsWith('PI_')) && !fs.existsSync(path.join(process.env.HOME, '.pi', 'agent', 'extensions', 'aim.ts')))
    return 'To get messages pushed automatically (even while idle): `aim hooks pi` installs the pi extension (ask your user first; they then /reload).';
  return '';
}

/** Who holds a name we were refused, from the holder's presence as the daemon heard it. */
function describeHolder(h, now = Date.now()) {
  if (!h) return 'it has not said who it is; it may run an older aim';
  const parts = [];
  parts.push(h.harness ? `a ${h.harness} agent` : 'an agent');
  if (h.workspace) parts[0] += ` in ${h.workspace}`;
  if (h.task) parts.push(`doing "${h.task}"`);
  if (h.lastActive) parts.push(`last active ${fmtAge(now - h.lastActive)} ago`);
  else if (h.seenAt) parts.push(`last heard ${fmtAge(now - h.seenAt)} ago`);
  return `held by ${parts.join(', ')}`;
}

/** Anything under this identity's rooms/ (even a concurrent join that has not written its config yet). */
function hasAnyRoomDir() {
  try {
    return fs.readdirSync(path.join(HOME, 'rooms')).length > 0;
  } catch {
    return false;
  }
}

/** Was the identity directory (~/.aim/as/<name>) there before this process ran? */
const HOME_EXISTED = fs.existsSync(HOME);

/** If another online member already uses our name, undo the join — auto-retrying with a free name if --as wasn't explicit. */
async function refuseTakenName(room, st, fresh, { explicitName = false, rawArgs = [] } = {}) {
  if (!st.duplicate) return;
  // Give the holder a moment to answer with its presence (it sends within ~2 s of seeing us), so the
  // refusal can say who it is; an older aim never answers, so keep this short.
  for (let i = 0; i < 15 && !st.holder; i++) {
    await sleep(200);
    st = readJson(files(room).state, st);
  }
  const who = describeHolder(st.holder);
  const cfg = loadConfig(room);
  const taken = new Set([...(st.online ?? []), ...(st.known ?? []), cfg.name]);
  let n = 2;
  while (taken.has(`${cfg.name}-${n}`)) n++;
  const free = `${cfg.name}-${n}`;
  const pid = daemonPid(room);
  if (pid) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(100); // it may still write into the room dir
  }
  if (fresh) fs.rmSync(files(room).dir, { recursive: true, force: true });
  // A refused join leaves nothing behind: no empty ~/.aim/as/<name> (which nextFreeLocalName would
  // count as taken). The session binding is only written after a join succeeds (see welcome()).
  if (!HOME_EXISTED && AS && HOME === path.join(ROOT, 'as', AS) && !hasAnyRoomDir()) fs.rmSync(HOME, { recursive: true, force: true });
  if (!explicitName && !AS && !process.env.AIM_HOME && !process.env.AIM_JOIN_AUTO_RETRY) {
    process.stderr.write(`aim: "${cfg.name}" is already online in ${cfg.label ?? room} (${who}); joining as "${free}" instead.\n`);
    const r = spawnSync(process.execPath, [SELF, 'join', ...rawArgs, '--as', free], {
      stdio: 'inherit',
      env: { ...process.env, AIM_NAME: free, AIM_JOIN_AUTO_RETRY: '1', AIM_AUTO_NAMED: free },
    });
    process.exit(r.status ?? 0);
  }
  die(`the name "${cfg.name}" is already in use by another online member of ${cfg.label ?? room} (${who}). Pick another, e.g. \`aim join --as ${free}\`${process.env.BD_ACTOR ? ' (and set BD_ACTOR to match)' : ''}. If that member was you a few seconds ago, wait 15 s and retry.`);
}

/**
 * `join --bind` / `rename`: this session was another identity (AIM_JOIN_PREV_HOME). Now that the new
 * name is accepted in `room`, leave `room` under the old identity. Returns the old name, if left.
 */
async function leavePreviousName(room, newName) {
  const prev = process.env.AIM_JOIN_PREV_HOME;
  if (!prev || process.env.AIM_NO_BIND || path.resolve(prev) === HOME) return null;
  const old = readJson(path.join(prev, 'rooms', room, 'config.json'));
  if (!old || old.name === newName) return null;
  await leaveRoomAt(path.resolve(prev), room);
  return old.name;
}

async function welcome(room, st0, { hooks = false, fresh = false, explicitName = false, rawArgs = [] } = {}) {
  let st = st0;
  const cfg = loadConfig(room);
  await sleep(1500); // let the roster arrive
  st = readJson(files(room).state, st);
  await refuseTakenName(room, st, fresh, { explicitName, rawArgs });
  // Only now, with the name accepted, does this harness session take it (the dispatcher skips join).
  if (envName()) bindSession(envName());
  out(`You are "${cfg.name}" in room ${cfg.label ?? room}.`);
  const left = await leavePreviousName(room, cfg.name);
  if (left) out(`Left ${cfg.label ?? room} as "${left}" (this session's previous name), so it doesn't stay online.`);
  if (process.env.AIM_AUTO_NAMED === cfg.name) {
    out(`Note: another live agent already used the default identity, so this session was automatically isolated as "${cfg.name}" (~/.aim/as/${cfg.name}).`);
  } else if (sessionKey() && boundName() && !process.env.AIM_NO_BIND) {
    out(`(Isolated under ~/.aim/as/${boundName()} and bound to this session — no AIM_NAME= prefix needed.)`);
  }
  if (st.duplicate) out(`Warning: another member is also using the name "${cfg.name}". Run \`aim leave\` and join again with a different --as.`);
  const onlineList = st.online ?? [];
  if (onlineList.length) {
    out('Online now:');
    const pl = st.peersListening ?? {};
    const peers = st.peers ?? {};
    for (const n of onlineList) {
      const p = peers[n];
      const listen = pl[n] === true ? 'listening' : pl[n] === false ? 'not listening' : 'online';
      out(`  ${n}: ${listen}${fmtMeta(p?.meta)}`);
    }
  } else {
    out('Online now: nobody else yet.');
  }
  out('');
  out('  aim send - <<\'EOF\'        send a message on stdin (add --to <name|@alias> for one agent)');
  out('  aim doing "what I\'m on"   publish your live status in `aim who`');
  out('  aim who                   live roster: who is online, listening, and doing what');
  out('  aim read                  new messages');
  const integ = await autoIntegrate(hooks);
  if (integ) out(`\n${integ}`);
  if (!liveWatcherHolding()) printUnread(room, false, { header: true });
}

const AGENTS_SNIPPET = `## Talking to other agents (aim)

This repo has an aim room where the agents working on it can message each other. If you are asked to
"join aim", or need to coordinate with another agent:

    command -v aim || curl -fsSL https://raw.githubusercontent.com/jondahl/aim/main/install.sh | sh
    aim join --as <your-name>     # in this checkout; prints who is online and how to use it

Then \`aim read\` at natural pauses, \`aim send "..."\` to talk, \`aim wait\` when you're blocked on a reply.`;

// Portable hook commands (no absolute paths), so they can be committed to a repo. A hook that runs
// before aim is installed does nothing, except SessionStart, which installs it.
const AIM = '"$HOME/.local/bin/aim"';
// Installing without npm or repo access: this release's tarball (dependencies bundled) from GitHub
// Releases, checked against its pinned SHA-256 before anything is unpacked.
const TARBALL = `https://github.com/jondahl/aim/releases/download/v${VERSION}/aim-${VERSION}.tgz`;
async function releaseSha() {
  if (/^[0-9a-f]{64}$/.test(process.env.AIM_RELEASE_SHA ?? '')) return process.env.AIM_RELEASE_SHA; // tests, offline
  const url = `https://github.com/jondahl/aim/releases/download/v${VERSION}/SHA256SUMS`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  const line = res?.ok ? (await res.text()).split('\n').find((l) => l.trim().endsWith(`aim-${VERSION}.tgz`)) : undefined;
  const sha = line?.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) die(`no published checksum for aim ${VERSION} (${url}); release it first (scripts/release.sh)`);
  return sha;
}
function installCommand(sha) {
  return (
    `d=$(mktemp -d) && curl -fsSL -o "$d/aim.tgz" ${TARBALL} && ` +
    `(cd "$d" && echo "${sha}  aim.tgz" | { sha256sum -c - 2>/dev/null || shasum -a 256 -c -; }) >/dev/null && ` +
    `rm -rf "$HOME/.aim/app" && mkdir -p "$HOME/.aim/app" "$HOME/.local/bin" && tar -xzf "$d/aim.tgz" -C "$HOME/.aim/app" && ` +
    `ln -sfn "$HOME/.aim/app/bin/aim.js" ${AIM}; s=$?; rm -rf "$d"; [ "$s" = 0 ]`
  );
}
// When AIM_HOME is set, check it directly; when a valid AIM_NAME directory exists, check only that
// identity so another idle agent's unread marker never triggers Node.js hook spawns after every tool call.
const ANY_UNREAD =
  '{ if [ -n "${AIM_HOME:-}" ]; then ls "$AIM_HOME"/rooms/*/unread; elif [ -n "${AIM_NAME:-}" ] && [ -d "$HOME/.aim/as/$AIM_NAME" ]; then ls "$HOME/.aim/as/$AIM_NAME"/rooms/*/unread; else ls "$HOME"/.aim/rooms/*/unread || ls "$HOME"/.aim/as/*/rooms/*/unread; fi; } >/dev/null 2>&1';
// By default the hooks only use aim where it is already installed: a hook runs outside the session's
// permission checks, so it must not install software those checks may have refused. Installing is
// the owner's call (--auto-install, or allow aim in the environment's permission settings).
const claudeHooks = (sha) => ({
  SessionStart: sha
    ? `[ -x ${AIM} ] || { ${installCommand(sha)}; }; [ -x ${AIM} ] && ${AIM} hook session-start || true`
    : `[ -x ${AIM} ] && ${AIM} hook session-start || true`,
  UserPromptSubmit: `${ANY_UNREAD} && ${AIM} hook user-prompt-submit || true`,
  PostToolUse: `${ANY_UNREAD} && ${AIM} hook post-tool-use || true`,
  Stop: `${ANY_UNREAD} && ${AIM} hook stop || true`,
});

async function installClaudeHooks(file, { autoInstall = false } = {}) {
  const settings = readJson(file, {});
  settings.hooks ??= {};
  for (const [ev, command] of Object.entries(claudeHooks(autoInstall ? await releaseSha() : undefined))) {
    const list = (settings.hooks[ev] ??= []);
    const kept = list.filter((g) => !(g.hooks ?? []).some(isAimHook));
    kept.push({ ...(ev === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: ev === 'SessionStart' ? 120 : 10 }] });
    settings.hooks[ev] = kept;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

const isAimHook = (h) => /aim(\.js)?"? hook /.test(String(h.command));

/** Remove the hook groups aim added (and nothing else); returns how many. */
function removeClaudeHooks(file) {
  const settings = readJson(file);
  if (!settings?.hooks) return 0;
  let n = 0;
  for (const [ev, list] of Object.entries(settings.hooks)) {
    const kept = list.filter((g) => !(g.hooks ?? []).some(isAimHook));
    n += list.length - kept.length;
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (n) fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return n;
}

function hasClaudeHooks() {
  const files = [path.join(process.env.HOME, '.claude', 'settings.json')];
  const top = localRepo()?.top;
  if (top) files.push(path.join(top, '.claude', 'settings.json'), path.join(top, '.claude', 'settings.local.json'));
  return files.some((f) => JSON.stringify(readJson(f, {}).hooks ?? {}).includes(' hook post-tool-use'));
}

/** Set up push delivery for the harness we're running in, once. Returns a line to print, or ''. */
async function autoIntegrate(enable) {
  if (!enable) return integrationHint();
  if (process.env.AIM_NO_HOOKS) return '';
  try {
    if (process.env.CLAUDECODE && !hasClaudeHooks()) {
      await installClaudeHooks(path.join(process.env.HOME, '.claude', 'settings.json'));
      return 'Set up Claude Code hooks (~/.claude/settings.json) so new messages reach you after each tool call; new sessions pick them up (or run /hooks).';
    }
    if (Object.keys(process.env).some((k) => k.startsWith('PI_'))) {
      const dest = path.join(process.env.HOME, '.pi', 'agent', 'extensions', 'aim.ts');
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(path.dirname(fs.realpathSync(SELF)), '..', 'integrations', 'pi', 'aim.ts'), dest);
        return 'Installed the pi extension so new messages arrive in the conversation, even when idle. Ask the user to run /reload.';
      }
      refreshPiExtension();
      return staleSessionsText();
    }
  } catch {}
  return '';
}

function gitHasKey(here) {
  try {
    return !fetchKey(here).missing;
  } catch {
    return false;
  }
}

function inviteText(invite, room, name) {
  return [
    `You've been invited to an aim room ("${room}") as "${name}". aim lets coding agents message each other.`,
    'Install it (Node 24+) and join, then follow the usage it prints:',
    '',
    '  curl -fsSL https://raw.githubusercontent.com/jondahl/aim/main/install.sh | sh',
    `  aim join ${invite}`,
    '',
    'The aim1_... invite is a secret credential; do not commit or log it.',
  ].join('\n');
}

/** Two agent sessions on this machine using one identity look like one member to everyone else. */
function warnSharedIdentity() {
  const others = noteSession();
  if (!others.length) return;
  const mins = Math.max(1, Math.round(Math.min(...others.map((o) => o.ago)) / 60000));
  const who = AS ? `"${AS}"` : 'the shared identity (~/.aim)';
  process.stderr.write(
    `aim: warning: ${others.length === 1 ? 'another agent session' : `${others.length} other agent sessions`} on this machine ` +
      `(${others.map((o) => o.key.split(':')[0]).join(', ')}, last active ${mins} min ago) also use ${who}. ` +
      'Others see you as one member, and each of you reads the other\'s messages. ' +
      'Give each agent its own identity: set AIM_NAME=<name> (e.g. AIM_NAME=pi-2) in its environment and `aim join` again.\n',
  );
}

/** All member names configured in rooms under the shared ~/.aim identity. */
function sharedRoomNames() {
  const names = new Set();
  try {
    const dir = path.join(ROOT, 'rooms');
    for (const r of fs.readdirSync(dir)) {
      const n = readJson(path.join(dir, r, 'config.json'))?.name;
      if (n) names.add(n);
    }
  } catch {}
  return [...names];
}

/** True if this harness session is already actively using the shared ~/.aim identity. */
function sessionUsesShared() {
  const sk = sessionKey();
  if (!sk) return false;
  const lock = readJson(path.join(ROOT, 'watch.json'));
  if (lock && pidAlive(Number(lock.pid)) && lock.key === sk) return true;
  const seen = readJson(path.join(ROOT, 'sessions.json'), {});
  const t = Number(seen[sk]);
  return Number.isFinite(t) && Date.now() - t < 30 * 60_000;
}

/**
 * Safely isolate a join into ~/.aim/as/<targetName> without silently renaming an already-named
 * session (or an active user of the shared ~/.aim identity) or duplicating an existing shared agent.
 */
function maybeIsolateJoin(targetName, { bind = false, args = [] } = {}) {
  if (process.env.AIM_HOME || process.env.AIM_JOIN_REEXEC) return;
  if (!validName(targetName)) die(`bad name "${targetName}": lowercase letters, digits and single hyphens, max 32`);
  if (AS === targetName) return;
  const current = AS ?? (sharedRoomNames().length && sessionUsesShared() ? sharedRoomNames().join('/') : null);
  if (current) {
    if (!AS && sharedRoomNames().includes(targetName)) return; // already on shared ~/.aim under targetName
    // Session already has a different identity: refuse unless explicitly opting to switch or act for another.
    if (!bind && !process.env.AIM_NO_BIND) {
      die(
        `this session is already "${current}", not "${targetName}". ` +
          `Pass --bind to switch this session to "${targetName}", or set AIM_NO_BIND=1 to join on "${targetName}"'s behalf without renaming this session.`,
      );
    }
    // With --bind the session moves to targetName: once that join is accepted, welcome() leaves the
    // room under the old identity (AIM_JOIN_PREV_HOME), so the old name isn't left online as a ghost.
    const r = spawnSync(process.execPath, [SELF, 'join', ...args], {
      stdio: 'inherit',
      env: { ...process.env, AIM_NAME: targetName, AIM_JOIN_REEXEC: '1', ...(process.env.AIM_NO_BIND ? {} : { AIM_JOIN_PREV_HOME: HOME }) },
    });
    process.exit(r.status ?? 0);
  }
  // No active session identity yet: keep existing shared identity intact if it already uses targetName.
  if (sharedRoomNames().includes(targetName)) return;
  const r = spawnSync(process.execPath, [SELF, 'join', ...args], {
    stdio: 'inherit',
    env: { ...process.env, AIM_NAME: targetName, AIM_JOIN_REEXEC: '1' },
  });
  process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------------------------------------

const commands = {
  async join(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        as: { type: 'string' },
        branch: { type: 'string' },
        hooks: { type: 'boolean' },
        bind: { type: 'boolean' },
        role: { type: 'string' },
        doing: { type: 'string' },
        state: { type: 'string' },
        alias: { type: 'string' },
      },
    });
    if (values.as) maybeIsolateJoin(values.as, { bind: values.bind, args });
    // Plain `aim join` (no --as, no identity yet): auto-isolate ONLY when a live listener lock on
    // shared ~/.aim belongs to another session (so /new or /fork in the same agent keeps its identity).
    if (!values.as && !AS && !process.env.AIM_HOME && !process.env.AIM_JOIN_REEXEC) {
      const sk = sessionKey();
      const sharedLock = readJson(path.join(ROOT, 'watch.json'));
      const lockOther = sharedLock && pidAlive(Number(sharedLock.pid)) && (!sk || sharedLock.key !== sk);
      if (lockOther) {
        const base = defaultName() || 'agent';
        const picked = nextFreeLocalName(base);
        process.stderr.write(`aim: another live session already listens on the shared identity; isolating this session as "${picked}".\n`);
        const r = spawnSync(process.execPath, [SELF, 'join', ...args, '--as', picked], {
          stdio: 'inherit',
          env: { ...process.env, AIM_NAME: picked, AIM_JOIN_REEXEC: '1', AIM_AUTO_NAMED: picked },
        });
        process.exit(r.status ?? 0);
      }
    }

    const meta = {
      ...(values.role ? { role: values.role } : {}),
      ...(values.doing ? { task: values.doing } : {}),
      ...(values.state ? { state: values.state } : {}),
      ...(values.alias ? { aliases: values.alias.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean) } : {}),
    };
    const text = positionals.join(' ');
    if (!text.includes('aim1_')) {
      // A repo room: this checkout's, or owner/repo, gh/owner/repo, github.com/owner/repo, or a URL.
      let where;
      let parsedBranch;
      if (text) {
        const parsed = parseRepoArg(text);
        if (!parsed) die(`"${text}" is neither an invite (aim1_...) nor a repo (owner/repo, gh/owner/repo, or git URL)`);
        parsedBranch = parsed.branch;
        const here = localRepo();
        where = here && here.owner === parsed.owner && here.repo === parsed.repo ? here : parsed;
      } else {
        where = localRepo();
        if (!where) die('not in a git checkout with an origin remote: cd into the repo, or run `aim join owner/repo`, or `aim join <invite>`');
      }
      let branch = values.branch ?? parsedBranch;
      if (branch === '.') branch = where.branch || die('not on a branch (detached HEAD); pass --branch <name>');
      // Without --as or AIM_NAME, rejoining keeps the name this identity already has in the room
      // (a changed default, e.g. the cloud worker name, must not lock it out of its own room).
      const prevName = !values.as && !envName() ? readJson(files(repoRoom(where.owner, where.repo, branch).id).config)?.name : null;
      return joinRepo({ ...where, branch, name: values.as ? memberName(values.as) : validName(prevName) ? prevName : memberName(), hooks: values.hooks, meta, explicitName: Boolean(values.as), rawArgs: args });
    }
    let inv;
    try {
      inv = decodeInvite(text);
    } catch (e) {
      die(e.message);
    }
    maybeIsolateJoin(inv.name, { bind: values.bind, args });
    const fresh = !readJson(files(inv.room).config);
    joinRoom(inv);
    initPresence(inv.room, 'invite', meta);
    const st = await ensureDaemon(inv.room, { waitLive: true });
    await welcome(inv.room, st, { hooks: values.hooks, fresh, explicitName: true, rawArgs: args });
  },

  async new(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { as: { type: 'string' }, ns: { type: 'string' } } });
    const room = positionals[0];
    if (!room || !values.as) die('usage: aim new <room> --as <your-name>   (names: lowercase letters, digits, hyphens)');
    if (!validName(room) || !validName(values.as)) die('room and name must be lowercase letters, digits and single hyphens (max 32)');
    if (listRooms().includes(room)) die(`already in room "${room}"`);
    const sb = await import('../lib/switchboard.js');
    try {
      const key = sb.requireKey();
      const ns = await sb.resolveNamespace(key, values.ns);
      const { kid, k } = await sb.createMemberKey(key, ns, room, values.as);
      joinRoom({ ns, room, name: values.as, kid, k });
    } catch (e) {
      die(e.status === 409 ? `room "${room}" already exists in this Namespace (or ${values.as} was already invited); pick another name` : e.message);
    }
    const st = await ensureDaemon(room, { waitLive: true });
    await welcome(room, st);
    out('');
    out('Invite others with: aim invite <their-name>');
  },

  async init(args) {
    const { values } = parseArgs({ args, options: { as: { type: 'string' }, ns: { type: 'string' }, 'allow-public': { type: 'boolean' }, hooks: { type: 'boolean' } } });
    const here = localRepo();
    if (!here) die('run aim init inside a git checkout whose origin is the repo');
    const name = memberName(values.as);
    const pub = await isPublic(here.owner, here.repo);
    if (pub && !values['allow-public']) die(`${here.owner}/${here.repo} is public, so anyone could read its room key. Use invites instead (aim new), or pass --allow-public.`);
    if (gitHasKey(here)) {
      process.stderr.write(`${here.owner}/${here.repo} already has a room; joining it.\n`);
      return joinRepo({ ...here, branch: undefined, name, hooks: values.hooks });
    }
    const sb = await import('../lib/switchboard.js');
    try {
      const key = sb.requireKey();
      const ns = await sb.resolveNamespace(key, values.ns);
      const r = repoRoom(here.owner, here.repo);
      const { kid, k } = await sb.createRepoKey(key, ns, keyLabel(here.owner, here.repo), r.keyPath);
      pushKey(here.top, { v: 1, ns, kid, k, path: r.keyPath });
    } catch (e) {
      die(e.message);
    }
    process.stderr.write(`Opened the aim room for ${here.owner}/${here.repo} (key in refs/aim/key; anyone who can read the repo can join).\n`);
    await joinRepo({ ...here, branch: undefined, name, hooks: values.hooks });
    out('');
    out('Other agents join with `aim join --as <name>` in a checkout of this repo. To make that discoverable, add this to AGENTS.md / CLAUDE.md:');
    out('');
    out(AGENTS_SNIPPET);
  },

  async rotate(args) {
    const { values } = parseArgs({ args, options: { ns: { type: 'string' } } });
    const here = localRepo();
    if (!here) die('run aim rotate inside a checkout of the repo');
    let got;
    try {
      got = fetchKey(here);
    } catch (e) {
      die(e.message);
    }
    if (got.missing) die('this repo has no aim room (aim init opens one)');
    const sb = await import('../lib/switchboard.js');
    const r = repoRoom(here.owner, here.repo);
    try {
      const key = sb.requireKey();
      const ns = values.ns || got.key.ns;
      const { kid, k } = await sb.createRepoKey(key, ns, keyLabel(here.owner, here.repo), r.keyPath);
      pushKey(here.top, { v: 1, ns, kid, k, path: r.keyPath });
      for (const old of await sb.listKids(key, ns, keyLabelPrefix(here.owner, here.repo))) if (old !== kid) await sb.deleteKey(key, ns, old);
    } catch (e) {
      die(e.message);
    }
    out(`Rotated the key for ${here.owner}/${here.repo}. Old connections end within about a minute; members' daemons re-read refs/aim/key and reconnect on their own.`);
  },

  async invite(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { room: { type: 'string' }, raw: { type: 'boolean' } } });
    const name = positionals[0];
    if (!name || !validName(name)) die('usage: aim invite <name>   (lowercase letters, digits, hyphens)');
    const room = pickRoom(values.room);
    const cfg = loadConfig(room);
    if (cfg.kind === 'repo') die(`${cfg.label} is a repo room: anyone who can read the repo joins with \`aim join\`, no invite needed. For someone without repo access, make an invite-only room with \`aim new\`.`);
    if (name === cfg.name) die('that is you');
    const sb = await import('../lib/switchboard.js');
    let kid;
    let k;
    try {
      ({ kid, k } = await sb.createMemberKey(sb.requireKey(), cfg.ns, room, name));
    } catch (e) {
      die(e.status === 409 ? `${name} already has an invite to ${room}; \`aim revoke ${name}\` first to issue a new one` : e.message);
    }
    const invite = encodeInvite({ ns: cfg.ns, room, name, kid, k });
    if (values.raw) return out(invite);
    process.stderr.write(`Invite for "${name}" (a secret: send it privately; revoke with \`aim revoke ${name}\`). Paste this to them:\n\n`);
    out(inviteText(invite, room, name));
  },

  async revoke(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { room: { type: 'string' } } });
    const name = positionals[0];
    if (!name) die('usage: aim revoke <name>');
    const room = pickRoom(values.room);
    const cfg = loadConfig(room);
    if (cfg.kind === 'repo') die(`${cfg.label} is a repo room (members share refs/aim/key, not per-member invites). Use \`aim rotate\` to replace the room key.`);
    const sb = await import('../lib/switchboard.js');
    try {
      await sb.deleteMemberKey(sb.requireKey(), cfg.ns, room, name);
    } catch (e) {
      die(e.status === 404 ? `${name} has no invite to ${room}` : e.message);
    }
    out(`Revoked ${name}'s invite to ${room}; their connections end within about a minute.`);
  },

  async login() {
    const key = await readSecret('Caprid API key (input hidden): ');
    if (!key) die('no key given');
    const sb = await import('../lib/switchboard.js');
    try {
      sb.storeApiKey(key);
    } catch (e) {
      die(e.message);
    }
    out('Stored in the OS keychain.');
  },

  async send(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        to: { type: 'string' },
        room: { type: 'string' },
        wait: { type: 'string', default: '10' },
        'no-wait': { type: 'boolean' },
        json: { type: 'boolean' },
        file: { type: 'string' },
        urgent: { type: 'boolean' },
      },
    });
    const room = pickRoom(values.room);
    const cfg = loadConfig(room);
    let text = positionals.join(' ');
    let fromPositional = false;
    if (values.file) {
      if (text) die('pass either --file <path> or message text, not both');
      try {
        text = fs.readFileSync(values.file, 'utf8').replace(/\n$/, '');
      } catch (e) {
        die(`could not read --file "${values.file}": ${e.message}`);
      }
    } else if (text === '-' || (!text && !process.stdin.isTTY)) {
      text = await readStdin();
    } else if (text) {
      fromPositional = true;
    }
    if (!text) die('usage: aim send [--to name|@alias[,...]] [--file path] - <<\'EOF\'   (or short text)');
    if (fromPositional && Buffer.byteLength(text) > 512 && !values.json) {
      process.stderr.write('aim: tip: pass long messages on stdin (`aim send -`) or --file so shell limits and endpoint-security tools don\'t cut them off.\n');
    }
    if (Buffer.byteLength(text) > 256 * 1024) die('message too long (max 256 KiB); put big things in a file or repo and send a pointer');

    const f = files(room);
    const st0 = readJson(f.state, {});
    const aliasesMap = st0.aliases ?? {};
    const knownAll = [...new Set([...(st0.online ?? []), ...(st0.known ?? [])])];

    let to = null;
    if (values.to) {
      const resolved = [];
      for (const raw of values.to.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (raw.startsWith('@')) {
          const alias = raw.slice(1);
          if (!validName(alias)) die(`bad alias "${raw}"`);
          const holders = (aliasesMap[alias] ?? []).filter((n) => n !== cfg.name);
          if (!holders.length) die(`nobody online holds alias @${alias} (claim with \`aim alias add ${alias}\`; check \`aim who\`)`);
          if (!values.json) process.stderr.write(`aim: resolved @${alias} -> ${holders.join(', ')}\n`);
          resolved.push(...holders);
        } else {
          if (!validName(raw)) die(`bad recipient name "${raw}"`);
          if (raw === cfg.name) die(`cannot send to yourself ("${cfg.name}")`);
          resolved.push(raw);
        }
      }
      to = [...new Set(resolved)];
      for (const n of to) {
        if (knownAll.length && !knownAll.includes(n)) {
          const close = knownAll
            .map((k) => ({ k, d: editDistance(n, k) }))
            .filter((x) => x.d <= 2)
            .sort((a, b) => a.d - b.d);
          const hint = close.length ? ` Did you mean "${close[0].k}"?` : aliasesMap[n]?.length ? ` (Use --to @${n} to message the @${n} alias.)` : '';
          process.stderr.write(`aim: warning: "${n}" has never been seen in ${cfg.label ?? room}.${hint}\n`);
        }
      }
    }

    const id = newId();
    writePrivate(path.join(f.outbox, `${id}.json`), JSON.stringify({ id, to, text, ts: Date.now(), ...(values.urgent ? { urgent: 1 } : {}) }));
    touchActive(room);
    await ensureDaemon(room);

    const waitMs = values['no-wait'] ? 0 : Math.max(0, Number(values.wait) || 0) * 1000;
    const deadline = Date.now() + waitMs;
    let entry;
    let by = new Set();
    for (;;) {
      const log = readLog(room);
      entry = log.find((e) => e.kind === 'out' && e.id === id);
      by = new Set(log.filter((e) => e.kind === 'ack' && e.id === id).map((e) => e.by));
      const need = entry?.waitFor;
      const done = entry && (need ? need.every((n) => by.has(n)) : by.size > 0);
      if (done || Date.now() >= deadline) break;
      await sleep(250);
    }
    const got = [...by];
    const need = entry?.waitFor ?? null;
    const missing = need ? need.filter((n) => !by.has(n)) : got.length ? [] : ['anyone'];
    const listeningNowAt = readJson(f.state, {}).peersListening ?? {};
    const deaf = got.filter((n) => listeningNowAt[n] === false);
    const deafNote = deaf.length ? ` Not listening: ${deaf.join(', ')} (nothing delivers ${deaf.length > 1 ? 'their' : 'its'} messages while idle), so ${deaf.length > 1 ? 'they see' : 'it sees'} this when ${deaf.length > 1 ? 'they next work or check' : 'it next works or checks'}.` : '';
    if (values.json) out(JSON.stringify({ id, to, delivered: got, pending: missing, notListening: deaf }));
    else if (!missing.length) out(`Delivered to ${got.join(', ')}.${deafNote}`);
    else if (!waitMs) out(`Queued (id ${id}).`);
    else if (missing[0] === 'anyone') out('Nobody else is online; the daemon delivers it to the first member who comes back.');
    else {
      const st = readJson(f.state, {});
      const off = missing.filter((n) => n !== 'anyone' && !(st.online ?? []).includes(n));
      out(
        `${got.length ? `Delivered to ${got.join(', ')}; ` : ''}not yet confirmed by ${missing.join(', ')}${off.length ? ` (offline: ${off.join(', ')})` : ''}. ` +
          'The daemon keeps retrying and delivers it when they are back.',
      );
    }
    // Don't race with a live `aim watch` process (e.g. pi extension or Monitor) that delivers unread
    // messages directly into the conversation.
    if (!liveWatcherHolding()) printUnread(room, values.json, { header: true });
  },

  async read(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' }, peek: { type: 'boolean' } } });
    const rooms = consumeRooms(values.room);
    if (!rooms.length) die('not in any room yet: run `aim join` in a repo that has a room, or `aim join <invite>`');
    const loading = [];
    for (const room of rooms) if ((await connectedDaemon(room)).loading) loading.push(room);
    if (loading.length && !values.json) out(`(Not connected yet: ${loading.join(', ')}; messages still on their way may be missing. Try again in a few seconds.)`);
    if (values.peek) {
      for (const room of rooms) for (const e of unread(room).fresh) out(fmtMsg(e, loadConfig(room).name, values.json));
      return;
    }
    if (!printUnreadRooms(rooms, values.json) && !values.json) out('No new messages.');
  },

  async wait(args) {
    const { values } = parseArgs({
      args,
      options: {
        room: { type: 'string' },
        json: { type: 'boolean' },
        timeout: { type: 'string', default: '100' },
        oneline: { type: 'boolean' },
        force: { type: 'boolean' },
      },
    });
    const rooms = consumeRooms(values.room);
    if (!rooms.length) die('not in any room yet: run `aim join` in a repo that has a room, or `aim join <invite>`');
    // Guard against duplicate waiters/watchers stealing messages and lying about read receipts.
    // If THIS session's own `aim watch` holds the lock (e.g. pi agent calling `aim wait` while its
    // extension watches), wait in peek-only mode without stealing the cursor from the watcher.
    let ownLock = false;
    let peekMode = false;
    const sk = sessionKey();
    if (!values.force) {
      const lock = tryListenLock(sk, Date.now(), 'wait');
      if (lock.ok) {
        ownLock = true;
      } else {
        const h = lock.holder ?? {};
        if (sk && h.key === sk && h.kind !== 'wait') {
          peekMode = true;
        } else {
          die(`another listener (pid ${h.pid ?? '?'}, ${h.kind ?? 'watch'}) already listens for this identity. Stop it first, use a separate AIM_NAME, or pass --force (consumes messages anyway).`);
        }
      }
    }
    const cleanup = () => {
      if (ownLock) releaseListenLock();
    };
    process.on('exit', cleanup);
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      cleanup();
      process.exit(130);
    });

    for (const room of rooms) await ensureDaemon(room);
    // --timeout 0 waits forever: run it as a background task in harnesses that wake the agent when
    // a background command exits (Claude Code); it exits right after printing what arrived.
    const secs = Number(values.timeout);
    const deadline = secs === 0 ? Infinity : Date.now() + Math.max(1, secs || 100) * 1000;
    const parent = process.ppid;
    const lastSizes = new Map();
    const startIdx = new Map();
    if (peekMode) for (const room of rooms) startIdx.set(room, readLog(room).length);
    let lastEnsure = Date.now();
    let lastTouch = 0;
    while (Date.now() < deadline) {
      // Orphaned (parent shell/session died): exit without consuming unread messages.
      if (process.ppid !== parent) {
        cleanup();
        return;
      }
      if (!peekMode && Date.now() - lastTouch > 10_000) {
        for (const room of rooms) touchListening(room, 'wait'); // others see that we're listening
        lastTouch = Date.now();
      }
      if (peekMode) {
        let printed = 0;
        for (const room of rooms) {
          const sz = statLogSize(room);
          if (sz === lastSizes.get(room)) continue;
          const entries = readLog(room);
          lastSizes.set(room, sz);
          const fresh = entries.slice(startIdx.get(room) ?? 0).filter((e) => e.kind === 'in' || e.kind === 'notice');
          if (!fresh.length) continue;
          const cfg = readJson(files(room).config);
          for (const e of fresh) {
            if (values.json) out(JSON.stringify({ room, label: cfg?.label ?? room, ...JSON.parse(fmtMsg(e, cfg?.name ?? '', true)) }));
            else out(`${values.oneline && rooms.length > 1 ? `(${cfg?.label ?? room}) ` : ''}${fmtMsg(e, cfg?.name ?? '', false, { oneline: values.oneline })}`);
            printed++;
          }
        }
        if (printed) {
          cleanup();
          return;
        }
      } else {
        let anyUnread = false;
        for (const room of rooms) {
          const sz = statLogSize(room);
          if (sz === lastSizes.get(room)) continue;
          if (unread(room).fresh.length) anyUnread = true;
          else lastSizes.set(room, sz);
        }
        if (anyUnread) {
          printUnreadRooms(rooms, values.json, { oneline: values.oneline });
          cleanup();
          return;
        }
      }
      if (Date.now() - lastEnsure > 30_000) {
        for (const room of rooms) await ensureDaemon(room).catch(() => {});
        lastEnsure = Date.now();
      }
      await sleep(250);
    }
    cleanup();
    if (values.json) out(JSON.stringify({ timeout: true }));
    else out(`No new messages after ${values.timeout}s. Run \`aim wait\` again to keep waiting.`);
  },

  // Stream messages as they arrive, forever: for harnesses that can feed a background command's
  // output into the agent (the pi extension, Claude Code Monitor; see integrations/). It never gives
  // up on its own: no room yet, or this session not yet named, are states it waits out, and it exits
  // (code 3, for the caller to restart it) only when it should become another identity or aim was upgraded.
  async watch(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' }, oneline: { type: 'boolean' } } });
    const emit = (o, text) => (values.json ? out(JSON.stringify(o)) : text && process.stderr.write(`aim watch: ${text}\n`));
    const parent = process.ppid;
    const restartIfStale = () => {
      // Orphaned (pi crashed or was killed): stop, or we'd mark messages read that nobody receives.
      if (process.ppid !== parent) process.exit(0);
      if (wantedIdentity() !== AS) emit({ type: 'identity-changed' }, 'identity changed; restart me');
      else if (versionNow() !== VERSION) emit({ type: 'upgraded', version: versionNow() }, 'aim was upgraded; restart me');
      else return;
      process.exit(3);
    };
    if (refreshPiExtension()) emit({ type: 'extension-updated' }, 'updated the pi extension; /reload pi to use it');
    // Unnamed (shared ~/.aim) while another harness session uses that identity: its messages aren't
    // ours to read. Wait, re-checking: this session may get a name (AIM_NAME in any aim command),
    // or the other one may stop using the shared identity.
    const othersOnShared = () => {
      const key = sessionKey();
      if (AS || !key) return false;
      const seen = readJson(path.join(HOME, 'sessions.json'), {});
      const recent = Object.entries(seen).filter(([k, t]) => Date.now() - t < 30 * 60_000 && !boundElsewhere(k));
      return recent.length > 0 && !recent.some(([k]) => k === key);
    };
    if (othersOnShared()) {
      emit({ type: 'waiting-identity' }, 'another agent session uses the shared identity; waiting for this session to get a name (launch it with AIM_NAME=<name>, or run any aim command with AIM_NAME=<name>).');
      while (othersOnShared()) {
        restartIfStale();
        await sleep(2000);
      }
    }
    // Only one watcher per identity: another session's live watcher holds it, so wait.
    if (!tryListenLock(sessionKey(), Date.now(), 'watch').ok) {
      emit({ type: 'waiting-identity', reason: 'another session listens as this identity' }, 'another session already listens as this identity; waiting (give this session its own name: AIM_NAME=<name>).');
      while (!tryListenLock(sessionKey(), Date.now(), 'watch').ok) {
        restartIfStale();
        await sleep(1000);
      }
    }
    const fixed = values.room || process.env.AIM_ROOM ? pickRoom(values.room) : null;
    let rooms = [];
    let roomsKey;
    const lastSizes = new Map();
    let lastScan = 0;
    let lastEnsure = Date.now();
    let lastCheck = Date.now();
    let lastClaim = 0;
    let lastTouch = 0;
    for (;;) {
      const now = Date.now();
      if (now - lastScan > 2000) {
        lastScan = now;
        const list = fixed ? [fixed] : listRooms();
        if (list.join(',') !== roomsKey) {
          roomsKey = list.join(',');
          for (const r of list) if (!rooms.includes(r)) await ensureDaemon(r).catch(() => {});
          rooms = list;
          lastSizes.clear();
          lastTouch = lastClaim = 0;
          if (!rooms.length) emit({ type: 'idle', reason: 'not in any room' }, 'not in any room yet; waiting for one (aim join)');
          else {
            for (const r of rooms) touchListening(r, 'watch');
            lastTouch = now;
            const info = rooms.map((room) => ({ room, label: roomLabel(room), name: readJson(files(room).config, {}).name }));
            const names = [...new Set(info.map((i) => i.name))].join('/');
            emit({ type: 'watching', rooms: info, room: rooms[0], label: info.map((i) => i.label).join(', '), name: names }, `listening in ${info.map((i) => i.label).join(', ')} as ${names}`);
          }
        }
      }
      if (rooms.length && now - lastClaim > 60_000) {
        noteSession(); // keep this session's claim on the identity fresh while it listens
        lastClaim = now;
      }
      if (rooms.length && now - lastTouch > 10_000) {
        for (const r of rooms) touchListening(r, 'watch');
        lastTouch = now;
      }
      if (now - lastCheck > 1000) {
        lastCheck = now;
        restartIfStale();
        // Lost the lock (a stale watcher of ours came back, or a race): stop and wait as a newcomer.
        if (readJson(path.join(HOME, 'watch.json'))?.pid !== process.pid) {
          emit({ type: 'identity-changed' }, 'another watcher took over this identity; restart me');
          process.exit(3);
        }
      }
      for (const room of rooms) {
        const sz = statLogSize(room);
        if (sz === lastSizes.get(room)) continue; // fast path: log file hasn't grown
        const cfg = readJson(files(room).config);
        if (!cfg) continue; // just left; the next scan drops it
        const { fresh, end } = unread(room);
        lastSizes.set(room, sz);
        if (!fresh.length) continue;
        for (const e of fresh) {
          if (values.json) out(JSON.stringify({ type: 'message', room, label: cfg.label ?? room, ...JSON.parse(fmtMsg(e, cfg.name, true)) }));
          else out(`${rooms.length > 1 ? `(${cfg.label ?? room}) ` : ''}${fmtMsg(e, cfg.name, false, { oneline: values.oneline })}`);
        }
        markRead(room, end);
        touchActive(room);
      }
      if (now - lastEnsure > 30_000) {
        for (const r of rooms) await ensureDaemon(r).catch(() => {});
        lastEnsure = now;
      }
      await sleep(300);
    }
  },

  // Claude Code hooks (aim hooks claude installs them): deliver messages mid-task (PostToolUse,
  // UserPromptSubmit), and don't let the agent stop with unread messages (Stop). Never fails.
  async hook(args) {
    const event = args[0];
    const rawStdin = await readStdin();
    let input = {};
    try {
      input = JSON.parse(rawStdin || '{}');
    } catch {}
    // Subagents and in-process teammates fire the same tool hooks with agent_id set; only the main
    // conversation consumes messages, or a worker would take (and mark read) the coordinator's mail.
    if (input.agent_id) return;
    // Claude Code passes session_id in hook stdin JSON (and may not export CLAUDE_CODE_SESSION_ID
    // into hook subprocesses). If that session is bound to a named identity, re-run under it.
    const sid = typeof input.session_id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(input.session_id) ? input.session_id : null;
    if (sid && !process.env.AIM_NAME && !process.env.AIM_HOME && !process.env.AIM_HOOK_REEXEC) {
      const bound = boundName(`claude:${sid}`);
      if (bound && bound !== AS) {
        const r = spawnSync(process.execPath, [SELF, 'hook', event], {
          input: rawStdin,
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, AIM_NAME: bound, AIM_NO_BIND: '1', AIM_HOOK_REEXEC: '1' },
        });
        if (r.stdout) process.stdout.write(r.stdout);
        return;
      }
    }
    try {
      if (input.cwd) process.chdir(input.cwd);
    } catch {}
    let room;
    try {
      const rooms = listRooms();
      const here = localRepo();
      room = here && rooms.find((r) => r === repoRoom(here.owner, here.repo).id);
      room ??= rooms.length === 1 ? rooms[0] : undefined;
    } catch {}
    if (event !== 'session-start') {
      // Avoid double-delivery when this same session is already streaming `aim watch` under Monitor.
      const sk = sid ? `claude:${sid}` : sessionKey();
      if (sk && liveWatcherHolding(sk)) return;
      // A named agent (AIM_NAME, or a name bound to this session) gets every room it is in. On the
      // shared identity, hooks fire in every session on the machine, so each takes only its own
      // checkout's room: otherwise the first session to run a tool takes every repo's messages.
      const rooms = AS ? listRooms() : room ? [room] : [];
      for (const r of rooms) startDaemon(r);
      const news = rooms.map((r) => ({ r, cfg: readJson(files(r).config), ...unread(r) })).filter((x) => x.cfg && x.fresh.length);
      if (!news.length) return;
      if (event === 'stop' && input.stop_hook_active) return; // already continued once for messages
      for (const x of news) {
        markRead(x.r, x.end);
        touchActive(x.r);
      }
      const text = news
        .map(
          (x) =>
            `New aim message${x.fresh.length > 1 ? 's' : ''} in ${x.cfg.label ?? x.r} (you are ${x.cfg.name}${rooms.length > 1 ? `; reply there with aim send --room ${x.r}` : ''}):\n${x.fresh.map((e) => fmtMsg(e, x.cfg.name, false)).join('\n')}`,
        )
        .join('\n\n');
      const body = `${text}\n(Reply with \`aim send -\` if a reply is useful; no need to acknowledge everything.)`;
      if (event === 'stop') out(JSON.stringify({ decision: 'block', reason: body }));
      else out(JSON.stringify({ hookSpecificOutput: { hookEventName: event === 'user-prompt-submit' ? 'UserPromptSubmit' : 'PostToolUse', additionalContext: body } }));
      return;
    }
    if (!room) {
      // A repo with a room that this machine hasn't joined yet (e.g. a fresh cloud container): join it.
      const here = localRepo();
      const name = defaultName();
      if (here && name && validName(name)) {
        try {
          const got = fetchKey(here);
          if (!got.missing) {
            const r = repoRoom(here.owner, here.repo);
            writeConfig(r.id, { kind: 'repo', ns: got.key.ns, room: r.id, label: r.label, repo: `${here.owner}/${here.repo}`, branch: null, path: r.path, name, kid: got.key.kid, k: got.key.k, gitDir: here.top, remote: here.remote });
            initPresence(r.id, 'repo');
            room = r.id;
          }
        } catch {}
      }
    }
    if (!room) return;
    const cfg = loadConfig(room);
    if (event === 'session-start') {
      const st = (await ensureDaemon(room, { waitLive: true, timeoutMs: 15_000, quiet: true })) ?? readJson(files(room).state, {});
      const { fresh, end } = unread(room);
      markRead(room, end);
      touchActive(room);
      const lines = [
        `You are "${cfg.name}" in the aim room ${cfg.label ?? room}, where the agents working on this repo talk. Online now: ${st.online?.length ? st.online.join(', ') : 'nobody else'}.`,
        'Send with `aim send - <<\'EOF\'` (or `aim send --to <name|@alias> -`). Publish your task with `aim doing "..."`. New messages arrive after tool calls while you work.',
        'So messages also reach you while you are idle: stream `aim watch --oneline` under your Monitor tool (re-arm when Monitor expires), or start `aim wait --timeout 0` as a background task.',
        ...(st.duplicate ? ['', `Warning: another online member also uses the name "${cfg.name}". Run \`aim join --as <unique-name>\` (and set BD_ACTOR to match).`] : []),
        ...(fresh.length ? ['', `${fresh.length} unread:`, ...fresh.map((e) => fmtMsg(e, cfg.name, false))] : []),
      ];
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
      return;
    }
  },

  // Install push delivery into an agent harness.
  async hooks(args) {
    const which = args[0];
    const appBin = fs.realpathSync(SELF);
    if (args.includes('--remove')) {
      if (which === 'pi') {
        const dest = path.join(process.env.HOME, '.pi', 'agent', 'extensions', 'aim.ts');
        fs.rmSync(dest, { force: true });
        return out(`Removed ${dest}. Run /reload in pi.`);
      }
      if (which === 'claude') {
        const project = args.includes('--project');
        const file = project ? path.join(localRepo()?.top ?? die('--project needs a git checkout'), '.claude', 'settings.json') : path.join(process.env.HOME, '.claude', 'settings.json');
        const n = removeClaudeHooks(file);
        return out(n ? `Removed ${n} aim hook group(s) from ${file}; nothing else changed.` : `No aim hooks in ${file}.`);
      }
      die('usage: aim hooks pi|claude --remove [--project]');
    }
    if (which === 'pi') {
      const src = path.join(path.dirname(appBin), '..', 'integrations', 'pi', 'aim.ts');
      const dest = path.join(process.env.HOME, '.pi', 'agent', 'extensions', 'aim.ts');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      out(`Installed the pi extension at ${dest}. Run /reload in pi (or restart it); new aim messages then arrive in the conversation and wake an idle session.`);
      const stale = staleSessionsText();
      if (stale) out(`\n${stale}`);
    } else if (which === 'claude') {
      const project = args.includes('--project');
      const autoInstall = args.includes('--auto-install');
      const file = project ? path.join(localRepo()?.top ?? die('--project needs a git checkout'), '.claude', 'settings.json') : path.join(process.env.HOME, '.claude', 'settings.json');
      await installClaudeHooks(file, { autoInstall });
      out(
        project
          ? `Wrote aim hooks to ${file}. Commit it: every Claude Code session in this repo${autoInstall ? ' installs aim if needed,' : ' (with aim installed)'} joins the room, and sees new messages after each tool call.`
          : `Installed aim hooks in ${file}: new messages reach you after each tool call and on each prompt, and you won't end a turn with unread ones. New sessions pick them up (or run /hooks).`,
      );
    } else die('usage: aim hooks pi | claude [--project] [--auto-install]');
  },

  async log(args) {
    const { values } = parseArgs({
      args,
      options: {
        room: { type: 'string' },
        json: { type: 'boolean' },
        last: { type: 'string', default: '20' },
        all: { type: 'boolean' },
        from: { type: 'string' },
        'no-mark-read': { type: 'boolean' },
      },
    });
    const room = pickRoom(values.room);
    const cfg = loadConfig(room);
    const entries = readLog(room);
    const acks = new Map();
    const seen = new Map();
    for (const e of entries) {
      if (e.kind === 'ack') {
        if (!acks.has(e.id)) acks.set(e.id, new Set());
        acks.get(e.id).add(e.by);
      } else if (e.kind === 'seen') {
        if (!seen.has(e.id)) seen.set(e.id, new Set());
        seen.get(e.id).add(e.by);
      }
    }
    const cursor = Number(readJson(files(room).cursor, 0));
    let indexed = entries
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => e.kind === 'in' || e.kind === 'out' || e.kind === 'notice');
    if (values.from) indexed = indexed.filter(({ e }) => e.from === values.from);
    const shown = values.all ? indexed : indexed.slice(-Number(values.last || 20));
    if (!shown.length) out('No messages yet.');
    for (const { e } of shown) {
      const line = fmtMsg(e, cfg.name, values.json);
      if (e.kind !== 'out' || values.json) {
        out(line);
        continue;
      }
      const got = [...(acks.get(e.id) ?? [])];
      const read = [...(seen.get(e.id) ?? [])];
      const notYetRead = got.filter((n) => !read.includes(n));
      out(`${line}   (${!got.length ? 'not yet delivered' : `${read.length ? `read by ${read.join(', ')}` : ''}${read.length && notYetRead.length ? '; ' : ''}${notYetRead.length ? `delivered to ${notYetRead.join(', ')}, not read yet` : ''}`})`);
    }
    // Only advance the read cursor if every unread message was actually displayed (never silently
    // mark unread messages read when truncated by --last or filtered by --from).
    if (!values.from && !values['no-mark-read']) {
      const shownIdx = new Set(shown.map((x) => x.idx));
      const allUnreadShown = entries.every((e, idx) => idx < cursor || (e.kind !== 'in' && e.kind !== 'notice') || shownIdx.has(idx));
      if (allUnreadShown) markRead(room, entries.length);
    }
  },

  async doing(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        room: { type: 'string' },
        state: { type: 'string' },
        role: { type: 'string' },
        task: { type: 'string' },
        alias: { type: 'string' },
        clear: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
    const rooms = values.room || process.env.AIM_ROOM ? [pickRoom(values.room)] : listRooms();
    if (!rooms.length) die('not in any room yet');
    const taskArg = values.task ?? (positionals.length ? positionals.join(' ') : undefined);
    if (values.state && values.state !== 'clear' && !VALID_STATES.has(values.state.toLowerCase())) {
      die(`bad --state "${values.state}": use one of ${[...VALID_STATES].join(', ')} (or "clear")`);
    }
    if (!values.clear && taskArg === undefined && values.state === undefined && values.role === undefined && values.alias === undefined) {
      die('usage: aim doing "<what you are working on>" [--role "..."] [--state busy|idle|blocked|paused] [--alias a] [--clear]');
    }
    const results = [];
    for (const room of rooms) {
      let next;
      if (values.clear) {
        next = updatePresence(room, {}, { clear: true });
      } else {
        const patch = {};
        if (taskArg !== undefined) patch.task = taskArg === 'clear' || taskArg === '' ? undefined : taskArg;
        if (values.state !== undefined) patch.state = values.state === 'clear' || values.state === '' ? undefined : values.state.toLowerCase();
        if (values.role !== undefined) patch.role = values.role === 'clear' || values.role === '' ? undefined : values.role;
        if (values.alias !== undefined) {
          const list = values.alias === 'clear' || values.alias === '' ? [] : values.alias.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
          for (const a of list) if (!validName(a)) die(`bad alias "${a}"`);
          patch.aliases = list.length ? list : undefined;
        }
        next = updatePresence(room, patch);
      }
      await ensureDaemon(room).catch(() => {});
      results.push({ room, meta: next });
    }
    if (values.json) return out(JSON.stringify(results.length === 1 ? results[0] : results));
    const m = results[0].meta;
    const summary = fmtMeta(m).trim();
    out(`Updated roster status${rooms.length > 1 ? ` across ${rooms.length} rooms` : ''}: ${summary || '(cleared)'}`);
  },

  async presence(args) {
    return commands.doing(args);
  },

  async alias(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { room: { type: 'string' }, json: { type: 'boolean' } } });
    const sub = positionals[0] || 'list';
    const target = positionals[1]?.replace(/^@/, '');
    if (sub === 'list') {
      const room = pickRoom(values.room);
      const st = readJson(files(room).state, {});
      const map = st.aliases ?? {};
      if (values.json) return out(JSON.stringify(map));
      const entries = Object.entries(map);
      if (!entries.length) return out('No active aliases in this room. Claim one with `aim alias add <name>`.');
      for (const [a, holders] of entries.sort()) out(`  @${a} → ${holders.join(', ')}`);
      return;
    }
    if (!target || !validName(target)) die('usage: aim alias [list | add <name> | rm <name>]');
    const rooms = values.room || process.env.AIM_ROOM ? [pickRoom(values.room)] : listRooms();
    if (!rooms.length) die('not in any room yet');
    let finalAliases = [];
    for (const room of rooms) {
      const cur = readJson(files(room).presence, {});
      const set = new Set(cur.aliases ?? []);
      if (sub === 'add') set.add(target);
      else if (sub === 'rm' || sub === 'remove') set.delete(target);
      else die('usage: aim alias [list | add <name> | rm <name>]');
      const next = updatePresence(room, { aliases: set.size ? [...set] : undefined });
      finalAliases = next.aliases ?? [];
      await ensureDaemon(room).catch(() => {});
    }
    if (values.json) return out(JSON.stringify({ aliases: finalAliases }));
    out(sub === 'add' ? `Claimed @${target} (others can send \`aim send --to @${target} -\`).` : `Released @${target}.`);
  },

  async whoami(args) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
    const rooms = listRooms();
    const src = identitySource();
    const sk = sessionKey();
    const lock = readJson(path.join(HOME, 'watch.json'));
    const listener = lock && pidAlive(Number(lock.pid)) ? { pid: lock.pid, kind: lock.kind ?? 'watch', session: lock.key ?? null } : null;
    const info = {
      identity: AS ?? '(shared ~/.aim)',
      source: src,
      home: HOME,
      sessionKey: sk,
      boundName: boundName(),
      rooms: rooms.map((r) => ({ room: r, name: readJson(files(r).config, {}).name ?? null })),
      listener,
    };
    if (values.json) return out(JSON.stringify(info));
    out(`Identity:  ${info.identity} (from ${src})`);
    out(`State dir: ${HOME}`);
    if (sk) out(`Session:   ${sk}${info.boundName ? ` (bound to "${info.boundName}")` : ' (not bound)'}`);
    out(`Listener:  ${listener ? `pid ${listener.pid} (${listener.kind})` : 'none'}`);
    out(`Rooms:     ${info.rooms.length ? info.rooms.map((r) => `${r.room} as ${r.name}`).join(', ') : 'none'}`);
  },

  async who(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' } } });
    const room = pickRoom(values.room);
    const { st, loading } = await connectedDaemon(room);
    const cfg = loadConfig(room);
    const everyone = [...new Set([...(st.known ?? []), ...(st.online ?? [])])].sort();
    const pl = st.peersListening ?? {};
    const peers = st.peers ?? {};
    const myMeta = readJson(files(room).presence, {});
    if (values.json) return out(JSON.stringify({ me: cfg.name, meta: myMeta, room, online: st.online ?? [], listening: pl, peers, aliases: st.aliases ?? {}, known: everyone, ...(loading ? { loading: true } : {}) }));
    const mine = listeningNow(room);
    out(`Room "${cfg.label ?? room}", you are ${cfg.name}${mine ? ' (listening)' : ' (not listening: messages reach you only when you check)'}${fmtMeta(myMeta)}.`);
    if (loading) out('(The daemon is not connected yet, so who is online is not known; try again in a few seconds.)');
    if (!everyone.length) out('Nobody else has joined yet.');
    const stateStr = (n) => {
      if (!(st.online ?? []).includes(n)) return 'offline';
      const p = peers[n];
      const idle = p?.lastActive && Date.now() - p.lastActive > 5 * 60_000 ? `, idle ${fmtAge(Date.now() - p.lastActive)}` : '';
      if (pl[n] === true) return `online, listening${fmtMeta(p?.meta)}`;
      if (pl[n] === false) return `online, not listening${idle}${fmtMeta(p?.meta)}`;
      return `online${fmtMeta(p?.meta)}`;
    };
    for (const n of everyone) out(`  ${n}: ${stateStr(n)}`);
  },

  async status(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' } } });
    const rooms = values.room ? [pickRoom(values.room)] : listRooms();
    if (!rooms.length) return out('Not in any room.');
    for (const room of rooms) {
      const cfg = loadConfig(room);
      const pid = daemonPid(room);
      const st = readJson(files(room).state, {});
      const fresh = pid && st.updated && Date.now() - st.updated < 10_000;
      if (values.json) {
        out(JSON.stringify({ room, name: cfg.name, identitySource: identitySource(), daemon: pid || null, status: fresh ? st.status : 'stopped', online: st.online ?? [], pending: st.pending ?? 0, unread: unread(room).fresh.length }));
        continue;
      }
      out(`${room}: you are ${cfg.name} (${identitySource()}); daemon ${pid ? `pid ${pid}, ${fresh ? st.status : 'not responding'}` : 'stopped (any aim command restarts it)'}${st.version && st.version !== VERSION ? ` (running ${st.version}; it switches to ${VERSION} within 10 s)` : ''}`);
      if (fresh) out(`  online: ${st.online.length ? st.online.join(', ') : 'nobody else'}; undelivered: ${st.pending}; unread: ${unread(room).fresh.length}; listener: ${listeningNow(room) ? 'running' : 'none (messages reach you only when you check)'}`);
    }
    if (!values.json && fs.existsSync(PI_EXT_DEST())) {
      const stale = staleSessionsText();
      if (stale) out(`\n${stale}`);
    }
  },

  async up(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' } } });
    const room = pickRoom(values.room);
    const st = await ensureDaemon(room, { waitLive: true });
    out(`Connected to ${room} as ${st.name}. Online: ${st.online.length ? st.online.join(', ') : 'nobody else yet'}.`);
  },

  async stop(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, all: { type: 'boolean' } } });
    const rooms = values.all ? listRooms() : [pickRoom(values.room)];
    if (!rooms.length) return out('Not in any room.');
    let stopped = 0;
    for (const room of rooms) {
      const pid = daemonPid(room);
      if (!pid) {
        if (!values.all) out('Not running.');
        continue;
      }
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(100);
      stopped++;
      out(`Stopped the ${room} daemon. Messages to you queue on the sender's side until you're back (\`aim up\`).`);
    }
    if (values.all && !stopped) out('No daemons were running.');
  },

  async leave(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' } } });
    const room = pickRoom(values.room);
    await leaveRoomAt(HOME, room);
    out(`Left ${room} and deleted its local history and credentials.`);
  },

  /**
   * Move this session to a new name in its repo rooms in one step: join each as <new> (keeping role,
   * task, state and aliases), and only once the new name is accepted leave the room as the old name
   * and rebind the session. If the new name is refused, the old one stays as it was.
   */
  async rename(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { room: { type: 'string' } } });
    const to = positionals[0];
    if (!to || positionals.length > 1) die('usage: aim rename <new-name> [--room <room>]');
    if (!validName(to)) die(`bad name "${to}": lowercase letters, digits and single hyphens, max 32`);
    if (process.env.AIM_HOME && !envName()) die('rename works on named identities (~/.aim/as/<name>); this one uses a custom AIM_HOME');
    const rooms = values.room || process.env.AIM_ROOM ? [pickRoom(values.room)] : listRooms();
    if (!rooms.length) die('not in any room yet');
    const todo = rooms.map((room) => ({ room, cfg: loadConfig(room) })).filter(({ cfg }) => cfg.name !== to);
    if (!todo.length) return out(`Already "${to}".`);
    const invites = todo.filter(({ cfg }) => cfg.kind !== 'repo');
    if (invites.length) {
      die(
        `an invite is issued to one name, so invite rooms can't be renamed: ${invites.map(({ room }) => room).join(', ')}. ` +
          `Ask for an invite as "${to}" and join with it, or rename only repo rooms (--room <owner/repo>).`,
      );
    }
    let failed = 0;
    for (const { room, cfg } of todo) {
      const m = readJson(files(room).presence, {});
      const where = `${cfg.repo}${cfg.branch ? `@${cfg.branch}` : ''}`;
      const joinArgs = ['join', where, '--as', to, '--bind'];
      if (m.role) joinArgs.push('--role', m.role);
      if (m.task) joinArgs.push('--doing', m.task);
      if (m.state) joinArgs.push('--state', m.state);
      if (m.aliases?.length) joinArgs.push('--alias', m.aliases.join(','));
      const cwd = cfg.gitDir && fs.existsSync(cfg.gitDir) ? cfg.gitDir : process.cwd();
      const env = { ...process.env, AIM_NAME: to, AIM_JOIN_REEXEC: '1', AIM_JOIN_PREV_HOME: HOME };
      delete env.AIM_NO_BIND;
      delete env.AIM_HOME;
      const r = spawnSync(process.execPath, [SELF, ...joinArgs], { stdio: 'inherit', env, cwd });
      if (r.status !== 0) {
        failed++;
        process.stderr.write(`aim: rename in ${cfg.label ?? room} failed; still "${cfg.name}" there.\n`);
      }
    }
    if (failed) process.exit(1);
    out(`\nRenamed to "${to}". Use AIM_NAME=${to} (or no AIM_NAME: this session is bound to it) from now on${process.env.BD_ACTOR ? ', and set BD_ACTOR to match' : ''}.`);
  },

  // The verified install one-liner for this version, to hand to another agent or put in a setup script.
  async 'install-command'() {
    out(installCommand(await releaseSha()));
  },

  async rooms() {
    const rooms = listRooms();
    out(rooms.length ? rooms.map((r) => `${r} (as ${loadConfig(r).name})`).join('\n') : 'Not in any room.');
  },

  async _daemon(args) {
    const { runDaemon } = await import('../lib/daemon.js');
    await runDaemon(args[0]);
  },

  help() {
    out(HELP);
  },
};

const [cmd = 'help', ...rest] = process.argv.slice(2);
const aliases = { '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version' };
const name = aliases[cmd] ?? cmd;
if (name === 'version') out(VERSION);
else if (!Object.hasOwn(commands, name)) die(`unknown command "${cmd}"\n\n${HELP}`);
else {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) die(`aim needs Node 22 or later (this is ${process.version})`);
  // Daemons serve identities, not sessions; join binds only once the name is accepted (welcome()),
  // and rename rebinds itself. Any other command names a session only if it has no name yet: running
  // one with another agent's AIM_NAME (acting on its behalf) must not rebind this session.
  if (envName() && !['_daemon', 'join', 'rename'].includes(name)) bindSession(envName(), undefined, { replace: false });
  if (!['_daemon', 'hook', 'help', 'join', 'watch', 'whoami'].includes(name)) warnSharedIdentity();
  try {
    await commands[name](rest);
  } catch (e) {
    die(e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' ? `${e.message}\n\n${HELP}` : (e?.stack ?? String(e)));
  }
}
