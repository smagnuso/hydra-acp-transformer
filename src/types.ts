// Typed payload shapes for every hook event in the catalog.
// Wire shapes follow PROTOCOL.md § "Transformer-only methods" and
// § "session/update — compaction lifecycle". Where a precise shape
// isn't documented, use Record<string, unknown> with an open-object
// comment. No runtime code — types only.

import type { Logger } from "./util/log.js";

// ── ACP envelope shapes (what the daemon actually sends) ──────────────

/** Flat session/prompt params sent to `request:session/prompt`. */
export interface PromptEnvelope {
  sessionId: string;
  prompt: Array<ContentBlock>;
  _meta?: Record<string, unknown>;
}

/** One content block inside a prompt array. Minimal shape — agents
 *  may include image/audio/resource fields we don't care about here. */
export interface ContentBlock {
  type?: string;
  text?: string;
}

/** Flat session/request_permission params sent to `request:session/request_permission`.
 *  Mirror of the ACP spec's PermissionRequest params plus Hydra extras. */
export interface PermissionEnvelope {
  sessionId: string;
  toolCall: ToolCallBase;
  options: Array<PermissionOption>;
  _meta?: Record<string, unknown>;
}

/** Minimal tool call info from a permission request. Extracted from
 *  the full `toolCall` object so hooks can inspect without knowing
 *  every agent-specific field. */
export interface ToolCallBase {
  toolCallId?: string;
  name?: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path?: string }>;
}

/** One allow/reject option the daemon sends in a permission request. */
export interface PermissionOption {
  kind?: string;
  optionId?: string;
}

// ── session/update subtypes (response chain) ──────────────────────────

/** sessionUpdate === "tool_call" — first sighting of a tool invocation.
 *  The envelope is `{ sessionId, update: { sessionUpdate, … } }`. */
export interface ToolCall {
  toolCallId: string;
  name?: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path?: string }>;
  [key: string]: unknown; // open — agents may add fields
}

/** sessionUpdate === "tool_call_update" — status/args/content update.
 *  Non-terminal (status not "completed"/"failed") fires `tool:progress`. */
export interface ToolCallUpdate {
  toolCallId: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path?: string }>;
  [key: string]: unknown; // open
}

/** sessionUpdate === "agent_message_chunk" | "agent_thought_chunk" |
 *  "user_message_chunk". All three hooks share the same payload shape. */
export interface MessageChunk {
  content?: ContentBlock;
  [key: string]: unknown; // open — may carry _meta, messageId, etc.
}

/** sessionUpdate === "plan". ACP plan envelope with checklist entries. */
export interface PlanUpdate {
  entries?: Array<PlanEntry>;
  [key: string]: unknown; // open — may carry _meta, sessionId context
}

export interface PlanEntry {
  content?: string;
  status?: string;
  priority?: string;
}

/** sessionUpdate === "current_mode_update". Mode transition info. */
export interface ModeUpdate {
  mode?: string;
  [key: string]: unknown; // open
}

/** sessionUpdate === "available_commands_update". Command palette update. */
export interface CommandsUpdate {
  commands?: Array<{ name: string; description?: string }>;
  [key: string]: unknown; // open
}

// ── Request-side envelopes (client→agent direction) ───────────────────

/** session/cancel params. ACP cancel is a notification, not a request. */
export interface CancelEnvelope {
  sessionId: string;
  _meta?: Record<string, unknown>;
}

/** session/new params with hydra-acp extensions. */
export interface NewSessionEnvelope {
  cwd?: string;
  mcpServers?: unknown[];
  _meta?: {
    "hydra-acp"?: {
      agentId?: string;
      title?: string;
      agentArgs?: string[];
      transformers?: string[];
      model?: string;
      mcpStdin?: boolean;
      interactive?: boolean;
      resume?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

/** session/load params. */
export interface LoadSessionEnvelope {
  sessionId: string;
  _meta?: {
    "hydra-acp"?: {
      readonly?: boolean;
      replayMode?: "instant" | "drip";
      dripSpeed?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

/** session/set_mode params. */
export interface ModeChangeRequest {
  sessionId: string;
  mode: string;
  _meta?: Record<string, unknown>;
}

/** authenticate params (client → agent auth challenge). */
export interface AuthEnvelope {
  challenge?: string;
  [key: string]: unknown; // open — varies by auth mechanism
}

// ── Lifecycle event payloads ──────────────────────────────────────────

/** session:open, session:close, session:idle — all fire empty payloads. */
export type SessionIdlePayload = {};

/** lifecycle:permission.replied */
export interface PermissionRepliedPayload {
  toolCallId: string;
  outcome: Record<string, unknown>;
  sourceWasTransformer: boolean;
}

/** lifecycle:tool.completed */
export interface ToolCompletedPayload {
  toolCallId: string;
  status: "completed" | "failed";
  kind?: string;
  content?: unknown;
  locations?: Array<{ path?: string }>;
}

/** lifecycle:file.edited */
export interface FileEditedPayload {
  path: string;
  toolCallId: string;
  line?: number;
}

/** lifecycle:agent.swap */
export interface AgentSwapPayload {
  phase: "pre" | "post";
  previousUpstreamSessionId: string;
  upstreamSessionId?: string;
  agentId?: string;
}

/** lifecycle:compaction — mirrors every broadcastCompactionPhase call. */
export interface CompactionPayload {
  phase:
    | "started"
    | "iteration"
    | "deferred"
    | "swapped"
    | "failed"
    | "rolled_back";
  [key: string]: unknown; // phase-specific fields
}

/** agent:initialize — the underlying agent's capability claim, forwarded
 *  verbatim from its own initialize response. */
export interface AgentCapabilities {
  sessionCapabilities?: Record<string, unknown>;
  [key: string]: unknown; // open — agent-defined
}

// ── Context interfaces ────────────────────────────────────────────────

/** Per-hook invocation context. Passed as the second argument to every
 *  hook handler. */
export interface Context {
  sessionId: string;
  cwd: string;
  logger: Logger;
  notify(level: "info" | "warn" | "error", message: string): void;
  state: Map<string, unknown>;
  signal: AbortSignal;
}

/** Context available during setup (before any session is known). */
export interface SetupContext extends Omit<Context, "sessionId" | "cwd"> {
  sessionId: undefined;
  cwd: undefined;
}

// ── Return-value shapes ───────────────────────────────────────────────

/** Transformer short-circuits a request with a denial. Valid on request hooks
 *  (e.g. permission:pre, prompt:pre). The bridge encodes this as action=stop
 *  with a hook-appropriate synthesized payload. */
export interface BlockReturn {
  block: true;
  reason?: string;
}

/** Transformer rewrites the envelope and lets the chain continue. Payload
 *  shape depends on the hook (e.g. a prompt envelope, a tool_call_update). */
export interface TransformReturn {
  transform: unknown;
}

/** Transformer short-circuits a permission request with approval. */
export interface ApproveReturn {
  approve: true;
  optionId?: string;
}

/** Transformer short-circuits prompt:pre with a synthesized reply. */
export interface HandledReturn {
  handled: true;
  reply: ContentBlock[];
}

/** Generic hook return type — every handler can return undefined (continue),
 *  a BlockReturn, ApproveReturn, or HandledReturn, or a Promise of any. */
export type HookReturn =
  | undefined
  | void
  | BlockReturn
  | TransformReturn
  | ApproveReturn
  | HandledReturn;

// ── Transformer spec (re-exported for test imports) ───────────────────────

/** User-facing transformer spec — mirrors bridge.ts to avoid circular imports. */
export interface TransformerSpec {
  setup?: (ctx: SetupContext) => void | Promise<void>;
  hooks: Partial<HookHandlers>;
}

type HookHandlers = Partial<{
  [K in import("./hooks/catalog.js").HookName]: (
    event: unknown,
    ctx: Context,
  ) => unknown | Promise<unknown>;
}>;
