import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { Stack } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import InCallManager from "react-native-incall-manager";
import {
  MediaStream,
  RTCView,
} from "react-native-webrtc";

import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import {
  endGroupCall,
  joinGroupCall,
  leaveGroupCall,
  loadGroupCall,
  loadGroupParticipants,
  startGroupCall,
  type GroupCallParticipant,
  type GroupCallType,
} from "../lib/groupCalling";
import {
  GroupWebRTCClient,
  type GroupPeerClientState,
  type GroupRemoteStream,
} from "../lib/groupWebRTC";

type LogEntry = {
  id: string;
  at: string;
  text: string;
};

function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString();
}

export default function GroupCallIntegrationTestScreen() {
  const { user } = useAuth();

  const [conversationId, setConversationId] = useState("");
  const [groupCallId, setGroupCallId] = useState("");
  const [callType, setCallType] =
    useState<GroupCallType>("voice");

  const [role, setRole] =
    useState<"host" | "participant" | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "starting" | "active" | "stopping"
  >("idle");

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

  const [muted, setMuted] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const clientRef = useRef<GroupWebRTCClient | null>(null);
  const participantTimerRef =
    useRef<ReturnType<typeof setInterval> | null>(null);
  const recoveryAttemptedForUserRef = useRef<string | null>(null);

  const active = phase === "active";

  const addLog = useCallback((text: string) => {
    setLogs((current) => [
      {
        id: `${Date.now()}-${Math.random()}`,
        at: nowLabel(),
        text,
      },
      ...current,
    ].slice(0, 80));
  }, []);

  const stopParticipantPolling = useCallback(() => {
    if (participantTimerRef.current) {
      clearInterval(participantTimerRef.current);
      participantTimerRef.current = null;
    }
  }, []);

  const refreshParticipants = useCallback(
    async (callId = groupCallId) => {
      if (!callId) return;

      try {
        const rows = await loadGroupParticipants(callId);
        setParticipants(rows);
      } catch (error) {
        addLog(
          `Participant refresh failed: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`
        );
      }
    },
    [addLog, groupCallId]
  );

  const startParticipantPolling = useCallback(
    (callId: string) => {
      stopParticipantPolling();

      void refreshParticipants(callId);

      participantTimerRef.current = setInterval(
        () => void refreshParticipants(callId),
        1500
      );
    },
    [refreshParticipants, stopParticipantPolling]
  );

  const stopLocalClient = useCallback(async () => {
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
    setParticipants([]);
    setMuted(false);
    setCameraEnabled(true);
  }, [stopParticipantPolling]);

  const bootWebRTCClient = useCallback(
    async (
      callId: string,
      resolvedType: GroupCallType
    ) => {
      if (!user) {
        throw new Error("You must be signed in.");
      }

      await stopLocalClient();

      const client = new GroupWebRTCClient({
        groupCallId: callId,
        userId: user.id,
        callType: resolvedType,
        events: {
          onRemoteStream(remote) {
            setRemoteStreams((current) => ({
              ...current,
              [remote.peerSessionId]: remote,
            }));
            addLog(
              `Remote media from ${shortId(
                remote.remoteUserId
              )}`
            );
          },

          onRemoteStreamRemoved(
            peerSessionId,
            remoteUserId
          ) {
            setRemoteStreams((current) => {
              const next = { ...current };
              delete next[peerSessionId];
              return next;
            });
            addLog(
              `Remote media removed: ${shortId(
                remoteUserId
              )}`
            );
          },

          onPeerState(state) {
            setPeerStates((current) => ({
              ...current,
              [state.peerSessionId]: state,
            }));
          },

          onError(error, context) {
            addLog(
              `${context.operation}${
                context.peerSessionId
                  ? ` ${shortId(
                      context.peerSessionId
                    )}`
                  : ""
              }: ${error.message}`
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
            resolvedType === "video"
              ? "video"
              : "audio",
        });
        InCallManager.setForceSpeakerphoneOn(true);
      } catch (error) {
        addLog(
          `Audio routing warning: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`
        );
      }

      startParticipantPolling(callId);
      addLog(
        `WebRTC client active (${resolvedType})`
      );
    },
    [
      addLog,
      startParticipantPolling,
      stopLocalClient,
      user,
    ]
  );

  const recoverActiveGroupCall = useCallback(async () => {
    if (!user || phase !== "idle") {
      return;
    }

    // Only attempt once for the currently authenticated user during this
    // screen mount. Re-opening the route creates a fresh screen and retries.
    if (recoveryAttemptedForUserRef.current === user.id) {
      return;
    }
    recoveryAttemptedForUserRef.current = user.id;

    try {
      setPhase("starting");
      addLog("Checking for an active group call…");

      const { data: participant, error: participantError } =
        await supabase
          .from("group_call_participants")
          .select("group_call_id, role, status, created_at")
          .eq("user_id", user.id)
          .eq("status", "joined")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

      if (participantError) {
        throw participantError;
      }

      if (!participant?.group_call_id) {
        setPhase("idle");
        addLog("No active group call to recover");
        return;
      }

      const call = await loadGroupCall(participant.group_call_id);

      if (
        call.status !== "ringing" &&
        call.status !== "active"
      ) {
        setPhase("idle");
        addLog(
          `Joined row belongs to non-live call (${call.status})`
        );
        return;
      }

      const recoveredRole =
        participant.role === "host"
          ? "host"
          : "participant";

      setGroupCallId(participant.group_call_id);
      setConversationId(call.conversation_id);
      setCallType(call.call_type);
      setRole(recoveredRole);

      await bootWebRTCClient(
        participant.group_call_id,
        call.call_type
      );

      setPhase("active");
      addLog(
        `Recovered ${recoveredRole} call: ${shortId(
          participant.group_call_id
        )}`
      );
    } catch (error) {
      await stopLocalClient();
      setRole(null);
      setPhase("idle");

      addLog(
        `Active-call recovery failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );
    }
  }, [
    addLog,
    bootWebRTCClient,
    phase,
    stopLocalClient,
    user,
  ]);

  async function handleStartHost() {
    if (!user || phase !== "idle") return;

    const cleanConversationId = conversationId.trim();

    if (!cleanConversationId) {
      Alert.alert(
        "Conversation ID required",
        "Paste the UUID of a 3-member test group."
      );
      return;
    }

    try {
      setPhase("starting");
      addLog(
        `Starting ${callType} call for ${shortId(
          cleanConversationId
        )}`
      );

      const callId = await startGroupCall(
        cleanConversationId,
        callType
      );

      setGroupCallId(callId);
      setRole("host");

      await bootWebRTCClient(callId, callType);

      setPhase("active");
      addLog(`HOST active: ${shortId(callId)}`);
    } catch (error) {
      await stopLocalClient();
      setPhase("idle");

      Alert.alert(
        "Group call start failed",
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  async function handleJoin() {
    if (!user || phase !== "idle") return;

    const callId = groupCallId.trim();

    if (!callId) {
      Alert.alert(
        "Group Call ID required",
        "Paste the Group Call ID shared by the host device."
      );
      return;
    }

    try {
      setPhase("starting");
      addLog(`Joining ${shortId(callId)}`);

      await joinGroupCall(callId);
      const call = await loadGroupCall(callId);

      setCallType(call.call_type);
      setConversationId(call.conversation_id);
      setRole("participant");

      await bootWebRTCClient(
        callId,
        call.call_type
      );

      setPhase("active");
      addLog(
        `PARTICIPANT active: ${shortId(callId)}`
      );
    } catch (error) {
      await stopLocalClient();
      setPhase("idle");

      Alert.alert(
        "Join failed",
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  async function handleLeave() {
    if (!groupCallId || phase !== "active") {
      return;
    }

    try {
      setPhase("stopping");

      if (role === "host") {
        await endGroupCall(
          groupCallId,
          "integration_test_host_ended"
        );
        addLog("Host ended group call");
      } else {
        await leaveGroupCall(
          groupCallId,
          "integration_test_participant_left"
        );
        addLog("Participant left group call");
      }
    } catch (error) {
      addLog(
        `Database leave/end warning: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );
    } finally {
      await stopLocalClient();
      setRole(null);
      setPhase("idle");
    }
  }

  async function handleCopyCallId() {
    if (!groupCallId) return;
    await Clipboard.setStringAsync(groupCallId);
    addLog("Group Call ID copied");
  }

  async function handleShareCallId() {
    if (!groupCallId) return;
    await Share.share({
      message:
        `Global Qall group-call test ID:\n${groupCallId}`,
    });
  }

  function toggleMute() {
    const next = !muted;

    localStream
      ?.getAudioTracks()
      .forEach((track) => {
        track.enabled = !next;
      });

    setMuted(next);
    addLog(next ? "Microphone muted" : "Microphone unmuted");
  }

  function toggleCamera() {
    if (callType !== "video") return;

    const next = !cameraEnabled;

    localStream
      ?.getVideoTracks()
      .forEach((track) => {
        track.enabled = next;
      });

    setCameraEnabled(next);
    addLog(next ? "Camera enabled" : "Camera disabled");
  }

  async function restartPeerIce(peerSessionId: string) {
    try {
      addLog(
        `ICE restart requested: ${shortId(
          peerSessionId
        )}`
      );

      const generation =
        await clientRef.current?.restartIce(
          peerSessionId
        );

      addLog(
        `ICE restart generation ${
          generation ?? "?"
        }`
      );
    } catch (error) {
      Alert.alert(
        "ICE restart failed",
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  useEffect(() => {
    if (!user || phase !== "idle") {
      return;
    }

    void recoverActiveGroupCall();
  }, [phase, recoverActiveGroupCall, user]);

  useEffect(() => {
    return () => {
      void stopLocalClient();
    };
  }, [stopLocalClient]);

  const joinedParticipants = useMemo(
    () =>
      participants.filter(
        (participant) =>
          participant.status === "joined"
      ),
    [participants]
  );

  const peerRows = useMemo(
    () => Object.values(peerStates),
    [peerStates]
  );

  const remoteRows = useMemo(
    () => Object.values(remoteStreams),
    [remoteStreams]
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: "Group WebRTC Test",
          headerShown: true,
        }}
      />

      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.warningCard}>
            <Ionicons
              name="construct-outline"
              size={22}
              color="#92400E"
            />
            <View style={styles.flex}>
              <Text style={styles.warningTitle}>
                Developer integration test
              </Text>
              <Text style={styles.warningText}>
                This route is intentionally not linked from
                production navigation. It does not use CallKit
                or group-call push notifications.
              </Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.heading}>
              Device identity
            </Text>
            <Text style={styles.mono}>
              User: {user?.id ?? "Not signed in"}
            </Text>
            <Text style={styles.mono}>
              Phase: {phase}
            </Text>
            <Text style={styles.mono}>
              Role: {role ?? "none"}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.heading}>
              1. Host device
            </Text>

            <Text style={styles.label}>
              Group Conversation UUID
            </Text>
            <TextInput
              value={conversationId}
              onChangeText={setConversationId}
              editable={phase === "idle"}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="d6c23b94-..."
              style={styles.input}
            />

            <View style={styles.segment}>
              <Pressable
                disabled={phase !== "idle"}
                onPress={() => setCallType("voice")}
                style={[
                  styles.segmentButton,
                  callType === "voice" &&
                    styles.segmentButtonActive,
                ]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    callType === "voice" &&
                      styles.segmentTextActive,
                  ]}
                >
                  Voice
                </Text>
              </Pressable>

              <Pressable
                disabled={phase !== "idle"}
                onPress={() => setCallType("video")}
                style={[
                  styles.segmentButton,
                  callType === "video" &&
                    styles.segmentButtonActive,
                ]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    callType === "video" &&
                      styles.segmentTextActive,
                  ]}
                >
                  Video
                </Text>
              </Pressable>
            </View>

            <Pressable
              disabled={
                phase !== "idle" || !user
              }
              onPress={() => void handleStartHost()}
              style={[
                styles.primaryButton,
                (phase !== "idle" || !user) &&
                  styles.disabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                Start as Host
              </Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.heading}>
              2. Participant device
            </Text>

            <Text style={styles.label}>
              Group Call UUID
            </Text>
            <TextInput
              value={groupCallId}
              onChangeText={setGroupCallId}
              editable={phase === "idle"}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Paste ID from host"
              style={styles.input}
            />

            <Pressable
              disabled={
                phase !== "idle" || !user
              }
              onPress={() => void handleJoin()}
              style={[
                styles.secondaryButton,
                (phase !== "idle" || !user) &&
                  styles.disabled,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                Join Existing Call
              </Text>
            </Pressable>
          </View>

          {!!groupCallId && (
            <View style={styles.card}>
              <Text style={styles.heading}>
                Active test call
              </Text>
              <Text selectable style={styles.callId}>
                {groupCallId}
              </Text>

              <View style={styles.buttonRow}>
                <Pressable
                  onPress={() =>
                    void handleCopyCallId()
                  }
                  style={styles.smallButton}
                >
                  <Ionicons
                    name="copy-outline"
                    size={18}
                    color="#176B5B"
                  />
                  <Text style={styles.smallButtonText}>
                    Copy
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() =>
                    void handleShareCallId()
                  }
                  style={styles.smallButton}
                >
                  <Ionicons
                    name="share-outline"
                    size={18}
                    color="#176B5B"
                  />
                  <Text style={styles.smallButtonText}>
                    Share
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {active && (
            <>
              <View style={styles.card}>
                <Text style={styles.heading}>
                  Media controls
                </Text>

                <View style={styles.controlRow}>
                  <Pressable
                    onPress={toggleMute}
                    style={styles.roundControl}
                  >
                    <Ionicons
                      name={
                        muted
                          ? "mic-off"
                          : "mic"
                      }
                      size={22}
                      color="#FFFFFF"
                    />
                    <Text style={styles.controlText}>
                      {muted
                        ? "Unmute"
                        : "Mute"}
                    </Text>
                  </Pressable>

                  {callType === "video" && (
                    <Pressable
                      onPress={toggleCamera}
                      style={styles.roundControl}
                    >
                      <Ionicons
                        name={
                          cameraEnabled
                            ? "videocam"
                            : "videocam-off"
                        }
                        size={22}
                        color="#FFFFFF"
                      />
                      <Text style={styles.controlText}>
                        Camera
                      </Text>
                    </Pressable>
                  )}

                  <Pressable
                    onPress={() => void handleLeave()}
                    style={styles.endControl}
                  >
                    <Ionicons
                      name="call"
                      size={22}
                      color="#FFFFFF"
                    />
                    <Text style={styles.controlText}>
                      {role === "host"
                        ? "End"
                        : "Leave"}
                    </Text>
                  </Pressable>
                </View>
              </View>

              {callType === "video" &&
                localStream &&
                cameraEnabled && (
                  <View style={styles.card}>
                    <Text style={styles.heading}>
                      Local video
                    </Text>
                    <RTCView
                      streamURL={localStream.toURL()}
                      style={styles.video}
                      mirror
                      objectFit="cover"
                    />
                  </View>
                )}

              {callType === "video" &&
                remoteRows.map((remote) => (
                  <View
                    key={remote.peerSessionId}
                    style={styles.card}
                  >
                    <Text style={styles.heading}>
                      Remote {shortId(
                        remote.remoteUserId
                      )}
                    </Text>
                    <RTCView
                      streamURL={remote.stream.toURL()}
                      style={styles.video}
                      objectFit="cover"
                    />
                  </View>
                ))}

              <View style={styles.card}>
                <Text style={styles.heading}>
                  Participants ({joinedParticipants.length}
                  /{participants.length})
                </Text>

                {participants.map((participant) => (
                  <View
                    key={participant.id}
                    style={styles.statusRow}
                  >
                    <View style={styles.flex}>
                      <Text style={styles.statusTitle}>
                        {participant.user_id === user?.id
                          ? "This device"
                          : shortId(
                              participant.user_id
                            )}
                      </Text>
                      <Text style={styles.statusMeta}>
                        {participant.role} ·{" "}
                        {participant.status}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.dot,
                        participant.status ===
                          "joined"
                          ? styles.dotGood
                          : styles.dotWaiting,
                      ]}
                    />
                  </View>
                ))}
              </View>

              <View style={styles.card}>
                <Text style={styles.heading}>
                  Peer mesh ({peerRows.length})
                </Text>

                {peerRows.length === 0 && (
                  <Text style={styles.mutedText}>
                    Waiting for another participant…
                  </Text>
                )}

                {peerRows.map((peer) => (
                  <View
                    key={peer.peerSessionId}
                    style={styles.peerCard}
                  >
                    <Text style={styles.statusTitle}>
                      {shortId(peer.remoteUserId)}
                    </Text>
                    <Text style={styles.statusMeta}>
                      {peer.role} · generation{" "}
                      {peer.iceGeneration}
                    </Text>
                    <Text style={styles.statusMeta}>
                      PC: {peer.connectionState} · ICE:{" "}
                      {peer.iceConnectionState}
                    </Text>

                    <Pressable
                      onPress={() =>
                        void restartPeerIce(
                          peer.peerSessionId
                        )
                      }
                      style={styles.restartButton}
                    >
                      <Ionicons
                        name="refresh-outline"
                        size={17}
                        color="#176B5B"
                      />
                      <Text
                        style={
                          styles.restartButtonText
                        }
                      >
                        ICE restart
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            </>
          )}

          <View style={styles.card}>
            <Text style={styles.heading}>
              Diagnostic log
            </Text>

            {logs.length === 0 ? (
              <Text style={styles.mutedText}>
                No events yet.
              </Text>
            ) : (
              logs.map((entry) => (
                <Text
                  key={entry.id}
                  style={styles.logText}
                >
                  {entry.at} · {entry.text}
                </Text>
              ))
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F4F7F6",
  },
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 14,
  },
  warningCard: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#FEF3C7",
  },
  warningTitle: {
    fontWeight: "800",
    color: "#92400E",
    marginBottom: 4,
  },
  warningText: {
    color: "#78350F",
    lineHeight: 19,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  flex: {
    flex: 1,
  },
  heading: {
    fontSize: 17,
    fontWeight: "800",
    color: "#17211F",
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: "#52605D",
  },
  mono: {
    fontFamily: "monospace",
    color: "#44504D",
    fontSize: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: "#D7DEDC",
    backgroundColor: "#FAFCFB",
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: "#17211F",
  },
  segment: {
    flexDirection: "row",
    backgroundColor: "#EEF3F1",
    padding: 4,
    borderRadius: 11,
  },
  segmentButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 9,
    borderRadius: 8,
  },
  segmentButtonActive: {
    backgroundColor: "#176B5B",
  },
  segmentText: {
    color: "#52605D",
    fontWeight: "700",
  },
  segmentTextActive: {
    color: "#FFFFFF",
  },
  primaryButton: {
    backgroundColor: "#176B5B",
    borderRadius: 11,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontWeight: "800",
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#176B5B",
    borderRadius: 11,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: "#176B5B",
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.45,
  },
  callId: {
    fontFamily: "monospace",
    color: "#17211F",
    fontSize: 13,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
  },
  smallButton: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#D7DEDC",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  smallButtonText: {
    color: "#176B5B",
    fontWeight: "700",
  },
  controlRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  roundControl: {
    minWidth: 78,
    alignItems: "center",
    gap: 5,
    backgroundColor: "#34423F",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  endControl: {
    minWidth: 78,
    alignItems: "center",
    gap: 5,
    backgroundColor: "#B42318",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  controlText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  video: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#0B1110",
    borderRadius: 12,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E5EAE8",
    paddingTop: 9,
  },
  statusTitle: {
    fontWeight: "700",
    color: "#17211F",
  },
  statusMeta: {
    color: "#66736F",
    fontSize: 12,
    marginTop: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotGood: {
    backgroundColor: "#15803D",
  },
  dotWaiting: {
    backgroundColor: "#D97706",
  },
  peerCard: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E5EAE8",
    paddingTop: 10,
    gap: 2,
  },
  restartButton: {
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 5,
    alignItems: "center",
    marginTop: 7,
    paddingVertical: 6,
  },
  restartButtonText: {
    color: "#176B5B",
    fontWeight: "700",
    fontSize: 12,
  },
  mutedText: {
    color: "#75817E",
    fontStyle: "italic",
  },
  logText: {
    fontFamily: "monospace",
    color: "#44504D",
    fontSize: 11,
    lineHeight: 17,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#EDF1F0",
    paddingTop: 6,
  },
});
