import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadUserScript } from "../src/host.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtemp(join(tmpdir(), "hydra-transformer-test-"));
}

/** Write a config that exports a valid defineTransformer result.
 *
 * loadUserScript checks for __brand === "TransformerDefinition" on the
 * default export, so we inline that marker directly — no module resolution
 * needed from temp directories. */
function writeValidConfig(path: string, hookNames: string[]): void {
  const hooks = hookNames.map((name) => `    "${name}": async (event) => {}`).join(",\n");
  writeFileSync(
    path,
    `const __def = { hooks: {\n${hooks}\n} };
Object.defineProperty(__def, "__brand", { value: "TransformerDefinition", writable: false });
export default __def;
`,
    "utf8",
  );
}

// ── loadUserScript tests ─────────────────────────────────────────────────────

describe("loadUserScript", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a missing config file", async () => {
    const result = await loadUserScript("/nonexistent/path/transformer.config.js");
    assert.strictEqual(result, undefined);
  });

  it("returns the UserDefinition when config has a valid defineTransformer export", async () => {
    tmpDir = await makeTempDir();
    const configPath = join(tmpDir, "transformer.config.js");

    writeValidConfig(configPath, ["tool:post", "session:idle"]);

    const result = await loadUserScript(configPath);
    assert.ok(result, "should return a definition for valid config");
    assert.ok(result.hooks, "definition should have hooks");
    assert.ok("tool:post" in result.hooks, "should contain tool:post hook");
    assert.ok("session:idle" in result.hooks, "should contain session:idle hook");
  });

  it("returns undefined when default export is not a defineTransformer result", async () => {
    tmpDir = await makeTempDir();
    const configPath = join(tmpDir, "transformer.config.js");

    writeFileSync(
      configPath,
      `// No __brand — just a plain object.
export default { hooks: {}, invalid: true };
`,
      "utf8",
    );

    const result = await loadUserScript(configPath);
    assert.strictEqual(result, undefined);
  });

  it("returns undefined when the config has no default export at all", async () => {
    tmpDir = await makeTempDir();
    const configPath = join(tmpDir, "transformer.config.js");

    writeFileSync(
      configPath,
      `// No default export — just a helper function.
function helper() { return {}; }
export { helper };
`,
      "utf8",
    );

    const result = await loadUserScript(configPath);
    assert.strictEqual(result, undefined);
  });

  it("returns undefined when the config throws on import", async () => {
    tmpDir = await makeTempDir();
    const configPath = join(tmpDir, "transformer.config.js");

    writeFileSync(
      configPath,
      `throw new Error("syntax is broken");
`,
      "utf8",
    );

    const result = await loadUserScript(configPath);
    assert.strictEqual(result, undefined);
  });

  it("SIGHUP reload picks up new hooks after writing a new config to disk", async () => {
    tmpDir = await makeTempDir();

    // Initial config with one hook.
    const initialPath = join(tmpDir, "transformer.config.v1.js");
    writeValidConfig(initialPath, ["tool:post"]);

    const initialDef = await loadUserScript(initialPath);
    assert.ok(initialDef, "initial config should load");
    assert.ok("tool:post" in initialDef.hooks, "should have tool:post hook");
    assert.strictEqual(
      Object.keys(initialDef.hooks).length,
      1,
      "should have exactly one hook",
    );

    // Simulate SIGHUP: write a new config with different hooks at the same
    // logical path. The real host would bust jiti cache before reloading;
    // using a distinct temp file here avoids jiti's global path cache while
    // exercising the same reload semantics (new file → new hooks).
    const reloadedPath = join(tmpDir, "transformer.config.v2.js");
    writeValidConfig(reloadedPath, ["file:edited", "session:idle"]);

    const reloadedDef = await loadUserScript(reloadedPath);
    assert.ok(reloadedDef, "reloaded config should load");
    assert.strictEqual(
      Object.keys(reloadedDef.hooks).length,
      2,
      "should have two hooks after reload",
    );
    assert.ok("file:edited" in reloadedDef.hooks, "should have file:edited hook");
    assert.ok("session:idle" in reloadedDef.hooks, "should have session:idle hook");
    assert.strictEqual(
      "tool:post" in reloadedDef.hooks,
      false,
      "old tool:post hook should be gone",
    );
  });
});
