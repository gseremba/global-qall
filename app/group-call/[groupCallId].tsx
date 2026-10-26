import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack, router, useLocalSearchParams } from "expo-router";
import InCallManager from "react-native-incall-manager";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  useWindowDimensions,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  MediaStream,
  RTCView,
} from "react-native-webrtc";

import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import {
  endGroupCall,
  leaveGroupCall,
  loadGroupCall,
  loadGroupParticipants,
  type GroupCall,
  type GroupCallParticipant,
} from "../../lib/groupCalling";
import {
  GroupWebRTCClient,
  type GroupPeerClientState,
  type GroupRemoteStream,
} from "../../lib/groupWebRTC";

type LocalRole = "host" | "participant";

export default function GroupCallScreen() {
  const { user } = useAuth();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [profiles, setProfiles] = useState<Record<string, { name: string; avatar: string | null }>>({});
  const [speakerOn, setSpeakerOn] = useState(true);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [sessionPeers, setSessionPeers] = useState<Record<string, { peer_a_id: string; peer_b_id: string }>>({});
  const params = useLocalSearchParams<{
    groupCallId?: string | string[];
  }>();

  const groupCallId = Array.isArray(params.groupCallId)
    ? params.groupCallId[0]
    : params.groupCallId;

  const [call, setCall] = useState<GroupCall | null>(null);
  const [role, setRole] = useState<LocalRole | null>(null);
  const [participants, setParticipants] =
    useState<GroupCallParticipant[]>([]);
  const [peerStates, setPeerStates] = useState<
    Record<string, GroupPeerClientState>
  >({});
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, GroupRemoteStream>
  >({});
  const [localStream, setLocalStream] =
    useState<MediaStream | null>(null);

  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);

  const clientRef = useRef<GroupWebRTCClient | null>(null);
  const remoteExitRef = useRef(false);
  const pollBusyRef = useRef(false);
  const participantTimerRef =
    useRef<ReturnType<typeof setInterval> | null>(null);

  const stopParticipantPolling = useCallback(() => {
    if (participantTimerRef.current) {
      clearInterval(participantTimerRef.current);
      participantTimerRef.current = null;
    }
  }, []);

  const exitEndedCall = useCallback(() => {
    if (remoteExitRef.current) return;
    remoteExitRef.current = true;
    stopParticipantPolling();
    // Dismiss immediately. The existing unmount cleanup stops the WebRTC
    // client and audio manager; no leave/end RPC is sent by B or C.
    router.back();
  }, [stopParticipantPolling]);

  const refreshParticipants = useCallback(async () => {
    if (!groupCallId || !user || remoteExitRef.current || pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      // The group call is authoritative: remote participants must leave when
      // the host ends it, even if their own participant row still says joined.
      const currentCall = await loadGroupCall(groupCallId);
      if (remoteExitRef.current) return;
      if (currentCall.status !== "ringing" && currentCall.status !== "active") {
        exitEndedCall();
        return;
      }

      const rows = await loadGroupParticipants(groupCallId);
      if (remoteExitRef.current) return;
      const me = rows.find(participant => participant.user_id === user.id);
      if (!me || me.status !== "joined") {
        exitEndedCall();
        return;
      }
      setParticipants(rows);
      setRole(me.role === "host" ? "host" : "participant");
    } catch (error) {
      // A temporary network/RLS error is not proof that the call ended.
      console.warn("Could not refresh group-call state:", error);
    } finally {
      pollBusyRef.current = false;
    }
  }, [groupCallId, user, exitEndedCall]);

  const stopClient = useCallback(async () => {
    stopParticipantPolling();

    const client = clientRef.current;
    clientRef.current = null;

    if (client) {
      await client.stop();
    }

    try {
      InCallManager.stop();
    } catch {
      // best effort
    }

    setLocalStream(null);
    setPeerStates({});
    setRemoteStreams({});
  }, [stopParticipantPolling]);

  const boot = useCallback(async () => {
    if (!user || !groupCallId) {
      return;
    }

    try {
      remoteExitRef.current = false;
      setLoading(true);

      const loadedCall = await loadGroupCall(groupCallId);
      const loadedParticipants =
        await loadGroupParticipants(groupCallId);

      const me = loadedParticipants.find(
        (participant) => participant.user_id === user.id
      );

      if (!me || me.status !== "joined") {
        throw new Error(
          "You are not currently joined to this group call."
        );
      }

      if (
        loadedCall.status !== "ringing" &&
        loadedCall.status !== "active"
      ) {
        throw new Error("This group call has already ended.");
      }

      setCall(loadedCall);
      setParticipants(loadedParticipants);
      setRole(me.role === "host" ? "host" : "participant");

      const client = new GroupWebRTCClient({
        groupCallId,
        userId: user.id,
        callType: loadedCall.call_type,
        events: {
          onRemoteStream(remote) {
            setRemoteStreams((current) => ({
              ...current,
              [remote.peerSessionId]: remote,
            }));
          },
          onRemoteStreamRemoved(peerSessionId) {
            setRemoteStreams((current) => {
              const next = { ...current };
              delete next[peerSessionId];
              return next;
            });
          },
          onPeerState(state) {
            setPeerStates((current) => ({
              ...current,
              [state.peerSessionId]: state,
            }));
          },
          onError(error, context) {
            console.warn(
              "Group WebRTC:",
              context.operation,
              error.message
            );
          },
        },
      });

      clientRef.current = client;
      const stream = await client.start();
      setLocalStream(stream);

      try {
        InCallManager.start({
          media:
            loadedCall.call_type === "video"
              ? "video"
              : "audio",
        });
        InCallManager.setForceSpeakerphoneOn(true);
      } catch (error) {
        console.warn("Group call audio routing:", error);
      }

      participantTimerRef.current = setInterval(
        () => void refreshParticipants(),
        1500
      );
    } catch (error) {
      await stopClient();

      Alert.alert(
        "Group call",
        error instanceof Error
          ? error.message
          : "Could not open the group call.",
        [
          {
            text: "OK",
            onPress: () => router.back(),
          },
        ]
      );
    } finally {
      setLoading(false);
    }
  }, [
    groupCallId,
    refreshParticipants,
    stopClient,
    user,
  ]);

  useEffect(() => {
    void boot();

    return () => {
      void stopClient();
    };
  }, [boot, stopClient]);

  // Display-only lookups. Neither query changes group membership or signaling.
  const rosterKey = participants.map(p => p.user_id).sort().join("|");
  useEffect(() => {
    if (!rosterKey) return;
    let cancelled = false;
    void (async () => {
      const ids = rosterKey.split("|");
      const { data, error } = await supabase.from("profiles")
        .select("id,display_name,qall_id,avatar_url").in("id", ids);
      if (error || cancelled) return;
      const next: Record<string, { name: string; avatar: string | null }> = {};
      for (const profile of data ?? []) next[profile.id] = {
        name: profile.display_name?.trim() || profile.qall_id || "Participant",
        avatar: profile.avatar_url || null,
      };
      setProfiles(next);
    })();
    return () => { cancelled = true; };
  }, [rosterKey]);

  useEffect(() => {
    if (!groupCallId) return;
    let cancelled = false;
    const refresh = async () => {
      const { data, error } = await supabase.from("group_call_peer_sessions")
        .select("id,peer_a_id,peer_b_id").eq("group_call_id", groupCallId);
      if (error || cancelled) return;
      const next: Record<string, { peer_a_id: string; peer_b_id: string }> = {};
      for (const row of data ?? []) next[row.id] = row;
      setSessionPeers(next);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [groupCallId]);

  const joinedParticipants = useMemo(
    () =>
      participants.filter(
        (participant) => participant.status === "joined"
      ),
    [participants]
  );

  const remoteRows = useMemo(
    () => Object.values(remoteStreams),
    [remoteStreams]
  );

  const peerRows = useMemo(
    () => Object.values(peerStates),
    [peerStates]
  );

  function toggleMute() {
    const next = !muted;

    localStream
      ?.getAudioTracks()
      .forEach((track) => {
        track.enabled = !next;
      });

    setMuted(next);
  }

  function toggleCamera() {
    if (call?.call_type !== "video") return;

    const next = !cameraEnabled;

    localStream
      ?.getVideoTracks()
      .forEach((track) => {
        track.enabled = next;
      });

    setCameraEnabled(next);
  }

  function toggleSpeaker() {
    const next = !speakerOn;
    try { InCallManager.setForceSpeakerphoneOn(next); setSpeakerOn(next); }
    catch (error) { console.warn("Group call speaker:", error); }
  }

  async function finishCall() {
    if (!groupCallId || !role || ending || remoteExitRef.current) {
      return;
    }

    try {
      setEnding(true);

      if (role === "host") {
        await endGroupCall(
          groupCallId,
          "host_ended"
        );
      } else {
        await leaveGroupCall(
          groupCallId,
          "local_leave"
        );
      }
    } catch (error) {
      Alert.alert(
        role === "host"
          ? "Could not end call"
          : "Could not leave call",
        error instanceof Error
          ? error.message
          : "Please try again."
      );
      setEnding(false);
      return;
    }

    remoteExitRef.current = true;
    await stopClient();
    router.back();
  }

  if (!groupCallId) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.errorTitle}>
          Group call unavailable
        </Text>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (loading || !call) {
    return (
      <>
        <Stack.Screen
          options={{
            title: "Group Call",
            headerShown: false,
          }}
        />
        <SafeAreaView style={styles.center}>
          <ActivityIndicator
            size="large"
            color="#FFFFFF"
          />
          <Text style={styles.connectingText}>
            Connecting group call…
          </Text>
        </SafeAreaView>
      </>
    );
  }

  // The roster determines tile order. Peer session IDs identify streams safely.
  const ordered = [...joinedParticipants].sort((a, b) => a.user_id.localeCompare(b.user_id));
  const streamsByUser = new Map<string, MediaStream>();
  for (const remote of remoteRows) {
    const pair = sessionPeers[remote.peerSessionId];
    if (!pair || !user) continue;
    const otherId = pair.peer_a_id === user.id ? pair.peer_b_id :
      pair.peer_b_id === user.id ? pair.peer_a_id : null;
    if (otherId && !streamsByUser.has(otherId)) streamsByUser.set(otherId, remote.stream);
  }
  const tiles = ordered.map(participant => ({
    id: participant.user_id,
    self: participant.user_id === user?.id,
    stream: participant.user_id === user?.id ? localStream : streamsByUser.get(participant.user_id) ?? null,
    name: participant.user_id === user?.id ? "You" : profiles[participant.user_id]?.name || "Participant",
    avatar: profiles[participant.user_id]?.avatar || null,
  }));
  const shades = ["#B43D64", "#B82C78", "#597CA1", "#C35C70", "#656B87", "#A94752", "#A16A60", "#9B8B59"];

  return (
    <>
      <Stack.Screen options={{ title: call.group_name_snapshot?.trim() || "Group Call", headerShown: false }} />
      <SafeAreaView style={styles.fullScreen}>
        <View style={styles.header}>
          <View style={styles.headerTitles}>
            <Text style={styles.heading} numberOfLines={1}>{call.group_name_snapshot?.trim() || "Global Qall — Group Call"}</Text>
            <Text style={styles.status}>{call.call_type === "video" ? "Group video call" : "Group audio call"}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View group call participants"
            onPress={() => setParticipantsOpen(true)}
            style={styles.participantHeaderButton}
          >
            <Ionicons name="people-outline" size={19} color="#FFFFFF" />
            <Text style={styles.countText}>{tiles.length}</Text>
          </Pressable>
        </View>

        {call.call_type === "voice" ? (
          <ScrollView style={styles.audioScroll} contentContainerStyle={styles.audioGrid} showsVerticalScrollIndicator={false}>
            {tiles.map((tile, index) => (
              <View key={tile.id} style={[styles.audioTile, { backgroundColor: shades[index % shades.length], width: landscape ? "23%" : "48%" }]}>
                {tile.self && muted && <Ionicons name="mic-off" size={16} color="#FFFFFF" style={styles.muteIndicator} />}
                <View style={styles.avatarCircle}>
                  {tile.avatar ? <Image source={{ uri: tile.avatar }} style={styles.avatarImage} /> :
                    <Text style={styles.avatarInitial}>{tile.name.charAt(0).toUpperCase()}</Text>}
                </View>
                <Text style={styles.audioName} numberOfLines={1}>{tile.name}</Text>
              </View>
            ))}
          </ScrollView>
        ) : (
          <View style={[styles.stage, landscape && styles.stageLandscape]}>
            {tiles.map(tile => {
              const activeVideo = Boolean(tile.stream && (!tile.self || cameraEnabled) &&
                tile.stream.getVideoTracks().some(track => track.readyState === "live"));
              return (
                <View key={tile.id} style={[styles.tile, landscape && styles.landscapeTile]}>
                  {activeVideo ? <RTCView streamURL={tile.stream!.toURL()} style={styles.video} objectFit="cover" mirror={tile.self} /> :
                    <View style={styles.placeholder}>
                      {tile.avatar ? <Image source={{ uri: tile.avatar }} style={styles.placeholderAvatar} /> :
                        <Ionicons name="person" size={42} color="#E2E8F0" />}
                    </View>}
                  <View style={styles.nameTag}><Text style={styles.tileText} numberOfLines={1}>{tile.name}</Text></View>
                  {tile.self && muted && <Ionicons name="mic-off" size={16} color="#FFFFFF" style={styles.videoMuteIndicator} />}
                </View>
              );
            })}
          </View>
        )}

        <Modal
          visible={participantsOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setParticipantsOpen(false)}
        >
          <View style={styles.manageBackdrop}>
            <View style={styles.managePanel}>
              <View style={styles.manageHeader}>
                <View style={styles.manageHeaderText}>
                  <Text style={styles.manageHeading}>Group call participants</Text>
                  <Text style={styles.manageSubtitle}>
                    {joinedParticipants.length} joined · {participants.length} total
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close participant list"
                  onPress={() => setParticipantsOpen(false)}
                  style={styles.manageCloseIcon}
                >
                  <Ionicons name="close" size={22} color="#FFFFFF" />
                </Pressable>
              </View>
              <ScrollView style={styles.manageList} showsVerticalScrollIndicator={false}>
                {[...participants].sort((a, b) => {
                  const aJoined = a.status === "joined" ? 0 : 1;
                  const bJoined = b.status === "joined" ? 0 : 1;
                  if (aJoined !== bJoined) return aJoined - bJoined;
                  if (a.role === "host" && b.role !== "host") return -1;
                  if (b.role === "host" && a.role !== "host") return 1;
                  return a.user_id.localeCompare(b.user_id);
                }).map(participant => {
                  const isSelf = participant.user_id === user?.id;
                  const profile = profiles[participant.user_id];
                  const displayName = isSelf ? "You" : profile?.name || "Participant";
                  const joined = participant.status === "joined";
                  const statusLabel = participant.status === "joined" ? "Joined" :
                    participant.status === "left" ? "Left" :
                    participant.status === "invited" ? "Invited" :
                    participant.status === "declined" ? "Declined" :
                    participant.status === "removed" ? "Removed" :
                    participant.status.replace(/_/g, " ");
                  return (
                    <View key={participant.user_id} style={styles.manageRow}>
                      <View style={styles.manageAvatar}>
                        {profile?.avatar ? (
                          <Image source={{ uri: profile.avatar }} style={styles.manageAvatarImage} />
                        ) : (
                          <Text style={styles.manageAvatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
                        )}
                      </View>
                      <View style={styles.manageIdentity}>
                        <Text style={styles.manageName} numberOfLines={1}>{displayName}</Text>
                        <Text style={styles.manageRole}>{participant.role === "host" ? "Host" : "Participant"}</Text>
                      </View>
                      <View style={[styles.manageStatusBadge, joined && styles.manageStatusJoined]}>
                        <Text style={[styles.manageStatusText, joined && styles.manageStatusTextJoined]}>{statusLabel}</Text>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Done viewing participants"
                onPress={() => setParticipantsOpen(false)}
                style={styles.manageDone}
              >
                <Text style={styles.manageDoneText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel={muted ? "Unmute" : "Mute"} onPress={toggleMute} style={styles.control}>
            <View style={[styles.controlCircle, muted && styles.controlActive]}><Ionicons name={muted ? "mic-off" : "mic"} size={24} color="#FFFFFF" /></View>
            <Text style={styles.controlText}>{muted ? "Unmute" : "Mute"}</Text>
          </Pressable>
          {call.call_type === "video" && <Pressable accessibilityRole="button" accessibilityLabel="Toggle camera" onPress={toggleCamera} style={styles.control}>
            <View style={[styles.controlCircle, !cameraEnabled && styles.controlActive]}><Ionicons name={cameraEnabled ? "videocam" : "videocam-off"} size={24} color="#FFFFFF" /></View>
            <Text style={styles.controlText}>Camera</Text>
          </Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel="Toggle speaker" onPress={toggleSpeaker} style={styles.control}>
            <View style={[styles.controlCircle, speakerOn && styles.controlActive]}><Ionicons name={speakerOn ? "volume-high" : "volume-medium"} size={24} color="#FFFFFF" /></View>
            <Text style={styles.controlText}>Speaker</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={role === "host" ? "End group call" : "Leave group call"} disabled={ending} onPress={() => void finishCall()} style={styles.control}>
            <View style={[styles.controlCircle, styles.leave]}>{ending ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="call" size={24} color="#FFFFFF" style={{ transform: [{ rotate: "135deg" }] }} />}</View>
            <Text style={styles.controlText}>{role === "host" ? "End" : "Leave"}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  participantHeaderButton: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18, backgroundColor: "#334155" },
  manageBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "center", padding: 20 },
  managePanel: { backgroundColor: "#1E293B", borderRadius: 18, padding: 18, maxHeight: "78%" },
  manageHeader: { flexDirection: "row", alignItems: "center", marginBottom: 12, gap: 10 },
  manageHeaderText: { flex: 1 },
  manageHeading: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  manageSubtitle: { color: "#CBD5E1", fontSize: 12, marginTop: 4 },
  manageCloseIcon: { padding: 6 },
  manageList: { flexGrow: 0 },
  manageRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: "#475569" },
  manageAvatar: { width: 42, height: 42, borderRadius: 21, overflow: "hidden", backgroundColor: "#475569", alignItems: "center", justifyContent: "center" },
  manageAvatarImage: { width: 42, height: 42, borderRadius: 21 },
  manageAvatarInitial: { color: "#FFFFFF", fontSize: 17, fontWeight: "800" },
  manageIdentity: { flex: 1, minWidth: 0 },
  manageName: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  manageRole: { color: "#CBD5E1", fontSize: 11, marginTop: 3 },
  manageStatusBadge: { borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: "#475569" },
  manageStatusJoined: { backgroundColor: "#176B5B" },
  manageStatusText: { color: "#E2E8F0", fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  manageStatusTextJoined: { color: "#FFFFFF" },
  manageDone: { backgroundColor: "#334155", alignSelf: "flex-end", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, marginTop: 14 },
  manageDoneText: { color: "#FFFFFF", fontWeight: "700" },
  fullScreen: { flex: 1, backgroundColor: "#101820", paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 },
  center: { flex: 1, backgroundColor: "#101820", alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  errorTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "800" },
  backButton: { backgroundColor: "#176B5B", paddingHorizontal: 20, paddingVertical: 11, borderRadius: 12 },
  backButtonText: { color: "#FFFFFF", fontWeight: "800" },
  connectingText: { color: "#D8E0DD", fontSize: 15 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 },
  headerTitles: { flex: 1 },
  heading: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  status: { color: "#94A3B8", fontSize: 11, marginTop: 4 },
  countBadge: { backgroundColor: "#334155", paddingHorizontal: 9, paddingVertical: 6, borderRadius: 14 },
  countText: { color: "#E2E8F0", fontSize: 12 },
  stage: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignContent: "center", justifyContent: "center", gap: 8, minHeight: 0 },
  stageLandscape: { flexWrap: "nowrap", alignItems: "center" },
  tile: { width: "48%", height: "47%", minHeight: 110, borderRadius: 12, overflow: "hidden", backgroundColor: "#334155" },
  landscapeTile: { flex: 1, width: undefined, height: "92%" },
  video: { width: "100%", height: "100%" },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  placeholderAvatar: { width: 74, height: 74, borderRadius: 37 },
  nameTag: { position: "absolute", bottom: 7, left: 7, backgroundColor: "rgba(15,23,42,0.75)", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, maxWidth: "90%" },
  tileText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  videoMuteIndicator: { position: "absolute", top: 9, right: 10 },
  audioScroll: { flex: 1, minHeight: 0 },
  audioGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignContent: "flex-start", gap: 9, paddingBottom: 12 },
  audioTile: { height: 126, borderRadius: 12, alignItems: "center", justifyContent: "center", overflow: "hidden", paddingHorizontal: 8 },
  muteIndicator: { position: "absolute", top: 9, right: 10 },
  avatarCircle: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFFFFF40", overflow: "hidden", alignItems: "center", justifyContent: "center" },
  avatarImage: { width: 58, height: 58, borderRadius: 29 },
  avatarInitial: { color: "#FFFFFF", fontWeight: "800", fontSize: 24 },
  audioName: { color: "#FFFFFF", fontSize: 12, marginTop: 8, fontWeight: "600", textAlign: "center" },
  actions: { flexDirection: "row", justifyContent: "space-evenly", alignItems: "center", paddingTop: 12, gap: 4 },
  control: { alignItems: "center", gap: 5, minWidth: 58 },
  controlCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: "#475569", alignItems: "center", justifyContent: "center" },
  controlActive: { backgroundColor: "#176B5B" },
  leave: { backgroundColor: "#DC2626" },
  controlText: { color: "#FFFFFF", fontSize: 11 },
});
