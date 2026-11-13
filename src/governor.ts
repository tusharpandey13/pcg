/**
 * pi-governor: cut the cost of long Claude sessions when the prompt cache lifetime is fixed.
 * See DESIGN.md. Features: wake-aware warming, auth stop, checkpoint, return prompt, rollover, cost before action.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

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
	idleCheckpoint: boolean; // take the checkpoint from our own timer when pi's warmer makes no decision
	autoContinue: boolean; // on return after expiry, continue from the checkpoint without asking when it saves enough
	history: boolean;
	confirmAbove: number; // USD; 0 = never ask before a prompt or a model-estimated task
	sessionBudget: number; // USD; 0 = no budget
	prices: Prices;
}
export const DEFAULTS: GovernorConfig = {
	checkpointMinTokens: 0, // an optional floor: checkpointPays decides
	rolloverTokens: 200_000,
	askOnReturn: true,
	idleCheckpoint: true,
	autoContinue: false,
	history: true,
	confirmAbove: 0,
	sessionBudget: 0,
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
		idleCheckpoint: typeof g.idleCheckpoint === "boolean" ? g.idleCheckpoint : DEFAULTS.idleCheckpoint,
		autoContinue: typeof g.autoContinue === "boolean" ? g.autoContinue : DEFAULTS.autoContinue,
		history: typeof g.history === "boolean" ? g.history : DEFAULTS.history,
		confirmAbove: num(g.confirmAbove, DEFAULTS.confirmAbove),
		sessionBudget: num(g.sessionBudget, DEFAULTS.sessionBudget),
		prices: {
			input: num(g.prices?.input, DEFAULTS.prices.input),
			cacheWrite: num(g.prices?.cacheWrite, DEFAULTS.prices.cacheWrite),
			cacheRead: num(g.prices?.cacheRead, DEFAULTS.prices.cacheRead),
			output: num(g.prices?.output, DEFAULTS.prices.output),
		},
	};
}

/** What a new or rewritten token costs: the cache-write price, or input for a model without one (cacheWrite 0). */
const writePriceOf = (p: Prices) => (p.cacheWrite > 0 ? p.cacheWrite : p.input);

/** Refreshes whose total cost equals one rewrite: (write - read) / read. */
export function breakEvenRefreshes(p: Prices): number {
	return p.cacheRead > 0 ? Math.max(0, Math.floor((writePriceOf(p) - p.cacheRead) / p.cacheRead)) : 0;
}

// Chance the user returns before the next refresh (about one cache lifetime x 0.9), given they are still away.
// Fitted to measured return rates on the maintainer's sessions: about 34% at 5-9.5 minutes away, falling to
// about 8% at 30 minutes. Break-even for a refresh at Bedrock Sonnet prices is about 4%.
export const RETURN_H0 = 0.53;
export const RETURN_TAU_MIN = 16;
export function returnChance(minutesAway: number): number {
	const m = Number.isFinite(minutesAway) && minutesAway > 0 ? minutesAway : 0;
	return RETURN_H0 * Math.exp(-m / RETURN_TAU_MIN);
}

/** Share of checkpoints assumed to be used on return. A prior, not measured. */
export const CHECKPOINT_USE_CHANCE = 0.25;
/** Output tokens of a checkpoint: a handoff of under 300 words (~400 tokens), written once and echoed in the reply, plus the tool call. */
export const CHECKPOINT_OUTPUT_TOKENS = 1000;
/**
 * A checkpoint pays when its expected saving covers its cost. Cost: two requests that read the context
 * (write the handoff, reply) plus the output. Saving: the rewrite avoided minus seeding the handoff into the new session.
 */
export function checkpointPays(tokens: number, p: Prices): boolean {
	const t = fin(tokens);
	if (t === undefined) return false;
	const cost = (2 * t * p.cacheRead + CHECKPOINT_OUTPUT_TOKENS * p.output) / 1e6;
	const saving = (Math.max(0, t - CHECKPOINT_OUTPUT_TOKENS) * writePriceOf(p)) / 1e6;
	return CHECKPOINT_USE_CHANCE * saving >= cost;
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
/** Dollars recorded on this branch: assistant usage plus cache_warm refreshes. Unknown numbers count as 0. */
export function sessionSpent(branch: Entry[]): number {
	let sum = 0;
	for (const e of branch) sum += fin(asMsg(e)?.usage?.cost?.total ?? (isWarm(e) && e.type === "usage" ? e.usage?.cost?.total : undefined)) ?? 0;
	return sum;
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
export function buildReport(branch: Entry[], cfg: GovernorConfig, ttlMs: number, prices: Prices = cfg.prices): Report {
	const r: Report = { refreshes: 0, refreshCost: 0, checkpoints: 0, checkpointCost: 0, rollovers: 0, continues: 0, rewritesAvoided: 0, saved: 0, net: 0 };
	const { cacheRead } = prices;
	const cacheWrite = writePriceOf(prices);
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

// ---- cost before action ------------------------------------------------------

/** New tokens assumed for a tool-result request when the session has no growth history yet. */
export const FALLBACK_STEP_TOKENS = 3000;
/** Assistant messages (requests) in each completed turn: the runs between consecutive user messages. */
export function requestsPerTurn(branch: Entry[]): number[] {
	const turns: number[] = [];
	let n = 0;
	for (const e of branch) {
		if (e.type === "message" && e.message.role === "user") {
			if (n > 0) turns.push(n);
			n = 0;
		} else if (asMsg(e)) n++;
	}
	if (n > 0) turns.push(n);
	return turns;
}
/** Prompt growth between consecutive requests (new tokens per step); unknown or shrinking steps are skipped. */
export function stepGrowth(branch: Entry[]): number[] {
	const sizes = branch.map(asMsg).filter((m): m is Msg => !!m).map(tokensOf);
	return sizes.flatMap((t, i) => (i > 0 && t !== undefined && sizes[i - 1] !== undefined && t >= sizes[i - 1]! ? [t - sizes[i - 1]!] : []));
}

// ---- task history and brief (feature 7, step 4) ---------------------------------

/** One finished task, as appended to governor-history.jsonl. Never holds cwd, file contents or the full prompt. */
export interface TaskRecord {
	v: 1;
	at: string;
	model: string;
	label: string;
	requests: number;
	tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
	usd: number;
	ms: number;
	tools: string[];
	estimate?: { usd: number; steps: number };
}
export const HISTORY_KEEP = 500;
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
/** Same-model past tasks ranked by word overlap (Jaccard) between the prompt and the label; score 0 is dropped. */
export function similarTasks(prompt: string, history: TaskRecord[], model: string, n = 3): TaskRecord[] {
	const a = words(prompt);
	return history
		.filter((r) => r.model === model)
		.map((r) => {
			const b = words(r.label);
			const both = [...a].filter((w) => b.has(w)).length;
			return { r, score: both / (a.size + b.size - both || 1) };
		})
		.filter((x) => x.score > 0)
		.sort((x, y) => y.score - x.score)
		.slice(0, n)
		.map((x) => x.r);
}
/** Actual / estimated cost over the last 10 tasks that carry a model estimate. */
export function calibration(history: TaskRecord[]): { n: number; median: number } | undefined {
	const s = ratioStats(history.filter((r) => fin(r.estimate?.usd)).slice(-10).map((r) => r.usd / r.estimate!.usd));
	return s && { n: s.n, median: s.median };
}
const ratioText = (r: number) => `${(r > 1 ? r : 1 / r).toFixed(1)}x ${r > 1 ? "low" : "high"}`;
const quote = (label: string) => `"${label.length > 40 ? `${label.slice(0, 40)}\u2026` : label}"`;
/** The one-paragraph note given to the model with each user prompt; undefined when there is nothing to say. */
export function buildBrief(a: { step?: string; left?: number; session: TaskRecord[]; history: TaskRecord[]; prompt: string; model: string | undefined }): string | undefined {
	const parts: string[] = [];
	if (a.step) parts.push(a.step);
	if (a.left !== undefined) parts.push(`Budget left ~${usd(a.left)}.`);
	if (a.session.length >= 2) {
		const u = a.session.map((r) => r.usd);
		parts.push(`Tasks this session: typical ${usd(median(u))}, high ${usd(Math.max(...u))} (${u.length}).`);
	}
	const sim = a.model ? similarTasks(a.prompt, a.history, a.model) : [];
	if (sim.length) parts.push(`Similar past tasks: ${sim.map((r) => `${usd(r.usd)}, ${r.requests} steps (${quote(r.label)})`).join("; ")}.`);
	const cal = calibration(a.history);
	if (cal && cal.n >= 3 && (cal.median > 1.2 || cal.median < 0.83)) parts.push(`Your estimates ran ${ratioText(cal.median)} (last ${cal.n}).`);
	if (!parts.length) return;
	return `[governor: cost estimates] ${parts.join(" ")} Before a task that will use tools, call estimate_cost.`;
}
/** Parse history lines, ignoring any that are corrupt; keep the last HISTORY_KEEP. */
export function parseHistory(text: string): TaskRecord[] {
	const out: TaskRecord[] = [];
	for (const line of text.split("\n")) {
		try {
			const r = JSON.parse(line) as TaskRecord;
			if (typeof r.model === "string" && typeof r.label === "string" && fin(r.usd) !== undefined && fin(r.requests) !== undefined) out.push(r);
		} catch {}
	}
	return out.slice(-HISTORY_KEEP);
}

// ---- checkpoint --------------------------------------------------------------

interface Checkpoint {
	text: string;
	tokens: number;
	awt: boolean;
}
const hasAwt = (cwd: string) => existsSync(join(cwd, "awt"));
const HANDOFF_FILE = ".pi-governor/handoff.md";
const CHECKPOINT_MARK = "[governor checkpoint]";
const SEED_MARK = "Continuing from a checkpoint of the previous session";
/** Prompts the governor sent itself: no brief, no task. */
const isOwnPrompt = (t: string) => t.startsWith(CHECKPOINT_MARK) || t.startsWith(SEED_MARK);
export const checkpointPrompt = (awt: boolean): string =>
	CHECKPOINT_MARK + " The session may go idle and its cache expire. Do nothing else. " +
	(awt
		? 'Run `./awt state --now "<what you are doing>" --next "<next steps>"` and update refs and decisions as needed. '
		: `Write a handoff to ${HANDOFF_FILE} (create the directory): goal, state, decisions, files, next steps. `) +
	"Then reply with that handoff in under 300 words.";

const EXPIRED = "AWS credentials expired";
const NO_RESPONSE = "AWS credentials unavailable";
const usd = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(n < 0.1 ? 3 : 2)}` : "unknown");
const k = (n: number) => `${Math.round(n / 1000)}K`;
const MIN = 60_000;
const COST_KEY = "governor-cost";
/** pi caps idle warming at 30 minutes after the request that started the run; we act at 29. */
const IDLE_LIMIT = 29 * MIN;
const IDLE_WATCHDOG = 0.92; // of the cache lifetime: after pi's first warming decision (0.9), before expiry
const AUTO_MIN_SAVING = 0.05; // USD: below this an automatic return is not worth losing the full context
const EVIDENCE_MIN_TOKENS = 10_000; // log "expired with no checkpoint" only for contexts that matter
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
	let pending: { text: string; saved: number; note?: string } | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined; // the watchdog: checkpoint if pi's warmer has not taken over
	let decided = false; // pi's warmer made a decision since the run settled, so its hook owns the checkpoint
	let costShown = false; // a governor-cost status is on screen, so it needs clearing
	let task: { from: number; label: string; startedAt: number; estimate?: { usd: number; steps: number }; reason?: string; gate?: "ok" | "declined" } | undefined; // the open task: a user prompt until the run settles
	let past: TaskRecord[] = []; // history file records, last HISTORY_KEEP
	let mine: TaskRecord[] = []; // records written by this session
	let raised = 0; // USD added to sessionBudget by "Allow another", until session_start
	let stopped = false; // the user chose "Stop tool calls" in this run
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

	const clearIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	/** Idle checkpoint (spec: docs/SPEC-idle-checkpoint.md). Armed when a run settles; stands down if pi's warmer decides first. */
	const armIdle = (ctx: ExtensionContext, last: { tokens: number } | undefined) => {
		clearIdle();
		if (!cfg.idleCheckpoint || !last || last.tokens < cfg.checkpointMinTokens || !checkpointPays(last.tokens, pricesOf(ctx.model, cfg.prices))) return;
		idleTimer = setTimeout(
			guard("idle-checkpoint", () => {
				idleTimer = undefined;
				const branch: Entry[] = ctx.sessionManager.getBranch();
				const [l, touch] = [lastRequest(branch), lastTouch(branch)];
				if (decided || phase !== "idle" || attempted || checkpoint || authExpired || wakes.size > 0 || !ctx.isIdle() || !l || touch === undefined || Date.now() - touch >= ttlOf(ctx)) return;
				pi.appendEntry("governor-log", { msg: `idle checkpoint at ${k(l.tokens)} tokens: no warming decision since the run settled` });
				startCheckpoint(ctx, false);
			}),
			ttlOf(ctx) * IDLE_WATCHDOG,
		);
		idleTimer.unref?.();
	};

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

	const historyFile = () => join(getAgentDir(), "governor-history.jsonl");
	const loadHistory = guard("history-load", () => {
		if (cfg.history && existsSync(historyFile())) past = parseHistory(readFileSync(historyFile(), "utf8"));
	});
	/** Close the open task: one record, kept in memory first so a failed write loses nothing. */
	const finishTask = (ctx: ExtensionContext, aborted: boolean) => {
		const t = task;
		task = undefined;
		if (!t || aborted || !cfg.history || !ctx.model) return;
		const msgs = ctx.sessionManager.getBranch().slice(t.from).map(asMsg).filter((m): m is Msg => !!m);
		const sum = (f: (m: Msg) => unknown) => msgs.reduce((s, m) => s + (fin(f(m)) ?? 0), 0);
		if (!msgs.length || msgs.every((m) => fin(m.usage?.cost?.total) === undefined)) return;
		const tools = msgs.flatMap((m) => (m.content ?? []).flatMap((c) => (c.type === "toolCall" ? [c.name] : [])));
		const rec: TaskRecord = {
			v: 1,
			at: new Date().toISOString(),
			model: `${ctx.model.provider}/${ctx.model.id}`,
			label: t.label,
			requests: msgs.length,
			tokens: { input: sum((m) => m.usage?.input), cacheRead: sum((m) => m.usage?.cacheRead), cacheWrite: sum((m) => m.usage?.cacheWrite), output: sum((m) => m.usage?.output) },
			usd: sum((m) => m.usage?.cost?.total),
			ms: Math.max(0, Date.now() - t.startedAt),
			tools: [...new Set(tools)],
			...(t.estimate && { estimate: t.estimate }),
		};
		past = [...past, rec].slice(-HISTORY_KEEP);
		mine.push(rec);
		mkdirSync(getAgentDir(), { recursive: true });
		appendFileSync(historyFile(), `${JSON.stringify(rec)}\n`);
	};

	on("session_start", (_e, ctx) => {
		cfg = loadConfig(pi.getSettings());
		wakes.clear();
		phase = "idle";
		authExpired = refreshing = attempted = asking = ended = decided = false;
		clearIdle();
		warmCount = 0;
		predicted = undefined;
		task = undefined;
		raised = 0;
		stopped = false;
		past = [];
		mine = [];
		checkpoint = undefined;
		loadHistory();
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
		decided = true;
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
		const prices = pricesOf(ctx.model, cfg.prices);
		const spent = Math.max(warmCount, refreshesSince(branch)) >= breakEvenRefreshes(prices);
		const canCheckpoint =
			!checkpoint && !attempted && phase === "idle" && ctx.isIdle() && last !== undefined && last.tokens >= cfg.checkpointMinTokens && checkpointPays(last.tokens, prices);
		// Without a wake, warm when the chance the user returns before the next refresh pays for it; pi's own action when that is unknown.
		const [warmCost, missCost] = [fin(ev.warmCost), fin(ev.missCost)];
		const priced = last !== undefined && warmCost !== undefined && missCost !== undefined && missCost > 0;
		const want = priced ? returnChance((Date.now() - last.ts) / MIN) * missCost >= warmCost : ev.action === "warm";
		// The last slot before pi's idle stop goes to the checkpoint when one will be taken; otherwise it is a normal refresh.
		const warm = forced ? !spent && !ended : !checkpoint && want && !(final && canCheckpoint);
		// Checkpoint before warming ends: at pi's idle stop (even if a wake still holds warming), at the cap, or when pi stops.
		const checkpointing = (final || !warm) && canCheckpoint;
		if (checkpointing) startCheckpoint(ctx, false);
		if (forced && (final || spent)) ended = true; // warming ends here; a restarted run after the checkpoint must not warm on
		// Display only: never changes the decision.
		if (!checkpointing && warmCost !== undefined && missCost !== undefined) {
			const touch = lastTouch(branch);
			if (warm) showCost(ctx, `warming ~${usd(warmCost)} per refresh \u00b7 a rewrite would cost ~${usd(missCost)}`);
			else if (touch !== undefined)
				showCost(ctx, `cache expires ~${new Date(touch + ttlOf(ctx)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} \u00b7 returning later costs ~${usd(missCost)} (rewrite)`);
		}
		if (!warm) return forced || ev.action !== "stop" ? { action: "stop" } : undefined;
		refreshing = true;
		if (forced) warmCount++;
		return forced || ev.action !== "warm" ? { action: "warm" } : undefined;
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

	/** Feature 7 step 2: show an estimate, never block or change anything. Unknown inputs clear the status. */
	const showCost = (ctx: ExtensionContext, text: string | undefined) => {
		if (text === undefined && !costShown) return;
		costShown = text !== undefined;
		try {
			ctx.ui.setStatus(COST_KEY, text);
		} catch {} // display only: never let it break the settle or checkpoint logic
	};
	const promptCost = guard("cost-prompt", (text: string, ctx: ExtensionContext) => {
		const branch: Entry[] = ctx.sessionManager.getBranch();
		const [last, touch] = [lastRequest(branch), lastTouch(branch)];
		const recentOutputs = branch.flatMap((e) => asMsg(e)?.usage?.output ?? []).slice(-10);
		const warm = touch !== undefined && Date.now() - touch < ttlOf(ctx);
		const added = String(text).length / 4;
		const est = last && touch !== undefined && estimateRequest({ priorTokens: last.tokens, warm, newTokens: added, recentOutputs, prices: pricesOf(ctx.model, cfg.prices) });
		// Only the first request can be cold; the rest of the turn reads the cache it just wrote.
		const step = last && stepCost(branch, last.tokens + added, ctx);
		if (!est || !step) {
			showCost(ctx, undefined);
			return;
		}
		const turns = requestsPerTurn(branch).slice(-10);
		const [lo, mid, hi] = turns.length >= 2 ? [Math.min(...turns), median(turns), Math.max(...turns)] : [1, 1, 1];
		const reqs = turns.length < 2 ? "1+ requests" : lo === hi ? `${lo} requests` : `${lo}\u2013${hi} requests`;
		const turnCost = (first: number, each: number, n: number) => first + (n - 1) * each;
		const [typical, high, cache] = [turnCost(est.usd, step.usd, mid), turnCost(est.high, step.high, hi), warm ? "cache warm" : "cache cold (rewrite)"];
		showCost(ctx, `~${usd(typical)} \u00b7 ${cache} \u00b7 ${reqs} \u00b7 high ${usd(high)}`);
		return { typical, high, cache, reqs };
	});
	/** A follow-up request inside a run: the context is warm and grows by this session's typical step. */
	const stepCost = (branch: Entry[], priorTokens: number, ctx: ExtensionContext, warm = true) => {
		const growth = stepGrowth(branch).slice(-10);
		const recentOutputs = branch.flatMap((e) => asMsg(e)?.usage?.output ?? []).slice(-10);
		return estimateRequest({ priorTokens, warm, newTokens: growth.length ? median(growth) : FALLBACK_STEP_TOKENS, recentOutputs, prices: pricesOf(ctx.model, cfg.prices) });
	};
	type EstimateArgs = { steps?: unknown; usd?: unknown; reason?: unknown };
	/** Validate estimate_cost args and store them on the open task (last call wins). */
	const recordEstimate = (p: EstimateArgs | undefined) => {
		const [steps, cost] = [fin(p?.steps), fin(p?.usd)];
		if (steps === undefined || !Number.isInteger(steps) || steps < 1 || cost === undefined) return "invalid" as const;
		if (!task) return "no task" as const;
		const reason = typeof p?.reason === "string" ? p.reason.replace(/\s+/g, " ").trim().slice(0, 80) : "";
		task.estimate = { usd: cost, steps };
		task.reason = reason;
		return { steps, usd: cost, reason };
	};
	// The tool result triggers another request.
	on("tool_call", async (e, ctx) => {
		const branch: Entry[] = ctx.sessionManager.getBranch();
		const last = lastRequest(branch);
		const est = last && stepCost(branch, last.tokens, ctx);
		showCost(ctx, est ? `next step ~${usd(est.usd)} (${k(est.breakdown.cacheReadTokens)} read + ~${k(est.breakdown.writeTokens)} write)` : undefined);
		// Gates (opt-in). Never the checkpoint turn, never estimate_cost. pi runs every tool_call hook of a
		// response before any tool executes, so record the estimate here: calls batched with it are gated.
		if (e.toolName === "estimate_cost") {
			recordEstimate((e as { input?: EstimateArgs }).input);
			return;
		}
		if (phase === "checkpoint") return;
		if (cfg.sessionBudget > 0) {
			try {
				const [budget, spent] = [cfg.sessionBudget + raised, sessionSpent(branch)];
				if (spent >= budget) {
					let pick: string | undefined;
					if (!stopped && ctx.hasUI) pick = await ctx.ui.select(`Session budget ${usd(budget)} spent (~${usd(spent)} so far)`, [`Allow another ${usd(cfg.sessionBudget)}`, "Stop tool calls"]);
					if (pick?.startsWith("Allow another")) raised += cfg.sessionBudget;
					else {
						stopped = true;
						return { block: true, terminate: true, reason: `Session budget of ${usd(budget)} is spent (~${usd(spent)}). Stop and ask the user before continuing.` };
					}
				}
			} catch {
				stopped = true; // fail closed: a budget gate that cannot ask blocks
				return { block: true, terminate: true, reason: "Session budget is spent or could not be checked. Stop and ask the user before continuing." };
			}
		}
		const t = task;
		if (!t?.estimate || cfg.confirmAbove <= 0 || t.estimate.usd <= cfg.confirmAbove) return;
		if (t.gate === undefined) {
			t.gate = "ok"; // decided before the dialog opens: overlapping calls do not ask again, and a failed dialog fails open
			if (ctx.hasUI) {
				try {
					if (!(await ctx.ui.confirm(`The model estimates this task at ~${usd(t.estimate.usd)}`, `${t.estimate.steps} steps${t.reason ? `: ${t.reason}` : ""}. Continue?`))) t.gate = "declined";
				} catch {}
			} else pi.appendEntry("governor-log", { msg: `task estimated at ~${usd(t.estimate.usd)}, above confirmAbove; allowed without asking (no UI)` });
		}
		if (t.gate === "declined") return { block: true, terminate: true, reason: `The user declined the estimated cost (~${usd(t.estimate.usd)}). Stop and ask the user how to proceed.` };
	});

	on("agent_start", (_e, ctx) => {
		clearIdle();
		refreshing = false;
		warmCount = 0;
		stopped = false;
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
		showCost(ctx, undefined); // the run is over: a stale figure must not look current
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
			pi.appendEntry("governor-checkpoint", { ...checkpoint, open: true, rollover: wasRollover, cost: branch.slice(cpFrom).reduce((sum, e) => sum + (fin(asMsg(e)?.usage?.cost?.total) ?? 0), 0) });
			if (wasRollover) later(() => runCommand("governor-rollover"));
			else release();
			return;
		}
		finishTask(ctx, ev.aborted);
		decided = false;
		const last = lastRequest(branch);
		if (ev.aborted || attempted || checkpoint || authExpired || wakes.size > 0) return;
		if (last && cfg.rolloverTokens > 0 && last.tokens > cfg.rolloverTokens) return startCheckpoint(ctx, true);
		armIdle(ctx, last);
	});

	const notice = (ctx: ExtensionContext, msg: string) => {
		try {
			ctx.ui.notify(msg, "info");
		} catch {}
	};
	/** Prompt gate: ask before a costly prompt. True = declined (the text is back in the editor). Fails open. */
	const declinedPrompt = async (text: string, cost: { typical: number; high: number; cache: string; reqs: string }, ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			pi.appendEntry("governor-log", { msg: `prompt may cost up to ~${usd(cost.high)}, above confirmAbove; sent without asking (no UI)` });
			return false;
		}
		asking = true; // other inputs are held while the dialog is open
		let ok = true;
		try {
			ok = await ctx.ui.confirm(`This prompt may cost up to ~${usd(cost.high)}`, `Typical ~${usd(cost.typical)} \u00b7 ${cost.cache} \u00b7 ${cost.reqs}. Send it?`);
		} catch {}
		asking = false;
		try {
			if (!ok) ctx.ui.setEditorText([text, ...held].join("\n\n")); // a failure here falls through and sends: the message is never lost
		} catch {
			ok = true;
		}
		if (ok) {
			release();
			return false;
		}
		held.length = 0;
		showCost(ctx, undefined);
		notice(ctx, "Not sent; your message is back in the editor.");
		return true;
	};

	// Feature 4: on return after expiry, offer the checkpoint.
	on("input", async (ev, ctx) => {
		if (ev.source === "extension") return;
		if (phase === "checkpoint" || asking) {
			held.push(ev.text);
			if (phase === "checkpoint") ctx.ui.notify("Saving handoff, your message follows.", "info");
			return { action: "handled" };
		}
		attempted = ended = false; // the user spoke: a new idle period
		clearIdle();
		const cost = promptCost(ev.text, ctx);
		const branch: Entry[] = ctx.sessionManager.getBranch();
		const [touch, last] = [lastTouch(branch), lastRequest(branch)];
		const expired = touch !== undefined && !!last && Date.now() - touch > ttlOf(ctx);
		// Automatic return: switch without asking when the checkpoint saves enough (no UI needed).
		const write = writePriceOf(pricesOf(ctx.model, cfg.prices));
		const auto = !!checkpoint && expired && !remember && cfg.autoContinue && !!last && (last.tokens * write - ((checkpoint.text.length + ev.text.length) / 4) * write) / 1e6 >= AUTO_MIN_SAVING;
		const returnQuestion = !!checkpoint && expired && !remember && ((cfg.askOnReturn && ctx.hasUI) || auto);
		if (cost && cfg.confirmAbove > 0 && cost.high > cfg.confirmAbove && !returnQuestion && !isOwnPrompt(ev.text) && (await declinedPrompt(ev.text, cost, ctx))) return { action: "handled" };
		if (!task || ctx.isIdle()) task = { from: branch.length, label: ev.text.replace(/\s+/g, " ").trim().slice(0, 80), startedAt: Date.now() };
		if (cfg.sessionBudget > 0) {
			const [budget, spent] = [cfg.sessionBudget + raised, sessionSpent(branch)];
			if (spent >= budget) notice(ctx, `Session budget spent (~${usd(spent)} of ${usd(budget)}): tool calls will ask first.`);
		}
		if (expired && !checkpoint && last && last.tokens >= EVIDENCE_MIN_TOKENS) {
			pi.appendEntry("governor-log", { msg: `cache expired with no checkpoint (${k(last.tokens)} tokens, idle ${Math.round((Date.now() - (touch ?? Date.now())) / MIN)} min, refreshes since last request ${refreshesSince(branch)})` });
		}
		if (!checkpoint) return;
		if (touch === undefined || !last || !expired) return closeCheckpoint();
		const writePrice = writePriceOf(pricesOf(ctx.model, cfg.prices));
		const resumeCost = (last.tokens * writePrice) / 1e6;
		const continueCost = (((checkpoint.text.length + ev.text.length) / 4) * writePrice) / 1e6;
		let choice = remember;
		let note: string | undefined;
		if (!choice && auto) {
			choice = "continue";
			note = `Cache expired ${Math.round((Date.now() - touch - ttlOf(ctx)) / MIN)} min ago; continuing from the checkpoint in a new session (~${usd(continueCost)} instead of ~${usd(resumeCost)}).`;
			pi.appendEntry("governor-log", { msg: `auto-continue: ${note}` });
		}
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
		pending = { text: [ev.text, ...held.splice(0)].join("\n\n"), saved: Math.max(0, resumeCost - continueCost) || 0, note };
		later(() => runCommand("governor-continue"));
		return { action: "handled" };
	});

	// Step 4: the brief is a persisted custom message right after the prompt, so the cache prefix stays stable.
	on("before_agent_start", (ev, ctx) => {
		if (ev.messageType !== "user" || phase === "checkpoint" || isOwnPrompt(ev.prompt)) return;
		const branch: Entry[] = ctx.sessionManager.getBranch();
		const [last, touch] = [lastRequest(branch), lastTouch(branch)];
		const warm = touch !== undefined && Date.now() - touch < ttlOf(ctx);
		const est = last && stepCost(branch, last.tokens, ctx, warm);
		const step = est && (warm ? `Cache warm; each step reads ~${k(est.breakdown.cacheReadTokens)} tokens, ~${usd(est.usd)}.` : `Cache cold; the first step rewrites ~${k(est.breakdown.writeTokens)} tokens, ~${usd(est.usd)}.`);
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const left = cfg.sessionBudget > 0 ? Math.max(0, cfg.sessionBudget + raised - sessionSpent(branch)) : undefined;
		const content = buildBrief({ step, left, session: mine, history: past, prompt: ev.prompt, model });
		return content ? { message: { customType: "governor-brief", content, display: false } } : undefined;
	});

	// Registered once at load, so the system prompt is the same on every turn and the cache is not invalidated.
	pi.registerTool({
		name: "estimate_cost",
		label: "Estimate cost",
		description: "Record your estimate of the steps and dollars the current task will take. It is shown to the user and compared with the actual cost afterwards.",
		promptSnippet: "estimate_cost: record your step and dollar estimate for a task before using tools",
		// In the same response as the first other tool call, so the estimate costs no request of its own.
		promptGuidelines: ["For a task that will use tools, call estimate_cost with your estimate of steps and dollars, using the governor cost note, as the first call in the same response as your first other tool call."],
		parameters: {
			type: "object",
			properties: {
				steps: { type: "integer", minimum: 1, description: "Expected number of model requests" },
				usd: { type: "number", minimum: 0, description: "Expected cost in dollars" },
				reason: { type: "string", description: "One short sentence: why" },
			},
			required: ["steps", "usd", "reason"],
			additionalProperties: false,
		} as never,
		execute: async (_id: string, p: EstimateArgs, _s: unknown, _u: unknown, ctx: ExtensionContext) => {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			try {
				const r = recordEstimate(p);
				if (r === "invalid") return text("Invalid estimate: steps must be an integer >= 1 and usd a number >= 0. Nothing recorded.");
				if (r === "no task") return text("Not recorded: no open task.");
				const { steps, usd: cost, reason } = r;
				try {
					ctx.ui.notify(`Model estimate for this task: ~${usd(cost)}, ${steps} steps${reason ? ` (${reason})` : ""}`, "info");
				} catch {}
				const branch: Entry[] = ctx.sessionManager.getBranch();
				const last = lastRequest(branch);
				const step = last && stepCost(branch, last.tokens, ctx);
				return text(step ? `Recorded. Current step ~${usd(step.usd)}.` : "Recorded.");
			} catch {
				return text("Not recorded: internal error.");
			}
		},
	});

	/** Start a fresh session from the checkpoint. A refused or failed switch keeps the checkpoint open and delivers `user` here. */
	const freshSession = async (ctx: CmdCtx, note: string, user?: string) => {
		const cp = checkpoint;
		if (!cp) return false;
		const seed =
			`${SEED_MARK} (${ctx.sessionManager.getSessionFile() ?? "ephemeral"}).\n\n${cp.text}` +
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
		handler: guard("governor-rollover", (_a: string, ctx: CmdCtx) => {
			// Per-step read cost before and after: the context now against the handoff alone.
			const read = pricesOf(ctx.model, cfg.prices).cacheRead;
			// A fresh session carries the system prompt and tools too: approximated by this session's first request.
			const branch: Entry[] = ctx.sessionManager.getBranch();
			const first = branch.map(asMsg).find((m): m is Msg => !!m);
			const base = first && tokensOf(first);
			const [tokens, handoff] = [lastRequest(branch)?.tokens, checkpoint?.text.length];
			const step = (n: number | undefined) => (n === undefined ? "unknown" : usd((n * read) / 1e6));
			return freshSession(
				ctx,
				`Context passed ${k(cfg.rolloverTokens)} tokens (~${step(tokens)} per step); continuing in a fresh session from the checkpoint (~${step(handoff === undefined || base === undefined || tokens === undefined ? undefined : Math.min(base, tokens) + handoff / 4)} per step).`,
				held.splice(0).join("\n\n") || undefined,
			);
		}) as never,
	});
	pi.registerCommand("governor-continue", {
		description: "Internal: continue your message in a fresh session from the checkpoint",
		handler: guard("governor-continue", async (_a: string, ctx: CmdCtx) => {
			const p = pending;
			pending = undefined;
			if (!p || !checkpoint) return;
			if (await freshSession(ctx, p.note ?? "Continuing from the checkpoint in a new session.", p.text)) pi.appendEntry("governor-continue", { saved: p.saved });
		}) as never,
	});

	pi.registerCommand("governor", {
		description: "Show prompt-cache savings for this session and the governor settings",
		handler: guard("governor", async (_a: string, ctx: CmdCtx) => {
			const p = cfg.prices;
			const mp = pricesOf(ctx.model, cfg.prices);
			const r = buildReport(ctx.sessionManager.getBranch(), cfg, ttlOf(ctx), mp);
			const es = estimateStats(ctx.sessionManager.getBranch());
				const cal = calibration(past);
			ctx.ui.notify(
				[
					`Refreshes: ${r.refreshes} (${usd(r.refreshCost)})   break-even cap: ${breakEvenRefreshes(mp)}`,
					`Checkpoints: ${r.checkpoints} (${usd(r.checkpointCost)})   rollovers: ${r.rollovers}   continued from checkpoint: ${r.continues}`,
					`Rewrites avoided: ${r.rewritesAvoided}   saved: ${usd(r.saved)}   net: ${usd(r.net)}`,
						es ? `Estimates: ${es.n} paired   predicted/actual median ${es.median.toFixed(2)}x   worst ${es.worst.toFixed(2)}x` : "Estimates: no estimates yet",
					cfg.history ? `History: ${past.length} tasks (this session ${mine.length})` + (cal ? `   your estimates: median ratio ${cal.median.toFixed(2)}x (${cal.n})` : "") : "History: off",
					`Config: checkpoint floor=${k(cfg.checkpointMinTokens)} rollover>${cfg.rolloverTokens ? k(cfg.rolloverTokens) : "off"} ask=${cfg.askOnReturn} idle-checkpoint=${cfg.idleCheckpoint} auto-continue=${cfg.autoContinue}` +
							(cfg.confirmAbove ? ` confirm>${usd(cfg.confirmAbove)}` : "") +
							(cfg.sessionBudget ? ` budget ${usd(cfg.sessionBudget + raised)} (spent ~${usd(sessionSpent(ctx.sessionManager.getBranch()))})` : "") +
							` prices(in/write/read/out)=${p.input}/${p.cacheWrite}/${p.cacheRead}/${p.output}` +
						(wakes.size ? `   wakes expected: ${wakes.size}` : "") +
						(authExpired ? "   warming stopped: AWS credentials expired or unavailable" : ""),
				].join("\n"),
				"info",
			);
		}) as never,
	});
}
