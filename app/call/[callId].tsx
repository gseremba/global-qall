import Ionicons from "@expo/vector-icons/Ionicons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { setAudioModeAsync } from "expo-audio";
import InCallManager from "react-native-incall-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Animated,
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
import { supabase } from "../../lib/supabase";

const TURN_URL = process.env.EXPO_PUBLIC_TURN_URL;
const TURN_USERNAME =
  process.env.EXPO_PUBLIC_TURN_USERNAME;
const TURN_CREDENTIAL =
  process.env.EXPO_PUBLIC_TURN_CREDENTIAL;

const RTC_CONFIGURATION = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    ...(TURN_URL &&
    TURN_USERNAME &&
    TURN_CREDENTIAL
      ? [
          {
            urls: TURN_URL,
            username: TURN_USERNAME,
            credential: TURN_CREDENTIAL,
          },
        ]
      : []),
  ],
};

const UNANSWERED_TIMEOUT_MS = 35_000;
const RECONNECT_GRACE_MS = 12_000;
const TERMINAL_CALL_STATUSES = new Set([
  "declined",
  "ended",
  "missed",
  "failed",
]);

function isTerminalCallStatus(status: string): boolean {
  return TERMINAL_CALL_STATUSES.has(status);
}


function closeCallScreen() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace("/chat");
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
  }>();
  const callId = Array.isArray(params.callId)
    ? params.callId[0]
    : params.callId;
  const nativeAction = Array.isArray(params.nativeAction)
    ? params.nativeAction[0]
    : params.nativeAction;

  const [call, setCall] = useState<VoiceCall | null>(null);
  const [otherProfile, setOtherProfile] = useState<OtherProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [muted, setMuted] = useState(false);
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
  const [networkQuality, setNetworkQuality] =
    useState<"Excellent" | "Good" | "Poor" | "Unknown">(
      "Unknown"
    );
  const [remoteVideoAvailable, setRemoteVideoAvailable] =
    useState(false);
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const previewPosition = useRef(
    new Animated.ValueXY({ x: 0, y: 0 })
  ).current;

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callChannelRef = useRef<any>(null);
  const remoteDescriptionReadyRef = useRef(false);
  const pendingCandidatesRef = useRef<Record<string, unknown>[]>([]);
  const offerCreatedRef = useRef(false);
  const answerAppliedRef = useRef(false);
  const answerApplyingRef = useRef(false);
  const nativeAnswerAppliedRef = useRef(false);
  const nativeOutgoingStartedRef = useRef(false);
  const nativeConnectedRef = useRef(false);
  const endedLocallyRef = useRef(false);
  const appliedCandidateKeysRef = useRef(new Set<string>());
  const reconnectTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const unansweredTimerRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);

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

  const cleanupMedia = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (unansweredTimerRef.current) {
      clearTimeout(unansweredTimerRef.current);
      unansweredTimerRef.current = null;
    }

    localStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteVideoAvailable(false);

    peerRef.current?.close();
    peerRef.current = null;

    InCallManager.stop();
    InCallManager.setForceSpeakerphoneOn(false);
  }, []);

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

      try {
        await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        appliedCandidateKeysRef.current.add(key);
      } catch (error) {
        console.warn("Could not add remote ICE candidate:", error);
      }
    },
    [candidateKey],
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
  }, [addRemoteCandidate]);

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
        if (peer.signalingState === "stable") {
          answerAppliedRef.current = true;
        }
        return;
      }

      answerApplyingRef.current = true;

      try {
        await peer.setRemoteDescription(
          new RTCSessionDescription(answer),
        );
        answerAppliedRef.current = true;
        remoteDescriptionReadyRef.current = true;
        await flushCandidates();
        await syncRemoteCandidates();
        setConnectionLabel("Connecting…");
      } catch (error) {
        // Another answer handler may have completed while this async call was
        // waiting. A stable peer already has its remote answer, so this is safe.
        if (peer.signalingState === "stable") {
          answerAppliedRef.current = true;
          return;
        }

        throw error;
      } finally {
        answerApplyingRef.current = false;
      }
    },
    [flushCandidates, syncRemoteCandidates],
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
    InCallManager.setForceSpeakerphoneOn(false);

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

    const peer = new RTCPeerConnection(RTC_CONFIGURATION);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    peer.onicecandidate = (event: any) => {
      if (!event.candidate) return;
      void supabase
        .from("call_ice_candidates")
        .insert({
          call_id: callId,
          user_id: user.id,
          candidate: event.candidate.toJSON
            ? event.candidate.toJSON()
            : event.candidate,
        })
        .then(({ error }) => {
          if (error) {
            console.warn("Could not save ICE candidate:", error.message);
          }
        });
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const beginReconnectGrace = () => {
      setConnectionLabel("Reconnecting…");

      if (reconnectTimerRef.current) {
        return;
      }

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;

        if (
          peer.connectionState !== "connected" &&
          peer.iceConnectionState !== "connected" &&
          peer.iceConnectionState !== "completed"
        ) {
          setConnectionLabel("Connection lost");
          void finishCall("failed", "connection_lost");
        }
      }, RECONNECT_GRACE_MS);
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;

      if (state === "connected") {
        clearReconnectTimer();
        setConnectionLabel("Connected");
      } else if (state === "connecting") {
        setConnectionLabel("Connecting…");
      } else if (
        state === "disconnected" ||
        state === "failed"
      ) {
        beginReconnectGrace();
      }
    };

    peer.oniceconnectionstatechange = () => {
      const state = peer.iceConnectionState;

      if (state === "connected" || state === "completed") {
        clearReconnectTimer();
        setConnectionLabel("Connected");
      } else if (state === "checking") {
        setConnectionLabel("Connecting…");
      } else if (
        state === "failed" ||
        state === "disconnected"
      ) {
        beginReconnectGrace();
      }
    };

    peer.ontrack = (event: any) => {
      const incomingStream = event.streams?.[0];

      if (incomingStream) {
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
  }, [call?.call_type, callId, user]);

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
    if (!callId || !call?.offer || preparing) return;
    setPreparing(true);
    try {
      const peer = await preparePeer();
      await peer.setRemoteDescription(new RTCSessionDescription(call.offer));
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
      if (!callId || endedLocallyRef.current) {
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
          const { data: transition, error: transitionError } = await supabase
            .from("calls")
            .update({ status })
            .eq("id", callId)
            .in("status", expectedStatuses)
            .select("id, status")
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
            closeCallScreen();
            return;
          }
        }

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

      closeCallScreen();
    },
    [callId, cleanupMedia]
  );

  const finishMissedIfStillRinging = useCallback(
    async (reason = "unanswered") => {
      if (!callId || endedLocallyRef.current) {
        return;
      }

      const { data, error } = await supabase
        .from("calls")
        .select("status, created_at, expires_at")
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

      await finishCall("missed", reason);
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
    if (!callId || !user) return;
    let mounted = true;

    const load = async () => {
      try {
        await expireStaleCalls();
        const { data, error } = await supabase
          .from("calls")
          .select("*")
          .eq("id", callId)
          .single();
        if (error) throw error;
        const loadedCall = data as VoiceCall;
        if (!mounted) return;

        if (isTerminalCallStatus(loadedCall.status)) {
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
          closeCallScreen();
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
            updated.answer &&
            updated.caller_id === user.id
          ) {
            await applyRemoteAnswer(updated.answer);
          }

          if (isTerminalCallStatus(updated.status)) {
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
            const labels: Record<string, string> = {
              declined: "Call declined",
              missed: "No answer",
              failed: "Call failed",
              ended: "Call ended",
            };

            setConnectionLabel(
              labels[updated.status] ?? "Call ended"
            );
            setTimeout(() => closeCallScreen(), 650);
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

      if (isCaller && !answerAppliedRef.current) {
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
    const subscription = AppState.addEventListener(
      "change",
      (state) => {
        if (state !== "active" || !callId) {
          return;
        }

        void expireStaleCalls();
        void syncRemoteCandidates();

        void supabase
          .from("calls")
          .select("*")
          .eq("id", callId)
          .maybeSingle()
          .then(({ data }) => {
            if (data) {
              setCall(data as VoiceCall);
            }
          });
      }
    );

    return () => subscription.remove();
  }, [
    callId,
    syncRemoteCandidates,
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

    const updateQuality = async () => {
      try {
        const reports =
          await peerRef.current?.getStats();

        let lost = 0;
        let received = 0;
        let jitter = 0;
        let roundTripTime = 0;

        reports?.forEach((report: any) => {
          if (
            report.type === "inbound-rtp" &&
            !report.isRemote
          ) {
            lost += report.packetsLost ?? 0;
            received += report.packetsReceived ?? 0;
            jitter = Math.max(
              jitter,
              report.jitter ?? 0
            );
          }

          if (
            report.type ===
            "candidate-pair" &&
            report.state === "succeeded"
          ) {
            roundTripTime = Math.max(
              roundTripTime,
              report.currentRoundTripTime ?? 0
            );
          }
        });

        const lostDelta = Math.max(
          0,
          lost - previousLost
        );
        const receivedDelta = Math.max(
          0,
          received - previousReceived
        );
        const total = lostDelta + receivedDelta;
        const lossRate =
          total > 0 ? lostDelta / total : 0;

        previousLost = lost;
        previousReceived = received;

        if (
          lossRate > 0.08 ||
          jitter > 0.08 ||
          roundTripTime > 0.6
        ) {
          setNetworkQuality("Poor");
        } else if (
          lossRate > 0.025 ||
          jitter > 0.035 ||
          roundTripTime > 0.3
        ) {
          setNetworkQuality("Good");
        } else {
          setNetworkQuality("Excellent");
        }
      } catch {
        setNetworkQuality("Unknown");
      }
    };

    void updateQuality();
    const timer = setInterval(
      updateQuality,
      4000
    );

    return () => clearInterval(timer);
  }, [call?.status]);

  useEffect(() => cleanupMedia, [cleanupMedia]);

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
          parameters.encodings?.length
            ? parameters.encodings
            : [{}];

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

  function toggleMute() {
    const next = !muted;

    localStreamRef.current
      ?.getAudioTracks()
      .forEach((track) => {
        track.enabled = !next;
      });

    setMuted(next);
    if (callId) {
      setNativeCallMuted(callId, next);
    }
  }

  function toggleSpeaker() {
    const next = !speakerOn;
    InCallManager.setForceSpeakerphoneOn(next);
    setSpeakerOn(next);
  }

  function toggleCamera() {
    const next = !cameraEnabled;

    localStreamRef.current
      ?.getVideoTracks()
      .forEach((track) => {
        track.enabled = next;
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

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      <SafeAreaView style={styles.safeArea}>
        {isVideoCall && !incomingWaiting ? (
          <View style={styles.videoStage}>
            {remoteStream &&
            remoteVideoAvailable ? (
              <RTCView
                streamURL={remoteStream.toURL()}
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
                    : call.status === "accepted"
                      ? "Camera is off"
                      : connectionLabel}
                </Text>
              </View>
            )}

            {localStream && cameraEnabled && (
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
                  ? `${formatDuration(
                      elapsedSeconds
                    )} · ${networkQuality}`
                  : connectionLabel}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.content}>
            <Text style={styles.status}>
              {incomingWaiting
                ? isVideoCall
                  ? "Incoming video call"
                  : "Incoming voice call"
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
              <Text style={styles.duration}>
                {formatDuration(elapsedSeconds)}
              </Text>
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
                    Camera
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
                Speaker
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
