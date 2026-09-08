import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import {
  PropsWithChildren,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useAuth } from "../contexts/AuthContext";
import {
  joinGroupCall,
  leaveGroupCall,
  loadGroupCall,
  type GroupCall,
  type GroupCallParticipant,
} from "../lib/groupCalling";
import { supabase } from "../lib/supabase";

type IncomingInvite = {
  participant: GroupCallParticipant;
  call: GroupCall;
};

export function IncomingGroupCallProvider({
  children,
}: PropsWithChildren) {
  const { user } = useAuth();
  const [invite, setInvite] = useState<IncomingInvite | null>(
    null
  );
  const [working, setWorking] = useState<
    "join" | "decline" | null
  >(null);
  const refreshTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDismissedCallIdRef = useRef<string | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const findIncomingInvite = useCallback(async () => {
    if (!user) {
      setInvite(null);
      return;
    }

    const { data, error } = await supabase
      .from("group_call_participants")
      .select("*")
      .eq("user_id", user.id)
      .in("status", ["invited", "ringing"])
      .order("invited_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(
        "[GROUP CALL INVITE] Participant lookup failed:",
        error.message
      );
      return;
    }

    if (!data) {
      setInvite(null);
      return;
    }

    const participant = data as GroupCallParticipant;

    if (
      participant.group_call_id ===
      lastDismissedCallIdRef.current
    ) {
      return;
    }

    try {
      const call = await loadGroupCall(
        participant.group_call_id
      );

      if (
        call.status !== "ringing" &&
        call.status !== "active"
      ) {
        setInvite(null);
        return;
      }

      setInvite({
        participant,
        call,
      });
    } catch (error) {
      console.warn(
        "[GROUP CALL INVITE] Call lookup failed:",
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }, [user]);

  const scheduleRefresh = useCallback(() => {
    clearRefreshTimer();

    refreshTimerRef.current = setTimeout(() => {
      void findIncomingInvite();
    }, 120);
  }, [clearRefreshTimer, findIncomingInvite]);

  useEffect(() => {
    if (!user) {
      setInvite(null);
      return;
    }

    void findIncomingInvite();

    const appStateSubscription = AppState.addEventListener(
      "change",
      (state) => {
        if (state === "active") {
          lastDismissedCallIdRef.current = null;
          scheduleRefresh();
        }
      }
    );

    // Sprint 12.3B.1:
    // Use a short foreground poll for the first production validation.
    // This avoids duplicate/late postgres_changes registration errors seen
    // with repeated React effect lifecycles while keeping invitation pickup
    // fast enough for the in-app incoming-call UX.
    const fallback = setInterval(() => {
      if (AppState.currentState === "active") {
        void findIncomingInvite();
      }
    }, 1000);

    return () => {
      clearRefreshTimer();
      clearInterval(fallback);
      appStateSubscription.remove();
    };
  }, [
    clearRefreshTimer,
    findIncomingInvite,
    scheduleRefresh,
    user,
  ]);

  async function joinIncomingCall() {
    if (!invite || working) return;

    try {
      setWorking("join");

      const callId = invite.call.id;

      // Important: invited users must JOIN before navigating to
      // the production call screen. Pre-join call access is RLS-limited.
      await joinGroupCall(callId);

      setInvite(null);
      lastDismissedCallIdRef.current = null;

      router.push(`/group-call/${callId}` as any);
    } catch (error) {
      console.warn(
        "[GROUP CALL INVITE] Join failed:",
        error instanceof Error
          ? error.message
          : String(error)
      );

      // Refresh in case the host ended the call while Join was tapped.
      await findIncomingInvite();
    } finally {
      setWorking(null);
    }
  }

  async function declineIncomingCall() {
    if (!invite || working) return;

    const callId = invite.call.id;

    try {
      setWorking("decline");

      // Existing leave_group_call RPC maps ringing/invited -> declined.
      await leaveGroupCall(callId, "declined_from_incoming_ui");

      lastDismissedCallIdRef.current = callId;
      setInvite(null);
    } catch (error) {
      console.warn(
        "[GROUP CALL INVITE] Decline failed:",
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      {children}

      <Modal
        visible={Boolean(invite)}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => {
          // Back button must not silently abandon the DB invitation.
        }}
      >
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <View style={styles.avatar}>
              <Ionicons
                name="people"
                size={42}
                color="#FFFFFF"
              />
            </View>

            <Text style={styles.eyebrow}>
              INCOMING GROUP{" "}
              {invite?.call.call_type === "video"
                ? "VIDEO"
                : "VOICE"}{" "}
              CALL
            </Text>

            <Text style={styles.groupName}>
              {invite?.call.group_name_snapshot?.trim() ||
                "Group call"}
            </Text>

            <Text style={styles.subtitle}>
              {invite?.call.call_type === "video"
                ? "Video call"
                : "Voice call"}{" "}
              · Tap Join to enter the call
            </Text>

            <View style={styles.actions}>
              <Pressable
                onPress={() => void declineIncomingCall()}
                disabled={Boolean(working)}
                style={[
                  styles.actionButton,
                  styles.declineButton,
                  Boolean(working) && styles.disabled,
                ]}
              >
                {working === "decline" ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Ionicons
                    name="close"
                    size={27}
                    color="#FFFFFF"
                  />
                )}
                <Text style={styles.actionText}>
                  Decline
                </Text>
              </Pressable>

              <Pressable
                onPress={() => void joinIncomingCall()}
                disabled={Boolean(working)}
                style={[
                  styles.actionButton,
                  styles.joinButton,
                  Boolean(working) && styles.disabled,
                ]}
              >
                {working === "join" ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Ionicons
                    name={
                      invite?.call.call_type === "video"
                        ? "videocam"
                        : "call"
                    }
                    size={25}
                    color="#FFFFFF"
                  />
                )}
                <Text style={styles.actionText}>Join</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(4, 12, 10, 0.82)",
  },
  card: {
    alignItems: "center",
    borderRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 34,
    paddingBottom: 26,
    backgroundColor: "#14211E",
  },
  avatar: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 22,
    backgroundColor: "#176B5B",
  },
  eyebrow: {
    color: "#8FB9AF",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.1,
  },
  groupName: {
    marginTop: 8,
    color: "#FFFFFF",
    fontSize: 26,
    fontWeight: "900",
    textAlign: "center",
  },
  subtitle: {
    marginTop: 8,
    color: "#B9C8C4",
    fontSize: 14,
    textAlign: "center",
  },
  actions: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 32,
  },
  actionButton: {
    width: 92,
    minHeight: 76,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  declineButton: {
    backgroundColor: "#B42318",
  },
  joinButton: {
    backgroundColor: "#16835F",
  },
  disabled: {
    opacity: 0.55,
  },
  actionText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "800",
  },
});
