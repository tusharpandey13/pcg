import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakEvenRefreshes, buildReport, DEFAULTS, economicWarm, expectWake, hasOwnEconomics, loadConfig } from "../src/governor.ts";
import { assistant, custom, setup, T0, warm } from "./helpers.ts";

const MIN = 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 4.5 * MIN); });
afterEach(() => vi.useRealTimers());
const dec = (action: "warm" | "stop") => ({ type: "cache_warming_decision", action, warmCost: 0.05, missCost: 0.5, continuationProbability: 0.15 });
const big = (n = 150_000) => [assistant(T0, n)];
/** A decision with explicit costs: miss 0.2, refresh 0.01, so savings are p * 0.2 - 0.01. */
const decCost = (action: "warm" | "stop", over: Record<string, number> = {}) => ({ type: "cache_warming_decision", action, warmCost: 0.01, missCost: 0.2, continuationProbability: 0.15, ...over });

describe("config", () => {
	it("derives break-even from prices, not a constant", () => {
		expect(breakEvenRefreshes(DEFAULTS.prices)).toBe(11);
		expect(breakEvenRefreshes({ input: 1, cacheWrite: 2, cacheRead: 0.5, output: 1 })).toBe(3);
		expect(breakEvenRefreshes({ input: 1, cacheWrite: 1, cacheRead: 0, output: 1 })).toBe(0);
	});
	it("merges the governor settings block over defaults and ignores junk", () => {
		const c = loadConfig({ governor: { rolloverTokens: 0, askOnReturn: false, prices: { cacheRead: 0.5 }, checkpointMinTokens: "x" } });
		expect(c).toMatchObject({ rolloverTokens: 0, askOnReturn: false, checkpointMinTokens: 100_000 });
		expect(c.prices).toEqual({ ...DEFAULTS.prices, cacheRead: 0.5 });
	});
});

describe("feature 1: wake-aware warming", () => {
	it("leaves pi's decision alone when no wake is expected", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined();
	});
	it("forces warm while a wake is expected, up to the break-even cap, then stops", async () => {
		const g = setup({ branch: [...big(), ...Array.from({ length: 10 }, (_, i) => warm(T0 + i))] });
		g.fire("session_start");
		expectWake(g.pi, "w1");
		expect(await g.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "warm" }); // 10 < 11
		g.branch.push(warm(T0 + 11));
		expect(await g.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "stop" }); // 11 == cap
	});
	it("a real request resets the refresh count", async () => {
		const g = setup({ branch: [...big(), ...Array.from({ length: 11 }, (_, i) => warm(T0 + i)), assistant(T0 + 1000, 150_000)] });
		g.fire("session_start");
		expectWake(g.pi, "w1");
		expect(await g.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "warm" });
	});
	it("uses the configured prices for the cap", async () => {
		const settings = { governor: { prices: { input: 1, cacheWrite: 2, cacheRead: 0.5, output: 1 } } };
		const g = setup({ settings, branch: [...big(), warm(T0), warm(T0), warm(T0)] });
		g.fire("session_start");
		expectWake(g.pi, "w");
		expect(await g.fire("cache_warming_decision", dec("warm"))).toEqual({ action: "stop" });
	});
	it("returns to pi's decision once the wake is cleared", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		expectWake(g.pi, "w1");
		expectWake(g.pi, "w2");
		expectWake(g.pi, "w1", false);
		expect(await g.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "warm" });
		await g.fire("after_provider_response", { status: 200, headers: {} });
		expectWake(g.pi, "w2", false);
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined();
	});
});

describe("feature 1b: the governor's own warming economics", () => {
	const own = (governor: object) => ({ governor: { prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }, ...governor } });
	it("config: both knobs default to pi's behaviour and junk is ignored", () => {
		expect(hasOwnEconomics(loadConfig({}))).toBe(false);
		expect(loadConfig({ governor: { continuationProbability: 1.5, minSavings: -1 } })).toMatchObject({ continuationProbability: undefined, minSavings: 0.05 });
		expect(loadConfig({ governor: { continuationProbability: 0.4, minSavings: 0.02 } })).toMatchObject({ continuationProbability: 0.4, minSavings: 0.02 });
		expect(hasOwnEconomics(loadConfig({ governor: { minSavings: 0.02 } }))).toBe(true);
		expect(hasOwnEconomics(loadConfig({ governor: { continuationProbability: 0.4 } }))).toBe(true);
	});
	it("economicWarm replaces only the idle probability, and falls back to pi when economics are unknown", () => {
		const cfg = loadConfig({ governor: { continuationProbability: 0.5 } });
		expect(economicWarm(decCost("stop"), cfg)).toBe(true); // 0.5 * 0.2 - 0.01 = 0.09 >= 0.05
		expect(economicWarm(decCost("warm", { continuationProbability: 1 }), cfg)).toBe(true); // streaming keeps pi's 1.0
		expect(economicWarm(decCost("stop", { missCost: 0.05 }), cfg)).toBe(false); // 0.5 * 0.05 - 0.01 = 0.015
		expect(economicWarm(decCost("stop", { missCost: 0 }), cfg)).toBe(false); // unknown: pi's action
		expect(economicWarm(decCost("warm", { missCost: 0 }), cfg)).toBe(true);
		expect(economicWarm(decCost("warm", { warmCost: NaN }), cfg)).toBe(true);
	});
	it("warms where pi stops once the configured probability clears the floor", async () => {
		const g = setup({ settings: own({ continuationProbability: 0.5 }), branch: big() });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "warm" });
	});
	it("a lower floor alone can start warming", async () => {
		const g = setup({ settings: own({ minSavings: 0.01 }), branch: big() });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "warm" }); // 0.15 * 0.2 - 0.01 = 0.02
	});
	it("a higher floor can stop what pi would warm", async () => {
		const g = setup({ settings: own({ minSavings: 0.5 }), branch: big() });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", decCost("warm"))).toEqual({ action: "stop" });
	});
	it("stops when the expected saving stays below the floor", async () => {
		const g = setup({ settings: own({ continuationProbability: 0.1 }), branch: big() });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "stop" }); // 0.1 * 0.2 - 0.01 = 0.01
	});
	it("ends at the break-even cap, counting refreshes it allowed", async () => {
		const g = setup({ settings: own({ continuationProbability: 0.5 }), branch: big() });
		g.fire("session_start");
		for (let i = 0; i < 11; i++) {
			expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "warm" });
			await g.fire("after_provider_response", { status: 200, headers: {} }); // the refresh got a response
		}
		expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "stop" });
	});
	it("a real request resets the refresh count", async () => {
		const g = setup({ settings: own({ continuationProbability: 0.5 }), branch: big() });
		g.fire("session_start");
		for (let i = 0; i < 11; i++) {
			await g.fire("cache_warming_decision", decCost("stop"));
			await g.fire("after_provider_response", { status: 200, headers: {} });
		}
		g.fire("agent_start");
		expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "warm" });
	});
	it("still checkpoints when it stops warming a large context", async () => {
		const g = setup({ settings: own({ continuationProbability: 0.1 }), branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", decCost("stop"));
		expect(g.sent.length).toBe(1); // checkpoint turn, same as when pi stops
	});
	it("never warms after an auth failure", async () => {
		const g = setup({ settings: own({ continuationProbability: 0.9 }), branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", decCost("stop"));
		await g.fire("after_provider_response", { status: 403, headers: {} });
		expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "stop" });
	});
	it("a wake still forces warming regardless of the floor", async () => {
		const g = setup({ settings: own({ minSavings: 5 }), branch: big() });
		g.fire("session_start");
		expectWake(g.pi, "w");
		expect(await g.fire("cache_warming_decision", decCost("stop"))).toEqual({ action: "warm" });
	});
});

describe("feature 2b: a refresh with no response stops warming", () => {
	it("stops at the next decision when the refresh never got an HTTP response, and says why", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined(); // refresh goes out, no response follows
		expect(await g.fire("cache_warming_decision", dec("warm"))).toEqual({ action: "stop" });
		expect(g.ui.setStatus).toHaveBeenCalledWith("governor", "AWS credentials unavailable");
		expect(g.sent).toHaveLength(0); // no checkpoint: it would need a working connection
	});

	it("recovers on the next real request: status cleared, warming allowed again", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("warm"));
		await g.fire("cache_warming_decision", dec("warm"));
		g.fire("agent_start");
		expect(g.ui.setStatus).toHaveBeenLastCalledWith("governor", undefined);
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined();
	});

	it("a refresh that got a normal response does not stop warming", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		for (let i = 0; i < 4; i++) {
			expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined();
			await g.fire("after_provider_response", { status: 200, headers: {} });
		}
		expect(g.ui.setStatus).not.toHaveBeenCalledWith("governor", "AWS credentials unavailable");
	});

	it("a response that arrives while a turn runs still counts as a response", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("warm"));
		g.ctx.isIdle = () => false;
		await g.fire("after_provider_response", { status: 200, headers: {} });
		g.ctx.isIdle = () => true;
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined();
	});

	it("logs the status and error type of a failed refresh, as evidence for which codes mean expired credentials", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("warm"));
		await g.fire("after_provider_response", { status: 400, headers: { "x-amzn-errortype": "ExpiredTokenException" } });
		expect(g.entries.some((e) => e.type === "governor-log" && /400 \(ExpiredTokenException\)/.test(e.data.msg))).toBe(true);
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined(); // 400 alone does not stop warming yet
	});
});

describe("feature 2: stop on auth errors", () => {
	const refresh = async (g: ReturnType<typeof setup>, status: number) => {
		await g.fire("cache_warming_decision", dec("warm"));
		await g.fire("after_provider_response", { status, headers: {} });
	};
	it.each([401, 403])("stops after a %i from a refresh until the next real request", async (status) => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await refresh(g, status);
		expect(g.ui.setStatus).toHaveBeenCalledWith("governor", "AWS credentials expired");
		expect(await g.fire("cache_warming_decision", dec("warm"))).toEqual({ action: "stop" });
		expect(g.sent).toHaveLength(0); // no checkpoint: it would fail too
		g.fire("agent_start");
		expect(g.ui.setStatus).toHaveBeenLastCalledWith("governor", undefined);
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined();
	});
	it("ignores other statuses and responses to real requests", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await refresh(g, 200);
		await refresh(g, 429);
		g.fire("agent_start");
		await g.fire("after_provider_response", { status: 401, headers: {} }); // real request, no refresh in flight
		expect(g.ui.setStatus).not.toHaveBeenCalled();
	});
	it("ignores a 401 that arrives while the agent is running", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("warm"));
		g.ctx.isIdle = () => false;
		await g.fire("after_provider_response", { status: 401, headers: {} });
		expect(g.ui.setStatus).not.toHaveBeenCalled();
	});
});

describe("feature 3: checkpoint while warm", () => {
	it("checkpoints in-session when pi stops warming and the context is large", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "stop" });
		expect(g.sent).toHaveLength(1);
		expect(g.sent[0].text).toContain(".pi-governor/handoff.md");
		expect(g.sent[0].text).not.toContain("./awt");
	});
	it("uses ./awt state when ./awt exists in the session cwd", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "gov-"));
		writeFileSync(join(cwd, "awt"), "#!/bin/sh");
		const g = setup({ branch: big(), cwd });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("stop"));
		expect(g.sent[0].text).toContain("./awt state --now");
	});
	it("does not checkpoint below the size threshold, while a wake is expected, or while not idle", async () => {
		const small = setup({ branch: big(50_000) });
		small.fire("session_start");
		expect(await small.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "stop" });
		expect(small.sent).toHaveLength(0);
		const busy = setup({ branch: big() });
		busy.fire("session_start");
		busy.ctx.isIdle = () => false;
		await busy.fire("cache_warming_decision", dec("stop"));
		expect(busy.sent).toHaveLength(0);
	});
	it("checkpoints on the last refresh before pi's silent 30-minute limit, even if pi says warm", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		vi.setSystemTime(T0 + 26 * MIN); // next refresh would land past 29 min
		expect(await g.fire("cache_warming_decision", dec("warm"))).toEqual({ action: "stop" });
		expect(g.sent).toHaveLength(1);
	});
	it("records the checkpoint when its turn settles and never starts a second one (loop guard)", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("stop"));
		g.branch.push(assistant(T0 + 5 * MIN, 150_000, "HANDOFF TEXT", { usage: { input: 5, output: 300, cacheRead: 150_000, cacheWrite: 0, totalTokens: 0, cost: { total: 0.05 } } }));
		await g.fire("input", { source: "extension", text: "x" }); // the checkpoint's own input is ignored
		g.fire("agent_settled", { aborted: false });
		expect(g.entries.at(-1)).toMatchObject({ type: "governor-checkpoint", data: { open: true, text: "HANDOFF TEXT", cost: 0.05 } });
		g.fire("agent_settled", { aborted: false }); // settling again: no rollover, size under the cap
		expect(await g.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "stop" });
		expect(g.sent).toHaveLength(1);
	});
	it("reads the handoff file when there is no ./awt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "gov-"));
		mkdirSync(join(cwd, ".pi-governor"));
		writeFileSync(join(cwd, ".pi-governor/handoff.md"), "FILE HANDOFF");
		const g = setup({ branch: big(), cwd });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("stop"));
		g.branch.push(assistant(T0 + 5 * MIN, 150_000, "chat summary"));
		g.fire("agent_settled", { aborted: false });
		expect(g.entries.at(-1)!.data.text).toBe("FILE HANDOFF");
	});
	it("an aborted or failed checkpoint is dropped and not retried", async () => {
		const g = setup({ branch: big() });
		g.fire("session_start");
		await g.fire("cache_warming_decision", dec("stop"));
		g.fire("agent_settled", { aborted: true });
		expect(g.entries).toHaveLength(0);
	});
});

describe("feature 5: rollover", () => {
	it("checkpoints in-session past the cap, then starts a fresh session seeded with the handoff", async () => {
		const g = setup({ branch: big(250_000) });
		g.fire("session_start");
		g.fire("agent_settled", { aborted: false });
		expect(g.sent).toHaveLength(1);
		expect(g.sent[0].text).toContain("[governor checkpoint]");
		g.branch.push(assistant(T0 + 1000, 250_000, "ROLL HANDOFF"));
		g.fire("agent_settled", { aborted: false }); // checkpoint turn settles: must not start another
		await vi.advanceTimersByTimeAsync(1);
		expect(g.sent.map((s) => s.text)).toEqual([g.sent[0].text, "/governor-rollover"]);
		expect(g.sent[1].opts).toEqual({ expandPromptTemplates: true });
		await g.commands.get("governor-rollover")!("", g.ctx);
		expect(g.ui.notify).toHaveBeenCalled();
		expect(g.newSession).toHaveBeenCalledOnce();
		expect(g.sent.at(-1)!.text).toMatch(/^\[new\] .*ROLL HANDOFF/s);
		expect(g.entries.at(-1)).toEqual({ type: "governor-checkpoint", data: { open: false } });
	});
	it("does nothing at or below the cap, when 0, when aborted, or while a wake is expected", () => {
		for (const [tokens, cfg, ev, wake] of [[200_000, {}, {}, false], [900_000, { rolloverTokens: 0 }, {}, false], [250_000, {}, { aborted: true }, false], [250_000, {}, {}, true]] as const) {
			const g = setup({ settings: { governor: cfg }, branch: big(tokens) });
			g.fire("session_start");
			if (wake) expectWake(g.pi, "w");
			g.fire("agent_settled", { aborted: false, ...ev });
			expect(g.sent).toHaveLength(0);
		}
	});
	it("does not retry after a failed rollover checkpoint until the user speaks", async () => {
		const g = setup({ branch: big(250_000) });
		g.fire("session_start");
		g.fire("agent_settled", { aborted: false });
		g.fire("agent_settled", { aborted: true });
		g.fire("agent_settled", { aborted: false });
		expect(g.sent).toHaveLength(1);
		await g.fire("input", { source: "interactive", text: "go on" });
		g.fire("agent_settled", { aborted: false });
		expect(g.sent).toHaveLength(2);
	});
});

describe("feature 4: choose on return", () => {
	const open = (extra = {}) => custom("governor-checkpoint", { open: true, text: "HANDOFF", tokens: 342_000, awt: false, ...extra });
	const expired = () => vi.setSystemTime(T0 + 28 * MIN);
	const input = { source: "interactive", text: "next please" };

	it("asks once with dollar estimates from the last request's usage, and resumes on choice", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: "Resume full context  ~$1.28" });
		g.fire("session_start");
		expired();
		expect(await g.fire("input", input)).toBeUndefined();
		const [title, options] = g.select.mock.calls[0];
		expect(title).toBe("Cache expired 23 min ago. Context: 342K tokens.");
		expect(options[0]).toContain("~$1.28"); // 342000 * 3.75 / 1e6
		expect(options[1]).toMatch(/Continue from checkpoint\s+~\$0\.00\d/);
		expect(g.entries.at(-1)!.data).toEqual({ open: false });
	});
	it("continue: swallows the message and starts a new session with handoff + message", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: "Continue from checkpoint  ~$0.01" });
		g.fire("session_start");
		expired();
		expect(await g.fire("input", input)).toEqual({ action: "handled" });
		await vi.advanceTimersByTimeAsync(1);
		expect(g.sent.at(-1)).toEqual({ text: "/governor-continue", opts: { expandPromptTemplates: true } });
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(g.sent.at(-1)!.text).toMatch(/^\[new\] .*HANDOFF.*next please$/s);
		expect(g.entries.some((e) => e.type === "governor-continue")).toBe(true);
	});
	it("remembers a don't-ask-again choice", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: "Resume full context (don't ask again)" });
		g.fire("session_start");
		expired();
		await g.fire("input", input);
		g.branch.push(open());
		await g.fire("input", input);
		expect(g.select).toHaveBeenCalledOnce();
	});
	it("does not ask when the cache is still warm, with no checkpoint, or after a refresh touched it", async () => {
		const warmCache = setup({ branch: [assistant(T0, 342_000), open(), warm(T0 + 26 * MIN)] });
		warmCache.fire("session_start");
		expired();
		await warmCache.fire("input", input);
		const none = setup({ branch: [assistant(T0, 342_000)] });
		none.fire("session_start");
		await none.fire("input", input);
		expect(warmCache.select).not.toHaveBeenCalled();
		expect(none.select).not.toHaveBeenCalled();
	});
	it("defaults to resume and logs without UI, or when askOnReturn is off", async () => {
		for (const o of [{ hasUI: false }, { settings: { governor: { askOnReturn: false } } }]) {
			const g = setup({ branch: [assistant(T0, 342_000), open()], ...o });
			g.fire("session_start");
			expired();
			expect(await g.fire("input", input)).toBeUndefined();
			expect(g.select).not.toHaveBeenCalled();
			expect(g.entries.map((e) => e.type)).toContain("governor-log");
			vi.setSystemTime(T0 + 4.5 * MIN);
		}
	});
	it("rebuilds an open checkpoint from the session on start", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: "Resume full context" });
		g.fire("session_start");
		expired();
		await g.fire("input", input);
		expect(g.select).toHaveBeenCalled();
		const closed = setup({ branch: [assistant(T0, 342_000), open(), custom("governor-checkpoint", { open: false })] });
		closed.fire("session_start");
		expired();
		await closed.fire("input", input);
		expect(closed.select).not.toHaveBeenCalled();
	});
});

describe("/governor report", () => {
	it("is computed from recorded usage, including cache_warm entries", () => {
		const branch = [
			assistant(T0, 150_000),
			warm(T0 + 4.5 * MIN, 0.0456),
			warm(T0 + 9 * MIN, 0.0456),
			assistant(T0 + 12 * MIN, 150_000), // gap > 5 min but the cache was read: a rewrite avoided
			custom("governor-checkpoint", { open: true, cost: 0.06, rollover: true }),
			custom("governor-checkpoint", { open: false }),
			custom("governor-continue", { saved: 1 }),
		] as any[];
		const r = buildReport(branch, DEFAULTS, 300_000);
		expect(r).toMatchObject({ refreshes: 2, checkpoints: 1, rollovers: 1, continues: 1, rewritesAvoided: 1 });
		expect(r.refreshCost).toBeCloseTo(0.0912);
		expect(r.saved).toBeCloseTo((150_000 * (DEFAULTS.prices.cacheWrite - DEFAULTS.prices.cacheRead)) / 1e6 + 1);
		expect(r.net).toBeCloseTo(r.saved - 0.0912 - 0.06);
	});
	it("the command prints it", async () => {
		const g = setup({ branch: [assistant(T0, 150_000), warm(T0 + MIN)] });
		g.fire("session_start");
		await g.commands.get("governor")!("", g.ctx);
		expect(g.ui.notify.mock.calls[0][0]).toMatch(/Refreshes: 1 .*break-even cap: 11/s);
	});
});
