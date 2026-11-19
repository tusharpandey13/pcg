# Chaos rubric: continue in place

Faults injected around the in-place continue. The offline chaos suite (`test/chaos.test.ts`, faux model, seeded) covers the C-cases marked "offline". The ones marked "live" are run on a real pi in Paseo, with the setup from `E2E-RUBRIC.md`. The pass bar for every case: no lost user message, no message sent twice, no stray dialog, no model call for the summary, and pcg's state consistent afterwards (a checkpoint either consumed or still open, never half of each).

| Id | Fault | Where | Pass when |
|---|---|---|---|
| C1 | A second user message arrives while the card is open | live + offline | It is held and delivered once after the choice, in order, in the same session. |
| C2 | A user message arrives during the in-place compaction | live | It is delivered once, after the compaction. It is never part of the summary and never lost. |
| C3 | A foreign compaction (the owner's `/compact`, or pi's threshold or overflow compaction) runs while pcg's flag could be set | offline | pcg's summary is not used for it. pi summarises normally, and pcg's flag is cleared after its own compaction ends. |
| C4 | `ctx.compact` raises an error or reports `onError` | offline | Falls back to `newSession`, then to staying in the session. The checkpoint is reopened on a full failure. |
| C5 | Compaction cancelled by another extension's `session_before_compact` `{cancel: true}` | offline + live (a project extension that cancels) | Same as C4. The owner's message still arrives. |
| C6 | The owner dismisses the card | live | Treated as resume (DESIGN section 4). No compaction, and the message is sent once. |
| C7 | Abort (Esc or Paseo stop) right after choosing continue | live | No hang. Either the compaction finished and the message was sent, or the compaction did not happen and the message was not lost: it is sent or left in the input. The agent ends idle. |
| C8 | Paseo daemon or pi process restart between the checkpoint and the return | live | After the restart, a return either shows the card (the checkpoint is restored from the `governor-checkpoint` entry) or no card. No crash and no double send. |
| C9 | The last entry before compaction is a custom or non-message entry, such as `governor-checkpoint` | offline | `firstKeptEntryId` points at a valid entry. The context after compaction is valid: no orphan tool result, no empty request. |
| C10 | Two returns in quick succession (rapid double send) | live | One card, one compaction. The second message follows the choice once. |
| C11 | Repeated cycles: checkpoint, return, continue, 3 times in one session | live | Each cycle adds exactly one compaction entry. The context stays small. Costs in `/governor` add up, with no rising request count from summaries. |
| C12 | Randomised interleavings (seeds, `CHAOS_RUNS`) | offline | The existing invariants hold: model calls equal assistant turns, zero `session_before_switch` events, and zero `newSession` calls on the success path. |

Live C-cases are run after E1 to E9 pass, and only those the runner can stage reliably. Each one not run is listed with the reason.
