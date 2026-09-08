type IncomingCallArgs = {
  callId: string;
  handle: string;
  callerName: string;
  hasVideo: boolean;
};

type OutgoingCallArgs = {
  callId: string;
  handle: string;
  contactName: string;
  hasVideo: boolean;
};

// Android does not use Apple CallKit. These values exist only so shared
// call-screen code can keep the same API without loading RNCallKeep.
export const CALLKIT_END_REASONS = {
  FAILED: 1,
  REMOTE_ENDED: 2,
  UNANSWERED: 3,
  ANSWERED_ELSEWHERE: 4,
  DECLINED_ELSEWHERE: 5,
  MISSED: 6,
} as const;

export function setupCallKit(): Promise<boolean> {
  return Promise.resolve(false);
}

export async function displayNativeIncomingCall(
  _args: IncomingCallArgs,
): Promise<void> {}

export async function startNativeOutgoingCall(
  _args: OutgoingCallArgs,
): Promise<void> {}

export function markNativeOutgoingCallConnected(
  _callId: string,
): void {}

export function endNativeCall(
  _callId: string,
  _reason = CALLKIT_END_REASONS.REMOTE_ENDED,
): void {}

export function setNativeCallMuted(
  _callId: string,
  _muted: boolean,
): void {}

// IncomingCallProvider is not rendered on Android, but exporting a harmless
// stub keeps the module surface compatible if it is imported accidentally.
export const RNCallKeep = {
  addEventListener: () => ({ remove() {} }),
};
