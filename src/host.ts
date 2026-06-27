import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import type { Context, SetupContext } from "./lib.js";
import { TransformerBridge } from "./bridge.js";
import { loadHostConfig } from "./config.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("host");

interface UserDefinition {
  setup?: (ctx: SetupContext) => void | Promise<void>;
  hooks: Partial<Record<string, (event: unknown, ctx: Context) => unknown | Promise<unknown>>>;
}

/** Load and validate a user config file via jiti.
 *
 * Returns the parsed UserDefinition if the file exists and exports a valid
 * defineTransformer result, or undefined on any error (missing file, malformed
 * export, import failure). Designed to be testable in isolation. */
export async function loadUserScript(
  path: string,
): Promise<UserDefinition | undefined> {
  const jiti = createJiti(import.meta.url, { interopDefault: true });

  if (!existsSync(path)) {
    log.warn(`config file not found at ${path}, idling`);
    return undefined;
  }
  try {
    const mod = await jiti.import<Record<string, unknown>>(path);
    const raw = mod.default as Record<string, unknown> | undefined;
    if (
      !raw ||
      typeof raw !== "object" ||
      !("__brand" in raw && raw.__brand === "TransformerDefinition")
    ) {
      log.error(`transformer config at ${path} does not export a valid defineTransformer result`);
      return undefined;
    }
    return raw as unknown as UserDefinition;
  } catch (err) {
    log.error(`failed to load transformer config: ${(err as Error).message}`);
    return undefined;
  }
}

export async function runHost(): Promise<void> {
  const config = loadHostConfig();
  setDebug(config.debug);

  const jiti = createJiti(import.meta.url, { interopDefault: true });

  async function loadUserScriptFromDisk(
    path: string,
  ): Promise<UserDefinition | undefined> {
    if (!existsSync(path)) {
      log.warn(`config file not found at ${path}, idling`);
      return undefined;
    }
    try {
      const mod = await jiti.import<Record<string, unknown>>(path);
      const raw = mod.default as Record<string, unknown> | undefined;
      if (
        !raw ||
        typeof raw !== "object" ||
        !("__brand" in raw && raw.__brand === "TransformerDefinition")
      ) {
        log.error(`transformer config at ${path} does not export a valid defineTransformer result`);
        return undefined;
      }
      return raw as unknown as UserDefinition;
    } catch (err) {
      log.error(`failed to load transformer config: ${(err as Error).message}`);
      return undefined;
    }
  }

  function bustJitiCache(path: string): void {
    delete (jiti as unknown as { cache: Record<string, unknown> }).cache[path];
  }

  function buildBridge(def: UserDefinition | undefined): TransformerBridge {
    const definition = def ?? { hooks: {} };
    return new TransformerBridge({
      daemonWsUrl: config.hydraWsUrl,
      token: config.hydraToken,
      clientName: process.env.HYDRA_ACP_TRANSFORMER_NAME ?? "transformer",
      definition,
    });
  }

  const initialDef = await loadUserScriptFromDisk(config.configPath);
  if (!initialDef) {
    log.info("no transformer config found, idling");
  }

  const bridge = buildBridge(initialDef);
  bridge.start();

  process.on("SIGHUP", async () => {
    log.info(`SIGHUP — reloading transformer from ${config.configPath}`);
    bustJitiCache(config.configPath);
    const newDef = await loadUserScriptFromDisk(config.configPath);
    if (!newDef) {
      log.warn("reload failed or config missing — keeping old hooks");
      return;
    }
    bridge.replaceDefinition(newDef as UserDefinition);
    log.info("transformer reload complete");
  });

  const shutdown = (sig: string): void => {
    log.info(`${sig} received — shutting down`);
    bridge.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const transformerName = process.env.HYDRA_ACP_TRANSFORMER_NAME ?? "transformer";
  log.info(
    `hydra-acp-transformer up; name=${transformerName} config=${config.configPath} daemon=${config.hydraDaemonUrl}`,
  );
}
