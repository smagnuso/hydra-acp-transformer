// Claude-Code-style hook shim for hydra-acp.
//
// Drop this at ~/.hydra-acp/transformer.config.js (or point
// HYDRA_ACP_TRANSFORMER_CONFIG at it) to run shell-script hooks using
// the same conventions Claude Code exposes via ~/.claude/settings.json.
//
// Supported Claude events (mapped to hydra hooks below):
//   PreToolUse          → permission:pre              (only fires for permission-gated tool calls)
//   PostToolUse         → tool:post                   (status=completed)
//   PostToolUseFailure  → tool:post                   (status=failed)
//   PermissionRequest   → permission:replied          (audit, post-decision)
//   PermissionDenied    → permission:replied          (outcome=cancelled)
//   Notification        → permission:replied          (closest analog hydra has)
//   UserPromptSubmit    → prompt:pre
//   MessageDisplay      → message:assistant           (streaming chunks)
//   Stop                → session:idle
//   SessionStart        → session:open
//   SessionEnd          → session:close
//   PreCompact          → compaction                  (phase=pre, notification-only)
//   PostCompact         → compaction                  (phase=completed, notification-only)
//   TaskCreated         → plan:update                 (diff: entry appeared)
//   TaskCompleted       → plan:update                 (diff: status → completed)
//   Setup               → setup() callback            (fires once at startup)
//   FileChanged         → fs.watch in setup           (shim-side, not from agent)
//   ConfigChange        → fs.watch in setup           (watches settings files)
//   InstructionsLoaded  → fs.watch in setup           (watches CLAUDE.md, rules)
//
// Not modeled (no userspace workaround):
//   SubagentStart/Stop                                 — hydra planner emits deferred
//   WorktreeCreate/Remove                              — hydra has no worktree concept
//   UserPromptExpansion, TeammateIdle, Elicitation*,
//   PermissionRequest dialog, StopFailure              — need daemon-internal signals
//
// Shell-script contract (matches Claude Code):
//   stdin   : JSON payload (session_id, hook_event_name, tool_name?, tool_input?, prompt?)
//   exit 0  : continue, no rewrite
//   exit 2  : block (stderr text used as reason); for PreToolUse denies the tool
//   other≠0 : non-blocking error (logged, hydra continues)
//   stdout  : optional JSON  { decision: "approve"|"block", reason }
//                          | { hookSpecificOutput: { additionalContext } } (UserPromptSubmit)

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineTransformer } from "@hydra-acp/transformer";

// ── Files to watch (shim-side file watcher) ───────────────────────────────
//
// GLOBAL_WATCH: absolute paths, watched once in setup() before any session.
// PROJECT_WATCH: paths relative to each session's cwd, watched per-session
// (started in session:open, closed in session:close).

const GLOBAL_WATCH = {
  ConfigChange: [`${homedir()}/.claude/settings.json`],
};

const PROJECT_WATCH = {
  FileChanged:        ["src", "test"],
  ConfigChange:       [".claude/settings.json", ".claude/settings.local.json"],
  InstructionsLoaded: ["CLAUDE.md", ".claude/rules"],
};

// ── Hook table — edit this to match your ~/.claude/settings.json ───────────
//
// `matcher`: regex matched against the tool name (or "*" for any).
// `command`: shell command to run. Receives the JSON payload on stdin.

const CLAUDE_HOOKS = {
  PreToolUse:         [{ matcher: "^Bash$", command: "~/.claude/hooks/deny-rm-rf.sh" }],
  PostToolUse:        [{ matcher: ".*",     command: "~/.claude/hooks/log-tool-call.sh" }],
  PostToolUseFailure: [{ matcher: ".*",     command: "~/.claude/hooks/log-tool-failure.sh" }],
  PermissionRequest:  [{ matcher: ".*",     command: "~/.claude/hooks/audit-permission.sh" }],
  PermissionDenied:   [{ matcher: ".*",     command: "~/.claude/hooks/log-denied.sh" }],
  Notification:       [{ matcher: "*",      command: "~/.claude/hooks/notify.sh" }],
  UserPromptSubmit:   [{ matcher: "*",      command: "~/.claude/hooks/inject-context.sh" }],
  MessageDisplay:     [{ matcher: "*",      command: "~/.claude/hooks/tee-output.sh" }],
  Stop:               [{ matcher: "*",      command: "~/.claude/hooks/notify-done.sh" }],
  SessionStart:       [{ matcher: "*",      command: "~/.claude/hooks/session-start.sh" }],
  SessionEnd:         [{ matcher: "*",      command: "~/.claude/hooks/session-end.sh" }],
  PreCompact:         [{ matcher: "*",      command: "~/.claude/hooks/archive-transcript.sh" }],
  PostCompact:        [{ matcher: "*",      command: "~/.claude/hooks/log-compact.sh" }],
  TaskCreated:        [{ matcher: "*",      command: "~/.claude/hooks/task-created.sh" }],
  TaskCompleted:      [{ matcher: "*",      command: "~/.claude/hooks/task-completed.sh" }],
  Setup:              [{ matcher: "*",      command: "~/.claude/hooks/setup.sh" }],
  FileChanged:        [{ matcher: "*",      command: "~/.claude/hooks/file-changed.sh" }],
  ConfigChange:       [{ matcher: "*",      command: "~/.claude/hooks/config-changed.sh" }],
  InstructionsLoaded: [{ matcher: "*",      command: "~/.claude/hooks/rules-changed.sh" }],
};

// Per-session plan snapshot for diffing TaskCreated / TaskCompleted out of plan:update.
function planEntryKey(e) { return e?.id ?? e?.title ?? JSON.stringify(e); }

// ── Shell-invocation helper ───────────────────────────────────────────────

function runShellHook(command, payload) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ code: -1, stdout: "", stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function matchesAny(entries, toolName) {
  return entries.filter((e) => {
    if (!e.matcher || e.matcher === "*") return true;
    try { return new RegExp(e.matcher).test(toolName ?? ""); }
    catch { return e.matcher === toolName; }
  });
}

async function dispatchClaude(eventName, toolName, payload) {
  const entries = matchesAny(CLAUDE_HOOKS[eventName] ?? [], toolName);
  const results = [];
  for (const { command } of entries) {
    results.push(await runShellHook(command, payload));
  }
  return results;
}

function parseJsonReply(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try { return JSON.parse(trimmed); }
  catch { return null; }
}

// ── Transformer definition ────────────────────────────────────────────────

function startWatchers(table, rootDir, sessionId) {
  const watchers = [];
  for (const [claudeEvent, paths] of Object.entries(table)) {
    for (const path of paths) {
      const abs = rootDir ? resolve(rootDir, path) : resolve(path);
      try {
        const w = watch(abs, { recursive: true }, (eventType, filename) => {
          dispatchClaude(claudeEvent, "", {
            session_id: sessionId,
            hook_event_name: claudeEvent,
            event_type: eventType,
            path: filename ? resolve(abs, filename) : abs,
          });
        });
        w.on("error", () => { /* path may not exist; ignore */ });
        watchers.push(w);
      } catch { /* path may not exist; ignore */ }
    }
  }
  return watchers;
}

export default defineTransformer({
  setup: async () => {
    await dispatchClaude("Setup", "", { hook_event_name: "Setup" });
    // Global watchers (e.g. ~/.claude/settings.json) live for the host's
    // lifetime; per-session watchers are set up in session:open below.
    startWatchers(GLOBAL_WATCH, null, undefined);
  },

  hooks: {
    "permission:pre": async (event, ctx) => {
      const toolName = event?.toolCall?.kind ?? event?.toolCall?.toolName ?? "tool";
      const payload = {
        session_id: ctx.sessionId,
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: event?.toolCall?.rawInput ?? {},
        cwd: ctx.cwd,
      };
      for (const r of await dispatchClaude("PreToolUse", toolName, payload)) {
        const reply = parseJsonReply(r.stdout);
        if (reply?.decision === "block" || r.code === 2) {
          return { block: true, reason: reply?.reason ?? r.stderr.trim() ?? "denied by hook" };
        }
        if (reply?.decision === "approve") {
          return { approve: true, optionId: "allow" };
        }
      }
    },

    "tool:post": async (event, ctx) => {
      const claudeEvent = event?.status === "failed" ? "PostToolUseFailure" : "PostToolUse";
      const toolName = event?.kind ?? "tool";
      await dispatchClaude(claudeEvent, toolName, {
        session_id: ctx.sessionId,
        hook_event_name: claudeEvent,
        tool_name: toolName,
        tool_call_id: event?.toolCallId,
        status: event?.status,
        content: event?.content,
      });
    },

    "permission:replied": async (event, ctx) => {
      const outcome = event?.outcome?.outcome ?? "unknown";
      const claudeEvent = outcome === "cancelled" ? "PermissionDenied" : "PermissionRequest";
      const toolName = event?.toolCallId ?? "tool";
      const payload = {
        session_id: ctx.sessionId,
        hook_event_name: claudeEvent,
        tool_call_id: event?.toolCallId,
        outcome,
        option_id: event?.outcome?.optionId,
      };
      await dispatchClaude(claudeEvent, toolName, payload);
      // Claude also fires `Notification` for permission prompts — fan out.
      await dispatchClaude("Notification", "", {
        session_id: ctx.sessionId,
        hook_event_name: "Notification",
        type: claudeEvent === "PermissionDenied" ? "permission_denied" : "permission_prompt",
      });
    },

    "plan:update": async (event, ctx) => {
      const entries = event?.update?.entries ?? event?.entries ?? [];
      const prev = ctx.state.get("plan") ?? new Map();
      const next = new Map(entries.map((e) => [planEntryKey(e), e]));

      for (const [key, entry] of next) {
        const before = prev.get(key);
        if (!before) {
          await dispatchClaude("TaskCreated", "", {
            session_id: ctx.sessionId,
            hook_event_name: "TaskCreated",
            task: entry,
          });
        } else if (before.status !== "completed" && entry.status === "completed") {
          await dispatchClaude("TaskCompleted", "", {
            session_id: ctx.sessionId,
            hook_event_name: "TaskCompleted",
            task: entry,
          });
        }
      }
      ctx.state.set("plan", next);
    },

    "message:assistant": async (event, ctx) => {
      // MessageDisplay fires for every assistant text chunk — keep handlers cheap.
      await dispatchClaude("MessageDisplay", "", {
        session_id: ctx.sessionId,
        hook_event_name: "MessageDisplay",
        content: event?.update?.content,
      });
    },

    "prompt:pre": async (event, ctx) => {
      const payload = {
        session_id: ctx.sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: event?.prompt,
        cwd: ctx.cwd,
      };
      for (const r of await dispatchClaude("UserPromptSubmit", "", payload)) {
        if (r.code === 2) {
          return { block: true, reason: r.stderr.trim() || "blocked by hook" };
        }
        const reply = parseJsonReply(r.stdout);
        const extra = reply?.hookSpecificOutput?.additionalContext;
        if (extra && Array.isArray(event?.prompt)) {
          return { transform: { ...event, prompt: [...event.prompt, { type: "text", text: extra }] } };
        }
      }
    },

    "session:idle": async (event, ctx) => {
      await dispatchClaude("Stop", "", {
        session_id: ctx.sessionId,
        hook_event_name: "Stop",
        stop_reason: event?.stopReason,
      });
    },

    "session:open": async (event, ctx) => {
      await dispatchClaude("SessionStart", "", {
        session_id: ctx.sessionId,
        hook_event_name: "SessionStart",
        cwd: ctx.cwd,
      });
      // Watch this session's cwd for FileChanged / ConfigChange /
      // InstructionsLoaded. Stored in per-session state for cleanup.
      if (ctx.cwd) {
        const watchers = startWatchers(PROJECT_WATCH, ctx.cwd, ctx.sessionId);
        ctx.state.set("fileWatchers", watchers);
      }
    },

    "session:close": async (event, ctx) => {
      for (const w of ctx.state.get("fileWatchers") ?? []) {
        try { w.close(); } catch { /* already closed */ }
      }
      await dispatchClaude("SessionEnd", "", {
        session_id: ctx.sessionId,
        hook_event_name: "SessionEnd",
        reason: event?.reason,
      });
    },

    "compaction": async (event, ctx) => {
      // Hydra emits compaction once per phase ("pre", "summarizing", "completed", ...).
      // Map the bookends to Claude's Pre/PostCompact; ignore intermediate phases.
      const phase = event?.phase;
      const claudeEvent =
        phase === "completed" ? "PostCompact" :
        phase === "pre"       ? "PreCompact"  : null;
      if (!claudeEvent) return;
      await dispatchClaude(claudeEvent, "", {
        session_id: ctx.sessionId,
        hook_event_name: claudeEvent,
        phase,
        trigger: event?.trigger ?? "auto",
      });
    },
  },
});
