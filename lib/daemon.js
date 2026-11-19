// The per-room background process. It holds the relay connections, so the CLI can be a series of
// short commands (which is how agents run tools).
//
// Wire format, one track per member: <ns>/aim/<room>/u/<name>/<generation> track "m", one JSON object
// per group:
//   {t:'msg', id, from, to: [names] | null, text, ts}   null `to` = everyone in the room
//   {t:'ack', id, from, to}                              `from` received message `id` sent by `to`
//   {t:'presence', from, listening, ts}                  whether a listener (aim watch / wait) is
//                                                        delivering `from`'s messages to its agent;
//                                                        sent on change and every minute
// MoQ is live-only (a write reaches whoever is subscribed right now), so delivery is made reliable
// here: the sender rewrites a message with backoff until each recipient acks it, and receivers
// de-duplicate by id. Caprid rule 9 (never replay a failed write automatically) is about writes the
// app can't make sense of twice; these are idempotent by id.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectRelaySubscriber, connectSupervisedPublisher, connectSupervisedSubscriber, readJSON } from '@caprid/relay';
import { createWebSocketTransport } from '@caprid/relay-websocket';
import { daemonEnv, files, listeningNow, loadConfig, mintToken, pidAlive, readJson, readLog, writePrivate } from './core.js';
import { fetchKey } from './repo.js';

const PKG = new URL('../package.json', import.meta.url);
const versionOf = () => {
  try {
    return JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  } catch {
    return undefined;
  }
};
const VERSION = versionOf();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_TEXT = 256 * 1024;
const GIVE_UP_MS = 3 * 24 * 3600 * 1000; // stop retrying a message after 3 days
const UNSEEN_MS = Number(process.env.AIM_UNSEEN_MINUTES || 10) * 60_000; // then tell the sender's agent

export async function runDaemon(room) {
  const f = files(room);
  const cfg = loadConfig(room);
  const me = cfg.name;
  const log = (...a) => process.stderr.write(`${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(' ')}\n`);

  const other = Number(readJson(f.pid, 0));
  if (other && other !== process.pid && pidAlive(other)) {
    log(`another daemon (pid ${other}) already serves this room`);
    return;
  }
  writePrivate(f.pid, String(process.pid));
  fs.mkdirSync(f.outbox, { recursive: true, mode: 0o700 });
  process.on('unhandledRejection', (e) => log('unhandled', e));

  // ---- state rebuilt from the log ----
  const entries = readLog(room);
  const seen = new Set();
  const known = new Set(); // every member we have ever heard from
  const pending = new Map(); // id -> {payload, waitFor: Set|null (null = any one member), next, delay}
  const acked = new Map(); // id -> Set(by)
  for (const e of entries) {
    if (e.kind === 'in') {
      seen.add(e.id);
      known.add(e.from);
    } else if (e.kind === 'ack') {
      known.add(e.by);
      if (!acked.has(e.id)) acked.set(e.id, new Set());
      acked.get(e.id).add(e.by);
    }
  }
  // Read receipts and notices, from the log.
  const outs = new Map(); // my message id -> {text, ts}
  const deliveredAt = new Map(); // `${id} ${by}` -> ts
  const seenBy = new Set(); // `${id} ${by}`
  const noticed = new Set(); // `${id} ${by}`
  const inIdx = []; // log line numbers of entries that count as unread until read: 'in' and 'notice'
  const inFrom = new Map(); // line -> {id, from}
  entries.forEach((e, i) => {
    if (e.kind === 'out') outs.set(e.id, { text: e.text, ts: e.ts });
    else if (e.kind === 'ack' && e.rr) deliveredAt.set(`${e.id} ${e.by}`, e.ts); // rr: the peer sends read receipts
    else if (e.kind === 'seen') seenBy.add(`${e.id} ${e.by}`);
    else if (e.kind === 'notice' && e.ref) for (const r of e.refs ?? [e.ref]) noticed.add(`${r} ${e.by}`);
    if (e.kind === 'in' || e.kind === 'notice') inIdx.push(i);
    if (e.kind === 'in') inFrom.set(i, { id: e.id, from: e.from });
  });
  let lines = entries.length;
  for (const e of entries) {
    if (e.kind !== 'out') continue;
    const by = acked.get(e.id) ?? new Set();
    const waitFor = e.waitFor ? new Set(e.waitFor.filter((n) => !by.has(n))) : by.size ? new Set() : null;
    if (waitFor === null || waitFor.size) pending.set(e.id, { payload: { t: 'msg', id: e.id, from: me, to: e.to, text: e.text, ts: e.ts }, waitFor, next: 0, delay: 2000 });
  }
  const fd = fs.openSync(f.log, 'a', 0o600);
  const append = (o) => {
    fs.writeSync(fd, `${JSON.stringify(o)}\n`);
    if (o.kind === 'in' || o.kind === 'notice') inIdx.push(lines);
    if (o.kind === 'in') inFrom.set(lines, { id: o.id, from: o.from });
    lines++;
  };

  // ---- connections ----
  const createTransport = createWebSocketTransport();
  const getToken = () => mintToken(cfg);
  const status = { pub: 'connecting', sub: 'connecting', roster: 'connecting' };
  const online = new Map(); // member -> Set(generation)
  const peerListening = new Map(); // member -> {listening, at}: from their presence objects (aim 0.6+)
  let listening = false; // is a listener delivering my messages to my agent
  let presenceDue = true;
  let presenceDueSince = Date.now();
  let lastPresence = 0;
  const presenceAt = []; // extra sends after a peer appears: it may not be subscribed to us yet
  const PEER_PRESENCE_TTL = 3 * 60_000; // a peer that stops sending presence (downgraded): unknown again
  const knownListening = (peer) => {
    const v = peerListening.get(peer);
    return v && Date.now() - v.at < PEER_PRESENCE_TTL ? v.listening : undefined;
  };
  let lastListenCheck = 0;
  const mine = new Set(); // my own publisher generations
  const impostors = new Set(); // generations under my name that are not mine: someone else uses it
  let stopping = false;

  // Repo rooms: the key in refs/aim/key may have been rotated. Re-read it at start and whenever the
  // connections keep failing; the supervisors pick the new key up at their next getToken.
  let failures = 0;
  let lastRefresh = 0;
  const refreshKey = () => {
    if (cfg.kind !== 'repo') return;
    lastRefresh = Date.now();
    try {
      const r = fetchKey({ top: cfg.gitDir && fs.existsSync(cfg.gitDir) ? cfg.gitDir : undefined, remote: cfg.remote });
      if (r.missing) return log('refs/aim/key is gone: the room was closed');
      if (r.key.kid !== cfg.kid || r.key.k !== cfg.k) {
        Object.assign(cfg, { ns: r.key.ns, kid: r.key.kid, k: r.key.k });
        writePrivate(f.config, JSON.stringify(cfg, null, 2));
        log('picked up a rotated room key', cfg.kid);
      }
    } catch (e) {
      log('key refresh failed:', e.message);
    }
  };
  refreshKey();

  const publisher = await connectSupervisedPublisher({
    namespace: ['u', me],
    getToken,
    createTransport,
    onStatus: (s, e) => {
      status.pub = s;
      failures = s === 'live' ? 0 : failures + (e ? 1 : 0);
      if (e) log('publisher', s, e);
    },
    onGeneration: (g) => mine.add(g.generation),
  });
  if (publisher.generation) mine.add(publisher.generation.generation);
  status.pub = publisher.status;
  const track = publisher.registerTrack({ track: 'm', writeTimeoutMs: 5000 });

  const subscriber = await connectSupervisedSubscriber({
    getToken,
    createTransport,
    onStatus: (s, e) => {
      status.sub = s;
      if (e) log('subscriber', s, e);
    },
  });
  status.sub = subscriber.status;

  const acks = []; // ack payloads waiting for demand
  const onObject = (peer) => (object) => {
    if (object.status !== 'normal') return;
    let m;
    try {
      m = readJSON(object);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || (typeof m.id !== 'string' && m.t !== 'seen' && m.t !== 'presence')) return;
    // The relay only lets <peer> publish under u/<peer>, so the namespace is the sender's identity.
    if (m.t === 'msg') {
      if (Array.isArray(m.to) && !m.to.includes(me)) return;
      if (acks.length < 1000 && !acks.some((a) => a.id === m.id && a.to === peer)) acks.push({ t: 'ack', id: m.id, from: me, to: peer, rr: 1 });
      if (seen.has(m.id)) return;
      seen.add(m.id);
      // The relay replays a track's latest group to a new subscriber: skip room-wide messages from
      // before we joined (ones addressed to us by name still count).
      if (!Array.isArray(m.to) && Number(m.ts) < (cfg.joinedAt ?? 0)) return;
      known.add(peer);
      const text = typeof m.text === 'string' ? m.text.slice(0, MAX_TEXT) : '';
      append({ kind: 'in', id: m.id, from: peer, to: Array.isArray(m.to) ? m.to : null, text, ts: Number(m.ts) || Date.now(), rx: Date.now() });
    } else if (m.t === 'presence') {
      peerListening.set(peer, { listening: Boolean(m.listening), at: Date.now() });
    } else if (m.t === 'seen' && m.to === me && Array.isArray(m.ids)) {
      for (const id of m.ids) {
        if (typeof id !== 'string' || !outs.has(id) || seenBy.has(`${id} ${peer}`)) continue;
        seenBy.add(`${id} ${peer}`);
        append({ kind: 'seen', id, by: peer, ts: Date.now() });
      }
    } else if (m.t === 'ack' && m.to === me) {
      const p = pending.get(m.id);
      if (!p) return;
      known.add(peer);
      if (m.rr) deliveredAt.set(`${m.id} ${peer}`, Date.now());
      append({ kind: 'ack', id: m.id, by: peer, ts: Date.now(), ...(m.rr ? { rr: 1 } : {}) });
      if (p.waitFor === null) pending.delete(m.id);
      else {
        p.waitFor.delete(peer);
        if (!p.waitFor.size) pending.delete(m.id);
      }
    }
  };
  const wanted = new Set();
  const want = (peer) => {
    if (peer === me || wanted.has(peer)) return;
    wanted.add(peer);
    subscriber.want(peer, { namespace: ['u', peer], track: 'm', generations: true }, { onObject: onObject(peer), onError: (e) => log('want', peer, e) });
  };
  for (const p of known) want(p);

  // Who is here: announcements under u/. Its own connection, because a want's generation discovery
  // and this prefix would overlap on one connection.
  (async () => {
    let backoff = 500;
    while (!stopping) {
      let conn;
      try {
        conn = await connectRelaySubscriber({ getToken, createTransport });
        status.roster = 'live';
        backoff = 500;
        for await (const ev of conn.namespaceEvents({ prefix: ['u'] })) {
          const [, peer, gen] = ev.namespace;
          if (!peer) continue;
          if (peer === me) {
            if (ev.type === 'announced' && gen && !mine.has(gen)) impostors.add(gen);
            else impostors.delete(gen);
            continue;
          }
          if (ev.type === 'announced') {
            if (!online.has(peer)) {
              online.set(peer, new Set());
              presenceAt.push(Date.now() + 2000, Date.now() + 10_000); // tell it whether we're listening, once it has subscribed
              for (const p of pending.values()) if (p.waitFor === null || p.waitFor.has(peer)) (p.next = 0), (p.delay = 2000);
            }
            online.get(peer).add(gen ?? '');
            want(peer);
          } else {
            online.get(peer)?.delete(gen ?? '');
            if (online.get(peer)?.size === 0) {
              online.delete(peer);
              peerListening.delete(peer);
            }
          }
        }
      } catch (e) {
        if (!stopping) log('roster', e);
      } finally {
        status.roster = 'reconnecting';
        online.clear();
        peerListening.clear();
        try {
          conn?.close();
        } catch {}
      }
      if (stopping) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  })();

  // ---- outbox: the CLI drops one JSON file per message ----
  const ingest = () => {
    let names;
    try {
      names = fs.readdirSync(f.outbox).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(f.outbox, n);
      const o = readJson(file);
      fs.rmSync(file, { force: true });
      if (!o || typeof o.text !== 'string' || typeof o.id !== 'string') continue;
      const to = Array.isArray(o.to) && o.to.length ? o.to : null;
      // A room-wide message waits for whoever is online now; if nobody is, for the first to return.
      const audience = to ?? [...online.keys()];
      const waitFor = audience.length ? audience : null;
      append({ kind: 'out', id: o.id, from: me, to, text: o.text, ts: o.ts, waitFor });
      outs.set(o.id, { text: o.text, ts: o.ts });
      pending.set(o.id, { payload: { t: 'msg', id: o.id, from: me, to, text: o.text, ts: o.ts }, waitFor: waitFor && new Set(waitFor), next: 0, delay: 2000 });
    }
  };

  const writeState = () =>
    writePrivate(
      f.state,
      JSON.stringify({
        pid: process.pid,
        room,
        name: me,
        status: status.pub === 'live' && status.sub === 'live' && status.roster === 'live' ? 'live' : `connecting (publisher ${status.pub}, subscriber ${status.sub}, roster ${status.roster})`,
        online: [...online.keys()].sort(),
        listening, // mine
        // Online members' listeners: true/false, or absent when they run an aim without presence.
        peersListening: Object.fromEntries([...online.keys()].filter((p) => knownListening(p) !== undefined).map((p) => [p, knownListening(p)])),
        known: [...known].sort(),
        pending: pending.size,
        duplicate: impostors.size > 0,
        version: VERSION,
        updated: Date.now(),
      }),
    );

  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    log('stopping:', why);
    subscriber.close();
    await Promise.race([publisher.close(), sleep(3000)]);
    try {
      if (Number(readJson(f.pid, 0)) === process.pid) fs.rmSync(f.pid, { force: true });
      fs.rmSync(f.state, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  log(`up as ${me} in ${room}`);

  // ---- read receipts: the CLI moves the cursor when the agent actually reads (read, wait, watch,
  // hooks); tell each sender, and keep an `unread` marker file for cheap hook checks ----
  let cursorSeen = Number(readJson(f.cursor, 0));
  const seenQueue = new Map(); // sender -> recent ids they sent that I have read (cumulative, so a lost receipt heals)
  const marker = path.join(f.dir, 'unread');
  const readReceipts = () => {
    const cursor = Number(readJson(f.cursor, 0));
    if (cursor > cursorSeen) {
      for (const i of inIdx) {
        if (i < cursorSeen || i >= cursor) continue;
        const m = inFrom.get(i);
        if (!m) continue;
        const ids = seenQueue.get(m.from)?.ids ?? [];
        ids.push(m.id);
        seenQueue.set(m.from, { ids: ids.slice(-50), dirty: true });
      }
      cursorSeen = cursor;
    }
    const unread = inIdx.filter((i) => i >= cursor).length;
    const has = fs.existsSync(marker);
    if (unread && !has) writePrivate(marker, String(unread));
    else if (!unread && has) fs.rmSync(marker, { force: true });
  };
  let lastNoticeCheck = 0;
  const unseenNotices = () => {
    lastNoticeCheck = Date.now();
    // One notice per recipient per check, however many of our messages it hasn't read.
    const byPeer = new Map();
    for (const [key, at] of deliveredAt) {
      if (Date.now() - at < UNSEEN_MS || seenBy.has(key) || noticed.has(key)) continue;
      const [id, by] = key.split(' ');
      const o = outs.get(id);
      if (!o) continue;
      noticed.add(key);
      const list = byPeer.get(by) ?? [];
      list.push({ id, at, text: o.text });
      byPeer.set(by, list);
    }
    for (const [by, list] of byPeer) {
      list.sort((a, b) => a.at - b.at);
      const first = list[0];
      const snippet = first.text.length > 80 ? `${first.text.slice(0, 77)}...` : first.text;
      const mins = Math.round((Date.now() - first.at) / 60_000);
      const what = list.length === 1 ? `your message "${snippet}"` : `${list.length} of your messages (oldest: "${snippet}")`;
      for (const m of list) noticed.add(`${m.id} ${by}`);
      const why = knownListening(by) === false ? 'nothing delivers its messages while it is idle, so it sees them when it next works or checks' : 'it may be idle';
      append({ kind: 'notice', id: `n${first.id}${by}`, ref: first.id, refs: list.map((m) => m.id), by, ts: Date.now(), text: `${by} received ${what} ${mins} min ago but its agent hasn't read ${list.length === 1 ? 'it' : 'them'} yet (${why}). If it matters, tell the user.` });
    }
  };

  // ---- the send loop: acks first, then read receipts, then messages whose retry time has come ----
  let lastState = 0;
  let lastVersionCheck = Date.now();
  while (!stopping) {
    if (!fs.existsSync(f.config)) await shutdown('left the room');
    if (Number(readJson(f.pid, 0)) !== process.pid) await shutdown('replaced by another daemon');
    if (Date.now() - lastVersionCheck > 10_000) {
      lastVersionCheck = Date.now();
      const v = versionOf();
      if (v && v !== VERSION) {
        // aim was upgraded under us: hand over to the new code (pending messages are in the log).
        const { spawn } = await import('node:child_process');
        fs.rmSync(f.pid, { force: true });
        spawn(process.execPath, [fileURLToPath(new URL('../bin/aim.js', import.meta.url)), '_daemon', room], { detached: true, env: daemonEnv(), stdio: ['ignore', fs.openSync(f.daemonLog, 'a'), fs.openSync(f.daemonLog, 'a')] }).unref();
        await shutdown(`upgraded ${VERSION} -> ${v}`);
      }
    }
    ingest();
    if (failures >= 2 && Date.now() - lastRefresh > 60_000) refreshKey();
    readReceipts();
    if (Date.now() - lastNoticeCheck > 15_000) unseenNotices();
    if (Date.now() - lastListenCheck > 2000) {
      lastListenCheck = Date.now();
      const now = listeningNow(room);
      if (now !== listening) (listening = now), (presenceDue = true);
      if (Date.now() - lastPresence > 60_000) presenceDue = true;
      if (presenceAt.some((t) => t <= Date.now())) {
        const later = presenceAt.filter((t) => t > Date.now());
        presenceAt.length = 0;
        presenceAt.push(...later);
        presenceDue = true;
      }
      if (!presenceDue) presenceDueSince = Date.now();
    }
    if (Date.now() - lastState > 1000) {
      writeState();
      lastState = Date.now();
    }
    let item;
    if (track.hasDemand) {
      const receipt = [...seenQueue].find(([, q]) => q.dirty);
      const presenceNow = () => {
        presenceDue = false;
        lastPresence = Date.now();
        return { t: 'presence', from: me, listening, ts: Date.now() };
      };
      // Presence goes after acks and receipts, but not later than 5 s after it fell due.
      if (presenceDue && Date.now() - presenceDueSince > 5000) item = presenceNow();
      else if (acks.length) item = acks.shift();
      else if (receipt) {
        receipt[1].dirty = false;
        item = { t: 'seen', ids: receipt[1].ids, from: me, to: receipt[0] };
      } else if (presenceDue) {
        item = presenceNow();
      } else {
        const now = Date.now();
        for (const [id, p] of pending) {
          if (now - p.payload.ts > GIVE_UP_MS) {
            pending.delete(id);
            continue;
          }
          if (p.next <= now) {
            item = p.payload;
            p.next = now + p.delay;
            p.delay = Math.min(p.delay * 2, 30_000);
            break;
          }
        }
      }
    }
    if (!item) {
      await sleep(200);
      continue;
    }
    try {
      await track.writeJSON(item);
    } catch (e) {
      if (item.t === 'ack') acks.unshift(item);
      log('write', item.t, e?.code ?? e);
      await sleep(500);
    }
  }
}
