/**
 * aim for pi: delivers aim messages into the conversation as they arrive, and wakes an idle
 * session to handle them. Install with `aim hooks pi` (copies this file to
 * ~/.pi/agent/extensions/aim.ts), then /reload.
 *
 * It runs `aim watch --json` in the session's working directory (so it follows that repo's room)
 * and turns each message into a custom message with triggerTurn. Messages that arrive close
 * together are batched. Without aim installed or a room for this directory it stays silent.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function aimCommand(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const p = path.join(dir, "aim");
		if (fs.existsSync(p)) return p;
	}
	const local = path.join(os.homedir(), ".local", "bin", "aim");
	return fs.existsSync(local) ? local : undefined;
}

export default function (pi: ExtensionAPI) {
	let child: ChildProcess | undefined;
	let stopped = false;
	let restartTimer: NodeJS.Timeout | undefined;
	let flushTimer: NodeJS.Timeout | undefined;
	let batch: { from: string; to: string[] | null; text: string; label: string }[] = [];

	const flush = () => {
		flushTimer = undefined;
		if (!batch.length) return;
		const msgs = batch;
		batch = [];
		const label = msgs[0].label;
		const lines = msgs.map((m) => `${m.from}${m.to ? ` → ${m.to.join(", ")}` : ""}: ${m.text}`).join("\n\n");
		pi.sendMessage(
			{
				customType: "aim",
				content: `[aim] New message${msgs.length > 1 ? "s" : ""} in ${label}:\n\n${lines}\n\n(Reply with \`aim send\` if a reply is useful; no need to acknowledge everything.)`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	const start = (cwd: string, sessionId: string | undefined, notify: (msg: string) => void, setStatus: (s: string | undefined) => void) => {
		const aim = aimCommand();
		if (!aim || stopped) return;
		const started = Date.now();
		// The session id lets aim find the name this session uses (any aim command it runs with
		// AIM_NAME records it), since pi's own environment doesn't carry the agent's AIM_NAME.
		const env = { ...process.env, ...(sessionId ? { PI_SESSION_ID: sessionId } : {}) };
		const proc = spawn(aim, ["watch", "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		child = proc;
		let buf = "";
		let err = "";
		proc.stdout!.on("data", (d) => {
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
					setStatus("aim: idle (another session uses the shared name; set AIM_NAME)");
				} else if (ev.type === "watching") {
					setStatus(`aim: ${ev.label} as ${ev.name}`);
					notify(`aim: listening in ${ev.label} as ${ev.name}`);
				} else if (ev.type === "message") {
					batch.push({ from: ev.from, to: ev.to, text: ev.text, label: ev.label });
					if (!flushTimer) flushTimer = setTimeout(flush, 750);
				}
			}
		});
		proc.stderr!.on("data", (d) => (err += d.toString()));
		proc.on("exit", (code) => {
			if (child === proc) child = undefined;
			setStatus(undefined);
			if (stopped) return;
			// 3: this session's aim identity changed (it got a name): restart as that identity now.
			if (code === 3) {
				restartTimer = setTimeout(() => start(cwd, sessionId, notify, setStatus), 200);
				return;
			}
			// "not in any room" and similar exit at once: stay quiet. Crashes later: restart.
			if (Date.now() - started < 5000) return;
			restartTimer = setTimeout(() => start(cwd, sessionId, notify, setStatus), 5000);
		});
		void err;
	};

	pi.on("session_start", async (_event, ctx) => {
		stopped = false;
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {}
		start(
			ctx.cwd,
			sessionId,
			(msg) => ctx.hasUI && ctx.ui.notify(msg, "info"),
			(s) => ctx.hasUI && ctx.ui.setStatus("aim", s),
		);
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		if (restartTimer) clearTimeout(restartTimer);
		if (flushTimer) clearTimeout(flushTimer);
		child?.kill();
		child = undefined;
	});
}
