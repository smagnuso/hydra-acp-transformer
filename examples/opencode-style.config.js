// Opencode-plugin-style hooks running as a hydra transformer.
//
// For users familiar with opencode's plugin API: write your plugin in
// the same shape you'd put at ~/.config/opencode/plugins/ — exported as
// an async function returning an event map — then drop this file at
// ~/.hydra-acp/transformer.config.js (or point HYDRA_ACP_TRANSFORMER_CONFIG
// at it). Your hooks run via hydra, so they apply to every ACP agent
// (Codex, Gemini, opencode-as-ACP, Claude when speaking ACP), not just
// opencode.
//
// Mappings (opencode event ← hydra hook):
//   tool.execute.before        ← permission:pre   (mutate output.args, throw to deny)
//   tool.execute.after         ← tool:post        (input.tool, output.error, output.metadata)
//   file.edited                ← file:edited
//   permission.asked / replied ← permission:replied
//   session.created            ← session:open
//   session.idle               ← session:idle
//   session.deleted            ← session:close
//   session.compacted          ← compaction (phase=completed)
//   todo.updated               ← plan:update (with diff)
//   experimental.session.compacting ← (not in hydra; ignored for now)
//   event (catch-all)          ← every lifecycle event
//
// Opencode-only events with no ACP wire source — ignored:
//   lsp.*, shell.env, tui.*, message.part.*, installation.updated,
//   server.connected.

import { defineTransformer } from "@hydra-acp/transformer";

// ── Your opencode-style plugin ────────────────────────────────────────────
//
// Same shape as ~/.config/opencode/plugins/*.js — async function taking
// ({ project, directory, worktree, client, $ }) and returning an event map.
// Copy-paste an existing plugin here and it should just work, modulo:
//   - `$` (Bun shell) is not provided. Use node:child_process if you need to
//     spawn shells.
//   - `client` (opencode SDK) is not provided. Use the hydra ctx instead.
//   - Custom tools (the `tool` export) aren't supported in hydra — opencode
//     owns the tool registry, not hydra.

const Plugin = async ({ project, directory, worktree, client, $ }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && /\brm -rf\b/.test(output.args.command ?? "")) {
        throw new Error("rm -rf denied by policy");
      }
    },

    "tool.execute.after": async (input, output) => {
      console.log(`[hooks] tool ${input.tool} ${output.error ? "failed" : "ok"}`);
    },

    "file.edited": async (input) => {
      console.log(`[hooks] file edited: ${input.file}`);
    },

    "session.idle": async (input) => {
      console.log(`[hooks] session idle: ${input.sessionID}`);
    },

    "todo.updated": async (input) => {
      const completed = (input.todos ?? []).filter((t) => t.status === "completed");
      if (completed.length) console.log(`[hooks] ${completed.length} todos completed`);
    },

    event: async ({ event }) => {
      // Catch-all — fires for every lifecycle event hydra can surface.
    },
  };
};

// ── Adapter ────────────────────────────────────────────────────────────────
//
// Instantiates Plugin once with a synthetic context, captures its returned
// event map, then dispatches hydra events to it after translating shapes.

const planSnapshots = new Map(); // sessionId → Map<id, todoEntry>
let pluginMap = null;
let pluginError = null;

async function ensurePlugin(ctx) {
  if (pluginMap || pluginError) return;
  try {
    pluginMap = await Plugin({
      project:   { worktree: process.cwd() },
      directory: ctx?.cwd ?? process.cwd(),
      worktree:  process.cwd(),
      client:    null,
      $:         null,
    });
  } catch (err) {
    pluginError = err;
    ctx?.logger.error(`opencode plugin init failed: ${err.message}`);
  }
}

async function invoke(eventName, ...args) {
  if (!pluginMap) return undefined;
  const fn = pluginMap[eventName];
  if (typeof fn !== "function") return undefined;
  try {
    return await fn(...args);
  } catch (err) {
    if (eventName === "tool.execute.before") throw err; // propagate denial
    console.error(`[hooks] "${eventName}" threw:`, err.message);
  }
}

export default defineTransformer({
  setup: async (ctx) => {
    await ensurePlugin(ctx);
  },

  hooks: {
    "permission:pre": async (event, ctx) => {
      await ensurePlugin(ctx);
      const input = {
        tool:      event?.toolCall?.kind ?? event?.toolCall?.toolName ?? "tool",
        sessionID: ctx.sessionId,
        callID:    event?.toolCall?.toolCallId,
      };
      const output = { args: { ...(event?.toolCall?.rawInput ?? {}) } };
      try {
        await invoke("tool.execute.before", input, output);
      } catch (err) {
        return { block: true, reason: err.message };
      }
      // If the plugin mutated output.args, surface it as a hydra transform
      // so the daemon rewrites the underlying envelope.
      const original = event?.toolCall?.rawInput ?? {};
      const mutated = Object.keys(output.args).some(
        (k) => output.args[k] !== original[k],
      );
      if (mutated) {
        return { transform: { ...event, toolCall: { ...event.toolCall, rawInput: output.args } } };
      }
    },

    "tool:post": async (event, ctx) => {
      await ensurePlugin(ctx);
      const input  = { tool: event?.kind ?? "tool", sessionID: ctx.sessionId, callID: event?.toolCallId };
      const output = { error: event?.status === "failed", metadata: event?.content };
      await invoke("tool.execute.after", input, output);
    },

    "file:edited": async (event, ctx) => {
      await ensurePlugin(ctx);
      await invoke("file.edited", { file: event?.path, sessionID: ctx.sessionId });
    },

    "permission:replied": async (event, ctx) => {
      await ensurePlugin(ctx);
      const opencodeEvent = event?.outcome?.outcome === "cancelled" ? "permission.replied" : "permission.asked";
      await invoke(opencodeEvent, {
        sessionID: ctx.sessionId,
        callID:    event?.toolCallId,
        response:  event?.outcome?.optionId ?? event?.outcome?.outcome,
      });
    },

    "session:open": async (event, ctx) => {
      await ensurePlugin(ctx);
      await invoke("session.created", { sessionID: ctx.sessionId });
      await invoke("event", { event: { type: "session.created", properties: { sessionID: ctx.sessionId } } });
    },

    "session:close": async (event, ctx) => {
      await ensurePlugin(ctx);
      planSnapshots.delete(ctx.sessionId);
      await invoke("session.deleted", { sessionID: ctx.sessionId });
      await invoke("event", { event: { type: "session.deleted", properties: { sessionID: ctx.sessionId } } });
    },

    "session:idle": async (event, ctx) => {
      await ensurePlugin(ctx);
      await invoke("session.idle", { sessionID: ctx.sessionId, stopReason: event?.stopReason });
      await invoke("event", { event: { type: "session.idle", properties: { sessionID: ctx.sessionId, stopReason: event?.stopReason } } });
    },

    "compaction": async (event, ctx) => {
      await ensurePlugin(ctx);
      if (event?.phase !== "completed") return;
      await invoke("session.compacted", { sessionID: ctx.sessionId });
      await invoke("event", { event: { type: "session.compacted", properties: { sessionID: ctx.sessionId } } });
    },

    "plan:update": async (event, ctx) => {
      await ensurePlugin(ctx);
      const todos = event?.update?.entries ?? event?.entries ?? [];
      planSnapshots.set(ctx.sessionId, new Map(todos.map((t) => [t.id ?? t.title, t])));
      await invoke("todo.updated", { sessionID: ctx.sessionId, todos });
    },
  },
});
