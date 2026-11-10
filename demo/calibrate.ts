// Replay the estimator over a recorded pi session: node demo/calibrate.ts <session.jsonl>. Offline.
import { readFileSync } from "node:fs";
import { DEFAULTS, estimateRequest, ratioStats } from "../src/governor.ts";

// $/MTok from the recorded cost breakdown, so the replay uses the model's own prices; defaults where a kind had no tokens.
const unitPrices = (u: any) => {
	const per = (k: "input" | "cacheWrite" | "cacheRead" | "output") => (u[k] > 0 && Number.isFinite(u.cost?.[k]) ? (u.cost[k] / u[k]) * 1e6 : DEFAULTS.prices[k]);
	return { input: per("input"), cacheWrite: u.cacheWrite > 0 ? per("cacheWrite") : 0, cacheRead: per("cacheRead"), output: per("output") };
};

const file = process.argv[2];
if (!file) throw new Error("usage: npm run calibrate -- <session.jsonl>");
const TTL = 300_000;
const ratios: number[] = [];
let prev: { tokens: number; ts: number } | undefined;
const outputs: number[] = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
	let m: any;
	try { m = JSON.parse(line)?.message; } catch { continue; }
	if (m?.role !== "assistant" || !m.usage) continue;
	const u = m.usage;
	const tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	if (prev) {
		// The recorded size stands in for the payload, so this measures the price rule, not the chars/4 guess.
		const est = estimateRequest({ priorTokens: prev.tokens, warm: m.timestamp - prev.ts < TTL, newTokens: Math.max(0, tokens - prev.tokens), recentOutputs: outputs.slice(-10), prices: unitPrices(u) });
		if (est && u.cost?.total > 0) ratios.push(est.usd / u.cost.total);
	}
	prev = { tokens, ts: m.timestamp };
	outputs.push(u.output);
}
const s = ratioStats(ratios);
console.log(s ? `${s.n} requests  predicted/actual median ${s.median.toFixed(2)}x  worst ${s.worst.toFixed(2)}x` : "no comparable requests");
