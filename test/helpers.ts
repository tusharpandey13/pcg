import { vi } from "vitest";
import governor from "../src/governor.ts";

/** Tests pin their own prices so their expected dollar figures do not depend on the shipped defaults. */
export const TEST_SETTINGS = { governor: { prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } } };
export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
export const usage = (o: Partial<Record<"input" | "cacheRead" | "cacheWrite", number>> = {}, cost = 0) => ({
	input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }, ...o,
});
let n = 0;
export const assistant = (ts: number, tokens: number, text = "ok", extra: any = {}) => ({
	type: "message", id: `e${n++}`, parentId: null, timestamp: new Date(ts).toISOString(),
	message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts, stopReason: "stop", usage: usage({ cacheRead: tokens }), ...extra },
});
export const warm = (ts: number, cost = 0.05) => ({
	type: "usage", kind: "cache_warm", id: `e${n++}`, parentId: null, timestamp: new Date(ts).toISOString(), usage: usage({ cacheRead: 1 }, cost),
});
export const custom = (customType: string, data: unknown, ts = T0) => ({ type: "custom", customType, data, id: `e${n++}`, parentId: null, timestamp: new Date(ts).toISOString() });

/** Minimal pi + ctx mocks: enough to drive the extension's handlers by hand. */
export function setup(opts: { settings?: any; branch?: any[]; hasUI?: boolean; cwd?: string; select?: string | undefined; confirm?: boolean } = {}) {
	const handlers = new Map<string, (e: any, c: any) => any>();
	const commands = new Map<string, (a: string, c: any) => any>();
	const tools = new Map<string, any>();
	const bus = new Map<string, ((d: unknown) => void)[]>();
	const sent: { text: string; opts?: any }[] = [];
	const entries: { type: string; data: any }[] = [];
	const branch = opts.branch ?? [];
	const newSession = vi.fn(async (o: any) => { await o.withSession?.({ sendUserMessage: async (t: string) => void sent.push({ text: `[new] ${t}` }) }); return { cancelled: false }; });
	const select = vi.fn(async (_t: string, _o: string[]) => opts.select);
	const confirm = vi.fn(async (_t: string, _m: string) => opts.confirm ?? true);
	const setEditorText = vi.fn();
	const ui = { setStatus: vi.fn(), notify: vi.fn(), select, confirm, setEditorText };
	const ctx: any = {
		ui, hasUI: opts.hasUI ?? true, cwd: opts.cwd ?? "/nonexistent", model: { provider: "p", id: "m", promptCache: { short: 300 } },
		isIdle: () => true, newSession,
		sessionManager: { getBranch: () => [...branch], getSessionFile: () => "/s/old.jsonl" },
	};
	const pi: any = {
		on: (ev: string, h: any) => void handlers.set(ev, h),
		registerTool: (t: any) => void tools.set(t.name, t),
		registerCommand: (n: string, c: any) => void commands.set(n, c.handler),
		events: { emit: (c: string, d: unknown) => bus.get(c)?.forEach((h) => h(d)), on: (c: string, h: any) => void bus.set(c, [...(bus.get(c) ?? []), h]) },
		sendUserMessage: (text: string, o?: any) => void sent.push({ text, opts: o }),
		appendEntry: (type: string, data: any) => { entries.push({ type, data }); branch.push(custom(type, data)); },
		getSettings: () => opts.settings ?? TEST_SETTINGS,
	};
	governor(pi);
	const fire = (ev: string, e: any = {}) => handlers.get(ev)!(e, ctx);
	return { pi, ctx, fire, commands, tools, sent, entries, branch, ui, select, confirm, setEditorText, newSession };
}
