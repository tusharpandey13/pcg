// Free dry run: real pi AgentSession, real CacheWarmer, the governor, pi's faux provider and a fake clock.
// No network and no model calls. Prints a timeline of what you would see. Run: npm run demo
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { it, vi } from "vitest";
import governor, { expectWake } from "../src/governor.ts";

// Sonnet 5.5 first-party prices, $/MTok. Usage numbers below are scripted, so the dollar figures are illustrative.
const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const MID = "x".repeat(600_000); // faux counts 4 chars per token: about 150K tokens
const BIG = "x".repeat(960_000); // about 240K tokens, over the 200K rollover cap
const lines: string[] = [];
let t0 = 0;
const at = () => `${String(Math.round((Date.now() - t0) / 60_000)).padStart(3)} min`;
const log = (who: string, text: string) => lines.push(`${at()}  ${who.padEnd(9)} ${text}`);
const reply = (text: string, u: Record<string, number>) =>
	({ ...fauxAssistantMessage(text), usage: { input: 10, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...u } });

async function boot(answer: string) {
	const cwd = mkdtempSync(join(tmpdir(), "gov-demo-"));
	const faux = registerFauxProvider({ models: [{ id: "sonnet-demo", cost, contextWindow: 1_000_000 }] });
	const m = faux.getModel();
	const rt = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false });
	rt.registerProvider(m.provider, { baseUrl: m.baseUrl, apiKey: "k", api: faux.api, models: faux.models.map((x) => ({ id: x.id, name: x.name, api: x.api, reasoning: x.reasoning, input: x.input, cost: x.cost, promptCache: { short: 300 }, contextWindow: x.contextWindow, maxTokens: x.maxTokens, baseUrl: x.baseUrl })) });
	let pi!: ExtensionAPI;
	const watch = (p: ExtensionAPI) => {
		pi = p;
		p.on("cache_warming_decision", (e) => void log("warmer", `refresh? pi says ${e.action} (costs $${e.warmCost.toFixed(3)}, a miss would cost $${e.missCost.toFixed(2)})`));
		p.on("after_provider_response", () => void log("request", "model request sent"));
	};
	const rl = new DefaultResourceLoader({ cwd, agentDir: cwd, extensionFactories: [governor, watch] });
	await rl.reload();
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, modelRuntime: rt, model: rt.getModel(m.provider, m.id)!, resourceLoader: rl,
		sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ cacheWarming: "idle" } as never),
	});
	const noop = () => undefined;
	const ui: any = Object.fromEntries("addAutocompleteProvider confirm custom editor getAllThemes getEditorComponent getEditorText getTheme getToolsExpanded input onTerminalInput pasteToEditor setEditorComponent setEditorText setFooter setHeader setHiddenThinkingLabel setTheme setTitle setToolsExpanded setWidget setWorkingIndicator setWorkingMessage setWorkingVisible".split(" ").map((k) => [k, noop]));
	ui.select = async (title: string, options: string[]) => {
		log("governor", `asks: ${title.replace(/\n/g, " | ")}`);
		options.forEach((o) => log("", `  option: ${o}`));
		log("you", `pick: ${answer}`);
		return options.find((o) => o.startsWith(answer));
	};
	ui.notify = (msg: string) => msg.split("\n").forEach((l, n) => log(n ? "" : "governor", l));
	ui.setStatus = (_key: string, text?: string) => void (text && log("status", text));
	await session.bindExtensions({
		uiContext: ui, mode: "tui",
		onError: (e: any) => void log("ERROR", String(e?.error ?? e?.message ?? JSON.stringify(e)).slice(0, 200)),
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (o?: any) => {
				log("pi", "new session started");
				await o?.withSession?.({ sendUserMessage: async (txt: string) => void log("pi", `new session gets: ${txt.slice(0, 140).replace(/\n/g, " ")}…`) });
				return { cancelled: false };
			},
		} as never,
	});
	return { session, faux, pi };
}

it("dry run", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	t0 = Date.now();

	lines.push("## Scenario 1: you step away for 25 minutes at ~150K tokens, then come back");
	let s = await boot("Continue from checkpoint");
	log("you", "work on the parser (context ~150K tokens)");
	s.faux.setResponses([reply("Parser refactor half done.", { cacheWrite: 150_000 }), reply("Handoff: lexer split done; next: wire error recovery in parser.ts.", { cacheRead: 150_000 })]);
	await s.session.prompt(MID);
	await vi.advanceTimersByTimeAsync(4.5 * 60_000 + 50);
	await vi.advanceTimersByTimeAsync(1000);
	await s.session.agent.waitForIdle();
	await vi.advanceTimersByTimeAsync(20 * 60_000);
	s.faux.setResponses([reply("Wiring error recovery now.", { cacheWrite: 4_000 })]);
	log("you", "type: carry on with error recovery");
	await s.session.prompt("carry on with error recovery");
	await vi.advanceTimersByTimeAsync(2000);
	await s.session.prompt("/governor");
	s.session.dispose(); s.faux.unregister();

	lines.push("", "## Scenario 2: a worker is still running while you wait");
	t0 = Date.now();
	s = await boot("Resume full context");
	s.faux.setResponses([reply("Started a worker on the tests.", { cacheWrite: 150_000 })]);
	log("you", "start a worker, then wait (context ~150K)");
	await s.session.prompt(MID);
	expectWake(s.pi, "worker-1");
	log("governor", "a worker result is expected, so keep warm");
	s.faux.setResponses(Array(4).fill(reply("", { cacheRead: 150_000 })));
	for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(4.5 * 60_000 + 50);
	expectWake(s.pi, "worker-1", false);
	s.faux.setResponses([reply("Worker done; tests pass.", { cacheRead: 150_000 })]);
	log("worker", "reports back at ~14 min; cache still warm");
	await s.session.prompt("worker-1 finished: tests pass");
	await s.session.prompt("/governor");
	s.session.dispose(); s.faux.unregister();

	lines.push("", "## Scenario 3: the session grows past the 200K rollover cap");
	t0 = Date.now();
	s = await boot("Resume full context");
	s.faux.setResponses([reply("Big refactor step done.", { cacheWrite: 240_000 }), reply("Handoff: refactor at step 3 of 5; next: migrate call sites in api/.", { cacheRead: 240_000 })]);
	log("you", "a long working turn (context ~240K)");
	await s.session.prompt(BIG);
	await vi.advanceTimersByTimeAsync(2000);
	await s.session.agent.waitForIdle();
	await vi.advanceTimersByTimeAsync(2000);
	s.session.dispose(); s.faux.unregister();

	vi.useRealTimers();
	const out = lines.join("\n");
	writeFileSync(join(__dirname, "dry-run-output.txt"), out + "\n");
	console.log(out);
}, 60_000);
