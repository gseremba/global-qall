import {
  mediaDevices,
  MediaStream,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from "react-native-webrtc";

import { supabase } from "./supabase";
import {
  addGroupIceCandidate,
  beginGroupIceRestart,
  getPeerNegotiation,
  getRemoteGroupIceCandidates,
  loadMyPeerSessions,
  setGroupPeerConnectionState,
  submitGroupAnswer,
  submitGroupOffer,
  touchGroupCallLiveness,
  type GroupCallType,
  type GroupPeerNegotiation,
  type GroupPeerSession,
} from "./groupCalling";

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

const RECONCILE_INTERVAL_MS = 1200;
const LIVENESS_INTERVAL_MS = 15_000;

export type GroupRemoteStream = {
  peerSessionId: string;
  remoteUserId: string;
  stream: MediaStream;
};

export type GroupPeerClientState = {
  peerSessionId: string;
  remoteUserId: string;
  role: "offerer" | "answerer";
  databaseState: string;
  connectionState: string;
  iceConnectionState: string;
  iceGeneration: number;
};

export type GroupWebRTCClientEvents = {
  onRemoteStream?: (
    remote: GroupRemoteStream
  ) => void;
  onRemoteStreamRemoved?: (
    peerSessionId: string,
    remoteUserId: string
  ) => void;
  onPeerState?: (
    state: GroupPeerClientState
  ) => void;
  onError?: (
    error: Error,
    context: {
      peerSessionId?: string;
      operation: string;
    }
  ) => void;
};

type PeerRuntime = {
  sessionId: string;
  remoteUserId: string;
  role: "offerer" | "answerer";
  pc: RTCPeerConnection;
  iceGeneration: number;
  remoteDescriptionGeneration: number | null;
  lastRemoteCandidateId: number;
  appliedCandidateIds: Set<number>;
  makingOffer: boolean;
  applyingAnswer: boolean;
  closed: boolean;
};

function normalizeError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error));
}

function descriptionToJson(
  description: any
): Record<string, unknown> {
  if (description?.toJSON) {
    return description.toJSON();
  }

  return {
    type: description?.type,
    sdp: description?.sdp,
  };
}

function candidateToJson(
  candidate: any
): Record<string, unknown> {
  return candidate?.toJSON
    ? candidate.toJSON()
    : candidate;
}

export class GroupWebRTCClient {
  private readonly peers =
    new Map<string, PeerRuntime>();

  private localStream: MediaStream | null = null;
  private reconcileTimer:
    | ReturnType<typeof setInterval>
    | null = null;
  private livenessTimer:
    | ReturnType<typeof setInterval>
    | null = null;
  private realtimeChannel: any = null;
  private stopped = false;
  private reconcileRunning = false;

  constructor(
    private readonly options: {
      groupCallId: string;
      userId: string;
      callType: GroupCallType;
      events?: GroupWebRTCClientEvents;
    }
  ) {}

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  getPeerStates(): GroupPeerClientState[] {
    return [...this.peers.values()].map(
      (runtime) => ({
        peerSessionId: runtime.sessionId,
        remoteUserId: runtime.remoteUserId,
        role: runtime.role,
        databaseState:
          runtime.pc.connectionState === "closed"
            ? "closed"
            : "runtime",
        connectionState:
          runtime.pc.connectionState,
        iceConnectionState:
          runtime.pc.iceConnectionState,
        iceGeneration: runtime.iceGeneration,
      })
    );
  }

  async start(): Promise<MediaStream> {
    if (this.localStream) {
      return this.localStream;
    }

    this.stopped = false;

    const stream =
      await mediaDevices.getUserMedia({
        audio: true,
        video:
          this.options.callType === "video"
            ? {
                facingMode: "user",
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 24 },
              }
            : false,
      });

    this.localStream = stream;

    this.subscribeToSignaling();

    await this.reconcileNow();

    this.reconcileTimer = setInterval(
      () => void this.reconcileNow(),
      RECONCILE_INTERVAL_MS
    );

    this.livenessTimer = setInterval(
      () => {
        void touchGroupCallLiveness(
          this.options.groupCallId
        ).catch((error) =>
          this.reportError(
            error,
            "touch_group_call_liveness"
          )
        );
      },
      LIVENESS_INTERVAL_MS
    );

    return stream;
  }

  async reconcileNow(): Promise<void> {
    if (
      this.stopped ||
      this.reconcileRunning
    ) {
      return;
    }

    this.reconcileRunning = true;

    try {
      const sessions =
        await loadMyPeerSessions(
          this.options.groupCallId,
          this.options.userId
        );

      const activeIds = new Set(
        sessions
          .filter(
            (session) =>
              session.status !== "closed"
          )
          .map((session) => session.id)
      );

      for (const [
        peerSessionId,
        runtime,
      ] of this.peers) {
        if (!activeIds.has(peerSessionId)) {
          this.closePeer(runtime);
          this.peers.delete(peerSessionId);
        }
      }

      for (const session of sessions) {
        if (session.status === "closed") {
          continue;
        }

        await this.reconcileSession(session);
      }
    } catch (error) {
      this.reportError(
        error,
        "reconcile"
      );
    } finally {
      this.reconcileRunning = false;
    }
  }

  async restartIce(
    peerSessionId: string
  ): Promise<number> {
    const runtime =
      this.peers.get(peerSessionId);

    if (!runtime) {
      throw new Error(
        "Peer session is not active locally."
      );
    }

    const generation =
      await beginGroupIceRestart(
        peerSessionId
      );

    runtime.iceGeneration = generation;
    runtime.remoteDescriptionGeneration =
      null;
    runtime.lastRemoteCandidateId = 0;
    runtime.appliedCandidateIds.clear();
    runtime.role = "offerer";

    await this.createAndSubmitOffer(
      runtime,
      true
    );

    return generation;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;

    this.stopped = true;

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }

    if (this.realtimeChannel) {
      await supabase.removeChannel(
        this.realtimeChannel
      );
      this.realtimeChannel = null;
    }

    for (const runtime of this.peers.values()) {
      this.closePeer(runtime);
    }

    this.peers.clear();

    if (this.localStream) {
      this.localStream
        .getTracks()
        .forEach((track) => track.stop());

      this.localStream = null;
    }
  }

  private subscribeToSignaling() {
    if (this.realtimeChannel) {
      return;
    }

    const callId =
      this.options.groupCallId;

    this.realtimeChannel = supabase
      .channel(
        `group-call-signaling:${callId}:${this.options.userId}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table:
            "group_call_peer_sessions",
          filter:
            `group_call_id=eq.${callId}`,
        },
        () => {
          void this.reconcileNow();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table:
            "group_call_ice_candidates",
          filter:
            `group_call_id=eq.${callId}`,
        },
        () => {
          void this.reconcileNow();
        }
      )
      .subscribe();
  }

  private async reconcileSession(
    session: GroupPeerSession
  ): Promise<void> {
    const negotiation =
      await getPeerNegotiation(
        session.id
      );

    let runtime =
      this.peers.get(session.id);

    if (!runtime) {
      runtime =
        await this.createPeerRuntime(
          negotiation
        );

      this.peers.set(
        session.id,
        runtime
      );
    }

    if (
      runtime.iceGeneration !==
      negotiation.iceGeneration
    ) {
      runtime.iceGeneration =
        negotiation.iceGeneration;
      runtime.remoteDescriptionGeneration =
        null;
      runtime.lastRemoteCandidateId = 0;
      runtime.appliedCandidateIds.clear();
      runtime.role =
        negotiation.localRole;
    }

    runtime.role =
      negotiation.localRole;

    if (
      negotiation.status === "pending" &&
      negotiation.localRole === "offerer" &&
      !negotiation.offer &&
      !runtime.makingOffer
    ) {
      await this.createAndSubmitOffer(
        runtime,
        false
      );
    }

    if (
      negotiation.localRole === "answerer" &&
      negotiation.offer &&
      (
        negotiation.status === "offered" ||
        negotiation.status === "answered"
      )
    ) {
      await this.applyOfferAndAnswer(
        runtime,
        negotiation
      );
    }

    if (
      negotiation.localRole === "offerer" &&
      negotiation.answer
    ) {
      await this.applyRemoteAnswer(
        runtime,
        negotiation
      );
    }

    await this.syncRemoteIce(
      runtime,
      negotiation.iceGeneration
    );

    this.emitPeerState(
      runtime,
      negotiation.status
    );
  }

  private async createPeerRuntime(
    negotiation: GroupPeerNegotiation
  ): Promise<PeerRuntime> {
    if (!this.localStream) {
      throw new Error(
        "Local media is not initialized."
      );
    }

    const pc =
      new RTCPeerConnection(
        RTC_CONFIGURATION
      );

    this.localStream
      .getTracks()
      .forEach((track) => {
        pc.addTrack(
          track,
          this.localStream!
        );
      });

    const runtime: PeerRuntime = {
      sessionId:
        negotiation.peerSessionId,
      remoteUserId:
        negotiation.remoteUserId,
      role: negotiation.localRole,
      pc,
      iceGeneration:
        negotiation.iceGeneration,
      remoteDescriptionGeneration: null,
      lastRemoteCandidateId: 0,
      appliedCandidateIds: new Set(),
      makingOffer: false,
      applyingAnswer: false,
      closed: false,
    };

    pc.onicecandidate = (event: any) => {
      if (
        !event.candidate ||
        runtime.closed
      ) {
        return;
      }

      void addGroupIceCandidate(
        runtime.sessionId,
        candidateToJson(
          event.candidate
        ),
        runtime.iceGeneration
      ).catch((error) =>
        this.reportError(
          error,
          "publish_ice",
          runtime.sessionId
        )
      );
    };

    pc.ontrack = (event: any) => {
      if (runtime.closed) return;

      const incomingStream =
        event.streams?.[0];

      if (incomingStream) {
        this.options.events
          ?.onRemoteStream?.({
            peerSessionId:
              runtime.sessionId,
            remoteUserId:
              runtime.remoteUserId,
            stream: incomingStream,
          });

        return;
      }

      if (event.track) {
        const stream =
          new MediaStream();

        stream.addTrack(event.track);

        this.options.events
          ?.onRemoteStream?.({
            peerSessionId:
              runtime.sessionId,
            remoteUserId:
              runtime.remoteUserId,
            stream,
          });
      }
    };

    pc.onconnectionstatechange = () => {
      if (runtime.closed) return;

      const state =
        pc.connectionState;

      if (
        state === "connecting" ||
        state === "connected" ||
        state === "disconnected" ||
        state === "failed"
      ) {
        void setGroupPeerConnectionState(
          runtime.sessionId,
          state
        ).catch((error) =>
          this.reportError(
            error,
            "publish_connection_state",
            runtime.sessionId
          )
        );
      }

      this.emitPeerState(
        runtime,
        state
      );
    };

    pc.oniceconnectionstatechange =
      () => {
        if (runtime.closed) return;

        this.emitPeerState(
          runtime,
          pc.iceConnectionState
        );
      };

    return runtime;
  }

  private async createAndSubmitOffer(
    runtime: PeerRuntime,
    iceRestart: boolean
  ): Promise<void> {
    if (
      runtime.closed ||
      runtime.makingOffer
    ) {
      return;
    }

    runtime.makingOffer = true;

    try {
      const offer =
        await runtime.pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo:
            this.options.callType === "video",
          ...(iceRestart
            ? { iceRestart: true }
            : {}),
        });

      await runtime.pc.setLocalDescription(
        offer
      );

      await submitGroupOffer(
        runtime.sessionId,
        descriptionToJson(offer),
        runtime.iceGeneration
      );
    } finally {
      runtime.makingOffer = false;
    }
  }

  private async applyOfferAndAnswer(
    runtime: PeerRuntime,
    negotiation: GroupPeerNegotiation
  ): Promise<void> {
    if (
      runtime.closed ||
      runtime.applyingAnswer ||
      !negotiation.offer
    ) {
      return;
    }

    if (
      runtime.remoteDescriptionGeneration ===
        negotiation.iceGeneration &&
      runtime.pc.localDescription?.type ===
        "answer"
    ) {
      return;
    }

    runtime.applyingAnswer = true;

    try {
      await runtime.pc.setRemoteDescription(
        new RTCSessionDescription(
          negotiation.offer as any
        )
      );

      runtime.remoteDescriptionGeneration =
        negotiation.iceGeneration;

      await this.syncRemoteIce(
        runtime,
        negotiation.iceGeneration
      );

      const answer =
        await runtime.pc.createAnswer();

      await runtime.pc.setLocalDescription(
        answer
      );

      await submitGroupAnswer(
        runtime.sessionId,
        descriptionToJson(answer),
        negotiation.iceGeneration
      );
    } finally {
      runtime.applyingAnswer = false;
    }
  }

  private async applyRemoteAnswer(
    runtime: PeerRuntime,
    negotiation: GroupPeerNegotiation
  ): Promise<void> {
    if (
      runtime.closed ||
      !negotiation.answer
    ) {
      return;
    }

    if (
      runtime.remoteDescriptionGeneration ===
        negotiation.iceGeneration &&
      runtime.pc.remoteDescription?.type ===
        "answer"
    ) {
      return;
    }

    await runtime.pc.setRemoteDescription(
      new RTCSessionDescription(
        negotiation.answer as any
      )
    );

    runtime.remoteDescriptionGeneration =
      negotiation.iceGeneration;

    await this.syncRemoteIce(
      runtime,
      negotiation.iceGeneration
    );
  }

  private async syncRemoteIce(
    runtime: PeerRuntime,
    generation: number
  ): Promise<void> {
    if (
      runtime.closed ||
      !runtime.pc.remoteDescription
    ) {
      return;
    }

    const rows =
      await getRemoteGroupIceCandidates(
        runtime.sessionId,
        runtime.lastRemoteCandidateId,
        generation
      );

    for (const row of rows) {
      runtime.lastRemoteCandidateId =
        Math.max(
          runtime.lastRemoteCandidateId,
          row.id
        );

      if (
        runtime.appliedCandidateIds.has(
          row.id
        )
      ) {
        continue;
      }

      await runtime.pc.addIceCandidate(
        new RTCIceCandidate(
          row.candidate as any
        )
      );

      runtime.appliedCandidateIds.add(
        row.id
      );
    }
  }

  private closePeer(
    runtime: PeerRuntime
  ) {
    if (runtime.closed) return;

    runtime.closed = true;

    try {
      runtime.pc.onicecandidate = null;
      runtime.pc.ontrack = null;
      runtime.pc.onconnectionstatechange =
        null;
      runtime.pc.oniceconnectionstatechange =
        null;
      runtime.pc.close();
    } catch {
      // Closing is best effort.
    }

    this.options.events
      ?.onRemoteStreamRemoved?.(
        runtime.sessionId,
        runtime.remoteUserId
      );
  }

  private emitPeerState(
    runtime: PeerRuntime,
    databaseState: string
  ) {
    this.options.events
      ?.onPeerState?.({
        peerSessionId:
          runtime.sessionId,
        remoteUserId:
          runtime.remoteUserId,
        role: runtime.role,
        databaseState,
        connectionState:
          runtime.pc.connectionState,
        iceConnectionState:
          runtime.pc.iceConnectionState,
        iceGeneration:
          runtime.iceGeneration,
      });
  }

  private reportError(
    error: unknown,
    operation: string,
    peerSessionId?: string
  ) {
    const normalized =
      normalizeError(error);

    console.warn(
      `[GROUP WEBRTC] ${operation}:`,
      normalized.message
    );

    this.options.events
      ?.onError?.(
        normalized,
        {
          peerSessionId,
          operation,
        }
      );
  }
}
