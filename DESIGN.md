# pi-governor: design

A pi extension that cuts the cost of long Claude sessions on Amazon Bedrock when the prompt cache lifetime is fixed at 5 minutes and cannot be changed.

## The problem in one rule

The only expensive event is a request against a large context whose cache has expired. It writes the whole context again at 1.25x the input price, where a cache read costs 0.1x. For a 340K-token context on Sonnet 5.5 that is about $1.06 against $0.07. Everything below exists to make that event rare and small.

## What pi already does

pi's built-in cache warmer (`packages/coding-agent/src/core/cache-warmer.ts`) refreshes the cache at 90% of its lifetime by replaying the exact last request with a one-token output cap. The refresh stays out of the conversation. It warms only while the expected saving is at least $0.05, assumes a 15% chance that you continue while idle, and stops after 30 minutes idle. Turn it on with `cacheWarming: "idle"` and a `promptCache` lifetime on the model.

The governor does not replace it. It adds what the warmer cannot know, and handles what happens when warming ends.

## Features

### 1. Warm when a wake is certain

The warmer assumes a 15% chance that a request arrives. When the governor knows a request will arrive, because a worker it started is still running and will report to this session, it overrides the decision to `warm` until the worker reports or the break-even cap is reached.

Cap: the smaller of two limits.

- Break-even: refreshes equal to one rewrite, `(write - read) / read`, about 11 for Sonnet 5.5 (about 50 minutes). After that, letting the cache expire is cheaper.
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

When warming is about to stop and the context is large (default 100K tokens or more), the governor writes a handoff while the cache is still warm. It does this as a turn inside the session, so the turn reads the cached context at 0.1x and writes a short handoff, typically 1-3K output tokens.

- With `./awt` in the task directory, the turn runs `./awt state --now ... --next ...` and updates refs and decisions as needed.
- Without it, the turn writes `.pi-governor/handoff.md`.

A checkpoint costs about 0.1x the context plus output. That is worth paying only when the cache will probably expire before you return, which is exactly when warming stops.

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

### 6. Workers with a mailbox (phase 2)

- A tool lets the front agent start a worker: a separate pi process in RPC mode with its own fresh context. When `./awt` exists, the worker starts from `./awt resume --scope <id>`.
- Workers write full output to files and return a one-line result plus a path.
- Results go into a mailbox. They reach the front agent as one message when it is idle, so several finishing workers cause one wake, not several.
- You can list workers, send one a message (steer), or stop it. Each worker runs pi's own warmer for its own cache.

Phase 2 starts after phase 1 has been used for real.

## Failing safe

Every handler catches its own errors, logs once, and does nothing: no checkpoint, no switch, the message is delivered. Numbers read from the session (usage, costs, timestamps) are trusted only when finite and non-negative; otherwise they are unknown, dollar figures show "unknown", and decisions that need them are skipped. A corrupt checkpoint entry is ignored.

## Configuration

All settings live in one block in pi's settings, with these defaults:

| Setting | Default | Meaning |
|---|---|---|
| `checkpointMinTokens` | 100000 | Smallest context worth a checkpoint |
| `rolloverTokens` | 200000 | Context size that triggers a rollover; 0 is off |
| `askOnReturn` | true | Ask between resuming and continuing from the checkpoint |
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
