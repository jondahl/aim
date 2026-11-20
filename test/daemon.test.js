// Real daemon-level tests using an in-memory fake relay injected into runDaemon(room, deps).
// Covers roster reconnect generations, self-healing read receipts, DM-only unseen notices,
// ack deduplication, presence v2 / v0.6.5 backward compatibility, and async refreshKey.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-daemon-test-'));
process.env.AIM_HOME = tmpHome;

const { runDaemon } = await import('../lib/daemon.js');
const { files, readJson, readLog, writePrivate } = await import('../lib/core.js');

const waitFor = async (pred, what, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
};

/** In-memory fake relay for driving runDaemon() deterministically. */
function makeFakeRelay() {
  const published = [];
  const wants = new Map(); // peer -> onObject callback
  let writeHook = null; // optional (item) => throw Error
  const rosterConns = [];

  class FakeRosterConn {
    constructor() {
      this.queue = [];
      this.waiter = null;
      this.closed = false;
      this.err = null;
    }
    push(ev) {
      if (this.closed) return;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve({ value: ev, done: false });
      } else {
        this.queue.push(ev);
      }
    }
    fail(err) {
      this.closed = true;
      this.err = err;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.reject(err);
      }
    }
    close() {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve({ value: undefined, done: true });
      }
    }
    namespaceEvents() {
      const self = this;
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (self.queue.length) return Promise.resolve({ value: self.queue.shift(), done: false });
              if (self.err) return Promise.reject(self.err);
              if (self.closed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve, reject) => {
                self.waiter = { resolve, reject };
              });
            },
          };
        },
      };
    }
  }

  let onRosterConnect = () => {};
  const track = {
    hasDemand: true,
    async writeJSON(item) {
      if (writeHook) writeHook(item);
      published.push(item);
    },
  };

  const relay = {
    createWebSocketTransport: () => () => ({}),
    readJSON: (obj) => obj.json,
    async connectSupervisedPublisher({ onGeneration }) {
      onGeneration?.({ generation: 'my-gen-1' });
      return {
        status: 'live',
        generation: { generation: 'my-gen-1' },
        registerTrack: () => track,
        async close() {},
      };
    },
    async connectSupervisedSubscriber() {
      return {
        status: 'live',
        want(peer, _spec, { onObject }) {
          wants.set(peer, onObject);
        },
        close() {},
      };
    },
    async connectRelaySubscriber() {
      const conn = new FakeRosterConn();
      rosterConns.push(conn);
      onRosterConnect(conn, rosterConns.length);
      return conn;
    },
  };

  return {
    relay,
    published,
    track,
    rosterConns,
    setWriteHook(fn) {
      writeHook = fn;
    },
    setOnRosterConnect(fn) {
      onRosterConnect = fn;
    },
    deliverFrom(peer, json) {
      const cb = wants.get(peer);
      assert.ok(cb, `daemon has not subscribed to peer "${peer}" yet`);
      cb({ status: 'normal', json });
    },
  };
}

function initRoom(room, name = 'neon', extraCfg = {}) {
  const f = files(room);
  fs.mkdirSync(f.outbox, { recursive: true });
  writePrivate(
    f.config,
    JSON.stringify({
      v: 1,
      kind: 'invite',
      ns: 'test',
      room,
      label: room,
      path: `aim/${room}`,
      name,
      kid: 'k1',
      k: Buffer.from('secret').toString('base64url'),
      joinedAt: 0,
      ...extraCfg,
    }),
  );
  return f;
}

test('roster reconnect prunes stale generations (no ghost-online peers) and resets retry backoff for restarted peers', async () => {
  const room = 'r-roster';
  const f = initRoom(room, 'neon');
  const fake = makeFakeRelay();
  fake.setOnRosterConnect((conn, n) => {
    if (n === 1) {
      conn.push({ type: 'announced', namespace: ['u', 'pi', 'gen-1'] });
    } else if (n === 2) {
      // pi restarted while we were disconnected: only gen-2 is live now!
      conn.push({ type: 'announced', namespace: ['u', 'pi', 'gen-2'] });
    }
  });

  const ac = new AbortController();
  const done = runDaemon(room, {
    relay: fake.relay,
    noExit: true,
    signal: ac.signal,
    tickMs: 20,
    reconcileMs: 120,
    rosterBackoffMs: 20,
    stateHeartbeatMs: 50,
    log: () => {},
  });

  try {
    await waitFor(() => readJson(f.state)?.online?.includes('pi'), 'pi online on conn 1');

    // Enqueue a message to pi; let initial send happen (backoff grows)
    writePrivate(path.join(f.outbox, 'm1.json'), JSON.stringify({ id: 'm1', to: ['pi'], text: 'ping', ts: Date.now() }));
    await waitFor(() => fake.published.some((p) => p.t === 'msg' && p.id === 'm1'), 'first m1 publish');
    const publishesBefore = fake.published.filter((p) => p.t === 'msg' && p.id === 'm1').length;

    // Simulate roster idle-timeout disconnect -> reconnects with pi on gen-2
    fake.rosterConns[0].fail(new Error('Connection closed: idle timeout'));
    await waitFor(() => fake.rosterConns.length >= 2, 'roster reconnected');
    // Reconnect with new gen-2 should immediately reset retry backoff and re-publish m1!
    await waitFor(() => fake.published.filter((p) => p.t === 'msg' && p.id === 'm1').length > publishesBefore, 'm1 retry reset on peer restart');

    // Wait for 120ms reconcile to prune stale gen-1
    await new Promise((r) => setTimeout(r, 200));

    // Now pi's gen-2 goes offline -> pi MUST go offline (stale gen-1 must not keep it online!)
    fake.rosterConns[1].push({ type: 'unannounced', namespace: ['u', 'pi', 'gen-2'] });
    await waitFor(() => !(readJson(f.state)?.online ?? []).includes('pi'), 'pi cleanly offline after gen-2 unannounced');
  } finally {
    ac.abort();
    await done;
  }
});

test('read receipts survive daemon restart, retry after write error, and re-emit on peer reconnect', async () => {
  const room = 'r-seen';
  const f = initRoom(room, 'neon');
  // Simulate message received and ALREADY marked read BEFORE daemon booted!
  fs.writeFileSync(f.log, `${JSON.stringify({ kind: 'in', id: 'in-1', from: 'claude-cloud', to: ['neon'], text: 'hi', ts: Date.now() })}\n`);
  writePrivate(f.cursor, '1');

  const fake = makeFakeRelay();
  let failOnce = true;
  fake.setWriteHook((item) => {
    if (item.t === 'seen' && failOnce) {
      failOnce = false;
      throw new Error('transient write error');
    }
  });
  fake.setOnRosterConnect((conn) => {
    conn.push({ type: 'announced', namespace: ['u', 'claude-cloud', 'g1'] });
  });

  const ac = new AbortController();
  const done = runDaemon(room, {
    relay: fake.relay,
    noExit: true,
    signal: ac.signal,
    tickMs: 20,
    rosterBackoffMs: 20,
    log: () => {},
  });

  try {
    // Despite failing on first write, daemon must re-queue dirty seen and succeed!
    await waitFor(() => fake.published.some((p) => p.t === 'seen' && p.to === 'claude-cloud' && p.ids.includes('in-1')), 'retried boot seen receipt');
    const seenCount1 = fake.published.filter((p) => p.t === 'seen' && p.to === 'claude-cloud').length;

    // Peer restarts with g2 -> daemon re-emits cumulative seen so peer heals!
    fake.rosterConns[0].push({ type: 'announced', namespace: ['u', 'claude-cloud', 'g2'] });
    await waitFor(() => fake.published.filter((p) => p.t === 'seen' && p.to === 'claude-cloud').length > seenCount1, 're-emitted seen on peer reconnect');
  } finally {
    ac.abort();
    await done;
  }
});

test('unseen notices escalate --to and --urgent broadcasts, skip normal broadcasts, and respect unseenMs=0', async () => {
  const room = 'r-unseen';
  const f = initRoom(room, 'neon');
  const fake = makeFakeRelay();
  fake.setOnRosterConnect((conn) => {
    conn.push({ type: 'announced', namespace: ['u', 'pi', 'g1'] });
    conn.push({ type: 'announced', namespace: ['u', 'pi-art', 'g1'] });
  });

  const ac = new AbortController();
  const done = runDaemon(room, {
    relay: fake.relay,
    noExit: true,
    signal: ac.signal,
    tickMs: 20,
    unseenMs: 40,
    noticeCheckMs: 30,
    log: () => {},
  });

  try {
    await waitFor(() => (readJson(f.state)?.online ?? []).length === 2, 'both peers online');
    // 1) Normal broadcast (should NOT trigger unseen notice)
    writePrivate(path.join(f.outbox, '1-bcast.json'), JSON.stringify({ id: 'bcast1', to: null, text: 'hello room', ts: Date.now() }));
    // 2) Direct --to message (SHOULD trigger unseen notice)
    writePrivate(path.join(f.outbox, '2-dm.json'), JSON.stringify({ id: 'dm1', to: ['pi'], text: 'direct ping', ts: Date.now() }));
    // 3) Urgent broadcast (SHOULD trigger unseen notice)
    writePrivate(path.join(f.outbox, '3-urg.json'), JSON.stringify({ id: 'urg1', to: null, text: 'urgent all', ts: Date.now(), urgent: 1 }));

    await waitFor(() => fake.published.some((p) => p.id === 'urg1'), 'messages published');
    // Deliver acks (with rr: 1) from pi and pi-art, plus a duplicate ack to test dedup!
    fake.deliverFrom('pi', { t: 'ack', id: 'bcast1', from: 'pi', to: 'neon', rr: 1 });
    fake.deliverFrom('pi-art', { t: 'ack', id: 'bcast1', from: 'pi-art', to: 'neon', rr: 1 });
    fake.deliverFrom('pi', { t: 'ack', id: 'dm1', from: 'pi', to: 'neon', rr: 1 });
    fake.deliverFrom('pi', { t: 'ack', id: 'dm1', from: 'pi', to: 'neon', rr: 1 }); // duplicate!
    fake.deliverFrom('pi-art', { t: 'ack', id: 'urg1', from: 'pi-art', to: 'neon', rr: 1 });

    await waitFor(() => readLog(room).filter((e) => e.kind === 'notice').length >= 2, 'notices emitted for dm1 and urg1');
    const entries = readLog(room);
    const notices = entries.filter((e) => e.kind === 'notice');
    assert.ok(notices.some((n) => n.by === 'pi' && n.refs.includes('dm1')), 'notice for direct --to dm1');
    assert.ok(notices.some((n) => n.by === 'pi-art' && n.refs.includes('urg1')), 'notice for --urgent urg1');
    assert.ok(!notices.some((n) => n.refs?.includes('bcast1')), 'no notice for normal broadcast');
    // Ack dedup check
    assert.equal(entries.filter((e) => e.kind === 'ack' && e.id === 'dm1' && e.by === 'pi').length, 1, 'duplicate ack not written twice');
  } finally {
    ac.abort();
    await done;
  }

  // Also test unseenMs = 0 disables notices entirely
  const room0 = 'r-unseen-off';
  const f0 = initRoom(room0, 'neon');
  const fake0 = makeFakeRelay();
  fake0.setOnRosterConnect((conn) => conn.push({ type: 'announced', namespace: ['u', 'pi', 'g1'] }));
  const ac0 = new AbortController();
  const done0 = runDaemon(room0, { relay: fake0.relay, noExit: true, signal: ac0.signal, tickMs: 20, unseenMs: 0, noticeCheckMs: 20, log: () => {} });
  try {
    await waitFor(() => readJson(f0.state)?.online?.includes('pi'), 'pi online');
    writePrivate(path.join(f0.outbox, 'm.json'), JSON.stringify({ id: 'dm0', to: ['pi'], text: 'quiet', ts: Date.now() }));
    await waitFor(() => fake0.published.some((p) => p.id === 'dm0'), 'dm0 sent');
    fake0.deliverFrom('pi', { t: 'ack', id: 'dm0', from: 'pi', to: 'neon', rr: 1 });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(readLog(room0).filter((e) => e.kind === 'notice').length, 0, 'unseenMs=0 suppresses notices');
  } finally {
    ac0.abort();
    await done0;
  }
});

test('presence v2 interoperates with literal v0.6.5 peers and async refreshKey updates rotated keys without overlapping', async () => {
  const room = 'r-compat';
  let fetchCount = 0;
  const f = initRoom(room, 'neon', { kind: 'repo', remote: 'https://example.invalid/o/r.git' });
  writePrivate(f.presence, JSON.stringify({ harness: 'pi', role: 'reviewer', task: 'dr-1', state: 'busy', aliases: ['reviewer'] }));

  const fake = makeFakeRelay();
  fake.setOnRosterConnect((conn) => {
    conn.push({ type: 'announced', namespace: ['u', 'old-peer', 'g1'] });
    conn.push({ type: 'announced', namespace: ['u', 'new-peer', 'g1'] });
  });

  const ac = new AbortController();
  const done = runDaemon(room, {
    relay: fake.relay,
    noExit: true,
    signal: ac.signal,
    tickMs: 20,
    listenCheckMs: 20,
    stateHeartbeatMs: 30,
    async fetchKey() {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 30));
      return { key: { ns: 'test', kid: 'k-rotated', k: Buffer.from('new-secret').toString('base64url'), path: 'aim/r-compat' } };
    },
    log: () => {},
  });

  try {
    await waitFor(() => fake.published.some((p) => p.t === 'presence' && p.v === 2), 'presence v2 published');
    const pres = fake.published.find((p) => p.t === 'presence');
    // Literal v0.6.5 onObject filter check:
    const passesV065 = (m) => m && typeof m === 'object' && !(typeof m.id !== 'string' && m.t !== 'seen' && m.t !== 'presence');
    assert.ok(passesV065(pres), 'presence v2 passes v0.6.5 receiver filter');
    assert.equal(pres.meta.role, 'reviewer');

    // Feed literal v0.6.5 presence (no v, no meta) and v0.7 presence
    fake.deliverFrom('old-peer', { t: 'presence', from: 'old-peer', listening: true, ts: Date.now() });
    fake.deliverFrom('new-peer', { t: 'presence', v: 2, from: 'new-peer', listening: false, lastActive: Date.now() - 600_000, meta: { role: 'coord', aliases: ['coordinator'] }, ts: Date.now() });

    await waitFor(() => readJson(f.state)?.aliases?.coordinator?.includes('new-peer'), 'state has aliases and peer presence');
    const st = readJson(f.state);
    assert.equal(st.peersListening['old-peer'], true);
    assert.equal(st.peersListening['new-peer'], false);
    assert.equal(st.peers['old-peer'].v, 1);
    assert.equal(st.peers['new-peer'].meta.role, 'coord');
    assert.deepEqual(st.aliases.reviewer, ['neon']);

    // Async refreshKey updated config.json cleanly
    await waitFor(() => readJson(f.config)?.kid === 'k-rotated', 'rotated key saved');
    assert.equal(fetchCount, 1);
  } finally {
    ac.abort();
    await done;
  }
});
