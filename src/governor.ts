/**
 * pi-governor: cut the cost of long Claude sessions when the prompt cache lifetime is fixed.
 * See DESIGN.md. Features: wake-aware warming, auth stop, checkpoint, return prompt, rollover.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---- config ---------------------------------------------------------------

/** $ per million tokens. */
export interface Prices {
	input: number;
	cacheWrite: number;
	cacheRead: number;
	output: number;
}
export interface GovernorConfig {
	checkpointMinTokens: number;
	rolloverTokens: number;
	askOnReturn: boolean;
	prices: Prices;
}
export const DEFAULTS: GovernorConfig = {
	checkpointMinTokens: 100_000,
	rolloverTokens: 200_000,
	askOnReturn: true,
	prices: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }, // Sonnet 5.5 first-party, $/MTok
};

/** Read the `governor` block of pi's settings, falling back to defaults per key. */
export function loadConfig(settings: unknown): GovernorConfig {
	const g = ((settings as { governor?: Partial<GovernorConfig> } | undefined)?.governor ?? {}) as Partial<GovernorConfig>;
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
	return {
		checkpointMinTokens: num(g.checkpointMinTokens, DEFAULTS.checkpointMinTokens),
		rolloverTokens: num(g.rolloverTokens, DEFAULTS.rolloverTokens),
		askOnReturn: typeof g.askOnReturn === "boolean" ? g.askOnReturn : DEFAULTS.askOnReturn,
		prices: {
			input: num(g.prices?.input, DEFAULTS.prices.input),
			cacheWrite: num(g.prices?.cacheWrite, DEFAULTS.prices.cacheWrite),
			cacheRead: num(g.prices?.cacheRead, DEFAULTS.prices.cacheRead),
			output: num(g.prices?.output, DEFAULTS.prices.output),
		},
	};
}

/** Refreshes whose total cost equals one rewrite: (write - read) / read. */
export function breakEvenRefreshes(p: Prices): number {
	return p.cacheRead > 0 ? Math.floor((p.cacheWrite - p.cacheRead) / p.cacheRead) : 0;
}

// ---- wake signal (phase 2 plugs in here) -----------------------------------

export const WAKE_EVENT = "governor:wake";
/** Tell the governor a wake is (or is no longer) expected from `id`, e.g. a running worker. */
export function expectWake(pi: Pick<ExtensionAPI, "events">, id: string, expected = true): void {
	pi.events.emit(WAKE_EVENT, { id, expected });
}

// ---- session reading ---------------------------------------------------------

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type Msg = NonNullable<ReturnType<typeof asMsg>>;
const asMsg = (e: Entry) => (e.type === "message" && e.message.role === "assistant" ? e.message : undefined);
const isWarm = (e: Entry) => e.type === "usage" && e.kind === "cache_warm";
/** Sanitize at the edge: only finite, non-negative numbers are known; anything else is unknown. */
const fin = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
const tokensOf = (m: Msg): number | undefined => {
	const [a, b, c] = [m.usage?.input, m.usage?.cacheRead, m.usage?.cacheWrite].map(fin);
	return a === undefined || b === undefined || c === undefined ? undefined : a + b + c;
};

/** Prompt size and time of the last real request; undefined when either is unknown. */
export function lastRequest(branch: Entry[]): { tokens: number; ts: number } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = asMsg(branch[i]);
		if (!m) continue;
		const tokens = tokensOf(m);
		const ts = fin(m.timestamp);
		return tokens === undefined || ts === undefined ? undefined : { tokens, ts };
	}
}
/** Last time the cache entry was written or refreshed. */
export function lastTouch(branch: Entry[]): number | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = asMsg(branch[i]);
		if (m) return fin(m.timestamp);
		const t = isWarm(branch[i]) ? fin(Date.parse(branch[i].timestamp)) : undefined;
		if (t !== undefined) return t;
	}
}
/** cache_warm refreshes since the last real request. */
export function refreshesSince(branch: Entry[]): number {
	let n = 0;
	for (let i = branch.length - 1; i >= 0 && !asMsg(branch[i]); i--) if (isWarm(branch[i])) n++;
	return n;
}
const textOf = (m: Msg): string => (m.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim();

export interface Report {
	refreshes: number;
	refreshCost: number;
	checkpoints: number;
	checkpointCost: number;
	rollovers: number;
	continues: number;
	rewritesAvoided: number;
	saved: number;
	net: number;
}
/** Every figure comes from usage pi recorded (cache_warm entries, assistant usage) plus governor entries. */
export function buildReport(branch: Entry[], cfg: GovernorConfig, ttlMs: number): Report {
	const r: Report = { refreshes: 0, refreshCost: 0, checkpoints: 0, checkpointCost: 0, rollovers: 0, continues: 0, rewritesAvoided: 0, saved: 0, net: 0 };
	const { cacheWrite, cacheRead } = cfg.prices;
	let prev: number | undefined;
	for (const e of branch) {
		if (isWarm(e) && e.type === "usage") {
			r.refreshes++;
			r.refreshCost += fin(e.usage?.cost?.total) ?? 0;
		} else if (e.type === "custom" && e.customType === "governor-checkpoint") {
			const d = e.data as { open?: boolean; cost?: number; rollover?: boolean; reopen?: boolean } | undefined;
			if (d?.open && !d.reopen) {
				r.checkpoints++;
				r.checkpointCost += fin(d.cost) ?? 0;
				if (d.rollover) r.rollovers++;
			}
		} else if (e.type === "custom" && e.customType === "governor-continue") {
			r.continues++;
			r.saved += fin((e.data as { saved?: number } | undefined)?.saved) ?? 0;
		}
		const m = asMsg(e);
		if (m) {
			// A request after more than one lifetime that still read the cache means refreshes kept it alive.
			const [ts, read, write] = [fin(m.timestamp), fin(m.usage?.cacheRead), fin(m.usage?.cacheWrite)];
			if (ts !== undefined && prev !== undefined && read !== undefined && write !== undefined && ts - prev > ttlMs && read > write) {
				r.rewritesAvoided++;
				r.saved += (read * (cacheWrite - cacheRead)) / 1e6;
			}
			prev = ts;
		}
	}
	r.net = r.saved - r.refreshCost - r.checkpointCost;
	return r;
}

// ---- estimator (feature 7, step 1: logged only, never shown or acted on) -----

export interface Estimate {
	usd: number;
	low: number;
	high: number;
	breakdown: { cacheReadTokens: number; writeTokens: number; outputTokens: number };
}
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/**
 * Price one request before it runs. Warm: the prior context is read from cache and the rest is written.
 * Cold: everything is written. A model with no cache-write price (cacheWrite 0) bills new tokens at input.
 * Output is the median of recent outputs; low/high use their min and max.
 * Any unknown input (non-finite, negative, no recent outputs) gives undefined.
 */
export function estimateRequest(a: { priorTokens: unknown; warm: boolean; newTokens: unknown; recentOutputs: unknown[]; prices: Prices }): Estimate | undefined {
	const [prior, added] = [fin(a.priorTokens), fin(a.newTokens)];
	const outs = a.recentOutputs.map(fin);
	const p = a.prices;
	if (prior === undefined || added === undefined || !outs.length || outs.some((o) => o === undefined)) return;
	if (![p.input, p.cacheRead, p.cacheWrite, p.output].every((x) => fin(x) !== undefined)) return;
	const writePrice = p.cacheWrite > 0 ? p.cacheWrite : p.input;
	const o = outs as number[];
	const read = a.warm ? prior : 0;
	const write = a.warm ? added : prior + added;
	const cost = (out: number) => (read * p.cacheRead + write * writePrice + out * p.output) / 1e6;
	return { usd: cost(median(o)), low: cost(Math.min(...o)), high: cost(Math.max(...o)), breakdown: { cacheReadTokens: read, writeTokens: write, outputTokens: median(o) } };
}
/** The model's catalog prices from pi ($/MTok, the same source as recorded costs); config `prices` when the model has none. */
export function pricesOf(model: { cost?: unknown } | undefined, fallback: Prices): Prices {
	const c = model?.cost as Partial<Prices> | undefined;
	const v = [fin(c?.input), fin(c?.cacheWrite), fin(c?.cacheRead), fin(c?.output)];
	return v.every((x) => x !== undefined) ? { input: v[0]!, cacheWrite: v[1]!, cacheRead: v[2]!, output: v[3]! } : fallback;
}
/** Predicted/actual ratios: the median, and the worst (farthest from 1 in either direction). */
export function ratioStats(ratios: number[]): { n: number; median: number; worst: number } | undefined {
	const r = ratios.filter((x) => Number.isFinite(x) && x > 0);
	if (!r.length) return;
	return { n: r.length, median: median(r), worst: r.reduce((w, x) => (Math.abs(Math.log(x)) > Math.abs(Math.log(w)) ? x : w)) };
}
const estimateStats = (branch: Entry[]) =>
	ratioStats(
		branch.flatMap((e) => {
			if (e.type !== "custom" || e.customType !== "governor-estimate") return [];
			const d = e.data as { predicted?: { usd?: unknown }; actual?: { usd?: unknown } } | undefined;
			const [p, a] = [fin(d?.predicted?.usd), fin(d?.actual?.usd)];
			return p !== undefined && a ? [p / a] : [];
		}),
	);

// ---- checkpoint --------------------------------------------------------------

interface Checkpoint {
	text: string;
	tokens: number;
	awt: boolean;
}
const hasAwt = (cwd: string) => existsSync(join(cwd, "awt"));
const HANDOFF_FILE = ".pi-governor/handoff.md";
export const checkpointPrompt = (awt: boolean): string =>
	"[governor checkpoint] The session may go idle and its cache expire. Do nothing else. " +
	(awt
		? 'Run `./awt state --now "<what you are doing>" --next "<next steps>"` and update refs and decisions as needed. '
		: `Write a handoff to ${HANDOFF_FILE} (create the directory): goal, state, decisions, files, next steps. `) +
	"Then reply with that handoff in under 300 words.";

const EXPIRED = "AWS credentials expired";
const NO_RESPONSE = "AWS credentials unavailable";
const usd = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(n < 0.1 ? 3 : 2)}` : "unknown");
const k = (n: number) => `${Math.round(n / 1000)}K`;
const MIN = 60_000;
/** pi caps idle warming at 30 minutes after the request that started the run; we act at 29. */
const IDLE_LIMIT = 29 * MIN;
const CHOICES = {
	resume: "Resume full context",
	continue: "Continue from checkpoint",
	resumeAlways: "Resume full context (don't ask again)",
	continueAlways: "Continue from checkpoint (don't ask again)",
};

type CmdCtx = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

// ---- extension ---------------------------------------------------------------

export default function governor(pi: ExtensionAPI) {
	let cfg = DEFAULTS;
	const wakes = new Set<string>();
	let phase: "idle" | "checkpoint" = "idle"; // "checkpoint": a governor turn is running; never start another
	let rollover = false;
	let attempted = false; // one checkpoint attempt per idle period, whatever the outcome
	let cpFrom = 0; // branch length when the checkpoint turn started: its own messages come after
	let cpAt = 0;
	let warmCount = 0; // warm decisions since the last real request (failed refreshes record no entry)
	let asking = false;
	let ended = false; // warming already ended for this idle period despite an expected wake
	const held: string[] = []; // user messages deferred while a checkpoint turn runs or the return question is open
	let checkpoint: Checkpoint | undefined;
	let authExpired = false;
	let refreshing = false;
	let remember: "resume" | "continue" | undefined;
	let pending: { text: string; saved: number } | undefined;
	let predicted: { est: Estimate; warm: boolean; approx: true } | undefined; // the in-flight real request's estimate

	/** Crash-proof a handler: log once per name and fail safe (undefined = no checkpoint, no switch, message delivered). */
	const logged = new Set<string>();
	const guard = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => {
		const fail = (e: unknown) => {
			if (!logged.has(name)) {
				logged.add(name);
				try {
					pi.appendEntry("governor-log", { msg: `${name} failed: ${e}` });
				} catch {}
			}
			return undefined;
		};
		return (...a: A): R | undefined => {
			try {
				const r = fn(...a);
				return r instanceof Promise ? (r.catch(fail) as R) : r;
			} catch (e) {
				return fail(e);
			}
		};
	};
	// biome-ignore lint/suspicious/noExplicitAny: handler types are checked by pi; the guard is generic
	const on = (ev: string, h: (...a: any[]) => unknown) => (pi.on as any)(ev, guard(ev, h));
	const later = (fn: () => void) => void setTimeout(guard("later", fn), 0);
	const ttlOf = (ctx: ExtensionContext) => (fin((ctx.model as { promptCache?: { short?: number } } | undefined)?.promptCache?.short) ?? 300) * 1000;
	const runCommand = (name: string) => pi.sendUserMessage(`/${name}`, { expandPromptTemplates: true });
	const release = () => {
		if (held.length) later(() => pi.sendUserMessage(held.splice(0).join("\n\n")));
	};

	pi.events.on(
		WAKE_EVENT,
		guard(WAKE_EVENT, (d: unknown) => {
			const { id, expected } = d as { id: string; expected: boolean };
			if (expected) wakes.add(id);
			else wakes.delete(id);
		}),
	);

	const closeCheckpoint = () => {
		if (!checkpoint) return;
		checkpoint = undefined;
		pi.appendEntry("governor-checkpoint", { open: false });
	};
	const startCheckpoint = (ctx: ExtensionContext, isRollover: boolean) => {
		phase = "checkpoint";
		attempted = true;
		rollover = isRollover;
		cpFrom = ctx.sessionManager.getBranch().length;
		cpAt = Date.now();
		try {
			pi.sendUserMessage(checkpointPrompt(hasAwt(ctx.cwd)));
		} catch (e) {
			phase = "idle";
			throw e;
		}
	};

	on("session_start", (_e, ctx) => {
		cfg = loadConfig(pi.getSettings());
		wakes.clear();
		phase = "idle";
		authExpired = refreshing = attempted = asking = ended = false;
		warmCount = 0;
		predicted = undefined;
		checkpoint = undefined;
		release();
		// Rebuild an open checkpoint so the return prompt survives a restart.
		for (const e of ctx.sessionManager.getBranch().reverse()) {
			if (e.type !== "custom" || e.customType !== "governor-checkpoint") continue;
			const d = e.data as (Checkpoint & { open: boolean }) | undefined;
			if (d?.open && typeof d.text === "string" && d.text) checkpoint = { text: d.text, tokens: fin(d.tokens) ?? 0, awt: d.awt === true };
			break;
		}
	});

	// Feature 1 + 2 + 3: decide each refresh.
	on("cache_warming_decision", (ev, ctx) => {
		if (refreshing) {
			// The previous refresh never got an HTTP response: credentials (for example a
			// credential_process that needs MFA) or the network failed. Retrying would re-run the
			// credential helper every few minutes, and the cache is probably lost already.
			authExpired = true;
			ctx.ui.setStatus("governor", NO_RESPONSE);
		}
		refreshing = false;
		if (authExpired) return { action: "stop" };
		const branch: Entry[] = ctx.sessionManager.getBranch();
		const last = lastRequest(branch);
		// Time left before pi's 30-minute idle stop: the next refresh would be the last one.
		const final = last !== undefined && Date.now() + ttlOf(ctx) * 0.9 > last.ts + IDLE_LIMIT;
		const forced = wakes.size > 0;
		const spent = Math.max(warmCount, refreshesSince(branch)) >= breakEvenRefreshes(cfg.prices);
		const canCheckpoint = !checkpoint && !attempted && phase === "idle" && ctx.isIdle() && last !== undefined && last.tokens >= cfg.checkpointMinTokens;
		// The last slot before pi's idle stop goes to the checkpoint when one will be taken; otherwise it is a normal refresh.
		const warm = forced ? !spent && !ended : !checkpoint && ev.action === "warm" && !(final && canCheckpoint);
		// Checkpoint before warming ends: at pi's idle stop (even if a wake still holds warming), at the cap, or when pi stops.
		if ((final || !warm) && canCheckpoint) startCheckpoint(ctx, false);
		if (forced && (final || spent)) ended = true; // warming ends here; a restarted run after the checkpoint must not warm on
		if (!warm) return { action: "stop" };
		refreshing = true;
		if (!forced) return;
		warmCount++;
		return { action: "warm" };
	});

	// Feature 2: a refresh gets its response through the same hook as real requests.
	on("after_provider_response", (ev, ctx) => {
		// Any HTTP response proves credentials and network work, so it ends the "no response" watch.
		// Only a response while idle can be the refresh's own, so only then do statuses count.
		const ours = refreshing && ctx.isIdle();
		refreshing = false;
		if (!ours) return;
		if (ev.status >= 400) {
			// Evidence for which statuses mean "credentials expired" on each provider; only 401 and 403 act.
			const type = ev.headers?.["x-amzn-errortype"] ?? ev.headers?.["X-Amzn-ErrorType"];
			pi.appendEntry("governor-log", { msg: `refresh failed: status ${ev.status}${type ? ` (${type})` : ""}` });
		}
		if (ev.status === 401 || ev.status === 403) {
			authExpired = true;
			ctx.ui.setStatus("governor", EXPIRED);
		}
	});
	// Feature 7 step 1: predict each real request, then pair it with the usage pi records. Nothing is shown or acted on.
	on("before_provider_request", (ev, ctx) => {
		predicted = undefined;
		if (refreshing && ctx.isIdle()) return; // a cache-warming refresh (same test as after_provider_response), not a real request
		const branch: Entry[] = ctx.sessionManager.getBranch();
		const [last, touch] = [lastRequest(branch), lastTouch(branch)];
		if (!last || touch === undefined) return;
		// Exact input tokens are not available before the request, so approximate from the payload: chars / 4.
		const total = JSON.stringify(ev.payload).length / 4;
		const recentOutputs = branch.flatMap((e) => asMsg(e)?.usage?.output ?? []).slice(-10);
		const warm = Date.now() - touch < ttlOf(ctx);
		const est = estimateRequest({ priorTokens: last.tokens, warm, newTokens: Math.max(0, total - last.tokens), recentOutputs, prices: pricesOf(ctx.model, cfg.prices) });
		if (est) predicted = { est, warm, approx: true };
	});
	on("message_end", (ev) => {
		const m = ev.message as Msg;
		if (m.role !== "assistant" || !predicted) return;
		const p = predicted;
		predicted = undefined;
		const actual = fin(m.usage?.cost?.total);
		if (m.stopReason === "error" || m.stopReason === "aborted" || actual === undefined) return;
		pi.appendEntry("governor-estimate", { predicted: p.est, actual: { usd: actual, tokens: tokensOf(m), outputTokens: fin(m.usage?.output) }, warm: p.warm, approx: p.approx });
	});

	on("agent_start", (_e, ctx) => {
		refreshing = false;
		warmCount = 0;
		if (phase !== "checkpoint") attempted = ended = false;
		if (authExpired) ctx.ui.setStatus("governor", undefined);
		authExpired = false;
	});

	/** The handoff file, if it is a readable file written after the checkpoint started. */
	const readHandoff = (ctx: ExtensionContext) => {
		try {
			const file = join(ctx.cwd, HANDOFF_FILE);
			if (!existsSync(file)) return;
			const st = statSync(file);
			if (!st.isFile()) throw new Error("not a file");
			if (st.mtimeMs >= cpAt - 2000) return readFileSync(file, "utf8").trim() || undefined;
		} catch {
			ctx.ui.notify(`${HANDOFF_FILE} is unreadable; using the checkpoint reply instead.`, "warning");
		}
	};

	// Features 3 + 5: finish a checkpoint turn, or start a rollover.
	on("agent_settled", (ev, ctx) => {
		const branch: Entry[] = ctx.sessionManager.getBranch();
		if (phase === "checkpoint") {
			phase = "idle";
			const wasRollover = rollover;
			rollover = false;
			// Only the checkpoint turn's own assistant message counts, never "the last one" in the session.
			const last = branch.slice(cpFrom).map(asMsg).filter((m): m is Msg => !!m).at(-1);
			if (ev.aborted || !last || last.stopReason === "error" || last.stopReason === "aborted") return release();
			const awt = hasAwt(ctx.cwd);
			const text = (!awt && readHandoff(ctx)) || textOf(last);
			checkpoint = { text, tokens: tokensOf(last) ?? 0, awt };
			pi.appendEntry("governor-checkpoint", { ...checkpoint, open: true, rollover: wasRollover, cost: fin(last.usage?.cost?.total) ?? 0 });
			if (wasRollover) later(() => runCommand("governor-rollover"));
			else release();
			return;
		}
		const last = lastRequest(branch);
		if (ev.aborted || attempted || checkpoint || authExpired || wakes.size > 0 || cfg.rolloverTokens === 0) return;
		if (last && last.tokens > cfg.rolloverTokens) startCheckpoint(ctx, true);
	});

	// Feature 4: on return after expiry, offer the checkpoint.
	on("input", async (ev, ctx) => {
		if (ev.source === "extension") return;
		if (phase === "checkpoint" || asking) {
			held.push(ev.text);
			if (phase === "checkpoint") ctx.ui.notify("Saving handoff, your message follows.", "info");
			return { action: "handled" };
		}
		attempted = ended = false; // the user spoke: a new idle period
		if (!checkpoint) return;
		const branch = ctx.sessionManager.getBranch();
		const touch = lastTouch(branch);
		const last = lastRequest(branch);
		if (touch === undefined || !last || Date.now() - touch <= ttlOf(ctx)) return closeCheckpoint();
		const p = cfg.prices;
		const resumeCost = (last.tokens * p.cacheWrite) / 1e6;
		const continueCost = ((checkpoint.text.length + ev.text.length) / 4) * p.cacheWrite / 1e6;
		let choice = remember;
		if (!choice && cfg.askOnReturn && ctx.hasUI) {
			const ago = Math.round((Date.now() - touch - ttlOf(ctx)) / MIN);
			asking = true;
			let picked: string | undefined;
			try {
				picked = await ctx.ui.select(`Cache expired ${ago} min ago. Context: ${k(last.tokens)} tokens.`, [
					`${CHOICES.resume}  ~${usd(resumeCost)}`,
					`${CHOICES.continue}  ~${usd(continueCost)} (new session, handoff + your message)`,
					CHOICES.resumeAlways,
					CHOICES.continueAlways,
				]);
			} catch {} // no usable UI: fall back to resume
			asking = false;
			if (picked?.startsWith(CHOICES.continueAlways)) choice = remember = "continue";
			else if (picked?.startsWith(CHOICES.resumeAlways)) choice = remember = "resume";
			else choice = picked?.startsWith(CHOICES.continue) ? "continue" : "resume";
		}
		if (!choice) {
			choice = "resume"; // no UI (print/json) or askOnReturn off: keep the session
			pi.appendEntry("governor-log", { msg: `cache expired, resuming full context (~${usd(resumeCost)})` });
		}
		if (choice === "resume") {
			release();
			return closeCheckpoint();
		}
		pending = { text: [ev.text, ...held.splice(0)].join("\n\n"), saved: Math.max(0, resumeCost - continueCost) || 0 };
		later(() => runCommand("governor-continue"));
		return { action: "handled" };
	});

	/** Start a fresh session from the checkpoint. A refused or failed switch keeps the checkpoint open and delivers `user` here. */
	const freshSession = async (ctx: CmdCtx, note: string, user?: string) => {
		const cp = checkpoint;
		if (!cp) return false;
		const seed =
			`Continuing from a checkpoint of the previous session (${ctx.sessionManager.getSessionFile() ?? "ephemeral"}).\n\n${cp.text}` +
			(cp.awt ? "\n\nRun `./awt resume` first." : "") +
			`\n\n${user ?? "Continue where you left off."}`;
		closeCheckpoint();
		ctx.ui.notify(note, "info");
		let ok = false;
		try {
			ok = !(await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				withSession: async (n) => {
					await n.sendUserMessage(seed);
				},
			})).cancelled;
		} catch {}
		if (!ok) {
			checkpoint = cp;
			pi.appendEntry("governor-checkpoint", { ...cp, open: true, reopen: true });
			ctx.ui.notify("The switch to a new session failed; staying in this session.", "warning");
			if (user) pi.sendUserMessage(user);
		}
		return ok;
	};
	pi.registerCommand("governor-rollover", {
		description: "Internal: start a fresh session from the checkpoint",
		handler: guard("governor-rollover", (_a: string, ctx: CmdCtx) =>
			freshSession(ctx, `Context passed ${k(cfg.rolloverTokens)} tokens; continuing in a fresh session from the checkpoint.`, held.splice(0).join("\n\n") || undefined),
		) as never,
	});
	pi.registerCommand("governor-continue", {
		description: "Internal: continue your message in a fresh session from the checkpoint",
		handler: guard("governor-continue", async (_a: string, ctx: CmdCtx) => {
			const p = pending;
			pending = undefined;
			if (!p || !checkpoint) return;
			if (await freshSession(ctx, "Continuing from the checkpoint in a new session.", p.text)) pi.appendEntry("governor-continue", { saved: p.saved });
		}) as never,
	});

	pi.registerCommand("governor", {
		description: "Show prompt-cache savings for this session and the governor settings",
		handler: guard("governor", async (_a: string, ctx: CmdCtx) => {
			const r = buildReport(ctx.sessionManager.getBranch(), cfg, ttlOf(ctx));
			const es = estimateStats(ctx.sessionManager.getBranch());
			const p = cfg.prices;
			ctx.ui.notify(
				[
					`Refreshes: ${r.refreshes} (${usd(r.refreshCost)})   break-even cap: ${breakEvenRefreshes(p)}`,
					`Checkpoints: ${r.checkpoints} (${usd(r.checkpointCost)})   rollovers: ${r.rollovers}   continued from checkpoint: ${r.continues}`,
					`Rewrites avoided: ${r.rewritesAvoided}   saved: ${usd(r.saved)}   net: ${usd(r.net)}`,
						es ? `Estimates: ${es.n} paired   predicted/actual median ${es.median.toFixed(2)}x   worst ${es.worst.toFixed(2)}x` : "Estimates: no estimates yet",
					`Config: checkpoint>=${k(cfg.checkpointMinTokens)} rollover>${cfg.rolloverTokens ? k(cfg.rolloverTokens) : "off"} ask=${cfg.askOnReturn} prices(in/write/read/out)=${p.input}/${p.cacheWrite}/${p.cacheRead}/${p.output}` +
						(wakes.size ? `   wakes expected: ${wakes.size}` : "") +
						(authExpired ? "   warming stopped: AWS credentials expired or unavailable" : ""),
				].join("\n"),
				"info",
			);
		}) as never,
	});
}
