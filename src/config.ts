import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface HostConfig {
  hydraDaemonUrl: string;
  hydraWsUrl: string;
  hydraToken: string;
  configPath: string;
  debug: boolean;
}

export function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  }
  if (httpUrl.startsWith("http://")) {
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  }
  throw new Error(`hydraDaemonUrl must start with http:// or https://: ${httpUrl}`);
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

function resolveConfigPath(): string {
  const override = process.env.HYDRA_ACP_TRANSFORMER_CONFIG;
  if (override && override.length > 0) {
    return override;
  }
  const base = resolve(homedir(), ".hydra-acp", "transformer.config");
  // Try each extension in order; return the first that exists.
  for (const ext of [".js", ".ts", ".mjs", ".cjs"]) {
    if (existsSync(base + ext)) {
      return base + ext;
    }
  }
  // None found — return the .js path so the host can warn and idle.
  return base + ".js";
}

export function loadHostConfig(): HostConfig {
  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ?? "http://127.0.0.1:55514";
  const hydraToken = process.env.HYDRA_ACP_TOKEN ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var. When run as a hydra extension, hydra injects this automatically.",
    );
  }
  const hydraWsUrl =
    process.env.HYDRA_ACP_WS_URL ?? deriveWsUrl(hydraDaemonUrl);
  const configPath = resolveConfigPath();

  return {
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    configPath,
    debug: boolEnv("DEBUG", false),
  };
}
