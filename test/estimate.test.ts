import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateRequest, pricesOf, ratioStats } from "../src/governor.ts";
import { assistant, setup, T0, usage } from "./helpers.ts";

const MIN = 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 4.5 * MIN); });
afterEach(() => vi.useRealTimers());
const P = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
const base = { priorTokens: 100_000, warm: true, newTokens: 20_000, recentOutputs: [1000, 2000, 4000], prices: P };

describe("estimateRequest", () => {
	it("warm: prior at read price, the rest at write price, median output; low/high from min/max", () => {
		const e = estimateRequest(base)!;
		expect(e.breakdown).toEqual({ cacheReadTokens: 100_000, writeTokens: 20_000, outputTokens: 2000 });
		expect(e.usd).toBeCloseTo((100_000 * 0.3 + 20_000 * 3.75 + 2000 * 15) / 1e6, 9);
		expect(e.low).toBeCloseTo((30_000 + 75_000 + 15_000) / 1e6, 9);
		expect(e.high).toBeCloseTo((30_000 + 75_000 + 60_000) / 1e6, 9);
	});
	it("cold: everything at write price", () => {
		const e = estimateRequest({ ...base, warm: false })!;
		expect(e.breakdown).toMatchObject({ cacheReadTokens: 0, writeTokens: 120_000 });
		expect(e.usd).toBeCloseTo((120_000 * 3.75 + 2000 * 15) / 1e6, 9);
	});
	it("garbage in, undefined out", () => {
		for (const bad of [NaN, -1, Infinity, "5", undefined]) {
			expect(estimateRequest({ ...base, priorTokens: bad })).toBeUndefined();
			expect(estimateRequest({ ...base, newTokens: bad })).toBeUndefined();
			expect(estimateRequest({ ...base, recentOutputs: [10, bad] })).toBeUndefined();
		}
		expect(estimateRequest({ ...base, recentOutputs: [] })).toBeUndefined();
		expect(estimateRequest({ ...base, prices: { ...P, cacheRead: NaN } })).toBeUndefined();
	});
	it("ratioStats: median and the worst ratio in either direction", () => {
		expect(ratioStats([])).toBeUndefined();
		expect(ratioStats([1, 1.1, 0.5, NaN, 0])).toEqual({ n: 3, median: 1, worst: 0.5 });
	});
});

describe("predicted vs actual logging", () => {
	const payload = { messages: [{ content: "x".repeat(480_000) }] }; // ~120K tokens by chars/4
	const response = (cost: number, extra: any = {}) => ({ message: { role: "assistant", content: [], timestamp: Date.now(), stopReason: "stop", usage: usage({ cacheRead: 100_000, cacheWrite: 20_000 }, cost), ...extra } });

	it("pairs the prediction with the recorded usage in one governor-estimate entry", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		await g.fire("session_start");
		await g.fire("before_provider_request", { payload });
		await g.fire("message_end", response(0.1));
		expect(g.entries).toHaveLength(1);
		const d = g.entries[0].data;
		expect(g.entries[0].type).toBe("governor-estimate");
		expect(d.warm).toBe(true);
		expect(d.approx).toBe(true);
		expect(d.predicted.usd).toBeCloseTo((30_000 + 20_000 * 3.75 + 5 * 15) / 1e6, 3); // payload wrapper chars add a few tokens;
		expect(d.actual).toMatchObject({ usd: 0.1, tokens: 120_000 });
		await g.fire("message_end", response(0.1)); // the prediction is consumed once
		expect(g.entries).toHaveLength(1);
	});
	it("a cold cache is priced at write", async () => {
		const g = setup({ branch: [assistant(T0 - 10 * MIN, 100_000)] });
		await g.fire("before_provider_request", { payload });
		await g.fire("message_end", response(0.5));
		expect(g.entries[0].data).toMatchObject({ warm: false, predicted: { breakdown: { cacheReadTokens: 0 } } });
	});
	it("records nothing for a refresh, a failed response, no history or an unparsable payload", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		await g.fire("cache_warming_decision", { type: "cache_warming_decision", action: "warm", warmCost: 0.05, missCost: 0.5, continuationProbability: 0.15 });
		await g.fire("before_provider_request", { payload }); // refreshing + idle: a refresh
		await g.fire("message_end", response(0.1));
		await g.fire("after_provider_response", { status: 200, headers: {} });
		await g.fire("before_provider_request", { payload });
		await g.fire("message_end", response(0.1, { stopReason: "error" }));
		const circular: any = {}; circular.self = circular;
		await g.fire("before_provider_request", { payload: circular });
		await g.fire("message_end", response(0.1));
		const fresh = setup();
		await fresh.fire("before_provider_request", { payload });
		await fresh.fire("message_end", response(0.1));
		expect(g.entries.filter((e) => e.type === "governor-estimate")).toEqual([]);
		expect(fresh.entries).toEqual([]);
	});
	it("/governor reports the paired estimates, or none", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		const text = async () => { g.ui.notify.mockClear(); await g.commands.get("governor")!("", g.ctx); return g.ui.notify.mock.calls[0][0] as string; };
		expect(await text()).toContain("no estimates yet");
		await g.fire("before_provider_request", { payload });
		await g.fire("message_end", response(0.1));
		expect(await text()).toMatch(/Estimates: 1 paired .*median 0\.\d\dx .*worst 0\.\d\dx/);
	});
});

describe("prices", () => {
	it("a model without a cache-write price bills new tokens at input", () => {
		const e = estimateRequest({ ...base, prices: { ...P, cacheWrite: 0 } })!;
		expect(e.usd).toBeCloseTo((100_000 * 0.3 + 20_000 * 3 + 2000 * 15) / 1e6);
	});
	it("pricesOf uses the model's catalog prices, else the config", () => {
		const D = { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
		expect(pricesOf({ cost: P }, D)).toEqual(P);
		expect(pricesOf({ cost: { ...P, output: NaN } }, D)).toEqual(D);
		expect(pricesOf(undefined, D)).toEqual(D);
	});
});
