import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeHookReturn } from "../src/hooks/contract.js";
import type { HookName } from "../src/hooks/catalog.js";

// --- undefined returns ---

describe("encodeHookReturn — undefined", () => {
  it("returns { action: 'continue' } for request hooks", () => {
    const result = encodeHookReturn("prompt:pre" as HookName, undefined);
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("returns { action: 'continue' } for permission hooks", () => {
    const result = encodeHookReturn("permission:pre" as HookName, undefined);
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("returns { action: 'continue' } for response hooks", () => {
    const result = encodeHookReturn("tool:start" as HookName, undefined);
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("returns { action: 'continue' } for lifecycle hooks", () => {
    const result = encodeHookReturn("session:open" as HookName, undefined);
    assert.deepStrictEqual(result, { action: "continue" });
  });
});

// --- transform returns ---

describe("encodeHookReturn — transform", () => {
  it("returns { action: 'continue', payload: <transform> } for request hooks", () => {
    const result = encodeHookReturn(
      "prompt:pre" as HookName,
      { transform: { foo: 1 } },
    );
    assert.deepStrictEqual(result, {
      action: "continue",
      payload: { foo: 1 },
    });
  });

  it("returns { action: 'continue', payload: <transform> } for permission hooks", () => {
    const result = encodeHookReturn(
      "permission:pre" as HookName,
      { transform: { bar: 2 } },
    );
    assert.deepStrictEqual(result, {
      action: "continue",
      payload: { bar: 2 },
    });
  });

  it("returns { action: 'continue', payload: <transform> } for response hooks", () => {
    const result = encodeHookReturn(
      "tool:start" as HookName,
      { transform: { baz: 3 } },
    );
    assert.deepStrictEqual(result, {
      action: "continue",
      payload: { baz: 3 },
    });
  });
});

// --- block returns ---

describe("encodeHookReturn — block", () => {
  it("returns { action: 'stop', payload: { outcome: { outcome: 'cancelled' } } } for permission hooks", () => {
    const result = encodeHookReturn(
      "permission:pre" as HookName,
      { block: true, reason: "no" },
    );
    assert.deepStrictEqual(result, {
      action: "stop",
      payload: { outcome: { outcome: "cancelled" } },
    });
  });

  it("returns { action: 'stop', payload: { stopReason: 'stopped' } } for non-permission request hooks (prompt:pre)", () => {
    const result = encodeHookReturn(
      "prompt:pre" as HookName,
      { block: true },
    );
    assert.deepStrictEqual(result, { action: "stop", payload: { stopReason: "stopped" } });
  });

  it("throws on response hooks after logging a warning (block falls through)", () => {
    let warned = false;
    const debugLog = { warn: (..._args: unknown[]) => { warned = true; } };
    assert.throws(
      () => encodeHookReturn("tool:start" as HookName, { block: true }, debugLog),
      /invalid return value/,
    );
    assert.strictEqual(warned, true);
  });

  it("accepts block on lifecycle hooks without throwing (logs warning)", () => {
    let warned = false;
    const debugLog = { warn: (..._args: unknown[]) => { warned = true; } };
    const result = encodeHookReturn(
      "session:open" as HookName,
      { block: true },
      debugLog,
    );
    assert.strictEqual(warned, true);
    assert.deepStrictEqual(result, { action: "continue" });
  });
});

// --- approve returns ---

describe("encodeHookReturn — approve", () => {
  it("returns { action: 'stop', payload: { outcome: { outcome: 'selected', optionId } } } for permission:pre", () => {
    const result = encodeHookReturn(
      "permission:pre" as HookName,
      { approve: true, optionId: "yes" },
    );
    assert.deepStrictEqual(result, {
      action: "stop",
      payload: { outcome: { outcome: "selected", optionId: "yes" } },
    });
  });

  it("defaults optionId to 'allow' and warns when not provided", () => {
    let warned = false;
    const debugLog = { warn: (..._args: unknown[]) => { warned = true; } };
    const result = encodeHookReturn(
      "permission:pre" as HookName,
      { approve: true },
      debugLog,
    );
    assert.strictEqual(warned, true);
    assert.deepStrictEqual(result, {
      action: "stop",
      payload: { outcome: { outcome: "selected", optionId: "allow" } },
    });
  });

  it("throws when approve is returned from prompt:pre (invalid combination)", () => {
    assert.throws(
      () => encodeHookReturn("prompt:pre" as HookName, { approve: true }),
      (err: Error) =>
        err.message.includes("approve") && err.message.includes("prompt:pre"),
    );
  });

  it("throws when approve is returned from a response hook", () => {
    assert.throws(
      () => encodeHookReturn("tool:start" as HookName, { approve: true }),
      (err: Error) =>
        err.message.includes("approve") && err.message.includes("tool:start"),
    );
  });
});

// --- handled returns ---

describe("encodeHookReturn — handled", () => {
  it("returns { action: 'stop', payload: { stopReason: 'end_turn' } } for prompt:pre (reply discarded)", () => {
    const result = encodeHookReturn(
      "prompt:pre" as HookName,
      { handled: true, reply: [{ type: "text", text: "done" }] },
    );
    assert.deepStrictEqual(result, {
      action: "stop",
      payload: { stopReason: "end_turn" },
    });
  });

  it("throws when handled is returned from permission hooks", () => {
    assert.throws(
      () =>
        encodeHookReturn("permission:pre" as HookName, { handled: true }),
      (err: Error) =>
        err.message.includes("handled") && err.message.includes("permission:pre"),
    );
  });

  it("throws when handled is returned from other request hooks", () => {
    assert.throws(
      () => encodeHookReturn("mode:change" as HookName, { handled: true }),
      (err: Error) =>
        err.message.includes("handled") && err.message.includes("mode:change"),
    );
  });

  it("throws when handled is returned from a response hook", () => {
    assert.throws(
      () => encodeHookReturn("tool:start" as HookName, { handled: true }),
      (err: Error) =>
        err.message.includes("handled") && err.message.includes("tool:start"),
    );
  });
});

// --- lifecycle hooks accept any return without throwing ---

describe("encodeHookReturn — lifecycle hooks", () => {
  it("accepts non-undefined return and returns { action: 'continue' } (return ignored)", () => {
    let warned = false;
    const debugLog = { warn: (..._args: unknown[]) => { warned = true; } };
    const result = encodeHookReturn(
      "tool:post" as HookName,
      { transform: { foo: 1 } },
      debugLog,
    );
    assert.strictEqual(warned, true);
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("accepts block without throwing", () => {
    const result = encodeHookReturn(
      "session:close" as HookName,
      { block: true },
    );
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("accepts approve without throwing", () => {
    const result = encodeHookReturn(
      "file:edited" as HookName,
      { approve: true },
    );
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("accepts handled without throwing", () => {
    const result = encodeHookReturn(
      "permission:replied" as HookName,
      { handled: true },
    );
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("accepts arbitrary values without throwing", () => {
    // @ts-expect-error — simulating a user returning a bare string.
    const result = encodeHookReturn("session:idle" as HookName, "random");
    assert.deepStrictEqual(result, { action: "continue" });
  });

  it("logs debug when non-undefined return is discarded", () => {
    let warned = false;
    const debugLog = { warn: (..._args: unknown[]) => { warned = true; } };
    encodeHookReturn("session:open" as HookName, { block: true }, debugLog);
    assert.strictEqual(warned, true);
  });

  it("does not log when return is undefined", () => {
    let warned = false;
    const debugLog = { warn: (..._args: unknown[]) => { warned = true; } };
    encodeHookReturn("session:open" as HookName, undefined, debugLog);
    assert.strictEqual(warned, false);
  });
});

// --- invalid shapes on non-lifecycle hooks ---

describe("encodeHookReturn — invalid shapes", () => {
  it("throws for bare string on request hook", () => {
    // @ts-expect-error — simulating unexpected return type.
    assert.throws(
      () => encodeHookReturn("prompt:pre" as HookName, "foo"),
      /invalid return value/,
    );
  });

  it("throws for bare number on response hook", () => {
    // @ts-expect-error — simulating unexpected return type.
    assert.throws(
      () => encodeHookReturn("tool:start" as HookName, 42),
      /invalid return value/,
    );
  });

  it("throws for unknown object shape on request hook", () => {
    assert.throws(
      () =>
        encodeHookReturn("prompt:pre" as HookName, { custom: true }),
      (err: Error) =>
        err.message.includes("invalid return value") &&
        err.message.includes("prompt:pre"),
    );
  });

  it("includes the JSON-stringified value in the error message", () => {
    try {
      encodeHookReturn("tool:start" as HookName, { foo: "bar" });
      assert.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(
        msg.includes('"foo":"bar"') || msg.includes("{"),
        `error should include serialized value, got: ${msg}`,
      );
    }
  });
});
