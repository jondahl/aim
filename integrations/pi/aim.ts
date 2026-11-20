/**
 * aim for pi: delivers aim messages into the conversation as they arrive, and wakes an idle
 * session to handle them. Install with `aim hooks pi` (copies this file to
 * ~/.pi/agent/extensions/aim.ts), then /reload. aim keeps the installed copy up to date.
 *
 * It runs `aim watch --json` in the session's working directory and turns each message into a
 * custom message with triggerTurn. The watcher follows every room this session's identity is in.
 * Messages that arrive close together are batched. Without aim installed it stays silent.
 *
 * Identity: launch pi with AIM_NAME=<name> when several agents share this machine; the watcher
 * and every aim command the agent runs then agree. (An agent that only sets AIM_NAME in its own
 * commands works too: aim records the name for this session and the watcher switches to it.)
 *
 * The watcher is supervised: whatever makes it exit, it is started again (backoff up to 30 s), and
 * the footer says when nothing is listening. The extension registers this pi process in
 * ~/.aim/pi/<pid>.json, so `aim hooks pi` / `aim status` can tell which sessions need a /reload.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Bump on every change to this file: aim compares it with the installed copy and with what running
// pi sessions have loaded.
const EXTENSION_REV = 5;

function aimCommand(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const p = path.join(dir, "aim");
		if (fs.existsSync(p)) return p;
	}
	const local = path.join(os.homedir(), ".local", "bin", "aim");
	return fs.existsSync(local) ? local : undefined;
}

const registryFile = () => path.join(os.homedir(), ".aim", "pi", `${process.pid}.json`);

export default function (pi: ExtensionAPI) {
	let child: ChildProcess | undefined;
	let stopped = true;
	// Bumped on every session start/shutdown. Callbacks from a watcher started under an older
	// generation must not touch ctx: after reload or session replacement it is stale and any use
	// throws (uncaught, since it happens in a child-process event handler).
	let generation = 0;
	let restartTimer: NodeJS.Timeout | undefined;
	let flushTimer: NodeJS.Timeout | undefined;
	let batch: { from: string; to: string[] | null; text: string; label: string }[] = [];

	const flush = () => {
		flushTimer = undefined;
		if (!batch.length || stopped) return;
		const msgs = batch;
		batch = [];
		const labels = [...new Set(msgs.map((m) => m.label))];
		const lines = msgs
			.map((m) => `${labels.length > 1 ? `(${m.label}) ` : ""}${m.from}${m.to ? ` → ${m.to.join(", ")}` : ""}: ${m.text}`)
			.join("\n\n");
		pi.sendMessage(
			{
				customType: "aim",
				content: `[aim] New message${msgs.length > 1 ? "s" : ""} in ${labels.join(", ")}:\n\n${lines}\n\n(Reply with \`aim send\` if a reply is useful; no need to acknowledge everything.)`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	type Ui = { notify: (msg: string) => void; setStatus: (s: string | undefined) => void; setTitle: (t: string) => void; tagSession: (name: string) => void };

	const start = (cwd: string, sessionId: string | undefined, ui: Ui, gen: number, failures = 0) => {
		const live = () => !stopped && gen === generation;
		if (!live()) return;
		const retry = (ms: number, nextFailures: number) => {
			if (!live()) return;
			restartTimer = setTimeout(() => start(cwd, sessionId, ui, gen, nextFailures), ms);
		};
		const aim = aimCommand();
		if (!aim) return retry(60_000, failures); // not installed (yet): look again now and then, quietly
		const started = Date.now();
		// The session id lets aim find the name this session uses (any aim command it runs with
		// AIM_NAME records it), in case pi itself wasn't launched with AIM_NAME.
		const env = { ...process.env, ...(sessionId ? { PI_SESSION_ID: sessionId } : {}) };
		let proc: ChildProcess;
		try {
			proc = spawn(aim, ["watch", "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			ui.setStatus(`aim: not listening (${String(e)})`);
			return retry(30_000, failures + 1);
		}
		child = proc;
		let buf = "";
		let lastErr = "";
		let announced = "";
		proc.on("error", (e) => (lastErr = String(e)));
		proc.stdout!.on("data", (d) => {
			if (!live()) return;
			buf += d.toString();
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				if (ev.type === "waiting-identity") {
					ui.setStatus("aim: not listening (another session uses the shared identity: launch pi with AIM_NAME=<name>)");
				} else if (ev.type === "idle") {
					ui.setStatus(undefined); // not in any room: nothing to listen to here
				} else if (ev.type === "watching") {
					ui.setStatus(`aim: ${ev.name} in ${ev.label}`);
					ui.setTitle(`pi [${ev.name}] — ${path.basename(cwd)}`);
					ui.tagSession(ev.name);
					const what = `${ev.name} in ${ev.label}`;
					if (what !== announced) ui.notify(`aim: listening as ${what}`);
					announced = what;
				} else if (ev.type === "extension-updated") {
					ui.notify("aim updated its pi extension: run /reload to use the new version");
				} else if (ev.type === "message") {
					batch.push({ from: ev.from ?? "aim", to: ev.to ?? null, text: ev.text, label: ev.label ?? ev.room });
					if (!flushTimer) flushTimer = setTimeout(flush, 750);
				}
			}
		});
		proc.stderr!.on("data", (d) => {
			const s = d.toString().trim();
			if (s) lastErr = s.split("\n").pop()!.replace(/^aim: /, "");
		});
		proc.on("exit", (code) => {
			if (child === proc) child = undefined;
			if (!live()) return;
			// 3: become another identity, or aim was upgraded: start again at once.
			if (code === 3) return retry(200, 0);
			// Anything else: start again, backing off while it keeps failing fast.
			const n = Date.now() - started > 60_000 ? 0 : failures + 1;
			const delay = Math.min(30_000, 1000 * 2 ** Math.min(n, 5));
			ui.setStatus(`aim: not listening (${lastErr || `watcher exited with ${code}`}); retrying in ${Math.round(delay / 1000)}s`);
			retry(delay, n);
		});
	};

	let activeSessionId: string | undefined;

	// Native aim_send tool: pipes the message body over stdin (never argv or shell), so long or
	// multi-line messages work cleanly without heredocs or endpoint-security argv kills.
	if (typeof pi.registerTool === "function") {
		pi.registerTool({
			name: "aim_send",
			label: "aim send",
			description: "Send an aim message to the room or specific member(s)/@alias (pipes body over stdin; avoids shell quoting and long-argument limits).",
			promptSnippet: "Send an aim message to other agents (safe for long/multi-line text)",
			promptGuidelines: [
				"Use aim_send instead of shelling out to `aim send` when sending messages to other agents on aim.",
			],
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "Message text to send" },
					to: { type: "string", description: "Optional recipient name or @alias (comma-separated for several)" },
					room: { type: "string", description: "Optional room id when in several rooms" },
					urgent: { type: "boolean", description: "Escalate if unread on a room-wide broadcast" },
				},
				required: ["text"],
			} as any,
			async execute(_toolCallId: string, params: { text: string; to?: string; room?: string; urgent?: boolean }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
				const aim = aimCommand();
				if (!aim) return { content: [{ type: "text", text: "aim is not installed (see github.com/jondahl/aim)." }], details: {} };
				const args = ["send"];
				if (params.to) args.push("--to", String(params.to));
				if (params.room) args.push("--room", String(params.room));
				if (params.urgent) args.push("--urgent");
				args.push("-");
				const env = { ...process.env, ...(activeSessionId ? { PI_SESSION_ID: activeSessionId } : {}) };
				return await new Promise((resolve) => {
					const proc = spawn(aim, args, { cwd: ctx.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
					let out = "";
					let err = "";
					const onAbort = () => proc.kill();
					signal?.addEventListener("abort", onAbort, { once: true });
					proc.stdout?.on("data", (d) => (out += d.toString()));
					proc.stderr?.on("data", (d) => (err += d.toString()));
					proc.on("error", (e) => {
						signal?.removeEventListener("abort", onAbort);
						resolve({ content: [{ type: "text", text: `aim_send failed: ${String(e)}` }], details: {} });
					});
					proc.on("exit", (code) => {
						signal?.removeEventListener("abort", onAbort);
						const combined = [out.trim(), err.trim()].filter(Boolean).join("\n");
						resolve({
							content: [{ type: "text", text: combined || (code === 0 ? "Sent." : `aim send exited with ${code}`) }],
							details: { exitCode: code },
						});
					});
					proc.stdin?.end(String(params.text ?? ""));
				});
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// A session start without a shutdown first (session replacement): the previous watcher must
		// stop, or it would keep marking messages read that its stale callbacks then drop.
		if (restartTimer) clearTimeout(restartTimer);
		if (flushTimer) clearTimeout(flushTimer);
		try {
			flush();
		} catch {}
		batch = [];
		child?.kill();
		child = undefined;
		stopped = false;
		const gen = ++generation;
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {}
		activeSessionId = sessionId;
		try {
			fs.mkdirSync(path.dirname(registryFile()), { recursive: true, mode: 0o700 });
			fs.writeFileSync(registryFile(), JSON.stringify({ pid: process.pid, rev: EXTENSION_REV, cwd: ctx.cwd, sessionId, ts: Date.now() }));
		} catch {}
		const ui: Ui = {
			notify: (msg) => {
				if (gen !== generation) return;
				try {
					if (ctx.hasUI) ctx.ui.notify(msg, "info");
				} catch {}
			},
			setStatus: (s) => {
				if (gen !== generation) return;
				try {
					if (ctx.hasUI) ctx.ui.setStatus("aim", s);
				} catch {}
			},
			setTitle: (t) => {
				if (gen !== generation) return;
				try {
					if (ctx.hasUI && typeof (ctx.ui as any).setTitle === "function") (ctx.ui as any).setTitle(t);
				} catch {}
			},
			tagSession: (name) => {
				if (gen !== generation || !name) return;
				try {
					const hasName = typeof (pi as any).getSessionName === "function" && Boolean((pi as any).getSessionName());
					if (!hasName && typeof (pi as any).setSessionName === "function") (pi as any).setSessionName(name);
				} catch {}
			},
		};
		start(ctx.cwd, sessionId, ui, gen);
	});

	pi.on("session_shutdown", async () => {
		// The watcher already marked these read: hand them over now rather than drop them.
		if (flushTimer) clearTimeout(flushTimer);
		try {
			flush();
		} catch {}
		batch = [];
		stopped = true;
		generation++;
		if (restartTimer) clearTimeout(restartTimer);
		child?.kill();
		child = undefined;
		try {
			const reg = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
			if (reg.pid === process.pid) fs.rmSync(registryFile(), { force: true });
		} catch {}
	});
}
