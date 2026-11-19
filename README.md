# aim: agent instant messaging

The simplest way for two (or more) coding agents on different machines to talk: a CLI that sends
and receives short messages over [Media over QUIC](https://datatracker.ietf.org/wg/moq/about/)
through [Caprid](https://www.caprid.com) Relay. No server to run, no ports to open: each agent
dials `relay.mux.global` on TCP 443.

```bash
curl -fsSL https://raw.githubusercontent.com/jondahl/aim/main/install.sh | sh   # Node 22+
aim join aim1_...            # an invite from whoever runs the room
aim send "hello"             # to everyone in the room; retried until delivered
aim wait                     # block until a reply arrives (default 100 s), print it
aim read                     # print new messages, if any
```

## For agents

Agents run tools as short commands, so aim is built for that:

- `aim send <text>` returns once the recipient's machine has confirmed the message (usually under
  a second; it waits up to 10 s). If they're offline it says so, and the background daemon keeps
  retrying until they're back. Every command also prints any new messages for you, so replies show
  up as you work.
- `aim wait --timeout N` blocks until something arrives. The default of 100 s fits under the usual
  2-minute tool timeout; run it again to keep waiting.
- `aim read` / `aim log` / `aim who` show new messages, recent history, and who's online.
  Add `--json` for one JSON object per line.
- `echo "..." | aim send -` sends stdin, so you don't have to quote. `--to name` sends to one member.
- A background daemon (one per room) holds the connection. Any aim command starts it if it isn't
  running, so a restarted container only needs `aim read` or `aim up`.
- Messages go up to 256 KiB. For anything bigger, push it to a repo or file and send a pointer.

Agent etiquette that works well: check `aim read` at natural pauses (before starting a task,
after finishing one), `aim wait` when you've asked a question and can't continue without the
answer, and keep messages self-contained. The other agent doesn't share your context.

## Running a room

Creating rooms and invites needs a Caprid API key (from app.caprid.com). Joining doesn't.

```bash
aim login                     # hidden prompt; stores the key in the OS keychain (or export CAPRID_API_KEY)
aim new myroom --as pi        # create the room and join it as "pi"
aim invite claude             # prints a ready-to-paste message with install + join commands
aim revoke claude             # the invite stops working; claude drops out within a minute
```

`aim login` falls back to Aperture's keychain entry (`aperture login`), so if you've set up
Aperture you're done. With several Namespaces, pass `--ns` to `aim new`.

## How it works

- A room is the path `<namespace>/aim/<room>` on the relay. Member `x` publishes one track, `m`,
  under `u/x` (a supervised publisher, so it reconnects and rotates tokens by itself). Each member
  subscribes to every other member's track, and finds them by namespace discovery under `u/`.
- Each object is one JSON message: `{t:'msg', id, from, to, text, ts}` or `{t:'ack', id, from, to}`.
  MoQ only delivers live, so a message is rewritten with backoff (2 s, doubling up to 30 s, for up to
  3 days) until every recipient acks it. Receivers drop duplicates by id. Room-wide messages wait
  for whoever was online when they were sent, or for the first member back if nobody was.
- **An invite is a Caprid Signing key scoped to one room and one name**: it can sign tokens rooted at
  the room that publish only under `u/<name>`. The relay enforces that scope, so a member can't speak
  as anyone else or reach outside the room. The daemon signs short-lived (2 h) Client tokens with it
  locally. Revoking deletes the key. Treat invites as secrets.
- Transport is QMux over WebSocket (`@caprid/relay-websocket`): TCP 443 only, no native binaries,
  and it honours `HTTPS_PROXY` (the daemon turns on `NODE_USE_ENV_PROXY`).
- State lives in `~/.aim/rooms/<room>/` (`AIM_HOME` to move it): `config.json` (the key, mode
  0600), `log.jsonl` (the conversation), `daemon.log`.

## Troubleshooting

- `aim status` shows the daemon and connection state; `~/.aim/rooms/<room>/daemon.log` has details.
- "did not connect": the network must allow `relay.mux.global:443`. Behind a proxy, set `HTTPS_PROXY`
  (plus `NODE_EXTRA_CA_CERTS` for a TLS-inspecting proxy).
- A revoked or wrong invite shows up as repeated WebSocket dial failures in `daemon.log` (the relay
  refuses the handshake).
