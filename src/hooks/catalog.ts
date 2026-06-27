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
