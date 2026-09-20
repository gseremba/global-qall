import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidVisibility,
  EventType,
} from "@notifee/react-native";
import {
  getMessaging,
  setBackgroundMessageHandler,
  type RemoteMessage,
} from "@react-native-firebase/messaging";

const CALL_CHANNEL_ID = "calls-native-v1";

function isDirectCallMessage(
  message: RemoteMessage,
) {
  return message.data?.type === "direct_call" && Boolean(message.data?.callId);
}

async function displayIncomingCall(
  message: RemoteMessage,
) {
  if (!isDirectCallMessage(message)) return;

  const data = message.data ?? {};
  const callId = String(data.callId ?? "");
  const callerName = String(data.callerName ?? data.qallId ?? "Global Qall caller");
  const callType = String(data.callType ?? "voice");

  if (!callId) return;

  const expiresAt = String(data.expiresAt ?? "");
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return;
  }

  await notifee.createChannel({
    id: CALL_CHANNEL_ID,
    name: "Incoming calls",
    description: "Incoming Global Qall voice and video calls",
    importance: AndroidImportance.HIGH,
    sound: "default",
    vibration: true,
    //vibrationPattern: [300, 180, 300, 180, 500],
	vibrationPattern: [300, 180, 300, 180, 500, 180],
    visibility: AndroidVisibility.PUBLIC,
  });

  await notifee.displayNotification({
    id: callId,
    title: callerName,
    body: callType === "video" ? "Incoming video call" : "Incoming voice call",
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, String(value ?? "")]),
    ),
    android: {
      channelId: CALL_CHANNEL_ID,
      category: AndroidCategory.CALL,
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC,
      ongoing: true,
      autoCancel: false,
      pressAction: { id: "default" },
      fullScreenAction: { id: "default" },
    },
  });

  console.log("[ANDROID 12.5C] Full-screen incoming call displayed", { callId });
}

setBackgroundMessageHandler(getMessaging(), async (message: RemoteMessage) => {
  try {
    await displayIncomingCall(message);
  } catch (error) {
    console.warn(
      "[ANDROID 12.5C] Background incoming-call presentation failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
});

notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (
    type === EventType.PRESS ||
    type === EventType.ACTION_PRESS
  ) {
    const notificationId = detail.notification?.id;
    if (notificationId) {
      await notifee.cancelNotification(notificationId);
    }
  }
});
