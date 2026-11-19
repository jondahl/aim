#!/usr/bin/env node
// aim: agent instant messaging over Media over QUIC (Caprid Relay). See README.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AS,
  HOME,
  decodeInvite,
  die,
  encodeInvite,
  files,
  listRooms,
  loadConfig,
  newId,
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
import { defaultName, fetchKey, isPublic, keyLabel, keyLabelPrefix, localRepo, parseRemote, pushKey, repoRoom } from '../lib/repo.js';

const SELF = fileURLToPath(import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(SELF), '..', 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s = '') => process.stdout.write(`${s}\n`);

const HELP = `aim ${VERSION}: agent instant messaging (Media over QUIC, via Caprid Relay)

Join and talk:
  aim join [--as <name>]         join this git repo's room (anyone who can read the repo can join)
  aim join --branch <b|.>        ...or the room for one branch of it ('.' = the current branch)
  aim join <owner/repo>          a repo room without a checkout (needs git access to the repo)
  aim join <invite>              a room you were invited to (aim1_...)
  aim send <text...>             send to everyone in the room (or: aim send --to claude "...")
  echo "long text" | aim send -  send stdin
  aim read                       print new messages (and mark them read)
  aim wait [--timeout 100]       block until a message arrives, print it (default 100 s; 0 = forever,
                                 as a background task that wakes the agent when it exits)
  aim who                        who is in the room, online or not
  aim log [--last 20]            recent conversation, both directions
  aim watch [--json]             stream messages as they arrive (for a background/monitor process)

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
  aim status | up | stop | leave | rooms     (--room <room> when you are in several)
  aim install-command            print a checksum-verified install one-liner for this version (no npm/repo access)

Messages you send are retried until each recipient's daemon confirms them, so a peer that is
briefly offline still gets them once both daemons are up. Output is plain text; add --json for
machine-readable lines.`;

// ---------------------------------------------------------------------------------------------

function pickRoom(explicit) {
  const rooms = listRooms();
  const room = explicit || process.env.AIM_ROOM;
  if (room) {
    if (!rooms.includes(room)) die(`not in room "${room}" (rooms: ${rooms.join(', ') || 'none'})`);
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

function daemonPid(room) {
  const pid = Number(readJson(files(room).pid, 0));
  return pidAlive(pid) ? pid : 0;
}

function startDaemon(room) {
  if (daemonPid(room)) return false;
  const f = files(room);
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(f.daemonLog, 'a', 0o600);
  const env = { ...process.env };
  if ((env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = '1';
  const child = spawn(process.execPath, [SELF, '_daemon', room], { detached: true, stdio: ['ignore', logFd, logFd], env });
  child.unref();
  fs.closeSync(logFd);
  return true;
}

/** Make sure the daemon runs; with `waitLive`, wait until it is connected. */
async function ensureDaemon(room, { waitLive = false, timeoutMs = 20_000, quiet = false } = {}) {
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

function fmtMsg(e, me, json) {
  if (e.kind === 'notice') return json ? JSON.stringify({ id: e.id, notice: true, from: 'aim', text: e.text, ts: e.ts }) : `[${fmtTime(e.ts)}] (aim) ${e.text}`;
  if (json) return JSON.stringify({ id: e.id, from: e.from, to: e.to, text: e.text, ts: e.ts });
  const to = e.to ? ` → ${e.to.join(', ')}` : '';
  const who = e.kind === 'out' ? `${me} (you)` : e.from;
  const text = e.text.includes('\n') ? `\n  ${e.text.replace(/\n/g, '\n  ')}` : ` ${e.text}`;
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

/** Join a repo room: fetch refs/aim/key with git, write the config, start the daemon. */
async function joinRepo({ owner, repo, top, remote, branch, name, hooks = false }) {
  const r = repoRoom(owner, repo, branch);
  const prev = readJson(files(r.id).config);
  if (prev && prev.name !== name) die(`already in ${r.label} as ${prev.name}; run \`aim leave --room ${r.id}\` first`);
  let got;
  try {
    got = fetchKey({ top, remote });
  } catch (e) {
    die(`${e.message}\nIf git can't reach the repo from here, ask for an invite instead (aim invite <name>).`);
  }
  if (got.missing) die(`${owner}/${repo} has no aim room yet. Someone with a Caprid API key opens one with \`aim init\` in a checkout.`);
  const { key } = got;
  writeConfig(r.id, { kind: 'repo', ns: key.ns, room: r.id, label: r.label, repo: `${owner}/${repo}`, branch: branch ?? null, path: r.path, name, kid: key.kid, k: key.k, gitDir: top ?? got.dir, remote: remote ?? null });
  const st = await ensureDaemon(r.id, { waitLive: true });
  await welcome(r.id, st, { hooks, fresh: !prev });
}

/** What to suggest when push delivery isn't set up: we never edit harness settings unasked. */
function integrationHint() {
  if (process.env.CLAUDECODE && !hasClaudeHooks())
    return 'To get messages without polling: run `aim wait --timeout 0` as a background task (wakes you when one arrives). For delivery mid-task too, `aim hooks claude` (edits ~/.claude/settings.json; ask your user first).';
  if (Object.keys(process.env).some((k) => k.startsWith('PI_')) && !fs.existsSync(path.join(process.env.HOME, '.pi', 'agent', 'extensions', 'aim.ts')))
    return 'To get messages without polling: `aim hooks pi` installs the pi extension (ask your user first; they then /reload).';
  return '';
}

/** If another online member already uses our name, undo the join and suggest a free one. */
async function refuseTakenName(room, st, fresh) {
  if (!st.duplicate) return;
  const cfg = loadConfig(room);
  const taken = new Set([...(st.online ?? []), ...(st.known ?? []), cfg.name]);
  let n = 2;
  while (taken.has(`${cfg.name}-${n}`)) n++;
  const pid = daemonPid(room);
  if (pid) process.kill(pid, 'SIGTERM');
  if (fresh) fs.rmSync(files(room).dir, { recursive: true, force: true });
  die(`the name "${cfg.name}" is already in use by another online member of ${cfg.label ?? room}. Pick another, e.g. \`aim join --as ${cfg.name}-${n}\` (and set AIM_NAME=${cfg.name}-${n}${process.env.BD_ACTOR ? ' and BD_ACTOR to match' : ''}). If that member was you a few seconds ago, wait 15 s and retry.`);
}

async function welcome(room, st0, { hooks = false, fresh = false } = {}) {
  let st = st0;
  const cfg = loadConfig(room);
  await sleep(1500); // let the roster arrive
  st = readJson(files(room).state, st);
  await refuseTakenName(room, st, fresh);
  out(`You are "${cfg.name}" in room ${cfg.label ?? room}. Online now: ${st.online.length ? st.online.join(', ') : 'nobody else yet'}.`);
  if (st.duplicate) out(`Warning: another member is also using the name "${cfg.name}". Run \`aim leave\` and join again with a different --as.`);
  out('');
  out('  aim send "hello"          send to the room (retried until delivered)');
  out('  aim read                  new messages');
  out('  aim wait --timeout 100    block until a reply arrives');
  out('  aim who                   who is here');
  const integ = await autoIntegrate(hooks);
  if (integ) out(`\n${integ}`);
  printUnread(room, false, { header: true });
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
const ANY_UNREAD = '{ ls "$HOME"/.aim/rooms/*/unread || ls "$HOME"/.aim/as/*/rooms/*/unread; } >/dev/null 2>&1';
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

// ---------------------------------------------------------------------------------------------

const commands = {
  async join(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { as: { type: 'string' }, branch: { type: 'string' }, hooks: { type: 'boolean' } } });
    const text = positionals.join(' ');
    if (!text.includes('aim1_')) {
      // A repo room: this checkout's, or owner/repo / a URL given explicitly.
      let where;
      if (text) {
        const id = parseRemote(text.includes('/') && !text.includes(':') && text.split('/').length === 2 ? `https://github.com/${text}` : text);
        if (!id) die(`"${text}" is neither an invite (aim1_...) nor a repo (owner/repo)`);
        const here = localRepo();
        where = here && here.owner === id.owner && here.repo === id.repo ? here : { ...id, remote: /^(https?|ssh|git@)/.test(text) ? text : `https://github.com/${id.owner}/${id.repo}.git` };
      } else {
        where = localRepo();
        if (!where) die('not in a git checkout with an origin remote: cd into the repo, or run `aim join owner/repo`, or `aim join <invite>`');
      }
      let branch = values.branch;
      if (branch === '.') branch = where.branch || die('not on a branch (detached HEAD); pass --branch <name>');
      return joinRepo({ ...where, branch, name: memberName(values.as), hooks: values.hooks });
    }
    let inv;
    try {
      inv = decodeInvite(text);
    } catch (e) {
      die(e.message);
    }
    const fresh = !readJson(files(inv.room).config);
    joinRoom(inv);
    const st = await ensureDaemon(inv.room, { waitLive: true });
    await welcome(inv.room, st, { hooks: values.hooks, fresh });
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
      options: { to: { type: 'string' }, room: { type: 'string' }, wait: { type: 'string', default: '10' }, 'no-wait': { type: 'boolean' }, json: { type: 'boolean' } },
    });
    const room = pickRoom(values.room);
    const cfg = loadConfig(room);
    let text = positionals.join(' ');
    if (text === '-' || (!text && !process.stdin.isTTY)) text = await readStdin();
    if (!text) die('usage: aim send [--to name[,name]] <text...>   (or - to read stdin)');
    if (Buffer.byteLength(text) > 256 * 1024) die('message too long (max 256 KiB); put big things in a file or repo and send a pointer');
    const to = values.to ? values.to.split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (to) for (const n of to) if (!validName(n)) die(`bad recipient name "${n}"`);
    const f = files(room);
    const id = newId();
    writePrivate(path.join(f.outbox, `${id}.json`), JSON.stringify({ id, to, text, ts: Date.now() }));
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
    if (values.json) out(JSON.stringify({ id, delivered: got, pending: missing }));
    else if (!missing.length) out(`Delivered to ${got.join(', ')}.`);
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
    printUnread(room, values.json, { header: true });
    void cfg;
  },

  async read(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' }, peek: { type: 'boolean' } } });
    const room = pickRoom(values.room);
    await ensureDaemon(room);
    const cfg = loadConfig(room);
    const { fresh, end } = unread(room);
    if (!fresh.length && !values.json) out('No new messages.');
    for (const e of fresh) out(fmtMsg(e, cfg.name, values.json));
    if (!values.peek) markRead(room, end);
  },

  async wait(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' }, timeout: { type: 'string', default: '100' } } });
    const room = pickRoom(values.room);
    await ensureDaemon(room);
    // --timeout 0 waits forever: run it as a background task in harnesses that wake the agent when
    // a background command exits (Claude Code); it exits right after printing what arrived.
    const secs = Number(values.timeout);
    const deadline = secs === 0 ? Infinity : Date.now() + Math.max(1, secs || 100) * 1000;
    let lastEnsure = Date.now();
    while (Date.now() < deadline) {
      if (unread(room).fresh.length) {
        printUnread(room, values.json);
        return;
      }
      if (Date.now() - lastEnsure > 30_000) {
        await ensureDaemon(room).catch(() => {});
        lastEnsure = Date.now();
      }
      await sleep(250);
    }
    if (values.json) out(JSON.stringify({ timeout: true }));
    else out(`No new messages after ${values.timeout}s. Run \`aim wait\` again to keep waiting.`);
  },

  // Stream messages as they arrive, forever: for harnesses that can feed a background command's
  // output into the agent (the pi extension does; see integrations/).
  async watch(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' } } });
    // Unnamed (shared ~/.aim) and another harness session has been using that identity: its
    // messages aren't ours to read. Wait until this session gets a name (AIM_NAME in any aim command).
    const othersOnShared = () => {
      const key = sessionKey();
      if (AS || !key) return false;
      const seen = readJson(path.join(HOME, 'sessions.json'), {});
      const recent = Object.entries(seen).filter(([, t]) => Date.now() - t < 30 * 60_000);
      return recent.length > 0 && !recent.some(([k]) => k === key);
    };
    const changed = () => wantedIdentity() !== AS;
    if (othersOnShared()) {
      if (values.json) out(JSON.stringify({ type: 'waiting-identity' }));
      else process.stderr.write('aim watch: another agent session uses the shared identity; waiting for this session to get a name (run any aim command with AIM_NAME=<name>).\n');
      while (!changed()) await sleep(2000);
      if (values.json) out(JSON.stringify({ type: 'identity-changed' }));
      process.exit(3);
    }
    const room = pickRoom(values.room);
    const cfg = loadConfig(room);
    await ensureDaemon(room);
    if (values.json) out(JSON.stringify({ type: 'watching', room, label: cfg.label ?? room, name: cfg.name }));
    let lastEnsure = Date.now();
    let lastIdentity = Date.now();
    let lastClaim = 0;
    for (;;) {
      if (Date.now() - lastClaim > 60_000) {
        noteSession(); // keep this session's claim on the identity fresh while it listens
        lastClaim = Date.now();
      }
      if (Date.now() - lastIdentity > 2000) {
        lastIdentity = Date.now();
        if (changed()) {
          if (values.json) out(JSON.stringify({ type: 'identity-changed' }));
          process.exit(3); // the caller restarts us as the new identity
        }
      }
      const { fresh, end } = unread(room);
      if (fresh.length) {
        for (const e of fresh) out(values.json ? JSON.stringify({ type: 'message', room, label: cfg.label ?? room, ...JSON.parse(fmtMsg(e, cfg.name, true)) }) : fmtMsg(e, cfg.name, false));
        markRead(room, end);
      }
      if (Date.now() - lastEnsure > 30_000) {
        await ensureDaemon(room).catch(() => {});
        lastEnsure = Date.now();
      }
      await sleep(300);
    }
  },

  // Claude Code hooks (aim hooks claude installs them): deliver messages mid-task (PostToolUse,
  // UserPromptSubmit), and don't let the agent stop with unread messages (Stop). Never fails.
  async hook(args) {
    const event = args[0];
    let input = {};
    try {
      input = JSON.parse((await readStdin()) || '{}');
    } catch {}
    // Subagents and in-process teammates fire the same tool hooks with agent_id set; only the main
    // conversation consumes messages, or a worker would take (and mark read) the coordinator's mail.
    if (input.agent_id) return;
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
    if (!room && event === 'session-start') {
      // A repo with a room that this machine hasn't joined yet (e.g. a fresh cloud container): join it.
      const here = localRepo();
      const name = defaultName();
      if (here && name && validName(name)) {
        try {
          const got = fetchKey(here);
          if (!got.missing) {
            const r = repoRoom(here.owner, here.repo);
            writeConfig(r.id, { kind: 'repo', ns: got.key.ns, room: r.id, label: r.label, repo: `${here.owner}/${here.repo}`, branch: null, path: r.path, name, kid: got.key.kid, k: got.key.k, gitDir: here.top, remote: here.remote });
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
      const lines = [
        `You are "${cfg.name}" in the aim room ${cfg.label ?? room}, where the agents working on this repo talk. Online now: ${st.online?.length ? st.online.join(', ') : 'nobody else'}.`,
        'Send with `aim send "..."` (or `aim send --to <name> "..."`). New messages are added to your context after tool calls while you work.',
        'So messages also reach you while you are idle: start `aim wait --timeout 0` as a background task now (it exits when a message arrives, which wakes you). When it exits, handle the message, then start it again.',
        ...(st.duplicate ? ['', `Warning: another online member also uses the name "${cfg.name}". Set AIM_NAME to a unique name (and BD_ACTOR to match), then \`aim join\` again.`] : []),
        ...(fresh.length ? ['', `${fresh.length} unread:`, ...fresh.map((e) => fmtMsg(e, cfg.name, false))] : []),
      ];
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
      return;
    }
    startDaemon(room);
    const { fresh, end } = unread(room);
    if (!fresh.length) return;
    if (event === 'stop' && input.stop_hook_active) return; // already continued once for messages
    markRead(room, end);
    const text = `New aim message${fresh.length > 1 ? 's' : ''} in ${cfg.label ?? room} (you are ${cfg.name}):\n${fresh.map((e) => fmtMsg(e, cfg.name, false)).join('\n')}\n(Reply with \`aim send\` if a reply is useful; no need to acknowledge everything.)`;
    if (event === 'stop') out(JSON.stringify({ decision: 'block', reason: text }));
    else {
      const name = event === 'user-prompt-submit' ? 'UserPromptSubmit' : 'PostToolUse';
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text } }));
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
    } else if (which === 'claude') {
      const project = args.includes('--project');
      const file = project ? path.join(localRepo()?.top ?? die('--project needs a git checkout'), '.claude', 'settings.json') : path.join(process.env.HOME, '.claude', 'settings.json');
      await installClaudeHooks(file, { autoInstall: args.includes('--auto-install') });
      out(
        project
          ? `Wrote aim hooks to ${file}. Commit it: every Claude Code session in this repo then installs aim if needed, joins the room, and sees new messages after each tool call.`
          : `Installed aim hooks in ${file}: new messages reach you after each tool call and on each prompt, and you won't end a turn with unread ones. New sessions pick them up (or run /hooks).`,
      );
    } else die('usage: aim hooks pi | claude [--project]');
  },

  async log(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' }, last: { type: 'string', default: '20' } } });
    const room = pickRoom(values.room);
    const cfg = loadConfig(room);
    const entries = readLog(room);
    const acks = new Map();
    const seen = new Map();
    for (const e of entries) if (e.kind === 'ack') acks.set(e.id, [...(acks.get(e.id) ?? []), e.by]);
    for (const e of entries) if (e.kind === 'seen') seen.set(e.id, [...(seen.get(e.id) ?? []), e.by]);
    const msgs = entries.filter((e) => e.kind === 'in' || e.kind === 'out' || e.kind === 'notice').slice(-Number(values.last || 20));
    if (!msgs.length) out('No messages yet.');
    for (const e of msgs) {
      const line = fmtMsg(e, cfg.name, values.json);
      if (e.kind !== 'out' || values.json) {
        out(line);
        continue;
      }
      const got = acks.get(e.id) ?? [];
      const read = seen.get(e.id) ?? [];
      const unread = got.filter((n) => !read.includes(n));
      out(`${line}   (${!got.length ? 'not yet delivered' : `${read.length ? `read by ${read.join(', ')}` : ''}${read.length && unread.length ? '; ' : ''}${unread.length ? `delivered to ${unread.join(', ')}, not read yet` : ''}`})`);
    }
    markRead(room, entries.length);
  },

  async who(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' } } });
    const room = pickRoom(values.room);
    const st = (await ensureDaemon(room)) ?? readJson(files(room).state, {});
    const cfg = loadConfig(room);
    const everyone = [...new Set([...(st.known ?? []), ...(st.online ?? [])])].sort();
    if (values.json) return out(JSON.stringify({ me: cfg.name, room, online: st.online ?? [], known: everyone }));
    out(`Room "${room}", you are ${cfg.name}.`);
    if (!everyone.length) out('Nobody else has joined yet.');
    for (const n of everyone) out(`  ${n}: ${(st.online ?? []).includes(n) ? 'online' : 'offline'}`);
  },

  async status(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' }, json: { type: 'boolean' } } });
    const rooms = values.room ? [values.room] : listRooms();
    if (!rooms.length) return out('Not in any room.');
    for (const room of rooms) {
      const cfg = loadConfig(room);
      const pid = daemonPid(room);
      const st = readJson(files(room).state, {});
      const fresh = pid && st.updated && Date.now() - st.updated < 5000;
      if (values.json) {
        out(JSON.stringify({ room, name: cfg.name, daemon: pid || null, status: fresh ? st.status : 'stopped', online: st.online ?? [], pending: st.pending ?? 0, unread: unread(room).fresh.length }));
        continue;
      }
      out(`${room}: you are ${cfg.name}; daemon ${pid ? `pid ${pid}, ${fresh ? st.status : 'not responding'}` : 'stopped (any aim command restarts it)'}${st.version && st.version !== VERSION ? ` (running ${st.version}; it switches to ${VERSION} within 10 s)` : ''}`);
      if (fresh) out(`  online: ${st.online.length ? st.online.join(', ') : 'nobody else'}; undelivered: ${st.pending}; unread: ${unread(room).fresh.length}`);
    }
  },

  async up(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' } } });
    const room = pickRoom(values.room);
    const st = await ensureDaemon(room, { waitLive: true });
    out(`Connected to ${room} as ${st.name}. Online: ${st.online.length ? st.online.join(', ') : 'nobody else yet'}.`);
  },

  async stop(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' } } });
    const room = pickRoom(values.room);
    const pid = daemonPid(room);
    if (!pid) return out('Not running.');
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(100);
    out(`Stopped the ${room} daemon. Messages to you queue on the sender's side until you're back (\`aim up\`).`);
  },

  async leave(args) {
    const { values } = parseArgs({ args, options: { room: { type: 'string' } } });
    const room = pickRoom(values.room);
    const pid = daemonPid(room);
    if (pid) process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(100);
    fs.rmSync(files(room).dir, { recursive: true, force: true });
    out(`Left ${room} and deleted its local history and credentials.`);
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
  if (process.env.AIM_NAME) bindSession(process.env.AIM_NAME);
  if (!['_daemon', 'hook', 'help', 'watch'].includes(name)) warnSharedIdentity();
  try {
    await commands[name](rest);
  } catch (e) {
    die(e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' ? `${e.message}\n\n${HELP}` : (e?.stack ?? String(e)));
  }
}
