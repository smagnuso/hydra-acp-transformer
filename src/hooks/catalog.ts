import {
  toolStartFilter,
  toolProgressFilter,
  messageAssistantFilter,
  messageThoughtFilter,
  messageUserFilter,
  planUpdateFilter,
  modeUpdateFilter,
  commandsUpdateFilter,
} from "./filter.js";

export const HOOK_CATALOG = {
  // Out-of-chain "session is coming to life" broadcast. Fires on
  // session/new AND resurrect from cold, once per session bring-up,
  // BEFORE the agent produces events. The daemon dispatches to every
  // subscribed transformer regardless of chain membership — so this
  // is the correct hook for opt-in-per-session patterns (e.g. "if I
  // have persisted state for this session, join its chain").
  //
  // Typical handler shape:
  //   async (_event, ctx) => {
  //     const activated = await ctx.extensionState.get("activated");
  //     if (!activated) return;
  //     await ctx.attach();          // join the chain going forward
  //     await ctx.refreshMcpTools(); // close the resurrect race
  //   }
  //
  // Fires BEFORE `session:open` (which is chain-scoped and only
  // reaches transformers already attached).
  "session:starting": { intercept: "lifecycle:session.starting" },
  "session:open": { intercept: "lifecycle:session.opened" },
  "session:close": { intercept: "lifecycle:session.closed" },
  "session:idle": { intercept: "lifecycle:session.idle" },
  "prompt:pre": { intercept: "request:session/prompt" },
  "permission:pre": { intercept: "request:session/request_permission" },
  "tool:permission": { intercept: "request:session/request_permission" },
  "permission:replied": { intercept: "lifecycle:permission.replied" },
  "tool:start": {
    intercept: "response:session/update",
    filter: toolStartFilter,
  },
  "tool:progress": {
    intercept: "response:session/update",
    filter: toolProgressFilter,
  },
  "tool:post": { intercept: "lifecycle:tool.completed" },
  "file:edited": { intercept: "lifecycle:file.edited" },
  "message:assistant": {
    intercept: "response:session/update",
    filter: messageAssistantFilter,
  },
  "message:thought": {
    intercept: "response:session/update",
    filter: messageThoughtFilter,
  },
  "message:user": {
    intercept: "response:session/update",
    filter: messageUserFilter,
  },
  "plan:update": {
    intercept: "response:session/update",
    filter: planUpdateFilter,
  },
  "mode:change": { intercept: "request:session/set_mode" },
  "mode:update": {
    intercept: "response:session/update",
    filter: modeUpdateFilter,
  },
  "commands:update": {
    intercept: "response:session/update",
    filter: commandsUpdateFilter,
  },
  "session:cancel": { intercept: "request:session/cancel" },
  "session:new": { intercept: "request:session/new" },
  "session:load": { intercept: "request:session/load" },
  "auth:required": { intercept: "request:authenticate" },
  "agent:initialize": { intercept: "agent:initialize" },
  "agent:swap": { intercept: "lifecycle:agent.swap" },
  compaction: { intercept: "lifecycle:compaction" },
} as const;

export type HookName = keyof typeof HOOK_CATALOG;
