import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, custom, setup, T0 } from "./helpers.ts";

const MIN = 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 28 * MIN); });
afterEach(() => vi.useRealTimers());
const open = () => custom("governor-checkpoint", { open: true, text: "HANDOFF", tokens: 342_000, awt: false });
const input = { source: "interactive", text: "next please" };
const CONTINUE = "Continue from checkpoint  ~$0.01";
const ret = async (opts: Parameters<typeof setup>[0]) => {
	const g = setup({ branch: [assistant(T0, 342_000), open()], select: CONTINUE, ...opts });
	g.fire("session_start");
	await g.fire("input", input);
	await vi.advanceTimersByTimeAsync(1);
	await g.commands.get("governor-continue")!("", g.ctx);
	return g;
};
/** A guard like pi's dirty-repo-guard and confirm-destructive: it would prompt on any session switch. */
const withGuard = (g: ReturnType<typeof setup>) => {
	const asked = vi.fn();
	g.ctx.newSession = vi.fn(async (o: any) => { asked(); await o.withSession?.({ sendUserMessage: async () => {} }); return { cancelled: false }; });
	return { asked, newSession: g.ctx.newSession };
};

describe("continue in place", () => {
	it("compacts with the checkpoint as the summary (no model call), then sends the message", async () => {
		const g = await ret({ compact: "ok" });
		expect(g.compact).toHaveBeenCalledOnce();
		expect(g.compactions).toHaveLength(1);
		const c = g.compactions[0];
		expect(c.summary).toContain("HANDOFF");
		expect(c.summary).toContain("/s/old.jsonl");
		expect(c).toMatchObject({ tokensBefore: 342_000 });
		expect(c.firstKeptEntryId).toBe(g.branch.find((e) => e.type === "custom" && e.data?.open === false)!.id);
		expect(g.newSession).not.toHaveBeenCalled();
		expect(g.sent.at(-1)).toEqual({ text: "next please", opts: undefined });
		expect(g.entries.some((e) => e.type === "governor-continue")).toBe(true);
	});
	it("a pi-style model call is never needed: the hook always supplies the summary", async () => {
		const g = await ret({ compact: "ok" });
		expect(g.compact.mock.calls[0][0].onError).toBeTypeOf("function");
		expect(g.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/failed/), "warning");
	});
	it("leaves foreign compactions untouched, before and after its own", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: CONTINUE, compact: "ok" });
		g.fire("session_start");
		const foreign = { type: "session_before_compact", reason: "manual", preparation: { tokensBefore: 1 }, branchEntries: [{ id: "x" }] };
		expect(await g.fire("session_before_compact", foreign)).toBeUndefined();
		await g.fire("input", input);
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(g.compactions).toHaveLength(1);
		expect(await g.fire("session_before_compact", foreign)).toBeUndefined();
		expect(await g.fire("session_before_compact", { ...foreign, reason: "threshold" })).toBeUndefined();
	});
	it("does not supply a summary to an automatic compaction that happens during its own", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: CONTINUE });
		g.fire("session_start");
		let foreign: unknown = "unset";
		g.ctx.compact = (o: any) => void (async () => {
			// pi's overflow recovery fires while ours is pending: not ours.
			foreign = await g.fire("session_before_compact", { reason: "overflow", preparation: { tokensBefore: 1 }, branchEntries: [{ id: "x" }] });
			o.onError(new Error("done"));
		})();
		await g.fire("input", input);
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(foreign).toBeUndefined();
	});
	it("falls back to a new session when compaction errors", async () => {
		const g = await ret({ compact: "error" });
		expect(g.compact).toHaveBeenCalledOnce();
		expect(g.newSession).toHaveBeenCalledOnce();
		expect(g.sent.at(-1)!.text).toMatch(/^\[new\] .*HANDOFF.*next please$/s);
		expect(g.entries.some((e) => e.type === "governor-continue")).toBe(true);
	});
	it("falls back to a new session when compact() throws or is unavailable", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: CONTINUE, compact: "ok" });
		g.ctx.compact = () => { throw new Error("boom"); };
		g.fire("session_start");
		await g.fire("input", input);
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(g.newSession).toHaveBeenCalledOnce();
	});
	it("with both failing, stays in the session and delivers the message", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: CONTINUE, compact: "error" });
		g.ctx.newSession = vi.fn(async () => ({ cancelled: true }));
		g.fire("session_start");
		await g.fire("input", input);
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(g.sent.at(-1)!.text).toBe("next please");
		expect(g.entries.at(-1)!.data).toMatchObject({ open: true, reopen: true });
	});
	it("never fires a session switch, so switch guards stay quiet", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: CONTINUE, compact: "ok" });
		const guard = withGuard(g);
		g.fire("session_start");
		await g.fire("input", input);
		await vi.advanceTimersByTimeAsync(1);
		await g.commands.get("governor-continue")!("", g.ctx);
		expect(guard.asked).not.toHaveBeenCalled();
		expect(g.sent.at(-1)!.text).toBe("next please");
	});
	it("rollover is in place too, and sends 'Continue where you left off.'", async () => {
		const g = setup({ branch: [assistant(T0, 250_000), open()], compact: "ok" });
		const guard = withGuard(g);
		g.fire("session_start");
		await g.commands.get("governor-rollover")!("", g.ctx);
		expect(g.compactions[0].summary).toContain("HANDOFF");
		expect(guard.asked).not.toHaveBeenCalled();
		expect(g.sent.at(-1)!.text).toBe("Continue where you left off.");
		expect(g.entries.at(-1)).toEqual({ type: "governor-checkpoint", data: { open: false } });
	});
	it("the return card says the continue happens in this session", async () => {
		const g = setup({ branch: [assistant(T0, 342_000), open()], select: CONTINUE, compact: "ok" });
		g.fire("session_start");
		await g.fire("input", input);
		expect(g.select.mock.calls[0][1][1]).toContain("in this session");
	});
});
