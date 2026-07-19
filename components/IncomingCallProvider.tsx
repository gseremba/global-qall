import { router } from "expo-router";
import {
  PropsWithChildren,
  useEffect,
  useRef,
} from "react";

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

    const showIncomingCall = async (call: VoiceCall) => {
      if (
        !active ||
        call.callee_id !== user.id ||
        call.status !== "ringing" ||
        displayedCallIdsRef.current.has(call.id)
      ) {
        return;
      }

      displayedCallIdsRef.current.add(call.id);
      const profile = await loadCaller(call.caller_id);

      await displayNativeIncomingCall({
        callId: call.id,
        handle: profile?.qall_id ?? "Global Qall",
        callerName:
          profile?.display_name?.trim() ||
          profile?.qall_id ||
          "Global Qall caller",
        hasVideo: call.call_type === "video",
      });
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
        const { data } = await supabase
          .from("calls")
          .select("status")
          .eq("id", callUUID)
          .maybeSingle();

        const wasRinging = data?.status === "ringing";

        try {
          await finishVoiceCall(
            callUUID,
            wasRinging ? "declined" : "ended",
            wasRinging
              ? "declined_from_callkit"
              : "ended_from_callkit",
          );
        } catch (error) {
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
        }
      },
    );

    void setupCallKit().then(recoverIncomingCall);

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
      answerListener.remove();
      endListener.remove();
      displayListener.remove();
      supabase.removeChannel(channel);
    };
  }, [user]);

  return children;
}
