// Helpers for chaos.test.ts: seeded RNG, network guard, a mock-driven session simulator, and a real-session boot.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import governor, { breakEvenRefreshes, lastRequest, loadConfig, refreshesSince } from "../src/governor.ts";
import { assistant, setup, T0, usage, warm } from "./helpers.ts";

export const MIN = 60_000;
export const SEED = Number(process.env.CHAOS_SEED ?? 20260101);

export function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
		chance: (p: number) => next() < p,
	};
}

/** Any network use in these tests is a failure: record and throw. */
export function netGuard() {
	const calls: string[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (u: any) => { calls.push(String(u)); throw new Error("network blocked by chaos test"); }) as never;
	return { calls, restore: () => { globalThis.fetch = orig; } };
}

export const BAD_TEXT = /NaN|Infinity|\$-|-\$|undefined/;

// ---- mock-driven simulator -----------------------------------------------------

export interface SimOpts {
	settings?: any; hasUI?: boolean; cwd?: string; select?: string | undefined; selectImpl?: (t: string, o: string[]) => Promise<string | undefined>;
	newSessionResult?: "ok" | "cancel" | "throw";
}
export type Turn = { kind: "checkpoint" | "user" };

/** Drives the real governor handlers with a tiny model of a pi session. Needs vi fake timers (Date, setTimeout). */
export function makeSim(o: SimOpts = {}) {
	const g = setup({ settings: o.settings, branch: [], hasUI: o.hasUI, cwd: o.cwd, select: o.select });
	if (o.selectImpl) (g.ctx.ui as any).select = vi.fn(o.selectImpl);
	const s = {
		g, errors: [] as string[], prompts: 0, sinceUser: 0, switches: 0, concurrent: 0, unannounced: 0, seeds: [] as string[], userSent: [] as string[],
		turn: undefined as Turn | undefined, warmCount: 0, ended: false, ctxTokens: 0, authStopped: false, refreshing: false, commandNotifyBase: 0,
		forcedWarmViolations: [] as string[], decisionViolations: [] as string[],
		lastPromptRollover: false,
	};
	g.ctx.isIdle = () => !s.turn;
	g.pi.sendUserMessage = (text: string) => {
		if (text.startsWith("/governor-")) {
			const name = text.slice(1);
			void Promise.resolve().then(async () => {
				s.commandNotifyBase = g.ui.notify.mock.calls.length;
				try { await g.commands.get(name)!("", g.ctx); } catch (e) { s.errors.push(`command ${name}: ${e}`); }
			});
			return;
		}
		if (text.startsWith("[governor checkpoint]")) {
			s.prompts++; s.sinceUser++;
			if (s.turn) s.concurrent++;
			s.turn = { kind: "checkpoint" };
			return;
		}
		s.userSent.push(text);
	};
	g.ctx.newSession = vi.fn(async (opt: any) => {
		if (o.newSessionResult === "throw") throw new Error("newSession exploded");
		if (o.newSessionResult === "cancel") return { cancelled: true };
		s.switches++;
		if (g.ui.notify.mock.calls.length <= s.commandNotifyBase) s.unannounced++;
		g.branch.length = 0; wakeSet.clear(); s.warmCount = 0; s.ended = false; s.authStopped = false; s.refreshing = false; s.turn = undefined; s.sinceUser = 0; s.ctxTokens = 0;
		await opt.withSession?.({ sendUserMessage: async (t: string) => void s.seeds.push(t) });
		await fire("session_start");
		return { cancelled: false };
	});
	const fire = async (ev: string, e: any = {}) => {
		try { return await g.fire(ev, e); } catch (err) { s.errors.push(`${ev}: ${(err as Error)?.stack ?? err}`); }
	};
	const flush = async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); };
	const now = () => Date.now();
	const ops = {
		fire, flush,
		async user(text = "hi", tokens = s.ctxTokens) {
			const during = s.turn?.kind === "checkpoint";
			const r = await fire("input", { text, source: "interactive" });
			if (r?.action !== "handled" || !during) { s.sinceUser = 0; s.ended = false; }
			await flush();
			if (r?.action === "handled") return r;
			if (s.turn) return r; // queued behind the running turn
			s.ctxTokens = tokens;
			s.turn = { kind: "user" };
			await ops.finish("ok");
			return r;
		},
		/** Finish the running turn. kind "abort"/"error" append a zero-usage assistant message, like pi does. */
		async finish(kind: "ok" | "abort" | "error" = "ok", u?: Partial<Record<"input" | "cacheRead" | "cacheWrite", number>>) {
			const t = s.turn; if (!t) return;
			await fire("agent_start");
			s.authStopped = false; s.refreshing = false; s.warmCount = 0;
			if (t.kind !== "checkpoint") s.ended = false;
			const stopReason = kind === "ok" ? "stop" : kind === "abort" ? "aborted" : "error";
			g.branch.push(assistant(now(), kind === "ok" ? s.ctxTokens : 0, t.kind === "checkpoint" ? "handoff text" : "reply", {
				stopReason, usage: usage(kind === "ok" ? { cacheRead: s.ctxTokens } : (u ?? {}), 0.01),
			}));
			s.turn = undefined;
			await fire("agent_settled", { aborted: kind === "abort" });
			await flush();
		},
		async decide(action: "warm" | "stop", opts: { append?: boolean } = {}) {
			const branchBefore = g.branch.slice();
			const cfg = loadConfig(g.pi.getSettings());
			const cap = breakEvenRefreshes(cfg.prices);
			const wakesNow = wakeSet.size > 0;
			const r = await fire("cache_warming_decision", { type: "cache_warming_decision", action, warmCost: 0.05, missCost: 0.5, continuationProbability: 0.15 });
			const eff = r?.action ?? action;
			if (wakesNow) {
				const last = lastRequest(branchBefore as never);
				const final = last !== undefined && Date.now() + 300_000 * 0.9 > last.ts + 29 * MIN;
				const spent = Math.max(s.warmCount, refreshesSince(branchBefore as never)) >= cap;
				const want = s.authStopped ? "stop" : !spent && !s.ended ? "warm" : "stop";
				if (r?.action !== want) s.decisionViolations.push(`wakes=${[...wakeSet]} warmCount=${s.warmCount} refreshes=${refreshesSince(branchBefore as never)} cap=${cap} ended=${s.ended} auth=${s.authStopped} want=${want} got=${r?.action}`);
				if (!s.authStopped) { if (final || spent) s.ended = true; if (r?.action === "warm") s.warmCount++; }
			} else if (r?.action === "warm") s.decisionViolations.push("forced warm without a wake");
			s.refreshing = eff === "warm";
			if (eff === "warm" && opts.append !== false) g.branch.push(warm(now()));
			if (eff === "stop") await flush();
			return r;
		},
		wake(id: string, expected: boolean) { (expectWakeRaw as any)(g.pi, id, expected); if (expected) wakeSet.add(id); else wakeSet.delete(id); },
		async status(code: number) {
			await fire("after_provider_response", { status: code, headers: {} });
			if (s.refreshing && s.turn === undefined && (code === 401 || code === 403)) s.authStopped = true;
			s.refreshing = false;
		},
		advance: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); },
		jump: (ms: number) => vi.setSystemTime(now() + ms),
		async report() {
			const before = g.ui.notify.mock.calls.length;
			await g.commands.get("governor")!("", g.ctx);
			return g.ui.notify.mock.calls.slice(before).map((c: any[]) => String(c[0])).join("\n");
		},
		async reload() { wakeSet.clear(); s.warmCount = 0; s.ended = false; s.sinceUser = 0; s.turn = undefined; s.authStopped = false; s.refreshing = false; await fire("session_start"); },
	};
	const wakeSet = new Set<string>();
	return Object.assign(s, { ops, wakeSet });
}
import { expectWake as expectWakeRaw } from "../src/governor.ts";
export { T0, assistant, usage, warm };

// ---- real pi session (faux provider, fake clock) --------------------------------

const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
export const reply = (text: string, u: { cacheRead?: number; cacheWrite?: number; input?: number } = {}, total = 0, extra: any = {}) =>
	({ ...(fauxMsg(text)), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }, ...u }, ...extra });
import { fauxAssistantMessage as fauxMsg } from "@earendil-works/pi-ai/compat";

export async function bootReal(opts: { cwd?: string; extra?: ((pi: ExtensionAPI) => void)[]; settings?: any; newSession?: (o: any) => Promise<{ cancelled: boolean }> } = {}) {
	const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "gov-chaos-"));
	const faux = registerFauxProvider({ models: [{ id: "f", cost, contextWindow: 2_000_000 }] });
	const model = { ...faux.getModel(), promptCache: { short: 300 } };
	const rt = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false });
	rt.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: "k", api: faux.api, models: faux.models.map((m) => ({ id: m.id, name: m.name, api: m.api, reasoning: m.reasoning, input: m.input, cost: m.cost, promptCache: { short: 300 }, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl })) });
	const pis: ExtensionAPI[] = [];
	const rl = new DefaultResourceLoader({ cwd, agentDir: cwd, extensionFactories: [governor, (pi) => void pis.push(pi), ...(opts.extra ?? [])] });
	await rl.reload();
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, modelRuntime: rt, model: rt.getModel(model.provider, model.id)!, resourceLoader: rl,
		sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ cacheWarming: "idle", ...{ governor: { prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } } }, ...(opts.settings ?? {}) } as never),
	});
	const notes: string[] = [];
	const ui: any = { notify: (m: string) => void notes.push(m), setStatus: () => {}, select: async () => undefined };
	const newSessions: any[] = [];
	const noop = async () => ({ cancelled: false });
	await session.bindExtensions({ uiContext: ui, commandContextActions: {
		waitForIdle: async () => {}, fork: noop, navigateTree: noop, switchSession: noop, reload: async () => {},
		newSession: async (o: any) => { newSessions.push(o); return opts.newSession ? opts.newSession(o) : { cancelled: false }; },
	} } as never);
	const branch = () => session.sessionManager.getBranch() as any[];
	/** Every request in the session came from the faux provider. */
	const assertFaux = () => {
		const bad = branch().filter((e) => (e.type === "message" && e.message.role === "assistant" && e.message.provider !== model.provider) || (e.type === "usage" && e.provider !== model.provider));
		if (bad.length) throw new Error(`non-faux entries: ${JSON.stringify(bad.map((b) => b.provider ?? b.message?.provider))}`);
	};
	const users = () => session.messages.filter((m) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("")));
	return { session, faux, pi: pis[0], cwd, notes, newSessions, branch, assertFaux, users, dispose: () => { session.dispose(); faux.unregister(); } };
}

/** Report invariant: every figure finite; refresh/checkpoint/saved dollars non-negative (net may be a legitimate loss). */
export function checkReport(out: string, tag = "") {
	if (/NaN|Infinity|undefined/.test(out)) throw new Error(`${tag} non-finite figure in report:\n${out}`);
	for (const line of out.split("\n")) {
		const body = line.replace(/net:.*/, "");
		if (/\$-/.test(body)) throw new Error(`${tag} negative dollar figure in report:\n${out}`);
	}
}
