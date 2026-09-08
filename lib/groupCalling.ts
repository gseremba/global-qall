import { supabase } from "./supabase";

export type GroupCallType = "voice" | "video";

export type GroupCallStatus =
  | "ringing"
  | "active"
  | "ended"
  | "cancelled"
  | "failed";

export type GroupParticipantStatus =
  | "invited"
  | "ringing"
  | "joined"
  | "declined"
  | "left"
  | "missed"
  | "failed";

export type GroupPeerStatus =
  | "pending"
  | "offered"
  | "answered"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type GroupCall = {
  id: string;
  conversation_id: string;
  created_by: string;
  call_type: GroupCallType;
  status: GroupCallStatus;
  group_name_snapshot: string | null;
  group_avatar_url_snapshot: string | null;
  participant_limit: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  last_state_changed_at: string;
  updated_at: string;
};

export type GroupCallParticipant = {
  id: string;
  group_call_id: string;
  user_id: string;
  role: "host" | "participant";
  status: GroupParticipantStatus;
  invited_at: string;
  ringing_at: string | null;
  joined_at: string | null;
  left_at: string | null;
  last_seen_at: string | null;
  is_muted: boolean;
  camera_enabled: boolean;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type GroupPeerSession = {
  id: string;
  group_call_id: string;
  peer_a_id: string;
  peer_b_id: string;
  peer_key: string;
  offerer_id: string;
  answerer_id: string;
  status: GroupPeerStatus;
  offer: Record<string, unknown> | null;
  answer: Record<string, unknown> | null;
  ice_generation: number;
  last_connected_at: string | null;
  disconnected_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GroupPeerNegotiation = {
  peerSessionId: string;
  groupCallId: string;
  peerAId: string;
  peerBId: string;
  offererId: string;
  answererId: string;
  localRole: "offerer" | "answerer";
  remoteUserId: string;
  status: GroupPeerStatus;
  iceGeneration: number;
  offer: Record<string, unknown> | null;
  answer: Record<string, unknown> | null;
  updatedAt: string;
};

export type GroupIceCandidateRow = {
  id: number;
  user_id: string;
  ice_generation: number;
  candidate: Record<string, unknown>;
  created_at: string;
};

function groupCallError(message: string): Error {
  const mappings: Array<[string, string]> = [
    ["AUTH_REQUIRED", "You must be signed in."],
    ["NOT_GROUP_MEMBER", "You are no longer a member of this group."],
    ["GROUP_CALL_ALREADY_ACTIVE", "A group call is already active in this group."],
    ["GROUP_CALL_LIMIT_EXCEEDED", "This group is too large for the current group-call limit."],
    ["GROUP_CALL_FULL", "This group call is full."],
    ["USER_BUSY", "You are already on another call."],
    ["GROUP_CALL_NOT_FOUND", "This group call no longer exists."],
    ["GROUP_CALL_NOT_JOINABLE", "This group call can no longer be joined."],
    ["GROUP_CALL_INVITE_NOT_ACTIVE", "This group-call invitation is no longer active."],
    ["PEER_SESSION_ACCESS_DENIED", "You cannot access this peer connection."],
    ["PEER_SESSION_NOT_FOUND", "This peer connection no longer exists."],
    ["OFFERER_REQUIRED", "This device is not the offerer for this peer connection."],
    ["ANSWERER_REQUIRED", "This device is not the answerer for this peer connection."],
    ["STALE_ICE_GENERATION", "This WebRTC negotiation is stale and must be refreshed."],
    ["PEER_SESSION_NOT_NEGOTIABLE", "This peer connection can no longer be negotiated."],
    ["PEER_SESSION_CLOSED", "This peer connection is closed."],
    ["SDP_OFFER_REQUIRED", "The remote offer has not arrived yet."],
    ["SDP_NEGOTIATION_INCOMPLETE", "WebRTC negotiation is not complete yet."],
  ];

  const mapped = mappings.find(([code]) =>
    message.includes(code)
  );

  return new Error(mapped?.[1] ?? message);
}

async function rpc<T>(
  functionName: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { data, error } = await supabase.rpc(
    functionName,
    args ?? {}
  );

  if (error) {
    throw groupCallError(error.message);
  }

  return data as T;
}

export async function startGroupCall(
  conversationId: string,
  callType: GroupCallType
): Promise<string> {
  return rpc<string>("start_group_call", {
    requested_conversation_id: conversationId,
    requested_call_type: callType,
  });
}

export async function joinGroupCall(
  groupCallId: string
): Promise<string> {
  return rpc<string>("join_group_call", {
    requested_group_call_id: groupCallId,
  });
}

export async function leaveGroupCall(
  groupCallId: string,
  reason = "local_leave"
): Promise<void> {
  await rpc<void>("leave_group_call", {
    requested_group_call_id: groupCallId,
    requested_reason: reason,
  });
}

export async function endGroupCall(
  groupCallId: string,
  reason = "host_ended"
): Promise<void> {
  await rpc<void>("end_group_call", {
    requested_group_call_id: groupCallId,
    requested_reason: reason,
  });
}

export async function touchGroupCallLiveness(
  groupCallId: string
): Promise<void> {
  await rpc<void>("touch_group_call_participant_liveness", {
    requested_group_call_id: groupCallId,
  });
}

export async function getPeerNegotiation(
  peerSessionId: string
): Promise<GroupPeerNegotiation> {
  return rpc<GroupPeerNegotiation>(
    "get_group_call_peer_negotiation",
    {
      requested_peer_session_id: peerSessionId,
    }
  );
}

export async function submitGroupOffer(
  peerSessionId: string,
  offer: Record<string, unknown>,
  iceGeneration: number
): Promise<void> {
  await rpc<void>("submit_group_call_offer", {
    requested_peer_session_id: peerSessionId,
    requested_offer: offer,
    requested_ice_generation: iceGeneration,
  });
}

export async function submitGroupAnswer(
  peerSessionId: string,
  answer: Record<string, unknown>,
  iceGeneration: number
): Promise<void> {
  await rpc<void>("submit_group_call_answer", {
    requested_peer_session_id: peerSessionId,
    requested_answer: answer,
    requested_ice_generation: iceGeneration,
  });
}

export async function addGroupIceCandidate(
  peerSessionId: string,
  candidate: Record<string, unknown>,
  iceGeneration: number
): Promise<number> {
  return rpc<number>("add_group_call_ice_candidate", {
    requested_peer_session_id: peerSessionId,
    requested_candidate: candidate,
    requested_ice_generation: iceGeneration,
  });
}

export async function getRemoteGroupIceCandidates(
  peerSessionId: string,
  afterId: number,
  iceGeneration: number
): Promise<GroupIceCandidateRow[]> {
  return rpc<GroupIceCandidateRow[]>(
    "get_group_call_remote_ice_candidates",
    {
      requested_peer_session_id: peerSessionId,
      requested_after_id: afterId,
      requested_ice_generation: iceGeneration,
    }
  );
}

export async function beginGroupIceRestart(
  peerSessionId: string
): Promise<number> {
  return rpc<number>("begin_group_call_ice_restart", {
    requested_peer_session_id: peerSessionId,
  });
}

export async function setGroupPeerConnectionState(
  peerSessionId: string,
  state:
    | "connecting"
    | "connected"
    | "disconnected"
    | "failed"
): Promise<void> {
  await rpc<void>("set_group_call_peer_connection_state", {
    requested_peer_session_id: peerSessionId,
    requested_state: state,
  });
}

export async function loadGroupCall(
  groupCallId: string
): Promise<GroupCall> {
  const { data, error } = await supabase
    .from("group_calls")
    .select("*")
    .eq("id", groupCallId)
    .single();

  if (error) {
    throw groupCallError(error.message);
  }

  return data as GroupCall;
}

export async function loadGroupParticipants(
  groupCallId: string
): Promise<GroupCallParticipant[]> {
  const { data, error } = await supabase
    .from("group_call_participants")
    .select("*")
    .eq("group_call_id", groupCallId)
    .order("joined_at", { ascending: true, nullsFirst: false });

  if (error) {
    throw groupCallError(error.message);
  }

  return (data ?? []) as GroupCallParticipant[];
}

export async function loadMyPeerSessions(
  groupCallId: string,
  userId: string
): Promise<GroupPeerSession[]> {
  const { data, error } = await supabase
    .from("group_call_peer_sessions")
    .select("*")
    .eq("group_call_id", groupCallId)
    .or(`peer_a_id.eq.${userId},peer_b_id.eq.${userId}`)
    .order("created_at", { ascending: true });

  if (error) {
    throw groupCallError(error.message);
  }

  return (data ?? []) as GroupPeerSession[];
}
