import { supabase } from "./supabase";

export type CallStatus =
  | "ringing"
  | "accepted"
  | "declined"
  | "ended"
  | "missed"
  | "failed";

export type VoiceCall = {
  id: string;
  caller_id: string;
  callee_id: string;
  call_type: "voice" | "video";
  status: CallStatus;
  offer: Record<string, unknown> | null;
  answer: Record<string, unknown> | null;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  expires_at: string | null;
  end_reason: string | null;
  ringing_acknowledged_at: string | null;
  caller_on_hold: boolean;
  callee_on_hold: boolean;
  last_state_changed_at: string;
};

function friendlyCallError(message: string): Error {
  if (message.includes("USER_BUSY")) {
    return new Error("User is busy.");
  }

  if (message.includes("INVALID_CALLEE")) {
    return new Error("This Global Qall account cannot be called.");
  }

  if (message.includes("AUTH_REQUIRED")) {
    return new Error("You must be signed in to place a call.");
  }

  return new Error(message);
}

export async function expireStaleCalls(): Promise<void> {
  const { error } = await supabase.rpc("expire_stale_calls");

  if (error) {
    console.warn("Could not expire stale calls:", error.message);
  }
}

export async function createVoiceCall(
  calleeId: string
): Promise<string> {
  const { data, error } = await supabase.rpc(
    "start_voice_call",
    {
      requested_callee_id: calleeId,
    }
  );

  if (error) {
    throw friendlyCallError(error.message);
  }

  if (!data) {
    throw new Error("Could not create the voice call.");
  }

  return data as string;
}

export async function createVideoCall(
  calleeId: string
): Promise<string> {
  const { data, error } = await supabase.rpc(
    "start_video_call",
    {
      requested_callee_id: calleeId,
    }
  );

  if (error) {
    throw friendlyCallError(error.message);
  }

  if (!data) {
    throw new Error("Could not create the video call.");
  }

  return data as string;
}

export async function finishVoiceCall(
  callId: string,
  status: CallStatus,
  reason: string
): Promise<void> {
  const { error } = await supabase.rpc("finish_call", {
    requested_call_id: callId,
    requested_status: status,
    requested_reason: reason,
  });

  if (error) {
    throw error;
  }
}

export function isUserBusyError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String(error ?? "");

  return (
    message.includes("USER_BUSY") ||
    message.toLowerCase().includes("currently on another call") ||
    message.toLowerCase().includes("already on another call")
  );
}

