# E2E rubric: real pi in Paseo

Live checks for the behaviour unit tests can only fake. Scope so far: continue from the checkpoint in place (DESIGN.md sections 3 to 5). Each case is run against a real pi agent started by Paseo, on a cheap model (DeepSeek on the owner's Mac), and needs the owner's approval because it spends tokens.

## Setup (every case)

- **Throwaway project.** A fresh git repo under `/tmp/pcg-e2e-<stamp>/proj`. It holds 3 committed files plus 3 uncommitted ones, so `git status --porcelain` is non-empty.
- **Scratch agent dir.** The owner's `~/.pi` is never edited. Some settings are global-only in pi (`cacheWarming`, `modelOverrides`, `defaultProjectTrust`), so the agent runs with `PI_CODING_AGENT_DIR` pointing at a scratch dir under the run folder. That dir loads pcg from the local clone, so the commit that is checked out is the one under test; record it in the run log. Paseo drives pi over RPC, which can't show the trust prompt, so the scratch dir sets `defaultProjectTrust: "always"`. Set `compaction.keepRecentTokens` below the test context size (500, for example): pi refuses to compact a context smaller than that value.
- **The two guards.** Copy pi's example extensions `dirty-repo-guard.ts` and `confirm-destructive.ts` from the installed pi release (`examples/extensions/`) into `proj/.pi/extensions/`. This is the work Mac's setup.
- **Short cache lifetime.** A `modelOverrides` entry sets `promptCache.short` to 60 s for the test model, so expiry takes about a minute instead of 5.
- **Test prices.** `governor.prices` (or a `modelOverrides` cost) is set so `checkpointPays` holds for a context of a few thousand tokens. A small `rolloverTokens` drives the rollover case. Record the exact values in the log.
- **Answering dialogs.** Every UI question pi raises reaches Paseo as a pending permission or question. The runner answers them through Paseo (`list_pending_permissions` and `respond_to_permission`) and logs each one verbatim: title, options and the choice made. Answering anything other than pcg's own card counts as a finding.
- **Evidence.** From the session `.jsonl` file (pi's session dir for the project): entry types, `compaction` entries with `summary` and `firstKeptEntryId`, assistant `usage` per request, and `governor-*` custom entries. From Paseo: the agent timeline. History lines from pcg, when `history` is on.

## Cases

| Id | Path | Steps | Pass when |
|---|---|---|---|
| E1 | Setup sanity | Start the pi agent in `proj`, then send a short prompt. | The reply arrives. `/governor` shows pcg loaded. The project trust prompt, if shown, is the only dialog. Both guard extensions are loaded: `/new` in a second scratch agent shows both dialogs, which proves the trap is real. Cancel them. |
| E2 | Checkpoint while warm | Build up context with 3 to 5 turns, for example asking the model to read and summarise the files. Then go idle. | Within about 2 TTLs, a pcg checkpoint turn runs on its own: a user-invisible or marked governor turn, a handoff reply, and a `governor-checkpoint` entry with `open: true`. No dialog. |
| E3 | Return: continue in place | After E2, wait until the cache has expired (more than 60 s after the last request), then send a prompt containing `ZQX-RETURN`. | Exactly one dialog appears: pcg's card, `Cache expired N min ago`, whose continue option says "in this session". Choose "Continue from checkpoint". Then all of these hold: (a) no `You have N uncommitted file(s)` dialog and no `Clear session?` dialog; (b) the session file is unchanged, so no new session file is created; (c) one new `compaction` entry whose summary contains the handoff text, with `firstKeptEntryId` set to the newest entry before it; (d) no model request between the choice and the compaction, so the request count rises only with the reply to `ZQX-RETURN`; (e) the next request's input tokens are far below the pre-compaction context (≤ 40%); (f) the model replies to `ZQX-RETURN`. |
| E4 | Return: resume full | Repeat E2 and E3 in a fresh agent, and choose "Resume full context". | One dialog only. No compaction entry. The reply arrives with the full context; its input tokens are about the pre-gap context. |
| E5 | Don't ask again | In the E3 agent, build context again until a second checkpoint, let it expire, then choose "Continue from checkpoint (don't ask again)". Do a third round. | The second round behaves like E3. The third round shows no dialog at all and continues in place on its own. |
| E6 | Rollover in place | A fresh agent with `rolloverTokens` just above the setup context. Send turns until the context passes it. | pcg tells you about the rollover ("Context passed ..."). There is a checkpoint turn, then a compaction entry carrying the handoff, then `Continue where you left off.` is sent in the same session. No guard dialog. |
| E7 | Fallback, too small to compact | A fresh agent with exactly one large user message as its whole history, made to checkpoint and then return, if this is reachable. | pi refuses to compact ("Nothing to compact"), and pcg falls back to a new session. In that one case the two guard dialogs are expected; record them. If the state can't be reached, mark the case "not reachable" and say why. |
| E8 | No deadlock | Across E3, E5 and E6. | Each choice completes within 30 s. The agent goes back to idle, and the Paseo UI stays responsive. |
| E9 | Paseo rendering | Across E3 and E6. | Note how the Paseo timeline shows the compaction and pcg's notices, with a screenshot or the timeline text. No pass or fail: this is reported to the owner. |

## Result format

`/tmp/pcg-e2e-<stamp>/RESULTS.md` holds:
- the commit under test and the model;
- one row per case with PASS, FAIL or NOT-RUN, plus its evidence (entry ids, token counts, the dialogs seen);
- the total spend.

A FAIL includes the minimal reproduction.
