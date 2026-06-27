import assert from "node:assert";
import { describe, it } from "node:test";

import {
  defineTransformer,
  runTransformer,
  type TransformerDefinition,
} from "../src/lib.js";

describe("defineTransformer", () => {
  it("returns a branded opaque definition", () => {
    const def = defineTransformer({ hooks: {} });
    assert.ok(def);
    assert.strictEqual(typeof def, "object");
  });

  it("accepts an empty hooks object", () => {
    const def = defineTransformer({ hooks: {} });
    assert.ok(def);
  });

  it("accepts hooks with valid catalog names", () => {
    const def = defineTransformer({
      hooks: {
        "tool:post": (_event, _ctx) => undefined,
        "session:open": (_event, _ctx) => {},
      },
    });
    assert.ok(def);
  });

  it("accepts hook aliases (tool:permission)", () => {
    const def = defineTransformer({
      hooks: {
        "tool:permission": (_event, _ctx) => undefined,
      },
    });
    assert.ok(def);
  });

  it("throws on unknown hook name — typo", () => {
    assert.throws(
      () =>
        defineTransformer({
          hooks: {
            "tool:complete": (_event, _ctx) => undefined,
          },
        }),
      /unknown hook name "tool:complete"/,
    );
  });

  it("throws on unknown hook name — completely wrong string", () => {
    assert.throws(
      () =>
        defineTransformer({
          hooks: {
            "onToolEnd": (_event, _ctx) => undefined,
          },
        }),
      /unknown hook name "onToolEnd"/,
    );
  });

  it("throws on mix of valid and invalid names", () => {
    assert.throws(
      () =>
        defineTransformer({
          hooks: {
            "tool:post": (_event, _ctx) => undefined,
            "tool:complet": (_event, _ctx) => undefined,
          },
        }),
      /unknown hook name "tool:complet"/,
    );
  });

  it("accepts setup callback", () => {
    const def = defineTransformer({
      setup: (_ctx) => {},
      hooks: {},
    });
    assert.ok(def);
  });

  it("accepts async setup callback", () => {
    const def = defineTransformer({
      setup: async (_ctx) => {},
      hooks: {},
    });
    assert.ok(def);
  });

  it("accepts async hook handlers", () => {
    const def = defineTransformer({
      hooks: {
        "tool:post": async (_event, _ctx) => undefined,
      },
    });
    assert.ok(def);
  });

  it("throws on unknown hook even with setup present", () => {
    assert.throws(
      () =>
        defineTransformer({
          setup: (_ctx) => {},
          hooks: {
            "fake:hook": (_event, _ctx) => undefined,
          },
        }),
      /unknown hook name "fake:hook"/,
    );
  });

  it("lists all valid hook names in the error message", () => {
    let caughtMsg = "";
    try {
      defineTransformer({
        hooks: {
          "bogus": (_event, _ctx) => undefined,
        },
      });
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    assert.ok(caughtMsg.length > 0, "should have thrown");
    assert.ok(caughtMsg.includes("session:open"));
    assert.ok(caughtMsg.includes("tool:post"));
    assert.ok(caughtMsg.includes("prompt:pre"));
  });

  it("accepts all 25 catalog hook names", () => {
    const validNames = [
      "session:open",
      "session:close",
      "session:idle",
      "prompt:pre",
      "permission:pre",
      "tool:permission",
      "permission:replied",
      "tool:start",
      "tool:progress",
      "tool:post",
      "file:edited",
      "message:assistant",
      "message:thought",
      "message:user",
      "plan:update",
      "mode:change",
      "mode:update",
      "commands:update",
      "session:cancel",
      "session:new",
      "session:load",
      "auth:required",
      "agent:initialize",
      "agent:swap",
      "compaction",
    ] as const;

    for (const name of validNames) {
      const def = defineTransformer({
        hooks: {
          [name]: (_event, _ctx) => undefined,
        },
      });
      assert.ok(def, `should accept hook name: ${String(name)}`);
    }
  });

  it("definition is opaque — no public constructor", () => {
    const def = defineTransformer({ hooks: {} });
    // The brand symbol is non-enumerable and not accessible via normal means.
    // Users cannot construct this type themselves since they have no access
    // to the internal symbol reference.
    const descriptors = Object.getOwnPropertyDescriptors(def);
    const brandKeys = Object.getOwnPropertySymbols(def);
    assert.strictEqual(brandKeys.length, 1, "should have exactly one symbol property (the brand)");
    assert.ok(
      !("__brand" in def),
      "brand should not be accessible by string key",
    );
  });
});

describe("runTransformer", () => {
  it("throws when HYDRA_ACP_WS_URL is missing", () => {
    const def = defineTransformer({ hooks: {} });
    const origWs = process.env.HYDRA_ACP_WS_URL;
    const origToken = process.env.HYDRA_ACP_TOKEN;

    delete process.env.HYDRA_ACP_WS_URL;
    delete process.env.HYDRA_ACP_TOKEN;

    assert.rejects(runTransformer(def), /HYDRA_ACP_WS_URL/);

    // Restore env.
    if (origWs) process.env.HYDRA_ACP_WS_URL = origWs;
    if (origToken) process.env.HYDRA_ACP_TOKEN = origToken;
  });
});
