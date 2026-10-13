import Ionicons from "@expo/vector-icons/Ionicons";
import { PropsWithChildren, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import { DirectConferenceMedia } from "./DirectConferenceMedia";

type ConferenceInvitation = {
  id: string;
  call_id: string;
  inviter_id: string;
  invitee_id: string;
  status: string;
  expires_at: string;
  created_at: string;
};
type InvitationDisplay = {
  invitation: ConferenceInvitation;
  inviterName: string;
  callType: "audio" | "video" | "unknown";
};

/** Sprint 14.3C.3: foreground-only invitation consent; no media or native call changes. */
export function IncomingConferenceInviteProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const [incoming, setIncoming] = useState<InvitationDisplay | null>(null);
  const [working, setWorking] = useState<"accept" | "decline" | null>(null);
  const [membershipReady, setMembershipReady] = useState(false);
  const [conferenceVideo, setConferenceVideo] = useState(false);
  const acceptedCallIdRef = useRef<string | null>(null);
  const membershipBusyRef = useRef(false);
  const busyRef = useRef(false);
  const fetchingRef = useRef(false);
  const generationRef = useRef(0);
  const lastDismissedRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user?.id || fetchingRef.current || busyRef.current || AppState.currentState !== "active") return;
    fetchingRef.current = true;
    const generation = generationRef.current;
    try {
      const { data, error } = await supabase
        .from("conference_invitations")
        .select("id, call_id, inviter_id, invitee_id, status, expires_at, created_at")
        .eq("invitee_id", user.id)
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      if (generation !== generationRef.current) return;
      const candidate = ((data ?? []) as ConferenceInvitation[]).find(
        (row) => row.id !== lastDismissedRef.current
      );
      if (!candidate) { setIncoming(null); return; }

      // Fetch only display information. The RPC remains the authority for accepting.
      const [profileResult, callResult] = await Promise.all([
        supabase.from("profiles").select("display_name, qall_id").eq("id", candidate.inviter_id).maybeSingle(),
        supabase.from("calls").select("call_type, status").eq("id", candidate.call_id).maybeSingle(),
      ]);
      if (generation !== generationRef.current) return;
      // Never present an invitation for a call known to have ended.
      if (callResult.data && callResult.data.status !== "accepted") {
        setIncoming(null);
        return;
      }
      const profile = profileResult.data;
      setIncoming({
        invitation: candidate,
        inviterName: profile?.display_name?.trim() || profile?.qall_id || "Global Qall user",
        callType: callResult.data?.call_type === "video" ? "video" :
          callResult.data?.call_type === "audio" ? "audio" : "unknown",
      });
    } catch (error) {
      console.warn("[CONFERENCE INVITE] Refresh failed:", error instanceof Error ? error.message : String(error));
    } finally {
      fetchingRef.current = false;
    }
  }, [user?.id]);

  useEffect(() => {
    generationRef.current += 1;
    lastDismissedRef.current = null;
    setIncoming(null);
    if (!user?.id) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      generationRef.current += 1;
      clearInterval(timer);
      subscription.remove();
    };
  }, [user?.id, refresh]);

  // Recipient observes authoritative membership; initialization belongs to A/B.
  useEffect(() => {
    if (!user?.id) { setMembershipReady(false); acceptedCallIdRef.current = null; return; }
    let cancelled = false;
    const checkMembership = async () => {
      const acceptedCallId = acceptedCallIdRef.current;
      if (!acceptedCallId || membershipBusyRef.current || AppState.currentState !== "active") return;
      membershipBusyRef.current = true;
      try {
        const { data: conference, error: conferenceError } = await supabase
          .from("direct_call_conferences")
          .select("id")
          .eq("call_id", acceptedCallId)
          .maybeSingle();
        if (conferenceError) throw conferenceError;
        if (!conference) return;
        const { data: member, error: memberError } = await supabase
          .from("direct_call_conference_participants")
          .select("id")
          .eq("conference_id", conference.id)
          .eq("user_id", user.id)
          .neq("status", "left")
          .maybeSingle();
        if (memberError) throw memberError;
        if (!cancelled && member) setMembershipReady(true);
      } catch (error) {
        console.warn("[CONFERENCE SYNC] Recipient:", error instanceof Error ? error.message : String(error));
      } finally { membershipBusyRef.current = false; }
    };
    const interval = setInterval(() => { void checkMembership(); }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [user?.id]);

  const respond = async (accept: boolean) => {
    if (!incoming || busyRef.current) return;
    const invitationId = incoming.invitation.id;
    if (Date.parse(incoming.invitation.expires_at) <= Date.now()) {
      lastDismissedRef.current = invitationId;
      setIncoming(null);
      Alert.alert("Invitation expired", "Ask the caller to send another invitation.");
      return;
    }
    busyRef.current = true;
    setWorking(accept ? "accept" : "decline");
    try {
      const { error } = await supabase.rpc("respond_to_conference_invite", {
        requested_invitation_id: invitationId,
        requested_accept: accept,
      });
      if (error) throw error;
      lastDismissedRef.current = invitationId;
      setIncoming(null);
      if (accept) {
        acceptedCallIdRef.current = incoming.invitation.call_id;
        setConferenceVideo(incoming.callType === "video");
        setMembershipReady(false);
        Alert.alert("Invitation accepted", "Waiting for the conference media connection.");
      }
    } catch (error) {
      Alert.alert("Invitation", error instanceof Error ? error.message : "Could not respond to the invitation.");
      console.warn("[CONFERENCE INVITE] Response failed:", error);
      // Recheck the authoritative invitation state after a failed response.
      setIncoming(null);
    } finally {
      busyRef.current = false;
      setWorking(null);
      void refresh();
    }
  };

  return <>
    {children}
    {membershipReady && acceptedCallIdRef.current && user?.id && (
      <DirectConferenceMedia
        callId={acceptedCallIdRef.current}
        userId={user.id}
        invitee
        video={conferenceVideo}
        onLeave={() => { acceptedCallIdRef.current = null; setMembershipReady(false); }}
      />
    )}
    <Modal visible={Boolean(incoming)} transparent animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.avatar}><Ionicons name="people" size={42} color="#FFFFFF" /></View>
          <Text style={styles.eyebrow}>CONFERENCE INVITATION</Text>
          <Text style={styles.title}>{incoming?.inviterName}</Text>
          <Text style={styles.subtitle}>Invited you to join an ongoing {incoming?.callType === "video" ? "video" : incoming?.callType === "audio" ? "voice" : ""} call.</Text>
          <Text style={styles.note}>Accepting records your consent. Conference audio/video is not connected yet.</Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={() => void respond(false)} disabled={Boolean(working)} style={[styles.actionButton, styles.declineButton, Boolean(working) && styles.disabled]}>
              {working === "decline" ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="close" size={26} color="#FFFFFF" />}
              <Text style={styles.actionText}>Decline</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void respond(true)} disabled={Boolean(working)} style={[styles.actionButton, styles.acceptButton, Boolean(working) && styles.disabled]}>
              {working === "accept" ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="checkmark" size={26} color="#FFFFFF" />}
              <Text style={styles.actionText}>Accept</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(4, 12, 10, 0.82)" },
  card: { alignItems: "center", borderRadius: 28, paddingHorizontal: 24, paddingTop: 34, paddingBottom: 26, backgroundColor: "#14211E" },
  avatar: { width: 92, height: 92, borderRadius: 46, alignItems: "center", justifyContent: "center", marginBottom: 22, backgroundColor: "#176B5B" },
  eyebrow: { color: "#8FB9AF", fontSize: 11, fontWeight: "900", letterSpacing: 1.1 },
  title: { marginTop: 8, color: "#FFFFFF", fontSize: 26, fontWeight: "900", textAlign: "center" },
  subtitle: { marginTop: 8, color: "#B9C8C4", fontSize: 14, textAlign: "center" },
  note: { marginTop: 12, color: "#8FB9AF", fontSize: 12, textAlign: "center" },
  actions: { width: "100%", flexDirection: "row", justifyContent: "space-around", marginTop: 32 },
  actionButton: { width: 100, minHeight: 76, borderRadius: 24, alignItems: "center", justifyContent: "center", gap: 6 },
  declineButton: { backgroundColor: "#B42318" },
  acceptButton: { backgroundColor: "#16835F" },
  disabled: { opacity: 0.55 },
  actionText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
});
