import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrief, calibration, similarTasks, type TaskRecord } from "../src/governor.ts";
import { assistant, setup, T0, usage } from "./helpers.ts";

const MIN = 60_000;
let dir: string;
const file = () => join(dir, "governor-history.jsonl");
const lines = () => readFileSync(file(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gov-hist-")); // never the real ~/.pi
	process.env.PI_CODING_AGENT_DIR = dir;
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const rec = (o: Partial<TaskRecord> = {}): TaskRecord => ({
	v: 1, at: "2026-01-01T00:00:00.000Z", model: "p/m", label: "fix flaky test", requests: 3, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usd: 0.4, ms: 1, tools: [], ...o,
});
const call = (name: string) => ({ type: "toolCall", id: "t", name, arguments: {} });
/** One finished task: a prompt, then assistant replies (each tokens + cost), then the run settles. */
async function task(g: ReturnType<typeof setup>, prompt: string, replies: { tokens?: number; cost: number; tools?: string[] }[] = [{ cost: 0.1 }], aborted = false) {
	await g.fire("input", { text: prompt, source: "interactive" });
	for (const r of replies) {
		g.branch.push(assistant(Date.now(), r.tokens ?? 1000, "ok", { content: (r.tools ?? []).map(call), usage: usage({ input: 10, cacheRead: r.tokens ?? 1000, cacheWrite: 5 }, r.cost) }));
	}
	vi.advanceTimersByTime(2000);
	await g.fire("agent_settled", { aborted });
}

describe("task history", () => {
	it("writes one record per task: sums, unique tools, an 80-char one-line label", async () => {
		const g = setup();
		g.fire("session_start");
		const long = `fix   the flaky\ntest ${"word ".repeat(30)}`;
		await task(g, long, [{ cost: 0.1, tools: ["read", "bash"] }, { cost: 0.25, tools: ["bash"] }]);
		const [r, ...more] = lines();
		expect(more).toHaveLength(0);
		expect(r).toMatchObject({ v: 1, model: "p/m", requests: 2, usd: 0.35, ms: 2000, tools: ["read", "bash"], tokens: { input: 20, cacheRead: 2000, cacheWrite: 10, output: 10 } });
		expect(r.at).toBe(new Date(T0 + 2000).toISOString());
		expect(r.label).toBe(long.replace(/\s+/g, " ").trim().slice(0, 80));
		expect(r.label).toHaveLength(80);
		expect(JSON.stringify(r)).not.toContain(g.ctx.cwd);
		expect(r.estimate).toBeUndefined();
	});

	it("writes nothing for an aborted run, a checkpoint turn, or a task with no known cost", async () => {
		const g = setup({ branch: [assistant(T0, 150_000)] });
		g.fire("session_start");
		await task(g, "stop me", [{ cost: 0.1 }], true);
		await g.fire("cache_warming_decision", { type: "cache_warming_decision", action: "stop", continuationProbability: 0.15 }); // starts the checkpoint turn
		g.branch.push(assistant(T0 + 5 * MIN, 150_000, "HANDOFF", { usage: usage({ cacheRead: 150_000 }, 0.05) }));
		await g.fire("agent_settled", { aborted: false });
		g.branch.push(assistant(T0 + 6 * MIN, 1000, "x", { usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: { total: Number.NaN } } }));
		await g.fire("input", { text: "no cost", source: "interactive" });
		await g.fire("agent_settled", { aborted: false });
		expect(() => readFileSync(file())).toThrow();
	});

	it("does not start a task for extension-sent input or a held message", async () => {
		const g = setup();
		g.fire("session_start");
		await g.fire("input", { text: "[governor checkpoint] x", source: "extension" });
		g.branch.push(assistant(T0, 1000, "ok", { usage: usage({ cacheRead: 1000 }, 0.1) }));
		await g.fire("agent_settled", { aborted: false });
		expect(() => readFileSync(file())).toThrow();
	});

	it("history: false writes nothing, reads nothing, and gives no past-task part", async () => {
		writeFileSync(file(), `${JSON.stringify(rec())}\n`);
		const g = setup({ settings: { governor: { history: false } }, branch: [assistant(T0, 1000)] });
		g.fire("session_start");
		await task(g, "fix flaky test", [{ cost: 0.1 }]);
		expect(readFileSync(file(), "utf8").trim().split("\n")).toHaveLength(1);
		const r = await g.fire("before_agent_start", { messageType: "user", prompt: "fix flaky test" });
		expect(r.message.content).not.toContain("Similar");
		await g.commands.get("governor")!("", g.ctx);
		expect(g.ui.notify.mock.calls.at(-1)![0]).toContain("History: off");
	});

	it("ignores corrupt lines and a missing file", async () => {
		const g0 = setup();
		await expect(Promise.resolve(g0.fire("session_start"))).resolves.not.toThrow(); // missing file
		writeFileSync(file(), ["not json", JSON.stringify(rec({ label: "good one here" })), '{"usd":"x","model":"p/m","label":"a"}', "{", JSON.stringify(rec({ usd: Number.NaN })), ""].join("\n"));
		const g = setup({ branch: [assistant(T0, 1000)] });
		g.fire("session_start");
		const r = await g.fire("before_agent_start", { messageType: "user", prompt: "good one" });
		expect(r.message.content).toContain("good one here");
		expect(g.entries.filter((e) => e.type === "governor-log")).toHaveLength(0);
		await g.commands.get("governor")!("", g.ctx);
		expect(g.ui.notify.mock.calls.at(-1)![0]).toContain("History: 1 tasks (this session 0)");
	});

	it("an unwritable history location is logged once and the session carries on", async () => {
		writeFileSync(join(dir, "blocker"), "");
		process.env.PI_CODING_AGENT_DIR = join(dir, "blocker", "sub"); // mkdir fails: a file is in the way
		const g = setup();
		g.fire("session_start");
		await task(g, "one task here");
		await task(g, "another task here");
		expect(g.entries.filter((e) => e.type === "governor-log")).toHaveLength(1);
		const r = await g.fire("before_agent_start", { messageType: "user", prompt: "task" });
		expect(r.message.content).toContain("Tasks this session"); // still kept in memory
	});
});

describe("brief", () => {
	const start = (extra: any[] = []) => {
		const g = setup({ branch: [assistant(T0, 152_000), ...extra] });
		g.fire("session_start");
		return g;
	};
	it("is added to a user prompt and never for governor-sent prompts or custom starts", async () => {
		const g = start();
		const r = await g.fire("before_agent_start", { messageType: "user", prompt: "do the thing" });
		expect(r).toMatchObject({ message: { customType: "governor-brief", display: false } });
		expect(r.message.content).toMatch(/^\[governor: cost estimates\] Cache warm; each step reads ~152K tokens, ~\$0\.0\d+\./);
		expect(r.message.content).toContain("call estimate_cost");
		expect(await g.fire("before_agent_start", { messageType: "user", prompt: "[governor checkpoint] The session may go idle" })).toBeUndefined();
		expect(await g.fire("before_agent_start", { messageType: "user", prompt: "Continuing from a checkpoint of the previous session (/s)." })).toBeUndefined();
		expect(await g.fire("before_agent_start", { messageType: "custom", message: {} })).toBeUndefined();
	});
	it("says the cache is cold when it has expired, and nothing when nothing is known", async () => {
		const g = start();
		vi.setSystemTime(T0 + 10 * MIN);
		expect((await g.fire("before_agent_start", { messageType: "user", prompt: "x y z" })).message.content).toContain("Cache cold; the first step rewrites ~15");
		const empty = setup();
		empty.fire("session_start");
		expect(await empty.fire("before_agent_start", { messageType: "user", prompt: "x y z" })).toBeUndefined();
	});
	it("gives session typical and high once two tasks exist", async () => {
		const g = start();
		await task(g, "alpha task", [{ cost: 0.2 }]);
		expect((await g.fire("before_agent_start", { messageType: "user", prompt: "zzz" })).message.content).not.toContain("Tasks this session");
		await task(g, "beta task", [{ cost: 0.6 }]);
		await task(g, "gamma task", [{ cost: 1 }]);
		expect((await g.fire("before_agent_start", { messageType: "user", prompt: "zzz" })).message.content).toContain("Tasks this session: typical $0.60, high $1.00 (3).");
	});
	it("similarTasks: same model only, ranked by word overlap, score 0 dropped", () => {
		const h = [
			rec({ label: "fix flaky parser test", usd: 1 }),
			rec({ label: "fix flaky test in the parser module", usd: 2 }),
			rec({ label: "fix flaky parser test", usd: 3, model: "other/m" }),
			rec({ label: "unrelated gardening notes", usd: 4 }),
			rec({ label: "parser", usd: 5 }), // under 3 chars of overlap would not count; this one shares "parser"
		];
		const got = similarTasks("Fix the flaky parser test", h, "p/m");
		expect(got.map((r) => r.usd)).toEqual([2, 1, 5]);
		expect(similarTasks("is it ok", h, "p/m")).toEqual([]); // words under 3 chars are ignored
	});
	it("quotes labels truncated to 40 chars with step counts", () => {
		const b = buildBrief({ session: [], history: [rec({ label: "x".repeat(60) + " parser", requests: 9, usd: 0.35 })], prompt: `${"x".repeat(60)} parser`, model: "p/m" })!;
		expect(b).toContain(`Similar past tasks: $0.35, 9 steps ("${"x".repeat(40)}…").`);
	});
	it("calibration text appears only outside 0.83-1.2 and with at least 3 estimates", () => {
		const h = (ratio: number, n: number) => Array.from({ length: n }, () => rec({ usd: ratio, estimate: { usd: 1, steps: 5 } }));
		const text = (ratio: number, n: number) => buildBrief({ session: [], history: h(ratio, n), prompt: "q", model: "p/m", step: "S." })!;
		expect(text(1.4, 3)).toContain("Your estimates ran 1.4x low (last 3).");
		expect(text(0.5, 12)).toContain("Your estimates ran 2.0x high (last 10).");
		expect(text(1.1, 5)).not.toContain("Your estimates");
		expect(text(0.9, 5)).not.toContain("Your estimates");
		expect(text(1.4, 2)).not.toContain("Your estimates");
		expect(calibration(h(2, 4))).toEqual({ n: 4, median: 2 });
	});
});

describe("estimate_cost", () => {
	const ctxOf = (g: ReturnType<typeof setup>) => g.ctx;
	const run = (g: ReturnType<typeof setup>, p: any) => g.tools.get("estimate_cost").execute("id", p, undefined, undefined, ctxOf(g));
	it("is registered with a one-line snippet and one guideline", () => {
		const t = setup().tools.get("estimate_cost");
		expect(t.promptGuidelines).toHaveLength(1);
		expect(t.promptSnippet).not.toContain("\n");
	});
	it("records the estimate onto the task record and notifies", async () => {
		const g = setup({ branch: [assistant(T0, 150_000)] });
		g.fire("session_start");
		await g.fire("input", { text: "do a big thing", source: "interactive" });
		const res = await run(g, { steps: 12, usd: 0.6, reason: "x".repeat(200) });
		expect(res.content[0].text).toMatch(/^Recorded\. Current step ~\$0\.0\d+\.$/);
		expect(g.ui.notify).toHaveBeenCalledWith(`Model estimate for this task: ~$0.60, 12 steps (${"x".repeat(80)})`, "info");
		await run(g, { steps: 8, usd: 0.4, reason: "revised" }); // last call wins
		g.branch.push(assistant(T0 + 1000, 150_000, "ok", { usage: usage({ cacheRead: 150_000 }, 0.3) }));
		await g.fire("agent_settled", { aborted: false });
		expect(lines()[0].estimate).toEqual({ usd: 0.4, steps: 8 });
	});
	it("bad input records nothing and never throws", async () => {
		const g = setup({ branch: [assistant(T0, 150_000)] });
		g.fire("session_start");
		await g.fire("input", { text: "do a thing", source: "interactive" });
		for (const p of [{ steps: 0, usd: 1 }, { steps: 1.5, usd: 1 }, { steps: 3, usd: -1 }, { steps: 3, usd: Number.NaN }, { steps: "x", usd: 1 }, {}, undefined, null]) {
			expect((await run(g, p)).content[0].text).toMatch(/^Invalid estimate/);
		}
		expect(g.ui.notify).not.toHaveBeenCalled();
		g.branch.push(assistant(T0 + 1000, 150_000, "ok", { usage: usage({ cacheRead: 150_000 }, 0.3) }));
		await g.fire("agent_settled", { aborted: false });
		expect(lines()[0].estimate).toBeUndefined();
	});
	it("a failing notify does not throw and the estimate is still recorded", async () => {
		const g = setup({ branch: [assistant(T0, 150_000)] });
		g.fire("session_start");
		await g.fire("input", { text: "do a thing", source: "interactive" });
		g.ui.notify.mockImplementation(() => { throw new Error("no ui"); });
		expect((await run(g, { steps: 2, usd: 0.1, reason: "r" })).content[0].text).toContain("Recorded.");
		g.branch.push(assistant(T0 + 1000, 150_000, "ok", { usage: usage({ cacheRead: 150_000 }, 0.3) }));
		await g.fire("agent_settled", { aborted: false });
		expect(lines()[0].estimate).toEqual({ usd: 0.1, steps: 2 });
	});
	it("without an open task it says so and does not throw", async () => {
		const g = setup();
		expect((await run(g, { steps: 2, usd: 0.1, reason: "r" })).content[0].text).toContain("no open task");
	});
});
