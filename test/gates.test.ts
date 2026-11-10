import "./setup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrief, loadConfig, sessionSpent } from "../src/governor.ts";
import { assistant, setup, T0, TEST_SETTINGS, usage, warm } from "./helpers.ts";

const MIN = 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + MIN); });
afterEach(() => vi.useRealTimers());
const cfg = (g: object) => ({ governor: { ...TEST_SETTINGS.governor, ...g } });
const costly = (cost = 0) => assistant(T0, 1_000_000, "ok", { usage: usage({ cacheRead: 1_000_000 }, cost) }); // a 1M-token warm context: a prompt's high estimate is ~$0.30
const started = new WeakSet<object>();
const boot = async (g: ReturnType<typeof setup>) => { if (!started.has(g)) { started.add(g); await g.fire("session_start"); } };
const prompt = async (g: ReturnType<typeof setup>, text = "do it") => (await boot(g), g.fire("input", { text, source: "interactive" }));
const BIG = { confirmAbove: 0.1 };

describe("config", () => {
	it("both default to 0 and follow the num rule", () => {
		expect(loadConfig(undefined)).toMatchObject({ confirmAbove: 0, sessionBudget: 0 });
		expect(loadConfig({ governor: { confirmAbove: -1, sessionBudget: "5" } })).toMatchObject({ confirmAbove: 0, sessionBudget: 0 });
		expect(loadConfig({ governor: { confirmAbove: 2, sessionBudget: 5 } })).toMatchObject({ confirmAbove: 2, sessionBudget: 5 });
	});
});

describe("prompt gate", () => {
	it("declined: handled, the text is back in the editor with held messages, nothing sent", async () => {
		const g = setup({ settings: cfg(BIG), branch: [costly()], confirm: false });
		await g.fire("session_start");
		g.confirm.mockImplementationOnce(async () => {
			await prompt(g, "second"); // typed while the dialog is open
			return false;
		});
		expect(await prompt(g, "first")).toEqual({ action: "handled" });
		expect(g.confirm.mock.calls[0][0]).toMatch(/^This prompt may cost up to ~\$0\.3/);
		expect(g.confirm.mock.calls[0][1]).toMatch(/Typical ~\$.*cache warm.*1\+ requests\. Send it\?/);
		expect(g.setEditorText).toHaveBeenCalledWith("first\n\nsecond");
		expect(g.ui.notify).toHaveBeenCalledWith("Not sent; your message is back in the editor.", "info");
		await vi.runAllTimersAsync();
		expect(g.sent).toEqual([]);
	});
	it("accepted: sent, and messages held meanwhile are released", async () => {
		const g = setup({ settings: cfg(BIG), branch: [costly()] });
		await g.fire("session_start");
		g.confirm.mockImplementationOnce(async () => {
			await prompt(g, "second");
			return true;
		});
		expect(await prompt(g, "first")).toBeUndefined();
		await vi.runAllTimersAsync();
		expect(g.sent.map((s) => s.text)).toEqual(["second"]);
		expect(g.setEditorText).not.toHaveBeenCalled();
	});
	it("under the limit, or 0: no dialog", async () => {
		for (const c of [{ confirmAbove: 5 }, {}]) {
			const g = setup({ settings: cfg(c), branch: [costly()], confirm: false });
			await g.fire("session_start");
			expect(await prompt(g)).toBeUndefined();
			expect(g.confirm).not.toHaveBeenCalled();
		}
	});
	it("unknown estimate: no gate", async () => {
		const g = setup({ settings: cfg(BIG), confirm: false });
		await g.fire("session_start");
		expect(await prompt(g)).toBeUndefined();
		expect(g.confirm).not.toHaveBeenCalled();
	});
	it("no UI: sent and logged", async () => {
		const g = setup({ settings: cfg(BIG), branch: [costly()], hasUI: false });
		await g.fire("session_start");
		expect(await prompt(g)).toBeUndefined();
		expect(g.confirm).not.toHaveBeenCalled();
		expect(g.entries.find((e) => e.type === "governor-log")?.data.msg).toMatch(/no UI/);
	});
	it("confirm throws: sent", async () => {
		const g = setup({ settings: cfg(BIG), branch: [costly()] });
		await g.fire("session_start");
		g.confirm.mockRejectedValueOnce(new Error("no dialog"));
		expect(await prompt(g)).toBeUndefined();
	});
	it("setEditorText throws: the message is sent rather than lost", async () => {
		const g = setup({ settings: cfg(BIG), branch: [costly()], confirm: false });
		await g.fire("session_start");
		g.setEditorText.mockImplementationOnce(() => { throw new Error("no editor"); });
		expect(await prompt(g)).toBeUndefined();
	});
	it("a return question is not double-asked, and extension or own prompts are never gated", async () => {
		const cp = { text: "handoff", tokens: 1000, awt: false, open: true };
		const g = setup({ settings: cfg(BIG), branch: [costly(), { type: "custom", customType: "governor-checkpoint", data: cp, id: "c", parentId: null, timestamp: new Date(T0).toISOString() }], select: "Resume full context  ~$1" });
		vi.setSystemTime(T0 + 10 * MIN);
		await g.fire("session_start");
		await prompt(g);
		expect(g.select).toHaveBeenCalledOnce();
		expect(g.confirm).not.toHaveBeenCalled();
		await g.fire("input", { text: "x", source: "extension" });
		await prompt(g, "[governor checkpoint] go");
		expect(g.confirm).not.toHaveBeenCalled();
	});
});

describe("estimate gate", () => {
	const start = async (g: ReturnType<typeof setup>, usdEst = 2) => {
		await g.fire("session_start");
		await prompt(g);
		await g.tools.get("estimate_cost").execute("1", { steps: 8, usd: usdEst, reason: "big refactor" }, undefined, undefined, g.ctx);
	};
	it("asks once per task; yes lets every call through", async () => {
		const g = setup({ settings: cfg({ confirmAbove: 1 }), confirm: true });
		await start(g);
		expect(await g.fire("tool_call", { toolName: "bash" })).toBeUndefined();
		expect(await g.fire("tool_call", { toolName: "read" })).toBeUndefined();
		expect(g.confirm).toHaveBeenCalledOnce();
		expect(g.confirm.mock.calls[0]).toEqual(["The model estimates this task at ~$2.00", "8 steps: big refactor. Continue?"]);
	});
	it("decline blocks with terminate, and later calls block without asking", async () => {
		const g = setup({ settings: cfg({ confirmAbove: 1 }), confirm: false });
		await start(g);
		const r = await g.fire("tool_call", { toolName: "bash" });
		expect(r).toMatchObject({ block: true, terminate: true });
		expect(r.reason).toMatch(/declined the estimated cost \(~\$2\.00\)/);
		expect(await g.fire("tool_call", { toolName: "read" })).toMatchObject({ block: true, terminate: true });
		expect(g.confirm).toHaveBeenCalledOnce();
	});
	it("gates a call batched with estimate_cost: pi runs every hook of a response before any tool executes", async () => {
		const g = setup({ settings: cfg({ confirmAbove: 1 }), confirm: false });
		await g.fire("session_start");
		await prompt(g);
		expect(await g.fire("tool_call", { toolName: "estimate_cost", input: { steps: 8, usd: 2, reason: "big refactor" } })).toBeUndefined();
		expect(await g.fire("tool_call", { toolName: "bash", input: {} })).toMatchObject({ block: true, terminate: true });
		expect(g.confirm.mock.calls[0]).toEqual(["The model estimates this task at ~$2.00", "8 steps: big refactor. Continue?"]);
	});
	it("estimate_cost is never gated; a new task asks again; below the limit or 0 never asks", async () => {
		const g = setup({ settings: cfg({ confirmAbove: 1 }), confirm: false });
		await start(g);
		expect(await g.fire("tool_call", { toolName: "estimate_cost" })).toBeUndefined();
		expect(g.confirm).not.toHaveBeenCalled();
		const small = setup({ settings: cfg({ confirmAbove: 5 }), confirm: false });
		await start(small);
		expect(await small.fire("tool_call", { toolName: "bash" })).toBeUndefined();
		const off = setup({ confirm: false });
		await start(off);
		expect(await off.fire("tool_call", { toolName: "bash" })).toBeUndefined();
		expect(small.confirm).not.toHaveBeenCalled();
		expect(off.confirm).not.toHaveBeenCalled();
	});
	it("no UI, or a failing dialog: allowed", async () => {
		const g = setup({ settings: cfg({ confirmAbove: 1 }), hasUI: false });
		await start(g);
		expect(await g.fire("tool_call", { toolName: "bash" })).toBeUndefined();
		expect(g.entries.some((e) => e.type === "governor-log" && /no UI/.test(e.data.msg))).toBe(true);
		const h = setup({ settings: cfg({ confirmAbove: 1 }) });
		await start(h);
		h.confirm.mockRejectedValueOnce(new Error("x"));
		expect(await h.fire("tool_call", { toolName: "bash" })).toBeUndefined();
		expect(await h.fire("tool_call", { toolName: "bash" })).toBeUndefined();
		expect(h.confirm).toHaveBeenCalledOnce();
	});
	it("the history record keeps its two-field estimate", async () => {
		const g = setup({ settings: cfg({ confirmAbove: 1 }), branch: [costly(0.5)] });
		await start(g);
		g.branch.push(assistant(T0 + 1, 10, "ok", { usage: usage({ cacheRead: 10 }, 0.4) }));
		await g.fire("agent_settled", { aborted: false });
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const lines = readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "governor-history.jsonl"), "utf8").trim().split("\n");
		expect(JSON.parse(lines.at(-1)!).estimate).toEqual({ usd: 2, steps: 8 });
	});
});

describe("sessionSpent", () => {
	it("sums assistant and cache_warm costs and ignores junk", () => {
		const junk = { type: "usage", kind: "other", usage: { cost: { total: 9 } } };
		const bad = [assistant(T0, 1, "x", { usage: usage({}, NaN) }), assistant(T0, 1, "x", { usage: usage({}, -3) }), assistant(T0, 1, "x", { usage: { cost: "5" } }), assistant(T0, 1, "x", { usage: undefined }), junk, { type: "usage", kind: "cache_warm" }, { type: "message", message: { role: "user" } }];
		expect(sessionSpent([assistant(T0, 1, "x", { usage: usage({}, 0.5) }), warm(T0, 0.25), ...bad] as never)).toBeCloseTo(0.75, 9);
		expect(sessionSpent([])).toBe(0);
	});
});

describe("session budget", () => {
	const tool = async (g: ReturnType<typeof setup>) => (await boot(g), g.fire("tool_call", { toolName: "bash" }));
	const over = (b = 1, spent = 1.5) => setup({ settings: cfg({ sessionBudget: b }), branch: [costly(spent)], select: "Allow another $1.00" });
	it("under budget: nothing asked", async () => {
		const g = over(1, 0.5);
		expect(await tool(g)).toBeUndefined();
		expect(g.select).not.toHaveBeenCalled();
	});
	it("Allow another raises the budget; the next ask comes only after the raised budget is spent", async () => {
		const g = over();
		expect(await tool(g)).toBeUndefined();
		expect(g.select.mock.calls[0][0]).toBe("Session budget $1.00 spent (~$1.50 so far)");
		expect(g.select.mock.calls[0][1]).toEqual(["Allow another $1.00", "Stop tool calls"]);
		expect(await tool(g)).toBeUndefined(); // 1.5 < 2.0
		expect(g.select).toHaveBeenCalledOnce();
		g.branch.push(assistant(T0 + 1, 10, "ok", { usage: usage({}, 0.6) })); // spent 2.1 >= 2.0
		await tool(g);
		expect(g.select).toHaveBeenCalledTimes(2);
		expect(g.select.mock.calls[1][0]).toBe("Session budget $2.00 spent (~$2.10 so far)");
		await g.fire("session_start"); // a new session forgets the raise
		await tool(g);
		expect(g.select.mock.calls[2][0]).toMatch(/^Session budget \$1\.00/);
	});
	it("Stop, undefined or a throw block with terminate; after Stop the rest of the run is blocked without asking", async () => {
		for (const pick of ["Stop tool calls", undefined]) {
			const g = setup({ settings: cfg({ sessionBudget: 1 }), branch: [costly(1.5)], select: pick });
			const r = await tool(g);
			expect(r).toMatchObject({ block: true, terminate: true });
			expect(r.reason).toBe("Session budget of $1.00 is spent (~$1.50). Stop and ask the user before continuing.");
			expect(await tool(g)).toMatchObject({ block: true });
			expect(g.select).toHaveBeenCalledOnce();
			await g.fire("agent_start"); // a new run asks again
			await tool(g);
			expect(g.select).toHaveBeenCalledTimes(2);
		}
		const t = over();
		t.select.mockRejectedValueOnce(new Error("x"));
		expect(await tool(t)).toMatchObject({ block: true, terminate: true });
	});
	it("no UI blocks", async () => {
		const g = setup({ settings: cfg({ sessionBudget: 1 }), branch: [costly(1.5)], hasUI: false });
		expect(await tool(g)).toMatchObject({ block: true, terminate: true });
		expect(g.select).not.toHaveBeenCalled();
	});
	it("never gates estimate_cost or the checkpoint turn", async () => {
		const g = over();
		expect(await g.fire("tool_call", { toolName: "estimate_cost" })).toBeUndefined();
		expect(g.select).not.toHaveBeenCalled();
		const h = setup({ settings: cfg({ sessionBudget: 1 }), branch: [costly(1.5)], select: "Stop tool calls" });
		await boot(h);
		await h.fire("cache_warming_decision", { type: "cache_warming_decision", action: "stop", warmCost: 0.05, missCost: 0.04, continuationProbability: 0 });
		expect(h.sent[0]?.text).toMatch(/^\[governor checkpoint\]/);
		expect(await tool(h)).toBeUndefined();
		expect(h.select).not.toHaveBeenCalled();
	});
	it("a prompt over budget gets one notice and is not blocked", async () => {
		const g = over();
		expect(await prompt(g)).toBeUndefined();
		expect(g.ui.notify).toHaveBeenCalledWith("Session budget spent (~$1.50 of $1.00): tool calls will ask first.", "info");
		expect(g.ui.notify.mock.calls.filter((c) => /Session budget/.test(c[0]))).toHaveLength(1);
	});
	it("the brief shows budget left, floor 0; none when unset", async () => {
		const brief = async (g: ReturnType<typeof setup>) => (await boot(g), await g.fire("before_agent_start", { messageType: "user", prompt: "p" }))?.message.content as string | undefined;
		expect(await brief(setup({ settings: cfg({ sessionBudget: 2 }), branch: [costly(0.5)] }))).toContain("Budget left ~$1.50.");
		expect(await brief(setup({ settings: cfg({ sessionBudget: 1 }), branch: [costly(3)] }))).toContain("Budget left ~$0.000.");
		expect(await brief(setup({ branch: [costly(3)] }))).not.toContain("Budget left");
		expect(buildBrief({ left: 1, session: [], history: [], prompt: "", model: undefined })).toContain("Budget left ~$1.00.");
	});
	it("/governor shows the settings when set", async () => {
		const g = over();
		await g.fire("session_start");
		await g.commands.get("governor")!("", g.ctx);
		expect(g.ui.notify.mock.calls.at(-1)![0]).toContain("budget $1.00 (spent ~$1.50)");
	});
});

describe("defaults", () => {
	it("no dialogs anywhere with both off", async () => {
		const g = setup({ branch: [costly(100)], confirm: false, select: undefined });
		await g.fire("session_start");
		await prompt(g);
		await g.tools.get("estimate_cost").execute("1", { steps: 8, usd: 50, reason: "x" }, undefined, undefined, g.ctx);
		expect(await g.fire("tool_call", { toolName: "bash" })).toBeUndefined();
		expect(g.confirm).not.toHaveBeenCalled();
		expect(g.select).not.toHaveBeenCalled();
	});
});
