import { router } from "expo-router";
import {
  PropsWithChildren,
  useEffect,
  useRef,
} from "react";
import { Platform } from "react-native";

import { useAuth } from "../contexts/AuthContext";
import {
  expireStaleCalls,
  finishVoiceCall,
  type VoiceCall,
} from "../lib/calling";
import {
  CALLKIT_END_REASONS,
  displayNativeIncomingCall,
  endNativeCall,
  RNCallKeep,
  setupCallKit,
} from "../lib/callkit";
import { supabase } from "../lib/supabase";

type CallerProfile = {
  display_name: string | null;
  qall_id: string;
};

export function IncomingCallProvider({
  children,
}: PropsWithChildren) {
  const { user } = useAuth();
  const displayedCallIdsRef = useRef(new Set<string>());
  const acknowledgedCallIdsRef = useRef(new Set<string>());
  const answeredCallIdsRef = useRef(new Set<string>());
  const endingCallIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!user) return;

    let active = true;

    const loadCaller = async (
      callerId: string,
    ): Promise<CallerProfile | null> => {
      const { data } = await supabase
        .from("profiles")
        .select("display_name, qall_id")
        .eq("id", callerId)
        .maybeSingle();

      return data as CallerProfile | null;
    };

    const acknowledgeIncomingCall = async (
      callId: string
    ) => {
      if (acknowledgedCallIdsRef.current.has(callId)) {
        console.log("[CALL RACE]", {
          callId,
          event: "duplicate_acknowledgement_ignored",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      acknowledgedCallIdsRef.current.add(callId);

      const { error } = await supabase.rpc(
        "acknowledge_incoming_call",
        {
          requested_call_id: callId,
        }
      );

      if (error) {
        // Allow the recovery path / display callback to retry after a real
        // transport failure.
        acknowledgedCallIdsRef.current.delete(callId);

        console.warn(
          "Could not acknowledge incoming call:",
          error.message
        );
        return;
      }

      console.log("[CALL DELIVERY]", {
        callId,
        event: "incoming_call_acknowledged_provider",
        timestamp: new Date().toISOString(),
      });
    };

    const showIncomingCall = async (call: VoiceCall) => {
      if (
        !active ||
        call.callee_id !== user.id ||
        call.status !== "ringing"
      ) {
        return;
      }

      if (displayedCallIdsRef.current.has(call.id)) {
        console.log("[CALL RACE]", {
          callId: call.id,
          event: "duplicate_incoming_display_ignored",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      displayedCallIdsRef.current.add(call.id);
      const profile = await loadCaller(call.caller_id);

      try {
        if (Platform.OS === "android") {
          console.log("[INCOMING CALL] Android foreground route", {
            callId: call.id,
            callType: call.call_type,
          });

          router.push({
            pathname: "/call/[callId]",
            params: {
              callId: call.id,
              direction: "incoming",
            },
          });

          await acknowledgeIncomingCall(call.id);
          return;
        }

        await displayNativeIncomingCall({
          callId: call.id,
          handle: profile?.qall_id ?? "Global Qall",
          callerName:
            profile?.display_name?.trim() ||
            profile?.qall_id ||
            "Global Qall caller",
          hasVideo: call.call_type === "video",
        });

        await acknowledgeIncomingCall(call.id);
      } catch (error) {
        displayedCallIdsRef.current.delete(call.id);

        console.warn(
          "Could not display/acknowledge incoming call:",
          error instanceof Error
            ? error.message
            : error
        );
      }
    };

    const recoverIncomingCall = async () => {
      await expireStaleCalls();

      const { data, error } = await supabase
        .from("calls")
        .select("*")
        .eq("callee_id", user.id)
        .eq("status", "ringing")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn(
          "Could not recover incoming CallKit call:",
          error.message,
        );
        return;
      }

      if (data) {
        await showIncomingCall(data as VoiceCall);
      }
    };

    const answerListener = RNCallKeep.addEventListener(
      "answerCall",
      ({ callUUID }) => {
        if (answeredCallIdsRef.current.has(callUUID)) {
          console.log("[CALL RACE]", {
            callId: callUUID,
            event: "duplicate_callkit_answer_ignored",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        answeredCallIdsRef.current.add(callUUID);

        router.push({
          pathname: "/call/[callId]",
          params: {
            callId: callUUID,
            direction: "incoming",
            nativeAction: "answer",
          },
        });
      },
    );

    const endListener = RNCallKeep.addEventListener(
      "endCall",
      async ({ callUUID }) => {
        if (endingCallIdsRef.current.has(callUUID)) {
          console.log("[CALL RACE]", {
            callId: callUUID,
            event: "duplicate_callkit_end_ignored",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        endingCallIdsRef.current.add(callUUID);

        try {
          const { data, error } = await supabase
            .from("calls")
            .select("status")
            .eq("id", callUUID)
            .maybeSingle();

          if (error) {
            throw error;
          }

          if (
            !data ||
            data.status === "declined" ||
            data.status === "ended" ||
            data.status === "missed" ||
            data.status === "failed"
          ) {
            console.log("[CALL RACE]", {
              callId: callUUID,
              event: "callkit_end_already_terminal",
              status: data?.status ?? null,
              timestamp: new Date().toISOString(),
            });
            return;
          }

          const wasRinging = data.status === "ringing";

          await finishVoiceCall(
            callUUID,
            wasRinging ? "declined" : "ended",
            wasRinging
              ? "declined_from_callkit"
              : "ended_from_callkit",
          );
        } catch (error) {
          // Permit a retry only when the action did not successfully reach
          // the authoritative database.
          endingCallIdsRef.current.delete(callUUID);

          console.warn(
            "Could not finish CallKit call:",
            error,
          );
        }
      },
    );

    const displayListener = RNCallKeep.addEventListener(
      "didDisplayIncomingCall",
      ({ error, callUUID }) => {
        if (error) {
          displayedCallIdsRef.current.delete(callUUID);
          console.warn(
            "CallKit could not display incoming call:",
            error,
          );
          return;
        }

        void acknowledgeIncomingCall(callUUID);
      },
    );

    if (Platform.OS === "ios") {
      void setupCallKit().then(recoverIncomingCall);
    } else {
      void recoverIncomingCall();
    }

    const recoveryTimer = setInterval(
      recoverIncomingCall,
      5000,
    );

    const channel = supabase
      .channel(`incoming-callkit-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "calls",
          filter: `callee_id=eq.${user.id}`,
        },
        (payload) => {
          void showIncomingCall(payload.new as VoiceCall);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "calls",
          filter: `callee_id=eq.${user.id}`,
        },
        (payload) => {
          const call = payload.new as VoiceCall;

          if (call.status === "ringing") {
            void showIncomingCall(call);
            return;
          }

          displayedCallIdsRef.current.delete(call.id);

          if (call.status === "declined") {
            endNativeCall(
              call.id,
              CALLKIT_END_REASONS.DECLINED_ELSEWHERE,
            );
          } else if (call.status === "missed") {
            endNativeCall(
              call.id,
              CALLKIT_END_REASONS.MISSED,
            );
          } else if (call.status === "failed") {
            endNativeCall(
              call.id,
              CALLKIT_END_REASONS.FAILED,
            );
          } else if (call.status === "ended") {
            endNativeCall(
              call.id,
              CALLKIT_END_REASONS.REMOTE_ENDED,
            );
          }
        },
      )
      .subscribe();

    return () => {
      active = false;
      clearInterval(recoveryTimer);
      displayedCallIdsRef.current.clear();
      acknowledgedCallIdsRef.current.clear();
      answeredCallIdsRef.current.clear();
      endingCallIdsRef.current.clear();
      answerListener.remove();
      endListener.remove();
      displayListener.remove();
      supabase.removeChannel(channel);
    };
  }, [user]);

  return children;
}
