import { type HookName } from "./catalog.js";

// Hooks whose intercepts are lifecycle events — notifications with no
// response to return.  The SDK accepts any return for API uniformity but
// silently discards it.
const LIFECYCLE_HOOKS: ReadonlySet<HookName> = new Set([
  "session:open",
  "session:close",
  "session:idle",
  "permission:replied",
  "tool:post",
  "file:edited",
  "agent:swap",
  "compaction",
  "agent:initialize",
]);

// Hooks whose intercepts are request-side — the chain has a response to
// return.  These accept transform, block, and hook-specific shapes.
const REQUEST_HOOKS: ReadonlySet<HookName> = new Set([
  "prompt:pre",
  "permission:pre",
  "tool:permission",
  "mode:change",
  "session:cancel",
  "session:new",
  "session:load",
  "auth:required",
]);

// Hooks that may return { approve } — permission hooks only.
const APPROVE_HOOKS = new Set(["permission:pre", "tool:permission"]);

// Hooks that may return { handled } — prompt:pre only.
const HANDLED_HOOKS = new Set(["prompt:pre"]);

// Shape of a transform envelope the user wants to inject into the chain.
export interface TransformReturn {
  transform: unknown;
}

// Shape for blocking / denying an in-flight request.
export interface BlockReturn {
  block: true;
  reason?: string;
}

// Shape for auto-approving a permission request (no user interaction).
export interface ApproveReturn {
  approve: true;
  optionId?: string;
}

// Shape for handling a prompt entirely on the transformer side.
export interface HandledReturn {
  handled: true;
  reply: unknown;
}

/** Result of encoding a hook return value into a wire action. */
export interface EncodedReturn {
  action: "continue" | "stop";
  payload?: unknown;
}

/**
 * Encode a user-hook return value into a wire-level { action, payload }.
 *
 * Lifecycle hooks accept any return without throwing (the bridge discards
 * it).  Request hooks validate against the hook-specific shape allowlist.
 * Response hooks accept only undefined and transform.
 *
 * @param hookName   — typed hook name from the catalog.
 * @param returnValue — what the user's hook handler returned.
 * @param debugLog   — optional logger for non-fatal warnings (approve
 *                     defaulting, lifecycle non-undefined).
 */
export function encodeHookReturn(
  hookName: HookName,
  returnValue: unknown,
  debugLog?: { warn(...args: unknown[]): void },
): EncodedReturn {
  // --- Lifecycle hooks: accept anything, discard silently. ---
  if (LIFECYCLE_HOOKS.has(hookName)) {
    if (returnValue !== undefined) {
      debugLog?.warn(
        `lifecycle hook "${hookName}" returned a value — ignored`,
      );
    }
    return { action: "continue" };
  }

  const ret = returnValue as Record<string, unknown> | undefined;

  // --- transform — valid on every request and response hook. ---
  if (ret?.transform !== undefined) {
    return { action: "continue", payload: ret.transform };
  }

  // --- block — valid on request hooks only. ---
  if (ret?.block === true) {
    if (!REQUEST_HOOKS.has(hookName)) {
      debugLog?.warn(
        `block is not valid for hook "${hookName}" — only request hooks accept it`,
      );
      // Fall through to unknown-shape handler below.
    } else if (hookName === "permission:pre" || hookName === "tool:permission") {
      return { action: "stop", payload: { outcome: { outcome: "cancelled" } } };
    } else {
      return { action: "stop", payload: { stopReason: "stopped" } };
    }
  }

  // --- approve — ONLY permission hooks. ---
  if (ret?.approve === true) {
    if (!APPROVE_HOOKS.has(hookName)) {
      throw new Error(
        `approve is not valid for hook "${hookName}"; only permission:pre and tool:permission accept it`,
      );
    }
    const optionId = ret.optionId ?? "allow";
    if (ret.optionId === undefined) {
      debugLog?.warn(
        `approve returned without optionId for "${hookName}" — defaulting to 'allow'; be explicit`,
      );
    }
    return { action: "stop", payload: { outcome: { outcome: "selected", optionId } } };
  }

  // --- handled — ONLY prompt:pre. ---
  if (ret?.handled === true) {
    if (!HANDLED_HOOKS.has(hookName)) {
      throw new Error(
        `handled is not valid for hook "${hookName}"; only prompt:pre accepts it`,
      );
    }
    return { action: "stop", payload: { stopReason: "end_turn" } };
  }

  // --- Unknown shape on a non-lifecycle hook. ---
  if (returnValue !== undefined) {
    throw new Error(
      `invalid return value for hook "${hookName}": expected undefined, { transform }, { block }, { approve }, or { handled }; got ${JSON.stringify(returnValue)}`,
    );
  }

  // undefined — pass through.
  return { action: "continue" };
}
