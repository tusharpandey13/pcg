# Working on pcg

pcg is a pi extension that decides when to keep a prompt cache warm, when to checkpoint, and when to roll a session over, so that long Claude sessions with a short, fixed cache lifetime cost less.

- `DESIGN.md` is the contract. Change it in the same commit as behaviour.
- `src/governor.ts` is the whole extension. Keep it one file, small, with no runtime dependencies.
- Complexity is debt. A new setting or command needs a measured reason.

## Rules that protect the point of the extension

- **A checkpoint is a turn inside the current session**, so it reads the warm cache. Never write a handoff with a separate model request: that reads the whole context at full input price.
- **At most one checkpoint attempt per idle period.** A checkpoint or rollover must never trigger another.
- **Warming always ends:** at the break-even cap, at pi's 30-minute idle limit, or on a 401 or 403.
- **Never lose the user's message.** Messages typed during a checkpoint are held and sent afterwards, and a failed session switch delivers to the current session.
- **No unannounced session switch.** The user is either asked or told.
- **No handler may throw into pi.** Use the `guard` and `fin` helpers.
- **Dollar figures come from usage pi recorded,** never from guesses.

## Testing

- `npm test` must pass, and `npm run typecheck` must be clean, before every commit.
- Tests use pi's faux provider and a fake clock. **Never add a test that calls a real model, AWS or the network.** The chaos suite fails any test that touches the network.
- Tests set their own prices (`TEST_SETTINGS` in `test/helpers.ts`), so changing the shipped defaults doesn't break them.
- A bug found by chaos testing gets fixed in `src/`, and its test is kept as a regression test. Don't weaken an invariant to make a test pass.
- For wider fuzzing, run `CHAOS_SEED=<n> CHAOS_RUNS=300 npm test` with a few seeds.
- `npm run demo` prints a timeline of the main scenarios at no cost. Run it after behaviour changes.
- Running against real Bedrock costs money. Do it only when the maintainer asks, and only on the maintainer's own account.

## Publishing

This repository is public. Never commit real task data, company names, account IDs, credentials or token-shaped strings.
