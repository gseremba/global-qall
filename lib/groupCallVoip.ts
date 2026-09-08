export type GroupCallVoipPayload = {
  isGroupCall: true;
  groupCallId: string;
  conversationId: string;
  callerId: string | null;
  callerName: string;
  initiatorName: string;
  groupName: string;
  callType: "voice" | "video";
  hasVideo: boolean;
  expiresAt: string | null;
};

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean ? clean : null;
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["1", "true", "yes", "video"].includes(value.toLowerCase());
  }
  return false;
}

export function parseGroupCallVoipPayload(
  payload: Record<string, unknown> | null | undefined
): GroupCallVoipPayload | null {
  if (!payload) return null;

  const isGroup =
    payload.isGroupCall === true ||
    payload.is_group_call === true ||
    String(payload.isGroupCall ?? payload.is_group_call ?? "").toLowerCase() === "true";

  if (!isGroup) return null;

  const groupCallId =
    stringValue(payload.groupCallId) ??
    stringValue(payload.group_call_id) ??
    stringValue(payload.callId) ??
    stringValue(payload.call_id) ??
    stringValue(payload.uuid);

  const conversationId =
    stringValue(payload.conversationId) ??
    stringValue(payload.conversation_id);

  if (!groupCallId || !conversationId) {
    return null;
  }

  const callType =
    stringValue(payload.callType) === "video" ||
    stringValue(payload.call_type) === "video" ||
    boolValue(payload.hasVideo ?? payload.has_video)
      ? "video"
      : "voice";

  const groupName =
    stringValue(payload.groupName) ??
    stringValue(payload.group_name) ??
    stringValue(payload.callerName) ??
    stringValue(payload.caller_name) ??
    "Global Qall group";

  return {
    isGroupCall: true,
    groupCallId,
    conversationId,
    callerId:
      stringValue(payload.callerId) ??
      stringValue(payload.caller_id),
    callerName:
      stringValue(payload.callerName) ??
      stringValue(payload.caller_name) ??
      groupName,
    initiatorName:
      stringValue(payload.initiatorName) ??
      stringValue(payload.initiator_name) ??
      stringValue(payload.handle) ??
      "Global Qall user",
    groupName,
    callType,
    hasVideo: callType === "video",
    expiresAt:
      stringValue(payload.expiresAt) ??
      stringValue(payload.expires_at),
  };
}
