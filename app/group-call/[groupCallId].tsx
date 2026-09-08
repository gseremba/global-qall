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
  const participantTimerRef =
    useRef<ReturnType<typeof setInterval> | null>(null);

  const stopParticipantPolling = useCallback(() => {
    if (participantTimerRef.current) {
      clearInterval(participantTimerRef.current);
      participantTimerRef.current = null;
    }
  }, []);

  const refreshParticipants = useCallback(async () => {
    if (!groupCallId) return;

    try {
      const rows = await loadGroupParticipants(groupCallId);
      setParticipants(rows);

      if (user) {
        const me = rows.find(
          (participant) => participant.user_id === user.id
        );

        if (me?.role === "host") {
          setRole("host");
        } else if (me) {
          setRole("participant");
        }
      }
    } catch (error) {
      console.warn(
        "Could not refresh group-call participants:",
        error
      );
    }
  }, [groupCallId, user]);

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

  async function finishCall() {
    if (!groupCallId || !role || ending) {
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

  return (
    <>
      <Stack.Screen
        options={{
          title:
            call.group_name_snapshot?.trim() ||
            "Group Call",
          headerShown: false,
        }}
      />

      <SafeAreaView style={styles.safeArea}>
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={10}
            style={styles.topButton}
          >
            <Ionicons
              name="chevron-down"
              size={26}
              color="#FFFFFF"
            />
          </Pressable>

          <View style={styles.titleArea}>
            <Text
              style={styles.groupName}
              numberOfLines={1}
            >
              {call.group_name_snapshot?.trim() ||
                "Group Call"}
            </Text>
            <Text style={styles.callMeta}>
              {call.call_type === "video"
                ? "Group video call"
                : "Group voice call"}{" "}
              · {joinedParticipants.length} joined
            </Text>
          </View>

          <View style={styles.topButton}>
            <Ionicons
              name="people-outline"
              size={23}
              color="#FFFFFF"
            />
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {call.call_type === "video" ? (
            <>
              {localStream && (
                <View style={styles.videoCard}>
                  <RTCView
                    streamURL={localStream.toURL()}
                    style={styles.video}
                    mirror
                    objectFit="cover"
                  />
                  <View style={styles.videoLabel}>
                    <Text style={styles.videoLabelText}>
                      You
                    </Text>
                  </View>
                </View>
              )}

              {remoteRows.map((remote) => (
                <View
                  key={remote.peerSessionId}
                  style={styles.videoCard}
                >
                  <RTCView
                    streamURL={remote.stream.toURL()}
                    style={styles.video}
                    objectFit="cover"
                  />
                  <View style={styles.videoLabel}>
                    <Text style={styles.videoLabelText}>
                      Participant
                    </Text>
                  </View>
                </View>
              ))}

              {remoteRows.length === 0 && (
                <View style={styles.waitingCard}>
                  <Ionicons
                    name="people-outline"
                    size={40}
                    color="#A7B2AF"
                  />
                  <Text style={styles.waitingTitle}>
                    Waiting for others to join
                  </Text>
                </View>
              )}
            </>
          ) : (
            <View style={styles.voiceStage}>
              <View style={styles.voiceAvatar}>
                <Ionicons
                  name="people"
                  size={56}
                  color="#FFFFFF"
                />
              </View>

              <Text style={styles.voiceTitle}>
                {call.group_name_snapshot?.trim() ||
                  "Group Call"}
              </Text>
              <Text style={styles.voiceSubtitle}>
                {joinedParticipants.length} participant
                {joinedParticipants.length === 1 ? "" : "s"} joined
              </Text>
            </View>
          )}

          <View style={styles.participantCard}>
            <Text style={styles.sectionTitle}>
              Participants
            </Text>

            {participants.map((participant) => (
              <View
                key={participant.id}
                style={styles.participantRow}
              >
                <View style={styles.participantAvatar}>
                  <Ionicons
                    name="person"
                    size={18}
                    color="#FFFFFF"
                  />
                </View>

                <View style={styles.participantDetails}>
                  <Text style={styles.participantName}>
                    {participant.user_id === user?.id
                      ? "You"
                      : "Group member"}
                  </Text>
                  <Text style={styles.participantStatus}>
                    {participant.role} · {participant.status}
                  </Text>
                </View>

                {participant.status === "joined" && (
                  <View style={styles.onlineDot} />
                )}
              </View>
            ))}
          </View>

          <Text style={styles.meshStatus}>
            Peer mesh: {peerRows.length}
          </Text>
        </ScrollView>

        <View style={styles.controls}>
          <Pressable
            onPress={toggleMute}
            style={styles.controlButton}
          >
            <Ionicons
              name={muted ? "mic-off" : "mic"}
              size={25}
              color="#FFFFFF"
            />
            <Text style={styles.controlText}>
              {muted ? "Unmute" : "Mute"}
            </Text>
          </Pressable>

          {call.call_type === "video" && (
            <Pressable
              onPress={toggleCamera}
              style={styles.controlButton}
            >
              <Ionicons
                name={
                  cameraEnabled
                    ? "videocam"
                    : "videocam-off"
                }
                size={25}
                color="#FFFFFF"
              />
              <Text style={styles.controlText}>
                Camera
              </Text>
            </Pressable>
          )}

          <Pressable
            onPress={() => void finishCall()}
            disabled={ending}
            style={styles.endButton}
          >
            {ending ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
              />
            ) : (
              <Ionicons
                name="call"
                size={25}
                color="#FFFFFF"
              />
            )}
            <Text style={styles.controlText}>
              {role === "host" ? "End" : "Leave"}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#111816",
  },
  center: {
    flex: 1,
    backgroundColor: "#111816",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 24,
  },
  connectingText: {
    color: "#D8E0DD",
    fontSize: 15,
  },
  errorTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "800",
  },
  backButton: {
    backgroundColor: "#176B5B",
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 12,
  },
  backButtonText: {
    color: "#FFFFFF",
    fontWeight: "800",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  topButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  titleArea: {
    flex: 1,
    alignItems: "center",
  },
  groupName: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
  },
  callMeta: {
    color: "#A7B2AF",
    fontSize: 12,
    marginTop: 2,
  },
  content: {
    padding: 14,
    paddingBottom: 120,
    gap: 12,
  },
  videoCard: {
    aspectRatio: 16 / 9,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "#25302D",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  videoLabel: {
    position: "absolute",
    left: 10,
    bottom: 10,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  videoLabelText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 12,
  },
  waitingCard: {
    minHeight: 180,
    borderRadius: 18,
    backgroundColor: "#1C2523",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  waitingTitle: {
    color: "#D8E0DD",
    fontWeight: "700",
  },
  voiceStage: {
    minHeight: 320,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  voiceAvatar: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: "#176B5B",
    alignItems: "center",
    justifyContent: "center",
  },
  voiceTitle: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  voiceSubtitle: {
    color: "#A7B2AF",
    fontSize: 14,
  },
  participantCard: {
    backgroundColor: "#1C2523",
    borderRadius: 18,
    padding: 14,
    gap: 4,
  },
  sectionTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 6,
  },
  participantRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#34413E",
  },
  participantAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#34423F",
    alignItems: "center",
    justifyContent: "center",
  },
  participantDetails: {
    flex: 1,
  },
  participantName: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
  participantStatus: {
    color: "#A7B2AF",
    fontSize: 12,
    marginTop: 2,
    textTransform: "capitalize",
  },
  onlineDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#22C55E",
  },
  meshStatus: {
    color: "#77837F",
    textAlign: "center",
    fontSize: 11,
  },
  controls: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 14,
    minHeight: 84,
    borderRadius: 22,
    backgroundColor: "#1C2523",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 12,
  },
  controlButton: {
    minWidth: 74,
    alignItems: "center",
    gap: 5,
    paddingVertical: 10,
  },
  endButton: {
    minWidth: 74,
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: "#B42318",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 14,
  },
  controlText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
});
