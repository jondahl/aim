// Other sessions publishing under my own name: the roster shows every generation announced under
// u/<me>/, and the ones my supervised publisher did not open belong to someone else using the name.
//
// Generation fields start with the publisher's start time in fixed-width base 36, so they sort by
// age. A rotation announces my NEXT generation (newer than any of mine) before the publisher reports
// it as mine, so an unknown generation newer than all of mine gets a short grace; one older than my
// newest cannot be my rotation and counts at once (that is the case a joining session must refuse).
//
// Interface used by the daemon:
//   const t = createImpostors({ graceMs });
//   t.mine(gen)               the publisher reports gen as mine (drops it if it was suspected)
//   t.announced(gen) -> bool  an own-name gen announced on the roster; true if newly suspected
//   t.gone(gen)               an own-name gen unannounced
//   t.reconcile(liveGens)     after a roster reconnect: drop suspects not announced on the new connection
//   t.duplicate(now)          is someone else using my name (state.duplicate)
//   t.noteObject(gen, m)      an object read from a suspect gen's track: remember who holds the name
//   t.holder(now)             { harness, workspace, task, lastActive?, seenAt } when duplicate, else null
//   t.suspects()              gens currently suspected
export function createImpostors({ graceMs = 5000, now = () => Date.now() } = {}) {
  const own = new Set();
  const suspect = new Map(); // gen -> { since, immediate }
  let holder = null; // { gen, meta, lastActive, seenAt }
  const newestOwn = () => [...own].sort().at(-1);

  const drop = (gen) => {
    suspect.delete(gen);
    if (holder?.gen === gen) holder = null;
  };
  const duplicate = (t = now()) => [...suspect.values()].some((s) => s.immediate || t - s.since >= graceMs);

  return {
    mine(gen) {
      if (!gen) return;
      own.add(gen);
      drop(gen);
    },
    announced(gen) {
      if (!gen || own.has(gen) || suspect.has(gen)) return false;
      const newest = newestOwn();
      suspect.set(gen, { since: now(), immediate: Boolean(newest && gen < newest) });
      return true;
    },
    gone(gen) {
      drop(gen);
    },
    reconcile(liveGens) {
      for (const g of [...suspect.keys()]) if (!liveGens.has(g)) drop(g);
    },
    duplicate,
    noteObject(gen, m) {
      if (!suspect.has(gen) || !m || typeof m !== 'object') return;
      const prev = holder?.gen === gen ? holder : { gen };
      holder = { ...prev, seenAt: now() };
      if (m.t === 'presence') {
        holder.meta = m.meta && typeof m.meta === 'object' ? m.meta : {};
        if (typeof m.lastActive === 'number' && Number.isFinite(m.lastActive)) holder.lastActive = m.lastActive;
      }
    },
    holder(t = now()) {
      if (!holder || !duplicate(t)) return null;
      return { ...(holder.meta ?? {}), ...(holder.lastActive ? { lastActive: holder.lastActive } : {}), seenAt: holder.seenAt };
    },
    suspects() {
      return [...suspect.keys()];
    },
    has(gen) {
      return suspect.has(gen);
    },
  };
}
