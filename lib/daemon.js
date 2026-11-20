// The per-room background process. It holds the relay connections, so the CLI can be a series of
// short commands (which is how agents run tools).
//
// Wire format, one track per member: <ns>/aim/<room>/u/<name>/<generation> track "m", one JSON object
// per group:
//   {t:'msg', id, from, to: [names] | null, text, ts, urgent?}   null `to` = everyone in the room
//   {t:'ack', id, from, to, rr?}                                 `from` received message `id` sent by `to`
//   {t:'seen', ids, from, to}                                    `from` read messages `ids` sent by `to`
//   {t:'presence', v: 2, from, listening, lastActive?, meta?, ts}
//                                                                aim <= 0.7 only: read (never sent) for older peers
// Presence (0.8): a second track per member, "presence", served by Caprid's publishPresence (a JSON
// document resent every PRESENCE_HEARTBEAT_MS; @caprid/relay >= 0.5) and followed with
// createPresenceView (a member is stale after three heartbeats with nothing new):
//   {v: 3, listening, agent: 'alive'|'gone'|'unknown', leaseAgeMs?, activeAgeMs?, meta?}
// `agent` is the agent's harness session (lib/lease.js), not this daemon. The ages are ages, never
// timestamps, so members' clocks don't have to agree; a receiver ages them on its own clock from when
// the document arrived. They are coarse (coarseAge), so the document changes rarely and the
// heartbeat, not a stream of changes, is the steady-state traffic. leaseAgeMs (last seen) is sent
// only while the agent is gone.
// MoQ is live-only (a write reaches whoever is subscribed right now), so delivery is made reliable
// here: the sender rewrites a message with backoff until each recipient acks it, and receivers
// de-duplicate by id. Caprid rule 9 (never replay a failed write automatically) is about writes the
// app can't make sense of twice; these are idempotent by id.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectRelaySubscriber, connectSupervisedPublisher, connectSupervisedSubscriber, readJSON } from '@caprid/relay';
import { createPresenceView, publishPresence } from '@caprid/relay/media';
import { createWebSocketTransport } from '@caprid/relay-websocket';
import { daemonEnv, files, lastActiveAt, listeningNow, loadConfig, mintToken, normalizePresenceMeta, pidAlive, readJson, readLog, writePrivate } from './core.js';
import { leaseState } from './lease.js';
import { fetchKeyAsync } from './repo.js';
import { createImpostors } from './impostors.js';

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
/** `p`, or a rejection after `ms` (a dial that never settles must not hang a loop forever). */
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
      t.unref?.();
    }),
  ]);
// Watchdog (0.6.6): a daemon that stays alive but stops talking to the relay (seen: after
// 'WebSocket dial failed' the reconnects stopped and the process kept running for 1.5 h, so every
// CLI check took it for healthy) replaces itself with a fresh one.
const WATCHDOG_NOT_LIVE_MS = 2 * 60_000; // publisher, subscriber or roster not live this long
const WATCHDOG_SILENT_MS = 3 * 60_000; // online peers' presence is stale (or, for <= 0.7 peers, unheard) this long
const PRESENCE_HEARTBEAT_MS = 10_000; // publisher resend and view staleness (3 heartbeats = 30 s)
/**
 * An age as the presence document carries it: whole minutes for the first 10 min, then 5 min steps
 * to an hour, then 30 min. A receiver that saw the change ages it exactly; one that subscribes later
 * is off by less than a step.
 */
export function coarseAge(ms) {
  const step = ms < 10 * 60_000 ? 60_000 : ms < 3600_000 ? 5 * 60_000 : 30 * 60_000;
  return Math.floor(ms / step) * step;
}
const MAX_TEXT = 256 * 1024;
const MAX_DAEMON_LOG_BYTES = 1024 * 1024;
const KEEP_DAEMON_LOG_BYTES = 200 * 1024;
const GIVE_UP_MS = 3 * 24 * 3600 * 1000; // stop retrying a message after 3 days
const SEEN_RESEND_WINDOW_MS = 24 * 3600 * 1000; // re-emit read receipts from last 24 h on restart

/** Trim daemon.log in place if it exceeds 1 MiB so long-running daemons never fill disk. */
function rotateLogIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_DAEMON_LOG_BYTES) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(KEEP_DAEMON_LOG_BYTES);
    fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
    fs.closeSync(fd);
    const nl = buf.indexOf(10);
    const kept = nl >= 0 ? buf.subarray(nl + 1) : buf;
    fs.writeFileSync(file, kept, { mode: 0o600 });
  } catch {}
}

/** Compact one-line error formatting for expected WebSocket idle/close reconnects. */
function fmtErr(e) {
  if (!(e instanceof Error)) return String(e);
  const msg = e.message || String(e);
  if (/idle timeout|Connection closed|WebSocket dial failed|WebSocket connection/i.test(msg)) return `${e.name}: ${msg}`;
  return e.stack ?? msg;
}

export async function runDaemon(room, deps = {}) {
  const relay = {
    connectRelaySubscriber,
    connectSupervisedPublisher,
    connectSupervisedSubscriber,
    createPresenceView,
    createWebSocketTransport,
    publishPresence,
    readJSON,
    ...deps.relay,
  };
  const doFetchKey = deps.fetchKey ?? fetchKeyAsync;
  const rawUnseen = process.env.AIM_UNSEEN_MINUTES;
  const UNSEEN_MS = deps.unseenMs !== undefined ? deps.unseenMs : rawUnseen === '0' ? 0 : Math.max(0, Number(rawUnseen || 10)) * 60_000;
  const RECONCILE_MS = deps.reconcileMs ?? 15_000;
  const TICK_MS = deps.tickMs ?? 200;
  const NOTICE_CHECK_MS = deps.noticeCheckMs ?? 15_000;
  const LISTEN_CHECK_MS = deps.listenCheckMs ?? 2000;
  const STATE_HEARTBEAT_MS = deps.stateHeartbeatMs ?? 3000; // <= 5 s so v0.6.x CLIs see us fresh during upgrades

  const f = files(room);
  const cfg = loadConfig(room);
  const me = cfg.name;
  rotateLogIfNeeded(f.daemonLog);
  const log = deps.log ?? ((...a) => process.stderr.write(`${new Date().toISOString()} ${a.map(fmtErr).join(' ')}\n`));

  const other = Number(readJson(f.pid, 0));
  if (!deps.noExit && other && other !== process.pid && pidAlive(other)) {
    log(`another daemon (pid ${other}) already serves this room`);
    return;
  }
  const myPid = deps.pid ?? process.pid;
  writePrivate(f.pid, String(myPid));
  fs.mkdirSync(f.outbox, { recursive: true, mode: 0o700 });
  if (!deps.noExit) process.on('unhandledRejection', (e) => log('unhandled', e));

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
  const outs = new Map(); // my message id -> {text, ts, to, urgent}
  const deliveredAt = new Map(); // `${id} ${by}` -> ts
  const seenBy = new Set(); // `${id} ${by}`
  const noticed = new Set(); // `${id} ${by}`
  const inIdx = []; // log line numbers of entries that count as unread until read: 'in' and 'notice'
  const inFrom = new Map(); // line -> {id, from, ts}
  entries.forEach((e, i) => {
    if (e.kind === 'out') outs.set(e.id, { text: e.text, ts: e.ts, to: e.to ?? null, urgent: Boolean(e.urgent) });
    else if (e.kind === 'ack' && e.rr) deliveredAt.set(`${e.id} ${e.by}`, e.ts); // rr: the peer sends read receipts
    else if (e.kind === 'seen') seenBy.add(`${e.id} ${e.by}`);
    else if (e.kind === 'notice' && e.ref) for (const r of e.refs ?? [e.ref]) noticed.add(`${r} ${e.by}`);
    if (e.kind === 'in' || e.kind === 'notice') inIdx.push(i);
    if (e.kind === 'in') inFrom.set(i, { id: e.id, from: e.from, ts: e.ts });
  });
  let lines = entries.length;
  for (const e of entries) {
    if (e.kind !== 'out') continue;
    const by = acked.get(e.id) ?? new Set();
    const waitFor = e.waitFor ? new Set(e.waitFor.filter((n) => !by.has(n))) : by.size ? new Set() : null;
    if (waitFor === null || waitFor.size) {
      pending.set(e.id, {
        payload: { t: 'msg', id: e.id, from: me, to: e.to, text: e.text, ts: e.ts, ...(e.urgent ? { urgent: 1 } : {}) },
        waitFor,
        next: 0,
        delay: 2000,
      });
    }
  }
  let fdClosed = false;
  const fd = fs.openSync(f.log, 'a', 0o600);
  const append = (o) => {
    if (stopping || fdClosed) return;
    fs.writeSync(fd, `${JSON.stringify(o)}\n`);
    if (o.kind === 'in' || o.kind === 'notice') inIdx.push(lines);
    if (o.kind === 'in') inFrom.set(lines, { id: o.id, from: o.from, ts: o.ts });
    lines++;
  };

  // ---- connections ----
  const createTransport = relay.createWebSocketTransport();
  const getToken = () => mintToken(cfg);
  const status = { pub: 'connecting', sub: 'connecting', roster: 'connecting' };
  const online = new Map(); // member -> Set(generation)
  const peerListening = new Map(); // aim <= 0.7 peers' 'm' presence: member -> {listening, activeAgeMs, meta, v, at}
  const peerPresence = new Map(); // presence documents (0.8+): member -> {doc, json, at, stale}
  let listening = false; // is a listener delivering my messages to my agent
  let myMeta = normalizePresenceMeta(readJson(f.presence));
  const PEER_PRESENCE_TTL = 3 * 60_000; // a <= 0.7 peer sends presence every minute; unheard this long: unknown
  /** An age reported `at` (local clock), as of now. */
  const aged = (ms, at) => (typeof ms === 'number' ? Math.max(0, ms + (Date.now() - at)) : undefined);
  const peerInfo = (peer) => {
    const p = peerPresence.get(peer);
    if (p) {
      const d = p.doc;
      return { listening: d.listening, v: d.v, agent: d.agent, leaseAgeMs: aged(d.leaseAgeMs, p.at), activeAgeMs: aged(d.activeAgeMs, p.at), meta: d.meta, stale: p.stale };
    }
    const v = peerListening.get(peer);
    return v && Date.now() - v.at < PEER_PRESENCE_TTL ? { listening: v.listening, v: v.v, activeAgeMs: aged(v.activeAgeMs, v.at), meta: v.meta } : undefined;
  };
  const knownListening = (peer) => peerInfo(peer)?.listening;
  let lastListenCheck = 0;
  const mine = new Set(); // my own publisher generations
  // Other sessions under my name (lib/impostors.js); holderSubs read their tracks to learn who.
  const impostors = createImpostors({ graceMs: deps.ownGenGraceMs ?? 5000 });
  const holderSubs = new Map(); // gen -> subscriptions on the roster connection ('presence', and 'm' for <= 0.7)
  const dropImpostor = (gen) => {
    impostors.gone(gen);
    for (const sub of holderSubs.get(gen) ?? []) {
      try {
        sub?.cancel?.();
      } catch {}
    }
    holderSubs.delete(gen);
  };
  /**
   * What the holder's object says about it, as impostors.noteObject reads it. Its lastActive is put
   * on our clock from an age: a presence document (0.8+) carries activeAgeMs; a <= 0.7 'm' presence
   * message carries lastActive and ts, both on the holder's clock.
   */
  const holderNote = (track, m) => {
    if (!m || typeof m !== 'object') return m;
    const meta = m.meta && typeof m.meta === 'object' ? normalizePresenceMeta(m.meta) : undefined;
    if (track === 'presence') {
      const age = Number.isFinite(m.activeAgeMs) && m.activeAgeMs >= 0 ? m.activeAgeMs : undefined;
      return { t: 'presence', meta, ...(age !== undefined ? { lastActive: Date.now() - age } : {}) };
    }
    if (m.t !== 'presence') return m;
    const age = Number.isFinite(m.lastActive) && Number.isFinite(m.ts) ? Math.max(0, m.ts - m.lastActive) : undefined;
    return { t: 'presence', meta, ...(age !== undefined ? { lastActive: Date.now() - age } : {}) };
  };
  const watchHolder = (conn, gen) => {
    if (holderSubs.has(gen) || typeof conn?.subscribe !== 'function') return;
    const subs = [];
    for (const track of ['presence', 'm']) {
      try {
        const sub = conn.subscribe(
          { namespace: ['u', me, gen], track },
          {
            onObject: (object) => {
              if (object.status !== 'normal' || !impostors.has(gen)) return;
              let m;
              try {
                m = relay.readJSON(object);
              } catch {
                return;
              }
              impostors.noteObject(gen, holderNote(track, m));
            },
          },
        );
        sub?.subscribed?.catch?.(() => {});
        sub?.ended?.catch?.(() => {});
        subs.push(sub);
      } catch (e) {
        log('holder subscribe', track, e);
      }
    }
    holderSubs.set(gen, subs);
  };
  let stopping = false;
  let lastInbound = Date.now(); // anything from the relay: an object from a peer or a roster event

  // Read receipts: initialized from log lines already read (< cursor) within the last 24 h so
  // receipts survive daemon crashes, upgrades, and container restarts (and re-emit on peer reconnect).
  let cursorSeen = Number(readJson(f.cursor, 0));
  const seenQueue = new Map(); // sender -> { ids: string[], dirty: boolean }
  const nowBoot = Date.now();
  for (const i of inIdx) {
    if (i >= cursorSeen) break;
    const m = inFrom.get(i);
    if (!m || nowBoot - (m.ts || 0) > SEEN_RESEND_WINDOW_MS) continue;
    const q = seenQueue.get(m.from) ?? { ids: [], dirty: true };
    if (!q.ids.includes(m.id)) q.ids.push(m.id);
    if (q.ids.length > 50) q.ids = q.ids.slice(-50);
    q.dirty = true;
    seenQueue.set(m.from, q);
  }

  // Repo rooms: the key in refs/aim/key may have been rotated. Re-read asynchronously so a slow
  // git fetch never freezes the daemon's event loop.
  let failures = 0;
  let lastRefresh = 0;
  let refreshing = false;
  const refreshKey = () => {
    if (cfg.kind !== 'repo' || refreshing) return;
    refreshing = true;
    lastRefresh = Date.now();
    void (async () => {
      try {
        const r = await doFetchKey({ top: cfg.gitDir && fs.existsSync(cfg.gitDir) ? cfg.gitDir : undefined, remote: cfg.remote });
        if (r.missing) return log('refs/aim/key is gone: the room was closed');
        if (r.key.kid !== cfg.kid || r.key.k !== cfg.k) {
          Object.assign(cfg, { ns: r.key.ns, kid: r.key.kid, k: r.key.k });
          writePrivate(f.config, JSON.stringify(cfg, null, 2));
          log('picked up a rotated room key', cfg.kid);
        }
      } catch (e) {
        log('key refresh failed:', e.message);
      } finally {
        refreshing = false;
      }
    })();
  };
  refreshKey();

  const publisher = await relay.connectSupervisedPublisher({
    namespace: ['u', me],
    getToken,
    createTransport,
    onStatus: (s, e) => {
      status.pub = s;
      failures = s === 'live' ? 0 : failures + (e ? 1 : 0);
      if (e) log('publisher', s, e);
    },
    onGeneration: (g) => {
      mine.add(g.generation);
      impostors.mine(g.generation);
      dropImpostor(g.generation);
    },
  });
  if (publisher.generation) mine.add(publisher.generation.generation), impostors.mine(publisher.generation.generation);
  status.pub = publisher.status;
  const track = publisher.registerTrack({ track: 'm', writeTimeoutMs: 5000 });

  const subscriber = await relay.connectSupervisedSubscriber({
    getToken,
    createTransport,
    onStatus: (s, e) => {
      status.sub = s;
      if (e) log('subscriber', s, e);
    },
  });
  status.sub = subscriber.status;

  // ---- presence: my document on the "presence" track, everyone's through a presence view ----
  const readLease = deps.leaseState ?? (() => leaseState());
  const presenceDoc = () => {
    const lease = readLease();
    const active = lastActiveAt(room);
    return {
      v: 3,
      listening,
      agent: lease.agent,
      ...(lease.agent === 'gone' && typeof lease.leaseAgeMs === 'number' ? { leaseAgeMs: coarseAge(lease.leaseAgeMs) } : {}),
      ...(active ? { activeAgeMs: coarseAge(Math.max(0, Date.now() - active)) } : {}),
      ...(Object.keys(myMeta).length ? { meta: myMeta } : {}),
    };
  };
  let myAgent = readLease();
  const heartbeatMs = deps.presenceHeartbeatMs ?? PRESENCE_HEARTBEAT_MS;
  const myPresence = relay.publishPresence(publisher, presenceDoc(), { heartbeatMs });
  const AGENTS = new Set(['alive', 'gone', 'unknown']);
  const ageOf = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);
  const parsePresence = (d) => {
    if (!d || typeof d !== 'object' || typeof d.v !== 'number') throw new TypeError('not an aim presence document');
    return {
      v: d.v,
      listening: Boolean(d.listening),
      agent: AGENTS.has(d.agent) ? d.agent : 'unknown',
      leaseAgeMs: ageOf(d.leaseAgeMs),
      activeAgeMs: ageOf(d.activeAgeMs),
      meta: d.meta && typeof d.meta === 'object' ? normalizePresenceMeta(d.meta) : undefined,
    };
  };
  const presenceView = relay.createPresenceView(
    subscriber,
    { prefix: ['u'], parse: parsePresence, heartbeatMs },
    {
      onChanged: ({ present }) => {
        lastInbound = Date.now();
        for (const [id, m] of present) {
          if (id === me) continue;
          const json = JSON.stringify(m.document);
          const prev = peerPresence.get(id);
          peerPresence.set(id, { doc: m.document, json, at: prev?.json === json ? prev.at : Date.now(), stale: m.stale });
        }
        for (const id of [...peerPresence.keys()]) if (!present.has(id)) peerPresence.delete(id);
      },
      onError: (e) => log('presence view', e),
    },
  );

  const acks = []; // ack payloads waiting for demand
  const onObject = (peer) => (object) => {
    lastInbound = Date.now();
    if (object.status !== 'normal') return;
    let m;
    try {
      m = relay.readJSON(object);
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
      // aim <= 0.7. lastActive and ts are both on the peer's clock: their difference is an age.
      const meta = m.meta && typeof m.meta === 'object' ? normalizePresenceMeta(m.meta) : undefined;
      const activeAgeMs = Number.isFinite(m.lastActive) && Number.isFinite(m.ts) ? Math.max(0, m.ts - m.lastActive) : undefined;
      const v = typeof m.v === 'number' ? m.v : 1;
      peerListening.set(peer, { listening: Boolean(m.listening), activeAgeMs, meta, v, at: Date.now() });
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
      if (!acked.has(m.id)) acked.set(m.id, new Set());
      const firstAck = !acked.get(m.id).has(peer);
      acked.get(m.id).add(peer);
      if (m.rr && !deliveredAt.has(`${m.id} ${peer}`)) deliveredAt.set(`${m.id} ${peer}`, Date.now());
      if (firstAck) append({ kind: 'ack', id: m.id, by: peer, ts: Date.now(), ...(m.rr ? { rr: 1 } : {}) });
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

  // Who is here: announcements under u/. Keeps last-known online set across brief reconnects (idle
  // timeouts), then reconciles both peers AND their generation sets once reconnected so stale
  // generations never leave ghost-online peers and restarted peers still trigger retry/presence resets.
  let rosterDownSince = 0;
  let rosterConn;
  const rosterLoop = (async () => {
    let backoff = deps.rosterBackoffMs ?? 500;
    while (!stopping) {
      let conn;
      let reconcileTimer;
      try {
        conn = await withTimeout(relay.connectRelaySubscriber({ getToken, createTransport }), 30_000, 'roster connect');
        rosterConn = conn;
        status.roster = 'live';
        rosterDownSince = 0;
        backoff = deps.rosterBackoffMs ?? 500;
        const connGens = new Map(); // peer -> Set(gen) announced on THIS connection
        const connOwn = new Set(); // generations under my own name announced on THIS connection
        const hadPeers = online.size > 0;
        if (hadPeers || impostors.suspects().length) {
          reconcileTimer = setTimeout(() => {
            // An unannounce missed while disconnected must not leave our name flagged as taken forever.
            for (const g of impostors.suspects()) if (!connOwn.has(g)) dropImpostor(g);
            for (const p of [...online.keys()]) {
              const fresh = connGens.get(p);
              if (!fresh || fresh.size === 0) {
                online.delete(p);
                peerListening.delete(p);
              } else {
                // Replace with this connection's live generations, dropping any stale pre-disconnect gens.
                online.set(p, new Set(fresh));
              }
            }
          }, RECONCILE_MS);
        }
        for await (const ev of conn.namespaceEvents({ prefix: ['u'] })) {
          if (ev.type === 'loaded') continue; // @caprid/relay 0.5: the end of the initial snapshot
          lastInbound = Date.now();
          const [, peer, gen] = ev.namespace;
          if (!peer) continue;
          const g = gen ?? '';
          if (peer === me) {
            if (ev.type === 'announced' && gen) connOwn.add(gen);
            else connOwn.delete(gen);
            if (ev.type === 'announced' && gen && !mine.has(gen)) {
              // The holder learns who we are the same way: our presence document (resent every 2 s).
              impostors.announced(gen);
              watchHolder(conn, gen);
            } else dropImpostor(gen);
            continue;
          }
          if (ev.type === 'announced') {
            if (!connGens.has(peer)) connGens.set(peer, new Set());
            connGens.get(peer).add(g);
            const prevGens = online.get(peer);
            const isNewOrRestart = !prevGens || !prevGens.has(g);
            if (!prevGens) online.set(peer, new Set());
            online.get(peer).add(g);
            if (isNewOrRestart) {
              for (const p of pending.values()) if (p.waitFor === null || p.waitFor.has(peer)) (p.next = 0), (p.delay = 2000);
              const q = seenQueue.get(peer);
              if (q && q.ids.length) q.dirty = true;
            }
            want(peer);
          } else {
            connGens.get(peer)?.delete(g);
            online.get(peer)?.delete(g);
            if (online.get(peer)?.size === 0) {
              online.delete(peer);
              peerListening.delete(peer);
            }
          }
        }
      } catch (e) {
        if (!stopping) log('roster', e);
      } finally {
        if (reconcileTimer) clearTimeout(reconcileTimer);
        holderSubs.clear(); // they die with this connection; the next one re-subscribes
        status.roster = 'reconnecting';
        if (!rosterDownSince) rosterDownSince = Date.now();
        try {
          conn?.close();
        } catch {}
        if (rosterConn === conn) rosterConn = undefined;
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
      const urgent = Boolean(o.urgent);
      // A room-wide message waits for whoever is online now; if nobody is, for the first to return.
      const audience = to ?? [...online.keys()];
      const waitFor = audience.length ? audience : null;
      append({ kind: 'out', id: o.id, from: me, to, text: o.text, ts: o.ts, waitFor, ...(urgent ? { urgent: 1 } : {}) });
      outs.set(o.id, { text: o.text, ts: o.ts, to, urgent });
      pending.set(o.id, {
        payload: { t: 'msg', id: o.id, from: me, to, text: o.text, ts: o.ts, ...(urgent ? { urgent: 1 } : {}) },
        waitFor: waitFor && new Set(waitFor),
        next: 0,
        delay: 2000,
      });
    }
  };

  const secs = (ms) => Math.floor(ms / 1000) * 1000;
  let lastStatePayload = '';
  let lastState = 0;
  const buildState = () => {
    const onlineList = [...online.keys()].sort();
    const peers = {};
    const aliases = {};
    for (const a of myMeta.aliases ?? []) (aliases[a] ??= []).push(me);
    for (const p of onlineList) {
      const info = peerInfo(p);
      if (!info) continue;
      peers[p] = {
        listening: info.listening,
        v: info.v,
        // Ages as of `updated`, in whole seconds so the state file changes at most once a second.
        ...(info.agent ? { agent: info.agent } : {}),
        ...(info.stale ? { stale: true } : {}),
        ...(info.leaseAgeMs !== undefined ? { leaseAgeMs: secs(info.leaseAgeMs) } : {}),
        ...(info.activeAgeMs !== undefined ? { activeAgeMs: secs(info.activeAgeMs) } : {}),
        ...(info.meta && Object.keys(info.meta).length ? { meta: info.meta } : {}),
      };
      for (const a of info.meta?.aliases ?? []) (aliases[a] ??= []).push(p);
    }
    return {
      pid: myPid,
      room,
      name: me,
      status: status.pub === 'live' && status.sub === 'live' && status.roster === 'live' ? 'live' : `connecting (publisher ${status.pub}, subscriber ${status.sub}, roster ${status.roster})`,
      online: onlineList,
      listening, // mine
      agent: myAgent.agent, // mine, from the lease (lib/lease.js)
      meta: myMeta,
      // Online members' listeners: true/false, or absent when they run an aim without presence.
      peersListening: Object.fromEntries(onlineList.filter((p) => knownListening(p) !== undefined).map((p) => [p, knownListening(p)])),
      peers,
      aliases,
      known: [...known].sort(),
      pending: pending.size,
      duplicate: impostors.duplicate(),
      ...(impostors.holder() ? { holder: impostors.holder() } : {}),
      version: VERSION,
    };
  };
  const writeState = (force = false) => {
    const obj = buildState();
    const payload = JSON.stringify(obj);
    if (!force && payload === lastStatePayload && Date.now() - lastState < STATE_HEARTBEAT_MS) return false;
    lastStatePayload = payload;
    lastState = Date.now();
    writePrivate(f.state, JSON.stringify({ ...obj, updated: lastState }));
    return true;
  };

  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    log('stopping:', why);
    try {
      rosterConn?.close();
    } catch {}
    try {
      presenceView.close();
    } catch {}
    subscriber.close();
    await Promise.race([publisher.close(), sleep(3000)]);
    try {
      if (Number(readJson(f.pid, 0)) === myPid) fs.rmSync(f.pid, { force: true });
      fs.rmSync(f.state, { force: true });
    } catch {}
    if (!fdClosed) {
      fdClosed = true;
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (!deps.noExit) process.exit(0);
  };
  if (deps.signal) {
    if (deps.signal.aborted) await shutdown('aborted');
    else deps.signal.addEventListener('abort', () => void shutdown('aborted'), { once: true });
  }
  if (!deps.noExit) {
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }
  log(`up as ${me} in ${room}`);

  // ---- read receipts: the CLI moves the cursor when the agent actually reads (read, wait, watch,
  // hooks); tell each sender, and keep an `unread` marker file for cheap hook checks ----
  const marker = path.join(f.dir, 'unread');
  const readReceipts = () => {
    const cursor = Number(readJson(f.cursor, 0));
    if (cursor > cursorSeen) {
      for (const i of inIdx) {
        if (i < cursorSeen || i >= cursor) continue;
        const m = inFrom.get(i);
        if (!m) continue;
        const ids = seenQueue.get(m.from)?.ids ?? [];
        if (!ids.includes(m.id)) ids.push(m.id);
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
    if (UNSEEN_MS <= 0) return;
    // Escalate only directly addressed messages (--to) or --urgent broadcasts, so room broadcasts
    // don't wake senders 10 minutes later about idle non-listening daemons.
    const byPeer = new Map();
    for (const [key, at] of deliveredAt) {
      if (Date.now() - at < UNSEEN_MS || seenBy.has(key) || noticed.has(key)) continue;
      const [id, by] = key.split(' ');
      const o = outs.get(id);
      if (!o) continue;
      if (!(o.urgent || (Array.isArray(o.to) && o.to.includes(by)))) continue;
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

  // ---- the send loop: acks first, then read receipts, then pending messages (presence has its own track) ----
  let lastVersionCheck = Date.now();
  let notLiveSince = 0;
  let lastWatchdog = Date.now();
  let allStaleSince = 0;
  let lastLogRotate = Date.now();
  // Hand over to a fresh daemon of the current code (pending messages are in the log).
  const respawn = async (why) => {
    const { spawn } = await import('node:child_process');
    fs.rmSync(f.pid, { force: true });
    spawn(process.execPath, [fileURLToPath(new URL('../bin/aim.js', import.meta.url)), '_daemon', room], { detached: true, env: daemonEnv(), stdio: ['ignore', fs.openSync(f.daemonLog, 'a'), fs.openSync(f.daemonLog, 'a')] }).unref();
    await shutdown(why);
  };
  writeState(true);
  while (!stopping) {
    if (!deps.noExit && Date.now() - lastWatchdog > 10_000) {
      lastWatchdog = Date.now();
      const live = status.pub === 'live' && status.sub === 'live' && status.roster === 'live';
      notLiveSince = live ? 0 : notLiveSince || Date.now();
      // <= 0.7 peers send 'm' presence every minute; 0.8+ peers' documents go stale when we stop
      // hearing their heartbeats. One wedged peer is its problem, not ours (respawning would not help,
      // and would repeat): it takes at least two, all stale, to suspect our own connection.
      const talkers = [...online.keys()].filter((p) => !peerPresence.has(p) && knownListening(p) !== undefined);
      const docs = [...online.keys()].map((p) => peerPresence.get(p)).filter(Boolean);
      allStaleSince = docs.length >= 2 && docs.every((d) => d.stale) ? allStaleSince || Date.now() : 0;
      if (notLiveSince && Date.now() - notLiveSince > WATCHDOG_NOT_LIVE_MS) {
        await respawn(`watchdog: not connected for ${Math.round((Date.now() - notLiveSince) / 1000)} s (publisher ${status.pub}, subscriber ${status.sub}, roster ${status.roster})`);
        break;
      } else if (talkers.length && Date.now() - lastInbound > WATCHDOG_SILENT_MS) {
        await respawn(`watchdog: nothing from the relay for ${Math.round((Date.now() - lastInbound) / 1000)} s with ${talkers.length} online peers`);
        break;
      } else if (allStaleSince && Date.now() - allStaleSince > WATCHDOG_SILENT_MS) {
        await respawn(`watchdog: the presence of all ${docs.length} online peers stale for ${Math.round((Date.now() - allStaleSince) / 1000)} s`);
        break;
      }
    }
    if (!fs.existsSync(f.config)) {
      await shutdown('left the room');
      break;
    }
    if (Number(readJson(f.pid, 0)) !== myPid) {
      await shutdown('replaced by another daemon');
      break;
    }
    if (!deps.noExit && Date.now() - lastVersionCheck > 10_000) {
      lastVersionCheck = Date.now();
      const v = versionOf();
      if (v && v !== VERSION) {
        await respawn(`upgraded ${VERSION} -> ${v}`); // aim was upgraded under us
        break;
      }
    }
    if (Date.now() - lastLogRotate > 10 * 60_000) {
      lastLogRotate = Date.now();
      rotateLogIfNeeded(f.daemonLog);
    }
    if (rosterDownSince && Date.now() - rosterDownSince > 20_000 && online.size) {
      online.clear();
      peerListening.clear();
    }
    ingest();
    if (failures >= 2 && Date.now() - lastRefresh > 60_000) refreshKey();
    readReceipts();
    if (Date.now() - lastNoticeCheck > NOTICE_CHECK_MS) unseenNotices();
    if (Date.now() - lastListenCheck > LISTEN_CHECK_MS) {
      lastListenCheck = Date.now();
      listening = listeningNow(room);
      myMeta = normalizePresenceMeta(readJson(f.presence));
      myAgent = readLease();
      try {
        myPresence.update(presenceDoc()); // sent only when it changed; Caprid resends it every 2 s
      } catch (e) {
        log('presence', e);
      }
    }
    writeState();
    let item;
    if (track.hasDemand) {
      const receipt = [...seenQueue].find(([, q]) => q.dirty && q.ids.length);
      if (acks.length) item = acks.shift();
      else if (receipt) {
        receipt[1].dirty = false;
        item = { t: 'seen', ids: receipt[1].ids, from: me, to: receipt[0] };
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
      await sleep(TICK_MS);
      continue;
    }
    try {
      await track.writeJSON(item);
    } catch (e) {
      if (item.t === 'ack') acks.unshift(item);
      else if (item.t === 'seen') {
        const q = seenQueue.get(item.to);
        if (q) q.dirty = true;
      }
      log('write', item.t, e?.code ?? e);
      await sleep(Math.min(500, TICK_MS * 2));
    }
  }
  await rosterLoop.catch(() => {});
}
