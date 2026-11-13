// Real pi AgentSession + real CacheWarmer + pi's faux provider + fake clock. No network, no cost.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import governor, { buildReport, DEFAULTS, expectWake } from "../src/governor.ts";

const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const reply = (text: string, u: { cacheRead?: number; cacheWrite?: number }, total = 0) =>
	({ ...fauxAssistantMessage(text), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }, ...u } });
// faux estimates usage from prompt text (4 chars per token), so a 150K-token context needs a long prompt.
const BIG = "x".repeat(600_000);
const cleanups: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); while (cleanups.length) cleanups.pop()!(); });

async function boot(extra: ((pi: ExtensionAPI) => void)[] = [], over: { warming?: "off" | "idle"; governor?: Record<string, unknown> } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "gov-int-"));
	const faux = registerFauxProvider({ models: [{ id: "f", cost, contextWindow: 1_000_000 }] });
	const model = { ...faux.getModel(), promptCache: { short: 300 } };
	const rt = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false });
	rt.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: "k", api: faux.api, models: faux.models.map((m) => ({ id: m.id, name: m.name, api: m.api, reasoning: m.reasoning, input: m.input, cost: m.cost, promptCache: { short: 300 }, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl })) });
	const pis: ExtensionAPI[] = [];
	const rl = new DefaultResourceLoader({ cwd, agentDir: cwd, extensionFactories: [governor, (pi) => void pis.push(pi), ...extra] });
	await rl.reload();
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, modelRuntime: rt, model: rt.getModel(model.provider, model.id)!, resourceLoader: rl,
		sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ cacheWarming: over.warming ?? "idle", governor: { prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }, ...over.governor } } as never),
	});
	await session.bindExtensions({});
	cleanups.push(() => { session.dispose(); faux.unregister(); });
	return { session, faux, pi: pis[0] };
}
const branch = (s: Awaited<ReturnType<typeof boot>>["session"]) => s.sessionManager.getBranch() as never[];
const userTexts = (s: Awaited<ReturnType<typeof boot>>["session"]) =>
	s.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("")));

describe("with the real warmer", () => {
	it("an expected wake overrides pi's stop decision; refreshes are recorded and reported", async () => {
		const responses: number[] = [];
		const { session, faux, pi } = await boot([(p) => p.on("after_provider_response", (e) => void responses.push(e.status))]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		faux.setResponses([reply("hi", { cacheWrite: 150_000 })]);
		await session.prompt(BIG);
		expectWake(pi, "worker-1");
		faux.setResponses([reply("", { cacheRead: 150_000 }, 0.0456), reply("", { cacheRead: 150_000 }, 0.0456)]);
		await vi.advanceTimersByTimeAsync(4.5 * 60_000 + 50);
		await vi.advanceTimersByTimeAsync(4.5 * 60_000 + 50);
		const warms = branch(session).filter((e: any) => e.type === "usage" && e.kind === "cache_warm");
		expect(responses).toHaveLength(3); // refreshes fire after_provider_response too: this is how a 401 is seen
		expect(warms).toHaveLength(2); // pi alone would have stopped: 0.15 * $0.52 - $0.05 < $0.05
		expect(buildReport(branch(session), DEFAULTS, 300_000)).toMatchObject({ refreshes: 2 });
		expect(userTexts(session)).toEqual([BIG]); // refreshes stay out of the conversation
	});

	it("without a wake, the return curve keeps warming small refreshes, then the governor checkpoints on the last slot, once", async () => {
		const { session, faux } = await boot();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		faux.setResponses([reply("hi", { cacheWrite: 150_000 })]);
		await session.prompt(BIG);
		// pi alone would stop (0.15 * $0.52 - $0.05 < $0.05); the curve warms: 0.4 * $0.52 > $0.05.
		faux.setResponses(Array.from({ length: 12 }, () => reply("handoff written", { cacheRead: 150_000 }, 0.0456)));
		await vi.advanceTimersByTimeAsync(4.5 * 60_000 + 50);
		await session.agent.waitForIdle();
		expect(branch(session).filter((e: any) => e.type === "usage" && e.kind === "cache_warm")).toHaveLength(1);
		expect(userTexts(session)).toHaveLength(1);
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(4.5 * 60_000);
		await session.agent.waitForIdle();
		const users = userTexts(session);
		expect(users).toHaveLength(2);
		expect(users[1]).toContain("[governor checkpoint]");
		expect(branch(session).filter((e: any) => e.type === "custom" && e.customType === "governor-checkpoint" && e.data.open)).toHaveLength(1);
		const pending = faux.getPendingResponseCount();
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(userTexts(session)).toHaveLength(2); // no loop, no further request
		expect(faux.getPendingResponseCount()).toBe(pending);
	});

	it("sendUserMessage('/cmd', { expandPromptTemplates }) dispatches an extension command (used for rollover/continue)", async () => {
		const ran = vi.fn();
		const { pi } = await boot([(p) => p.registerCommand("probe", { description: "p", handler: async () => void ran() })]);
		pi.sendUserMessage("/probe", { expandPromptTemplates: true });
		await vi.waitFor(() => expect(ran).toHaveBeenCalled());
	});

	it("the brief reaches the model's context after the prompt, and estimate_cost is callable and recorded", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "gov-int-agent-"));
		process.env.PI_CODING_AGENT_DIR = agentDir; // never the real ~/.pi
		const { session, faux } = await boot();
		faux.setResponses([reply("done", { cacheWrite: 1000 }, 0.2)]);
		await session.prompt("fix the flaky parser test");
		await session.agent.waitForIdle();
		let seen: any[] = [];
		faux.setResponses([
			(context) => { seen = context.messages as any[]; return { ...fauxAssistantMessage([fauxToolCall("estimate_cost", { steps: 4, usd: 0.5, reason: "small fix" })], { stopReason: "toolUse" }), usage: reply("", { cacheRead: 1000 }, 0.1).usage }; },
			reply("ok", { cacheRead: 1100 }, 0.1),
		]);
		await session.prompt("fix the flaky parser test again");
		await session.agent.waitForIdle();
		const text = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join(""));
		const i = seen.findIndex((m) => text(m) === "fix the flaky parser test again");
		expect(text(seen[i + 1])).toMatch(/^\[governor: cost estimates\] .*Similar past tasks: \$0\.\d+, 1 steps \("fix the flaky parser test"\)/);
		expect(seen[i + 1].role).toBe("user");
		expect(branch(session).some((e: any) => e.type === "custom_message" && e.customType === "governor-brief")).toBe(true); // persisted
		const result = session.messages.find((m: any) => m.role === "toolResult") as any;
		expect(text(result)).toMatch(/^Recorded\./);
		const recs = readFileSync(join(agentDir, "governor-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(recs).toHaveLength(2);
		expect(recs[1]).toMatchObject({ requests: 2, tools: ["estimate_cost"], estimate: { usd: 0.5, steps: 4 } });
	});
	it("idle checkpoint: with pi's warmer off, the governor checkpoints in the warm window; a later return continues in a new session", async () => {
		const { session, faux } = await boot([], { warming: "off", governor: { autoContinue: true } });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		faux.setResponses([reply("hi", { cacheWrite: 150_000 })]);
		await session.prompt(BIG);
		await session.agent.waitForIdle();
		faux.setResponses([reply("handoff: state X, next Y", { cacheRead: 150_000 }, 0.05)]);
		await vi.advanceTimersByTimeAsync(4.6 * 60_000); // before the 5-minute lifetime ends
		await session.agent.waitForIdle();
		const users = userTexts(session);
		expect(users).toHaveLength(2);
		expect(users[1]).toContain("[governor checkpoint]");
		expect(branch(session).filter((e: any) => e.type === "custom" && e.customType === "governor-checkpoint" && e.data.open)).toHaveLength(1);
		expect(branch(session).some((e: any) => e.type === "custom" && e.customType === "governor-log" && /idle checkpoint/.test(e.data.msg))).toBe(true);
		// Return after the renewed window has expired too: the message continues in a new session from the handoff.
		const before = faux.getPendingResponseCount();
		await vi.advanceTimersByTimeAsync(12 * 60_000);
		await session.prompt("next please");
		await vi.advanceTimersByTimeAsync(50);
		const types = branch(session).map((e: any) => e.customType);
		expect(types).toContain("governor-continue"); // switched without a question
		expect(userTexts(session)).toHaveLength(2); // the old session got neither the message nor a rewrite
		expect(before).toBe(0);
	});

	it("idle checkpoint: stands down when pi's warmer is running (its hook owns the checkpoint)", async () => {
		const { session, faux } = await boot();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		faux.setResponses([reply("hi", { cacheWrite: 150_000 })]);
		await session.prompt(BIG);
		await session.agent.waitForIdle();
		faux.setResponses([reply("", { cacheRead: 150_000 }, 0.0456)]);
		await vi.advanceTimersByTimeAsync(4.7 * 60_000);
		await session.agent.waitForIdle();
		expect(userTexts(session)).toEqual([BIG]); // a refresh, not a checkpoint turn
		expect(branch(session).some((e: any) => e.type === "custom" && e.customType === "governor-log" && /idle checkpoint/.test(e.data.msg))).toBe(false);
	});

});
