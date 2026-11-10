# pcg: pi cache governor

A [pi](https://github.com/earendil-works/pi-mono) extension that cuts the cost of long Claude sessions when the prompt cache lifetime is short and fixed, for example 5 minutes on Amazon Bedrock.

## Why

With prompt caching, a request that reuses a warm cache pays about 0.1× the input price for the context. Once the cache expires, the next request writes the whole context again at 1.25×. A pause longer than 5 minutes therefore costs 12.5 times what a cache read would.

For a 340K-token context on Sonnet 5.5 at first-party prices, that is about $1.06 for the rewrite against $0.07 for a read. A session pays it every time you step away, read a long diff, or wait for a build.

pi already has a cache warmer that refreshes the cache before it expires, but it can't know when you're coming back. pcg adds that knowledge, and handles what happens when warming has to stop.

## What it does

| Situation | What pcg does |
|---|---|
| You send a prompt, or the model is about to run a tool | Shows an estimate in the status line, never blocking: `~$0.08 · cache warm · 1–6 requests · high $0.21` (a cold cache shows `cache cold (rewrite)`), then `next step ~$0.02 (150K read + ~3K write)` before each tool call. Estimates are rough, and cleared when the run ends |
| A wake is certain, such as a worker still running that will report back | Keeps warming until the wake arrives, up to the break-even point or pi's 30-minute idle limit |
| Credentials expired: a refresh gets a 401 or 403, or gets no response at all (for example a credential helper waiting on MFA) | Stops warming instead of retrying every 4.5 minutes, and shows "AWS credentials expired" or "AWS credentials unavailable". The next real request recovers. |
| Warming is about to stop and the context is large | Writes a **checkpoint** as a turn inside the session while the cache is warm, at about 0.1× the context |
| You return after the cache expired and a checkpoint exists | Asks once: resume the full context, or continue from the checkpoint in a fresh session, with dollar estimates for each |
| The context passes a size cap (200K tokens by default) | Hands off while warm, rolls over to a fresh session, and tells you |

A checkpoint is always a turn inside the warm session. A handoff written by a separate request would read the whole context at the full input price, which is the cost this extension exists to avoid.

If the task directory has [`awt`](https://github.com/tusharpandey13/awt), the checkpoint goes into it (`./awt state`). Otherwise it goes to `.pi-governor/handoff.md`.

## Install

Needs pi 1.5.0 or later (Node 22.19+).

```bash
npm install -g @earendil-works/pi-coding-agent   # if pi is missing or older
pi install git:github.com/tusharpandey13/pcg
```

pi loads TypeScript directly, so there is no build step, and pcg has no runtime dependencies.

## Setup

1. **Credentials.** Either route works, because pi uses the standard AWS credential chain:
   - **SSO profile:** `aws sso login --profile <your-sso-profile>`, then run pi with that profile.
   - **`credential_process`,** for managed setups where a helper prints short-lived credentials as JSON (`Version`, `AccessKeyId`, `SecretAccessKey`, `SessionToken`, `Expiration`). Add a profile to `~/.aws/config`:
     ```ini
     [profile pcg-bedrock]
     region = us-east-1
     credential_process = /path/to/your-credential-helper
     ```

   Set the profile for pi only, not globally, so other tools keep their own credentials. A shell alias does this:
   ```bash
   alias pi='AWS_PROFILE=pcg-bedrock command pi'
   ```
   Set `AWS_REGION` if the profile doesn't, and `AWS_CA_BUNDLE` if your network uses a proxy certificate.
2. **One region.** Pick a plain regional model ID, not a `us.` or `global.` cross-region inference profile. A request served from another region writes a new cache entry, which defeats warming.
3. **Turn on idle warming.** In `~/.pi/agent/settings.json`:
   ```json
   { "cacheWarming": "idle" }
   ```
4. **Declare the cache lifetime.** pi only warms caches whose lifetime it knows. In `~/.pi/agent/models.json`:
   ```json
   {
     "providers": {
       "amazon-bedrock": {
         "modelOverrides": {
           "<your regional model id>": { "promptCache": { "short": 300 } }
         }
       }
     }
   }
   ```
5. **Set your prices** (optional, recommended). Add a `governor` block to `~/.pi/agent/settings.json`. These are the defaults:
   ```json
   {
     "governor": {
       "checkpointMinTokens": 100000,
       "rolloverTokens": 200000,
       "askOnReturn": true,
       "prices": { "input": 2, "cacheWrite": 2.5, "cacheRead": 0.2, "output": 10 }
     }
   }
   ```
   - `prices` are dollars per million tokens. The defaults are Sonnet 5.5 first-party rates, so set your Bedrock rates.
   - `rolloverTokens: 0` turns rollover off.
   - Settings are read when a session starts.

## Use

Work in pi as usual. pcg only acts when you pause or the context grows.

- **When you return after the cache expired,** you may see:
  ```
  Cache expired 20 min ago. Context: 151K tokens.
    Resume full context  ~$0.38
    Continue from checkpoint  ~$0.01 (new session, handoff + your message)
  ```
  The "don't ask again" variants remember your choice for the session.
- **`/governor`** reports, for the current session, from usage pi recorded:
  - refreshes and their cost;
  - checkpoints, rollovers and continues;
  - rewrites avoided, estimated savings, and the net result;
  - the active settings.

## Limits

- **Warming beyond 30 minutes isn't possible.** pi caps idle warming at 30 minutes, so a longer wait ends in a checkpoint.
- **The checkpoint estimate is low.** It counts only the handoff, not writing pi's system prompt and tools again in the new session, so the real cost is a few cents more.
- **Warming stops on the first refresh with no response.** Near a 5-minute lifetime, a missed refresh has probably lost the cache already, and retrying would run your credential helper again, which may mean another MFA prompt each time. A network drop has the same effect. The next real request recovers.
- **The handoff is only as good as the model's summary.** Continuing from a checkpoint is cheaper but loses detail that the full context would keep.
- **Not yet confirmed against real Bedrock:**
  - which HTTP statuses Bedrock returns for expired credentials. pcg acts on 401 and 403 only, and logs every failed refresh's status and `x-amzn-errortype` in the session (`governor-log` entries), so this can be checked;
  - that a single-region model ID gets cache hits. Check with `/governor` after two turns: refreshes should show cache reads, and writes on every refresh mean the region or model ID doesn't match;
  - real handoff quality;
  - pi's own selection menu.

  The tests cover these with pi's fake provider.

## Try it without spending anything

```bash
git clone git@github.com:tusharpandey13/pcg.git && cd pcg && npm install
npm run demo
```

The demo runs a real pi session, pi's real cache warmer and pcg on pi's fake provider with a fake clock, and prints a timeline. It covers stepping away, a worker that reports back, and a rollover. Its dollar figures come from scripted usage, so treat them as illustrative.

## Develop

```bash
npm install
npm test            # unit, integration and chaos tests; no network, no cost
npm run typecheck
CHAOS_SEED=7 CHAOS_RUNS=300 npm test   # more seeded fuzzing
npm run calibrate -- session.jsonl   # replay the cost estimator over a recorded pi session; offline
```

- [DESIGN.md](DESIGN.md) is the contract.
- [AGENTS.md](AGENTS.md) has the rules for changing the code.

## Extending: expected wakes

Anything that knows a wake is coming, such as a background worker, can tell pcg to keep warming:

```ts
import { expectWake } from "pcg/src/governor.ts";
expectWake(pi, "worker-1");          // a wake is expected
expectWake(pi, "worker-1", false);   // it arrived
```

Without an import, emit the event instead: `pi.events.emit("governor:wake", { id, expected })`.
