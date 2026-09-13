import Ionicons from "@expo/vector-icons/Ionicons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as Network from "expo-network";
import { setAudioModeAsync, useAudioPlayer
} from "expo-audio";
import InCallManager from "react-native-incall-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import {
  mediaDevices,
  MediaStream,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
} from "react-native-webrtc";

import { UserAvatar } from "../../components/UserAvatar";
import { useAuth } from "../../contexts/AuthContext";
import {
  expireStaleCalls,
  finishVoiceCall,
  type CallStatus,
  type VoiceCall,
} from "../../lib/calling";
import {
  CALLKIT_END_REASONS,
  endNativeCall,
  markNativeOutgoingCallConnected,
  setNativeCallMuted,
  startNativeOutgoingCall,
} from "../../lib/callkit";
import {
  clearWaitingCall,
  subscribeToWaitingCall,
  type WaitingCall,
} from "../../lib/callWaiting";
import {
  isNativeCallHandoffFrom,
  markNativeCallHandoffCleanupComplete,
} from "../../lib/nativeCallHandoff";
import { supabase } from "../../lib/supabase";

const VOIP_SERVER_URL = (
  process.env.EXPO_PUBLIC_VOIP_SERVER_URL ||
  "https://globalqall-voip.onrender.com"
).replace(/\/+$/, "");

const FALLBACK_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

let cachedIceServers: IceServerConfig[] | null = null;
let cachedIceServersExpiresAt = 0;

async function loadIceServers(): Promise<IceServerConfig[]> {
  const now = Date.now();

  if (
    cachedIceServers &&
    cachedIceServersExpiresAt > now
  ) {
    return cachedIceServers;
  }

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error("No authenticated session for TURN request");
    }

    const response = await fetch(
      `${VOIP_SERVER_URL}/api/turn-credentials`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `TURN endpoint returned ${response.status}`
      );
    }

    const payload = await response.json();
    const remoteIceServers = Array.isArray(payload?.iceServers)
      ? (payload.iceServers as IceServerConfig[])
      : [];

    if (remoteIceServers.length === 0) {
      throw new Error("TURN endpoint returned no ICE servers");
    }

    const ttlSeconds = Number(payload?.ttl || 3600);

    cachedIceServers = [
      ...FALLBACK_ICE_SERVERS,
      ...remoteIceServers,
    ];

    // Refresh credentials before the one-hour token expires.
    cachedIceServersExpiresAt =
      now + Math.max(60, ttlSeconds - 600) * 1000;

    console.log("[TURN]", {
      event: "ice_servers_loaded",
      serverCount: cachedIceServers.length,
      relayServerCount: remoteIceServers.filter((server) => {
        const urls = Array.isArray(server.urls)
          ? server.urls
          : [server.urls];

        return urls.some((url) =>
          String(url).startsWith("turn:")
        );
      }).length,
      ttlSeconds,
      timestamp: new Date().toISOString(),
    });

    return cachedIceServers;
  } catch (error) {
    console.warn("[TURN]", {
      event: "ice_servers_fallback_stun_only",
      error:
        error instanceof Error
          ? error.message
          : String(error),
      timestamp: new Date().toISOString(),
    });

    return FALLBACK_ICE_SERVERS;
  }
}

const UNANSWERED_TIMEOUT_MS = 35_000;
const INITIAL_CONNECT_TIMEOUT_MS = 25_000;
const RECONNECT_GRACE_MS = 12_000;
const ICE_RESTART_COOLDOWN_MS = 6_000;
const JS_HEARTBEAT_INTERVAL_MS = 5_000;
const JS_SUSPENSION_GAP_MS = 12_000;
const POST_SUSPENSION_VERIFY_MS = 1_200;
const BACKGROUND_NETWORK_VERIFY_MS = 1_500;

// Sprint 10.2D.3: accepted-call liveness is intentionally much slower
// than ICE/TURN recovery. Media recovery gets the first chance to succeed.
const PEER_LIVENESS_SAMPLE_MS = 10_000;
const PEER_LIVENESS_WRITE_MIN_MS = 20_000;
const STALE_ACCEPTED_CHECK_MS = 30_000;
const TERMINAL_CALL_STATUSES = new Set([
  "declined",
  "ended",
  "missed",
  "failed",
]);

function isTerminalCallStatus(status: string): boolean {
  return TERMINAL_CALL_STATUSES.has(status);
}

function terminalCallLabel(
  status: string,
  endReason?: string | null
): string {
  if (status === "declined") {
    return "Call declined";
  }

  if (status === "missed") {
    return "No answer";
  }

  if (status === "failed") {
    if (endReason === "unreachable") {
      return "User unavailable";
    }

    if (endReason === "connecting_timeout") {
      return "Unable to connect";
    }

    if (endReason === "connection_lost") {
      return "Connection lost";
    }

    if (endReason === "busy") {
      return "User is busy";
    }

    return "Call failed";
  }

  if (status === "ended") {
    return "Call ended";
  }

  return "Call ended";
}


function closeCallScreen() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace("/chats");
  }
}

type OtherProfile = {
  id: string;
  display_name: string | null;
  qall_id: string;
  avatar_url: string | null;
};

export default function CallScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams<{
    callId?: string | string[];
    direction?: string | string[];
    nativeAction?: string | string[];
    returnCallId?: string | string[];
  }>();
  const callId = Array.isArray(params.callId)
    ? params.callId[0]
    : params.callId;
  const nativeAction = Array.isArray(params.nativeAction)
    ? params.nativeAction[0]
    : params.nativeAction;
  const returnCallId = Array.isArray(params.returnCallId)
    ? params.returnCallId[0]
    : params.returnCallId;

  const [call, setCall] = useState<VoiceCall | null>(null);
  const [otherProfile, setOtherProfile] = useState<OtherProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [holdUpdating, setHoldUpdating] = useState(false);
  const [waitingCall, setWaitingCall] =
    useState<WaitingCall | null>(null);
  const [waitingActionBusy, setWaitingActionBusy] =
    useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [frontCamera, setFrontCamera] = useState(true);
  const [localStream, setLocalStream] =
    useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] =
    useState<MediaStream | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [connectionLabel, setConnectionLabel] =
    useState("Preparing call…");
  const [peerConnectionState, setPeerConnectionState] =
    useState("new");
  const [iceConnectionState, setIceConnectionState] =
    useState("new");
  const [networkQuality, setNetworkQuality] =
    useState<"Excellent" | "Good" | "Poor" | "Unknown">(
      "Unknown"
    );
  const [remoteVideoAvailable, setRemoteVideoAvailable] =
    useState(false);
  const ringbackPlayer = useAudioPlayer(
    require("../../assets/sounds/outgoing-ringback.wav"),
    { keepAudioSessionActive: true }
  );
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const previewPosition = useRef(
    new Animated.ValueXY({ x: 0, y: 0 })
  ).current;

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const reconnectTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const callChannelRef = useRef<any>(null);
  const remoteDescriptionReadyRef = useRef(false);
  const pendingCandidatesRef = useRef<Record<string, unknown>[]>([]);
  const offerCreatedRef = useRef(false);
  const answerAppliedRef = useRef(false);
  const answerApplyingRef = useRef(false);
  const iceRestartInProgressRef = useRef(false);
  const iceRestartAttemptRef = useRef(0);
  const lastIceRestartStartedAtRef = useRef(0);
  const lastHandledRestartOfferSdpRef = useRef<string | null>(null);
  const lastAnsweredRestartOfferSdpRef = useRef<string | null>(null);
  const callStatusRef = useRef<VoiceCall["status"] | null>(null);
  const lastNetworkTypeRef = useRef<string | null>(null);
  const lastNetworkConnectedRef = useRef<boolean | null>(null);
  const lastNetworkReachableRef = useRef<boolean | null>(null);
  const lastNetworkRecoveryAtRef = useRef(0);
  const lifecycleStateRef = useRef(AppState.currentState);
  const backgroundedAtRef = useRef<number | null>(null);
  const backgroundNetworkSnapshotRef = useRef<{
    type: string | null;
    isConnected: boolean | null;
    isInternetReachable: boolean | null;
  } | null>(null);
  const backgroundNetworkVerifyTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const lifecycleSummaryRef = useRef({
    backgroundCount: 0,
    resumeCount: 0,
    totalBackgroundMs: 0,
    longestBackgroundMs: 0,
    jsSuspensionCount: 0,
    backgroundNetworkChangeCount: 0,
    recoveryRequiredCount: 0,
    recoverySucceededCount: 0,
    unlockAudioRestoreCount: 0,
    firstBackgroundAt: null as string | null,
    lastResumeAt: null as string | null,
    lastNetworkFrom: null as string | null,
    lastNetworkTo: null as string | null,
  });
  const lifecycleSummaryWrittenRef = useRef(false);
  const lifecycleAudioRestoreTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const lastJsHeartbeatAtRef = useRef(Date.now());
  const postSuspensionVerifyTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const requestIceRestartRef = useRef<(() => void) | null>(null);
  const activeIceServersRef = useRef<IceServerConfig[]>([]);
  const speakerOnRef = useRef(false);
  const audioRecoveryTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const needsAudioRecoveryRef = useRef(false);
  const nativeAnswerAppliedRef = useRef(false);
  const acceptInFlightRef = useRef(false);
  const nativeOutgoingStartedRef = useRef(false);
  const nativeConnectedRef = useRef(false);
  const endedLocallyRef = useRef(false);
  const appliedCandidateKeysRef = useRef(new Set<string>());
  const seenRemoteIceUfragsRef = useRef(
    new Set<string>()
  );
  const unansweredTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const initialConnectTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const hasEverConnectedRef = useRef(false);
  const lastInboundPacketsRef = useRef(-1);
  const lastPeerLivenessWriteAtRef = useRef(0);
  const lastStaleAcceptedCheckAtRef = useRef(0);
  const lastQualitySnapshotRef = useRef<Record<string, unknown> | null>(
    null
  );
  const connectedDiagnosticWrittenRef = useRef(false);
  const terminalNavigationTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const suppressTerminalNavigationRef = useRef(false);

  const resumeReturnCall = useCallback(async () => {
    if (!returnCallId || !user?.id) {
      return;
    }

    try {
      const { data: heldCall, error: heldCallError } = await supabase
        .from("calls")
        .select("id, caller_id, callee_id, status")
        .eq("id", returnCallId)
        .maybeSingle();

      if (heldCallError) {
        throw heldCallError;
      }

      if (!heldCall || heldCall.status !== "accepted") {
        return;
      }

      const holdColumn =
        heldCall.caller_id === user.id
          ? "caller_on_hold"
          : heldCall.callee_id === user.id
            ? "callee_on_hold"
            : null;

      if (!holdColumn) {
        return;
      }

      const { error: resumeError } = await supabase
        .from("calls")
        .update({ [holdColumn]: false })
        .eq("id", returnCallId)
        .eq("status", "accepted");

      if (resumeError) {
        throw resumeError;
      }

      console.log("[CALL WAITING]", {
        callId,
        returnCallId,
        event: "held_call_resumed_before_return",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Never strand navigation because resume bookkeeping failed. The user
      // can still return to the first call and use its Resume control.
      console.warn("[CALL WAITING]", {
        callId,
        returnCallId,
        event: "held_call_auto_resume_failed",
        error:
          error instanceof Error
            ? error.message
            : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }, [callId, returnCallId, user?.id]);

  const closeCurrentCallScreen = useCallback(async () => {
    // Android app-level waiting-call switch or iOS CallKit "End & Accept":
    // the old call is expected to become terminal. It must never pop the new
    // call screen after the handoff has started.
    if (
      suppressTerminalNavigationRef.current ||
      (callId ? isNativeCallHandoffFrom(callId) : false)
    ) {
      console.log("[CALL WAITING]", {
        callId,
        event: "terminal_navigation_suppressed_during_switch",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    await resumeReturnCall();
    closeCallScreen();
  }, [callId, resumeReturnCall]);

  const recordCallDiagnostic = useCallback(
    async (
      eventName: string,
      severity: "info" | "warning" | "error" = "info",
      details: Record<string, unknown> = {}
    ) => {
      if (!callId || !user?.id) {
        return;
      }

      try {
        const { error } = await supabase.rpc(
          "record_call_diagnostic",
          {
            requested_call_id: callId,
            requested_event: eventName,
            requested_severity: severity,
            requested_details: details,
          }
        );

        if (error) {
          console.warn("[CALL DIAGNOSTICS]", {
            callId,
            event: "persist_failed",
            diagnosticEvent: eventName,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        // Diagnostics must never affect the call itself.
        console.warn("[CALL DIAGNOSTICS]", {
          callId,
          event: "persist_failed",
          diagnosticEvent: eventName,
          error:
            error instanceof Error
              ? error.message
              : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    },
    [callId, user?.id]
  );

  const previewPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        previewPosition.setOffset({
          x: (previewPosition.x as any)._value,
          y: (previewPosition.y as any)._value,
        });
        previewPosition.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event(
        [
          null,
          {
            dx: previewPosition.x,
            dy: previewPosition.y,
          },
        ],
        { useNativeDriver: false }
      ),
      onPanResponderRelease: () => {
        previewPosition.flattenOffset();
      },
    })
  ).current;

  const isCaller = Boolean(call && user && call.caller_id === user.id);
  const isIncoming = Boolean(
    call && user && call.callee_id === user.id
  );
  const isVideoCall = call?.call_type === "video";
  const localOnHold = Boolean(
    call && isCaller ? call.caller_on_hold : call?.callee_on_hold
  );
  const remoteOnHold = Boolean(
    call && isCaller ? call.callee_on_hold : call?.caller_on_hold
  );

  useEffect(() => {
    return subscribeToWaitingCall((nextWaitingCall) => {
      if (
        nextWaitingCall &&
        nextWaitingCall.activeCallId === callId
      ) {
        setWaitingCall(nextWaitingCall);
        return;
      }

      setWaitingCall(null);
    });
  }, [callId]);

  const cleanupMedia = useCallback(() => {
    if (unansweredTimerRef.current) {
      clearTimeout(unansweredTimerRef.current);
      unansweredTimerRef.current = null;
    }

    if (initialConnectTimerRef.current) {
      clearTimeout(initialConnectTimerRef.current);
      initialConnectTimerRef.current = null;
    }

    localStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteVideoAvailable(false);

    peerRef.current?.close();
    peerRef.current = null;

    InCallManager.stop();
    InCallManager.setForceSpeakerphoneOn(false);
  }, []);

  const completeNativeHandoffCleanup = useCallback(() => {
    if (!callId || !isNativeCallHandoffFrom(callId)) {
      return false;
    }

    cleanupMedia();

    if (terminalNavigationTimerRef.current) {
      clearTimeout(terminalNavigationTimerRef.current);
      terminalNavigationTimerRef.current = null;
    }

    setConnectionLabel("Switching calls…");
    markNativeCallHandoffCleanupComplete(callId);

    console.log("[NATIVE CALL HANDOFF]", {
      callId,
      event: "old_call_screen_cleanup_complete",
      timestamp: new Date().toISOString(),
    });

    return true;
  }, [callId, cleanupMedia]);

  const extractIceUfragFromSdp = useCallback(
    (sdp: string | null | undefined) => {
      if (!sdp) return null;
      const match = sdp.match(/^a=ice-ufrag:(.+)$/m);
      return match?.[1]?.trim() || null;
    },
    [],
  );

  const extractCandidateIceUfrag = useCallback(
    (candidate: Record<string, unknown>) => {
      const explicit =
        typeof candidate.usernameFragment === "string"
          ? candidate.usernameFragment
          : typeof candidate.ufrag === "string"
            ? candidate.ufrag
            : null;

      if (explicit) return explicit;

      const candidateLine =
        typeof candidate.candidate === "string"
          ? candidate.candidate
          : "";

      const match = candidateLine.match(
        /\bufrag\s+([^\s]+)/i,
      );

      return match?.[1] || null;
    },
    [],
  );

  const classifyRemoteCandidateGeneration =
    useCallback(
      (
        candidate: Record<string, unknown>
      ): "current" | "future" | "stale" => {
        const peer = peerRef.current;

        if (!peer?.remoteDescription?.sdp) {
          return "future";
        }

        const expectedUfrag = extractIceUfragFromSdp(
          peer.remoteDescription.sdp,
        );
        const candidateUfrag =
          extractCandidateIceUfrag(candidate);

        if (!expectedUfrag || !candidateUfrag) {
          return "current";
        }

        if (expectedUfrag === candidateUfrag) {
          return "current";
        }

        if (
          seenRemoteIceUfragsRef.current.has(
            candidateUfrag
          )
        ) {
          return "stale";
        }

        return "future";
      },
      [
        extractCandidateIceUfrag,
        extractIceUfragFromSdp,
      ],
    );

  const candidateKey = useCallback(
    (candidate: Record<string, unknown>) => JSON.stringify(candidate),
    [],
  );

  const addRemoteCandidate = useCallback(
    async (candidate: Record<string, unknown>) => {
      if (!peerRef.current) {
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      const key = candidateKey(candidate);

      if (appliedCandidateKeysRef.current.has(key)) {
        return;
      }

      if (!remoteDescriptionReadyRef.current) {
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      const generation =
        classifyRemoteCandidateGeneration(candidate);

      if (generation === "future") {
        const alreadyQueued =
          pendingCandidatesRef.current.some(
            (queuedCandidate) =>
              candidateKey(queuedCandidate) === key
          );

        if (!alreadyQueued) {
          pendingCandidatesRef.current.push(candidate);
        }

        console.log("[ICE GENERATION]", {
          callId,
          event: "future_candidate_queued",
          expectedUfrag: extractIceUfragFromSdp(
            peerRef.current.remoteDescription?.sdp
          ),
          candidateUfrag:
            extractCandidateIceUfrag(candidate),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (generation === "stale") {
        console.log("[ICE GENERATION]", {
          callId,
          event: "stale_candidate_ignored",
          expectedUfrag: extractIceUfragFromSdp(
            peerRef.current.remoteDescription?.sdp
          ),
          candidateUfrag:
            extractCandidateIceUfrag(candidate),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      try {
        await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        appliedCandidateKeysRef.current.add(key);
      } catch (error) {
        console.warn("Could not add remote ICE candidate:", error);
      }
    },
    [
      callId,
      candidateKey,
      classifyRemoteCandidateGeneration,
      extractCandidateIceUfrag,
      extractIceUfragFromSdp,
    ],
  );

  const flushCandidates = useCallback(async () => {
    if (!peerRef.current || !remoteDescriptionReadyRef.current) {
      return;
    }

    const queued = [...pendingCandidatesRef.current];
    pendingCandidatesRef.current = [];

    for (const candidate of queued) {
      await addRemoteCandidate(candidate);
    }

    console.log("[ICE GENERATION]", {
      callId,
      event: "candidate_queue_flushed",
      attempted: queued.length,
      remaining: pendingCandidatesRef.current.length,
      currentUfrag: extractIceUfragFromSdp(
        peerRef.current.remoteDescription?.sdp
      ),
      timestamp: new Date().toISOString(),
    });
  }, [
    addRemoteCandidate,
    callId,
    extractIceUfragFromSdp,
  ]);

  const syncRemoteCandidates = useCallback(async () => {
    if (!callId || !user) {
      return;
    }

    const { data, error } = await supabase
      .from("call_ice_candidates")
      .select("user_id, candidate")
      .eq("call_id", callId)
      .neq("user_id", user.id)
      .order("id", { ascending: true });

    if (error) {
      console.warn("Could not synchronize ICE candidates:", error.message);
      return;
    }

    for (const row of data ?? []) {
      await addRemoteCandidate(row.candidate as Record<string, unknown>);
    }
  }, [addRemoteCandidate, callId, user]);

  const applyRemoteAnswer = useCallback(
    async (answer: Record<string, unknown> | null) => {
      const peer = peerRef.current;

      if (
        !answer ||
        !peer ||
        answerAppliedRef.current ||
        answerApplyingRef.current
      ) {
        return;
      }

      // A remote answer is valid only while the caller is waiting in
      // "have-local-offer". Realtime plus recovery polling can deliver the
      // same answer more than once, so ignore it after the peer becomes stable.
      if (peer.signalingState !== "have-local-offer") {
        if ((peer.signalingState as string) === "stable") {
          answerAppliedRef.current = true;
        }
        return;
      }

      answerApplyingRef.current = true;

      try {
        const previousRemoteUfrag =
          extractIceUfragFromSdp(
            peer.remoteDescription?.sdp,
          );

        await peer.setRemoteDescription(
          new RTCSessionDescription(answer as any),
        );

        const nextRemoteUfrag =
          extractIceUfragFromSdp(
            peer.remoteDescription?.sdp,
          );

        if (
          previousRemoteUfrag &&
          nextRemoteUfrag &&
          previousRemoteUfrag !== nextRemoteUfrag
        ) {
          seenRemoteIceUfragsRef.current.add(
            previousRemoteUfrag
          );
          seenRemoteIceUfragsRef.current.add(
            nextRemoteUfrag
          );
          appliedCandidateKeysRef.current.clear();
    seenRemoteIceUfragsRef.current.clear();

          console.log("[ICE GENERATION]", {
            callId,
            event: "remote_generation_changed",
            previousUfrag: previousRemoteUfrag,
            nextUfrag: nextRemoteUfrag,
            side: "caller",
            timestamp: new Date().toISOString(),
          });
        }

        if (nextRemoteUfrag) {
          seenRemoteIceUfragsRef.current.add(
            nextRemoteUfrag
          );
        }

        answerAppliedRef.current = true;
        remoteDescriptionReadyRef.current = true;
        await flushCandidates();
        await syncRemoteCandidates();

        // The remote SDP answer has been applied successfully and the call
        // is already accepted in Supabase. Do not keep the caller UI stuck
        // on “Connecting…” while waiting for a delayed WebRTC callback.
        setConnectionLabel("Connected");
      } catch (error) {
        // Another answer handler may have completed while this async call was
        // waiting. A stable peer already has its remote answer, so this is safe.
        if ((peer.signalingState as string) === "stable") {
          answerAppliedRef.current = true;
          return;
        }

        throw error;
      } finally {
        answerApplyingRef.current = false;
      }
    },
    [
      extractIceUfragFromSdp,
      flushCandidates,
      syncRemoteCandidates,
    ],
  );

  const handleRemoteIceRestartOffer = useCallback(
    async (offer: Record<string, unknown> | null) => {
      if (!offer || !callId || !user || isCaller) {
        return;
      }

      const peer = peerRef.current;
      if (!peer) {
        return;
      }

      const offerSdp =
        typeof offer.sdp === "string" ? offer.sdp : null;

      if (!offerSdp) {
        return;
      }

      if (
        offerSdp === lastHandledRestartOfferSdpRef.current ||
        offerSdp === lastAnsweredRestartOfferSdpRef.current ||
        offerSdp === peer.remoteDescription?.sdp
      ) {
        console.log("[WEBRTC RECOVERY]", {
          callId,
          event: "restart_offer_ignored_duplicate",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      try {
        // Mark before awaiting anything so realtime/polling cannot process
        // the same SDP concurrently.
        lastHandledRestartOfferSdpRef.current = offerSdp;

        console.log("[WEBRTC RECOVERY]", {
          callId,
          event: "restart_offer_received",
          timestamp: new Date().toISOString(),
        });

        setConnectionLabel("Reconnecting…");

        const recoveryIceServers = await loadIceServers();
        activeIceServersRef.current = recoveryIceServers;

        const relayServerCount = recoveryIceServers.filter((server) => {
          const urls = Array.isArray(server.urls)
            ? server.urls
            : [server.urls];
          return urls.some((url) =>
            String(url).startsWith("turn:") ||
            String(url).startsWith("turns:")
          );
        }).length;

        console.log("[TURN RECOVERY]", {
          callId,
          event: "relay_policy_requested",
          reason: "callee_restart",
          iceServerCount: recoveryIceServers.length,
          relayServerCount,
          timestamp: new Date().toISOString(),
        });

        try {
          const setConfiguration = (peer as any).setConfiguration;
          if (relayServerCount > 0 && typeof setConfiguration === "function") {
            setConfiguration.call(peer, {
              iceServers: recoveryIceServers,
              iceTransportPolicy: "relay",
            });
            console.log("[TURN RECOVERY]", {
              callId,
              event: "relay_policy_applied",
              reason: "callee_restart",
              relayServerCount,
              timestamp: new Date().toISOString(),
            });
          } else {
            console.warn("[TURN RECOVERY]", {
              callId,
              event: relayServerCount === 0
                ? "relay_policy_unavailable_no_turn_servers"
                : "set_configuration_unavailable",
              reason: "callee_restart",
              timestamp: new Date().toISOString(),
            });
          }
        } catch (error) {
          console.warn("[TURN RECOVERY]", {
            callId,
            event: "relay_policy_apply_failed",
            reason: "callee_restart",
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          });
        }

        const previousRemoteUfrag =
          extractIceUfragFromSdp(
            peer.remoteDescription?.sdp,
          );

        await peer.setRemoteDescription(
          new RTCSessionDescription(offer as any),
        );

        const nextRemoteUfrag =
          extractIceUfragFromSdp(
            peer.remoteDescription?.sdp,
          );

        if (
          previousRemoteUfrag &&
          nextRemoteUfrag &&
          previousRemoteUfrag !== nextRemoteUfrag
        ) {
          seenRemoteIceUfragsRef.current.add(
            previousRemoteUfrag
          );
          seenRemoteIceUfragsRef.current.add(
            nextRemoteUfrag
          );
          appliedCandidateKeysRef.current.clear();

          console.log("[ICE GENERATION]", {
            callId,
            event: "remote_generation_changed",
            previousUfrag: previousRemoteUfrag,
            nextUfrag: nextRemoteUfrag,
            side: "callee",
            timestamp: new Date().toISOString(),
          });
        }

        if (nextRemoteUfrag) {
          seenRemoteIceUfragsRef.current.add(
            nextRemoteUfrag
          );
        }

        remoteDescriptionReadyRef.current = true;
        await flushCandidates();
        await syncRemoteCandidates();
        await flushCandidates();

        if (offerSdp === lastAnsweredRestartOfferSdpRef.current) {
          console.log("[WEBRTC RECOVERY]", {
            callId,
            event: "restart_answer_skipped_duplicate",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        const { data, error } = await supabase
          .from("calls")
          .update({
            answer: answer.toJSON ? answer.toJSON() : answer,
          })
          .eq("id", callId)
          .eq("status", "accepted")
          .select("id")
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          console.warn("[WEBRTC RECOVERY]", {
            callId,
            event: "restart_answer_not_saved",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        lastAnsweredRestartOfferSdpRef.current = offerSdp;

        console.log("[WEBRTC RECOVERY]", {
          callId,
          event: "restart_answer_saved",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        if (
          lastAnsweredRestartOfferSdpRef.current !== offerSdp &&
          lastHandledRestartOfferSdpRef.current === offerSdp
        ) {
          lastHandledRestartOfferSdpRef.current = null;
        }

        console.warn("[WEBRTC RECOVERY]", {
          callId,
          event: "restart_offer_failed",
          error:
            error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
        setConnectionLabel("Connection issue");
      }
    },
    [
      callId,
      extractIceUfragFromSdp,
      flushCandidates,
      isCaller,
      syncRemoteCandidates,
      user,
      recordCallDiagnostic,
    ],
  );

  const logSelectedIcePath = useCallback(
    async (peer: RTCPeerConnection) => {
      try {
        if (
          peer.connectionState === "closed" ||
          isTerminalCallStatus(callStatusRef.current ?? "")
        ) {
          return;
        }

        const stats: any = await peer.getStats();
        const reports: any[] = [];

        if (typeof stats?.forEach === "function") {
          stats.forEach((report: any) => reports.push(report));
        } else if (Array.isArray(stats)) {
          reports.push(...stats);
        }

        const byId = new Map<string, any>();
        for (const report of reports) {
          if (report?.id) {
            byId.set(report.id, report);
          }
        }

        let selectedPair: any = reports.find(
          (report) =>
            report?.type === "candidate-pair" &&
            report?.selected === true
        );

        if (!selectedPair) {
          const transport = reports.find(
            (report) =>
              report?.type === "transport" &&
              report?.selectedCandidatePairId
          );

          if (transport?.selectedCandidatePairId) {
            selectedPair = byId.get(
              transport.selectedCandidatePairId
            );
          }
        }

        if (!selectedPair) {
          selectedPair = reports.find(
            (report) =>
              report?.type === "candidate-pair" &&
              (report?.state === "succeeded" ||
                report?.nominated === true)
          );
        }

        const localCandidate = selectedPair?.localCandidateId
          ? byId.get(selectedPair.localCandidateId)
          : null;
        const remoteCandidate = selectedPair?.remoteCandidateId
          ? byId.get(selectedPair.remoteCandidateId)
          : null;

        console.log("[ICE PATH]", {
          callId,
          localCandidateType:
            localCandidate?.candidateType ?? null,
          localProtocol:
            localCandidate?.protocol ?? null,
          remoteCandidateType:
            remoteCandidate?.candidateType ?? null,
          remoteProtocol:
            remoteCandidate?.protocol ?? null,
          usingRelay:
            localCandidate?.candidateType === "relay" ||
            remoteCandidate?.candidateType === "relay",
          transportPolicy: "production-fallback",
          bytesSent: selectedPair?.bytesSent ?? null,
          bytesReceived: selectedPair?.bytesReceived ?? null,
          currentRoundTripTime:
            selectedPair?.currentRoundTripTime ?? null,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("[ICE PATH]", {
          callId,
          event: "stats_unavailable",
          error:
            error instanceof Error
              ? error.message
              : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    },
    [callId]
  );

  const preparePeer = useCallback(async () => {
    if (!callId || !user) throw new Error("Call information is missing.");
    if (peerRef.current) return peerRef.current;

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
    });

    InCallManager.start({
      media:
        call?.call_type === "video"
          ? "video"
          : "audio",
      auto: true,
    });
    InCallManager.setKeepScreenOn(true);

    // Professional route defaults: voice calls begin on the earpiece, while
    // video calls begin on speaker. Keep the UI state aligned with the route.
    const defaultSpeakerOn = call?.call_type === "video";
    InCallManager.setForceSpeakerphoneOn(defaultSpeakerOn);
    setSpeakerOn(defaultSpeakerOn);

    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video:
        call?.call_type === "video"
          ? {
              facingMode: "user",
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 24 },
            }
          : false,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);

    const iceServers = await loadIceServers();
    activeIceServersRef.current = iceServers;

    const relayServerCount = iceServers.filter((server) => {
      const urls = Array.isArray(server.urls)
        ? server.urls
        : [server.urls];

      return urls.some((url) =>
        String(url).startsWith("turn:") ||
        String(url).startsWith("turns:")
      );
    }).length;

    console.log("[TURN]", {
      callId,
      event: "startup_ice_policy",
      policy: "all",
      iceServerCount: iceServers.length,
      relayServerCount,
      timestamp: new Date().toISOString(),
    });

    const peer = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: "all",
    } as any);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    peer.onicecandidate = (event: any) => {
      if (!event.candidate) return;

      const serializedCandidate =
        event.candidate.toJSON
          ? event.candidate.toJSON()
          : event.candidate;

      console.log("[ICE GENERATION]", {
        callId,
        event: "local_candidate",
        ufrag: extractCandidateIceUfrag(
          serializedCandidate as Record<string, unknown>
        ),
        type:
          (serializedCandidate as any)?.type ?? null,
        protocol:
          (serializedCandidate as any)?.protocol ?? null,
        timestamp: new Date().toISOString(),
      });

      void supabase
        .from("call_ice_candidates")
        .insert({
          call_id: callId,
          user_id: user.id,
          candidate: serializedCandidate,
        })
        .then(({ error }) => {
          if (error) {
            console.warn("Could not save ICE candidate:", error.message);
          }
        });
    };

    const forceRelayPolicy = async (
      reason: "caller_restart" | "callee_restart"
    ) => {
      const servers = activeIceServersRef.current;
      const relayServerCount = servers.filter((server) => {
        const urls = Array.isArray(server.urls)
          ? server.urls
          : [server.urls];
        return urls.some((url) =>
          String(url).startsWith("turn:") ||
          String(url).startsWith("turns:")
        );
      }).length;

      console.log("[TURN RECOVERY]", {
        callId,
        event: "relay_policy_requested",
        reason,
        iceServerCount: servers.length,
        relayServerCount,
        timestamp: new Date().toISOString(),
      });

      if (relayServerCount === 0) {
        console.warn("[TURN RECOVERY]", {
          callId,
          event: "relay_policy_unavailable_no_turn_servers",
          reason,
          timestamp: new Date().toISOString(),
        });
        return false;
      }

      try {
        const setConfiguration = (peer as any).setConfiguration;
        if (typeof setConfiguration !== "function") {
          console.warn("[TURN RECOVERY]", {
            callId,
            event: "set_configuration_unavailable",
            reason,
            timestamp: new Date().toISOString(),
          });
          return false;
        }

        setConfiguration.call(peer, {
          iceServers: servers,
          iceTransportPolicy: "relay",
        });

        console.log("[TURN RECOVERY]", {
          callId,
          event: "relay_policy_applied",
          reason,
          relayServerCount,
          timestamp: new Date().toISOString(),
        });

        void recordCallDiagnostic(
          "turn_relay_forced",
          "warning",
          {
            reason,
            relayServerCount,
            peerConnectionState: peer.connectionState,
            iceConnectionState: peer.iceConnectionState,
            networkType:
              lastNetworkTypeRef.current ?? "unknown",
          }
        );

        return true;
      } catch (error) {
        console.warn("[TURN RECOVERY]", {
          callId,
          event: "relay_policy_apply_failed",
          reason,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
        return false;
      }
    };

    const attemptIceRestart = async () => {
      if (
        !isCaller ||
        iceRestartInProgressRef.current ||
        peer.connectionState === "closed"
      ) {
        return;
      }

      const now = Date.now();
      const sinceLastRestart =
        now - lastIceRestartStartedAtRef.current;

      if (
        lastIceRestartStartedAtRef.current > 0 &&
        sinceLastRestart < ICE_RESTART_COOLDOWN_MS
      ) {
        console.log("[WEBRTC RECOVERY]", {
          callId,
          event: "ice_restart_cooldown_ignored",
          remainingMs:
            ICE_RESTART_COOLDOWN_MS - sinceLastRestart,
          peerConnectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      lastIceRestartStartedAtRef.current = now;
      iceRestartInProgressRef.current = true;
      iceRestartAttemptRef.current += 1;
      const attempt = iceRestartAttemptRef.current;

      try {
        console.log("[WEBRTC RECOVERY]", {
          callId,
          event: "ice_restart_started",
          attempt,
          peerConnectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          timestamp: new Date().toISOString(),
        });

        void recordCallDiagnostic(
          "ice_restart_started",
          "warning",
          {
            attempt,
            peerConnectionState: peer.connectionState,
            iceConnectionState: peer.iceConnectionState,
            networkType:
              lastNetworkTypeRef.current ?? "unknown",
          }
        );

        setConnectionLabel("Reconnecting…");

        await forceRelayPolicy("caller_restart");

        // A new remote answer must be accepted for this restart negotiation.
        answerAppliedRef.current = false;
        answerApplyingRef.current = false;

        const restartOffer = await peer.createOffer({
          iceRestart: true,
          offerToReceiveAudio: true,
          offerToReceiveVideo:
            call?.call_type === "video",
        });

        await peer.setLocalDescription(restartOffer);

        const serializedOffer = restartOffer.toJSON
          ? restartOffer.toJSON()
          : restartOffer;

        const { data, error } = await supabase
          .from("calls")
          .update({
            offer: serializedOffer,
            answer: null,
          })
          .eq("id", callId)
          .eq("status", "accepted")
          .select("id")
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          console.warn("[WEBRTC RECOVERY]", {
            callId,
            event: "ice_restart_aborted_call_not_active",
            attempt,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        console.log("[WEBRTC RECOVERY]", {
          callId,
          event: "ice_restart_offer_saved",
          attempt,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("[WEBRTC RECOVERY]", {
          callId,
          event: "ice_restart_failed",
          attempt,
          error:
            error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });

        void recordCallDiagnostic(
          "ice_restart_failed",
          "error",
          {
            attempt,
            error:
              error instanceof Error
                ? error.message
                : String(error),
            peerConnectionState: peer.connectionState,
            iceConnectionState: peer.iceConnectionState,
            networkType:
              lastNetworkTypeRef.current ?? "unknown",
          }
        );

        setConnectionLabel("Connection issue");
      } finally {
        iceRestartInProgressRef.current = false;
      }
    };

    requestIceRestartRef.current = () => {
      void attemptIceRestart();
    };

    const clearReconnectGraceTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        console.log("[WEBRTC RECOVERY]", {
          callId,
          event: "grace_cancelled",
          timestamp: new Date().toISOString(),
        });
      }
    };

    const startReconnectGraceTimer = () => {
      if (reconnectTimerRef.current) return;
      console.log("[WEBRTC RECOVERY]", {
        callId,
        event: "grace_started",
        graceMs: RECONNECT_GRACE_MS,
        timestamp: new Date().toISOString(),
      });
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (
          peer.connectionState === "disconnected" ||
          peer.iceConnectionState === "disconnected"
        ) {
          console.warn("[WEBRTC RECOVERY]", {
            callId,
            event: "grace_expired",
            peerConnectionState: peer.connectionState,
            iceConnectionState: peer.iceConnectionState,
            timestamp: new Date().toISOString(),
          });
          setConnectionLabel("Connection issue");

          // Stage 3: only the caller initiates renegotiation so both peers
          // cannot create competing restart offers at the same time.
          if (isCaller) {
            void attemptIceRestart();
          }
        }
      }, RECONNECT_GRACE_MS);
    };

    const restoreAudioAfterRecovery = () => {
      try {
        const mediaType =
          call?.call_type === "video" ? "video" : "audio";

        // Re-assert the native in-call audio session after a network handoff.
        // ICE can be connected while iOS still holds a stale audio route.
        InCallManager.start({
          media: mediaType,
          auto: true,
        });
        InCallManager.setKeepScreenOn(true);
        InCallManager.setForceSpeakerphoneOn(
          speakerOnRef.current
        );

        // The remote MediaStream survives ICE restart. Make sure its audio
        // track is still enabled after the transport changes underneath it.
        const activeRemoteStream =
          remoteStreamRef.current;

        activeRemoteStream
          ?.getAudioTracks()
          .forEach((track) => {
            track.enabled = true;
          });

        console.log("[AUDIO RECOVERY]", {
          callId,
          event: "audio_route_restored",
          media: mediaType,
          speakerOn: speakerOnRef.current,
          remoteAudioTracks:
            activeRemoteStream?.getAudioTracks().length ?? 0,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("[AUDIO RECOVERY]", {
          callId,
          event: "audio_route_restore_failed",
          error:
            error instanceof Error
              ? error.message
              : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    };

    const logConnectionState = (
      source: "peer" | "ice"
    ) => {
      console.log("[WEBRTC STATE]", {
        callId,
        source,
        callStatus: callStatusRef.current,
        peerConnectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        signalingState: peer.signalingState,
        timestamp: new Date().toISOString(),
      });
    };

    const updateConnectionUi = () => {
      const peerState = peer.connectionState;
      const iceState = peer.iceConnectionState;

      if (peerState === "closed" || iceState === "closed") {
        clearReconnectGraceTimer();
        return;
      }

      if (
        peerState === "connected" ||
        iceState === "connected" ||
        iceState === "completed"
      ) {
        clearReconnectGraceTimer();

        if (!hasEverConnectedRef.current) {
          hasEverConnectedRef.current = true;

          if (initialConnectTimerRef.current) {
            clearTimeout(initialConnectTimerRef.current);
            initialConnectTimerRef.current = null;
          }

          console.log("[CALL TIMEOUT]", {
            callId,
            event: "initial_connection_established",
            peerConnectionState: peerState,
            iceConnectionState: iceState,
            timestamp: new Date().toISOString(),
          });

          if (!connectedDiagnosticWrittenRef.current) {
            connectedDiagnosticWrittenRef.current = true;

            void recordCallDiagnostic(
              "call_connected",
              "info",
              {
                peerConnectionState: peerState,
                iceConnectionState: iceState,
                networkType:
                  lastNetworkTypeRef.current ?? "unknown",
              }
            );
          }
        }

        const recoveredFromRestart =
          iceRestartAttemptRef.current > 0;

        if (recoveredFromRestart) {
          console.log("[WEBRTC RECOVERY]", {
            callId,
            event: "ice_restart_recovered",
            attempts: iceRestartAttemptRef.current,
            timestamp: new Date().toISOString(),
          });

          lifecycleSummaryRef.current.recoverySucceededCount += 1;

          void recordCallDiagnostic(
            "ice_restart_recovered",
            "info",
            {
              attempts: iceRestartAttemptRef.current,
              peerConnectionState: peerState,
              iceConnectionState: iceState,
              networkType:
                lastNetworkTypeRef.current ?? "unknown",
              quality: lastQualitySnapshotRef.current,
            }
          );

          iceRestartAttemptRef.current = 0;
        }

        const shouldRestoreAudio =
          callStatusRef.current === "accepted" &&
          (needsAudioRecoveryRef.current || recoveredFromRestart);

        if (shouldRestoreAudio) {
          // Consume the recovery marker now so multiple connected/completed
          // callbacks from the same handoff cannot schedule duplicate work.
          needsAudioRecoveryRef.current = false;

          if (audioRecoveryTimerRef.current) {
            clearTimeout(audioRecoveryTimerRef.current);
          }

          console.log("[AUDIO RECOVERY]", {
            callId,
            event: "audio_restore_scheduled",
            recoveredFromRestart,
            peerConnectionState: peerState,
            iceConnectionState: iceState,
            timestamp: new Date().toISOString(),
          });

          // Let the newly selected ICE path settle before reasserting the
          // native in-call route.
          audioRecoveryTimerRef.current = setTimeout(() => {
            audioRecoveryTimerRef.current = null;
            restoreAudioAfterRecovery();
          }, 500);
        }

        setConnectionLabel("Connected");

        setTimeout(() => {
          void logSelectedIcePath(peer);
        }, 800);

        return;
      }

      if (
        peerState === "disconnected" ||
        iceState === "disconnected"
      ) {
        if (callStatusRef.current === "accepted") {
          needsAudioRecoveryRef.current = true;
        }

        setConnectionLabel("Reconnecting…");

        // During active renegotiation on the callee, don't start another
        // grace timer for the same recovery cycle.
        if (
          isCaller ||
          !lastHandledRestartOfferSdpRef.current ||
          peer.signalingState === "stable"
        ) {
          startReconnectGraceTimer();
        }

        return;
      }

      if (peerState === "failed" || iceState === "failed") {
        if (callStatusRef.current === "accepted") {
          needsAudioRecoveryRef.current = true;
        }

        clearReconnectGraceTimer();
        setConnectionLabel("Connection issue");

        if (isCaller) {
          void attemptIceRestart();
        }
        return;
      }

      if (peerState === "connecting" || iceState === "checking") {
        setConnectionLabel("Connecting…");
      }
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      setPeerConnectionState(state);
      logConnectionState("peer");
      updateConnectionUi();
    };

    peer.oniceconnectionstatechange = () => {
      const state = peer.iceConnectionState;
      setIceConnectionState(state);
      logConnectionState("ice");
      updateConnectionUi();
    };

    peer.ontrack = (event: any) => {
      const incomingStream = event.streams?.[0];

      if (incomingStream) {
        remoteStreamRef.current = incomingStream;
        setRemoteStream(incomingStream);
        if (
          incomingStream.getVideoTracks().length > 0
        ) {
          setRemoteVideoAvailable(true);
        }
      } else if (event.track) {
        setRemoteStream((current) => {
          const nextStream =
            current ?? new MediaStream();

          const alreadyAdded = nextStream
            .getTracks()
            .some(
              (track) =>
                track.id === event.track.id
            );

          if (!alreadyAdded) {
            nextStream.addTrack(event.track);
          }

          remoteStreamRef.current = nextStream;

          if (event.track.kind === "video") {
            setRemoteVideoAvailable(true);

            event.track.onmute = () =>
              setRemoteVideoAvailable(false);
            event.track.onunmute = () =>
              setRemoteVideoAvailable(true);
            event.track.onended = () =>
              setRemoteVideoAvailable(false);
          }

          return nextStream;
        });
      }

      setConnectionLabel("Connected");
    };

    peerRef.current = peer;
    return peer;
  }, [
    call?.call_type,
    callId,
    extractCandidateIceUfrag,
    isCaller,
    logSelectedIcePath,
    user,
  ]);

  const createOffer = useCallback(async () => {
    if (!callId || offerCreatedRef.current) return;
    offerCreatedRef.current = true;
    setPreparing(true);
    try {
      const peer = await preparePeer();
      const offer = await peer.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo:
          call?.call_type === "video",
      });
      await peer.setLocalDescription(offer);
      const { data: offerUpdate, error } = await supabase
        .from("calls")
        .update({ offer: offer.toJSON ? offer.toJSON() : offer })
        .eq("id", callId)
        .eq("status", "ringing")
        .select("id")
        .maybeSingle();
      if (error) throw error;

      if (!offerUpdate) {
        cleanupMedia();
        endNativeCall(callId, CALLKIT_END_REASONS.REMOTE_ENDED);
        setConnectionLabel("Call no longer available");
        return;
      }

      setConnectionLabel("Ringing…");

      const { data: latestCall } = await supabase
        .from("calls")
        .select("answer, status")
        .eq("id", callId)
        .maybeSingle();

      if (latestCall?.status === "accepted" && latestCall?.answer) {
        await applyRemoteAnswer(latestCall.answer as Record<string, unknown>);
      }
    } finally {
      setPreparing(false);
    }
  }, [
    applyRemoteAnswer,
    call?.call_type,
    callId,
    cleanupMedia,
    preparePeer,
  ]);

  const acceptCall = useCallback(async () => {
    if (!callId || !call?.offer) {
      return;
    }

    if (acceptInFlightRef.current) {
      console.log("[CALL RACE]", {
        callId,
        event: "duplicate_accept_ignored",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // A ref changes synchronously, unlike React state. This closes the tiny
    // window where two Accept events can arrive before `preparing` re-renders.
    acceptInFlightRef.current = true;
    setPreparing(true);

    try {
      const peer = await preparePeer();
      await peer.setRemoteDescription(new RTCSessionDescription(call.offer as any));
      remoteDescriptionReadyRef.current = true;
      await flushCandidates();
      await syncRemoteCandidates();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      const now = new Date().toISOString();
      const { data: acceptedTransition, error } = await supabase
        .from("calls")
        .update({
          answer: answer.toJSON ? answer.toJSON() : answer,
          status: "accepted",
          answered_at: now,
        })
        .eq("id", callId)
        .eq("status", "ringing")
        .select("id, status")
        .maybeSingle();
      if (error) throw error;

      if (!acceptedTransition) {
        // Another terminal transition (decline, timeout, or caller cancel)
        // won the race before this answer reached the database.
        cleanupMedia();
        endNativeCall(callId, CALLKIT_END_REASONS.REMOTE_ENDED);
        setConnectionLabel("Call no longer available");
        return;
      }

      setConnectionLabel("Connecting…");
    } catch (error) {
      Alert.alert(
        "Call error",
        error instanceof Error ? error.message : "Could not answer the call.",
      );
    } finally {
      acceptInFlightRef.current = false;
      setPreparing(false);
    }
  }, [
    call,
    callId,
    cleanupMedia,
    flushCandidates,
    preparePeer,
    preparing,
    syncRemoteCandidates,
  ]);

  useEffect(() => {
    if (
      nativeAction !== "answer" ||
      nativeAnswerAppliedRef.current ||
      !call?.offer ||
      call.status !== "ringing"
    ) {
      return;
    }

    nativeAnswerAppliedRef.current = true;
    void acceptCall();
  }, [acceptCall, call, nativeAction]);

  const finishCall = useCallback(
    async (
      status: CallStatus = "ended",
      reason = "local_hangup"
    ) => {
      if (!callId) {
        return;
      }

      if (endedLocallyRef.current) {
        console.log("[CALL RACE]", {
          callId,
          event: "duplicate_finish_ignored",
          requestedStatus: status,
          requestedReason: reason,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Lock this device against double taps while the conditional update is
      // in flight. If the database update itself fails, release the lock so
      // the user can retry.
      endedLocallyRef.current = true;

      const expectedStatuses: CallStatus[] =
        status === "declined" || status === "missed"
          ? ["ringing"]
          : status === "ended"
            ? ["accepted"]
            : status === "failed"
              ? ["ringing", "accepted"]
              : [];

      try {
        if (expectedStatuses.length > 0) {
          const nowIso = new Date().toISOString();
          const { data: transition, error: transitionError } = await supabase
            .from("calls")
            .update({
              status,
              end_reason: reason,
              ended_at: nowIso,
              last_state_changed_at: nowIso,
            })
            .eq("id", callId)
            .in("status", expectedStatuses)
            .select("id, status, end_reason")
            .maybeSingle();

          if (transitionError) {
            throw transitionError;
          }

          if (!transition) {
            // Another device/action already changed the call. Never overwrite
            // the winning state; just synchronize local/native UI.
            const { data: latest } = await supabase
              .from("calls")
              .select("status")
              .eq("id", callId)
              .maybeSingle();

            cleanupMedia();
            endNativeCall(
              callId,
              latest?.status === "missed"
                ? CALLKIT_END_REASONS.MISSED
                : latest?.status === "failed"
                  ? CALLKIT_END_REASONS.FAILED
                  : latest?.status === "declined"
                    ? CALLKIT_END_REASONS.DECLINED_ELSEWHERE
                    : CALLKIT_END_REASONS.REMOTE_ENDED,
            );
            void closeCurrentCallScreen();
            return;
          }
        }

        if (!lifecycleSummaryWrittenRef.current) {
          lifecycleSummaryWrittenRef.current = true;

          const summary = {
            ...lifecycleSummaryRef.current,
            finalStatus: status,
            finalReason: reason,
            finalNetworkType:
              lastNetworkTypeRef.current ?? "unknown",
            finalPeerConnectionState:
              peerRef.current?.connectionState ?? "closed",
            finalIceConnectionState:
              peerRef.current?.iceConnectionState ?? "closed",
            finalQuality:
              lastQualitySnapshotRef.current,
            hadLifecycleActivity:
              lifecycleSummaryRef.current.backgroundCount > 0 ||
              lifecycleSummaryRef.current.jsSuspensionCount > 0 ||
              lifecycleSummaryRef.current.backgroundNetworkChangeCount > 0 ||
              lifecycleSummaryRef.current.recoveryRequiredCount > 0,
          };

          console.log("[CALL LIFECYCLE SUMMARY]", {
            callId,
            event: "lifecycle_summary",
            ...summary,
            timestamp: new Date().toISOString(),
          });

          void recordCallDiagnostic(
            "lifecycle_summary",
            status === "failed" ? "warning" : "info",
            summary
          );
        }

        void recordCallDiagnostic(
          "call_terminal",
          status === "failed" ? "error" : "info",
          {
            status,
            reason,
            networkType:
              lastNetworkTypeRef.current ?? "unknown",
            finalQuality:
              lastQualitySnapshotRef.current,
          }
        );

        cleanupMedia();

        const nativeEndReason =
          status === "missed" && reason !== "cancelled_by_caller"
            ? CALLKIT_END_REASONS.MISSED
            : status === "failed"
              ? CALLKIT_END_REASONS.FAILED
              : status === "declined"
                ? CALLKIT_END_REASONS.DECLINED_ELSEWHERE
                : CALLKIT_END_REASONS.REMOTE_ENDED;

        endNativeCall(callId, nativeEndReason);

        // Preserve the existing helper's bookkeeping (reason/history fields).
        // The status was already claimed conditionally above, so this call can
        // no longer steal a transition from answer/decline/timeout.
        await finishVoiceCall(
          callId,
          status,
          reason
        );
      } catch (error) {
        endedLocallyRef.current = false;
        console.warn(
          "Could not finish call:",
          error instanceof Error
            ? error.message
            : error
        );
        return;
      }

      void closeCurrentCallScreen();
    },
    [callId, cleanupMedia, recordCallDiagnostic]
  );

  useEffect(() => {
    if (!callId || call?.status !== "accepted") {
      if (initialConnectTimerRef.current) {
        clearTimeout(initialConnectTimerRef.current);
        initialConnectTimerRef.current = null;
      }
      return;
    }

    if (hasEverConnectedRef.current) {
      return;
    }

    const peer = peerRef.current;
    const alreadyConnected =
      peer?.connectionState === "connected" ||
      peer?.iceConnectionState === "connected" ||
      peer?.iceConnectionState === "completed";

    if (alreadyConnected) {
      hasEverConnectedRef.current = true;
      return;
    }

    if (initialConnectTimerRef.current) {
      return;
    }

    console.log("[CALL TIMEOUT]", {
      callId,
      event: "initial_connect_timer_started",
      timeoutMs: INITIAL_CONNECT_TIMEOUT_MS,
      peerConnectionState: peer?.connectionState ?? null,
      iceConnectionState: peer?.iceConnectionState ?? null,
      timestamp: new Date().toISOString(),
    });

    initialConnectTimerRef.current = setTimeout(() => {
      initialConnectTimerRef.current = null;

      const activePeer = peerRef.current;
      const connected =
        hasEverConnectedRef.current ||
        activePeer?.connectionState === "connected" ||
        activePeer?.iceConnectionState === "connected" ||
        activePeer?.iceConnectionState === "completed";

      if (
        callStatusRef.current !== "accepted" ||
        connected ||
        endedLocallyRef.current
      ) {
        console.log("[CALL TIMEOUT]", {
          callId,
          event: "initial_connect_timeout_cancelled",
          callStatus: callStatusRef.current,
          connected,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      console.warn("[CALL TIMEOUT]", {
        callId,
        event: "initial_connect_timeout_expired",
        peerConnectionState:
          activePeer?.connectionState ?? null,
        iceConnectionState:
          activePeer?.iceConnectionState ?? null,
        timestamp: new Date().toISOString(),
      });

      setConnectionLabel("Unable to connect");
      void finishCall("failed", "connecting_timeout");
    }, INITIAL_CONNECT_TIMEOUT_MS);

    return () => {
      if (initialConnectTimerRef.current) {
        clearTimeout(initialConnectTimerRef.current);
        initialConnectTimerRef.current = null;
      }
    };
  }, [call?.status, callId, finishCall]);

  const finishMissedIfStillRinging = useCallback(
    async (reason = "unanswered") => {
      if (!callId || endedLocallyRef.current) {
        return;
      }

      const { data, error } = await supabase
        .from("calls")
        .select(
          "status, created_at, expires_at, ringing_acknowledged_at"
        )
        .eq("id", callId)
        .maybeSingle();

      if (error) {
        console.warn(
          "Could not verify unanswered call status:",
          error.message
        );
        return;
      }

      if (!data || data.status !== "ringing") {
        return;
      }

      const expiryTime = data.expires_at
        ? new Date(data.expires_at).getTime()
        : new Date(data.created_at).getTime() +
          UNANSWERED_TIMEOUT_MS;

      if (Date.now() < expiryTime) {
        return;
      }

      const wasAcknowledged = Boolean(
        data.ringing_acknowledged_at
      );

      console.log("[CALL DELIVERY]", {
        callId,
        event: wasAcknowledged
          ? "unanswered_after_delivery"
          : "unreachable_no_acknowledgement",
        ringingAcknowledgedAt:
          data.ringing_acknowledged_at ?? null,
        timestamp: new Date().toISOString(),
      });

      await finishCall(
        wasAcknowledged ? "missed" : "failed",
        wasAcknowledged ? reason : "unreachable"
      );
    },
    [callId, finishCall]
  );

  const handleEndPress = useCallback(() => {
    if (call?.status === "ringing" && isCaller) {
      // Preserve the existing history model: a caller cancellation before
      // answer is stored as missed, with a distinct reason for diagnostics.
      void finishCall("missed", "cancelled_by_caller");
      return;
    }

    void finishCall("ended", "local_hangup");
  }, [call?.status, finishCall, isCaller]);

  useEffect(() => {
    // A CallKit waiting-call switch can replace /call/[callId] with another
    // call while this screen component is still mounted. Reset all per-call
    // guards so the new incoming call can initialize and answer normally.
    if (terminalNavigationTimerRef.current) {
      clearTimeout(terminalNavigationTimerRef.current);
      terminalNavigationTimerRef.current = null;
    }

    cleanupMedia();
    remoteDescriptionReadyRef.current = false;
    pendingCandidatesRef.current = [];
    offerCreatedRef.current = false;
    answerAppliedRef.current = false;
    answerApplyingRef.current = false;
    hasEverConnectedRef.current = false;
    lastInboundPacketsRef.current = -1;
    lastPeerLivenessWriteAtRef.current = 0;
    lastStaleAcceptedCheckAtRef.current = 0;
    lastQualitySnapshotRef.current = null;
    connectedDiagnosticWrittenRef.current = false;
    iceRestartInProgressRef.current = false;
    iceRestartAttemptRef.current = 0;
    lastIceRestartStartedAtRef.current = 0;
    lastHandledRestartOfferSdpRef.current = null;
    lastAnsweredRestartOfferSdpRef.current = null;
    lastNetworkTypeRef.current = null;
    lastNetworkConnectedRef.current = null;
    lastNetworkReachableRef.current = null;
    lastNetworkRecoveryAtRef.current = 0;
    lifecycleStateRef.current = AppState.currentState;
    backgroundedAtRef.current = null;
    backgroundNetworkSnapshotRef.current = null;
    lifecycleSummaryRef.current = {
      backgroundCount: 0,
      resumeCount: 0,
      totalBackgroundMs: 0,
      longestBackgroundMs: 0,
      jsSuspensionCount: 0,
      backgroundNetworkChangeCount: 0,
      recoveryRequiredCount: 0,
      recoverySucceededCount: 0,
      unlockAudioRestoreCount: 0,
      firstBackgroundAt: null,
      lastResumeAt: null,
      lastNetworkFrom: null,
      lastNetworkTo: null,
    };
    lifecycleSummaryWrittenRef.current = false;

    if (backgroundNetworkVerifyTimerRef.current) {
      clearTimeout(backgroundNetworkVerifyTimerRef.current);
      backgroundNetworkVerifyTimerRef.current = null;
    }

    if (lifecycleAudioRestoreTimerRef.current) {
      clearTimeout(lifecycleAudioRestoreTimerRef.current);
      lifecycleAudioRestoreTimerRef.current = null;
    }

    lastJsHeartbeatAtRef.current = Date.now();

    if (postSuspensionVerifyTimerRef.current) {
      clearTimeout(postSuspensionVerifyTimerRef.current);
      postSuspensionVerifyTimerRef.current = null;
    }

    requestIceRestartRef.current = null;
    activeIceServersRef.current = [];
    needsAudioRecoveryRef.current = false;
    nativeAnswerAppliedRef.current = false;
    acceptInFlightRef.current = false;
    nativeOutgoingStartedRef.current = false;
    nativeConnectedRef.current = false;
    endedLocallyRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (audioRecoveryTimerRef.current) {
      clearTimeout(audioRecoveryTimerRef.current);
      audioRecoveryTimerRef.current = null;
    }

    if (backgroundNetworkVerifyTimerRef.current) {
      clearTimeout(backgroundNetworkVerifyTimerRef.current);
      backgroundNetworkVerifyTimerRef.current = null;
    }

    if (lifecycleAudioRestoreTimerRef.current) {
      clearTimeout(lifecycleAudioRestoreTimerRef.current);
      lifecycleAudioRestoreTimerRef.current = null;
    }

    if (postSuspensionVerifyTimerRef.current) {
      clearTimeout(postSuspensionVerifyTimerRef.current);
      postSuspensionVerifyTimerRef.current = null;
    }

    setPeerConnectionState("new");
    setIceConnectionState("new");
    appliedCandidateKeysRef.current.clear();

    setCall(null);
    setOtherProfile(null);
    setLoading(true);
    setPreparing(false);
    setMuted(false);
    setHoldUpdating(false);
    setSpeakerOn(false);
    speakerOnRef.current = false;
    setCameraEnabled(true);
    setFrontCamera(true);
    setElapsedSeconds(0);
    setConnectionLabel("Preparing call…");
    setNetworkQuality("Unknown");
    setRemoteVideoAvailable(false);
  }, [callId, cleanupMedia]);

  useEffect(() => {
    callStatusRef.current = call?.status ?? null;
  }, [call?.status]);

  useEffect(() => {
    speakerOnRef.current = speakerOn;
  }, [speakerOn]);

  useEffect(() => {
    if (!callId || !user) return;
    let mounted = true;

    const load = async () => {
      try {
        await expireStaleCalls();

        const { error: staleAcceptedError } =
          await supabase.rpc(
            "expire_stale_accepted_call",
            {
              requested_call_id: callId,
            }
          );

        if (staleAcceptedError) {
          console.warn(
            "[CALL LIVENESS] load_stale_check_failed",
            staleAcceptedError.message
          );
        }

        const { data, error } = await supabase
          .from("calls")
          .select("*")
          .eq("id", callId)
          .single();
        if (error) throw error;
        const loadedCall = data as VoiceCall;
        if (!mounted) return;

        console.log("[CALL RECONCILE]", {
          callId,
          event: "call_load_reconciled",
          status: loadedCall.status,
          endReason: loadedCall.end_reason ?? null,
          timestamp: new Date().toISOString(),
        });

        if (isTerminalCallStatus(loadedCall.status)) {
          if (completeNativeHandoffCleanup()) {
            return;
          }

          cleanupMedia();
          endNativeCall(
            callId,
            loadedCall.status === "missed"
              ? CALLKIT_END_REASONS.MISSED
              : loadedCall.status === "failed"
                ? CALLKIT_END_REASONS.FAILED
                : loadedCall.status === "declined"
                  ? CALLKIT_END_REASONS.DECLINED_ELSEWHERE
                  : CALLKIT_END_REASONS.REMOTE_ENDED,
          );
          void closeCurrentCallScreen();
          return;
        }

        if (loadedCall.status === "ringing") {
          const expiryTime = loadedCall.expires_at
            ? new Date(loadedCall.expires_at).getTime()
            : new Date(loadedCall.created_at).getTime() +
              UNANSWERED_TIMEOUT_MS;

          if (Date.now() >= expiryTime) {
            setCall(loadedCall);
            await finishMissedIfStillRinging("expired_before_open");
            return;
          }
        }

        setCall(loadedCall);

        const otherId =
          loadedCall.caller_id === user.id
            ? loadedCall.callee_id
            : loadedCall.caller_id;
        const { data: profileData } = await supabase
          .from("profiles")
          .select("id, display_name, qall_id, avatar_url")
          .eq("id", otherId)
          .maybeSingle();
        if (mounted) setOtherProfile(profileData as OtherProfile | null);
      } catch (error) {
        Alert.alert(
          "Call error",
          error instanceof Error ? error.message : "Could not load the call.",
        );
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void load();
    return () => {
      mounted = false;
    };
  }, [
    callId,
    cleanupMedia,
    finishMissedIfStillRinging,
    user,
  ]);

  useEffect(() => {
    if (
      !callId ||
      !call ||
      !user ||
      !isIncoming ||
      call.status !== "ringing" ||
      call.ringing_acknowledged_at
    ) {
      return;
    }

    let cancelled = false;

    const acknowledge = async () => {
      const { error } = await supabase.rpc(
        "acknowledge_incoming_call",
        {
          requested_call_id: callId,
        }
      );

      if (error) {
        console.warn(
          "Could not acknowledge incoming call:",
          error.message
        );
        return;
      }

      if (cancelled) {
        return;
      }

      const acknowledgedAt = new Date().toISOString();

      setCall((current) =>
        current && current.id === callId
          ? {
              ...current,
              ringing_acknowledged_at:
                current.ringing_acknowledged_at ??
                acknowledgedAt,
            }
          : current
      );

      console.log("[CALL DELIVERY]", {
        callId,
        event: "incoming_call_acknowledged",
        timestamp: acknowledgedAt,
      });
    };

    void acknowledge();

    return () => {
      cancelled = true;
    };
  }, [
    call?.id,
    call?.ringing_acknowledged_at,
    call?.status,
    callId,
    isIncoming,
    user,
  ]);

  useEffect(() => {
    if (!call || !user || !isCaller || call.status !== "ringing") return;
    void createOffer();
  }, [call, createOffer, isCaller, user]);

  useEffect(() => {
    if (
      !callId ||
      !call ||
      !otherProfile ||
      !isCaller ||
      call.status !== "ringing" ||
      nativeOutgoingStartedRef.current
    ) {
      return;
    }

    nativeOutgoingStartedRef.current = true;
    void startNativeOutgoingCall({
      callId,
      handle: otherProfile.qall_id,
      contactName:
        otherProfile.display_name?.trim() ||
        otherProfile.qall_id,
      hasVideo: call.call_type === "video",
    });
  }, [call, callId, isCaller, otherProfile]);

  useEffect(() => {
    if (
      !callId ||
      call?.status !== "accepted" ||
      nativeConnectedRef.current
    ) {
      return;
    }

    nativeConnectedRef.current = true;
    markNativeOutgoingCallConnected(callId);
  }, [call?.status, callId]);



  useEffect(() => {
    if (!callId) {
      return;
    }

    const subscription = Network.addNetworkStateListener((state) => {
      const nextType = String(state.type ?? "unknown");
      const nextConnected = state.isConnected ?? null;
      const nextReachable = state.isInternetReachable ?? null;

      const previousType = lastNetworkTypeRef.current;
      const previousConnected = lastNetworkConnectedRef.current;
      const previousReachable = lastNetworkReachableRef.current;

      if (
        previousType === null &&
        previousConnected === null &&
        previousReachable === null
      ) {
        lastNetworkTypeRef.current = nextType;
        lastNetworkConnectedRef.current = nextConnected;
        lastNetworkReachableRef.current = nextReachable;

        console.log("[NETWORK STATE]", {
          callId,
          event: "network_baseline",
          type: nextType,
          isConnected: nextConnected,
          isInternetReachable: nextReachable,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const typeChanged = previousType !== nextType;
      const connectionChanged = previousConnected !== nextConnected;
      const reachabilityChanged = previousReachable !== nextReachable;

      if (!typeChanged && !connectionChanged && !reachabilityChanged) {
        return;
      }

      lastNetworkTypeRef.current = nextType;
      lastNetworkConnectedRef.current = nextConnected;
      lastNetworkReachableRef.current = nextReachable;

      const peer = peerRef.current;
      const peerState = peer?.connectionState ?? "closed";
      const iceState = peer?.iceConnectionState ?? "closed";

      console.log("[NETWORK STATE]", {
        callId,
        event: "network_changed",
        from: {
          type: previousType,
          isConnected: previousConnected,
          isInternetReachable: previousReachable,
        },
        to: {
          type: nextType,
          isConnected: nextConnected,
          isInternetReachable: nextReachable,
        },
        peerConnectionState: peerState,
        iceConnectionState: iceState,
        callStatus: callStatusRef.current,
        timestamp: new Date().toISOString(),
      });

      if (callStatusRef.current === "accepted") {
        void recordCallDiagnostic(
          "network_changed",
          nextConnected === false ||
          nextReachable === false
            ? "warning"
            : "info",
          {
            from: {
              type: previousType,
              isConnected: previousConnected,
              isInternetReachable: previousReachable,
            },
            to: {
              type: nextType,
              isConnected: nextConnected,
              isInternetReachable: nextReachable,
            },
            peerConnectionState: peerState,
            iceConnectionState: iceState,
          }
        );
      }

      const networkUnavailable =
        nextConnected === false || nextReachable === false;

      if (networkUnavailable) {
        if (callStatusRef.current === "accepted") {
          needsAudioRecoveryRef.current = true;
          setConnectionLabel("Reconnecting…");

          console.log("[AUDIO RECOVERY]", {
            callId,
            event: "audio_recovery_marked_network_loss",
            type: nextType,
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      const networkAvailable =
        nextConnected === true && nextReachable === true;

      if (
        typeChanged &&
        callStatusRef.current === "accepted"
      ) {
        needsAudioRecoveryRef.current = true;

        console.log("[AUDIO RECOVERY]", {
          callId,
          event: "audio_recovery_marked_network_handoff",
          fromType: previousType,
          toType: nextType,
          timestamp: new Date().toISOString(),
        });
      }

      const peerDegraded =
        peerState === "disconnected" ||
        peerState === "failed" ||
        iceState === "disconnected" ||
        iceState === "failed";

      if (
        !networkAvailable ||
        !peerDegraded ||
        callStatusRef.current !== "accepted" ||
        !isCaller ||
        !requestIceRestartRef.current
      ) {
        return;
      }

      const now = Date.now();

      if (now - lastNetworkRecoveryAtRef.current < 2500) {
        console.log("[NETWORK RECOVERY]", {
          callId,
          event: "network_restart_ignored_duplicate",
          type: nextType,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      lastNetworkRecoveryAtRef.current = now;

      console.log("[NETWORK RECOVERY]", {
        callId,
        event: "network_recovery_requested",
        type: nextType,
        peerConnectionState: peerState,
        iceConnectionState: iceState,
        timestamp: new Date().toISOString(),
      });

      requestIceRestartRef.current();
    });

    return () => {
      subscription.remove();
    };
  }, [callId, isCaller]);

  useEffect(() => {
    const shouldPlayRingback = Boolean(
      call && isCaller && call.status === "ringing"
    );

    let cancelled = false;
    let repeatTimer: ReturnType<typeof setInterval> | null = null;

    const playCadence = async () => {
      if (cancelled) {
        return;
      }

      try {
        // outgoing-ringback.wav is one complete 6-second cadence:
        // 2 seconds audible + 4 seconds silence.
        await ringbackPlayer.seekTo(0).catch(() => undefined);

        if (!cancelled) {
          ringbackPlayer.play();
        }
      } catch (error) {
        console.warn(
          "Could not play outgoing ringback:",
          error instanceof Error ? error.message : error
        );
      }
    };

    if (shouldPlayRingback) {
      ringbackPlayer.loop = false;
      ringbackPlayer.volume = 0.42;

      void playCadence();

      // Explicit JavaScript-controlled repeat every 6 seconds.
      repeatTimer = setInterval(() => {
        void playCadence();
      }, 6000);
    }

    // IMPORTANT:
    // When ringing ends because the call was answered, do not call pause()
    // or seekTo() here. On iOS that can interfere with the shared audio
    // session exactly when WebRTC/InCallManager is taking control, leaving
    // the connected call silent. Stopping the repeat timer is enough.

    return () => {
      cancelled = true;

      if (repeatTimer) {
        clearInterval(repeatTimer);
      }

      // Do not pause/release here. useAudioPlayer owns the native
      // lifecycle and auto-disposes the player on unmount.
    };
  }, [
    call?.status,
    isCaller,
    ringbackPlayer,
  ]);

  useEffect(() => {
    if (!call || call.status !== "ringing" || !isCaller) {
      if (unansweredTimerRef.current) {
        clearTimeout(unansweredTimerRef.current);
        unansweredTimerRef.current = null;
      }
      return;
    }

    const expiryTime = call.expires_at
      ? new Date(call.expires_at).getTime()
      : new Date(call.created_at).getTime() +
        UNANSWERED_TIMEOUT_MS;

    const remaining = Math.max(
      0,
      expiryTime - Date.now()
    );

    unansweredTimerRef.current = setTimeout(
      () => {
        // Re-read the row before marking missed so an answer/decline that
        // wins the race at the timeout boundary is never overwritten.
        void finishMissedIfStillRinging("unanswered");
      },
      remaining
    );

    return () => {
      if (unansweredTimerRef.current) {
        clearTimeout(unansweredTimerRef.current);
        unansweredTimerRef.current = null;
      }
    };
  }, [
    call,
    finishMissedIfStillRinging,
    isCaller,
  ]);

  useEffect(() => {
    if (!callId || !user) return;

    const callChannel = supabase
      .channel(`call-${callId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "calls",
          filter: `id=eq.${callId}`,
        },
        async (payload) => {
          const updated = payload.new as VoiceCall;
          setCall(updated);

          if (
            updated.status === "accepted" &&
            updated.offer &&
            updated.callee_id === user.id
          ) {
            await handleRemoteIceRestartOffer(
              updated.offer as Record<string, unknown>,
            );
          }

          if (
            updated.status === "accepted" &&
            updated.answer &&
            updated.caller_id === user.id
          ) {
            await applyRemoteAnswer(updated.answer);
          }

          // Supabase is the authoritative lifecycle state. Once the call is
          // accepted, keep the UI synchronized even if a WebRTC connection
          // callback is delayed on one device. Hold messaging is rendered
          // separately from connectionLabel.
          if (updated.status === "accepted") {
            setConnectionLabel("Connected");
          }

          if (isTerminalCallStatus(updated.status)) {
            if (completeNativeHandoffCleanup()) {
              return;
            }

            cleanupMedia();
            endNativeCall(
              callId,
              updated.status === "missed"
                ? CALLKIT_END_REASONS.MISSED
                : updated.status === "failed"
                  ? CALLKIT_END_REASONS.FAILED
                  : updated.status === "declined"
                    ? CALLKIT_END_REASONS.DECLINED_ELSEWHERE
                    : CALLKIT_END_REASONS.REMOTE_ENDED,
            );
            setConnectionLabel(
              terminalCallLabel(
                updated.status,
                updated.end_reason
              )
            );
            if (terminalNavigationTimerRef.current) {
              clearTimeout(terminalNavigationTimerRef.current);
            }

            terminalNavigationTimerRef.current = setTimeout(() => {
              terminalNavigationTimerRef.current = null;
              void closeCurrentCallScreen();
            }, 650);
          }
        },
      )
      .on(
        "broadcast",
        { event: "camera-state" },
        ({ payload }) => {
          if (payload?.user_id === user.id) return;
          setRemoteVideoAvailable(
            payload?.enabled !== false
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "call_ice_candidates",
          filter: `call_id=eq.${callId}`,
        },
        (payload) => {
          const row = payload.new as {
            user_id: string;
            candidate: Record<string, unknown>;
          };
          if (row.user_id !== user.id) void addRemoteCandidate(row.candidate);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          callChannelRef.current = callChannel;

          if (isVideoCall) {
            void callChannel.send({
              type: "broadcast",
              event: "camera-state",
              payload: {
                user_id: user.id,
                enabled: cameraEnabled,
              },
            });
          }
        }
      });

    void syncRemoteCandidates();

    const recoveryTimer = setInterval(() => {
      void syncRemoteCandidates();

      if (
        isCaller &&
        (
          !answerAppliedRef.current ||
          peerRef.current?.signalingState === "have-local-offer"
        )
      ) {
        void supabase
          .from("calls")
          .select("answer, status")
          .eq("id", callId)
          .maybeSingle()
          .then(({ data, error }) => {
            if (error) {
              console.warn("Could not recover remote answer:", error.message);
              return;
            }

            if (data?.status === "accepted" && data?.answer) {
              void applyRemoteAnswer(data.answer as Record<string, unknown>);
            }
          });
      }
    }, 1200);

    return () => {
      clearInterval(recoveryTimer);
      if (callChannelRef.current === callChannel) {
        callChannelRef.current = null;
      }
      supabase.removeChannel(callChannel);
    };
  }, [
    addRemoteCandidate,
    applyRemoteAnswer,
    handleRemoteIceRestartOffer,
    callId,
    cleanupMedia,
    cameraEnabled,
    isCaller,
    isVideoCall,
    syncRemoteCandidates,
    user,
  ]);

  useEffect(() => {
    if (call?.status !== "accepted") return;
    const started = call.answered_at
      ? new Date(call.answered_at).getTime()
      : Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [call?.answered_at, call?.status]);

  useEffect(() => {
    if (
      !callId ||
      !call ||
      !user ||
      call.status !== "accepted"
    ) {
      return;
    }

    const observedUserId =
      call.caller_id === user.id
        ? call.callee_id
        : call.caller_id;

    let cancelled = false;
    let sampleInFlight = false;

    const samplePeerLiveness = async () => {
      if (cancelled || sampleInFlight) {
        return;
      }

      sampleInFlight = true;

      try {
        const peer = peerRef.current;

        if (
          !peer ||
          peer.connectionState === "closed" ||
          isTerminalCallStatus(callStatusRef.current ?? "")
        ) {
          return;
        }

        const reports = await peer.getStats();
        let inboundPackets = 0;

        reports?.forEach((report: any) => {
          if (
            report.type === "inbound-rtp" &&
            !report.isRemote
          ) {
            inboundPackets +=
              Number(report.packetsReceived ?? 0);
          }
        });

        const previousPackets =
          lastInboundPacketsRef.current;

        lastInboundPacketsRef.current =
          inboundPackets;

        const receivedNewMedia =
          previousPackets < 0
            ? inboundPackets > 0
            : inboundPackets > previousPackets;

        const now = Date.now();

        if (
          receivedNewMedia &&
          now - lastPeerLivenessWriteAtRef.current >=
            PEER_LIVENESS_WRITE_MIN_MS
        ) {
          const { error } = await supabase.rpc(
            "touch_call_peer_liveness",
            {
              requested_call_id: callId,
              observed_user_id: observedUserId,
            }
          );

          if (error) {
            console.warn(
              "[CALL LIVENESS] peer_touch_failed",
              error.message
            );
          } else {
            lastPeerLivenessWriteAtRef.current =
              now;

            console.log("[CALL LIVENESS]", {
              callId,
              event: "peer_media_observed",
              observedUserId,
              inboundPackets,
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (
          now - lastStaleAcceptedCheckAtRef.current >=
            STALE_ACCEPTED_CHECK_MS
        ) {
          lastStaleAcceptedCheckAtRef.current =
            now;

          const {
            data: expired,
            error: expireError,
          } = await supabase.rpc(
            "expire_stale_accepted_call",
            {
              requested_call_id: callId,
            }
          );

          if (expireError) {
            console.warn(
              "[CALL LIVENESS] stale_check_failed",
              expireError.message
            );
          } else if (expired === true) {
            console.warn("[CALL LIVENESS]", {
              callId,
              event: "stale_accepted_call_expired",
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (error) {
        // Liveness is a backstop only. A stats/RPC problem must never tear
        // down an otherwise healthy call.
        console.warn(
          "[CALL LIVENESS] sample_failed",
          error instanceof Error
            ? error.message
            : String(error)
        );
      } finally {
        sampleInFlight = false;
      }
    };

    void samplePeerLiveness();

    const timer = setInterval(
      samplePeerLiveness,
      PEER_LIVENESS_SAMPLE_MS
    );

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    call?.callee_id,
    call?.caller_id,
    call?.status,
    callId,
    user,
  ]);

  useEffect(() => {
    if (call?.status !== "accepted") {
      lastJsHeartbeatAtRef.current = Date.now();
      return;
    }

    lastJsHeartbeatAtRef.current = Date.now();

    const timer = setInterval(() => {
      lastJsHeartbeatAtRef.current = Date.now();
    }, JS_HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [call?.status, callId]);

  useEffect(() => {
    let resumeReconcileInFlight = false;

    const reconcileOnResume = async (
      previousLifecycleState: string,
      backgroundDurationMs: number | null,
      suspensionGapMs: number | null,
      backgroundNetwork: {
        type: string | null;
        isConnected: boolean | null;
        isInternetReachable: boolean | null;
      } | null
    ) => {
      if (!callId || resumeReconcileInFlight) {
        return;
      }

      resumeReconcileInFlight = true;

      try {
        const networkState =
          await Network.getNetworkStateAsync().catch(
            () => null
          );

        const resumedNetwork = networkState
          ? {
              type: String(
                networkState.type ?? "unknown"
              ),
              isConnected:
                networkState.isConnected ?? null,
              isInternetReachable:
                networkState.isInternetReachable ?? null,
            }
          : {
              type: lastNetworkTypeRef.current,
              isConnected:
                lastNetworkConnectedRef.current,
              isInternetReachable:
                lastNetworkReachableRef.current,
            };

        const backgroundNetworkChanged = Boolean(
          backgroundNetwork &&
          (
            backgroundNetwork.type !== resumedNetwork.type ||
            backgroundNetwork.isConnected !==
              resumedNetwork.isConnected ||
            backgroundNetwork.isInternetReachable !==
              resumedNetwork.isInternetReachable
          )
        );

        lastNetworkTypeRef.current =
          resumedNetwork.type;
        lastNetworkConnectedRef.current =
          resumedNetwork.isConnected;
        lastNetworkReachableRef.current =
          resumedNetwork.isInternetReachable;

        if (
          backgroundNetworkChanged &&
          callStatusRef.current === "accepted"
        ) {
          lifecycleSummaryRef.current.backgroundNetworkChangeCount += 1;
          lifecycleSummaryRef.current.lastNetworkFrom =
            backgroundNetwork?.type ?? null;
          lifecycleSummaryRef.current.lastNetworkTo =
            resumedNetwork.type ?? null;

          console.log("[BACKGROUND NETWORK]", {
            callId,
            event: "background_network_change_detected",
            from: backgroundNetwork,
            to: resumedNetwork,
            backgroundDurationMs,
            suspensionGapMs,
            peerConnectionState:
              peerRef.current?.connectionState ?? null,
            iceConnectionState:
              peerRef.current?.iceConnectionState ?? null,
            timestamp: new Date().toISOString(),
          });

          void recordCallDiagnostic(
            "background_network_change_detected",
            "warning",
            {
              from: backgroundNetwork,
              to: resumedNetwork,
              backgroundDurationMs,
              suspensionGapMs,
              peerConnectionState:
                peerRef.current?.connectionState ?? null,
              iceConnectionState:
                peerRef.current?.iceConnectionState ?? null,
            }
          );

          needsAudioRecoveryRef.current = true;
        }

        // Backgrounding by itself never triggers recovery. We first reconcile
        // Supabase, then inspect the actual network + WebRTC state.
        await expireStaleCalls();

        const { error: staleAcceptedError } =
          await supabase.rpc(
            "expire_stale_accepted_call",
            {
              requested_call_id: callId,
            }
          );

        if (staleAcceptedError) {
          console.warn(
            "[CALL LIVENESS] resume_stale_check_failed",
            staleAcceptedError.message
          );
        }

        const { data, error } = await supabase
          .from("calls")
          .select("*")
          .eq("id", callId)
          .maybeSingle();

        if (error) {
          console.warn(
            "[CALL RECONCILE] resume_read_failed",
            error.message
          );
          return;
        }

        if (!data) {
          console.warn("[CALL RECONCILE]", {
            callId,
            event: "resume_call_missing",
            timestamp: new Date().toISOString(),
          });

          cleanupMedia();
          endNativeCall(
            callId,
            CALLKIT_END_REASONS.REMOTE_ENDED
          );
          void closeCurrentCallScreen();
          return;
        }

        const authoritativeCall = data as VoiceCall;

        console.log("[CALL RECONCILE]", {
          callId,
          event: "app_resume_reconciled",
          previousLifecycleState,
          backgroundDurationMs,
          suspensionGapMs,
          backgroundNetwork,
          resumedNetwork,
          backgroundNetworkChanged,
          localStatus: callStatusRef.current,
          authoritativeStatus: authoritativeCall.status,
          endReason: authoritativeCall.end_reason ?? null,
          networkType:
            lastNetworkTypeRef.current ?? "unknown",
          isConnected:
            lastNetworkConnectedRef.current,
          isInternetReachable:
            lastNetworkReachableRef.current,
          timestamp: new Date().toISOString(),
        });

        setCall(authoritativeCall);

        if (isTerminalCallStatus(authoritativeCall.status)) {
          if (completeNativeHandoffCleanup()) {
            return;
          }
          if (!lifecycleSummaryWrittenRef.current) {
            lifecycleSummaryWrittenRef.current = true;

            const summary = {
              ...lifecycleSummaryRef.current,
              finalStatus: authoritativeCall.status,
              finalReason:
                authoritativeCall.end_reason ?? null,
              finalNetworkType:
                lastNetworkTypeRef.current ?? "unknown",
              finalPeerConnectionState:
                peerRef.current?.connectionState ?? "closed",
              finalIceConnectionState:
                peerRef.current?.iceConnectionState ?? "closed",
              finalQuality:
                lastQualitySnapshotRef.current,
              hadLifecycleActivity:
                lifecycleSummaryRef.current.backgroundCount > 0 ||
                lifecycleSummaryRef.current.jsSuspensionCount > 0 ||
                lifecycleSummaryRef.current.backgroundNetworkChangeCount > 0 ||
                lifecycleSummaryRef.current.recoveryRequiredCount > 0,
            };

            console.log("[CALL LIFECYCLE SUMMARY]", {
              callId,
              event: "lifecycle_summary",
              ...summary,
              timestamp: new Date().toISOString(),
            });

            void recordCallDiagnostic(
              "lifecycle_summary",
              authoritativeCall.status === "failed"
                ? "warning"
                : "info",
              summary
            );
          }

          cleanupMedia();

          endNativeCall(
            callId,
            authoritativeCall.status === "missed"
              ? CALLKIT_END_REASONS.MISSED
              : authoritativeCall.status === "failed"
                ? CALLKIT_END_REASONS.FAILED
                : authoritativeCall.status === "declined"
                  ? CALLKIT_END_REASONS.DECLINED_ELSEWHERE
                  : CALLKIT_END_REASONS.REMOTE_ENDED
          );

          setConnectionLabel(
            terminalCallLabel(
              authoritativeCall.status,
              authoritativeCall.end_reason
            )
          );

          console.log("[CALL RECONCILE]", {
            callId,
            event: "terminal_cleanup_applied",
            status: authoritativeCall.status,
            endReason: authoritativeCall.end_reason ?? null,
            timestamp: new Date().toISOString(),
          });

          void recordCallDiagnostic(
            "lifecycle_resumed_terminal",
            "info",
            {
              previousLifecycleState,
              backgroundDurationMs,
              status: authoritativeCall.status,
              endReason:
                authoritativeCall.end_reason ?? null,
            }
          );

          if (terminalNavigationTimerRef.current) {
            clearTimeout(terminalNavigationTimerRef.current);
          }

          terminalNavigationTimerRef.current = setTimeout(() => {
            terminalNavigationTimerRef.current = null;
            void closeCurrentCallScreen();
          }, 650);

          return;
        }

        // If the call is still active, resume normal candidate/answer sync.
        await syncRemoteCandidates();

        if (
          authoritativeCall.status === "accepted" &&
          authoritativeCall.answer &&
          authoritativeCall.caller_id === user?.id
        ) {
          await applyRemoteAnswer(
            authoritativeCall.answer as Record<string, unknown>
          );
        }

        if (authoritativeCall.status !== "accepted") {
          return;
        }

        const peer = peerRef.current;
        const peerState =
          peer?.connectionState ?? "closed";
        const iceState =
          peer?.iceConnectionState ?? "closed";

        const networkHealthy =
          lastNetworkConnectedRef.current !== false &&
          lastNetworkReachableRef.current !== false;

        const peerHealthy =
          peerState === "connected" &&
          (
            iceState === "connected" ||
            iceState === "completed"
          );

        if (networkHealthy && peerHealthy) {
          console.log("[CALL LIFECYCLE]", {
            callId,
            event: "resumed_connected",
            backgroundDurationMs,
            peerConnectionState: peerState,
            iceConnectionState: iceState,
            networkType:
              lastNetworkTypeRef.current ?? "unknown",
            timestamp: new Date().toISOString(),
          });

          void recordCallDiagnostic(
            "lifecycle_resumed_connected",
            "info",
            {
              backgroundDurationMs,
              peerConnectionState: peerState,
              iceConnectionState: iceState,
              networkType:
                lastNetworkTypeRef.current ?? "unknown",
            }
          );

          if (lifecycleAudioRestoreTimerRef.current) {
            clearTimeout(
              lifecycleAudioRestoreTimerRef.current
            );
          }

          lifecycleAudioRestoreTimerRef.current =
            setTimeout(() => {
              lifecycleAudioRestoreTimerRef.current = null;

              const activePeer = peerRef.current;

              if (
                callStatusRef.current !== "accepted" ||
                !activePeer ||
                activePeer.connectionState !== "connected" ||
                !(
                  activePeer.iceConnectionState === "connected" ||
                  activePeer.iceConnectionState === "completed"
                )
              ) {
                return;
              }

              try {
                const mediaType =
                  authoritativeCall.call_type === "video"
                    ? "video"
                    : "audio";

                InCallManager.start({
                  media: mediaType,
                  auto: true,
                });
                InCallManager.setKeepScreenOn(true);
                InCallManager.setForceSpeakerphoneOn(
                  speakerOnRef.current
                );

                if (!remoteOnHold) {
                  remoteStreamRef.current
                    ?.getAudioTracks()
                    .forEach((track) => {
                      track.enabled = true;
                    });
                }

                lifecycleSummaryRef.current.unlockAudioRestoreCount += 1;

                console.log("[CALL LOCK]", {
                  callId,
                  event: "unlock_audio_route_restored",
                  backgroundDurationMs,
                  media: mediaType,
                  speakerOn: speakerOnRef.current,
                  remoteAudioTracks:
                    remoteStreamRef.current
                      ?.getAudioTracks().length ?? 0,
                  timestamp: new Date().toISOString(),
                });

                void recordCallDiagnostic(
                  "lifecycle_unlock_audio_restored",
                  "info",
                  {
                    backgroundDurationMs,
                    media: mediaType,
                    speakerOn: speakerOnRef.current,
                    remoteAudioTracks:
                      remoteStreamRef.current
                        ?.getAudioTracks().length ?? 0,
                  }
                );
              } catch (error) {
                console.warn("[CALL LOCK]", {
                  callId,
                  event: "unlock_audio_route_restore_failed",
                  error:
                    error instanceof Error
                      ? error.message
                      : String(error),
                  timestamp: new Date().toISOString(),
                });

                void recordCallDiagnostic(
                  "lifecycle_unlock_audio_restore_failed",
                  "warning",
                  {
                    backgroundDurationMs,
                    error:
                      error instanceof Error
                        ? error.message
                        : String(error),
                  }
                );
              }
            }, 350);

          if (
            suspensionGapMs !== null &&
            suspensionGapMs >= JS_SUSPENSION_GAP_MS
          ) {
            if (postSuspensionVerifyTimerRef.current) {
              clearTimeout(
                postSuspensionVerifyTimerRef.current
              );
            }

            postSuspensionVerifyTimerRef.current =
              setTimeout(() => {
                postSuspensionVerifyTimerRef.current = null;

                void (async () => {
                  await syncRemoteCandidates();

                  const resumedPeer = peerRef.current;
                  const resumedPeerState =
                    resumedPeer?.connectionState ?? "closed";
                  const resumedIceState =
                    resumedPeer?.iceConnectionState ?? "closed";

                  const resumedNetworkHealthy =
                    lastNetworkConnectedRef.current !== false &&
                    lastNetworkReachableRef.current !== false;

                  const resumedPeerHealthy =
                    resumedPeerState === "connected" &&
                    (
                      resumedIceState === "connected" ||
                      resumedIceState === "completed"
                    );

                  if (
                    callStatusRef.current === "accepted" &&
                    resumedNetworkHealthy &&
                    resumedPeerHealthy
                  ) {
                    console.log("[CALL SUSPENSION]", {
                      callId,
                      event: "js_suspension_recovered",
                      suspensionGapMs,
                      backgroundDurationMs,
                      peerConnectionState:
                        resumedPeerState,
                      iceConnectionState:
                        resumedIceState,
                      networkType:
                        lastNetworkTypeRef.current ?? "unknown",
                      timestamp: new Date().toISOString(),
                    });

                    void recordCallDiagnostic(
                      "js_suspension_recovered",
                      "info",
                      {
                        suspensionGapMs,
                        backgroundDurationMs,
                        peerConnectionState:
                          resumedPeerState,
                        iceConnectionState:
                          resumedIceState,
                        networkType:
                          lastNetworkTypeRef.current ?? "unknown",
                      }
                    );

                    return;
                  }

                  if (callStatusRef.current !== "accepted") {
                    return;
                  }

                  lifecycleSummaryRef.current.recoveryRequiredCount += 1;

                  console.warn("[CALL SUSPENSION]", {
                    callId,
                    event: "js_suspension_recovery_required",
                    suspensionGapMs,
                    backgroundDurationMs,
                    peerConnectionState:
                      resumedPeerState,
                    iceConnectionState:
                      resumedIceState,
                    networkType:
                      lastNetworkTypeRef.current ?? "unknown",
                    isConnected:
                      lastNetworkConnectedRef.current,
                    isInternetReachable:
                      lastNetworkReachableRef.current,
                    timestamp: new Date().toISOString(),
                  });

                  void recordCallDiagnostic(
                    "js_suspension_recovery_required",
                    "warning",
                    {
                      suspensionGapMs,
                      backgroundDurationMs,
                      peerConnectionState:
                        resumedPeerState,
                      iceConnectionState:
                        resumedIceState,
                      networkType:
                        lastNetworkTypeRef.current ?? "unknown",
                      isConnected:
                        lastNetworkConnectedRef.current,
                      isInternetReachable:
                        lastNetworkReachableRef.current,
                    }
                  );

                  needsAudioRecoveryRef.current = true;
                  setConnectionLabel("Reconnecting…");

                  const resumedPeerDegraded =
                    resumedPeerState === "disconnected" ||
                    resumedPeerState === "failed" ||
                    resumedIceState === "disconnected" ||
                    resumedIceState === "failed";

                  if (
                    resumedNetworkHealthy &&
                    resumedPeerDegraded &&
                    isCaller &&
                    requestIceRestartRef.current
                  ) {
                    requestIceRestartRef.current();
                  }
                })();
              }, POST_SUSPENSION_VERIFY_MS);
          }

          if (backgroundNetworkChanged) {
            if (backgroundNetworkVerifyTimerRef.current) {
              clearTimeout(
                backgroundNetworkVerifyTimerRef.current
              );
            }

            backgroundNetworkVerifyTimerRef.current =
              setTimeout(() => {
                backgroundNetworkVerifyTimerRef.current = null;

                void (async () => {
                  const latestNetwork =
                    await Network.getNetworkStateAsync().catch(
                      () => null
                    );

                  if (latestNetwork) {
                    lastNetworkTypeRef.current = String(
                      latestNetwork.type ?? "unknown"
                    );
                    lastNetworkConnectedRef.current =
                      latestNetwork.isConnected ?? null;
                    lastNetworkReachableRef.current =
                      latestNetwork.isInternetReachable ?? null;
                  }

                  await syncRemoteCandidates();

                  const activePeer = peerRef.current;
                  const activePeerState =
                    activePeer?.connectionState ?? "closed";
                  const activeIceState =
                    activePeer?.iceConnectionState ?? "closed";

                  const activeNetworkHealthy =
                    lastNetworkConnectedRef.current !== false &&
                    lastNetworkReachableRef.current !== false;

                  const activePeerHealthy =
                    activePeerState === "connected" &&
                    (
                      activeIceState === "connected" ||
                      activeIceState === "completed"
                    );

                  if (
                    callStatusRef.current === "accepted" &&
                    activeNetworkHealthy &&
                    activePeerHealthy
                  ) {
                    console.log("[BACKGROUND NETWORK]", {
                      callId,
                      event: "background_network_change_survived",
                      from: backgroundNetwork,
                      to: {
                        type:
                          lastNetworkTypeRef.current ?? "unknown",
                        isConnected:
                          lastNetworkConnectedRef.current,
                        isInternetReachable:
                          lastNetworkReachableRef.current,
                      },
                      peerConnectionState:
                        activePeerState,
                      iceConnectionState:
                        activeIceState,
                      timestamp: new Date().toISOString(),
                    });

                    void recordCallDiagnostic(
                      "background_network_change_survived",
                      "info",
                      {
                        from: backgroundNetwork,
                        to: {
                          type:
                            lastNetworkTypeRef.current ?? "unknown",
                          isConnected:
                            lastNetworkConnectedRef.current,
                          isInternetReachable:
                            lastNetworkReachableRef.current,
                        },
                        peerConnectionState:
                          activePeerState,
                        iceConnectionState:
                          activeIceState,
                        quality:
                          lastQualitySnapshotRef.current,
                      }
                    );

                    return;
                  }

                  if (callStatusRef.current !== "accepted") {
                    return;
                  }

                  lifecycleSummaryRef.current.recoveryRequiredCount += 1;

                  console.warn("[BACKGROUND NETWORK]", {
                    callId,
                    event: "background_network_change_recovery_required",
                    from: backgroundNetwork,
                    to: {
                      type:
                        lastNetworkTypeRef.current ?? "unknown",
                      isConnected:
                        lastNetworkConnectedRef.current,
                      isInternetReachable:
                        lastNetworkReachableRef.current,
                    },
                    peerConnectionState:
                      activePeerState,
                    iceConnectionState:
                      activeIceState,
                    timestamp: new Date().toISOString(),
                  });

                  void recordCallDiagnostic(
                    "background_network_change_recovery_required",
                    "warning",
                    {
                      from: backgroundNetwork,
                      to: {
                        type:
                          lastNetworkTypeRef.current ?? "unknown",
                        isConnected:
                          lastNetworkConnectedRef.current,
                        isInternetReachable:
                          lastNetworkReachableRef.current,
                      },
                      peerConnectionState:
                        activePeerState,
                      iceConnectionState:
                        activeIceState,
                    }
                  );

                  needsAudioRecoveryRef.current = true;
                  setConnectionLabel("Reconnecting…");

                  const activePeerDegraded =
                    activePeerState === "disconnected" ||
                    activePeerState === "failed" ||
                    activeIceState === "disconnected" ||
                    activeIceState === "failed";

                  if (
                    activeNetworkHealthy &&
                    activePeerDegraded &&
                    isCaller &&
                    requestIceRestartRef.current
                  ) {
                    requestIceRestartRef.current();
                  }
                })();
              }, BACKGROUND_NETWORK_VERIFY_MS);
          }

          return;
        }

        lifecycleSummaryRef.current.recoveryRequiredCount += 1;

        console.warn("[CALL LIFECYCLE]", {
          callId,
          event: "resumed_recovery_required",
          backgroundDurationMs,
          peerConnectionState: peerState,
          iceConnectionState: iceState,
          networkType:
            lastNetworkTypeRef.current ?? "unknown",
          isConnected:
            lastNetworkConnectedRef.current,
          isInternetReachable:
            lastNetworkReachableRef.current,
          timestamp: new Date().toISOString(),
        });

        void recordCallDiagnostic(
          "lifecycle_resumed_recovery_required",
          "warning",
          {
            backgroundDurationMs,
            peerConnectionState: peerState,
            iceConnectionState: iceState,
            networkType:
              lastNetworkTypeRef.current ?? "unknown",
            isConnected:
              lastNetworkConnectedRef.current,
            isInternetReachable:
              lastNetworkReachableRef.current,
          }
        );

        setConnectionLabel("Reconnecting…");
        needsAudioRecoveryRef.current = true;

        // Recovery is evidence-driven: only ask for an ICE restart when
        // network is available AND WebRTC is actually degraded.
        const peerDegraded =
          peerState === "disconnected" ||
          peerState === "failed" ||
          iceState === "disconnected" ||
          iceState === "failed";

        if (
          networkHealthy &&
          peerDegraded &&
          isCaller &&
          requestIceRestartRef.current
        ) {
          requestIceRestartRef.current();
        }
      } finally {
        resumeReconcileInFlight = false;
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      (nextState) => {
        const previousState =
          lifecycleStateRef.current;

        lifecycleStateRef.current = nextState;

        if (
          previousState === nextState
        ) {
          return;
        }

        if (
          nextState === "background" ||
          nextState === "inactive"
        ) {
          if (backgroundedAtRef.current === null) {
            backgroundedAtRef.current = Date.now();

            lifecycleSummaryRef.current.backgroundCount += 1;
            lifecycleSummaryRef.current.firstBackgroundAt ??=
              new Date().toISOString();

            backgroundNetworkSnapshotRef.current = {
              type: lastNetworkTypeRef.current,
              isConnected:
                lastNetworkConnectedRef.current,
              isInternetReachable:
                lastNetworkReachableRef.current,
            };
          }

          if (callStatusRef.current === "accepted") {
            console.log("[CALL LIFECYCLE]", {
              callId,
              event: "backgrounded",
              from: previousState,
              to: nextState,
              peerConnectionState:
                peerRef.current?.connectionState ?? null,
              iceConnectionState:
                peerRef.current?.iceConnectionState ?? null,
              networkType:
                lastNetworkTypeRef.current ?? "unknown",
              networkSnapshot:
                backgroundNetworkSnapshotRef.current,
              timestamp: new Date().toISOString(),
            });

            void recordCallDiagnostic(
              "lifecycle_backgrounded",
              "info",
              {
                from: previousState,
                to: nextState,
                peerConnectionState:
                  peerRef.current?.connectionState ?? null,
                iceConnectionState:
                  peerRef.current?.iceConnectionState ?? null,
                networkType:
                  lastNetworkTypeRef.current ?? "unknown",
              }
            );

            console.log("[CALL LOCK]", {
              callId,
              event: "lock_or_background_entered",
              from: previousState,
              to: nextState,
              peerConnectionState:
                peerRef.current?.connectionState ?? null,
              iceConnectionState:
                peerRef.current?.iceConnectionState ?? null,
              timestamp: new Date().toISOString(),
            });
          }

          // Important: do not stop media, do not mutate the call row, and do
          // not request ICE recovery simply because the app backgrounded.
          return;
        }

        if (nextState === "active") {
          const now = Date.now();
          const backgroundDurationMs =
            backgroundedAtRef.current === null
              ? null
              : now -
                backgroundedAtRef.current;

          const suspensionGapMs = Math.max(
            0,
            now - lastJsHeartbeatAtRef.current
          );

          lastJsHeartbeatAtRef.current = now;

          lifecycleSummaryRef.current.resumeCount += 1;
          lifecycleSummaryRef.current.lastResumeAt =
            new Date().toISOString();

          if (backgroundDurationMs !== null) {
            lifecycleSummaryRef.current.totalBackgroundMs +=
              backgroundDurationMs;
            lifecycleSummaryRef.current.longestBackgroundMs =
              Math.max(
                lifecycleSummaryRef.current.longestBackgroundMs,
                backgroundDurationMs
              );
          }

          const backgroundNetwork =
            backgroundNetworkSnapshotRef.current;

          backgroundedAtRef.current = null;
          backgroundNetworkSnapshotRef.current = null;

          if (
            callStatusRef.current === "accepted" &&
            suspensionGapMs >= JS_SUSPENSION_GAP_MS
          ) {
            lifecycleSummaryRef.current.jsSuspensionCount += 1;

            console.warn("[CALL SUSPENSION]", {
              callId,
              event: "js_suspension_detected",
              suspensionGapMs,
              backgroundDurationMs,
              from: previousState,
              peerConnectionState:
                peerRef.current?.connectionState ?? null,
              iceConnectionState:
                peerRef.current?.iceConnectionState ?? null,
              timestamp: new Date().toISOString(),
            });

            void recordCallDiagnostic(
              "js_suspension_detected",
              "warning",
              {
                suspensionGapMs,
                backgroundDurationMs,
                from: previousState,
                peerConnectionState:
                  peerRef.current?.connectionState ?? null,
                iceConnectionState:
                  peerRef.current?.iceConnectionState ?? null,
              }
            );
          }

          console.log("[CALL LIFECYCLE]", {
            callId,
            event: "resumed",
            from: previousState,
            backgroundDurationMs,
            suspensionGapMs,
            backgroundNetwork,
            timestamp: new Date().toISOString(),
          });

          if (callStatusRef.current === "accepted") {
            void recordCallDiagnostic(
              "lifecycle_resumed",
              "info",
              {
                from: previousState,
                backgroundDurationMs,
                suspensionGapMs,
                backgroundNetwork,
              }
            );
          }

          void reconcileOnResume(
            previousState,
            backgroundDurationMs,
            suspensionGapMs,
            backgroundNetwork
          );
        }
      }
    );

    return () => subscription.remove();
  }, [
    applyRemoteAnswer,
    callId,
    cleanupMedia,
    isCaller,
    recordCallDiagnostic,
    remoteOnHold,
    syncRemoteCandidates,
    user?.id,
  ]);

  useEffect(() => {
    if (
      call?.status !== "accepted" ||
      !peerRef.current
    ) {
      setNetworkQuality("Unknown");
      return;
    }

    let previousLost = 0;
    let previousReceived = 0;
    let previousBytesReceived = 0;
    let previousBytesSent = 0;
    let previousSampleAt = Date.now();
    let previousPairId: string | null = null;

    const updateQuality = async () => {
      try {
        const peer = peerRef.current;

        if (
          !peer ||
          peer.connectionState === "closed" ||
          isTerminalCallStatus(callStatusRef.current ?? "")
        ) {
          return;
        }

        const stats: any = await peer.getStats();
        const reports: any[] = [];

        if (typeof stats?.forEach === "function") {
          stats.forEach((report: any) =>
            reports.push(report)
          );
        } else if (Array.isArray(stats)) {
          reports.push(...stats);
        }

        const byId = new Map<string, any>();

        for (const report of reports) {
          if (report?.id) {
            byId.set(report.id, report);
          }
        }

        let lost = 0;
        let received = 0;
        let sent = 0;
        let jitterSeconds = 0;
        let inboundAudioPackets = 0;
        let inboundVideoPackets = 0;
        let outboundAudioPackets = 0;
        let outboundVideoPackets = 0;

        for (const report of reports) {
          if (
            report?.type === "inbound-rtp" &&
            !report?.isRemote
          ) {
            const packetsReceived =
              Number(report.packetsReceived ?? 0);

            lost += Number(report.packetsLost ?? 0);
            received += packetsReceived;
            jitterSeconds = Math.max(
              jitterSeconds,
              Number(report.jitter ?? 0)
            );

            if (report.kind === "audio" ||
                report.mediaType === "audio") {
              inboundAudioPackets += packetsReceived;
            }

            if (report.kind === "video" ||
                report.mediaType === "video") {
              inboundVideoPackets += packetsReceived;
            }
          }

          if (
            report?.type === "outbound-rtp" &&
            !report?.isRemote
          ) {
            const packetsSent =
              Number(report.packetsSent ?? 0);

            sent += packetsSent;

            if (report.kind === "audio" ||
                report.mediaType === "audio") {
              outboundAudioPackets += packetsSent;
            }

            if (report.kind === "video" ||
                report.mediaType === "video") {
              outboundVideoPackets += packetsSent;
            }
          }
        }

        let selectedPair: any = reports.find(
          (report) =>
            report?.type === "candidate-pair" &&
            report?.selected === true
        );

        if (!selectedPair) {
          const transport = reports.find(
            (report) =>
              report?.type === "transport" &&
              report?.selectedCandidatePairId
          );

          if (transport?.selectedCandidatePairId) {
            selectedPair = byId.get(
              transport.selectedCandidatePairId
            );
          }
        }

        if (!selectedPair) {
          selectedPair = reports.find(
            (report) =>
              report?.type === "candidate-pair" &&
              report?.state === "succeeded" &&
              report?.nominated === true
          );
        }

        if (!selectedPair) {
          selectedPair = reports.find(
            (report) =>
              report?.type === "candidate-pair" &&
              report?.state === "succeeded"
          );
        }

        const localCandidate =
          selectedPair?.localCandidateId
            ? byId.get(selectedPair.localCandidateId)
            : null;

        const remoteCandidate =
          selectedPair?.remoteCandidateId
            ? byId.get(selectedPair.remoteCandidateId)
            : null;

        const pairId =
          selectedPair?.id ?? null;

        const now = Date.now();
        const elapsedMs = Math.max(
          1,
          now - previousSampleAt
        );

        const bytesReceived = Number(
          selectedPair?.bytesReceived ?? 0
        );
        const bytesSent = Number(
          selectedPair?.bytesSent ?? 0
        );

        // A candidate-pair switch resets byte counters. Do not interpret
        // that reset as zero/negative bitrate.
        const pairChanged =
          previousPairId !== null &&
          pairId !== previousPairId;

        const inboundBitrateKbps =
          !pairChanged &&
          previousBytesReceived > 0 &&
          bytesReceived >= previousBytesReceived
            ? Math.round(
                ((bytesReceived -
                  previousBytesReceived) *
                  8) /
                  elapsedMs
              )
            : null;

        const outboundBitrateKbps =
          !pairChanged &&
          previousBytesSent > 0 &&
          bytesSent >= previousBytesSent
            ? Math.round(
                ((bytesSent -
                  previousBytesSent) *
                  8) /
                  elapsedMs
              )
            : null;

        const lostDelta = Math.max(
          0,
          lost - previousLost
        );
        const receivedDelta = Math.max(
          0,
          received - previousReceived
        );
        const packetTotal =
          lostDelta + receivedDelta;

        const lossRate =
          packetTotal > 0
            ? lostDelta / packetTotal
            : 0;

        const roundTripTimeSeconds =
          Number(
            selectedPair?.currentRoundTripTime ?? 0
          );

        const quality =
          lossRate > 0.08 ||
          jitterSeconds > 0.08 ||
          roundTripTimeSeconds > 0.6
            ? "Poor"
            : lossRate > 0.025 ||
                jitterSeconds > 0.035 ||
                roundTripTimeSeconds > 0.3
              ? "Good"
              : "Excellent";

        setNetworkQuality(quality);

        const qualitySnapshot = {
          quality,
          networkType:
            lastNetworkTypeRef.current ?? "unknown",
          rttMs: Math.round(
            roundTripTimeSeconds * 1000
          ),
          jitterMs: Math.round(
            jitterSeconds * 1000
          ),
          packetLossPct: Number(
            (lossRate * 100).toFixed(2)
          ),
          inboundBitrateKbps,
          outboundBitrateKbps,
          packetsReceived: received,
          packetsSent: sent,
          localCandidateType:
            localCandidate?.candidateType ?? null,
          remoteCandidateType:
            remoteCandidate?.candidateType ?? null,
          localProtocol:
            localCandidate?.protocol ?? null,
          remoteProtocol:
            remoteCandidate?.protocol ?? null,
          usingRelay:
            localCandidate?.candidateType === "relay" ||
            remoteCandidate?.candidateType === "relay",
          peerConnectionState:
            peer.connectionState,
          iceConnectionState:
            peer.iceConnectionState,
        };

        lastQualitySnapshotRef.current =
          qualitySnapshot;

        console.log("[CALL QUALITY]", {
          callId,
          event: "quality_sample",
          quality,
          networkType:
            lastNetworkTypeRef.current ?? "unknown",
          isConnected:
            lastNetworkConnectedRef.current,
          isInternetReachable:
            lastNetworkReachableRef.current,
          rttMs: Math.round(
            roundTripTimeSeconds * 1000
          ),
          jitterMs: Math.round(
            jitterSeconds * 1000
          ),
          packetLossPct: Number(
            (lossRate * 100).toFixed(2)
          ),
          inboundBitrateKbps,
          outboundBitrateKbps,
          packetsReceived: received,
          packetsSent: sent,
          inboundAudioPackets,
          inboundVideoPackets,
          outboundAudioPackets,
          outboundVideoPackets,
          ice: {
            localCandidateType:
              localCandidate?.candidateType ?? null,
            remoteCandidateType:
              remoteCandidate?.candidateType ?? null,
            localProtocol:
              localCandidate?.protocol ?? null,
            remoteProtocol:
              remoteCandidate?.protocol ?? null,
            usingRelay:
              localCandidate?.candidateType === "relay" ||
              remoteCandidate?.candidateType === "relay",
          },
          peerConnectionState:
            peer.connectionState,
          iceConnectionState:
            peer.iceConnectionState,
          timestamp: new Date().toISOString(),
        });

        previousLost = lost;
        previousReceived = received;
        previousBytesReceived = bytesReceived;
        previousBytesSent = bytesSent;
        previousSampleAt = now;
        previousPairId = pairId;
      } catch (error) {
        setNetworkQuality("Unknown");

        console.warn("[CALL QUALITY]", {
          callId,
          event: "quality_sample_failed",
          error:
            error instanceof Error
              ? error.message
              : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    };

    void updateQuality();

    const timer = setInterval(
      updateQuality,
      4000
    );

    return () => clearInterval(timer);
  }, [call?.status, callId]);

  useEffect(() => {
    return () => {
      if (terminalNavigationTimerRef.current) {
        clearTimeout(terminalNavigationTimerRef.current);
        terminalNavigationTimerRef.current = null;
      }

      cleanupMedia();
    };
  }, [cleanupMedia]);

  useEffect(() => {
    if (!isVideoCall) {
      return;
    }

    const videoSender = peerRef.current
      ?.getSenders()
      .find(
        (sender: any) =>
          sender.track?.kind === "video"
      );

    if (!videoSender?.getParameters) {
      return;
    }

    const applyQuality = async () => {
      try {
        const parameters =
          videoSender.getParameters();

        parameters.encodings =
          (parameters.encodings?.length
            ? parameters.encodings
            : [{}]) as any;

        parameters.encodings[0].maxBitrate =
          networkQuality === "Poor"
            ? 280_000
            : networkQuality === "Good"
              ? 650_000
              : 1_200_000;

        await videoSender.setParameters(
          parameters
        );
      } catch (error) {
        console.warn(
          "Could not adjust video quality:",
          error
        );
      }
    };

    void applyQuality();
  }, [isVideoCall, networkQuality]);

  useEffect(() => {
    if (call?.status !== "accepted") {
      return;
    }

    // Hold pauses outgoing media without changing the user's mute/camera
    // preferences. Resume restores those preferences automatically.
    localStreamRef.current
      ?.getAudioTracks()
      .forEach((track) => {
        track.enabled = !localOnHold && !muted;
      });

    localStreamRef.current
      ?.getVideoTracks()
      .forEach((track) => {
        track.enabled = !localOnHold && cameraEnabled;
      });
  }, [call?.status, cameraEnabled, localOnHold, muted]);

  const toggleHold = useCallback(async () => {
    if (!callId || !call || call.status !== "accepted" || holdUpdating) {
      return;
    }

    const next = !localOnHold;
    const holdColumn = isCaller ? "caller_on_hold" : "callee_on_hold";

    setHoldUpdating(true);

    try {
      const { data, error } = await supabase
        .from("calls")
        .update({ [holdColumn]: next })
        .eq("id", callId)
        .eq("status", "accepted")
        .select("id, caller_on_hold, callee_on_hold, status")
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        setConnectionLabel("Call no longer active");
        return;
      }

      // Update immediately; Realtime will deliver the same state to both sides.
      setCall((current) =>
        current
          ? {
              ...current,
              caller_on_hold: Boolean(data.caller_on_hold),
              callee_on_hold: Boolean(data.callee_on_hold),
            }
          : current
      );
    } catch (error) {
      Alert.alert(
        "Hold unavailable",
        error instanceof Error
          ? error.message
          : "Could not update the hold state."
      );
    } finally {
      setHoldUpdating(false);
    }
  }, [call, callId, holdUpdating, isCaller, localOnHold]);

  const declineWaitingCall = useCallback(async () => {
    if (!waitingCall || waitingActionBusy) {
      return;
    }

    setWaitingActionBusy(true);

    try {
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from("calls")
        .update({
          status: "declined",
          end_reason: "declined_call_waiting",
          ended_at: nowIso,
          last_state_changed_at: nowIso,
        })
        .eq("id", waitingCall.call.id)
        .eq("status", "ringing")
        .select("id")
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (data) {
        await finishVoiceCall(
          waitingCall.call.id,
          "declined",
          "declined_call_waiting"
        );
      }

      clearWaitingCall(waitingCall.call.id);
      setWaitingCall(null);
    } catch (error) {
      Alert.alert(
        "Call waiting",
        error instanceof Error
          ? error.message
          : "Could not decline the waiting call."
      );
    } finally {
      setWaitingActionBusy(false);
    }
  }, [waitingActionBusy, waitingCall]);

  const holdAndAnswerWaitingCall = useCallback(async () => {
    if (
      !waitingCall ||
      !callId ||
      !call ||
      !user ||
      call.status !== "accepted" ||
      waitingActionBusy
    ) {
      return;
    }

    setWaitingActionBusy(true);

    try {
      const holdColumn =
        call.caller_id === user.id
          ? "caller_on_hold"
          : "callee_on_hold";

      const { data, error } = await supabase
        .from("calls")
        .update({ [holdColumn]: true })
        .eq("id", callId)
        .eq("status", "accepted")
        .select("id, caller_on_hold, callee_on_hold")
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error("The current call is no longer active.");
      }

      setCall((current) =>
        current
          ? {
              ...current,
              caller_on_hold: Boolean(data.caller_on_hold),
              callee_on_hold: Boolean(data.callee_on_hold),
            }
          : current
      );

      // Disable the current call's media immediately. The existing hold effect
      // will keep these tracks disabled while the first call remains on hold.
      localStreamRef.current
        ?.getAudioTracks()
        .forEach((track) => {
          track.enabled = false;
        });

      localStreamRef.current
        ?.getVideoTracks()
        .forEach((track) => {
          track.enabled = false;
        });

      const waitingCallId = waitingCall.call.id;
      clearWaitingCall(waitingCallId);
      setWaitingCall(null);

      router.push({
        pathname: "/call/[callId]",
        params: {
          callId: waitingCallId,
          direction: "incoming",
          nativeAction: "answer",
          returnCallId: callId,
        },
      });
    } catch (error) {
      Alert.alert(
        "Call waiting",
        error instanceof Error
          ? error.message
          : "Could not hold the current call."
      );
    } finally {
      setWaitingActionBusy(false);
    }
  }, [call, callId, user, waitingActionBusy, waitingCall]);

  const endAndAnswerWaitingCall = useCallback(async () => {
    if (
      !waitingCall ||
      !callId ||
      call?.status !== "accepted" ||
      waitingActionBusy
    ) {
      return;
    }

    setWaitingActionBusy(true);
    suppressTerminalNavigationRef.current = true;

    try {
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from("calls")
        .update({
          status: "ended",
          end_reason: "ended_for_waiting_call",
          ended_at: nowIso,
          last_state_changed_at: nowIso,
        })
        .eq("id", callId)
        .eq("status", "accepted")
        .select("id")
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error("The current call is no longer active.");
      }

      // Tear down only the current call after its authoritative transition has
      // succeeded, then replace this route with the waiting call and auto-answer.
      cleanupMedia();
      endNativeCall(
        callId,
        CALLKIT_END_REASONS.REMOTE_ENDED
      );

      await finishVoiceCall(
        callId,
        "ended",
        "ended_for_waiting_call"
      );

      const waitingCallId = waitingCall.call.id;
      clearWaitingCall(waitingCallId);
      setWaitingCall(null);

      // Replace Call A with Call B only after Call A is terminal. Its
      // Realtime terminal callback is suppressed above so it cannot pop B.
      router.replace({
        pathname: "/call/[callId]",
        params: {
          callId: waitingCallId,
          direction: "incoming",
          nativeAction: "answer",
        },
      });
    } catch (error) {
      suppressTerminalNavigationRef.current = false;
      Alert.alert(
        "Call waiting",
        error instanceof Error
          ? error.message
          : "Could not switch to the waiting call."
      );
    } finally {
      setWaitingActionBusy(false);
    }
  }, [
    call?.status,
    callId,
    cleanupMedia,
    waitingActionBusy,
    waitingCall,
  ]);

  function toggleMute() {
    const next = !muted;

    localStreamRef.current
      ?.getAudioTracks()
      .forEach((track) => {
        track.enabled = !next && !localOnHold;
      });

    setMuted(next);
    if (callId) {
      setNativeCallMuted(callId, next);
    }
  }

  const toggleSpeaker = useCallback(() => {
    const next = !speakerOn;

    // Force the in-call audio route immediately, then mirror that state in UI.
    // This does not touch WebRTC tracks, mute, hold, or the call lifecycle.
    InCallManager.setForceSpeakerphoneOn(next);
    setSpeakerOn(next);
  }, [speakerOn]);

  function toggleCamera() {
    const next = !cameraEnabled;

    localStreamRef.current
      ?.getVideoTracks()
      .forEach((track) => {
        track.enabled = next && !localOnHold;
      });

    setCameraEnabled(next);

    if (user && callChannelRef.current) {
      void callChannelRef.current.send({
        type: "broadcast",
        event: "camera-state",
        payload: {
          user_id: user.id,
          enabled: next,
        },
      });
    }
  }

  function switchCamera() {
    const track = localStreamRef.current
      ?.getVideoTracks()?.[0] as
      | (MediaStreamTrack & {
          _switchCamera?: () => void;
        })
      | undefined;

    if (!track?._switchCamera) {
      Alert.alert(
        "Camera switch unavailable",
        "This device could not switch cameras."
      );
      return;
    }

    track._switchCamera();
    setFrontCamera((current) => !current);
  }

  function formatDuration(seconds: number) {
    return `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  }

  if (loading || !call) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#FFFFFF" />
      </SafeAreaView>
    );
  }

  const otherName =
    otherProfile?.display_name ??
    "Global Qall User";
  const incomingWaiting =
    isIncoming && call.status === "ringing";
  const remoteVideoVisible = Boolean(
    remoteStream &&
    remoteVideoAvailable &&
    !remoteOnHold
  );
  const remoteVideoStatus =
    remoteOnHold
      ? `${otherName} is on hold`
      : call.status === "accepted"
        ? "Camera is off"
        : connectionLabel;

  const qualityIndicator =
    call.status === "accepted" &&
    (
      connectionLabel.startsWith("Reconnecting") ||
      peerConnectionState === "disconnected" ||
      iceConnectionState === "disconnected" ||
      iceConnectionState === "failed"
    )
      ? "Reconnecting"
      : networkQuality;

  const qualityIcon =
    qualityIndicator === "Reconnecting"
      ? "sync"
      : qualityIndicator === "Excellent"
        ? "cellular"
        : qualityIndicator === "Good"
          ? "wifi"
          : qualityIndicator === "Poor"
            ? "warning"
            : "help-circle-outline";

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      <Modal
        visible={Boolean(waitingCall)}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!waitingActionBusy) {
            void declineWaitingCall();
          }
        }}
      >
        <View style={styles.callWaitingBackdrop}>
          <View style={styles.callWaitingCard}>
            <Text style={styles.callWaitingEyebrow}>
              Incoming call
            </Text>

            <Text style={styles.callWaitingName}>
              {waitingCall?.caller?.display_name?.trim() ||
                waitingCall?.caller?.qall_id ||
                "Global Qall caller"}
            </Text>

            <Text style={styles.callWaitingId}>
              {waitingCall?.caller?.qall_id ?? "Global Qall"}
            </Text>

            <Text style={styles.callWaitingType}>
              {waitingCall?.call.call_type === "video"
                ? "Video call waiting"
                : "Voice call waiting"}
            </Text>

            {waitingActionBusy ? (
              <ActivityIndicator
                size="large"
                color="#FFFFFF"
                style={styles.callWaitingSpinner}
              />
            ) : (
              <View style={styles.callWaitingActions}>
                <Pressable
                  onPress={() => void declineWaitingCall()}
                  style={[
                    styles.callWaitingAction,
                    styles.callWaitingDecline,
                  ]}
                >
                  <Ionicons
                    name="close"
                    size={24}
                    color="#FFFFFF"
                  />
                  <Text style={styles.callWaitingActionText}>
                    Decline
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() =>
                    void endAndAnswerWaitingCall()
                  }
                  style={[
                    styles.callWaitingAction,
                    styles.callWaitingAnswer,
                  ]}
                >
                  <Ionicons
                    name="call"
                    size={22}
                    color="#FFFFFF"
                  />
                  <Text style={styles.callWaitingActionText}>
                    End & Accept
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>

      <SafeAreaView style={styles.safeArea}>
        {isVideoCall && !incomingWaiting ? (
          <View style={styles.videoStage}>
            {remoteVideoVisible ? (
              <RTCView
                streamURL={remoteStream!.toURL()}
                style={styles.remoteVideo}
                objectFit="cover"
                mirror={false}
                zOrder={0}
              />
            ) : (
              <View style={styles.videoWaiting}>
                <UserAvatar
                  avatarUrl={otherProfile?.avatar_url}
                  name={otherName}
                  size={118}
                />
                <Text style={styles.videoWaitingName}>
                  {otherName}
                </Text>
                <Text style={styles.videoWaitingStatus}>
                  {incomingWaiting
                    ? "Incoming video call"
                    : remoteVideoStatus}
                </Text>
              </View>
            )}

            {localStream && cameraEnabled && !localOnHold && (
              <Animated.View
                {...previewPanResponder.panHandlers}
                style={[
                  styles.localVideoContainer,
                  isLandscape
                    ? styles.localVideoLandscape
                    : styles.localVideoPortrait,
                  {
                    transform:
                      previewPosition.getTranslateTransform(),
                  },
                ]}
              >
                <RTCView
                  streamURL={localStream.toURL()}
                  style={styles.localVideo}
                  objectFit="cover"
                  mirror={frontCamera}
                  zOrder={2}
                />
              </Animated.View>
            )}

            <View style={styles.videoTopOverlay}>
              <Text style={styles.videoCallName}>
                {otherName}
              </Text>
              <Text style={styles.videoStatus}>
                {call.status === "accepted"
                  ? remoteOnHold
                    ? `${otherName} is on hold`
                    : localOnHold
                      ? "Call on hold"
                      : formatDuration(
                          elapsedSeconds
                        )
                  : connectionLabel}
              </Text>

              {call.status === "accepted" &&
                !localOnHold &&
                !remoteOnHold && (
                  <View style={styles.qualityIndicator}>
                    <Ionicons
                      name={qualityIcon as any}
                      size={14}
                      color="#FFFFFF"
                    />
                    <Text style={styles.qualityIndicatorText}>
                      {qualityIndicator === "Reconnecting"
                        ? "Reconnecting…"
                        : qualityIndicator}
                    </Text>
                  </View>
                )}

              {call.status === "accepted" && (
                <Pressable
                  onPress={() => void toggleHold()}
                  disabled={holdUpdating}
                  style={[
                    styles.holdPill,
                    localOnHold && styles.holdPillActive,
                    holdUpdating && styles.disabled,
                  ]}
                >
                  <Ionicons
                    name={localOnHold ? "play" : "pause"}
                    size={15}
                    color="#FFFFFF"
                  />
                  <Text style={styles.holdPillText}>
                    {holdUpdating
                      ? "Updating…"
                      : localOnHold
                        ? "Resume"
                        : "Hold"}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.content}>
            <Text style={styles.status}>
              {incomingWaiting
                ? isVideoCall
                  ? "Incoming video call"
                  : "Incoming voice call"
                : call.status === "accepted" && remoteOnHold
                  ? `${otherName} is on hold`
                  : call.status === "accepted" && localOnHold
                    ? "Call on hold"
                    : connectionLabel}
            </Text>

            <UserAvatar
              avatarUrl={otherProfile?.avatar_url}
              name={otherName}
              size={132}
            />

            <Text style={styles.name}>
              {otherName}
            </Text>

            <Text style={styles.qallId}>
              {otherProfile?.qall_id ??
                "Global Qall"}
            </Text>

            {call.status === "accepted" && (
              <>
                <Text style={styles.duration}>
                  {formatDuration(elapsedSeconds)}
                </Text>

                {!localOnHold && !remoteOnHold && (
                  <View
                    style={[
                      styles.qualityIndicator,
                      styles.voiceQualityIndicator,
                    ]}
                  >
                    <Ionicons
                      name={qualityIcon as any}
                      size={14}
                      color="#FFFFFF"
                    />
                    <Text style={styles.qualityIndicatorText}>
                      {qualityIndicator === "Reconnecting"
                        ? "Reconnecting…"
                        : qualityIndicator}
                    </Text>
                  </View>
                )}

                <Pressable
                  onPress={() => void toggleHold()}
                  disabled={holdUpdating}
                  style={[
                    styles.holdPill,
                    styles.voiceHoldPill,
                    localOnHold && styles.holdPillActive,
                    holdUpdating && styles.disabled,
                  ]}
                >
                  <Ionicons
                    name={localOnHold ? "play" : "pause"}
                    size={15}
                    color="#FFFFFF"
                  />
                  <Text style={styles.holdPillText}>
                    {holdUpdating
                      ? "Updating…"
                      : localOnHold
                        ? "Resume"
                        : "Hold"}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        {incomingWaiting ? (
          <View style={styles.incomingActions}>
            <Pressable
              onPress={() =>
                void finishCall(
                  "declined",
                  "declined_by_callee"
                )
              }
              style={[
                styles.roundButton,
                styles.declineButton,
              ]}
            >
              <Ionicons
                name="call"
                size={31}
                color="#FFFFFF"
                style={styles.declineIcon}
              />
              <Text style={styles.actionLabel}>
                Decline
              </Text>
            </Pressable>

            <Pressable
              onPress={() => void acceptCall()}
              disabled={preparing || !call.offer}
              style={[
                styles.roundButton,
                styles.acceptButton,
                (preparing || !call.offer) &&
                  styles.disabled,
              ]}
            >
              {preparing ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Ionicons
                  name={
                    isVideoCall
                      ? "videocam"
                      : "call"
                  }
                  size={31}
                  color="#FFFFFF"
                />
              )}
              <Text style={styles.actionLabel}>
                Accept
              </Text>
            </Pressable>
          </View>
        ) : (
          <View
            style={[
              styles.activeActions,
              isVideoCall &&
                styles.videoActiveActions,
            ]}
          >
            <Pressable
              onPress={toggleMute}
              style={[
                styles.controlButton,
                muted &&
                  styles.controlButtonActive,
              ]}
            >
              <Ionicons
                name={muted ? "mic-off" : "mic"}
                size={27}
                color="#FFFFFF"
              />
              <Text style={styles.controlLabel}>
                {muted ? "Unmute" : "Mute"}
              </Text>
            </Pressable>

            {isVideoCall && (
              <>
                <Pressable
                  onPress={toggleCamera}
                  style={[
                    styles.controlButton,
                    !cameraEnabled &&
                      styles.controlButtonActive,
                  ]}
                >
                  <Ionicons
                    name={
                      cameraEnabled
                        ? "videocam"
                        : "videocam-off"
                    }
                    size={27}
                    color="#FFFFFF"
                  />
                  <Text style={styles.controlLabel}>
                    {cameraEnabled ? "Video Off" : "Video On"}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={switchCamera}
                  style={styles.controlButton}
                >
                  <Ionicons
                    name="camera-reverse"
                    size={28}
                    color="#FFFFFF"
                  />
                  <Text style={styles.controlLabel}>
                    Flip
                  </Text>
                </Pressable>
              </>
            )}

            <Pressable
              onPress={toggleSpeaker}
              style={[
                styles.controlButton,
                speakerOn &&
                  styles.controlButtonActive,
              ]}
            >
              <Ionicons
                name={
                  speakerOn
                    ? "volume-high"
                    : "volume-medium"
                }
                size={27}
                color="#FFFFFF"
              />
              <Text style={styles.controlLabel}>
                {speakerOn ? "Speaker" : "Earpiece"}
              </Text>
            </Pressable>

            <Pressable
              onPress={handleEndPress}
              style={[
                styles.controlButton,
                styles.hangupButton,
              ]}
            >
              <Ionicons
                name="call"
                size={31}
                color="#FFFFFF"
                style={styles.declineIcon}
              />
              <Text style={styles.controlLabel}>
                End
              </Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#102D28" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#102D28",
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  status: {
    marginBottom: 28,
    fontSize: 16,
    fontWeight: "600",
    color: "#C8DDD8",
  },
  connectionDebug: {
    marginTop: 6,
    fontSize: 12,
    color: "#AAB7B3",
    textAlign: "center",
  },
  name: {
    marginTop: 22,
    fontSize: 28,
    fontWeight: "800",
    textAlign: "center",
    color: "#FFFFFF",
  },
  qallId: { marginTop: 7, fontSize: 15, letterSpacing: 0.7, color: "#B8CBC6" },
  duration: {
    marginTop: 13,
    fontSize: 18,
    fontVariant: ["tabular-nums"],
    color: "#FFFFFF",
  },
  qualityIndicator: {
    marginTop: 7,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.28)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  voiceQualityIndicator: {
    alignSelf: "center",
    marginTop: 10,
  },
  qualityIndicatorText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  holdPill: {
    marginTop: 10,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  voiceHoldPill: {
    alignSelf: "center",
    marginTop: 18,
  },
  holdPillActive: {
    backgroundColor: "#B87916",
  },
  holdPillText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  incomingActions: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingHorizontal: 42,
    paddingBottom: 52,
  },
  roundButton: {
    width: 78,
    height: 78,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 39,
  },
  declineButton: { backgroundColor: "#D92D20" },
  acceptButton: { backgroundColor: "#20A464" },
  declineIcon: { transform: [{ rotate: "135deg" }] },
  actionLabel: {
    position: "absolute",
    top: 86,
    fontSize: 13,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  activeActions: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 30,
    paddingBottom: 48,
  },
  controlButton: {
    width: 74,
    height: 74,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 37,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  controlButtonActive: { backgroundColor: "#65706D" },
  hangupButton: { backgroundColor: "#D92D20" },
  controlLabel: {
    position: "absolute",
    top: 82,
    fontSize: 12,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  disabled: { opacity: 0.5 },

  callWaitingBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    backgroundColor: "rgba(0,0,0,0.58)",
  },
  callWaitingCard: {
    width: "100%",
    maxWidth: 430,
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 22,
    borderRadius: 24,
    backgroundColor: "#173C35",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
  },
  callWaitingEyebrow: {
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    color: "#BFD8D1",
  },
  callWaitingName: {
    marginTop: 9,
    fontSize: 25,
    fontWeight: "800",
    textAlign: "center",
    color: "#FFFFFF",
  },
  callWaitingId: {
    marginTop: 5,
    fontSize: 14,
    textAlign: "center",
    color: "#BFD8D1",
  },
  callWaitingType: {
    marginTop: 10,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
    color: "#FFFFFF",
  },
  callWaitingSpinner: {
    marginTop: 26,
    marginBottom: 8,
  },
  callWaitingActions: {
    marginTop: 24,
    flexDirection: "row",
    gap: 12,
  },
  callWaitingAction: {
    flex: 1,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  callWaitingDecline: {
    backgroundColor: "#B42318",
  },
  callWaitingHold: {
    backgroundColor: "#8A6116",
  },
  callWaitingAnswer: {
    backgroundColor: "#16875C",
  },
  callWaitingActionText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#FFFFFF",
  },

  videoStage: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#101817",
  },
  remoteVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  videoWaiting: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  videoWaitingName: {
    marginTop: 18,
    fontSize: 25,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  videoWaitingStatus: {
    marginTop: 8,
    fontSize: 15,
    color: "#C8DDD8",
  },
  localVideoContainer: {
    position: "absolute",
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.75)",
    borderRadius: 16,
    backgroundColor: "#263330",
  },
  localVideoPortrait: {
    top: 74,
    right: 16,
    width: 112,
    height: 166,
  },
  localVideoLandscape: {
    top: 56,
    right: 18,
    width: 176,
    height: 112,
  },
  localVideo: {
    width: "100%",
    height: "100%",
  },
  videoTopOverlay: {
    position: "absolute",
    top: 26,
    left: 18,
    right: 145,
  },
  videoCallName: {
    fontSize: 19,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  videoStatus: {
    marginTop: 3,
    fontSize: 13,
    color: "rgba(255,255,255,0.82)",
  },
  videoActiveActions: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 22,
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 22,
    backgroundColor: "rgba(10,18,17,0.72)",
  },
});
