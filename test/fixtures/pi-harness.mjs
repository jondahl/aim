// Loads integrations/pi/aim.ts the way pi does, with a stand-in for pi's ExtensionAPI, and drives it
// from stdin: `start <cwd> <sessionId>`, `shutdown` (then the old ctx goes stale, as in pi, and any
// use of it throws), `exit`. Everything the extension does to pi is printed as one JSON line.
import readline from 'node:readline';

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
process.on('uncaughtException', (e) => {
  emit({ crash: String(e?.message ?? e) });
  process.exit(1);
});

const ext = (await import(new URL('../../integrations/pi/aim.ts', import.meta.url).href)).default;
const handlers = {};
const tools = {};
ext({
  on: (ev, fn) => (handlers[ev] = fn),
  sendMessage: (m, opts) => emit({ sent: m.content, opts }),
  registerTool: (t) => {
    tools[t.name] = t;
    emit({ toolRegistered: t.name });
  },
});

function makeCtx(cwd, sid) {
  let stale = false;
  const check = () => {
    if (stale) throw new Error('This extension ctx is stale after session replacement or reload.');
  };
  const ctx = {
    get cwd() {
      check();
      return cwd;
    },
    get hasUI() {
      check();
      return true;
    },
    get ui() {
      check();
      return { notify: (msg) => emit({ notify: msg }), setStatus: (_k, s) => emit({ status: s ?? null }) };
    },
    get sessionManager() {
      check();
      return { getSessionId: () => sid };
    },
  };
  return { ctx, expire: () => (stale = true) };
}

let cur;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const [cmd, ...a] = line.trim().split(' ');
  if (cmd === 'start') {
    cur = makeCtx(a[0], a[1]);
    await handlers.session_start({}, cur.ctx);
    emit({ started: a[1] });
  } else if (cmd === 'tool') {
    const name = a[0];
    const params = JSON.parse(a.slice(1).join(' '));
    const res = await tools[name].execute('tc1', params, undefined, undefined, cur.ctx);
    emit({ toolResult: name, text: res.content?.[0]?.text ?? '' });
  } else if (cmd === 'shutdown') {
    await handlers.session_shutdown({}, cur.ctx);
    cur.expire();
    emit({ shutdown: true });
  } else if (cmd === 'exit') process.exit(0);
}
