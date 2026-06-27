// Library entry point for @hydra-acp/transformer.
// Exports defineTransformer / runTransformer plus every type a consumer needs.

import { HOOK_CATALOG, type HookName } from "./hooks/catalog.js";
import type { Logger } from "./util/log.js";
import type {
  PromptEnvelope,
  PermissionEnvelope,
  ToolCall,
  ToolCallUpdate,
  MessageChunk,
  PlanEntry,
  PlanUpdate,
  ModeUpdate,
  CommandsUpdate,
  CancelEnvelope,
  NewSessionEnvelope,
  LoadSessionEnvelope,
  ModeChangeRequest,
  AuthEnvelope,
  SessionIdlePayload,
  PermissionRepliedPayload,
  ToolCompletedPayload,
  FileEditedPayload,
  AgentSwapPayload,
  CompactionPayload,
  AgentCapabilities,
  Context,
  SetupContext,
  BlockReturn,
  TransformReturn,
  ApproveReturn,
  HandledReturn,
  HookReturn,
} from "./types.js";

// ── Event payload lookup (avoids a gnarly mapped-type across 25 hooks) ──

interface TransformerEvents {
  "session:open": SessionIdlePayload;
  "session:close": SessionIdlePayload;
  "session:idle": SessionIdlePayload;
  "prompt:pre": PromptEnvelope;
  "permission:pre": PermissionEnvelope;
  "tool:permission": PermissionEnvelope;
  "permission:replied": PermissionRepliedPayload;
  "tool:start": ToolCall;
  "tool:progress": ToolCallUpdate;
  "tool:post": ToolCompletedPayload;
  "file:edited": FileEditedPayload;
  "message:assistant": MessageChunk;
  "message:thought": MessageChunk;
  "message:user": MessageChunk;
  "plan:update": PlanUpdate;
  "mode:change": ModeChangeRequest;
  "mode:update": ModeUpdate;
  "commands:update": CommandsUpdate;
  "session:cancel": CancelEnvelope;
  "session:new": NewSessionEnvelope;
  "session:load": LoadSessionEnvelope;
  "auth:required": AuthEnvelope;
  "agent:initialize": AgentCapabilities;
  "agent:swap": AgentSwapPayload;
  compaction: CompactionPayload;
}

// ── Hook handler type per hook name ────────────────────────────────────────

type HookHandlers = Partial<{
  [K in HookName]: (
    event: TransformerEvents[K],
    ctx: Context,
  ) => HookReturn | Promise<HookReturn>;
}>;

// ── User-facing spec ────────────────────────────────────────────────────────

export interface TransformerSpec {
  setup?: (ctx: SetupContext) => void | Promise<void>;
  hooks: Partial<HookHandlers>;
}

// ── Opaque definition ──────────────────────────────────────────────────────

const __brand = Symbol("TransformerDefinition");

interface TransformerDefinition {
  readonly [__brand]: "TransformerDefinition";
}

/**
 * Wrap a user-provided spec into an opaque TransformerDefinition.
 *
 * Validates hook names against the catalog at registration time so that
 * typos (e.g. "tool:complete" instead of "tool:post") are caught during
 * module initialization rather than silently swallowed at runtime.
 */
export function defineTransformer(
  spec: TransformerSpec,
): TransformerDefinition {
  const hooks = spec.hooks;

  if (hooks) {
    for (const key of Object.keys(hooks)) {
      if (!(key in HOOK_CATALOG)) {
        throw new Error(
          `unknown hook name "${String(key)}"; expected one of: ${Object.keys(HOOK_CATALOG).join(", ")}`,
        );
      }
    }
  }

  const wrapped = spec as unknown as TransformerDefinition;
  Object.defineProperty(wrapped, __brand, {
    value: "TransformerDefinition" as const,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return wrapped;
}

// ── Bridge and runTransformer (T8) ────────────────────────────────────────

export { TransformerBridge, runTransformer } from "./bridge.js";

// ── Re-exports (all types a consumer needs) ────────────────────────────────

export type {
  HookName,
  Logger,
  Context,
  SetupContext,
  BlockReturn,
  TransformReturn,
  ApproveReturn,
  HandledReturn,
  HookReturn,
  PromptEnvelope,
  PermissionEnvelope,
  ToolCall,
  ToolCallUpdate,
  MessageChunk,
  PlanUpdate,
  PlanEntry,
  ModeUpdate,
  CommandsUpdate,
  CancelEnvelope,
  NewSessionEnvelope,
  LoadSessionEnvelope,
  ModeChangeRequest,
  AuthEnvelope,
  SessionIdlePayload,
  PermissionRepliedPayload,
  ToolCompletedPayload,
  FileEditedPayload,
  AgentSwapPayload,
  CompactionPayload,
  AgentCapabilities,
};
