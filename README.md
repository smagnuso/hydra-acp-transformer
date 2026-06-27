# @hydra-acp/transformer

JS-injected hooks for [hydra-acp](https://github.com/smagnuso/hydra-acp). Write policies that observe or intercept messages flowing through the daemon's message pipeline — block dangerous commands, auto-approve routine permissions, log file edits, rewrite prompts, or react to lifecycle events like session close and compaction.

Ship hooks as a plain `.config.js` file (casual mode) or import `@hydra-acp/transformer` from your own binary for library-style integration with `defineTransformer` and `runTransformer`.

## Quickstart — casual author

Install the transformer via hydra's extension system:

```sh
hydra extension add @hydra-acp/transformer
```

Drop a config file at `~/.hydra-acp/transformer.config.js`:

```js
import { defineTransformer } from "@hydra-acp/transformer";

export default defineTransformer({
  hooks: {
    // Block rm -rf before the agent executes it
    "tool:permission": async (event) => {
      const cmd = event.toolCall?.rawInput?.command ?? "";
      if (/\brm\s+-rf\s+/.test(cmd)) {
        return { block: true, reason: "policy: rm -rf denied" };
      }
    },

    // Log every file the agent edits
    "file:edited": async (event, ctx) => {
      ctx.logger.info(`edited: ${event.path}`);
    },

    // Cleanup when session goes idle
    "session:idle": async () => {
      console.log("session went quiet");
    },
  },
});
```

Add `@hydra-acp/transformer` to `defaultTransformers` in your hydra config. The daemon spawns the binary on the next session and it connects automatically.

The config file supports `.ts`, `.mjs`, and `.cjs` extensions. The host loads it via jiti so TypeScript works out of the box with no build step.

## Quickstart — library consumer

For packages that want to embed transformer logic (the budgeter, clarifier, or your own tool):

```sh
npm install @hydra-acp/transformer
```

```ts
// my-transformer/src/index.ts
import { defineTransformer, runTransformer } from "@hydra-acp/transformer";

const transformer = defineTransformer({
  hooks: {
    "tool:permission": async (event) => {
      // budget gating logic
    },
    "session:idle": async () => {
      // roll up usage stats
    },
  },
});

if (process.env.HYDRA_ACP_TRANSFORMER_NAME) {
  void runTransformer(transformer);
}
```

`runTransformer` is the same code path the host binary uses — it opens a WebSocket to the daemon, declares the intercepts your hooks need, and dispatches incoming messages to your handlers. When `HYDRA_ACP_TRANSFORMER_NAME` is set (injected by the daemon), your binary enters transformer mode automatically.

## Hook reference

| Hook | Fires when | Payload type | Typical use case |
|---|---|---|---|
| `session:open` | Transformer joins a live session or chain runs on creation | `{}` | Log attachment, initialize per-session state |
| `session:close` | Session is cold-demoted, deleted, or daemon shuts down | `{}` | Persist in-flight state, flush logs |
| `session:idle` | Session goes quiet after `idleEventTimeoutMs` of no activity | `{}` | Roll up usage, trigger cleanup workflows |
| `prompt:pre` | A `session/prompt` request enters the chain | `PromptEnvelope` | Rewrite the user's prompt, short-circuit with a canned reply via `{ handled }` |
| `permission:pre` (alias `tool:permission`) | Agent requests permission to run a tool | `PermissionEnvelope` | Auto-approve routine calls, block dangerous ones, or abstain for human review |
| `permission:replied` | A permission request resolves (by transformer or human) | `{ toolCallId, outcome, sourceWasTransformer }` | Audit trail, stats on auto-approval rates |
| `tool:start` | First `session_update` sighting of a tool invocation (`"tool_call"`) | `ToolCall` | Track which tools the agent uses, enforce per-tool budgets |
| `tool:progress` | Non-terminal tool status update (`"tool_call_update"`) | `ToolCallUpdate` | Stream progress to external systems, live cost tracking |
| `tool:post` | Tool call reaches terminal status (`"completed"` / `"failed"`) | `{ toolCallId, status, kind?, content?, locations? }` | Post-processing after a tool finishes, error alerting |
| `file:edited` | Agent edits a file (first sighting of each path per session) | `{ path, toolCallId, line? }` | Log changed files, trigger linters or tests |
| `message:assistant` | Agent message chunk arrives (`"agent_message_chunk"`) | `MessageChunk` | Live text accumulation, streaming analysis |
| `message:thought` | Agent thought chunk arrives (`"agent_thought_chunk"`) | `MessageChunk` | Monitor reasoning steps, log chain-of-thought |
| `message:user` | User message chunk arrives (`"user_message_chunk"`) | `MessageChunk` | Audit user input, content filtering |
| `plan:update` | ACP plan update arrives (`"plan"`) | `PlanUpdate` | Render plan boards, track task progress |
| `mode:change` | Agent switches mode (`session/set_mode`) | `ModeChangeRequest` | Mode-aware policy changes (e.g. stricter rules in `compose` mode) |
| `mode:update` | Mode state update arrives (`"current_mode_update"`) | `ModeUpdate` | Sync UI with current agent mode |
| `commands:update` | Command palette changes (`"available_commands_update"`) | `CommandsUpdate` | Keep command lists in sync with external tools |
| `session:cancel` | User cancels the session (`session/cancel`) | `CancelEnvelope` | Clean up background work before the agent sees the cancel |
| `session:new` | A new session is created (`session/new`) | `NewSessionEnvelope` | Pre-configure transformers on a per-session basis |
| `session:load` | A cold session is resurrected (`session/load`) | `LoadSessionEnvelope` | Rehydrate state from disk when loading old sessions |
| `auth:required` | Agent auth challenge arrives (`authenticate`) | `AuthEnvelope` | Inject credentials into the auth flow |
| `agent:initialize` | Underlying agent sends its initialize capabilities | `AgentCapabilities` | Discover what the agent supports before the session starts |
| `agent:swap` | Compaction replaces the upstream agent (fires twice: `"pre"` then `"post"`) | `{ phase, previousUpstreamSessionId, upstreamSessionId?, agentId }` | Prepare for agent transition, re-register MCP tools on post-swap |
| `compaction` | Any compaction phase fires (`"started"`, `"iteration"`, `"deferred"`, `"swapped"`, `"failed"`, `"rolled_back"`) | `{ phase, ... }` | Monitor compaction progress, alert on failures |

## Return-value contract

Every hook handler can return `undefined`, a plain value, or a `Promise` of any of these shapes. The bridge translates them into wire-level actions:

| Return value | Wire action | Valid hooks |
|---|---|---|
| `undefined` / `void` | `continue` — pass through unchanged | every hook |
| `{ transform: envelope }` | `continue` with rewritten envelope | every request and response hook |
| `{ block: true, reason?: string }` | `stop` with synthesized denial | request hooks (`permission:pre`, `tool:permission`, `prompt:pre`, `mode:change`, `session:cancel`, `session:new`, `session:load`, `auth:required`) |
| `{ approve: true, optionId?: string }` | `stop` with synthesized approval (selects an option) | `permission:pre` and `tool:permission` only |
| `{ handled: true, reply: ContentBlock[] }` | `stop` with synthesized assistant reply (`"end_turn"`) | `prompt:pre` only |

Lifecycle hooks (`session:open`, `session:close`, `session:idle`, `permission:replied`, `tool:post`, `file:edited`, `agent:swap`, `compaction`) ignore return values — they're notifications. The SDK accepts a return for API uniformity but logs and discards it.

Async hooks automatically claim the call with `{ action: "processing" }` and send keep-alives until the Promise resolves. If the transformer doesn't discharge within the claim timeout, the daemon resumes the chain (fail-open).

## ctx API

Every hook handler receives a `ctx` as its second argument:

| Field | Description |
|---|---|
| `ctx.sessionId` | The hydra session id this event belongs to |
| `ctx.cwd` | The session's working directory |
| `ctx.logger` | Structured logger with `.debug()`, `.info()`, `.warn()`, `.error()` methods. Each call writes a timestamped line to stdout or stderr |
| `ctx.notify(level, message)` | Surface a notification to attached clients (UI, Slack, TUI) |
| `ctx.state` | Per-session `Map<string, unknown>` that survives across hook invocations but not daemon restarts — use it to carry state between calls |
| `ctx.signal` | An `AbortSignal` that fires when the session closes or the daemon shuts down the transformer — use it to cancel in-flight work |

The `setup` callback (see below) receives a `SetupContext` instead — same fields except `sessionId` and `cwd` are `undefined` since setup runs before any session is known.

## Config

Drop a JS module at `~/.hydra-acp/transformer.config.js` (override with `HYDRA_ACP_TRANSFORMER_CONFIG`). Default-export the result of `defineTransformer({ hooks: { ... } })`. The file supports `.ts`, `.mjs`, and `.cjs` extensions.

```js
// ~/.hydra-acp/transformer.config.js
import { defineTransformer } from "@hydra-acp/transformer";

export default defineTransformer({
  setup(ctx) {
    ctx.logger.info("transformer loaded");
  },
  hooks: {
    "permission:pre": async (event, ctx) => {
      // ...
    },
  },
});
```

A missing config file is a warning — the transformer idles without crashing. A malformed default export (no `defineTransformer` call, wrong shape) is also a non-fatal error that leaves the transformer idle.

## Environment

| Env var | Default | Purpose |
|---|---|---|
| `HYDRA_ACP_DAEMON_URL` | `http://127.0.0.1:55514` | HTTP base of the hydra daemon |
| `HYDRA_ACP_TOKEN` | *(required)* | Daemon auth token (injected by the daemon when spawned as a transformer) |
| `HYDRA_ACP_WS_URL` | derived from `HYDRA_ACP_DAEMON_URL` | WebSocket endpoint override |
| `HYDRA_ACP_TRANSFORMER_NAME` | *(set by daemon)* | Presence triggers transformer mode; its value is the client name in the initialize handshake |
| `HYDRA_ACP_TRANSFORMER_CONFIG` | `~/.hydra-acp/transformer.config.js` | Absolute path to an alternate config file |
| `DEBUG` | `false` | Verbose logging (emits `.debug()` calls) |

## Hot reload

Sending `SIGHUP` to the transformer process re-imports the config file and atomically swaps the live hook set. In-flight hook invocations complete with their old closures; new invocations use the fresh hooks. Errors during reload leave the previous hook set in place — the transformer never runs without hooks after a failed reload.

The host binary also picks up `SIGHUP` automatically when spawned by the daemon. Manual trigger:

```sh
kill -HUP $(pgrep -f hydra-acp-transformer)
```

## CLI flags

When `HYDRA_ACP_TRANSFORMER_NAME` is not set, the binary runs in CLI mode:

| Flag | Effect |
|---|---|
| `--version` | Print the package version and exit |
| `--help` | Print usage information and exit |
| `--validate <path>` | Load a config file at `<path>` via jiti and check that it exports a valid transformer definition. Exits 0 on success, 1 with an error message on failure |

## Status

Version 0.0.1 — expect API drift before 0.1.0. Hook names, payload shapes, and the return-value contract are stable enough for experimentation but may change in minor releases until the first 0.1.0 tag.

## License

MIT.
