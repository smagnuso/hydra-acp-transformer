import { EventEmitter } from "node:events";
import { TransformerClient } from "./acp/transformer.js";
import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
} from "./acp/protocol.js";
import { logger } from "./util/log.js";
import { HOOK_CATALOG, type HookName } from "./hooks/catalog.js";
import { encodeHookReturn } from "./hooks/contract.js";
import type { CommandHandler, CommandInvocation, CommandResult, CommandSpec, Context, SetupContext } from "./types.js";

const log = logger("bridge");

/** Default claim timeout (ms) — mirrors daemon's TRANSFORMER_CLAIM_TIMEOUT_MS. */
const DEFAULT_CLAIM_TIMEOUT_MS = 30_000;

/** Threshold: if a hook promise hasn't resolved within this time, send "processing". */
const EARLY_RESOLVE_THRESHOLD_MS = 20;

// ── Internal types ────────────────────────────────────────────────────────

/** Minimal surface the bridge uses on its TransformerClient. */
export interface BridgeClient {
  request<R = unknown>(method: string, params?: unknown): Promise<R>;
  reply(id: JsonRpcId, result: unknown): void;
  notify(method: string, params?: unknown): void;
  start(): void;
  stop(): void;
  /** Test seam: lets the bridge pass computed intercepts for handshake. */
  setIntercepts?(intercepts: string[]): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (info: { hadError: boolean }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "request", listener: (req: JsonRpcRequest) => void): unknown;
  on(
    event: "notification",
    listener: (note: JsonRpcNotification) => void,
  ): unknown;
}

interface BridgeOptions {
  daemonWsUrl: string;
  httpUrl: string;
  token: string;
  clientName: string;
  definition: TransformerSpec;
  claimTimeoutMs?: number;
  /** Test seam: when provided, the bridge uses this instead of creating a real client. */
  client?: BridgeClient;
  /** Test seam: when provided, the bridge uses this for ctx.fetch instead of globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
}

/** User-facing transformer spec — mirrors lib.ts to avoid circular imports. */
interface TransformerSpec {
  setup?: (ctx: SetupContext) => void | Promise<void>;
  hooks: Partial<HookHandlers>;
}

type HookHandlers = Partial<{
  [K in HookName]: (
    event: unknown,
    ctx: Context,
  ) => unknown | Promise<unknown>;
}>;

/** Registry of which hooks subscribe to which wire intercepts. */
const HOOK_INTERCEPT_MAP = buildInterceptMap();

function buildInterceptMap(): Map<HookName, string> {
  const map = new Map<HookName, string>();
  for (const [name, entry] of Object.entries(HOOK_CATALOG)) {
    map.set(name as HookName, entry.intercept);
  }
  return map;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Internal wrapper — stores the Context alongside its AbortController so
 *  we can abort signals when a session closes or the connection drops. */
interface SessionEntry {
  ctx: Context;
  ac: AbortController;
}

/** Build a per-session Context from a sessionId. */
function createContext(
  sessionId: string,
  options: {
    logger: import("./util/log.js").Logger;
    rpc?: (method: string, params?: unknown) => Promise<unknown>;
    registerCommand?: (spec: CommandSpec, handler: CommandHandler) => void;
    httpUrl?: string;
    token?: string;
    fetchFn?: typeof globalThis.fetch;
  },
): SessionEntry {
  const ac = new AbortController();
  return {
    ac,
    ctx: {
      sessionId,
      cwd: "",
      logger: options.logger,
      notify(level, message) {
        options.logger[level](message);
      },
      state: new Map(),
      signal: ac.signal,
      rpc(method, params) {
        return options.rpc?.(method, params) ?? Promise.resolve(undefined);
      },
      registerCommand(spec, handler) {
        options.registerCommand?.(spec, handler);
      },
      emitMessage(text: string) {
        // Fire-and-forget: emit an assistant-visible message into the
        // current session using hydra-acp/message/emit with route "daemon".
        // Errors are suppressed — callers should also surface critical info
        // via the command return value.
        options.rpc?.("hydra-acp/message/emit", {
          sessionId,
          method: "session/prompt",
          envelope: {
            sessionId,
            prompt: [{ type: "text", text }],
          },
          route: "daemon",
        }).catch(() => void 0);
        return Promise.resolve();
      },
      async fetch(pathOrUrl, init) {
        const base = options.httpUrl;
        const url = base && pathOrUrl.startsWith("/")
          ? `${base.replace(/\/$/, "")}${pathOrUrl}`
          : pathOrUrl;
        const headers = new Headers(init?.headers);
        if (!headers.has("Authorization") && base) {
          headers.set("Authorization", `Bearer ${options.token ?? ""}`);
        }
        return (options.fetchFn ?? globalThis.fetch)(url, { ...init, headers });
      },
      extensionState: {
        async get(key: string): Promise<unknown> {
          const res = (await options.rpc?.(
            "hydra-acp/session/extension_state/get",
            { sessionId, key },
          )) as { value?: unknown } | undefined;
          return res?.value ?? undefined;
        },
        async list(): Promise<Record<string, unknown>> {
          const res = (await options.rpc?.(
            "hydra-acp/session/extension_state/list",
            { sessionId },
          )) as { state?: Record<string, unknown> } | undefined;
          return res?.state ?? {};
        },
        async set(key: string, value: unknown): Promise<void> {
          await options.rpc?.(
            "hydra-acp/session/extension_state/set",
            { sessionId, key, value },
          );
        },
        async delete(key: string): Promise<void> {
          await options.rpc?.(
            "hydra-acp/session/extension_state/delete",
            { sessionId, key },
          );
        },
      },
      async attach(): Promise<void> {
        await options.rpc?.("hydra-acp/transformer/attach", { sessionId });
      },
      async refreshMcpTools(): Promise<void> {
        await options.rpc?.("hydra-acp/mcp_tools/refresh_session", {
          sessionId,
        });
      },
    },
  };
}

/** Compute the union of wire intercepts from registered hook names. */
function computeIntercepts(hookNames: HookName[]): string[] {
  const set = new Set<string>();
  for (const name of hookNames) {
    const intercept = HOOK_INTERCEPT_MAP.get(name);
    if (intercept) set.add(intercept);
  }
  return [...set];
}

// ── TransformerBridge ─────────────────────────────────────────────────────

export class TransformerBridge extends EventEmitter {
  private client: BridgeClient;
  private readonly claimTimeoutMs: number;
  private readonly sessions = new Map<string, SessionEntry>();

  // Hook name → hook handler function. Populated from the user spec.
  private hooksByName = new Map<HookName, (event: unknown, ctx: Context) => unknown | Promise<unknown>>();

  // Intercept string → array of (hookName, filter?) tuples that subscribe to it.
  private interceptHandlers = new Map<string, Array<{ name: HookName; filter?: (envelope: unknown) => boolean }>>();

  // Active keep-alive intervals keyed by sessionId (for async claim management).
  private readonly keepAliveTimers = new Map<string, ReturnType<typeof setInterval>>();

  // Registered slash commands: verb → { spec, handler }. Populated via
  // ctx.registerCommand() from setup or any hook. Re-sent on every WS open.
  private registeredCommands = new Map<string, { spec: CommandSpec; handler: CommandHandler }>();

  constructor(private readonly opts: BridgeOptions) {
    super();

    this.claimTimeoutMs = opts.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;

    // Store the setup callback separately from hooks.
    const setupFn = opts.definition.setup;

    // Populate hook registries from the user spec.
    const registeredHooks = opts.definition.hooks;
    if (registeredHooks) {
      for (const [key, handler] of Object.entries(registeredHooks)) {
        const name = key as HookName;
        if (!(name in HOOK_CATALOG)) continue;

        this.hooksByName.set(name, handler as (event: unknown, ctx: Context) => unknown | Promise<unknown>);

        const intercept = HOOK_INTERCEPT_MAP.get(name)!;
        const entry = HOOK_CATALOG[name];
        const filter = "filter" in entry ? entry.filter : undefined;

        const arr = this.interceptHandlers.get(intercept) ?? [];
        arr.push({ name, filter });
        this.interceptHandlers.set(intercept, arr);
      }
    }

    // Build the TransformerClient with only the intercepts we actually need.
    const hookNames = [...this.hooksByName.keys()];
    const intercepts = computeIntercepts(hookNames);

    this.client =
      opts.client ??
      new TransformerClient({
        daemonWsUrl: opts.daemonWsUrl,
        token: opts.token,
        intercepts,
        clientName: opts.clientName,
      });

    // Test seam: pass computed intercepts to injected fake clients so they
    // can include them in their simulated handshake.
    if (opts.client && typeof opts.client.setIntercepts === "function") {
      opts.client.setIntercepts(intercepts);
    }

    // Wire up internal event handlers.
    this.client.on("open", () => {
      log.info("WS connected, handshake complete");
      void this.handleOpen(setupFn);
      void this.registerCommands();
    });

    this.client.on("close", ({ hadError }) => {
      log.info(`WS closed (hadError=${hadError})`);
      this.clearKeepAliveTimers();
      this.abortAllSessions();
      this.emit("disconnected", { hadError });
    });

    this.client.on("error", (err) => {
      log.error("client error:", err.message);
      this.emit("error", err);
    });

    this.client.on("request", (req) => {
      try {
        this.handleRequest(req);
      } catch (err) {
        log.error("handleRequest threw:", (err as Error).message);
      }
    });
    this.client.on("notification", (note) => {
      try {
        this.handleNotification(note);
      } catch (err) {
        log.error("handleNotification threw:", (err as Error).message);
      }
    });
  }

  private clearKeepAliveTimers(): void {
    for (const timer of this.keepAliveTimers.values()) {
      clearInterval(timer);
    }
    this.keepAliveTimers.clear();
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.clearKeepAliveTimers();
    this.abortAllSessions();
    this.client.stop();
  }

  /** Replace the hook definition and restart with updated intercepts.
   *
   *  Stops the current WS connection, rebuilds it with the new
   *  intercept set, and starts it again. In-flight processing claims
   *  complete with their original handler closures (they were captured
   *  at dispatch time). The WS briefly reconnects — daemon-side
   *  `addTransformer` re-subscribes intercepts on the fresh connection. */
  replaceDefinition(newDef: TransformerSpec): TransformerBridge {
    log.info("replacing transformer hook definition");
    this.stop();

    // Reconstruct with a fresh client using updated intercepts.
    // Preserve test-seam client if one was injected.
    const newClient =
      this.opts.client ??
      new TransformerClient({
        daemonWsUrl: this.opts.daemonWsUrl,
        token: this.opts.token,
        intercepts: computeIntercepts(
          Object.keys(newDef.hooks ?? {}).filter(
            (k): k is HookName => k in HOOK_CATALOG,
          ),
        ),
        clientName: this.opts.clientName,
      });

    // Rebuild hook registries from the new definition.
    const newHooksByName = new Map<
      HookName,
      (event: unknown, ctx: Context) => unknown | Promise<unknown>
    >();
    const newInterceptHandlers = new Map<
      string,
      Array<{ name: HookName; filter?: (envelope: unknown) => boolean }>
    >();

    if (newDef.hooks) {
      for (const [key, handler] of Object.entries(newDef.hooks)) {
        const name = key as HookName;
        if (!(name in HOOK_CATALOG)) continue;

        newHooksByName.set(
          name,
          handler as (event: unknown, ctx: Context) => unknown | Promise<unknown>,
        );

        const intercept = HOOK_INTERCEPT_MAP.get(name)!;
        const entry = HOOK_CATALOG[name];
        const filter = "filter" in entry ? entry.filter : undefined;

        const arr = newInterceptHandlers.get(intercept) ?? [];
        arr.push({ name, filter });
        newInterceptHandlers.set(intercept, arr);
      }
    }

    this.hooksByName = newHooksByName;
    this.interceptHandlers = newInterceptHandlers;
    this.client = newClient as unknown as BridgeClient;

    // Re-wire internal event handlers on the fresh client.
    this.client.on("open", () => {
      log.info("WS connected, handshake complete");
      void this.handleOpen(newDef.setup);
      void this.registerCommands();
    });
    this.client.on("close", ({ hadError }) => {
      log.info(`WS closed (hadError=${hadError})`);
      this.abortAllSessions();
      this.emit("disconnected", { hadError });
    });
    this.client.on("error", (err) => {
      log.error("client error:", err.message);
      this.emit("error", err);
    });
    this.client.on("request", (req) => {
      try {
        this.handleRequest(req);
      } catch (err) {
        log.error("handleRequest threw:", (err as Error).message);
      }
    });
    this.client.on("notification", (note) => {
      try {
        this.handleNotification(note);
      } catch (err) {
        log.error("handleNotification threw:", (err as Error).message);
      }
    });

    this.client.start();
    return this;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  private async handleOpen(setupFn?: (ctx: SetupContext) => void | Promise<void>): Promise<void> {
    if (!setupFn) return;

    const bridge = this;
    const ctx: SetupContext = {
       sessionId: undefined,
       cwd: undefined,
       logger: log,
       notify(level, message) {
         log[level](message);
       },
       state: new Map(),
       signal: new AbortController().signal,
       rpc(method, params) {
         return bridge.rpc(method, params);
       },
       registerCommand(spec, handler) {
         bridge.registerCommand(spec, handler);
       },
       emitMessage(_text: string) {
         // No session during setup — no-op.
         return Promise.resolve();
       },
       async fetch(pathOrUrl, init) {
         const url = pathOrUrl.startsWith("/") ? `${bridge.opts.httpUrl.replace(/\/$/, "")}${pathOrUrl}` : pathOrUrl;
         const headers = new Headers(init?.headers);
         if (!headers.has("Authorization")) {
           headers.set("Authorization", `Bearer ${bridge.opts.token}`);
         }
         return (bridge.opts.fetchFn ?? globalThis.fetch)(url, { ...init, headers });
       },
     };

    try {
      await setupFn(ctx);
      log.debug("setup callback completed");
    } catch (err) {
      log.error("setup callback threw:", (err as Error).message);
    }
  }

  private async registerCommands(): Promise<void> {
    if (this.registeredCommands.size === 0) return;
    try {
      const specs = [...this.registeredCommands.values()].map((v) => v.spec);
      await this.client.request("hydra-acp/commands/register", { commands: specs });
      log.info(`registered ${specs.length} slash command(s): ${specs.map((s) => s.verb).join(", ")}`);
    } catch (err) {
      log.error(`commands/register failed: ${(err as Error).message}`);
    }
  }

  private abortAllSessions(): void {
    for (const entry of this.sessions.values()) {
      entry.ac.abort();
    }
    this.sessions.clear();
  }

  /** Abort the signal for a single session and remove it from the map. */
  private abortSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.ac.abort();
      this.sessions.delete(sessionId);
    }
  }

  // ── Incoming message dispatch ─────────────────────────────────────────

  private handleRequest(req: JsonRpcRequest): void {
    if (req.method === "hydra-acp/commands/invoke") {
      this.handleCommandsInvoke(req);
      return;
    }
    if (req.method !== "hydra-acp/transformer/message") return;

    const params = req.params as Record<string, unknown> | undefined;
    const phase = params?.phase as "request" | "response" | undefined;
    const method = params?.method as string | undefined;
    const sessionId = params?.sessionId as string | undefined;
    const envelope = params?.envelope as unknown;

    // PROTOCOL.md:1474 — chain token for processing-claim discharge.
    const chainToken = params?.token as string | undefined;

    if (!phase || !method || !sessionId) {
      log.warn("transformer/message: missing required params");
      return;
    }

    // Compute the intercept key from phase + method.
    const intercept = `${phase}:${method}`;
    const handlers = this.interceptHandlers.get(intercept);
    if (!handlers || handlers.length === 0) {
      log.debug(`no hooks registered for intercept "${intercept}"`);
      return;
    }

    // Response chain may have multiple matching hooks (e.g. several
    // response:session/update filters). Request-side is single hook per intercept.
    const isResponse = phase === "response";

    if (isResponse) {
      void this.dispatchResponseChain(sessionId, chainToken, envelope, handlers);
    } else {
      // We checked handlers.length > 0 above; non-null assertion is safe.
      void this.dispatchRequestHook(req.id, sessionId, chainToken, envelope, handlers[0]!);
    }
  }

  private handleNotification(note: JsonRpcNotification): void {
    if (note.method !== "hydra-acp/transformer/session_event") return;

    const params = note.params as Record<string, unknown> | undefined;
    const event = params?.event as string | undefined;
    const sessionId = params?.sessionId as string | undefined;
    const payload = params?.payload as unknown;

    if (!event || !sessionId) {
      log.warn("session_event: missing required params");
      return;
    }

    // Abort the session signal when the session closes so any in-flight
    // work can detect cancellation via its AbortSignal. Do this before any
    // other processing since the user's session:close handler may expect
    // the signal to still be active during its own execution.
    if (event === "session.closed") {
      this.abortSession(sessionId);
    }

    // Map daemon lifecycle event names to SDK hook names.
    const lifecycleMap = new Map<string, HookName>([
      ["session.starting", "session:starting"],
      ["session.opened", "session:open"],
      ["session.closed", "session:close"],
      ["session.idle", "session:idle"],
      ["permission.replied", "permission:replied"],
      ["tool.completed", "tool:post"],
      ["file.edited", "file:edited"],
      ["agent.swap", "agent:swap"],
      ["compaction", "compaction"],
    ]);

    const hookName = lifecycleMap.get(event);
    if (!hookName) {
      log.debug(`no hook registered for lifecycle event "${event}"`);
      return;
    }

    const handler = this.hooksByName.get(hookName);
    if (!handler) {
      log.debug(`lifecycle hook "${hookName}" not in user spec`);
      return;
    }

    // Fire-and-forget: lifecycle hooks' return values are ignored.
    void (async () => {
      const ctx = this.getOrCreateSession(sessionId);
      try {
        await handler(payload, ctx);
      } catch (err) {
        log.error(`lifecycle hook "${hookName}" threw:`, (err as Error).message);
      }
    })();
  }

  // ── Slash-command dispatch ──────────────────────────────────────────

  private handleCommandsInvoke(req: JsonRpcRequest): void {
    const params = (req.params ?? {}) as {
      sessionId?: string;
      verb?: string;
      args?: string;
      messageId?: string;
    };
    const sessionId = params.sessionId ?? "";
    const verb = params.verb ?? "";
    const args = (params.args ?? "").trim();
    const messageId = params.messageId;

    const entry = this.registeredCommands.get(verb);
    if (!entry) {
      log.warn(`no command registered for verb "${verb}"`);
      this.client.reply(req.id, { text: `unknown command: ${verb}` });
      return;
    }

    const argv = args.length > 0 ? args.split(/\s+/) : [];
    const inv: CommandInvocation = { verb, argv, sessionId, messageId };

    void (async () => {
      const ctx = this.getOrCreateSession(sessionId);
      try {
        const result = await entry.handler(inv, ctx);
        if (result.message) {
          this.client.reply(req.id, { text: result.message });
        } else {
          this.client.reply(req.id, {});
        }
      } catch (err) {
        const msg = (err as Error).message;
        log.error(`command handler "${verb}" threw:`, msg);
        this.client.reply(req.id, { text: `Error: ${msg}` });
      }
    })();
  }

  // ── Request hook dispatch (single hook per intercept) ─────────────────

  private async dispatchRequestHook(
    requestId: JsonRpcId,
    sessionId: string,
    chainToken: string | undefined,
    envelope: unknown,
    handlerDef: { name: HookName; filter?: (envelope: unknown) => boolean },
  ): Promise<void> {
    const { name, filter } = handlerDef;
    if (filter && !filter(envelope)) return;

    const ctx = this.getOrCreateSession(sessionId);
    const hookHandler = this.hooksByName.get(name)!;

    await this.runHookWithClaim(
      ctx,
      sessionId,
      requestId,
      name,
      () => hookHandler(envelope, ctx),
      (returnVal) => {
        const encoded = encodeHookReturn(name, returnVal, log);
        // Async hooks discharge via message/emit with respondsTo so the
        // daemon knows which parked claim this resolves.  Sync hooks send
        // a direct reply since no processing claim was taken.
        if (chainToken) {
          void this.client.request("hydra-acp/message/emit", {
            sessionId,
            method: encoded.action,
            envelope: encoded.payload,
            respondsTo: chainToken,
          }).catch((err) => {
            log.error("message/emit discharge failed:", err.message);
          });
        } else {
          this.client.reply(requestId, buildReply(encoded));
        }
      },
      (err) => {
        log.error(`hook "${name}" threw:`, err.message);
        // Fail open — send continue so the chain proceeds.
        if (chainToken) {
          void this.client.request("hydra-acp/message/emit", {
            sessionId,
            method: "continue",
            respondsTo: chainToken,
          }).catch(() => void 0);
        } else {
          this.client.reply(requestId, { action: "continue" });
        }
      },
    );
  }

  // ── Response hook dispatch (chained hooks) ────────────────────────────

  private async dispatchResponseChain(
    sessionId: string,
    chainToken: string | undefined,
    envelope: unknown,
    handlers: Array<{ name: HookName; filter?: (envelope: unknown) => boolean }>,
  ): Promise<void> {
    let currentEnvelope = envelope;

    for (const handlerDef of handlers) {
      const { name, filter } = handlerDef;
      if (filter && !filter(currentEnvelope)) continue;

      const ctx = this.getOrCreateSession(sessionId);
      const hookHandler = this.hooksByName.get(name)!;

      let returnVal: unknown;
      try {
        returnVal = await hookHandler(currentEnvelope, ctx);
      } catch (err) {
        log.error(`response hook "${name}" threw:`, (err as Error).message);
        // Fail open — discharge with continue.
        void this.dischargeResponse(sessionId, chainToken, "continue", undefined);
        return;
      }

      const encoded = encodeHookReturn(name, returnVal, log);

      if (encoded.action === "stop") {
        void this.dischargeResponse(sessionId, chainToken, "stop", encoded.payload);
        return;
      }

      // transform — pass the transformed envelope to the next hook.
      if (encoded.payload !== undefined) {
        currentEnvelope = encoded.payload;
      }
      // continue (undefined) — pass original envelope unchanged.
    }

    // All hooks processed without stop — discharge with the final envelope.
    void this.dischargeResponse(sessionId, chainToken, "continue", currentEnvelope);
  }

  /** Discharge a response-side hook result via message/emit. */
  private dischargeResponse(
    sessionId: string,
    chainToken: string | undefined,
    action: string,
    payload: unknown,
  ): void {
    const body: Record<string, unknown> = { sessionId };
    if (chainToken) {
      body.respondsTo = chainToken;
    }
    // Always include method so the daemon can validate per PROTOCOL.md.
    body.method = action === "continue" ? "response" : action;
    if (payload !== undefined) {
      body.envelope = payload;
    }
    void this.client.request("hydra-acp/message/emit", body).catch((err) => {
      log.error("dischargeResponse failed:", err.message);
    });
  }

  // ── Hook execution with async claim management ────────────────────────

  /**
   * Execute a hook handler and manage processing claims for slow async hooks.
   *
   * If the handler returns a Promise that takes longer than
   * EARLY_RESOLVE_THRESHOLD_MS to resolve, sends "processing" to park the
   * claim and starts keep-alive pings every claimTimeoutMs / 2 until
   * resolution.
   */
  private async runHookWithClaim(
    ctx: Context,
    sessionId: string,
    requestId: JsonRpcId,
    hookName: HookName,
    fn: () => unknown | Promise<unknown>,
    onResolved: (returnVal: unknown) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const start = Date.now();
    const rawResult = fn();

    // Synchronous return — encode and send directly.
    if (!(rawResult instanceof Promise)) {
      const duration = Date.now() - start;
      log.debug(`hook "${hookName}" resolved sync in ${duration}ms, sessionId=${sessionId}`);
      onResolved(rawResult);
      return;
    }

    // Async hook: race against a 100ms threshold to decide whether we need
    // a processing claim. If the promise resolves within 100ms, no claim is
    // needed (the daemon's timeout is much longer). Otherwise, park with
    // "processing" and keep the claim alive until resolution.
    let settled = false;

    const earlyResolve = new Promise<void>((resolve) => {
      rawResult.then(
        () => {
          settled = true;
          resolve();
        },
        () => {
          settled = true;
          resolve();
        },
      );
    });

    await Promise.race([
      earlyResolve,
      new Promise<void>((resolve) => setTimeout(resolve, EARLY_RESOLVE_THRESHOLD_MS)),
    ]);

    if (settled) {
      // Hook resolved within 100ms — send result directly.
      try {
        const resolved = await rawResult;
        const duration = Date.now() - start;
        log.debug(`hook "${hookName}" resolved in ${duration}ms, sessionId=${sessionId}`);
        onResolved(resolved);
      } catch (err) {
        onError(err as Error);
      }
      return;
    }

    // Took longer than 100ms — send processing claim and start keep-alive.
    log.debug(`hook "${hookName}" slow, sending processing claim, sessionId=${sessionId}`);
    this.client.reply(requestId, { action: "processing" });
    const interval = this.startKeepAlive(sessionId);

    try {
      const resolved = await rawResult;
      const duration = Date.now() - start;
      log.debug(`hook "${hookName}" resolved in ${duration}ms, sessionId=${sessionId}`);
      onResolved(resolved);
    } catch (err) {
      onError(err as Error);
    } finally {
      clearInterval(interval);
    }
  }

  private startKeepAlive(sessionId: string): ReturnType<typeof setInterval> {
    // Clear any existing timer for this session.
    const existing = this.keepAliveTimers.get(sessionId);
    if (existing) clearInterval(existing);

    const intervalMs = Math.floor(this.claimTimeoutMs / 2);
    const timer = setInterval(() => {
      try {
        this.client.notify("hydra-acp/connection/keep_alive", { sessionId });
      } catch {
        // WS may be closed — interval will be cleared on next tick.
      }
    }, intervalMs);

    // unref so the timer doesn't prevent Node from exiting during tests.
    if (typeof timer.unref === "function") timer.unref();

    this.keepAliveTimers.set(sessionId, timer);
    return timer;
  }

  // ── Context extensions (rpc + registerCommand) ────────────────────────

 /** Generic RPC: thin wrapper over client.request(). */
 private rpc(method: string, params?: unknown): Promise<unknown> {
   return this.client.request(method, params);
 }

 /** Register a slash command. Stores spec+handler in the bridge's Map keyed
  *  by verb. On WS open (initial and after SIGHUP), all stored specs are
  *  re-sent via hydra-acp/commands/register. */
 private registerCommand(spec: CommandSpec, handler: CommandHandler): void {
   this.registeredCommands.set(spec.verb, { spec, handler });
 }

 // ── Session management ────────────────────────────────────────────────

  private getOrCreateSession(sessionId: string): Context {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = createContext(sessionId, { logger: log, rpc: this.rpc.bind(this), registerCommand: this.registerCommand.bind(this), httpUrl: this.opts.httpUrl, token: this.opts.token, fetchFn: this.opts.fetchFn });
      this.sessions.set(sessionId, entry);
    }
    return entry.ctx;
  }
}

// ── runTransformer (public entry point) ───────────────────────────────────

/**
 * Run a transformer definition against the daemon.
 *
 * Constructs a bridge, starts it, and resolves when shutdown signals fire.
 * Reads connection details from environment variables:
 *   - HYDRA_ACP_WS_URL — WebSocket URL for the daemon
 *   - HYDRA_ACP_TOKEN   — auth token
 *   - HYDRA_ACP_TRANSFORMER_NAME — identifies this transformer to the daemon
 */
export async function runTransformer(definition: TransformerSpec | { setup?: TransformerSpec["setup"]; hooks: Record<string, unknown> }): Promise<void> {
  const wsUrl = process.env.HYDRA_ACP_WS_URL;
  const token = process.env.HYDRA_ACP_TOKEN;
  const clientName = process.env.HYDRA_ACP_TRANSFORMER_NAME ?? "transformer";

  if (!wsUrl) throw new Error("HYDRA_ACP_WS_URL is not set");
  if (!token) throw new Error("HYDRA_ACP_TOKEN is not set");

  // Derive the HTTP base URL from the WebSocket URL.
  // ws(s)://host/path → http(s)://host
  const httpUrl = (() => {
    let derived = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    // Strip everything from the first "/" onward (host + path).
    const slashIdx = derived.indexOf("/");
    if (slashIdx !== -1) {
      derived = derived.slice(0, slashIdx);
    }
    return derived;
  })();

  const bridge = new TransformerBridge({
    daemonWsUrl: wsUrl,
    httpUrl,
    token,
    clientName,
    definition: definition as TransformerSpec,
  });

  bridge.start();

  return new Promise<void>((resolve) => {
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      log.info("shutdown complete");
      resolve();
    }

    // Graceful shutdown on SIGINT / SIGTERM.
    process.on("SIGINT", () => {
      log.info("received SIGINT, shutting down");
      bridge.stop();
      finish();
    });

    process.on("SIGTERM", () => {
      log.info("received SIGTERM, shutting down");
      bridge.stop();
      finish();
    });
  });
}

// ── Reply builder ─────────────────────────────────────────────────────────

/** Build a JSON-RPC result object from an encoded hook return. */
function buildReply(encoded: { action: string; payload?: unknown }): Record<string, unknown> {
  const result: Record<string, unknown> = { action: encoded.action };
  if (encoded.payload !== undefined) {
    result.payload = encoded.payload;
  }
  return result;
}
