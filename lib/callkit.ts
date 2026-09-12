import { Platform } from "react-native";
import RNCallKeep, {
  CONSTANTS as CALLKEEP_CONSTANTS,
} from "react-native-callkeep";

let setupPromise: Promise<boolean> | null = null;

export const CALLKIT_END_REASONS =
  CALLKEEP_CONSTANTS.END_CALL_REASONS;

export function setupCallKit(): Promise<boolean> {
  if (!setupPromise) {
    setupPromise = RNCallKeep.setup({
      ios: {
        appName: "Global Qall",
        supportsVideo: true,
        maximumCallGroups: "1",
        maximumCallsPerCallGroup: "2",
        includesCallsInRecents: false,
      },

      android: {
        alertTitle: "Calling permission",
        alertDescription:
          "Global Qall needs access to phone calling services.",
        cancelButton: "Cancel",
        okButton: "Allow",
        additionalPermissions: [],
      },
    });
  }

  return setupPromise;
}

export async function displayNativeIncomingCall(args: {
  callId: string;
  handle: string;
  callerName: string;
  hasVideo: boolean;
}): Promise<void> {
  await setupCallKit();

  RNCallKeep.displayIncomingCall(
    args.callId,
    args.handle,
    args.callerName,
    "generic",
    args.hasVideo,
  );
}

export async function startNativeOutgoingCall(args: {
  callId: string;
  handle: string;
  contactName: string;
  hasVideo: boolean;
}): Promise<void> {
  if (Platform.OS !== "ios") return;
  await setupCallKit();

  RNCallKeep.startCall(
    args.callId,
    args.handle,
    args.contactName,
    "generic",
    args.hasVideo,
  );

  RNCallKeep.reportConnectingOutgoingCallWithUUID(
    args.callId
  );
}

export function markNativeOutgoingCallConnected(
  callId: string,
): void {
  if (Platform.OS !== "ios") return;
  RNCallKeep.reportConnectedOutgoingCallWithUUID(callId);
}

export function endNativeCall(
  callId: string,
  reason: number = CALLKIT_END_REASONS.REMOTE_ENDED,
): void {
  RNCallKeep.reportEndCallWithUUID(callId, reason);
}

export function setNativeCallMuted(
  callId: string,
  muted: boolean,
): void {
  if (Platform.OS !== "ios") return;
  RNCallKeep.setMutedCall(callId, muted);
}

export { RNCallKeep };
