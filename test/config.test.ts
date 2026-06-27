import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { deriveWsUrl, loadHostConfig } from "../src/config.js";

describe("deriveWsUrl", () => {
  it("converts http:// to ws://", () => {
    assert.strictEqual(deriveWsUrl("http://127.0.0.1:55514"), "ws://127.0.0.1:55514/acp");
  });

  it("converts https:// to wss://", () => {
    assert.strictEqual(deriveWsUrl("https://example.com"), "wss://example.com/acp");
  });

  it("strips trailing slash", () => {
    assert.strictEqual(deriveWsUrl("http://127.0.0.1:8765/"), "ws://127.0.0.1:8765/acp");
  });

  it("throws on neither http:// nor https://", () => {
    assert.throws(
      () => deriveWsUrl("ftp://127.0.0.1:8765"),
      /must start with http:\/\/ or https:\/\//,
    );
  });
});

describe("loadHostConfig", () => {
  const savedToken = process.env.HYDRA_ACP_TOKEN;
  const savedDaemonUrl = process.env.HYDRA_ACP_DAEMON_URL;
  const savedWsUrl = process.env.HYDRA_ACP_WS_URL;
  const savedConfigPath = process.env.HYDRA_ACP_TRANSFORMER_CONFIG;
  const savedDebug = process.env.DEBUG;

  afterEach(() => {
    if (savedToken !== undefined) process.env.HYDRA_ACP_TOKEN = savedToken;
    else delete process.env.HYDRA_ACP_TOKEN;

    if (savedDaemonUrl !== undefined) process.env.HYDRA_ACP_DAEMON_URL = savedDaemonUrl;
    else delete process.env.HYDRA_ACP_DAEMON_URL;

    if (savedWsUrl !== undefined) process.env.HYDRA_ACP_WS_URL = savedWsUrl;
    else delete process.env.HYDRA_ACP_WS_URL;

    if (savedConfigPath !== undefined) process.env.HYDRA_ACP_TRANSFORMER_CONFIG = savedConfigPath;
    else delete process.env.HYDRA_ACP_TRANSFORMER_CONFIG;

    if (savedDebug !== undefined) process.env.DEBUG = savedDebug;
    else delete process.env.DEBUG;
  });

  it("throws when HYDRA_ACP_TOKEN is missing", () => {
    delete process.env.HYDRA_ACP_TOKEN;
    assert.throws(
      loadHostConfig,
      /Missing HYDRA_ACP_TOKEN env var/,
    );
  });

  it("uses default daemon URL when not set", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    delete process.env.HYDRA_ACP_DAEMON_URL;
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.hydraDaemonUrl, "http://127.0.0.1:55514");
  });

  it("reads custom HYDRA_ACP_DAEMON_URL", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    process.env.HYDRA_ACP_DAEMON_URL = "http://custom.host:9999";
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.hydraDaemonUrl, "http://custom.host:9999");
  });

  it("derives WS URL from daemon URL", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    delete process.env.HYDRA_ACP_WS_URL;
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.hydraWsUrl, "ws://127.0.0.1:55514/acp");
  });

  it("uses HYDRA_ACP_WS_URL when set", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    process.env.HYDRA_ACP_WS_URL = "ws://override:3000/acp";
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.hydraWsUrl, "ws://override:3000/acp");
  });

  it("reads HYDRA_ACP_TOKEN", () => {
    process.env.HYDRA_ACP_TOKEN = "my-secret-token";
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.hydraToken, "my-secret-token");
  });

  it("uses HYDRA_ACP_TRANSFORMER_CONFIG override", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    process.env.HYDRA_ACP_TRANSFORMER_CONFIG = "/tmp/fake.config.js";
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.configPath, "/tmp/fake.config.js");
  });

  it("defaults configPath to ~/.hydra-acp/transformer.config.js", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    delete process.env.HYDRA_ACP_TRANSFORMER_CONFIG;
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.configPath, join(homedir(), ".hydra-acp", "transformer.config.js"));
  });

  it("resolves to .ts extension when .js does not exist but .ts does", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    delete process.env.HYDRA_ACP_TRANSFORMER_CONFIG;

    const tmpDir = join(homedir(), ".hydra-acp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const jsPath = join(tmpDir, "transformer.config.js");
    const tsPath = join(tmpDir, "transformer.config.ts");

    // Remove .js if it exists, create .ts
    if (existsSync(jsPath)) rmSync(jsPath);
    writeFileSync(tsPath, "// placeholder", "utf8");

    try {
      const cfg = loadHostConfig();
      assert.strictEqual(cfg.configPath, tsPath);
    } finally {
      rmSync(tsPath);
    }
  });

  it("sets debug from DEBUG env var", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    process.env.DEBUG = "1";
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.debug, true);
  });

  it("debug is false by default", () => {
    process.env.HYDRA_ACP_TOKEN = "test-token";
    delete process.env.DEBUG;
    const cfg = loadHostConfig();
    assert.strictEqual(cfg.debug, false);
  });
});
