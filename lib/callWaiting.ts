import type { VoiceCall } from "./calling";

export type CallWaitingProfile = {
  display_name: string | null;
  qall_id: string;
};

export type WaitingCall = {
  activeCallId: string;
  call: VoiceCall;
  caller: CallWaitingProfile | null;
};

type Listener = (waitingCall: WaitingCall | null) => void;

let currentWaitingCall: WaitingCall | null = null;
const listeners = new Set<Listener>();

export function publishWaitingCall(waitingCall: WaitingCall): void {
  currentWaitingCall = waitingCall;

  for (const listener of listeners) {
    listener(currentWaitingCall);
  }
}

export function clearWaitingCall(callId?: string): void {
  if (
    callId &&
    currentWaitingCall &&
    currentWaitingCall.call.id !== callId
  ) {
    return;
  }

  currentWaitingCall = null;

  for (const listener of listeners) {
    listener(null);
  }
}

export function subscribeToWaitingCall(
  listener: Listener
): () => void {
  listeners.add(listener);

  // Deliver the current waiting call immediately so navigation timing cannot
  // cause a missed event.
  listener(currentWaitingCall);

  return () => {
    listeners.delete(listener);
  };
}
