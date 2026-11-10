import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakEvenRefreshes, buildReport, checkpointPays, DEFAULTS, expectWake, loadConfig, returnChance } from "../src/governor.ts";
import { assistant, custom, setup, T0, warm } from "./helpers.ts";

const MIN = 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 4.5 * MIN); });
afterEach(() => vi.useRealTimers());
// Costs are omitted so these tests exercise pi's own action; `priced` adds them for the return-curve tests.
const dec = (action: "warm" | "stop", priced?: { warmCost: number; missCost: number }) => ({ type: "cache_warming_decision", action, continuationProbability: 0.15, ...priced });
const big = (n = 150_000) => [assistant(T0, n)];

describe("config", () => {
	it("derives break-even from prices, not a constant", () => {
		expect(breakEvenRefreshes(DEFAULTS.prices)).toBe(11);
		expect(breakEvenRefreshes({ input: 1, cacheWrite: 2, cacheRead: 0.5, output: 1 })).toBe(3);
		expect(breakEvenRefreshes({ input: 1, cacheWrite: 1, cacheRead: 0, output: 1 })).toBe(0);
	});
	it("merges the governor settings block over defaults and ignores junk", () => {
		const c = loadConfig({ governor: { rolloverTokens: 0, askOnReturn: false, prices: { cacheRead: 0.5 }, checkpointMinTokens: "x" } });
		expect(c).toMatchObject({ rolloverTokens: 0, askOnReturn: false, checkpointMinTokens: 0 });
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
		expect(await g.fire("cache_warming_decision", dec("stop"))).toBeUndefined();
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
		const small = setup({ branch: big(30_000) });
		small.fire("session_start");
		expect(await small.fire("cache_warming_decision", dec("stop"))).toBeUndefined(); // pi stops and so do we
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
	it("sends the last refresh before pi's 30-minute limit when no checkpoint will be taken", async () => {
		const g = setup({ branch: big(30_000) }); // too small for a checkpoint to pay
		g.fire("session_start");
		vi.setSystemTime(T0 + 26 * MIN);
		expect(await g.fire("cache_warming_decision", dec("warm"))).toBeUndefined(); // pi's warm stands
		expect(g.sent).toHaveLength(0);
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
		expect(await g.fire("cache_warming_decision", dec("stop"))).toBeUndefined();
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

const BEDROCK = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };

describe("return curve", () => {
	it("falls monotonically, about 34% at 7 minutes and 8% at 30", () => {
		let prev = Infinity;
		for (const m of [0, 1, 5, 7, 10, 20, 30, 60]) {
			const r = returnChance(m);
			expect(r).toBeLessThan(prev);
			prev = r;
		}
		expect(returnChance(7)).toBeCloseTo(0.34, 1);
		expect(returnChance(30)).toBeCloseTo(0.08, 1);
	});
	it("treats negative or non-finite minutes as 0", () => {
		for (const m of [-5, Number.NaN, Number.POSITIVE_INFINITY * -1]) expect(returnChance(m)).toBe(returnChance(0));
	});
});

describe("feature 1: warming by the return curve", () => {
	it("warms a small context pi would skip when the curve pays", async () => {
		const g = setup({ branch: big(20_000) });
		g.fire("session_start"); // 4.5 minutes away: 0.4 * 0.5 >= 0.05
		expect(await g.fire("cache_warming_decision", dec("stop", { warmCost: 0.05, missCost: 0.5 }))).toEqual({ action: "warm" });
		expect(g.ui.setStatus).toHaveBeenCalledWith("governor-cost", expect.stringContaining("warming ~$0.050 per refresh"));
	});
	it("keeps pi's warm when the curve agrees (undefined)", async () => {
		const g = setup({ branch: big(20_000) });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", dec("warm", { warmCost: 0.05, missCost: 0.5 }))).toBeUndefined();
	});
	it("stops late in the window with a low cost ratio even though pi says warm", async () => {
		const g = setup({ branch: big(20_000) });
		g.fire("session_start");
		vi.setSystemTime(T0 + 25 * MIN); // 0.11 * missCost < 0.2 * missCost
		expect(await g.fire("cache_warming_decision", dec("warm", { warmCost: 0.1, missCost: 0.5 }))).toEqual({ action: "stop" });
		expect(g.ui.setStatus).toHaveBeenCalledWith("governor-cost", expect.stringMatching(/^cache expires ~\d\d:\d\d · returning later costs ~\$0\.50 \(rewrite\)$/));
	});
	it("follows pi when a cost is unknown or missCost is 0", async () => {
		const g = setup({ branch: big(20_000) });
		g.fire("session_start");
		expect(await g.fire("cache_warming_decision", dec("stop"))).toBeUndefined();
		expect(await g.fire("cache_warming_decision", dec("stop", { warmCost: 0.05, missCost: 0 }))).toBeUndefined();
		expect(await g.fire("cache_warming_decision", dec("warm", { warmCost: Number.NaN, missCost: 0.5 }))).toBeUndefined();
	});
	it("the curve never overrides an open checkpoint or the final-slot checkpoint", async () => {
		const open = setup({ branch: big(200_000) });
		open.fire("session_start");
		await open.fire("cache_warming_decision", dec("stop")); // starts the checkpoint
		open.branch.push(assistant(T0 + 5 * MIN, 200_000, "H"));
		open.fire("agent_settled", { aborted: false });
		expect(await open.fire("cache_warming_decision", dec("warm", { warmCost: 0.01, missCost: 5 }))).toEqual({ action: "stop" });
		const fin = setup({ branch: big(200_000) });
		fin.fire("session_start");
		vi.setSystemTime(T0 + 26 * MIN);
		expect(await fin.fire("cache_warming_decision", dec("stop", { warmCost: 0.01, missCost: 5 }))).toBeUndefined();
		expect(fin.sent).toHaveLength(1); // the checkpoint takes the slot
	});
	it("shows no new status when a checkpoint starts", async () => {
		const g = setup({ branch: big(200_000) });
		g.fire("session_start");
		vi.setSystemTime(T0 + 26 * MIN);
		await g.fire("cache_warming_decision", dec("warm", { warmCost: 0.05, missCost: 0.5 }));
		expect(g.ui.setStatus).not.toHaveBeenCalled();
	});
	it("a model with no cache-write price still gets a sane forced-wake cap", async () => {
		const settings = { governor: { prices: { input: 3, cacheWrite: 0, cacheRead: 0.3, output: 15 } } };
		const g = setup({ settings, branch: [...big(), ...Array.from({ length: 5 }, (_, i) => warm(T0 + i))] });
		g.fire("session_start");
		expectWake(g.pi, "w");
		expect(await g.fire("cache_warming_decision", dec("stop"))).toEqual({ action: "warm" }); // cap is 9, not 0
	});
});

describe("feature 3: checkpoint economics", () => {
	it("pays from about 47K tokens at Bedrock Sonnet prices", () => {
		expect(checkpointPays(50_000, BEDROCK)).toBe(true);
		expect(checkpointPays(150_000, BEDROCK)).toBe(true);
		expect(checkpointPays(45_000, BEDROCK)).toBe(false);
		expect(checkpointPays(30_000, BEDROCK)).toBe(false);
	});
	it("never pays for a tiny context, at any price", () => {
		for (const p of [BEDROCK, { input: 100, cacheWrite: 125, cacheRead: 10, output: 1 }, { input: 1, cacheWrite: 0, cacheRead: 0.1, output: 100 }]) {
			expect(checkpointPays(1000, p)).toBe(false);
			expect(checkpointPays(Number.NaN, p)).toBe(false);
		}
	});
	it("bills the rewrite at input when the model has no cache-write price", () => {
		const noWrite = { input: 3, cacheWrite: 0, cacheRead: 0.3, output: 15 };
		expect(checkpointPays(100_000, noWrite)).toBe(false); // input 3 < write 3.75: the threshold moves from 47K to 105K
		expect(checkpointPays(110_000, noWrite)).toBe(true);
		expect(checkpointPays(100_000, { ...noWrite, cacheWrite: 3 })).toBe(false);
	});
	it("does not checkpoint a context that does not pay, and checkpointMinTokens is only a floor", async () => {
		const small = setup({ branch: big(40_000) });
		small.fire("session_start");
		await small.fire("cache_warming_decision", dec("stop"));
		expect(small.sent).toHaveLength(0);
		const floor = setup({ settings: { governor: { prices: BEDROCK, checkpointMinTokens: 300_000 } }, branch: big(200_000) });
		floor.fire("session_start");
		await floor.fire("cache_warming_decision", dec("stop"));
		expect(floor.sent).toHaveLength(0);
	});
});

describe("break-even with no cache-write price", () => {
	it("uses input as the write price", () => {
		expect(breakEvenRefreshes({ input: 3, cacheWrite: 0, cacheRead: 0.3, output: 15 })).toBe(9);
		expect(breakEvenRefreshes({ input: 0.1, cacheWrite: 0, cacheRead: 0.3, output: 15 })).toBe(0);
	});
});

describe("feature 5: rollover notice", () => {
	it("shows the per-step read cost before and after", async () => {
		const g = setup({ branch: [assistant(T0 - MIN, 15_000), assistant(T0, 250_000)] });
		g.fire("session_start");
		g.fire("agent_settled", { aborted: false }); // above the 200K cap: starts the checkpoint
		g.branch.push(assistant(T0 + MIN, 250_000, "x".repeat(4000)));
		g.fire("agent_settled", { aborted: false });
		await vi.waitFor(() => expect(g.commands.has("governor-rollover")).toBe(true));
		await g.commands.get("governor-rollover")!("", g.ctx);
		const note = g.ui.notify.mock.calls.map((c: any[]) => c[0]).find((t: string) => t.startsWith("Context passed"));
		expect(note).toContain("(~$0.075 per step)"); // 250K * 0.3
		expect(note).toContain("(~$0.005 per step)"); // (15K first request + 1K handoff) * 0.3
	});
});
