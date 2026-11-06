# pcg: pi cache governor

A [pi](https://github.com/earendil-works/pi-mono) extension that cuts the cost of long Claude sessions on Amazon Bedrock when the prompt cache lifetime is a fixed 5 minutes. Design: [DESIGN.md](DESIGN.md). Phase 1 = features 1-5 plus `/governor`. Workers (feature 6) are phase 2.

Built and tested against `@earendil-works/pi-coding-agent` **1.5.0** (needs Node >= 22.19).

## Install

```bash
pi install git:github.com/tusharpandey13/pcg
```

Other ways to load it:

```bash
pi -e /path/to/pi-governor/src/governor.ts          # one run
```
or add to `~/.pi/agent/settings.json`:
```json
{ "extensions": ["/path/to/pi-governor/src/governor.ts"] }
```
or `pi install /path/to/pi-governor` (the `pi.extensions` field in `package.json` points at the entry). No build step; pi loads TypeScript directly, and the extension has no runtime dependencies.

## One-time setup on the work Mac

1. **Credentials.** `export AWS_PROFILE=<your-sso-profile>` and `aws sso login`. Set `AWS_REGION` if the profile does not.
2. **One region, no cross-region profile.** Select a plain regional model ID (for example `anthropic.claude-sonnet-5-5-...` in your region), not a `us.`/`global.` inference profile. A request served from another region writes a new cache entry and defeats warming.
3. **Warming on idle.** In `~/.pi/agent/settings.json`:
   ```json
   { "cacheWarming": "idle" }
   ```
4. **Declare the 5-minute lifetime** (pi only warms tiers with a known lifetime). In `~/.pi/agent/models.json`, override the model you use:
   ```json
   {
     "providers": {
       "amazon-bedrock": {
         "modelOverrides": {
           "<your single-region model id>": { "promptCache": { "short": 300 } }
         }
       }
     }
   }
   ```
5. **Load the extension** (above). Optionally add a `governor` block to settings (defaults shown):
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
   `prices` are $ per million tokens; set them to your Bedrock rates. The break-even refresh cap is `floor((cacheWrite - cacheRead) / cacheRead)`. `rolloverTokens: 0` turns rollover off. Settings are read at session start.

## Use

`/governor` prints, for the current session: refreshes and their cost, checkpoints, rollovers, continues from a checkpoint, rewrites avoided, estimated savings and net, all from usage pi recorded (`cache_warm` entries and assistant usage) plus the governor's own session entries. It also shows the active config.

`/governor-rollover` and `/governor-continue` are internal commands the extension triggers itself (a new session can only be started from a command context).

## Phase 2 hook

Anything that knows a wake is coming (a running worker) calls:

```ts
import { expectWake } from "pi-governor/src/governor.ts";
expectWake(pi, "worker-1");          // wake expected: keep warming, up to the break-even cap or pi's 30-minute idle limit, whichever is first, then checkpoint
expectWake(pi, "worker-1", false);   // worker reported
```
or, without an import, `pi.events.emit("governor:wake", { id, expected })`.

## Develop

```bash
npm install
npm test        # vitest: mocks + real AgentSession/CacheWarmer with pi's faux provider and a fake clock. No network, no cost.
npm run typecheck
```
