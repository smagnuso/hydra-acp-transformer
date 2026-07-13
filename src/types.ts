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

// ── Slash-command shapes (hydra-acp/commands/register + invoke) ──────

/** Specification for a slash command registered via ctx.registerCommand(). */
export interface CommandSpec {
  verb: string;
  description: string;
  argsHint?: string;
}

/** Invocation delivered to a command handler when the daemon dispatches
 *  hydra-acp/commands/invoke. Mirrors the wire shape from PROTOCOL.md. */
export interface CommandInvocation {
  verb: string;
  argv: string[];
  sessionId: string;
  messageId?: string;
}

/** Result returned by a command handler. The bridge encodes this as the
 *  commands/invoke reply — { text } for non-empty messages, {} for silent. */
export interface CommandResult {
  ok: boolean;
  message?: string;
}

/** Handler function for a registered slash command. Receives the parsed
 *  invocation and a per-session Context. */
export type CommandHandler = (
  inv: CommandInvocation,
  ctx: Context,
) => Promise<CommandResult>;

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
 /** Send a generic RPC request to the daemon and await its response.
    *  Thin wrapper over the internal client.request() that preserves
    *  session context via _meta.hydra-acp.sessionId. */
   rpc(method: string, params?: unknown): Promise<unknown>;
   /** Register a slash command with the daemon. The spec is advertised
    *  on WS open (initial connect and after SIGHUP reload). Invocations
    *  arrive as hydra-acp/commands/invoke requests and are dispatched
    *  to this handler. Safe to call from setup or any hook. */
   registerCommand(spec: CommandSpec, handler: CommandHandler): void;
  /** Emit an assistant-visible message into the current session.
    *  Uses `hydra-acp/message/emit` with route "daemon" under the hood.
    *  Errors are suppressed — this is fire-and-forget; callers should
    *  also surface critical info via the command return value. */
   emitMessage(text: string): Promise<void>;
    /** Fetch against the hydra daemon. If pathOrUrl starts with "/" the
    *  daemon base URL is prepended. The Authorization: Bearer <token>
    *  header is injected unless the caller sets one in init.headers.
    *  Non-2xx responses are NOT thrown — caller decides. */
    fetch(pathOrUrl: string, init?: RequestInit): Promise<Response>;
    /** Per-session, per-extension durable key-value store. Persisted to
    *  the session's meta.json by the daemon; survives daemon and
    *  transformer restarts, follows the session across cold/warm
    *  cycles. Reset to empty on user-visible session forks; preserved
    *  across compaction swaps.
    *
    *  Namespaced by the calling extension: the daemon derives the
    *  extension name from the connection's identity, so extensions
    *  can only read/write their own keys — no way to touch another
    *  extension's state, no way to spoof.
    *
    *  Use for small pieces of durable per-session state: activation
    *  flags, policy decisions, spend carryover, last-seen markers,
    *  etc. Total per-extension bucket is capped at 64KB; a set() that
    *  would exceed the cap rejects with an actionable error.
    */
    extensionState: ExtensionStateApi;
  }

/** Context available during setup (before any session is known). */
export interface SetupContext extends Omit<Context, "sessionId" | "cwd" | "extensionState"> {
  sessionId: undefined;
  cwd: undefined;
}

/** Per-session, per-extension durable key-value store. See Context.extensionState. */
export interface ExtensionStateApi {
  /** Read one key. Resolves to undefined when the key isn't set. */
  get(key: string): Promise<unknown>;
  /** Read the caller extension's full bucket for this session. */
  list(): Promise<Record<string, unknown>>;
  /** Write one key. Rejects on size-cap violations (64KB per bucket). */
  set(key: string, value: unknown): Promise<void>;
  /** Remove one key. No-op when the key or bucket doesn't exist. */
  delete(key: string): Promise<void>;
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
