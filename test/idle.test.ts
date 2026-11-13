// Spec: docs/SPEC-idle-checkpoint.md (U1-U16)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, loadConfig } from "../src/governor.ts";
import { assistant, custom, setup, T0, TEST_SETTINGS } from "./helpers.ts";

const MIN = 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => vi.useRealTimers());
const gov = (g: Record<string, unknown>) => ({ governor: { ...TEST_SETTINGS.governor, ...g } });
const open = (extra = {}) => custom("governor-checkpoint", { open: true, text: "HANDOFF", tokens: 100_000, awt: false, ...extra });
const settled = (g: ReturnType<typeof setup>) => { g.fire("session_start"); g.fire("agent_settled", { aborted: false }); };
const prompts = (g: ReturnType<typeof setup>) => g.sent.filter((m) => m.text.startsWith("[governor checkpoint]"));
const logs = (g: ReturnType<typeof setup>) => g.entries.filter((e) => e.type === "governor-log").map((e) => e.data.msg as string);

describe("idle checkpoint watchdog", () => {
	it("U1 takes the checkpoint in the warm window when pi's warmer made no decision, once", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		settled(g);
		await vi.advanceTimersByTimeAsync(0.91 * 300_000);
		expect(prompts(g)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(0.02 * 300_000);
		expect(prompts(g)).toHaveLength(1);
		expect(logs(g).some((m) => /idle checkpoint at 100K/.test(m))).toBe(true);
		await vi.advanceTimersByTimeAsync(20 * MIN);
		expect(prompts(g)).toHaveLength(1);
	});
	it("U2 stands down when pi's warmer decided first", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		settled(g);
		await vi.advanceTimersByTimeAsync(0.9 * 300_000);
		g.fire("cache_warming_decision", { type: "cache_warming_decision", action: "warm", continuationProbability: 0.15 });
		await vi.advanceTimersByTimeAsync(2 * MIN);
		expect(prompts(g)).toHaveLength(0);
	});
	it("U3 arms nothing below the pay threshold", async () => {
		const g = setup({ branch: [assistant(T0, 5_000)] });
		settled(g);
		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(g.sent).toHaveLength(0);
	});
	it("U4 is off with idleCheckpoint: false", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)], settings: gov({ idleCheckpoint: false }) });
		settled(g);
		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(g.sent).toHaveLength(0);
	});
	it("U5 a user message before the timer clears it", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		settled(g);
		await vi.advanceTimersByTimeAsync(2 * MIN);
		await g.fire("input", { source: "interactive", text: "hi" });
		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(prompts(g)).toHaveLength(0);
	});
	it("U6 a run starting before the timer clears it", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		settled(g);
		await vi.advanceTimersByTimeAsync(2 * MIN);
		g.fire("agent_start");
		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(prompts(g)).toHaveLength(0);
	});
	it("U7 does nothing when the cache is already cold at fire time (clock jump)", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		settled(g);
		vi.setSystemTime(T0 + 8 * MIN); // timers do not fire on a plain clock jump
		await vi.advanceTimersByTimeAsync(0.92 * 300_000);
		expect(prompts(g)).toHaveLength(0);
	});
	it("U8 does nothing when a checkpoint is open", async () => {
		const g = setup({ branch: [assistant(T0, 100_000), open()] });
		settled(g);
		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(g.sent).toHaveLength(0);
	});
	it("a failed checkpoint turn does not re-arm: one attempt per idle period", async () => {
		const g = setup({ branch: [assistant(T0, 100_000)] });
		settled(g);
		await vi.advanceTimersByTimeAsync(0.93 * 300_000);
		g.fire("agent_settled", { aborted: true });
		await vi.advanceTimersByTimeAsync(30 * MIN);
		expect(prompts(g)).toHaveLength(1);
	});
});

describe("automatic return", () => {
	const input = { source: "interactive", text: "next please" };
	const expired = () => vi.setSystemTime(T0 + 28 * MIN);
	const base = (o: object = {}) => setup({ branch: [assistant(T0, 342_000), open({ tokens: 342_000 })], settings: gov({ autoContinue: true }), ...o });

	it("U9 continues in a new session without a question, with the saved cost in the notice", async () => {
		const g = base();
		g.fire("session_start");
		expired();
		expect(await g.fire("input", input)).toEqual({ action: "handled" });
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(g.select).not.toHaveBeenCalled();
		expect(g.ui.notify.mock.calls.some(([m]) => /Cache expired 23 min ago; continuing from the checkpoint in a new session \(~\$0\.0\d+ instead of ~\$1\.28\)/.test(m))).toBe(true);
		expect(g.sent.at(-1)!.text).toMatch(/^\[new\] .*HANDOFF.*next please$/s);
		expect(logs(g).some((m) => m.startsWith("auto-continue:"))).toBe(true);
	});
	it("U10 falls back to asking when the saving is under $0.05", async () => {
		const g = setup({ branch: [assistant(T0, 8_000), open({ tokens: 8_000 })], settings: gov({ autoContinue: true }), select: "Resume full context" });
		g.fire("session_start");
		expired();
		expect(await g.fire("input", input)).toBeUndefined();
		expect(g.select).toHaveBeenCalled();
	});
	it("U12 works without a UI", async () => {
		const g = base({ hasUI: false });
		g.fire("session_start");
		expired();
		expect(await g.fire("input", input)).toEqual({ action: "handled" });
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(g.sent.at(-1)!.text).toMatch(/^\[new\] .*next please$/s);
	});
	it("U13 a refused switch delivers the message to the current session and reopens the checkpoint", async () => {
		const g = base();
		g.newSession.mockResolvedValueOnce({ cancelled: true });
		g.fire("session_start");
		expired();
		await g.fire("input", input);
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(g.sent.at(-1)).toMatchObject({ text: "next please" });
		expect(g.entries.at(-1)!.data).toMatchObject({ open: true, reopen: true });
	});
	it("U14 changes nothing while the cache is warm", async () => {
		const g = base();
		g.fire("session_start");
		vi.setSystemTime(T0 + 2 * MIN);
		expect(await g.fire("input", input)).toBeUndefined();
		expect(g.newSession).not.toHaveBeenCalled();
	});
	it("U15 with autoContinue off, nothing switches without a question", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open({ tokens: 342_000 })], select: "Resume full context" });
		g.fire("session_start");
		expired();
		await g.fire("input", input);
		expect(g.select).toHaveBeenCalled();
		expect(g.newSession).not.toHaveBeenCalled();
	});
});

describe("evidence and config", () => {
	it("U16 logs once when the cache expired with no checkpoint", async () => {
		const g = setup({ branch: [assistant(T0, 120_000)] });
		g.fire("session_start");
		vi.setSystemTime(T0 + 20 * MIN);
		await g.fire("input", { source: "interactive", text: "hi" });
		expect(logs(g).filter((m) => /cache expired with no checkpoint \(120K tokens, idle 20 min, refreshes since last request 0\)/.test(m))).toHaveLength(1);
	});
	it("does not log for a small context or a warm cache", async () => {
		const small = setup({ branch: [assistant(T0, 3_000)] });
		small.fire("session_start");
		vi.setSystemTime(T0 + 20 * MIN);
		await small.fire("input", { source: "interactive", text: "hi" });
		const warm = setup({ branch: [assistant(T0, 120_000)] });
		warm.fire("session_start");
		vi.setSystemTime(T0 + 2 * MIN);
		await warm.fire("input", { source: "interactive", text: "hi" });
		expect(logs(small)).toEqual([]);
		expect(logs(warm)).toEqual([]);
	});
	it("loadConfig defaults and ignores wrong types", () => {
		expect(DEFAULTS).toMatchObject({ idleCheckpoint: true, autoContinue: false });
		expect(loadConfig({ governor: { idleCheckpoint: "yes", autoContinue: 1 } })).toMatchObject({ idleCheckpoint: true, autoContinue: false });
		expect(loadConfig({ governor: { idleCheckpoint: false, autoContinue: true } })).toMatchObject({ idleCheckpoint: false, autoContinue: true });
	});
});
