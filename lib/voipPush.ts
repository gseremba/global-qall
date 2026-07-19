import { Platform } from "react-native";
import VoipPushNotification from "react-native-voip-push-notification";
import { supabase } from "./supabase";

type CachedVoipEvent = { name?: string; data?: unknown };
const state: { userId: string | null; token: string | null; started: boolean } = { userId: null, token: null, started: false };
function normalizeToken(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "token" in value && typeof (value as {token?:unknown}).token === "string") return (value as {token:string}).token.trim();
  return null;
}
async function saveToken(): Promise<void> {
  if (!state.userId || !state.token) return;
  const { error } = await supabase.from("voip_push_tokens").upsert({ user_id: state.userId, token: state.token, platform: "ios", environment: __DEV__ ? "development" : "production", is_active: true, last_error: null, invalidated_at: null, last_registered_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "token" });
  if (error) console.warn("Could not save PushKit token:", error.message); else console.log("PushKit token saved.");
}
function onRegister(value: unknown): void { const token=normalizeToken(value); if (!token) return console.warn("PushKit returned an empty token."); state.token=token; void saveToken(); }
function handleCachedEvents(events: unknown): void { if (!Array.isArray(events)) return; for (const event of events as CachedVoipEvent[]) if (event?.name === "RNVoipPushRemoteNotificationsRegisteredEvent") onRegister(event.data); }
export function initializeVoipPushEvents(): () => void {
  if (Platform.OS !== "ios" || state.started) return () => undefined;
  state.started=true;
  VoipPushNotification.addEventListener("register", onRegister);
  VoipPushNotification.addEventListener("didLoadWithEvents", handleCachedEvents);
  return () => { VoipPushNotification.removeEventListener("register"); VoipPushNotification.removeEventListener("didLoadWithEvents"); state.started=false; };
}
export function setVoipPushUser(userId: string | null): void { state.userId=userId; void saveToken(); }
export async function deactivateVoipPushToken(): Promise<void> {
  if (!state.userId || !state.token) return;
  const { error } = await supabase.from("voip_push_tokens").update({is_active:false,updated_at:new Date().toISOString()}).eq("user_id",state.userId).eq("token",state.token);
  if (error) console.warn("Could not deactivate PushKit token:", error.message);
  state.userId=null;
}
