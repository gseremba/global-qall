import { Platform } from "react-native";

import {
  addVoipTokenListener,
  getVoipToken,
} from "global-qall-voip";

import { supabase } from "./supabase";

const state: {
  userId: string | null;
  token: string | null;
  started: boolean;
} = {
  userId: null,
  token: null,
  started: false,
};

/*
function getEnvironment(): "development" | "production" {
  return __DEV__ ? "development" : "production";
}
*/

function getEnvironment(): "development" | "production" {
  return "production";
}

async function saveToken(): Promise<void> {
  const environment = getEnvironment();

  console.log("[VOIP APP] saveToken called:", {
    hasUserId: Boolean(state.userId),
    hasToken: Boolean(state.token),
    environment,
    tokenSuffix: state.token ? state.token.slice(-8) : null,
  });

  if (!state.userId || !state.token) {
    console.warn("[VOIP APP] Token not saved because user or token is missing.", {
      userId: state.userId,
      hasToken: Boolean(state.token),
    });
    return;
  }

  const now = new Date().toISOString();

  const { error } = await supabase
    .from("voip_push_tokens")
    .upsert(
      {
        user_id: state.userId,
        token: state.token,
        platform: "ios",
        environment,
        is_active: true,
        last_error: null,
        invalidated_at: null,
        last_registered_at: now,
        updated_at: now,
      },
      {
        onConflict: "token",
      }
    );

  if (error) {
    console.error("[VOIP APP] Could not save PushKit token:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      userId: state.userId,
      tokenSuffix: state.token.slice(-8),
    });
    return;
  }

  console.log("[VOIP APP] PushKit token saved successfully:", {
    userId: state.userId,
    environment,
    tokenSuffix: state.token.slice(-8),
  });
}

function receiveToken(token: string | null): void {
  console.log("[VOIP APP] Token received from native module:", {
    exists: Boolean(token),
    length: token?.length ?? 0,
    suffix: token ? token.slice(-8) : null,
  });

  const normalizedToken = token?.trim();

  if (!normalizedToken) {
    console.warn("[VOIP APP] Native PushKit token is empty or unavailable.");
    return;
  }

  state.token = normalizedToken;

  console.log("[VOIP APP] Token stored in local state:", {
    userId: state.userId,
    tokenSuffix: normalizedToken.slice(-8),
  });

  void saveToken();
}

export function initializeVoipPushEvents(): () => void {
  if (Platform.OS !== "ios" || state.started) {
    return () => undefined;
  }

  state.started = true;

  // The native subscriber may receive the token before JavaScript loads.
  receiveToken(getVoipToken());

  const subscription = addVoipTokenListener(receiveToken);

  return () => {
    subscription?.remove();
    state.started = false;
  };
}

export function setVoipPushUser(userId: string | null): void {
  console.log("[VOIP APP] Setting VoIP user:", {
    previousUserId: state.userId,
    newUserId: userId,
    hasToken: Boolean(state.token),
  });

  state.userId = userId;
  void saveToken();
}

export async function deactivateVoipPushToken(): Promise<void> {
  if (!state.userId || !state.token) {
    state.userId = null;
    return;
  }

  const { error } = await supabase
    .from("voip_push_tokens")
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", state.userId)
    .eq("token", state.token);

  if (error) {
    console.warn("[VOIP APP] Could not deactivate PushKit token:", {
      message: error.message,
      code: error.code,
      userId: state.userId,
      tokenSuffix: state.token.slice(-8),
    });
  }

  state.userId = null;
}
