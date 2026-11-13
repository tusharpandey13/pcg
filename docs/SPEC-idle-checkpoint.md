# Spec: idle checkpoint and automatic return

Status: built (see `test/idle.test.ts` and `test/integration.test.ts`). Contract for `DESIGN.md` features 3 and 4 when pi's warmer does not run, or nobody can answer a question.

## 1. Problem

Measured on the maintainer's sessions, which run in a host app (Paseo) that drives pi over RPC:

- 42 requests paid a full cache rewrite (cold cache, 27K to 224K tokens). 41 of them had **no cache refresh in the idle gap before them**. Pi's idle warmer did not run, or ended, in those sessions.
- Every governor feature that protects a return (checkpoint, return question, rollover) is entered from the `cache_warming_decision` hook, which only fires while the warmer runs. No refresh means no checkpoint, no checkpoint means no choice on return, so each return rewrote the whole context.
- The host does surface `ctx.ui.select` and `confirm` (RPC mode has `hasUI: true`; the host shows them as a question card). It is therefore not "no UI". The cost is attention: the user must answer before the prompt is sent.
- A session switch from an extension (`ctx.newSession`) works in RPC mode: a new session file is opened and events continue on the same stream.

Rewrites are about a third of all spend on these sessions, and the avoidable ones are those after a long gap.

## 2. Goals and non-goals

Goals

1. A checkpoint exists before the cache expires, whether or not pi's warmer runs.
2. On return after expiry, the user can get the cheap path without answering a question (opt-in).
3. Nothing is silent: every automatic switch is announced, logged and carries the saved cost.
4. Every skipped protection leaves evidence in the session log, so the next failure can be diagnosed.

Non-goals: finding why the warmer does not run (the log from goal 4 will say), changing the model or region, any model call outside the warm session.

## 3. Dev spec

### 3.1 Settings (`governor` block)

| Setting | Default | Meaning |
|---|---|---|
| `idleCheckpoint` | `true` | Take the checkpoint from the governor's own timer when pi's warmer makes no decision |
| `autoContinue` | `false` | On return after expiry with a checkpoint, continue from it without asking when it saves at least $0.05 |

Both are read with the existing `loadConfig` rules (a wrong type falls back to the default). `askOnReturn` is unchanged. `autoContinue` takes precedence over it when its saving condition holds; otherwise `askOnReturn` applies as before.

Measured reason for each: `idleCheckpoint` fixes 41 of 42 unprotected rewrites; `autoContinue` removes the question that costs a round trip of attention on every return, and is needed where the user is not watching the session.

### 3.2 Idle checkpoint watchdog

State: `idleTimer`, `decidedSinceSettle` (boolean).

- Armed in `agent_settled` (not a checkpoint turn, not aborted), when `idleCheckpoint` is on, no checkpoint is open, none was attempted this idle period, auth is not expired, no wake is pending, and `checkpointPays(last.tokens)` holds (same rule as feature 3). Delay: `0.92 * ttl`.
  - The delay is after pi's first warming decision (`0.9 * ttl`) so that, when the warmer runs, its hook owns the checkpoint and the watchdog stands down. It is before expiry with 24 s of slack at a 5-minute lifetime.
- `decidedSinceSettle` is cleared at `agent_settled` and set in the `cache_warming_decision` hook.
- On fire (inside `guard`): do nothing if `decidedSinceSettle`, the phase is not `idle`, the context is not idle, a checkpoint exists or was attempted, or the last request is older than `ttl` (the cache is already cold, a checkpoint would rewrite it). Otherwise log `governor-log` ("idle checkpoint: no warming decision since the run settled") and call `startCheckpoint(ctx, false)`.
- Cleared (`clearTimeout`) at `agent_start`, `input` from a user, `session_start` and when the extension logs an auth stop. The timer is `unref`'d.
- The checkpoint turn reads the cached context, so it also renews the cache for another lifetime.

### 3.3 Automatic return

In the `input` hook, after the existing expiry test and with a checkpoint open:

```
saved = resumeCost - continueCost
if no remembered choice and cfg.autoContinue and saved >= 0.05:
    choice = continue; note = "Cache expired N min ago; continuing from the checkpoint in a new session (~$A instead of ~$B)."
```

- No UI is needed, so the path also works in print/json mode.
- A remembered "resume" wins (the memory lasts until the next `session_start`, which also reloads the settings, so the two cannot be combined in one session and need no test).
- The note is shown with `ui.notify` and recorded as a `governor-log` entry. The seed message keeps its existing opening line, which names the previous session file.
- The existing `freshSession` failure path is unchanged: a failed switch reopens the checkpoint, tells the user and sends the message to the current session.
- The prompt gate (`confirmAbove`) is skipped for the same input, as it is for the question, because the cold-cache estimate it would show no longer applies.

### 3.4 Evidence

New `governor-log` entries, at most one per idle period each:

- Cache expired and no checkpoint existed: `cache expired with no checkpoint (N tokens, idle M min, warm refreshes K)`.
- The watchdog stood down, and why.

`/governor` shows the two flags in its config line; the counts come from the log entries.

### 3.5 Invariants (all existing ones stay)

1. At most one checkpoint attempt per idle period, the watchdog and the warmer hook share `attempted`.
2. A checkpoint is a turn in the current session; the watchdog never makes a separate model request.
3. The user's message is never lost: the auto path sends it as the seed, and every failure delivers it to the current session.
4. No handler throws into pi; the timer callback runs inside `guard`.
5. No test touches the network.

## 4. Test spec

Unit (mocks from `test/helpers.ts`, fake clock)

| # | Case | Expect |
|---|---|---|
| U1 | Settle with a 100K context, no warming decision, advance `0.92 * ttl` | One checkpoint prompt sent, one `governor-log` |
| U2 | Same, but a `cache_warming_decision` fires first | Watchdog sends nothing; the hook's checkpoint rules apply |
| U3 | Context under the pay threshold | No timer armed |
| U4 | `idleCheckpoint: false` | No timer armed |
| U5 | User input before the timer | Timer cleared, nothing sent |
| U6 | Run starts before the timer | Timer cleared |
| U7 | Timer fires after the cache already expired (clock jump) | Nothing sent |
| U8 | Checkpoint already open, or already attempted | Nothing sent |
| U9 | `autoContinue`, checkpoint open, expired, saving over $0.05 | `newSession` called, no `select`, note shown, message in seed |
| U10 | `autoContinue` with a saving under $0.05 | Falls back to ask or resume |
| U12 | `autoContinue` with no UI | Still switches |
| U13 | `newSession` refuses | Message to the current session, checkpoint reopened |
| U14 | Cache warm (not expired) with a checkpoint | Nothing changes |
| U15 | Expired, no checkpoint | Resumes, one evidence log entry |
| U16 | `loadConfig` with wrong types | Defaults |

Chaos (existing suite): add `idleCheckpoint` and `autoContinue` to the randomised config; invariants 1 to 5 must hold and no message may be lost.

End to end (`test/integration.test.ts`: real `AgentSession`, real `CacheWarmer`, faux provider, fake clock)

| # | Scenario | Expect |
|---|---|---|
| E1 | `cacheWarming: "off"`, 150K-token context, idle 4.7 min | A checkpoint turn ran in the session, its cost recorded, cache entries show a read |
| E2 | Then the user returns at 12 min with `autoContinue` | A new session whose first user message holds the handoff and the user's text; the old session got no further request |
| E3 | Same with `autoContinue: false` and a scripted `select` | The question appears once with both prices |
| E4 | `cacheWarming: "idle"`, warmer running | The watchdog never fires, the hook checkpoints once at the last slot (existing behaviour) |
| E5 | Return at 2 min | No checkpoint, no switch |

Manual check on the host (maintainer only, real model, a few cents): work two turns in a large session, leave it 12 minutes, send a message. Expect a checkpoint turn at about 4.6 minutes, then the new session with the notice. `~/.pi/agent/sessions` shows a `governor-checkpoint` entry and a `governor-continue` entry.

## 5. Journeys

### 5.1 User (host app)

1. Works in a large session. The run ends.
2. About 4.6 minutes later a short turn appears ("Record where things stand…"). It costs a few cents and also renews the cache. The user can ignore it.
3. Back within the renewed window: the next message is a normal warm turn.
4. Back later (cache cold), `autoContinue` off: a question card shows both prices, resume or continue. One tap.
5. Back later, `autoContinue` on: the message goes straight into a new session. A notice states the time away and the saved cost; the seed message shows the handoff.
6. If the switch fails: a warning, and the message goes to the old session (the expensive path, but nothing is lost).

### 5.2 Agent

- During the checkpoint turn the agent sees the standard checkpoint prompt and runs `./awt state --now … --next …` when `awt` exists, otherwise writes `.pi-governor/handoff.md`. It answers with the handoff.
- In the new session its first message is the seed: the handoff, the pointer to the previous session file, "Run `./awt resume` first" when `awt` is present, then the user's message. It has no earlier conversation and must work from that.
- The agent is told nothing about prices.

### 5.3 Failure journeys

| Situation | Result |
|---|---|
| Credentials expired during the idle period | No checkpoint (needs a connection); the user resumes or restarts as before |
| User types while the checkpoint runs | Held, then sent after the handoff, with the existing notice |
| The checkpoint reply is empty or aborted | No checkpoint stored; on return the session resumes at full price; the evidence entry says why |
| Host restarts mid-idle | Timer lost; no checkpoint; the evidence entry records the miss on return |

## 6. Rollout

1. Land `idleCheckpoint` (on) and `autoContinue` (off) with tests and the `DESIGN.md` update in one commit.
2. The maintainer turns `autoContinue` on in one session, compares the next week's cold-rewrite cost in `governor-history.jsonl` and the evidence entries.
3. If the watchdog fires in sessions where the warmer also ran, the delay is wrong; adjust `0.92`.
