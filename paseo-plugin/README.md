# pcg Paseo plugin

An optional Paseo plugin that makes pcg's checkpoint quiet in the chat. It draws only client timeline transformers and has no server logic.

pcg checkpoints an idle session by sending a prompt (`[governor checkpoint] ...`) and keeping the agent's handoff reply (up to 300 words). Without this plugin, Paseo shows both as full chat bubbles. With it:

- the checkpoint prompt (a user message starting with `[governor checkpoint]`) is hidden;
- the handoff reply (an assistant message whose text starts with `[pcg handoff]`) becomes one grey row: `pcg · checkpoint saved before the cache expired`.

Every other item is unchanged, including tool calls and the `Continue where you left off.` message. The handoff itself is still stored and used: only the drawing changes.

## Install

From this directory:

```sh
paseo plugin install "$PWD"
```

Needs Paseo 0.16.1 or later, and pcg 0.2.1 or later (older versions do not start the reply with `[pcg handoff]`).

## Develop

```sh
npm ci
npm test   # typecheck + offline tests
```
