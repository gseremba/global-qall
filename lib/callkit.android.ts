import NativeCallKeep, {
  CONSTANTS as CALLKEEP_CONSTANTS,
} from "react-native-callkeep";

let setupPromise: Promise<boolean> | null = null;

export const CALLKIT_END_REASONS =
  CALLKEEP_CONSTANTS.END_CALL_REASONS;

export function setupCallKit(): Promise<boolean> {
  if (!setupPromise) {
    setupPromise = NativeCallKeep.setup({
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
          "Global Qall needs access to Android calling services so incoming calls can appear while the app is locked or in the background.",
        cancelButton: "Cancel",
        okButton: "Allow",
        additionalPermissions: [],
        foregroundService: {
          channelId: "global-qall-active-call",
          channelName: "Global Qall active calls",
          notificationTitle: "Global Qall call in progress",
          notificationIcon: "ic_launcher",
        },
      },
    });
  }

  return setupPromise;
}

export async function prepareAndroidNativeCalling(): Promise<boolean> {
  try {
    await setupCallKit();

    NativeCallKeep.setAvailable(true);
    NativeCallKeep.canMakeMultipleCalls(true);

    const supported =
      await NativeCallKeep.supportConnectionService();

    if (!supported) {
      console.warn(
        "[ANDROID CALLKEEP] ConnectionService is not supported on this device."
      );
      return false;
    }

    const enabled =
      await NativeCallKeep.hasPhoneAccount();

    console.log("[ANDROID CALLKEEP] Phone account readiness", {
      supported,
      enabled,
    });

    return enabled;
  } catch (error) {
    console.warn(
      "[ANDROID CALLKEEP] Could not prepare native calling:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    return false;
  }
}

export async function displayNativeIncomingCall(args: {
  callId: string;
  handle: string;
  callerName: string;
  hasVideo: boolean;
}): Promise<void> {
  await setupCallKit();

  NativeCallKeep.displayIncomingCall(
    args.callId,
    args.handle,
    args.callerName,
    "generic",
    args.hasVideo
  );
}

/*
 * Android outgoing calls continue to use the existing Global Qall
 * React/WebRTC flow. We are only using ConnectionService for native
 * incoming-call presentation in Sprint 12.5B.
 */
export async function startNativeOutgoingCall(_args: {
  callId: string;
  handle: string;
  contactName: string;
  hasVideo: boolean;
}): Promise<void> {
  return;
}

export function markNativeOutgoingCallConnected(
  _callId: string
): void {
  return;
}

export function endNativeCall(
  callId: string,
  reason: number = CALLKIT_END_REASONS.REMOTE_ENDED
): void {
  NativeCallKeep.reportEndCallWithUUID(
    callId,
    reason
  );
}

export function setNativeCallMuted(
  callId: string,
  muted: boolean
): void {
  NativeCallKeep.setMutedCall(
    callId,
    muted
  );
}

/*
 * Other Global Qall files import { RNCallKeep } from "./callkit".
 * On Android this must now be the real native CallKeep module,
 * not the old no-op shim.
 */
export const RNCallKeep = NativeCallKeep;