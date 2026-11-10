import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestsPerTurn, stepGrowth } from "../src/governor.ts";
import { assistant, setup, T0 } from "./helpers.ts";

const MIN = 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 2 * MIN); });
afterEach(() => vi.useRealTimers());
const user = (ts: number) => ({ type: "message", id: `u${ts}`, parentId: null, timestamp: new Date(ts).toISOString(), message: { role: "user", content: "hi", timestamp: ts } });
/** Three past turns of 1, 2 and 6 requests, each growing the context; the last request is at T0 + 1 min. */
const history = () => {
	const sizes = [100_000, 101_000, 103_000, 104_000, 106_000, 107_000, 108_000, 109_000, 110_000];
	const cuts = [0, 1, 3];
	return sizes.flatMap((t, i) => [...(cuts.includes(i) ? [user(T0 + i * 1000)] : []), assistant(T0 - 8 * MIN + i * MIN, t)]);
};
const status = (g: ReturnType<typeof setup>) => g.ui.setStatus.mock.calls.filter((c: any[]) => c[0] === "governor-cost").at(-1)?.[1] as string | undefined;
const prompt = "x".repeat(4000); // ~1K tokens

describe("cost before a prompt", () => {
	it("warm: typical figure, requests-per-turn range and a high figure", async () => {
		const b = history();
		const g = setup({ branch: b });
		expect(requestsPerTurn(g.branch as any)).toEqual([1, 2, 6]);
		const r = await g.fire("input", { text: prompt, source: "interactive" });
		expect(r).toBeUndefined();
		expect(status(g)).toMatch(/^~\$0\.\d+ · cache warm · 1–6 requests · high \$\d/);
	});
	it("cold: only the first request of the turn pays the rewrite, whatever the request count", async () => {
		const warmG = setup({ branch: history() });
		await warmG.fire("input", { text: prompt, source: "interactive" });
		vi.setSystemTime(T0 + 60 * MIN);
		const g = setup({ branch: history() });
		await g.fire("input", { text: prompt, source: "interactive" });
		const typ = (s?: string) => Number(/^~\$([\d.]+)/.exec(s ?? "")![1]);
		const high = (s?: string) => Number(/high \$([\d.]+)/.exec(s ?? "")![1]);
		// Typical (2 requests) and high (6 requests) differ from warm by the same single rewrite premium.
		expect(high(status(g)) - high(status(warmG))).toBeCloseTo(typ(status(g)) - typ(status(warmG)), 1);
	});
	it("cold: called out as a rewrite and costs more", async () => {
		const warmG = setup({ branch: history() });
		await warmG.fire("input", { text: prompt, source: "interactive" });
		vi.setSystemTime(T0 + 60 * MIN);
		const g = setup({ branch: history() });
		await g.fire("input", { text: prompt, source: "interactive" });
		expect(status(g)).toContain("cache cold (rewrite)");
		const val = (s?: string) => Number(/~\$([\d.]+)/.exec(s ?? "")![1]);
		expect(val(status(g))).toBeGreaterThan(val(status(warmG)));
	});
	it("fewer than two past turns: single request, '1+ requests'", async () => {
		const g = setup({ branch: [assistant(T0, 100_000), assistant(T0 + 1000, 101_000)] });
		await g.fire("input", { text: prompt, source: "interactive" });
		expect(status(g)).toMatch(/cache warm · 1\+ requests/);
	});
	it("ignores extension inputs", async () => {
		const g = setup({ branch: history() });
		await g.fire("input", { text: prompt, source: "extension" });
		expect(g.ui.setStatus).not.toHaveBeenCalled();
	});
	it("unknown usage: nothing shown, no throw", async () => {
		const bad = assistant(T0, 1, "ok", { usage: { input: NaN, cacheRead: "x" } });
		for (const branch of [[], [bad], [bad, bad, user(1)]]) {
			const g = setup({ branch });
			await expect(g.fire("input", { text: prompt, source: "interactive" })).resolves.toBeUndefined();
			expect(await g.fire("tool_call", { toolName: "read" })).toBeUndefined();
			expect(status(g)).toBeUndefined();
		}
		const g = setup({ branch: history() });
		expect(await g.fire("input", { text: undefined, source: "interactive" })).toBeUndefined();
	});
});

describe("cost before a tool call", () => {
	it("prices the next request from the median step growth and never blocks", async () => {
		const g = setup({ branch: history() });
		expect(stepGrowth(g.branch as any).slice(-3)).toEqual([1000, 1000, 1000]);
		const r = await g.fire("tool_call", { toolName: "read", input: {} });
		expect(r).toBeUndefined();
		expect(status(g)).toMatch(/^next step ~\$0\.\d+ \(110K read \+ ~1K write\)$/);
	});
	it("falls back to a fixed step when there is no growth history", async () => {
		const g = setup({ branch: [assistant(T0, 50_000)] });
		await g.fire("tool_call", {});
		expect(status(g)).toContain("(50K read + ~3K write)");
	});
});

describe("settling", () => {
	it("clears a shown figure, and stays silent when nothing was shown", async () => {
		const g = setup({ branch: history() });
		await g.fire("agent_settled", { aborted: false });
		expect(g.ui.setStatus).not.toHaveBeenCalled();
		await g.fire("tool_call", {});
		await g.fire("agent_settled", { aborted: false });
		expect(status(g)).toBeUndefined();
		expect(g.ui.setStatus).toHaveBeenCalledTimes(2);
	});
});
