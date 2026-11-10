# pi-governor: design

A pi extension that cuts the cost of long Claude sessions on Amazon Bedrock when the prompt cache lifetime is fixed at 5 minutes and cannot be changed.

## The problem in one rule

The only expensive event is a request against a large context whose cache has expired. It writes the whole context again at 1.25x the input price, where a cache read costs 0.1x. For a 340K-token context on Sonnet 5.5 that is about $1.06 against $0.07. Everything below exists to make that event rare and small.

## What pi already does

pi's built-in cache warmer (`packages/coding-agent/src/core/cache-warmer.ts`) refreshes the cache at 90% of its lifetime by replaying the exact last request with a one-token output cap. The refresh stays out of the conversation. It warms only while the expected saving is at least $0.05, assumes a 15% chance that you continue while idle, and stops after 30 minutes idle. Turn it on with `cacheWarming: "idle"` and a `promptCache` lifetime on the model.

The governor does not replace it. It adds what the warmer cannot know, and handles what happens when warming ends.

## Features

### 1. Warm by the return curve, and when a wake is certain

The warmer assumes a 15% chance that a request arrives, whatever the time away or the context size. The governor replaces that with a measured return curve. At every refresh tick pi reports `warmCost` (a cache read of the prompt plus one output token) and `missCost` (a full miss minus a hit), both at the model's catalog prices. When no wake is expected, the governor warms if and only if `returnChance(minutes away) * missCost >= warmCost`, and overrides pi in either direction: it warms small contexts pi skips, and stops late refreshes pi would send. It returns pi's action (no override) when the two agree.

`returnChance(m) = 0.53 * exp(-m / 16)` is the chance the user returns before the next refresh (about one cache lifetime x 0.9), given they are still away. It is fitted to measured return rates on the maintainer's sessions: about 34% at 5-9.5 minutes away, falling to about 8% at 30 minutes. Break-even for a refresh at Bedrock Sonnet prices is about 4%. It has no setting. If either cost is unknown, `missCost` is 0, or the last request is unknown, the governor follows pi's action. The stops below, the open checkpoint and the final-slot checkpoint rule all win over the curve.

When the governor knows a request will arrive, because a worker it started is still running and will report to this session, it overrides the decision to `warm` until the worker reports or the break-even cap is reached.

Cap: the smaller of two limits.

- Break-even: refreshes equal to one rewrite, `(write - read) / read`, about 11 for Sonnet 5.5 (about 50 minutes). It uses the model's prices, and input as the write price when the model has none. After that, letting the cache expire is cheaper.
- pi's idle limit: pi caps idle warming at 30 minutes after the request that started the run, about 6 refreshes at a 5-minute lifetime. A wake longer than that ends in a checkpoint, not in warming.

Refreshes are counted by warm decisions, so a failed refresh (500, 429, timeout), which leaves no `cache_warm` entry, still counts. When the cap or the idle limit is reached while a wake is still expected, the governor checkpoints before warming ends, as in feature 3, and does not restart warming for that idle period.

### 2. Stop on auth errors

Credentials expire, whether they come from an SSO profile or a `credential_process` helper. Warming stops until the next real request, instead of retrying every 4.5 minutes, in two cases:

- A refresh gets a 401 or 403. The status line shows "AWS credentials expired".
- A refresh gets no HTTP response at all before the next warming decision. The status line shows "AWS credentials unavailable".

The second case is how a `credential_process` failure looks: the AWS SDK runs the helper before sending, and a helper that needs the user (an MFA approval, a login) fails inside the SDK, so no response arrives. Stopping on the first miss is deliberate, because each retry would run the helper again, possibly sending another MFA prompt. A network drop looks the same and is handled the same way.

Any HTTP response, even one that arrives while a turn is running, ends this watch, because it proves credentials and network work. Only responses while idle count as the refresh's own status.

Neither case writes a checkpoint, because a checkpoint needs a working connection. Every failed refresh's status and `x-amzn-errortype` are logged in the session as evidence. That way it can be confirmed which other statuses, if any, also mean expired credentials, without guessing.

### 3. Checkpoint while warm

When warming is about to stop and a checkpoint pays for itself, the governor writes a handoff while the cache is still warm.

A checkpoint pays when `CHECKPOINT_USE_CHANCE * saving >= cost`, with prices from the model:

- cost = `2 * tokens * cacheRead + 1000 * output`: two requests (write the handoff, reply) that read the context, plus about 1000 output tokens (a handoff under 300 words, written and echoed, plus the tool call).
- saving = `(tokens - 1000) * writePrice`: the rewrite avoided, minus seeding the handoff into the new session. `writePrice` is the cache-write price, or input when the model has none.
- `CHECKPOINT_USE_CHANCE = 0.25` is a prior, not measured.

At Bedrock Sonnet prices (input 3, write 3.75, read 0.3, output 15) this crosses at about 47K tokens. `checkpointMinTokens` is an optional floor on top (default 0): the economics decide. The recorded cost of a checkpoint is the sum of all its requests, so the constants can be checked against real checkpoints. It does this as a turn inside the session, so the turn reads the cached context at 0.1x and writes a short handoff, typically 1-3K output tokens.

- With `./awt` in the task directory, the turn runs `./awt state --now ... --next ...` and updates refs and decisions as needed.
- Without it, the turn writes `.pi-governor/handoff.md`.

A checkpoint costs about 0.2x the context plus output (two reads). That is worth paying only when the cache will probably expire before you return, which is exactly when warming stops.

The checkpoint takes the slot of the last refresh before pi's 30-minute idle stop (the governor acts at 29 minutes). When no checkpoint will be taken, for example because the context is under the threshold or one was already attempted, that last refresh is sent as usual.

The handoff is taken only from the checkpoint turn's own assistant message (messages after the turn started), never from "the last assistant message". `handoff.md` counts only if it is a readable file written after the checkpoint started; otherwise the reply is used, with a notice. There is at most one checkpoint attempt per idle period (until the next real request), whatever the outcome.

A user message that arrives while the checkpoint turn runs is held and sent when the turn settles, with the notice "Saving handoff, your message follows". It is never steered into the checkpoint turn.

This adds one turn to the old session's history. The old session is not reused after a fresh start, so that does not matter.

### 4. Choose on return

When you send a message, the governor checks whether the cache has expired (time since the last request is longer than the lifetime). If it has and a checkpoint exists, it asks once:

```
Cache expired 23 min ago. Context: 342K tokens.
  Resume full context     ~$1.06
  Continue from checkpoint ~$0.08 (new session, handoff + your message)
```

"Continue from checkpoint" starts a new session seeded with the handoff and your message. The question is single-flight: inputs that arrive while it is open are held and follow the choice. If the new session is refused or fails, the governor keeps the checkpoint open, tells you the switch failed, and sends your message to the current session. The same holds for rollover, which then reuses the open checkpoint instead of starting another. If `ui.select` throws, it resumes. Either choice is remembered for the session if you tick "don't ask again". Without a checkpoint, nothing is asked.

### 5. Roll over past a size cap

When a run settles and the context is above the cap (default 200K tokens), the governor does the same in-session handoff while warm, then starts a fresh session from it, and tells you. This bounds the cost of every later turn and of any later rewrite. The cap is configurable, and `0` turns rollover off.

The cap stays a size, not a price. Cost alone says to roll over almost at once, because a smaller context always costs less per step; the real limit is summary quality, which the estimator cannot price. The notice shows what the move buys, as the read cost per step before and after: `Context passed 200K tokens (~$0.06 per step); continuing in a fresh session from the checkpoint (~$0.01 per step).` Before is the last context size x cacheRead; after is this session's first request (system prompt, tools, first prompt) plus the handoff length / 4, x cacheRead, at the model's prices.

### 6. Workers with a mailbox (phase 2)

- A tool lets the front agent start a worker: a separate pi process in RPC mode with its own fresh context. When `./awt` exists, the worker starts from `./awt resume --scope <id>`.
- Workers write full output to files and return a one-line result plus a path.
- Results go into a mailbox. They reach the front agent as one message when it is idle, so several finishing workers cause one wake, not several.
- You can list workers, send one a message (steer), or stop it. Each worker runs pi's own warmer for its own cache.

Phase 2 starts after phase 1 has been used for real.

### 7. Cost before action (all five steps built)

Every action is priced before it runs, the price is shown to the user, and the model plans with the same numbers. This replaces the fixed thresholds of features 1, 3 and 5 with one estimator.

**One estimator.** `estimate(action) → { usd, low, high, breakdown }`, built from the context size, the cache state (warm until the last request plus the TTL) and the model's prices from pi (config `prices` overrides them). A request costs cached tokens × read + new or uncached tokens × write + expected output × output. A cold cache bills the whole context at the write price.

**Shown before each action, on by default.**

| Before | pi hook | Shown |
|---|---|---|
| A prompt is sent | `input` | `~$0.08 · cache warm · 1–6 requests · high $0.21` |
| Each tool call | `tool_call` | `next step ~$0.02 (150K read + ~3K write)` |
| Warm or stop while idle | `cache_warming_decision` | warm: `warming ~$0.03 per refresh · a rewrite would cost ~$0.35`; stop (no checkpoint starting): `cache expires ~14:05 · returning later costs ~$0.35 (rewrite)` |

Showing never blocks. Two gates are opt-in and default to off (0): `confirmAbove` asks before a prompt whose high estimate exceeds it, and before a task the model itself estimated above it; `sessionBudget` asks, then blocks tool calls (`block` with `terminate`) once the session's recorded spend reaches it. Neither gates the checkpoint turn, cache-warming refreshes or the `estimate_cost` tool.

**Past costs, given to the model.** The model knows the task; the governor knows the prices and history. Together they estimate better than either alone.

- *History.* After each task (a prompt until the run settles), the governor appends one local record: model, requests, tokens by kind, cost, duration, tools used, and a short task label taken from the prompt. It lives in pi's user directory, never in the repository, and can be turned off.
- *Brief.* When a prompt arrives, the governor appends a brief of about 150 tokens to the end of the context: the current price per step, the cache state, the budget left, typical and high cost for tasks of this session, and the three past tasks whose labels best match the prompt (word overlap; no embeddings, no model call).
- *Estimate first.* A registered tool, `estimate_cost({ steps, usd, reason })`, is described as the first call for any task that will use tools, made in the same response as the first other tool call so it costs no request of its own (a separate request would re-read the whole context). pi checks every call of a response (the `tool_call` hooks) before it runs any of them, so the governor records the estimate when estimate_cost is checked; with a gate set, the other calls of that response then wait for the user's confirmation before they run.
- *Calibration.* Each estimate is stored with the task's actual cost. The brief reports the model's recent error ("your last 10 estimates ran 1.4× low"), so its estimates correct over time.

**Rules.**

- The brief goes at the end of the context, never into the system prompt: changing the system prompt invalidates the cache every turn and costs more than it saves.
- Estimates are always labelled as estimates. `/governor` reports keep using recorded usage only, and show predicted against actual cost.
- Steps per task are decided by the model, so a task's cost is a range, not a number. The budget gate is the hard limit.

**Order.** (1) estimator and predicted-vs-actual logging, nothing shown (**built**: `estimateRequest` prices each real request at the model's catalog prices from pi (`prices` only when the model has none; a model without a cache-write price bills new tokens at input) in `before_provider_request`, with input size approximated as payload characters / 4 because exact tokens are unknown before the call; cache-warming refreshes are skipped; `message_end` pairs the prediction with the usage pi recorded and appends a `governor-estimate` entry; `/governor` shows the paired count and the median and worst predicted/actual ratio; `npm run calibrate -- <session.jsonl>` replays the estimator over a recorded session, offline, at the prices recorded in it; it assumes a 5-minute cache lifetime, so providers that keep caches longer show outliers); (2) show before prompt and tool call (**built**: the `input` hook prices the prompt's first request with `estimateRequest` (cold if the cache expired) and adds one warm follow-up step per further request, since only the first request can pay a rewrite; the request count is this session's requests per turn, the assistant messages between consecutive user messages on the branch, over the last 10 turns: the median gives the typical figure and the min and max give the range and the high figure, with "1+ requests" until two turns exist; the `tool_call` hook prices the request the tool result triggers, as a warm read of the current context plus the median of recent per-request prompt growth, or 3000 tokens before any history; both write the `governor-cost` status, extension-sent inputs are ignored, a cold cache shows as "cache cold (rewrite)", the status is cleared when the run settles, and unknown inputs show nothing; it never blocks or changes anything); (3) features 1, 3 and 5 move to the estimator (**built**: warming follows the return curve of feature 1 and overrides pi both ways; a checkpoint needs `checkpointPays` (feature 3), so `checkpointMinTokens` defaults to 0 and is only a floor; rollover keeps its size cap and its notice shows the per-step read cost before and after (feature 5); the idle status above uses `showCost`, is display only and never changes a decision, and the next prompt overwrites it; the break-even cap, the return prompt and `/governor` reports use the model's prices from pi, with input as the write price when the model has none, and `/governor` still prints the configured `prices`); (4) history, brief and `estimate_cost` (**built**: *history*: with `history` on (default), a task starts at a user `input` (not extension-sent, not held while a checkpoint runs) and ends at the next `agent_settled` that is not the checkpoint turn; aborted runs are skipped. The governor appends one JSON line to `governor-history.jsonl` in pi's agent directory (`getAgentDir()`, so `PI_CODING_AGENT_DIR` moves it), never in the repository: `v`, end time, `provider/id` model, label, request count, tokens by kind, cost, duration, unique tool names, and the model's estimate if it made one. The label is the prompt with whitespace collapsed, cut to 80 characters; cwd, file contents and full prompts are never stored. Sums come from the assistant messages the task added, unknown numbers count as 0, and a task with no known cost is not recorded. On session start the last 500 valid lines are loaded (corrupt lines are skipped); new records are kept in memory first and then appended, and a file error is logged once and the session behaves as if the history were empty. *Brief*: `before_agent_start` for a user prompt returns a `governor-brief` custom message with `display: false`. pi saves it in the session right after the prompt and sends it to the model as a user message, so the next request has the same prefix and the cache stays valid; the system prompt is never touched. It is skipped for prompts the governor sent itself (the checkpoint prompt and the rollover/continue seed) and when there is nothing to say. One paragraph, every number an estimate: the cache state and per-step cost (cold: the first step rewrites the context), typical and high cost of this session's tasks once there are two, up to three past tasks of the same model whose labels overlap the prompt most (Jaccard over lowercase words of three or more characters; labels shown cut to 40 characters), and a calibration note when at least 3 of the last 10 tasks with an estimate have a median actual/estimate ratio outside 0.83 to 1.2 ("ran 1.4x low" when actual is higher). *Tool*: `estimate_cost({ steps, usd, reason })` is registered once at load, so the tool list and system prompt are identical on every turn. A call with an integer `steps` of at least 1 and a finite `usd` of at least 0 stores the estimate on the open task (last call wins) and shows it to the user; anything else is answered with an error text and records nothing. The tool never throws. `tool_call` status is unchanged, so it also fires for `estimate_cost`. `/governor` adds a history line with the task count and the median calibration ratio. Held messages released after a checkpoint are sent by the extension, so they get a brief but do not open a task); (5) gates (**built**, both off at 0; read with the `num` rule). *Prompt gate*: in `input`, for a user prompt (not extension-sent, not held, not the governor's own prompt) when no return question will be asked for it (feature 4 asks only with a checkpoint, an expired cache, no remembered choice, `askOnReturn` and a UI), the turn estimate that is shown is also returned; if its high figure exceeds `confirmAbove` and there is a UI, the governor sets `asking` (other inputs are held as for the return question) and calls `ctx.ui.confirm("This prompt may cost up to ~$H", "Typical ~$T · cache state · requests. Send it?")`. Declined: the prompt and any messages held meanwhile go back to the editor (`setEditorText`, joined by blank lines), the user is told, and the input is `handled`, so nothing is sent and no task opens. Accepted: the prompt goes on as usual and held messages are released. *Fails open*: no UI (logged as a `governor-log` entry), a confirm that throws, an unknown estimate, or an editor that cannot take the text (the message is sent rather than lost). *Model-estimate gate*: in `tool_call`, when the open task has an `estimate_cost` estimate above `confirmAbove` and the tool is not `estimate_cost`, the first call asks once per task (`confirm`, showing steps and the model's reason, which is kept on the task but not in the history record). Yes: the task is confirmed. No: the call is blocked with `terminate` and a reason that tells the model to stop and ask, and every later call of that task is blocked without asking again. *Fails open*: no UI (logged) or a failing dialog allows the task, because blocking work on a broken dialog costs the user more than the estimate does. *Budget gate*: spent is `sessionSpent(branch)`, the sum of assistant `usage.cost.total` and `cache_warm` entries on the current branch (unknown numbers count as 0). In `tool_call`, once spent reaches the budget, `ctx.ui.select` offers "Allow another $B" (raises this session's budget by B in memory until `session_start`, so the next ask comes only after the raised budget is spent) or "Stop tool calls". Anything else, a throw, or no UI blocks with `terminate` and a reason telling the model to stop and ask the user; after a stop the rest of that run is blocked without asking (`agent_start` clears it). *Fails closed*: a budget that cannot ask or check blocks, since the budget is the hard limit. A prompt sent while over budget is never blocked; the user gets one notice per prompt. The brief adds "Budget left ~$X." (budget plus raises minus spent, floor 0) when `sessionBudget` is set, and `/governor` shows `confirm>$X` and `budget $X (spent ~$S)` when set. Every number is from recorded usage or the shown estimate. Each step is tested against recorded sessions and the faux provider, with no paid runs.

## Failing safe

Every handler catches its own errors, logs once, and does nothing: no checkpoint, no switch, the message is delivered. Numbers read from the session (usage, costs, timestamps) are trusted only when finite and non-negative; otherwise they are unknown, dollar figures show "unknown", and decisions that need them are skipped. A corrupt checkpoint entry is ignored.

## Configuration

All settings live in one block in pi's settings, with these defaults:

| Setting | Default | Meaning |
|---|---|---|
| `checkpointMinTokens` | 0 | Optional floor on the context size for a checkpoint; the economic rule decides otherwise |
| `rolloverTokens` | 200000 | Context size that triggers a rollover; 0 is off |
| `askOnReturn` | true | Ask between resuming and continuing from the checkpoint |
| `history` | true | Keep the local task history (`governor-history.jsonl` in pi's agent directory) and use it for the brief; false writes and reads nothing |
| `confirmAbove` | 0 | USD; ask before a prompt whose high estimate exceeds it, and before a task the model estimated above it. 0 is off |
| `sessionBudget` | 0 | USD; once this session's recorded spend (assistant requests and cache refreshes) reaches it, tool calls ask to continue or are blocked. 0 is off |
| `prices` | Sonnet 5.5 first-party | $ per million tokens: input, cache write, cache read, output. Set to your Bedrock rates |

## Reporting

`/governor` shows, for this session: refreshes sent and their cost, checkpoints and rollovers, rewrites avoided, and the net estimate. Every figure comes from usage pi records per request, including its `cache_warm` entries, not from guesses.

## Setup the user does once (work Mac)

1. Install pi and point it at an AWS profile (`AWS_PROFILE`): either an SSO profile or one with a `credential_process` helper. Set the profile for pi only.
2. Pin the model to one region rather than a cross-region inference profile, since a request served from another region writes a new cache entry.
3. Set `cacheWarming: "idle"` and `"promptCache": {"short": 300}` for the model.
4. Install the governor extension.

## Testing

- Unit tests use pi's fake provider with scripted usage numbers and a fake clock. They spend no tokens.
- Each feature is tested by its decision: warm or stop, checkpoint or not, the prompt shown on return, and when rollover fires.
- A real run on Bedrock happens only at work, with the user's approval.

## Not doing

- No new interface: pi's TUI is the interface.
- No changes to Claude Code, settings policy or gateways.
- No automatic switch to a fresh session without telling the user.
- No model-written summaries outside the warm session, since those read the context at full price.
