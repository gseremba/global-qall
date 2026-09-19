import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import {
  displayNativeIncomingCall,
  prepareAndroidNativeCalling,
} from "./callkit";

const ANDROID_NATIVE_INCOMING_CALL_TASK =
  "global-qall-android-native-incoming-call";

type IncomingCallPushData = {
  type?: unknown;
  callId?: unknown;
  callerId?: unknown;
  callerName?: unknown;
  qallId?: unknown;
  callType?: unknown;
  expiresAt?: unknown;
};

function extractIncomingCallData(
  raw: unknown
): IncomingCallPushData | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const object = raw as Record<string, unknown>;

  const nestedNotificationData =
    (
      object.notification &&
      typeof object.notification === "object"
    )
      ? (
          (
            (
              object.notification as Record<string, unknown>
            ).request as Record<string, unknown> | undefined
          )?.content as Record<string, unknown> | undefined
        )?.data
      : null;

  if (
    nestedNotificationData &&
    typeof nestedNotificationData === "object"
  ) {
    return nestedNotificationData as IncomingCallPushData;
  }

  if (
    object.data &&
    typeof object.data === "object"
  ) {
    return object.data as IncomingCallPushData;
  }

  return object as IncomingCallPushData;
}

async function showFallbackNotification(
  data: IncomingCallPushData
) {
  const callId = String(data.callId ?? "");

  if (!callId) {
    return;
  }

  const callerName =
    String(data.callerName ?? "").trim() ||
    String(data.qallId ?? "").trim() ||
    "Global Qall caller";

  const callType =
    String(data.callType ?? "voice") === "video"
      ? "video"
      : "voice";

  await Notifications.scheduleNotificationAsync({
    content: {
      title: callerName,
      body:
        callType === "video"
          ? "Incoming video call"
          : "Incoming voice call",
      sound: "default",
      data: {
        type: "direct_call",
        callId,
        callerName,
        qallId: String(data.qallId ?? ""),
        callType,
      },
    },
    trigger: null,
  });
}

if (
  Platform.OS === "android" &&
  !TaskManager.isTaskDefined(
    ANDROID_NATIVE_INCOMING_CALL_TASK
  )
) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    ANDROID_NATIVE_INCOMING_CALL_TASK,
    async ({ data, error }) => {
      if (error) {
        console.warn(
          "[ANDROID NATIVE CALL TASK] Notification task error:",
          error.message
        );
        return;
      }

      const incoming =
        extractIncomingCallData(data);

      if (
        !incoming ||
        String(incoming.type ?? "") !== "direct_call"
      ) {
        return;
      }

      const callId =
        String(incoming.callId ?? "");

      if (!callId) {
        return;
      }

      const expiresAt =
        String(incoming.expiresAt ?? "");

      if (
        expiresAt &&
        Number.isFinite(Date.parse(expiresAt)) &&
        Date.parse(expiresAt) <= Date.now()
      ) {
        console.log(
          "[ANDROID NATIVE CALL TASK] Ignored expired call",
          { callId }
        );
        return;
      }

      const callerName =
        String(incoming.callerName ?? "").trim() ||
        String(incoming.qallId ?? "").trim() ||
        "Global Qall caller";

      const handle =
        String(incoming.qallId ?? "").trim() ||
        "Global Qall";

      const hasVideo =
        String(incoming.callType ?? "voice") === "video";

      try {
        const phoneAccountReady =
          await prepareAndroidNativeCalling();

        if (!phoneAccountReady) {
          console.warn(
            "[ANDROID NATIVE CALL TASK] Phone account is not enabled; using notification fallback.",
            { callId }
          );

          await showFallbackNotification(incoming);
          return;
        }

        await displayNativeIncomingCall({
          callId,
          handle,
          callerName,
          hasVideo,
        });

        console.log(
          "[ANDROID NATIVE CALL TASK] Native incoming call displayed",
          {
            callId,
            callerName,
            hasVideo,
          }
        );
      } catch (nativeError) {
        console.warn(
          "[ANDROID NATIVE CALL TASK] Native display failed; using fallback notification.",
          nativeError instanceof Error
            ? nativeError.message
            : String(nativeError)
        );

        await showFallbackNotification(incoming);
      }
    }
  );
}

export async function registerAndroidNativeIncomingCallTask() {
  if (Platform.OS !== "android") {
    return;
  }

  try {
    await Notifications.registerTaskAsync(
      ANDROID_NATIVE_INCOMING_CALL_TASK
    );

    console.log(
      "[ANDROID NATIVE CALL TASK] Registered"
    );
  } catch (error) {
    console.warn(
      "[ANDROID NATIVE CALL TASK] Registration failed:",
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
}
