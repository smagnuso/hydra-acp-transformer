import assert from "node:assert";
import { describe, it } from "node:test";

import { HOOK_CATALOG, type HookName } from "../src/hooks/catalog.js";
import {
  toolStartFilter,
  toolProgressFilter,
  messageAssistantFilter,
  messageThoughtFilter,
  messageUserFilter,
  planUpdateFilter,
  modeUpdateFilter,
  commandsUpdateFilter,
} from "../src/hooks/filter.js";

describe("HOOK_CATALOG", () => {
  it("has exactly 25 entries (tool:permission aliases permission:pre)", () => {
    const keys = Object.keys(HOOK_CATALOG);
    assert.strictEqual(keys.length, 25); // 24 unique intercepts + tool:permission alias
  });

  it("all values have intercept strings", () => {
    for (const [name, entry] of Object.entries(HOOK_CATALOG)) {
      assert.ok(
        typeof entry.intercept === "string" && entry.intercept.length > 0,
        `${String(name)} missing intercept`,
      );
    }
  });

  it("lifecycle hooks have no filter", () => {
    const lifecycleHooks = [
      "session:open",
      "session:close",
      "session:idle",
      "permission:replied",
      "tool:post",
      "file:edited",
      "agent:swap",
      "compaction",
    ];
    for (const name of lifecycleHooks) {
      assert.strictEqual(
        (HOOK_CATALOG as Record<string, { filter?: unknown }>)[name].filter,
        undefined,
        `${name} should have no filter`,
      );
    }
  });

  it("request hooks have no filter", () => {
    const requestHooks = [
      "prompt:pre",
      "permission:pre",
      "tool:permission",
      "mode:change",
      "session:cancel",
      "session:new",
      "session:load",
      "auth:required",
      "agent:initialize",
    ];
    for (const name of requestHooks) {
      assert.strictEqual(
        (HOOK_CATALOG as Record<string, { filter?: unknown }>)[name].filter,
        undefined,
        `${name} should have no filter`,
      );
    }
  });

  it("response hooks with filters define them", () => {
    const responseHooks = [
      "tool:start",
      "tool:progress",
      "message:assistant",
      "message:thought",
      "message:user",
      "plan:update",
      "mode:update",
      "commands:update",
    ];
    for (const name of responseHooks) {
      assert.ok(
        typeof (HOOK_CATALOG as Record<string, { filter?: unknown }>)[name]
          .filter === "function",
        `${name} should have a filter function`,
      );
    }
  });

  it("tool:permission and permission:pre share the same intercept", () => {
    assert.strictEqual(
      (HOOK_CATALOG as Record<string, { intercept: string }>)[
        "tool:permission"
      ].intercept,
      (HOOK_CATALOG as Record<string, { intercept: string }>)[
        "permission:pre"
      ].intercept,
    );
  });

  it("catalog entry for every catalog row", () => {
    const expected: Array<[HookName, string, boolean]> = [
      ["session:open", "lifecycle:session.opened", false],
      ["session:close", "lifecycle:session.closed", false],
      ["session:idle", "lifecycle:session.idle", false],
      ["prompt:pre", "request:session/prompt", false],
      ["permission:pre", "request:session/request_permission", false],
      ["tool:permission", "request:session/request_permission", false],
      ["permission:replied", "lifecycle:permission.replied", false],
      ["tool:start", "response:session/update", true],
      ["tool:progress", "response:session/update", true],
      ["tool:post", "lifecycle:tool.completed", false],
      ["file:edited", "lifecycle:file.edited", false],
      [
        "message:assistant",
        "response:session/update",
        true,
      ],
      ["message:thought", "response:session/update", true],
      ["message:user", "response:session/update", true],
      ["plan:update", "response:session/update", true],
      ["mode:change", "request:session/set_mode", false],
      ["mode:update", "response:session/update", true],
      [
        "commands:update",
        "response:session/update",
        true,
      ],
      ["session:cancel", "request:session/cancel", false],
      ["session:new", "request:session/new", false],
      ["session:load", "request:session/load", false],
      ["auth:required", "request:authenticate", false],
      [
        "agent:initialize",
        "agent:initialize",
        false,
      ],
      ["agent:swap", "lifecycle:agent.swap", false],
      ["compaction", "lifecycle:compaction", false],
    ];

    for (const [name, intercept, hasFilter] of expected) {
      const entry = HOOK_CATALOG[name];
      assert.strictEqual(entry.intercept, intercept, `intercept mismatch for ${String(name)}`);
      if (hasFilter) {
        assert.ok(typeof entry.filter === "function", `filter missing for ${String(name)}`);
      } else {
        assert.strictEqual(
          (entry as { filter?: unknown }).filter,
          undefined,
          `unexpected filter for ${String(name)}`,
        );
      }
    }
  });
});

describe("filters", () => {
  describe("toolStartFilter", () => {
    it("matches tool_call", () => {
      assert.strictEqual(
        toolStartFilter({ update: { sessionUpdate: "tool_call" } }),
        true,
      );
    });

    it("rejects other subtypes", () => {
      assert.strictEqual(
        toolStartFilter({ update: { sessionUpdate: "plan" } }),
        false,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(toolStartFilter(null as unknown as Parameters<typeof toolStartFilter>[0]), false);
      assert.strictEqual(toolStartFilter({}), false);
      assert.strictEqual(
        toolStartFilter({ update: null }),
        false,
      );
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(toolStartFilter({ update: {} }), false);
    });

    it("rejects string envelope", () => {
      assert.strictEqual(
        toolStartFilter("tool_call" as unknown as Parameters<typeof toolStartFilter>[0]),
        false,
      );
    });

    it("rejects numeric envelope", () => {
      assert.strictEqual(
        toolStartFilter(42 as unknown as Parameters<typeof toolStartFilter>[0]),
        false,
      );
    });
  });

  describe("toolProgressFilter", () => {
    it("matches non-terminal tool_call_update with running status", () => {
      assert.strictEqual(
        toolProgressFilter({ update: { sessionUpdate: "tool_call_update", status: "running" } }),
        true,
      );
    });

    it("matches tool_call_update with starting status", () => {
      assert.strictEqual(
        toolProgressFilter({ update: { sessionUpdate: "tool_call_update", status: "starting" } }),
        true,
      );
    });

    it("rejects terminal completed", () => {
      assert.strictEqual(
        toolProgressFilter({ update: { sessionUpdate: "tool_call_update", status: "completed" } }),
        false,
      );
    });

    it("rejects terminal failed", () => {
      assert.strictEqual(
        toolProgressFilter({ update: { sessionUpdate: "tool_call_update", status: "failed" } }),
        false,
      );
    });

    it("rejects wrong subtype", () => {
      assert.strictEqual(
        toolProgressFilter({ update: { sessionUpdate: "tool_call" } }),
        false,
      );
    });

    it("matches when status is absent (non-terminal)", () => {
      assert.strictEqual(
        toolProgressFilter({ update: { sessionUpdate: "tool_call_update" } }),
        true,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(toolProgressFilter(null as unknown as Parameters<typeof toolProgressFilter>[0]), false);
      assert.strictEqual(toolProgressFilter({}), false);
      assert.strictEqual(toolProgressFilter({ update: null }), false);
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(toolProgressFilter({ update: {} }), false);
    });

    it("rejects string envelope", () => {
      assert.strictEqual(
        toolProgressFilter("tool_call_update" as unknown as Parameters<typeof toolProgressFilter>[0]),
        false,
      );
    });
  });

  describe("messageAssistantFilter", () => {
    it("matches agent_message_chunk", () => {
      assert.strictEqual(
        messageAssistantFilter({ update: { sessionUpdate: "agent_message_chunk" } }),
        true,
      );
    });

    it("rejects other subtypes", () => {
      assert.strictEqual(
        messageAssistantFilter({ update: { sessionUpdate: "plan" } }),
        false,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(messageAssistantFilter(null as unknown as Parameters<typeof messageAssistantFilter>[0]), false);
      assert.strictEqual(messageAssistantFilter({}), false);
      assert.strictEqual(messageAssistantFilter({ update: null }), false);
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(messageAssistantFilter({ update: {} }), false);
    });
  });

  describe("messageThoughtFilter", () => {
    it("matches agent_thought_chunk", () => {
      assert.strictEqual(
        messageThoughtFilter({ update: { sessionUpdate: "agent_thought_chunk" } }),
        true,
      );
    });

    it("rejects other subtypes", () => {
      assert.strictEqual(
        messageThoughtFilter({ update: { sessionUpdate: "plan" } }),
        false,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(messageThoughtFilter(null as unknown as Parameters<typeof messageThoughtFilter>[0]), false);
      assert.strictEqual(messageThoughtFilter({}), false);
      assert.strictEqual(messageThoughtFilter({ update: null }), false);
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(messageThoughtFilter({ update: {} }), false);
    });
  });

  describe("messageUserFilter", () => {
    it("matches user_message_chunk", () => {
      assert.strictEqual(
        messageUserFilter({ update: { sessionUpdate: "user_message_chunk" } }),
        true,
      );
    });

    it("rejects other subtypes", () => {
      assert.strictEqual(
        messageUserFilter({ update: { sessionUpdate: "plan" } }),
        false,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(messageUserFilter(null as unknown as Parameters<typeof messageUserFilter>[0]), false);
      assert.strictEqual(messageUserFilter({}), false);
      assert.strictEqual(messageUserFilter({ update: null }), false);
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(messageUserFilter({ update: {} }), false);
    });
  });

  describe("planUpdateFilter", () => {
    it("matches plan", () => {
      assert.strictEqual(
        planUpdateFilter({ update: { sessionUpdate: "plan" } }),
        true,
      );
    });

    it("rejects other subtypes", () => {
      assert.strictEqual(
        planUpdateFilter({ update: { sessionUpdate: "tool_call" } }),
        false,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(planUpdateFilter(null as unknown as Parameters<typeof planUpdateFilter>[0]), false);
      assert.strictEqual(planUpdateFilter({}), false);
      assert.strictEqual(planUpdateFilter({ update: null }), false);
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(planUpdateFilter({ update: {} }), false);
    });
  });

  describe("modeUpdateFilter", () => {
    it("matches current_mode_update", () => {
      assert.strictEqual(
        modeUpdateFilter({ update: { sessionUpdate: "current_mode_update" } }),
        true,
      );
    });

    it("rejects other subtypes", () => {
      assert.strictEqual(
        modeUpdateFilter({ update: { sessionUpdate: "plan" } }),
        false,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(modeUpdateFilter(null as unknown as Parameters<typeof modeUpdateFilter>[0]), false);
      assert.strictEqual(modeUpdateFilter({}), false);
      assert.strictEqual(modeUpdateFilter({ update: null }), false);
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(modeUpdateFilter({ update: {} }), false);
    });
  });

  describe("commandsUpdateFilter", () => {
    it("matches available_commands_update", () => {
      assert.strictEqual(
        commandsUpdateFilter({ update: { sessionUpdate: "available_commands_update" } }),
        true,
      );
    });

    it("rejects other subtypes", () => {
      assert.strictEqual(
        commandsUpdateFilter({ update: { sessionUpdate: "plan" } }),
        false,
      );
    });

    it("rejects invalid envelopes", () => {
      assert.strictEqual(commandsUpdateFilter(null as unknown as Parameters<typeof commandsUpdateFilter>[0]), false);
      assert.strictEqual(commandsUpdateFilter({}), false);
      assert.strictEqual(commandsUpdateFilter({ update: null }), false);
    });

    it("rejects envelope with missing sessionUpdate", () => {
      assert.strictEqual(commandsUpdateFilter({ update: {} }), false);
    });
  });
});
