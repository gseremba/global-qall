import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { AppState, Platform } from "react-native";

import { supabase } from "./supabase";

let configured = false;
let responseSubscription:
  | Notifications.EventSubscription
  | null = null;

// The chat screen reports which conversation is currently visible.
// This lets foreground notification handling suppress only that exact chat.
let activeConversationId: string | null = null;

export function setActiveMessageConversation(
  conversationId: string | null
) {
  activeConversationId =
    conversationId?.trim() || null;
}

function getProjectId(): string | null {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null
  );
}

function openNotificationData(
  data: Record<string, unknown> | undefined
) {
  if (!data) return;

  const type = String(data.type ?? "");

  if (type === "direct_call") {
    const callId = String(data.callId ?? "");

    if (!callId) {
      return;
    }

    console.log("[DIRECT CALL PUSH] Opening incoming call", {
      callId,
      appState: AppState.currentState,
    });

    router.push({
      pathname: "/call/[callId]",
      params: {
        callId,
        direction: "incoming",
      },
    });

    return;
  }

  const conversationId = String(
    data.conversationId ?? ""
  );

  if (
    type !== "chat_message" ||
    !conversationId
  ) {
    return;
  }

  router.push({
    pathname: "/chat/[conversationId]",
    params: { conversationId },
  });
}

export function initializeMessagePushEvents() {
  if (!configured) {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data =
          notification.request.content
            .data as Record<string, unknown>;

        const notificationType =
          String(data?.type ?? "");

        if (
          notificationType === "direct_call" &&
          AppState.currentState === "active"
        ) {
          return {
            shouldPlaySound: false,
            shouldSetBadge: false,
            shouldShowBanner: false,
            shouldShowList: false,
          };
        }

        const notificationConversationId =
          String(data?.conversationId ?? "");

        const isSameOpenConversation =
          AppState.currentState === "active" &&
          Boolean(activeConversationId) &&
          notificationConversationId ===
            activeConversationId;

        if (isSameOpenConversation) {
          console.log(
            "[MESSAGE PUSH] Suppressed foreground banner",
            {
              conversationId:
                notificationConversationId,
            }
          );

          return {
            shouldPlaySound: false,
            shouldSetBadge: false,
            shouldShowBanner: false,
            shouldShowList: false,
          };
        }

        return {
          shouldPlaySound: true,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
        };
      },
    });

    configured = true;
  }

  responseSubscription?.remove();

  responseSubscription =
    Notifications.addNotificationResponseReceivedListener(
      (response) => {
        openNotificationData(
          response.notification.request.content
            .data as Record<string, unknown>
        );
      }
    );

  // Handle a notification that launched the app from
  // a terminated state.
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!response) return;

      openNotificationData(
        response.notification.request.content
          .data as Record<string, unknown>
      );
    })
    .catch((error) => {
      console.warn(
        "[MESSAGE PUSH] Could not read last response:",
        error instanceof Error
          ? error.message
          : String(error)
      );
    });

  return () => {
    responseSubscription?.remove();
    responseSubscription = null;
  };
}

async function configureAndroidChannel() {
  if (Platform.OS !== "android") return;

  await Notifications.setNotificationChannelAsync(
    "messages",
    {
      name: "Messages",
      importance:
        Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 250, 150, 250],
      lockscreenVisibility:
        Notifications.AndroidNotificationVisibility.PUBLIC,
    }
  );

  await Notifications.setNotificationChannelAsync(
    "calls",
    {
      name: "Incoming calls",
      description:
        "Incoming Global Qall voice and video calls",
      importance:
        Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 300, 180, 300, 180, 500],
      lockscreenVisibility:
        Notifications.AndroidNotificationVisibility.PUBLIC,
    }
  );
}

export async function registerMessagePushToken(
  userId: string
): Promise<string | null> {
  console.log("[MESSAGE PUSH] register start", {
    userId,
    platform: Platform.OS,
  });

  const projectId = getProjectId();

  console.log("[MESSAGE PUSH] projectId", {
    projectId,
  });

  if (!projectId) {
    console.warn(
      "[MESSAGE PUSH] EAS projectId is unavailable."
    );
    return null;
  }

  try {
    await configureAndroidChannel();

    console.log("[MESSAGE PUSH] channel configured");

    const currentPermissions =
      await Notifications.getPermissionsAsync();

    console.log("[MESSAGE PUSH] current permission", {
      status: currentPermissions.status,
    });

    let finalStatus = currentPermissions.status;

    if (finalStatus !== "granted") {
      const requested =
        await Notifications.requestPermissionsAsync();

      finalStatus = requested.status;

      console.log("[MESSAGE PUSH] requested permission", {
        status: finalStatus,
      });
    }

    if (finalStatus !== "granted") {
      console.log(
        "[MESSAGE PUSH] Notification permission not granted."
      );
      return null;
    }

    const tokenResult =
      await Notifications.getExpoPushTokenAsync({
        projectId,
      });

    console.log("[MESSAGE PUSH] token result", {
      token: tokenResult.data,
    });

    const expoPushToken = tokenResult.data;

    if (!expoPushToken) {
      console.warn("[MESSAGE PUSH] No Expo token returned");
      return null;
    }

    const { error } = await supabase
      .from("message_push_tokens")
      .upsert(
        {
          user_id: userId,
          expo_push_token: expoPushToken,
          platform: Platform.OS,
          is_active: true,
          last_registered_at:
            new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "expo_push_token",
        }
      );

    console.log("[MESSAGE PUSH] upsert result", {
      error: error?.message ?? null,
      code: error?.code ?? null,
    });

    if (error) {
      throw error;
    }

    console.log("[MESSAGE PUSH] Registered", {
      platform: Platform.OS,
      tokenSuffix: expoPushToken.slice(-12),
    });

    return expoPushToken;
  } catch (error) {
    console.warn(
      "[MESSAGE PUSH] Registration failed:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    return null;
  }
}
