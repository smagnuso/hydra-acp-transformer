// Predicate type for narrowing `response:session/update` envelopes by
// their `sessionUpdate` subtype.  Each filter receives the full
// `{ sessionId, update }` envelope the daemon sends over
// `hydra-acp/transformer/message`.

export type SessionUpdateFilter = (envelope: unknown) => boolean;

/** Check that an envelope has the expected shape before accessing nested fields. */
function isSessionUpdateEnvelope(envelope: unknown): envelope is {
  update?: { sessionUpdate?: string };
} {
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    "update" in envelope &&
    typeof (envelope as { update: unknown }).update === "object"
  );
}

/** `tool:start` — fires only on `sessionUpdate === "tool_call"`. */
export const toolStartFilter: SessionUpdateFilter = (
  envelope,
): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  return envelope.update?.sessionUpdate === "tool_call";
};

/** `tool:progress` — fires on `sessionUpdate === "tool_call_update"` but
 * excludes terminal statuses (`completed`, `failed`) because those route
 * to `tool:post` instead. */
export const toolProgressFilter: SessionUpdateFilter = (
  envelope,
): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  const su = envelope.update?.sessionUpdate;
  if (su !== "tool_call_update") return false;
  const status = (envelope.update as { status?: string }).status;
  if (status === "completed" || status === "failed") return false;
  return true;
};

/** `message:assistant` — fires on `sessionUpdate === "agent_message_chunk"`. */
export const messageAssistantFilter: SessionUpdateFilter = (
  envelope,
): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  return envelope.update?.sessionUpdate === "agent_message_chunk";
};

/** `message:thought` — fires on `sessionUpdate === "agent_thought_chunk"`. */
export const messageThoughtFilter: SessionUpdateFilter = (
  envelope,
): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  return envelope.update?.sessionUpdate === "agent_thought_chunk";
};

/** `message:user` — fires on `sessionUpdate === "user_message_chunk"`. */
export const messageUserFilter: SessionUpdateFilter = (envelope): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  return envelope.update?.sessionUpdate === "user_message_chunk";
};

/** `plan:update` — fires on `sessionUpdate === "plan"`. */
export const planUpdateFilter: SessionUpdateFilter = (envelope): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  return envelope.update?.sessionUpdate === "plan";
};

/** `mode:update` — fires on `sessionUpdate === "current_mode_update"`. */
export const modeUpdateFilter: SessionUpdateFilter = (envelope): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  return envelope.update?.sessionUpdate === "current_mode_update";
};

/** `commands:update` — fires on `sessionUpdate === "available_commands_update"`. */
export const commandsUpdateFilter: SessionUpdateFilter = (
  envelope,
): boolean => {
  if (!isSessionUpdateEnvelope(envelope)) return false;
  return envelope.update?.sessionUpdate === "available_commands_update";
};
