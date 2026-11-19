// The per-room background process. It holds the relay connections, so the CLI can be a series of
// short commands (which is how agents run tools).
//
// Wire format, one track per member: <ns>/aim/<room>/u/<name>/<generation> track "m", one JSON object
// per group:
//   {t:'msg', id, from, to: [names] | null, text, ts}   null `to` = everyone in the room
//   {t:'ack', id, from, to}                              `from` received message `id` sent by `to`
// MoQ is live-only (a write reaches whoever is subscribed right now), so delivery is made reliable
// here: the sender rewrites a message with backoff until each recipient acks it, and receivers
// de-duplicate by id. Caprid rule 9 (never replay a failed write automatically) is about writes the
// app can't make sense of twice; these are idempotent by id.
import fs from 'node:fs';
import path from 'node:path';
import { connectRelaySubscriber, connectSupervisedPublisher, connectSupervisedSubscriber, readJSON } from '@caprid/relay';
import { createWebSocketTransport } from '@caprid/relay-websocket';
import { files, loadConfig, mintToken, pidAlive, readJson, readLog, writePrivate } from './core.js';
import { fetchKey } from './repo.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_TEXT = 256 * 1024;
const GIVE_UP_MS = 3 * 24 * 3600 * 1000; // stop retrying a message after 3 days

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
  for (const e of entries) {
    if (e.kind !== 'out') continue;
    const by = acked.get(e.id) ?? new Set();
    const waitFor = e.waitFor ? new Set(e.waitFor.filter((n) => !by.has(n))) : by.size ? new Set() : null;
    if (waitFor === null || waitFor.size) pending.set(e.id, { payload: { t: 'msg', id: e.id, from: me, to: e.to, text: e.text, ts: e.ts }, waitFor, next: 0, delay: 2000 });
  }
  const fd = fs.openSync(f.log, 'a', 0o600);
  const append = (o) => fs.writeSync(fd, `${JSON.stringify(o)}\n`);

  // ---- connections ----
  const createTransport = createWebSocketTransport();
  const getToken = () => mintToken(cfg);
  const status = { pub: 'connecting', sub: 'connecting', roster: 'connecting' };
  const online = new Map(); // member -> Set(generation)
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
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') return;
    // The relay only lets <peer> publish under u/<peer>, so the namespace is the sender's identity.
    if (m.t === 'msg') {
      if (Array.isArray(m.to) && !m.to.includes(me)) return;
      if (acks.length < 1000 && !acks.some((a) => a.id === m.id && a.to === peer)) acks.push({ t: 'ack', id: m.id, from: me, to: peer });
      if (seen.has(m.id)) return;
      seen.add(m.id);
      // The relay replays a track's latest group to a new subscriber: skip room-wide messages from
      // before we joined (ones addressed to us by name still count).
      if (!Array.isArray(m.to) && Number(m.ts) < (cfg.joinedAt ?? 0)) return;
      known.add(peer);
      const text = typeof m.text === 'string' ? m.text.slice(0, MAX_TEXT) : '';
      append({ kind: 'in', id: m.id, from: peer, to: Array.isArray(m.to) ? m.to : null, text, ts: Number(m.ts) || Date.now(), rx: Date.now() });
    } else if (m.t === 'ack' && m.to === me) {
      const p = pending.get(m.id);
      if (!p) return;
      known.add(peer);
      append({ kind: 'ack', id: m.id, by: peer, ts: Date.now() });
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
              for (const p of pending.values()) if (p.waitFor === null || p.waitFor.has(peer)) (p.next = 0), (p.delay = 2000);
            }
            online.get(peer).add(gen ?? '');
            want(peer);
          } else {
            online.get(peer)?.delete(gen ?? '');
            if (online.get(peer)?.size === 0) online.delete(peer);
          }
        }
      } catch (e) {
        if (!stopping) log('roster', e);
      } finally {
        status.roster = 'reconnecting';
        online.clear();
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
        known: [...known].sort(),
        pending: pending.size,
        duplicate: impostors.size > 0,
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

  // ---- the send loop: acks first, then messages whose retry time has come ----
  let lastState = 0;
  while (!stopping) {
    if (!fs.existsSync(f.config)) await shutdown('left the room');
    if (Number(readJson(f.pid, 0)) !== process.pid) await shutdown('replaced by another daemon');
    ingest();
    if (failures >= 2 && Date.now() - lastRefresh > 60_000) refreshKey();
    if (Date.now() - lastState > 1000) {
      writeState();
      lastState = Date.now();
    }
    let item;
    if (track.hasDemand) {
      if (acks.length) item = acks.shift();
      else {
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
