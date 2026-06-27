#!/usr/bin/env node
// Single binary, two modes:
//
//   1. Transformer mode — when spawned by the hydra-acp daemon, the env
//      var HYDRA_ACP_TRANSFORMER_NAME is set. We connect to the daemon
//      over WSS, register intercepts, and run the transformer loop until shutdown.
//
//   2. CLI mode — invoked from the user's shell. We parse argv and dispatch
//      to --version, --help, or --validate.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";
import { runHost } from "./host.js";
import { logger } from "./util/log.js";

const log = logger("main");

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function validateScript(path: string): void {
  const load = jiti(dirname(fileURLToPath(import.meta.url)), { interopDefault: true });
  const absPath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    const mod = load(absPath);
    if (mod === null || mod === undefined) {
      log.error(`--validate: '${path}' loaded but has no exports`);
      process.exit(1);
    }
    const def = (mod as Record<string, unknown>).default;
    if (typeof def !== "object" || def === null) {
      log.error(`--validate: '${path}' default export is not an object`);
      process.exit(1);
    }
    const hooks = (def as Record<string, unknown>).hooks;
    if (hooks === undefined) {
      log.error(`--validate: '${path}' missing 'hooks' on default export`);
      process.exit(1);
    }
    log.info(`--validate: '${path}' is valid`);
    process.exit(0);
  } catch (err) {
    log.error(`--validate: '${path}' invalid — ${(err as Error).message}`);
    process.exit(1);
  }
}

function runCli(argv: readonly string[]): void {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`hydra-acp-transformer ${readVersion()}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Run as a hydra-acp transformer extension; see ~/dev/hydra-acp/cli/plans/hooks-stage3.md\n",
    );
    return;
  }
  const validateIdx = argv.indexOf("--validate");
  if (validateIdx !== -1) {
    const path = argv[validateIdx + 1] ?? "unknown";
    validateScript(path);
    return;
  }
}

async function main(): Promise<void> {
  if (process.env.HYDRA_ACP_TRANSFORMER_NAME) {
    await runHost();
    return;
  }
  runCli(process.argv.slice(2));
}

main().catch((err) => {
  process.stderr.write(`hydra-acp-transformer: ${(err as Error).message}\n`);
  process.exit(1);
});
