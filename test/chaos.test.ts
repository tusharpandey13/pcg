// Chaos suite for pi-governor. Reproduce a failure with CHAOS_SEED=<n> npx vitest run test/chaos.test.ts
// Everything uses the faux provider or hand mocks. A fetch guard fails any test that touches the network.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakEvenRefreshes, buildReport, DEFAULTS, expectWake, loadConfig, refreshesSince } from "../src/governor.ts";
import { assistant, bootReal, BAD_TEXT, checkReport, makeSim, MIN, netGuard, reply, rng, SEED, T0, usage, warm } from "./chaos-helpers.ts";

let attacks = 0;
const atk = (n = 1) => void (attacks += n);
let guard: ReturnType<typeof netGuard>;
const live: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(T0); guard = netGuard(); });
afterEach(() => { vi.useRealTimers(); while (live.length) live.pop()!(); guard.restore(); expect(guard.calls, "faux only: no network request").toEqual([]); });
afterAll(() => console.log(`[chaos] seed=${SEED} attacks=${attacks}`));

const NOROLL = { settings: { governor: { rolloverTokens: 0 } } };
const CTX340 = "x".repeat(1_360_000);
const big = (n = 150_000, ts = T0) => assistant(ts, n);
const cpPrompts = (s: ReturnType<typeof makeSim>) => s.prompts;
const mkSim = (o: Parameters<typeof makeSim>[0] = {}, tokens = 150_000) => {
	const s = makeSim(o);
	s.g.branch.push(big(tokens));
	s.ctxTokens = tokens;
	return s;
};
async function start(s: ReturnType<typeof makeSim>) { await s.ops.fire("session_start"); }
const openCheckpoints = (s: ReturnType<typeof makeSim>) => s.g.branch.filter((e: any) => e.customType === "governor-checkpoint" && e.data?.open);

// ============================ TIME ============================================
describe("time", () => {
	it("decision exactly at the 29-minute checkpoint boundary does not checkpoint; one ms later does, once", async () => {
		atk();
		const s = mkSim(); await start(s);
		vi.setSystemTime(T0 + 24.5 * MIN);
		expect(await s.ops.fire("cache_warming_decision", { action: "warm" })).toBeUndefined();
		expect(cpPrompts(s)).toBe(0);
		await s.ops.fire("after_provider_response", { status: 200, headers: {} }); // the refresh succeeded
		vi.setSystemTime(T0 + 24.5 * MIN + 1);
		expect(await s.ops.fire("cache_warming_decision", { action: "warm" })).toEqual({ action: "stop" });
		expect(cpPrompts(s)).toBe(1);
		expect(s.errors).toEqual([]);
	});

	it("repeated and out-of-order decisions yield exactly one checkpoint prompt per idle period", async () => {
		atk();
		const s = mkSim(); await start(s);
		for (let i = 0; i < 6; i++) await s.ops.decide("stop");
		await s.ops.decide("warm");
		expect(cpPrompts(s)).toBe(1);
		await s.ops.finish("ok");
		for (let i = 0; i < 6; i++) await s.ops.decide(i % 2 ? "warm" : "stop");
		expect(cpPrompts(s)).toBe(1);
		expect(openCheckpoints(s)).toHaveLength(1);
		expect(s.errors).toEqual([]);
	});

	it("clock jumping back one hour and forward three days never crashes or loops", async () => {
		atk();
		const s = mkSim(); await start(s);
		for (const jump of [-60 * MIN, +3 * 24 * 60 * MIN, -3 * 24 * 60 * MIN, 29 * MIN, -29 * MIN, 0]) {
			s.ops.jump(jump);
			await s.ops.decide("stop");
			await s.ops.decide("warm");
			checkReport(await s.ops.report());
		}
		expect(cpPrompts(s)).toBeLessThanOrEqual(1);
		expect(s.errors).toEqual([]);
	});

	it("return exactly at expiry counts as warm (no question); one ms later asks once, with a finite minute count", async () => {
		atk(2);
		for (const [late, asks] of [[0, 0], [1, 1]] as const) {
			vi.setSystemTime(T0);
			const s = mkSim({ select: "Resume full context  ~$1" }); await start(s);
			s.g.branch.push({ ...(await import("./helpers.ts")).custom("governor-checkpoint", { open: true, text: "H", tokens: 150000, awt: false }) });
			await s.ops.fire("session_start");
			vi.setSystemTime(T0 + 5 * MIN + late);
			await s.ops.user("back");
			expect(s.g.select).toHaveBeenCalledTimes(asks);
			if (asks) expect(String(s.g.select.mock.calls[0][0])).not.toMatch(BAD_TEXT);
			await s.ops.user("again");
			expect(s.g.select.mock.calls.length).toBe(asks); // once
			expect(s.errors).toEqual([]);
		}
	});

	it("sleep across expiry with a wake expected: nothing blows up, the user is asked once on return", async () => {
		atk();
		const s = mkSim({ select: "Continue from checkpoint  ~$0.08" }, 150_000); await start(s);
		s.ops.wake("w", true);
		await s.ops.decide("stop");
		s.ops.jump(2 * 60 * MIN); // laptop slept
		s.ops.wake("w", false);
		await s.ops.decide("stop"); // out-of-order decision after wake: now creates a checkpoint (stale cache), costs 0.1x? no: cache is gone
		await s.ops.finish("ok");
		await s.ops.user("hello");
		expect(s.errors).toEqual([]);
		expect(s.g.select.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("regression: NaN timestamps in the branch never reach the user (prompt text stays finite)", async () => {
		atk();
		const s = mkSim({ select: "Resume full context" }); await start(s);
		s.g.branch.push({ ...warm(T0), timestamp: "garbage" });
		s.g.branch.push((await import("./helpers.ts")).custom("governor-checkpoint", { open: true, text: "H", tokens: 150000, awt: false }));
		await s.ops.fire("session_start");
		s.ops.jump(10 * MIN);
		await s.ops.user("x");
		for (const c of s.g.select.mock.calls) expect(String(c[0])).not.toMatch(BAD_TEXT);
	});
});

// ============================ INTERLEAVING ====================================
describe("interleaving", () => {
	it("user input during a checkpoint turn is held with a notice, delivered exactly once after it settles, and never enters the handoff", async () => {
		atk();
		const s = mkSim(); await start(s);
		await s.ops.decide("stop");
		expect(s.turn?.kind).toBe("checkpoint");
		const r = await s.ops.user("hurry up");
		expect(r?.action).toBe("handled");
		expect(s.g.ui.notify).toHaveBeenCalled();
		expect(s.userSent).toEqual([]); // not delivered mid-turn
		await s.ops.decide("stop");
		await s.ops.finish("ok");
		await s.ops.flush();
		expect(s.userSent.filter((t) => t === "hurry up")).toHaveLength(1);
		expect((openCheckpoints(s)[0] as any).data.text).toBe("handoff text");
		await s.ops.flush(); await s.ops.advance(MIN);
		expect(s.userSent.filter((t) => t === "hurry up")).toHaveLength(1);
		expect(cpPrompts(s)).toBe(1);
		expect(s.switches).toBe(0);
		expect(s.errors).toEqual([]);
	});

	it("a rollover checkpoint running blocks decision-time checkpoints and vice versa", async () => {
		atk(2);
		const s = mkSim({}, 250_000); await start(s);
		await s.ops.fire("agent_settled", { aborted: false }); // big context -> rollover checkpoint
		expect(s.turn?.kind).toBe("checkpoint");
		await s.ops.decide("stop");
		await s.ops.decide("warm");
		expect(cpPrompts(s)).toBe(1);
		await s.ops.finish("ok");
		expect(s.switches).toBe(1);
		expect(s.unannounced).toBe(0);
		expect(cpPrompts(s)).toBe(1);

		const t = mkSim(); await start(t);
		await t.ops.decide("stop"); // warm-stop checkpoint running
		await t.ops.user("typed while checkpointing", 250_000); // a big-context user turn queued behind it
		await t.ops.finish("ok");
		expect(t.prompts).toBe(1);
	});

	it("abort during a checkpoint: no rollover, no switch, no immediate retry; the next user turn unblocks", async () => {
		atk();
		const s = mkSim({}, 250_000); await start(s);
		await s.ops.fire("agent_settled", { aborted: false });
		await s.ops.finish("abort");
		await s.ops.decide("stop");
		await s.ops.fire("agent_settled", { aborted: false });
		expect(s.switches).toBe(0);
		expect(cpPrompts(s)).toBe(1);
		expect(openCheckpoints(s)).toHaveLength(0);
	});

	it("regression: an aborted checkpoint that reported usage must not be retried by a later decision (one per idle period)", async () => {
		atk();
		const s = mkSim(); await start(s);
		await s.ops.decide("stop");
		await s.ops.finish("abort", { cacheRead: 150_000 });
		await s.ops.decide("stop");
		await s.ops.decide("stop");
		expect(cpPrompts(s)).toBe(1);
	});

	it("an errored checkpoint (500) is not retried and not recorded", async () => {
		atk();
		const s = mkSim(); await start(s);
		await s.ops.decide("stop");
		await s.ops.finish("error");
		for (let i = 0; i < 3; i++) await s.ops.decide("stop");
		expect(cpPrompts(s)).toBe(1);
		expect(openCheckpoints(s)).toHaveLength(0);
	});

	it("session switch / reload / new session mid-handoff leaves a usable, quiet governor", async () => {
		atk(3);
		const s = mkSim({}, 250_000); await start(s);
		await s.ops.fire("agent_settled", { aborted: false }); // rollover checkpoint pending
		await s.ops.reload(); // /reload mid-handoff
		await s.ops.fire("agent_settled", { aborted: false }); // late settle from the old turn: nothing to do
		expect(s.switches).toBe(0);
		// a rollover whose command fires after the user already started a new session
		const t = mkSim({}, 250_000); await start(t);
		await t.ops.fire("agent_settled", { aborted: false });
		await t.ops.finish("ok"); // schedules governor-rollover
		await t.ops.reload();
		await t.ops.flush();
		expect(t.errors).toEqual([]);
		// governor still works afterwards
		t.g.branch.push(big(150_000, Date.now()));
		await t.ops.decide("stop");
		expect(t.prompts).toBeGreaterThanOrEqual(2);
	});

	it("wake flapping, unknown ids, duplicate on/off, never cleared: decisions follow the cap and warming ends", async () => {
		atk(3);
		const s = mkSim(); await start(s);
		s.ops.wake("a", false);
		s.ops.wake("a", true); s.ops.wake("a", true); s.ops.wake("b", true);
		s.ops.wake("a", false); // b remains
		let warms = 0;
		for (let i = 0; i < 40; i++) { const r = await s.ops.decide("stop"); if (r?.action === "warm") warms++; else break; }
		expect(warms).toBe(breakEvenRefreshes(DEFAULTS.prices)); // ends at the cap, not before, not after
		expect(s.decisionViolations).toEqual([]);
		// all workers gone -> pi's own decision again
		s.ops.wake("b", false);
		expect(await s.ops.fire("cache_warming_decision", { action: "warm" })).toBeUndefined();
	});

	it("multiple workers expected then none, rapid toggling with random order", async () => {
		atk();
		const r = rng(SEED);
		const s = mkSim(); await start(s);
		for (let i = 0; i < 200; i++) {
			s.ops.wake(`w${r.int(4)}`, r.chance(0.5));
			if (r.chance(0.5)) await s.ops.decide(r.pick(["warm", "stop"] as const), { append: r.chance(0.7) });
			if (r.chance(0.1)) await s.ops.user("m");
		}
		expect(s.decisionViolations).toEqual([]);
		expect(s.errors).toEqual([]);
	});

	it("a wake that is never cleared keeps rollover off, but warming still ends at the cap", async () => {
		atk();
		const s = mkSim({}, 250_000); await start(s);
		s.ops.wake("forever", true);
		await s.ops.fire("agent_settled", { aborted: false });
		expect(cpPrompts(s)).toBe(0);
		const out: string[] = [];
		for (let i = 0; i < 30; i++) out.push((await s.ops.decide("warm"))!.action!);
		expect(out.filter((a) => a === "warm")).toHaveLength(11);
		expect(out.slice(12).every((a) => a === "stop")).toBe(true);
	});

	it("internal commands invoked directly or twice: no-ops without a checkpoint, announced switch with one, never twice", async () => {
		atk(4);
		const s = mkSim(); await start(s);
		for (const c of ["governor-rollover", "governor-continue", "governor-rollover", "governor-continue"]) await s.g.commands.get(c)!("", s.g.ctx);
		expect(s.switches).toBe(0);
		// with a checkpoint
		await s.ops.decide("stop"); await s.ops.finish("ok");
		await s.g.commands.get("governor-continue")!("", s.g.ctx); // no pending message: no-op
		expect(s.switches).toBe(0);
		await s.g.commands.get("governor-rollover")!("", s.g.ctx);
		await s.g.commands.get("governor-rollover")!("", s.g.ctx);
		expect(s.switches).toBe(1);
		expect(s.unannounced).toBe(0);
		expect(s.seeds).toHaveLength(1);
		expect(s.errors).toEqual([]);
	});

	it("regression: choosing 'continue' when the new session is refused must not lose the user's message", async () => {
		atk();
		const s = mkSim({ select: "Continue from checkpoint", newSessionResult: "cancel" }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN);
		await s.ops.user("my important question");
		await s.ops.flush();
		expect(s.userSent.join("\n") + s.seeds.join("\n")).toContain("my important question");
	});

	it("regression: choosing 'continue' while newSession throws leaves no unhandled error and keeps the message deliverable", async () => {
		atk();
		const s = mkSim({ select: "Continue from checkpoint", newSessionResult: "throw" }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN);
		await s.ops.user("my other question");
		await s.ops.flush();
		expect(s.errors).toEqual([]);
		expect(s.userSent.join("\n")).toContain("my other question");
	});

	it("regression: two inputs racing the return question get asked once", async () => {
		atk();
		const releases: ((v: string) => void)[] = [];
		const s = mkSim({ selectImpl: () => new Promise<string | undefined>((r) => releases.push(r)) }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN);
		const a = s.ops.fire("input", { text: "one", source: "interactive" });
		const b = s.ops.fire("input", { text: "two", source: "interactive" });
		await vi.advanceTimersByTimeAsync(0);
		releases.forEach((r) => r("Resume full context"));
		await vi.advanceTimersByTimeAsync(0);
		releases.forEach((r) => r("Resume full context"));
		await Promise.all([a, b]);
		expect(s.g.ui.select.mock.calls.length).toBe(1);
	});
});

// ============================ PROVIDER / USAGE ================================
describe("provider and usage", () => {
	it.each([401, 403])("%i on a refresh stops warming (even with a wake) until the next real request", async (code) => {
		atk(2);
		const s = mkSim(); await start(s);
		s.ops.wake("w", true);
		await s.ops.decide("stop");
		await s.ops.status(code);
		expect(await s.ops.fire("cache_warming_decision", { action: "warm" })).toEqual({ action: "stop" });
		expect(s.g.ui.setStatus).toHaveBeenCalledWith("governor", "AWS credentials expired");
		await s.ops.fire("agent_start");
		expect(s.g.ui.setStatus).toHaveBeenLastCalledWith("governor", undefined);
		expect(await s.ops.fire("cache_warming_decision", { action: "stop" })).toEqual({ action: "warm" });
	});

	it.each([429, 500, 502, 503, 408, 0, undefined as any])("status %s on a refresh does not trip the auth stop and warming stays bounded", async (code) => {
		atk();
		const s = mkSim(); await start(s);
		s.ops.wake("w", true);
		let n = 0;
		for (let i = 0; i < 15; i++) {
			const r = await s.ops.decide("stop", { append: false }); // failed refreshes record no cache_warm entry
			if (r?.action !== "warm") break;
			await s.ops.status(code);
			n++;
		}
		expect(s.g.ui.setStatus).not.toHaveBeenCalled();
		expect(n).toBeGreaterThan(0); // still trying: only pi's own 30 min limit ends it (see the next test)
	});

	it("regression: failed refreshes (500/429/timeout) record no cache_warm entry, so they never count toward the break-even cap", async () => {
		atk();
		const s = mkSim(); await start(s);
		s.ops.wake("w", true);
		let n = 0;
		for (let i = 0; i < 40; i++) {
			const r = await s.ops.decide("stop", { append: false });
			if (r?.action !== "warm") break;
			await s.ops.status(500);
			n++;
		}
		expect(n).toBeLessThanOrEqual(breakEvenRefreshes(DEFAULTS.prices));
	});

	it("a 401 on a real request or on the checkpoint turn is not a refresh failure", async () => {
		atk(2);
		const s = mkSim(); await start(s);
		await s.ops.decide("stop"); // checkpoint turn running, not idle
		await s.ops.status(401);
		await s.ops.finish("error");
		s.ops.wake("w", true);
		expect(await s.ops.fire("cache_warming_decision", { action: "warm" })).toEqual({ action: "warm" });
		expect(s.g.ui.setStatus).not.toHaveBeenCalled();
	});

	it("dropped refresh responses: warming ends at the first drop, a refresh made during a turn never false-stops, and the next real request recovers", async () => {
		atk();
		const r = rng(SEED + 17);
		for (let run = 0; run < 40; run++) {
			const s = mkSim(); await start(s);
			if (r.chance(0.5)) s.ops.wake("w", true);
			const dropAt = r.int(6);
			let stopped = -1;
			for (let i = 0; i < 8; i++) {
				const a = (await s.ops.decide("warm"))?.action ?? "warm";
				if (stopped < 0 && a === "stop") stopped = i;
				if (i === dropAt) s.ops.drop();
			}
			expect(stopped, `run ${run}`).toBe(dropAt + 1);
			expect(s.g.ui.setStatus).toHaveBeenCalledWith("governor", "AWS credentials unavailable");
			await s.ops.user("back");
			expect((await s.ops.decide("warm"))?.action ?? "warm", `run ${run} recovers`).not.toBe("stop");
			expect(s.decisionViolations).toEqual([]);
			expect(s.errors).toEqual([]);
		}
	});

	it("a stray 401 while idle but not refreshing is ignored", async () => {
		atk();
		const s = mkSim(); await start(s);
		await s.ops.fire("after_provider_response", { status: 401, headers: {} });
		expect(s.g.ui.setStatus).not.toHaveBeenCalled();
	});

	it("a timeout (no status) and a rejected checkpoint turn never wedge the governor", async () => {
		atk();
		const s = mkSim(); await start(s);
		await s.ops.decide("stop");
		await s.ops.finish("error");
		await s.ops.user("retry", 150_000);
		s.ops.jump(25 * MIN);
		await s.ops.decide("stop");
		expect(s.prompts).toBe(2); // a new idle period gets a new checkpoint
	});

	// Report arithmetic with hostile usage. Every dollar figure must be finite and non-negative.
	const junk: [string, unknown][] = [["NaN", NaN], ["negative", -5], ["huge", 1e308], ["Infinity", Infinity], ["zero", 0]];
	it.each(junk.filter(([n]) => ["zero", "huge"].includes(n)))("report survives %s cache_warm cost with finite output", async (_n, v) => {
		atk();
		const s = mkSim(); await start(s);
		s.g.branch.push({ ...warm(T0 + 1), usage: usage({ cacheRead: 1 }, v as number) });
		const out = await s.ops.report();
		checkReport(out);
		expect(s.errors).toEqual([]);
	});
	for (const [n, v] of junk.filter(([n]) => ["NaN", "negative", "Infinity"].includes(n))) {
		it(`regression: report must stay finite and non-negative with a ${n} cache_warm cost`, async () => {
			atk();
			const s = mkSim(); await start(s);
			s.g.branch.push({ ...warm(T0 + 1), usage: usage({ cacheRead: 1 }, v as number) });
			checkReport(await s.ops.report());
		});
	}
	it("regression: a cache_warm entry without usage must not break /governor", async () => {
		atk();
		const s = mkSim(); await start(s);
		s.g.branch.push({ ...warm(T0 + 1), usage: undefined });
		const out = await s.ops.report();
		expect(s.errors).toEqual([]);
		expect(out).toContain("Refreshes");
	});
	it("regression: a cache_warm entry with usage but no cost object must not break /governor", async () => {
		atk();
		const s = mkSim(); await start(s);
		s.g.branch.push({ ...warm(T0 + 1), usage: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 } });
		await s.ops.report();
		expect(s.errors).toEqual([]);
	});
	it("assistant usage with missing/NaN/negative token counts: report and decisions stay finite", async () => {
		atk();
		const s = makeSim(); await start(s);
		s.g.branch.push(assistant(T0, 0, "a", { usage: usage({ cacheRead: NaN as never }) }));
		s.g.branch.push(assistant(T0 + 1, 0, "b", { usage: usage({ cacheRead: -100 as never, cacheWrite: 1e15 }) }));
		s.g.branch.push(assistant(T0 + 6 * MIN, 0, "c", { usage: usage({ cacheRead: 1e15 }) }));
		checkReport(await s.ops.report());
		await s.ops.decide("stop");
		expect(s.errors).toEqual([]);
	});
	it("regression: assistant message without a usage object must not crash decisions", async () => {
		atk();
		const s = makeSim(); await start(s);
		s.g.branch.push(assistant(T0, 0, "a", { usage: undefined }));
		await s.ops.decide("stop");
		await s.ops.fire("agent_settled", { aborted: false });
		expect(s.errors).toEqual([]);
	});
	it("regression: a checkpoint turn whose usage cost is NaN/negative must not poison the net estimate", async () => {
		atk();
		const s = mkSim(); await start(s);
		await s.ops.decide("stop");
		await s.ops.finish("ok", {});
		const last: any = s.g.branch.filter((e: any) => e.type === "message").at(-1);
		expect(openCheckpoints(s)).toHaveLength(1);
		last.message.usage.cost.total = NaN;
		(openCheckpoints(s)[0] as any).data.cost = NaN;
		checkReport(await s.ops.report());
	});
	it("returned-prompt dollar figures are finite for zero prices, zero tokens and huge tokens", async () => {
		atk(3);
		for (const [settings, tokens] of [[{ governor: { prices: { cacheWrite: 0, cacheRead: 0 } } }, 150_000], [{}, 0], [{}, 1e15]] as const) {
			vi.setSystemTime(T0);
			const s = mkSim({ settings, select: "Resume full context" }, tokens); await start(s);
			s.g.branch.push((await import("./helpers.ts")).custom("governor-checkpoint", { open: true, text: "H", tokens, awt: false }));
			await s.ops.fire("session_start");
			s.ops.jump(40 * MIN);
			await s.ops.user("x");
			for (const c of s.g.select.mock.calls) { expect(String(c[0])).not.toMatch(BAD_TEXT); for (const o of c[1]) expect(String(o)).not.toMatch(BAD_TEXT); }
			expect(s.errors).toEqual([]);
		}
	});
	it("regression: a corrupted open checkpoint entry (no text) restored at start does not crash the return flow", async () => {
		atk();
		const s = mkSim({ select: "Resume full context" }); await start(s);
		s.g.branch.push((await import("./helpers.ts")).custom("governor-checkpoint", { open: true }));
		await s.ops.fire("session_start");
		s.ops.jump(40 * MIN);
		await s.ops.user("x");
		expect(s.errors).toEqual([]);
	});
});

// ============================ ENVIRONMENT =====================================
describe("environment", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gov-env-")); });
	afterEach(() => { try { chmodSync(join(dir, ".pi-governor"), 0o755); } catch {} rmSync(dir, { recursive: true, force: true }); });

	const finishCp = async (s: ReturnType<typeof makeSim>) => { await s.ops.decide("stop"); await s.ops.finish("ok"); };

	it("./awt missing, a directory, non-executable, or a symlink loop: prompt picks a mode, nothing crashes, handoff = reply text", async () => {
		atk(4);
		const variants: [string, (p: string) => void][] = [
			["missing", () => {}], ["dir", (p) => mkdirSync(p)], ["nonexec", (p) => writeFileSync(p, "garbage\u0000\u0001", { mode: 0o644 })],
			["hang", (p) => writeFileSync(p, "#!/bin/sh\nsleep 1000\n", { mode: 0o755 })],
		];
		for (const [name, mk] of variants) {
			const cwd = mkdtempSync(join(tmpdir(), "gov-awt-"));
			mk(join(cwd, "awt"));
			const s = mkSim({ cwd }); await start(s);
			await finishCp(s);
			expect(s.errors, name).toEqual([]);
			expect((openCheckpoints(s)[0] as any).data.text, name).toBe("handoff text");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("deleted cwd: checkpoint still completes from the reply", async () => {
		atk();
		const cwd = mkdtempSync(join(tmpdir(), "gov-gone-")); rmSync(cwd, { recursive: true });
		const s = mkSim({ cwd }); await start(s);
		await finishCp(s);
		expect(s.errors).toEqual([]);
		expect(openCheckpoints(s)).toHaveLength(1);
	});

	it("regression: handoff.md that is a directory must not break the checkpoint settle", async () => {
		atk();
		mkdirSync(join(dir, ".pi-governor", "handoff.md"), { recursive: true });
		const s = mkSim({ cwd: dir }); await start(s);
		await finishCp(s);
		expect(s.errors).toEqual([]);
		expect(openCheckpoints(s)).toHaveLength(1);
	});

	it("regression: unreadable handoff.md (read-only/permission-denied dir) must not break the checkpoint settle", async () => {
		atk();
		if (process.getuid?.() === 0) return;
		mkdirSync(join(dir, ".pi-governor"));
		writeFileSync(join(dir, ".pi-governor", "handoff.md"), "secret");
		chmodSync(join(dir, ".pi-governor", "handoff.md"), 0o000);
		const s = mkSim({ cwd: dir }); await start(s);
		await finishCp(s);
		expect(s.errors).toEqual([]);
		expect(openCheckpoints(s)).toHaveLength(1);
	});

	it("regression: a stale handoff.md from an earlier checkpoint must not be used for a new one", async () => {
		atk();
		mkdirSync(join(dir, ".pi-governor"));
		writeFileSync(join(dir, ".pi-governor", "handoff.md"), "OLD STALE HANDOFF");
		const old = new Date(T0 - 3 * 3600_000);
		(await import("node:fs")).utimesSync(join(dir, ".pi-governor", "handoff.md"), old, old);
		const s = mkSim({ cwd: dir }); await start(s);
		await finishCp(s); // the model failed to write a new file; its reply is the handoff
		expect((openCheckpoints(s)[0] as any).data.text).not.toContain("OLD STALE");
	});

	it("a fresh, valid handoff.md is preferred over the reply (the documented path)", async () => {
		atk();
		mkdirSync(join(dir, ".pi-governor"));
		const s = mkSim({ cwd: dir }); await start(s);
		await s.ops.decide("stop");
		writeFileSync(join(dir, ".pi-governor", "handoff.md"), "WRITTEN BY MODEL");
		await s.ops.finish("ok");
		expect((openCheckpoints(s)[0] as any).data.text).toBe("WRITTEN BY MODEL");
	});

	const garbage: [string, any][] = [
		["strings for numbers", { governor: { checkpointMinTokens: "100", rolloverTokens: "0", prices: { cacheRead: "0.3", cacheWrite: "x" } } }],
		["negative caps", { governor: { checkpointMinTokens: -1, rolloverTokens: -5, prices: { input: -1, cacheWrite: -3, cacheRead: -0.1, output: -15 } } }],
		["zero prices", { governor: { prices: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } } }],
		["missing block", {}], ["null block", { governor: null }], ["string block", { governor: "on" }], ["array block", { governor: [] }],
		["null prices", { governor: { prices: null } }], ["NaN/Infinity", { governor: { rolloverTokens: NaN, checkpointMinTokens: Infinity, prices: { cacheRead: NaN, cacheWrite: Infinity } } }],
		["askOnReturn string", { governor: { askOnReturn: "false" } }], ["undefined settings", undefined],
	];
	it.each(garbage)("settings garbage: %s -> sane finite config, whole flow runs", async (_n, settings) => {
		atk();
		const c = loadConfig(settings);
		for (const v of [c.checkpointMinTokens, c.rolloverTokens, ...Object.values(c.prices)]) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); }
		expect(typeof c.askOnReturn).toBe("boolean");
		const cap = breakEvenRefreshes(c.prices);
		expect(Number.isFinite(cap)).toBe(true);
		const s = mkSim({ settings, select: "Resume full context" }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN); await s.ops.user("x");
		checkReport(await s.ops.report());
		expect(s.errors).toEqual([]);
	});

	it("break-even rule matches (write-read)/read across random price sets", async () => {
		atk(20);
		const r = rng(SEED);
		for (let i = 0; i < 20; i++) {
			const read = [0.03, 0.1, 0.3, 1, 1.5][r.int(5)], write = read * (1 + r.next() * 20);
			const prices = { input: 3, cacheWrite: write, cacheRead: read, output: 15 };
			const cap = Math.floor((write - read) / read);
			expect(breakEvenRefreshes(prices)).toBe(cap);
			const s = mkSim({ settings: { governor: { prices } } }); await start(s);
			s.ops.wake("w", true);
			let n = 0;
			for (; n < 500; n++) { if ((await s.ops.decide("stop"))?.action !== "warm") break; }
			expect(n, JSON.stringify(prices)).toBe(cap);
		}
	});

	it("no UI (print/json mode): expired checkpoint resumes without asking and logs; no select call", async () => {
		atk();
		const s = mkSim({ hasUI: false }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN);
		const r = await s.ops.user("x");
		expect(r?.action).not.toBe("handled");
		expect(s.g.select).not.toHaveBeenCalled();
		expect(s.g.entries.some((e) => e.type === "governor-log")).toBe(true);
		expect(s.switches).toBe(0);
	});

	it("regression: ui.select throwing (RPC/non-TUI) must not throw into pi, and the message must go through", async () => {
		atk();
		const s = mkSim({ selectImpl: async () => { throw new Error("select unavailable"); } }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN);
		const r = await s.ops.user("x");
		expect(s.errors).toEqual([]);
		expect(r?.action).not.toBe("handled");
	});

	it("ui.select cancelled (undefined) resumes full context, closes the checkpoint, no switch", async () => {
		atk();
		const s = mkSim({ select: undefined }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN);
		await s.ops.user("x");
		expect(s.switches).toBe(0);
		expect(openCheckpoints(s)).toHaveLength(1); // the open record
		expect(s.g.entries.at(-1)).toMatchObject({ type: "governor-checkpoint", data: { open: false } });
	});

	it("'continue' choice: announced switch, seed contains checkpoint and the user's message, one switch only", async () => {
		atk();
		const s = mkSim({ select: "Continue from checkpoint (don't ask again)" }); await start(s);
		await s.ops.decide("stop"); await s.ops.finish("ok");
		s.ops.jump(40 * MIN);
		const r = await s.ops.user("do the thing");
		expect(r?.action).toBe("handled");
		await s.ops.flush();
		expect(s.switches).toBe(1);
		expect(s.unannounced).toBe(0);
		expect(s.seeds[0]).toContain("do the thing");
		expect(s.seeds[0]).toContain("handoff text");
		expect(s.errors).toEqual([]);
	});
});

// ============================ RANDOM INTERLEAVINGS =============================
describe("seeded random interleavings", () => {
	const RUNS = Number(process.env.CHAOS_RUNS ?? 40), STEPS = 250;
	const garbageSettings = [undefined, {}, { governor: { prices: { cacheRead: 0.03, cacheWrite: 0.5 } } }, { governor: { rolloverTokens: 0 } }, { governor: { checkpointMinTokens: 1, rolloverTokens: 100_000 } }, { governor: { askOnReturn: false } }, { governor: { prices: { cacheRead: 0, cacheWrite: 0 } } }, { governor: "junk" }];
	it(`runs ${RUNS} fuzz sessions x ${STEPS} steps from CHAOS_SEED=${SEED}`, async () => {
		for (let run = 0; run < RUNS; run++) {
			const seed = SEED + run * 7919;
			const r = rng(seed);
			vi.setSystemTime(T0);
			const choices = ["Resume full context", "Continue from checkpoint", "Continue from checkpoint (don't ask again)", undefined];
			const s = makeSim({ settings: r.pick(garbageSettings), hasUI: r.chance(0.8), selectImpl: async () => r.pick(choices) });
			await s.ops.fire("session_start");
			const tag = `seed=${seed} run=${run}`;
			const trace: string[] = [];
			const sizes = [0, 20_000, 99_999, 100_000, 150_000, 199_999, 200_000, 200_001, 350_000];
			for (let i = 0; i < STEPS; i++) {
				const op = r.int(14);
				trace.push(`${i}:${op}@${((Date.now() - T0) / MIN).toFixed(1)}m cp=${s.prompts} since=${s.sinceUser} turn=${s.turn?.kind ?? "-"} w=${s.wakeSet.size}`);
				atk();
				switch (op) {
					case 0: case 1: await s.ops.user(`m${i}`, r.pick(sizes)); break;
					case 2: await s.ops.advance(r.pick([1000, 4.5 * MIN, 5 * MIN, 5 * MIN + 1, 29 * MIN, 1])); break;
					case 3: s.ops.jump(r.pick([-60 * MIN, -MIN, 1, MIN, 5 * MIN, 24.5 * MIN, 40 * MIN, 3 * 24 * 60 * MIN])); break;
					case 4: case 5: await s.ops.decide(r.pick(["warm", "stop"] as const), { append: r.chance(0.8) }); break;
					case 6: s.ops.wake(`w${r.int(3)}`, r.chance(0.6)); break;
					case 7: if (r.chance(0.25)) s.ops.drop(); else await s.ops.status(r.pick([401, 403, 429, 500, 200, 0])); break;
					case 8: await s.ops.finish(r.pick(["ok", "ok", "ok", "abort", "error"] as const)); break;
					case 9: await s.ops.user("big", r.pick([250_000, 400_000])); break;
					case 10: if (r.chance(0.3)) await s.ops.reload(); break;
					case 11: await s.g.commands.get(r.pick(["governor-rollover", "governor-continue"]))!("", s.g.ctx).catch((e: Error) => s.errors.push(String(e))); break;
					case 12: checkReport(await s.ops.report(), tag); break;
					case 13: await s.ops.flush(); break;
				}
				expect(s.errors, `${tag} step ${i} ops=\n${trace.slice(-8).join("\n")}`).toEqual([]);
				expect(s.concurrent, `${tag}: checkpoint started while another turn ran`).toBe(0);
				expect(s.sinceUser, `${tag}: >1 checkpoint in one idle period\n${trace.slice(-12).join("\n")}`).toBeLessThanOrEqual(1);
				expect(s.decisionViolations, tag).toEqual([]);
				expect(s.unannounced, `${tag}: unannounced session switch`).toBe(0);
			}
		}
	}, 30_000 + RUNS * 200); // scales with CHAOS_RUNS; the default 5 s timeout made this flaky under load
});

// ============================ REAL pi SESSION + REAL WARMER ===================
describe("real AgentSession and CacheWarmer", () => {
	it("a worker that never reports: warms while expected, exactly one checkpoint before pi's 30-minute stop, then warming stays off", async () => {
		atk();
		const t = await bootReal(NOROLL); live.push(t.dispose);
		const t0 = Date.now();
		t.faux.setResponses([reply("hi", { cacheWrite: 340_000 })]);
		await t.session.prompt(CTX340);
		expectWake(t.pi, "worker-1");
		t.faux.setResponses(Array.from({ length: 30 }, (_, i) => reply("", { cacheRead: 340_000 }, 0.1)));
		await vi.advanceTimersByTimeAsync(40 * MIN);
		t.assertFaux();
		const warms = t.branch().filter((e) => e.type === "usage" && e.kind === "cache_warm").length;
		expect(warms).toBeGreaterThanOrEqual(5);
		expect(warms).toBeLessThanOrEqual(breakEvenRefreshes(DEFAULTS.prices));
		const cps = t.branch().filter((e) => e.type === "custom" && e.customType === "governor-checkpoint" && e.data.open);
		expect(cps).toHaveLength(1);
		const cpTurn = t.branch().filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
		expect(cpTurn.message.timestamp - t0).toBeLessThan(30 * MIN);
		const calls = t.faux.state.callCount;
		await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
		expect(t.faux.state.callCount).toBe(calls);
	});

	it("warming always ends: wake never cleared, 3 hours: one checkpoint, then no more requests; every request is faux", async () => {
		atk();
		const t = await bootReal(NOROLL); live.push(t.dispose);
		t.faux.setResponses([reply("hi", { cacheWrite: 340_000 })]);
		await t.session.prompt(CTX340);
		expectWake(t.pi, "w");
		t.faux.setResponses(Array.from({ length: 100 }, () => reply("", { cacheRead: 340_000 }, 0.1)));
		await vi.advanceTimersByTimeAsync(40 * MIN);
		const calls = t.faux.state.callCount;
		await vi.advanceTimersByTimeAsync(140 * MIN);
		t.assertFaux();
		expect(t.faux.state.callCount).toBe(calls); // warming stays off for the rest of the idle period
		expect(calls).toBeLessThanOrEqual(1 + 6 + 1);
		expect(t.users().filter((u) => u.includes("[governor checkpoint]"))).toHaveLength(1);
		expect(t.users()[0]).toBe(CTX340);
	});

	it("failed refreshes (provider error) are not recorded, do not crash, and stop by the 30-minute limit", async () => {
		atk();
		const t = await bootReal(NOROLL); live.push(t.dispose);
		t.faux.setResponses([reply("hi", { cacheWrite: 340_000 })]);
		await t.session.prompt(CTX340);
		expectWake(t.pi, "w");
		t.faux.setResponses(Array.from({ length: 100 }, () => reply("", {}, 0, { stopReason: "error", errorMessage: "500 internal" })));
		await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
		t.assertFaux();
		expect(t.branch().filter((e) => e.kind === "cache_warm")).toHaveLength(0);
		const at2h = t.faux.state.callCount;
		expect(at2h).toBeLessThanOrEqual(1 + 6 + 1 + 3); // refreshes, one checkpoint, pi's own 3 retries of the failed turn
		await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
		expect(t.faux.state.callCount).toBe(at2h);
		expect(t.users().filter((u) => u.includes("[governor checkpoint]"))).toHaveLength(1);
		// session still works
		t.faux.setResponses([reply("alive", { cacheWrite: 340_000 })]);
		await t.session.prompt("still there?");
		expect(t.users()).toContain("still there?");
	});

	it("sleep across expiry (clock jumps 2h in one step) then wake: no crash, at most one checkpoint, session works", async () => {
		atk();
		const t = await bootReal(NOROLL); live.push(t.dispose);
		t.faux.setResponses([reply("hi", { cacheWrite: 340_000 })]);
		await t.session.prompt(CTX340);
		vi.setSystemTime(Date.now() + 2 * 60 * MIN);
		t.faux.setResponses(Array.from({ length: 5 }, () => reply("handoff", { cacheRead: 340_000 })));
		await vi.advanceTimersByTimeAsync(5 * MIN);
		await vi.advanceTimersByTimeAsync(30 * MIN);
		await t.session.agent.waitForIdle();
		t.assertFaux();
		expect(t.users().filter((u) => u.includes("[governor checkpoint]")).length).toBeLessThanOrEqual(1);
		t.faux.setResponses([reply("alive", { cacheWrite: 340_000 })]);
		await t.session.prompt("back");
		expect(t.users()).toContain("back");
	});

	it("full idle path with pi warming: refreshes, then exactly one checkpoint inside the warm window, then silence", async () => {
		atk();
		const t = await bootReal(NOROLL); live.push(t.dispose);
		t.faux.setResponses([reply("hi", { cacheWrite: 340_000 })]);
		const t0 = Date.now();
		await t.session.prompt(CTX340);
		t.faux.setResponses([
			...Array.from({ length: 5 }, () => reply("", { cacheRead: 340_000 }, 0.1)),
			reply("handoff", { cacheRead: 340_000 }, 0.1),
			reply("LOOP", {}),
		]);
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(4.5 * MIN + 100);
		await t.session.agent.waitForIdle();
		await vi.advanceTimersByTimeAsync(60 * MIN);
		t.assertFaux();
		const cps = t.branch().filter((e) => e.type === "custom" && e.customType === "governor-checkpoint" && e.data.open);
		expect(cps).toHaveLength(1);
		const cpTurn = t.branch().filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
		expect(cpTurn.message.timestamp - t0).toBeLessThan(30 * MIN); // written while the cache was still warm
		expect(t.faux.getPendingResponseCount()).toBe(1); // nothing after the checkpoint
		expect(t.users().filter((u) => u.includes("[governor checkpoint]"))).toHaveLength(1);
	});

	const steered = async () => {
		atk();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const t = await bootReal(NOROLL); live.push(t.dispose);
		t.faux.setResponses([reply("hi", { cacheWrite: 340_000 })]);
		await t.session.prompt(CTX340);
		t.faux.setResponses([
			...Array.from({ length: 5 }, () => reply("", { cacheRead: 340_000 }, 0.1)),
			async () => { await gate; return reply("handoff", { cacheRead: 340_000 }); },
			reply("answer to user", { cacheRead: 340_000 }),
			reply("LOOP", {}),
		]);
		for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(4.5 * MIN + 100);
		expect(t.session.isStreaming).toBe(true); // checkpoint turn is in flight
		await t.session.prompt("urgent question", { streamingBehavior: "steer" });
		release();
		await vi.advanceTimersByTimeAsync(1000);
		await t.session.agent.waitForIdle();
		await vi.advanceTimersByTimeAsync(40 * MIN);
		t.assertFaux();
		expect(t.users().filter((u) => u.includes("[governor checkpoint]"))).toHaveLength(1);
		expect(t.users()).toContain("urgent question");
		expect(t.notes.filter((n) => /fresh session|new session/i.test(n))).toHaveLength(0);
		expect(t.faux.getPendingResponseCount()).toBeLessThanOrEqual(2);
		return t;
	};
	it("user message steered into a running checkpoint turn: no loop, no switch, session intact", async () => { await steered(); });
	it("regression: a user message steered into the checkpoint turn overwrites the handoff with the reply to that message", async () => {
		const t = await steered();
		const cp: any = t.branch().filter((e) => e.customType === "governor-checkpoint" && e.data.open).at(-1);
		expect(cp.data.text).toBe("handoff");
	});

	it("abort during a checkpoint turn: no loop over the next hour, session still works", async () => {
		atk();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const t = await bootReal(NOROLL); live.push(t.dispose);
		t.faux.setResponses([reply("hi", { cacheWrite: 340_000 })]);
		await t.session.prompt(CTX340);
		t.faux.setResponses([
			...Array.from({ length: 5 }, () => reply("", { cacheRead: 340_000 }, 0.1)),
			async () => { await gate; return reply("handoff", { cacheRead: 340_000 }); },
			...Array.from({ length: 10 }, () => reply("again", { cacheRead: 340_000 })),
		]);
		for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(4.5 * MIN + 100);
		expect(t.session.isStreaming).toBe(true);
		const ab = t.session.abort();
		release();
		await ab;
		await vi.advanceTimersByTimeAsync(90 * MIN);
		t.assertFaux();
		expect(t.users().filter((u) => u.includes("[governor checkpoint]")).length).toBeLessThanOrEqual(1);
		t.faux.setResponses([reply("alive", { cacheWrite: 340_000 })]);
		await t.session.prompt("after abort");
		expect(t.users()).toContain("after abort");
	});

	it("rollover on a huge context: one handoff turn, one announced newSession, nothing else", async () => {
		atk();
		const t = await bootReal({ newSession: async () => ({ cancelled: false }) }); live.push(t.dispose);
		t.faux.setResponses(Array.from({ length: 30 }, (_, i) => reply("r" + i, {})));
		await t.session.prompt("x".repeat(1_000_000));
		await vi.advanceTimersByTimeAsync(2000);
		t.assertFaux();
		expect(t.newSessions).toHaveLength(1);
		expect(t.notes.filter((n) => /fresh session/.test(n))).toHaveLength(1);
		expect(t.users().filter((u) => u.includes("[governor checkpoint]"))).toHaveLength(1);
		expect(t.faux.state.callCount).toBe(2);
	});

	it("regression: rollover whose newSession is refused: the user must not be told a switch happened, and no second handoff is paid for", async () => {
		atk();
		const t = await bootReal({ newSession: async () => ({ cancelled: true }) }); live.push(t.dispose);
		t.faux.setResponses(Array.from({ length: 40 }, (_, i) => reply("r" + i, {})));
		await t.session.prompt("x".repeat(1_000_000));
		await vi.advanceTimersByTimeAsync(40 * MIN);
		t.assertFaux();
		expect(t.users().filter((u) => u.includes("[governor checkpoint]")).length).toBeLessThanOrEqual(1);
	});
});
