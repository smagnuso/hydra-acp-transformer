# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`@hydra-acp/transformer` serves two roles from one package:

1. **A general-purpose transformer host binary** (`hydra-acp-transformer`)
   that loads a user's `.config.js` and dispatches hook events. Write
   policies in plain JS — block dangerous commands, auto-approve routine
   permissions, log file edits, rewrite prompts, react to lifecycle
   events like session close and compaction.

2. **A library** (`defineTransformer`, `runTransformer`, plus the full
   type surface in `types.ts`) that other Node projects import to build
   their *own* transformer binaries without reimplementing the WS
   connection, hook dispatch, or intercept plumbing. This is a
   supported, semver-stable API — treat it that way.

The purpose-built transformers in the Hydra ecosystem split across both
lanes: `budgeter`, `clarifier`, and `planner` speak the transformer
protocol directly (they need surfaces the library doesn't expose);
[`reviewer`](https://github.com/smagnuso/hydra-acp-reviewer) is built on
top of this library. New library consumers should look at reviewer as a
worked example.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md` for the transformer surface (`transformer/initialize`,
intercepts, lifecycle events).

Transformers sit **inside the daemon's message pipeline** (not attached as
clients) and see every in-flight ACP message in both directions before the
daemon acts on it. Reference implementations live in
`cli/examples/transformer-*.mjs`.

Configured under the `transformers` key in `~/.hydra-acp/config.json`
(distinct from `extensions`), and enabled per-session via
`defaultTransformers` (session-creation-time pipeline). Order matters — a
prompt-rewriter should come before a logger so the logger sees the
rewritten prompt.

## Layout

- `src/index.ts` — entry point (the `hydra-acp-transformer` binary)
- `src/host.ts` — the host runtime that loads a user's config.js and
  dispatches hook events
- `src/bridge.ts` — transformer WS connection to the daemon
- `src/hooks/` — hook implementations (`tool:permission`, file edits,
  lifecycle, …)
- `src/lib.ts` — public library entry (`defineTransformer`,
  `runTransformer`)
- `src/types.ts` — public hook type definitions
- `src/config.ts`, `src/util/`, `src/acp/`

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-transformer` on PATH. Registered via
`hydra-acp transformer add hydra-acp-transformer`.

User config defaults to `~/.hydra-acp/transformer.config.js`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- Hook names and payload shapes are **public API** — user configs depend
  on them. Add fields, don't rename or remove them.
- The library entry (`defineTransformer`, `runTransformer`, `types.ts`) is
  imported by third-party binaries — treat as semver-stable.
- User `.config.js` is arbitrary user JS. Errors in user hooks must never
  crash the host — catch, log, and continue with a fail-open decision
  (i.e. don't block a prompt because a rule threw).

## Gotchas

- **Trust boundary**: transformer-kind tokens unlock methods no extension
  can call. A misbehaving hook can rewrite or drop any message. Document
  this clearly to users.
- `block: true` on `tool:permission` denies the tool call — make sure the
  reason string reaches the client (it surfaces to the user).
- Hooks are ordered per the `defaultTransformers` array; rewriting a
  prompt affects downstream hooks. Users may not realize this — test
  chains, not just single hooks.
- Lifecycle events (`session.opened`, `session.idle`, `session.closed`,
  compaction) fire outside of a prompt/response cycle. Handlers must not
  assume there's an active turn to interact with.
- **User config is loaded via `jiti`, not native `import()`**
  (`host.ts`). That's what gives TS/ESM/CJS interop in a plain
  `.config.js` file, and what makes SIGHUP reload work (by explicitly
  deleting from `jiti.cache`). A refactor to native dynamic import will
  break both interop and reload.
- **Definition brand is a string key**
  (`lib.ts` `__hydraAcpTransformer`), deliberately not a Symbol. Reason:
  the user's config and the host binary can load DIFFERENT module
  instances of `@hydra-acp/transformer` (npm dedup can't always merge
  them). A Symbol brand would silently fail
  `isTransformerDefinition` across those dual-loaded copies.
- **Hook names are validated at `defineTransformer` time**
  (`lib.ts`), not at bridge start. Typos throw at module init and
  surface in the user's config load error — not silently at
  intercept-dispatch time. Preserve this — deferred validation makes
  bad configs load-then-nothing-happens, which is much worse to debug.
- **Hook catalog maps to concrete daemon intercepts**
  (`hooks/catalog.ts`). Some hooks are intercept-only (e.g.
  `session:cancel`); others are `response:session/update` filtered by
  an internal predicate (`tool:start`, `plan:update`). When a new
  update kind lands in the daemon, filters must be added here — hooks
  silently miss it otherwise.
- **`types.ts` re-exports are stable public API** (`lib.ts` re-export
  block). Third-party binaries import these directly. Removing or
  renaming any is a breaking change; deprecate through an alias
  first.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
