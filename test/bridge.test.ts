import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "../src/acp/protocol.js";
import type { BridgeClient } from "../src/bridge.js";
import { TransformerBridge } from "../src/bridge.js";

// Fake client that records every wire call and properly routes events to
// registered listeners so the bridge internal handlers fire.
// start() simulates the real TransformerClient handshake sequence: it sends
// both initialize and hydra-acp/transformer/initialize, then emits open.

interface RecordedCall {
  method: string;
  params?: unknown;
}

class FakeTransformerClient implements BridgeClient {
  readonly requests: RecordedCall[] = [];
  readonly notifications: RecordedCall[] = [];
  readonly replies: Array<{ id: JsonRpcId; result: unknown }> = [];
  private _connected = true;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return Promise.resolve({ ok: true });
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  reply(id: JsonRpcId, result: unknown): void {
    this.replies.push({ id, result });
  }

  replyError(_id: JsonRpcId, _code: number, _message: string): void {}

  private _intercepts: string[] = [];
  setIntercepts(intercepts: string[]): void { this._intercepts = intercepts; }

  start(): void {
    this._connected = true;
    void (async () => {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "test-transformer", version: "0.0.1" },
      });
      await this.request("hydra-acp/transformer/initialize", { intercepts: this._intercepts });
      this.emit("open");
    })();
  }

  stop(): void {
    this._connected = false;
    this.emit("close", { hadError: false });
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return undefined;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const arr = this.listeners.get(event);
    if (arr) for (const fn of arr) fn(...args);
    return true;
  }
}

function emitRequest(fake: FakeTransformerClient, bridge: TransformerBridge, req: JsonRpcRequest): void {
  fake.emit("request", req);
}

function emitNotification(fake: FakeTransformerClient, _bridge: TransformerBridge, note: JsonRpcNotification): void {
  fake.emit("notification", note);
}

describe("TransformerBridge - protocol fidelity", () => {

  describe("hook subscription", () => {
    it("declares only intercepts needed by registered hooks", async () => {
      const fake = new FakeTransformerClient();
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "prompt:pre": async () => undefined, "tool:post": async () => undefined } },
        client: fake,
      });
      bridge.start();
      await new Promise((r) => setTimeout(r, 10));
      const initCall = fake.requests.find((r) => r.method === "hydra-acp/transformer/initialize");
      assert.ok(initCall);
      const intercepts = (initCall!.params as { intercepts?: string[] })?.intercepts ?? [];
      assert.ok(intercepts.includes("request:session/prompt"));
      assert.ok(intercepts.includes("lifecycle:tool.completed"));
    });

    it("deduplicates intercepts when multiple hooks share one wire target", async () => {
      const fake = new FakeTransformerClient();
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "permission:pre": async () => undefined, "tool:permission": async () => undefined } },
        client: fake,
      });
      bridge.start();
      await new Promise((r) => setTimeout(r, 10));
      const initCall = fake.requests.find((r) => r.method === "hydra-acp/transformer/initialize");
      assert.ok(initCall);
      const intercepts = (initCall!.params as { intercepts?: string[] })?.intercepts ?? [];
      const count = intercepts.filter((i) => i === "request:session/request_permission").length;
      assert.equal(count, 1);
    });

    it("does not subscribe to intercepts with no registered hooks", async () => {
      const fake = new FakeTransformerClient();
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "tool:post": async () => undefined } },
        client: fake,
      });
      bridge.start();
      await new Promise((r) => setTimeout(r, 10));
      const initCall = fake.requests.find((r) => r.method === "hydra-acp/transformer/initialize");
      assert.ok(initCall);
      const intercepts = (initCall!.params as { intercepts?: string[] })?.intercepts ?? [];
      assert.ok(!intercepts.includes("request:session/prompt"));
    });
  });

  describe("sync hook dispatch", () => {
    it(
      "calls prompt:pre hook and replies with encoded action",
      async () => {
        const fake = new FakeTransformerClient();
        let hookCalled = false;
        let hookEnvelope: unknown;
        let hookSessionId = "";
        const bridge = new TransformerBridge({
          daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
          definition: { hooks: { "prompt:pre": async (event, ctx) => { hookCalled = true; hookEnvelope = event; hookSessionId = ctx.sessionId; return undefined; } } },
          client: fake,
        });
        const envelope = { sessionId: "sess-1", prompt: [{ type: "text", text: "hello" }] };
        emitRequest(fake, bridge, {
          jsonrpc: "2.0", id: 42, method: "hydra-acp/transformer/message",
          params: { token: "chain-token-1", phase: "request", method: "session/prompt", direction: "client\u2192agent", sessionId: "sess-1", envelope },
        });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(hookCalled, true);
        assert.deepEqual(hookEnvelope, envelope);
        assert.equal(hookSessionId, "sess-1");
        // With chainToken present the bridge discharges via message/emit.
        const emitCall = fake.requests.find((r) => r.method === "hydra-acp/message/emit");
        assert.ok(emitCall);
        const ep = emitCall!.params as Record<string, unknown> | undefined;
        assert.equal(ep?.respondsTo, "chain-token-1");
      },
    );

    it(
      "encodes transform return as payload in message/emit",
      async () => {
        const fake = new FakeTransformerClient();
        const bridge = new TransformerBridge({
          daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
          definition: { hooks: { "prompt:pre": async () => ({ transform: { sessionId: "sess-1", prompt: [{ type: "text", text: "rewritten" }] } }) } },
          client: fake,
        });
        emitRequest(fake, bridge, {
          jsonrpc: "2.0", id: 5, method: "hydra-acp/transformer/message",
          params: { token: "chain-token-2", phase: "request", method: "session/prompt", direction: "client\u2192agent", sessionId: "sess-1", envelope: { sessionId: "sess-1", prompt: [] } },
        });
        await new Promise((r) => setTimeout(r, 10));
        const emitCall = fake.requests.find((r) => r.method === "hydra-acp/message/emit");
        assert.ok(emitCall);
        const ep = emitCall!.params as Record<string, unknown> | undefined;
        assert.ok(ep?.envelope, "discharge should carry the encoded envelope");
      },
    );

    it(
      "encodes block return as stop action in message/emit",
      async () => {
        const fake = new FakeTransformerClient();
        const bridge = new TransformerBridge({
          daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
          definition: { hooks: { "prompt:pre": async () => ({ block: true, reason: "denied" }) } },
          client: fake,
        });
        emitRequest(fake, bridge, {
          jsonrpc: "2.0", id: 7, method: "hydra-acp/transformer/message",
          params: { token: "chain-token-3", phase: "request", method: "session/prompt", direction: "client\u2192agent", sessionId: "sess-1", envelope: { sessionId: "sess-1", prompt: [] } },
        });
        await new Promise((r) => setTimeout(r, 10));
        const emitCall = fake.requests.find((r) => r.method === "hydra-acp/message/emit");
        assert.ok(emitCall);
        const ep = emitCall!.params as Record<string, unknown> | undefined;
        assert.equal(ep?.method, "stop", "block return should encode as stop");
      },
    );
  });

  describe("async hook with processing claim", () => {
    it("sends processing first then discharges via message/emit", async () => {
      const fake = new FakeTransformerClient();
      let resolved = false;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "prompt:pre": async () => { await new Promise((r) => setTimeout(r, 50)); resolved = true; return undefined; } } },
        client: fake,
      });
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 10, method: "hydra-acp/transformer/message",
        params: { token: "chain-async-1", phase: "request", method: "session/prompt", direction: "client→agent", sessionId: "sess-2", envelope: { sessionId: "sess-2", prompt: [] } },
      });
      await new Promise((r) => setTimeout(r, 50));
      const processingReply = fake.replies.find((r) => r.id === 10);
      assert.ok(processingReply);
      assert.equal((processingReply!.result as { action: string })?.action, "processing");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(resolved, true);
      const emitCall = fake.requests.find((r) => r.method === "hydra-acp/message/emit");
      assert.ok(emitCall);
      const emitParams = emitCall!.params as Record<string, unknown> | undefined;
      assert.equal(emitParams?.respondsTo, "chain-async-1");
    });

    it("emits encoded payload in message/emit when hook returns transform", async () => {
      const fake = new FakeTransformerClient();
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "prompt:pre": async () => { await new Promise((r) => setTimeout(r, 50)); return { transform: { sessionId: "sess-3", prompt: [{ type: "text", text: "async rewrite" }] } }; } } },
        client: fake,
      });
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 11, method: "hydra-acp/transformer/message",
        params: { token: "chain-async-2", phase: "request", method: "session/prompt", direction: "client→agent", sessionId: "sess-3", envelope: { sessionId: "sess-3", prompt: [] } },
      });
      await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      const emitCall = fake.requests.find((r) => r.method === "hydra-acp/message/emit");
      assert.ok(emitCall);
      const emitParams = emitCall!.params as Record<string, unknown> | undefined;
      assert.ok(emitParams?.envelope);
    });
  });

  describe("lifecycle dispatch", () => {
    it("routes session_event to the correct lifecycle hook", async () => {
      const fake = new FakeTransformerClient();
      let hookCalled = false;
      let hookPayload: unknown;
      let hookSessionId = "";
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "tool:post": async (event, ctx) => { hookCalled = true; hookPayload = event; hookSessionId = ctx.sessionId; } } },
        client: fake,
      });
      const payload = { toolCallId: "tc-1", status: "completed" as const };
      emitNotification(fake, bridge, {
        jsonrpc: "2.0", method: "hydra-acp/transformer/session_event",
        params: { event: "tool.completed", sessionId: "sess-4", payload },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(hookCalled, true);
      assert.deepEqual(hookPayload, payload);
      assert.equal(hookSessionId, "sess-4");
    });

    it("ignores unknown lifecycle events without error", async () => {
      const fake = new FakeTransformerClient();
      let hookCalled = false;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "tool:post": async () => { hookCalled = true; } } },
        client: fake,
      });
      emitNotification(fake, bridge, {
        jsonrpc: "2.0", method: "hydra-acp/transformer/session_event",
        params: { event: "unknown.event", sessionId: "sess-5", payload: {} },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(hookCalled, false);
    });

    it("does not dispatch when hook is not registered for a known lifecycle event", async () => {
      const fake = new FakeTransformerClient();
      let toolPostCalled = false;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "tool:post": async () => { toolPostCalled = true; } } },
        client: fake,
      });
      emitNotification(fake, bridge, {
        jsonrpc: "2.0", method: "hydra-acp/transformer/session_event",
        params: { event: "session.opened", sessionId: "sess-6", payload: {} },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(toolPostCalled, false);
    });
  });

  describe("subtype filter", () => {
    it("routes agent_message_chunk to message:assistant not tool:start", async () => {
      const fake = new FakeTransformerClient();
      let assistantCalled = false;
      let toolStartCalled = false;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "message:assistant": async () => { assistantCalled = true; }, "tool:start": async () => { toolStartCalled = true; } } },
        client: fake,
      });
      const envelope = { sessionId: "sess-7", update: { sessionUpdate: "agent_message_chunk" } };
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 20, method: "hydra-acp/transformer/message",
        params: { token: "chain-filter-1", phase: "response", method: "session/update", direction: "agent→client", sessionId: "sess-7", envelope },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(assistantCalled, true);
      assert.equal(toolStartCalled, false);
    });

    it("routes tool_call to tool:start not message:assistant", async () => {
      const fake = new FakeTransformerClient();
      let assistantCalled = false;
      let toolStartCalled = false;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "message:assistant": async () => { assistantCalled = true; }, "tool:start": async () => { toolStartCalled = true; } } },
        client: fake,
      });
      const envelope = { sessionId: "sess-8", update: { sessionUpdate: "tool_call", toolCallId: "tc-1" } };
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 21, method: "hydra-acp/transformer/message",
        params: { token: "chain-filter-2", phase: "response", method: "session/update", direction: "agent→client", sessionId: "sess-8", envelope },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(toolStartCalled, true);
      assert.equal(assistantCalled, false);
    });
  });

  describe("multiple hooks compose", () => {
    it("first hook transforms tool_call second hook is skipped by its filter", async () => {
      const fake = new FakeTransformerClient();
      let toolStartCalls = 0;
      let assistantCalls = 0;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "tool:start": async (event) => { toolStartCalls++; return { transform: { ...event, _transformedBy: "tool-start" } }; }, "message:assistant": async () => { assistantCalls++; } } },
        client: fake,
      });
      const envelope = { sessionId: "sess-9", update: { sessionUpdate: "tool_call", toolCallId: "tc-1" } };
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 30, method: "hydra-acp/transformer/message",
        params: { token: "chain-compose-1", phase: "response", method: "session/update", direction: "agent→client", sessionId: "sess-9", envelope },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(toolStartCalls, 1);
      assert.equal(assistantCalls, 0);
    });
  });

  describe("hook throws", () => {
    it("bridge logs and sends continue fail open", async () => {
      const fake = new FakeTransformerClient();
      let hookThrew = false;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "prompt:pre": async () => { hookThrew = true; throw new Error("boom"); } } },
        client: fake,
      });
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 40, method: "hydra-acp/transformer/message",
        params: { token: "chain-throw-1", phase: "request", method: "session/prompt", direction: "client\u2192agent", sessionId: "sess-10", envelope: { sessionId: "sess-10", prompt: [] } },
      });
      await new Promise((r) => setTimeout(r, 10));
      // With chainToken the bridge discharges via message/emit.
      const emitCall = fake.requests.find((r) => r.method === "hydra-acp/message/emit");
      assert.ok(emitCall);
      const ep = emitCall!.params as Record<string, unknown> | undefined;
      assert.equal(ep?.method, "continue", "thrown hook should fail open with continue");
      assert.equal(hookThrew, true);
    });
  });

  describe("context lifecycle", () => {
    it("Context for sessionId X is reused across two events and state persists", async () => {
      const fake = new FakeTransformerClient();
      let contextA: import("../src/types.js").Context | undefined;
      let contextB: import("../src/types.js").Context | undefined;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "prompt:pre": async (_event, ctx) => { if (!contextA) { contextA = ctx; ctx.state.set("counter", 1); } else { contextB = ctx; const prev = ctx.state.get("counter") as number | undefined; ctx.state.set("counter", (prev ?? 0) + 1); } return undefined; } } },
        client: fake,
      });
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 50, method: "hydra-acp/transformer/message",
        params: { token: "chain-ctx-1", phase: "request", method: "session/prompt", direction: "client→agent", sessionId: "ctx-sess", envelope: { sessionId: "ctx-sess", prompt: [{ type: "text", text: "first" }] } },
      });
      emitRequest(fake, bridge, {
        jsonrpc: "2.0", id: 51, method: "hydra-acp/transformer/message",
        params: { token: "chain-ctx-2", phase: "request", method: "session/prompt", direction: "client→agent", sessionId: "ctx-sess", envelope: { sessionId: "ctx-sess", prompt: [{ type: "text", text: "second" }] } },
      });
      assert.ok(contextA);
      assert.ok(contextB);
      assert.strictEqual(contextA, contextB);
      assert.equal(contextB!.state.get("counter"), 2);
    });

    it("signal is aborted when lifecycle:session.closed fires", async () => {
      const fake = new FakeTransformerClient();
      let storedSignal: AbortSignal | undefined;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "session:open": async (_event, ctx) => { storedSignal = ctx.signal; } } },
        client: fake,
      });
      emitNotification(fake, bridge, {
        jsonrpc: "2.0", method: "hydra-acp/transformer/session_event",
        params: { event: "session.opened", sessionId: "abort-sess", payload: {} },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(storedSignal);
      assert.equal(storedSignal!.aborted, false);
      emitNotification(fake, bridge, {
        jsonrpc: "2.0", method: "hydra-acp/transformer/session_event",
        params: { event: "session.closed", sessionId: "abort-sess", payload: {} },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(storedSignal!.aborted, true);
    });

    it("disconnect aborts all session signals and clears contexts", async () => {
      const fake = new FakeTransformerClient();
      let storedSignal: AbortSignal | undefined;
      const bridge = new TransformerBridge({
        daemonWsUrl: "ws://localhost:55514/acp", token: "test-token", clientName: "test-transformer",
        definition: { hooks: { "session:open": async (_event, ctx) => { storedSignal = ctx.signal; } } },
        client: fake,
      });
      emitNotification(fake, bridge, {
        jsonrpc: "2.0", method: "hydra-acp/transformer/session_event",
        params: { event: "session.opened", sessionId: "disconnect-sess", payload: {} },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(storedSignal);
      fake.stop();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(storedSignal!.aborted, true);
    });
  });
});
