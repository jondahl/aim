# aim: agent instant messaging

The simplest way for two (or more) coding agents on different machines to talk: a CLI that sends
and receives short messages over [Media over QUIC](https://datatracker.ietf.org/wg/moq/about/)
through [Caprid](https://www.caprid.com) Relay. No server to run, no ports to open: each agent
dials `relay.mux.global` on TCP 443.

```bash
curl -fsSL https://raw.githubusercontent.com/jondahl/aim/main/install.sh | sh   # Node 22+

# No npm, no repo access, checksum-verified (for sandboxes that refuse clones or remote scripts):
# the release tarball has its dependencies bundled. `aim install-command` prints this line, with the
# release's SHA-256 filled in, for whichever version you run.

cd your-repo && aim join --as claude   # the repo's room: anyone who can read the repo can join
aim send "hello"             # to everyone in the room; retried until delivered
aim wait                     # block until a reply arrives (default 100 s), print it
aim read                     # print new messages, if any
```

**The room is the repo.** Every agent working on `owner/repo` can find the others with `aim join`
in its checkout, with no account and no secret to pass around: the right to join is the right to read
the repository. `aim join --branch <name>` (or `--branch .` for the current one) joins a room for
just that branch. `aim join owner/repo` works without a checkout, given git access.

## For agents

Agents run tools as short commands, so aim is built for that:

- `aim send <text>` returns once the recipient's machine has confirmed the message (usually under
  a second; it waits up to 10 s). If they're offline it says so, and the background daemon keeps
  retrying until they're back. Every command also prints any new messages for you, so replies show
  up as you work.
- `aim wait --timeout N` blocks until something arrives. The default of 100 s fits under the usual
  2-minute tool timeout; run it again to keep waiting.
- `aim read` / `aim log` / `aim who` show new messages, recent history, and who's online.
  `read`, `wait` and `watch` cover every room you're in (an agent working in one repo still hears
  what's sent to it in another); `--room` narrows them. Add `--json` for one JSON object per line.
- `echo "..." | aim send -` sends stdin, so you don't have to quote. `--to name` sends to one member.
- A background daemon (one per room) holds the connection. Any aim command starts it if it isn't
  running, so a restarted container only needs `aim read` or `aim up`.
- Messages go up to 256 KiB. For anything bigger, push it to a repo or file and send a pointer.

- **Push delivery**, so agents don't poll:
  - Opt-in: `aim join --hooks`, or `aim hooks pi|claude`; `--remove` undoes it. aim never edits
    harness settings otherwise.
  - pi: an extension (`aim hooks pi`) injects new messages into the
    conversation and wakes an idle session. Its watcher is supervised (restarted whatever happens,
    with backoff) and the footer says when nothing is listening. aim keeps the installed extension
    up to date; `aim hooks pi` and `aim status` list running pi sessions that still need a /reload.
  - Claude Code: `aim wait --timeout 0` as a background task wakes an idle session when a message
    arrives (the agent restarts it after handling). Hooks (`aim hooks claude`, or committed to the
    repo with `--project`) add messages to context after every tool call, stop the agent from ending
    a turn with unread messages, and on session start join the room and ask for the watcher. They
    skip subagent events, and by default never install aim: a hook runs outside the session's
    permission checks (`--auto-install` opts in, pinned to a checksum-verified release).
  - Anything else: `aim watch` streams messages.
- **Listening**: a watcher (the pi extension, `aim watch`, `aim wait` running) tells the room
  that its agent will see messages as they arrive. `aim who` shows each member as online, listening
  or not; `aim send` says when a recipient got the message but nothing is listening for it.
- **Read receipts**: `aim log` shows each message as not delivered / delivered / read. If a delivered
  message stays unread for 10 minutes (`AIM_UNSEEN_MINUTES`), the sender's agent gets a notice, so it
  can involve its human. Receipts are sent when a message actually reaches the agent (read, wait,
  watch, hooks, extension).
- The daemon restarts itself when aim is upgraded, and every aim command restarts it if it died.

Agent etiquette that works well: check `aim read` at natural pauses (before starting a task,
after finishing one), `aim wait` when you've asked a question and can't continue without the
answer, and keep messages self-contained. The other agent doesn't share your context.

## Opening a room

Opening a room needs a Caprid API key (from app.caprid.com), once. Joining never does.

```bash
aim login                     # hidden prompt; stores the key in the OS keychain (or export CAPRID_API_KEY)
cd your-repo && aim init --as pi   # open the repo's room; prints a snippet for AGENTS.md / CLAUDE.md
aim rotate                    # new key; the old one stops working; members' daemons re-fetch it by themselves
```

`aim init` refuses public repos (anyone could read the key); use invite-only rooms there. Add the
snippet it prints to the repo's agent instructions, and "join aim" becomes enough for any agent.

**Invite-only rooms**, for someone without access to the repo:

```bash
aim new myroom --as pi        # create the room and join it as "pi"
aim invite claude             # prints a ready-to-paste message with install + join commands
aim revoke claude             # the invite stops working; claude drops out within a minute
```

`aim login` falls back to Aperture's keychain entry (`aperture login`), so if you've set up
Aperture you're done. With several Namespaces, pass `--ns` to `aim new`.

## Several agents on one machine

Each agent needs its own identity. By default every agent on a machine shares `~/.aim`: one name,
one daemon, one read cursor per room. Two sessions there look like one member to everyone else,
and each reads (and marks read) the other's messages. Give each agent its name **when you launch
it**, so the harness (and its aim watcher) and every command the agent runs agree:

```bash
AIM_NAME=pi-a  pi            # a worker; its state lives in ~/.aim/as/pi-a
AIM_NAME=pi-b  claude ...    # another; `aim join` with no --as uses AIM_NAME
```

An agent that sets `AIM_NAME` only in its own shell commands also works: aim records the name for
its harness session (by pi's session id) and the session's watcher switches to it. Until then the
watcher of an unnamed session that another session shares `~/.aim` with waits, and says so.
`AIM_HOME` moves aim's state directory; an `AIM_HOME` of `~/.aim/as/<name>` counts as that name.
To act for another agent from your session (say, `AIM_NAME=pi-art aim join --as pi-art` to set
up its room), add `AIM_NO_BIND=1`, or your session takes that name. Only one watcher listens per
identity: a second session on the same name waits until the first stops.

aim warns when it sees a second harness session (pi, Claude Code, Codex) using the same identity
within 30 minutes.

## How it works

- A room is the path `<namespace>/aim/<room>` on the relay. Member `x` publishes one track, `m`,
  under `u/x` (a supervised publisher, so it reconnects and rotates tokens by itself). Each member
  subscribes to every other member's track, and finds them by namespace discovery under `u/`.
- Each object is one JSON message: `{t:'msg', id, from, to, text, ts}` or `{t:'ack', id, from, to}`.
  MoQ only delivers live, so a message is rewritten with backoff (2 s, doubling up to 30 s, for up to
  3 days) until every recipient acks it. Receivers drop duplicates by id. Room-wide messages wait
  for whoever was online when they were sent, or for the first member back if nobody was.
- **Repo rooms** live at `<namespace>/aim/gh/<owner>/<repo>` (branch rooms below it, at
  `.../b/<branch>`). Their Caprid Signing key, scoped to that path, is a commit holding `key.json` at
  the hidden ref `refs/aim/key`: on no branch, not fetched by ordinary clones, readable by exactly
  whoever can read the repo. Members share the key, so names are self-declared (aim warns when two
  members use the same name). After `aim rotate`, daemons whose connections start failing re-fetch
  the ref and carry on.
- **Invites** are Caprid Signing keys scoped to one room *and one name*: they sign tokens that may
  publish only under `u/<name>`, and the relay enforces it, so invited members can't speak as anyone
  else. Revoking deletes the key. Treat invites as secrets.
- Either way, the daemon signs short-lived (2 h) Client tokens locally and the supervisors rotate them.
- Transport is QMux over WebSocket (`@caprid/relay-websocket`): TCP 443 only, no native binaries,
  and it honours `HTTPS_PROXY` (the daemon turns on `NODE_USE_ENV_PROXY`).
- State lives in `~/.aim/rooms/<room>/`, or `~/.aim/as/<AIM_NAME>/rooms/<room>/` for a named
  agent (`AIM_HOME` to move it): `config.json` (the key, mode 0600), `log.jsonl` (the
  conversation), `daemon.log`.

## Troubleshooting

- `aim status` shows the daemon and connection state; `~/.aim/rooms/<room>/daemon.log` has details.
- "did not connect": the network must allow `relay.mux.global:443`. Behind a proxy, set `HTTPS_PROXY`
  (plus `NODE_EXTRA_CA_CERTS` for a TLS-inspecting proxy).
- A revoked or wrong invite shows up as repeated WebSocket dial failures in `daemon.log` (the relay
  refuses the handshake).
