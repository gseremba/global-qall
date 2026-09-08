import { router } from "expo-router";
import {
  PropsWithChildren,
  useEffect,
  useRef,
} from "react";

import { useAuth } from "../contexts/AuthContext";
import {
  expireStaleCalls,
  type VoiceCall,
} from "../lib/calling";
import { supabase } from "../lib/supabase";

export function AndroidIncomingCallProvider({
  children,
}: PropsWithChildren) {
  const { user } = useAuth();
  const openedCallIdsRef = useRef(new Set<string>());
  const acknowledgedCallIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!user) {
      return;
    }

    let active = true;

    const acknowledgeIncomingCall = async (
      callId: string
    ) => {
      if (acknowledgedCallIdsRef.current.has(callId)) {
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
        acknowledgedCallIdsRef.current.delete(callId);
        console.warn(
          "[ANDROID CALL] acknowledge_failed",
          error.message
        );
        return;
      }

      console.log("[ANDROID CALL]", {
        callId,
        event: "incoming_call_acknowledged",
        timestamp: new Date().toISOString(),
      });
    };

    const openIncomingCall = async (
      call: VoiceCall
    ) => {
      if (
        !active ||
        call.callee_id !== user.id ||
        call.status !== "ringing"
      ) {
        return;
      }

      if (openedCallIdsRef.current.has(call.id)) {
        console.log("[ANDROID CALL]", {
          callId: call.id,
          event: "duplicate_incoming_ignored",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      openedCallIdsRef.current.add(call.id);

      await acknowledgeIncomingCall(call.id);

      console.log("[ANDROID CALL]", {
        callId: call.id,
        event: "incoming_call_opened",
        callType: call.call_type,
        timestamp: new Date().toISOString(),
      });

      router.push({
        pathname: "/call/[callId]",
        params: {
          callId: call.id,
          direction: "incoming",
        },
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
        .order("created_at", {
          ascending: false,
        })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn(
          "[ANDROID CALL] recovery_failed",
          error.message
        );
        return;
      }

      if (data) {
        await openIncomingCall(data as VoiceCall);
      }
    };

    void recoverIncomingCall();

    const recoveryTimer = setInterval(
      recoverIncomingCall,
      5_000
    );

    const channel = supabase
      .channel(`android-incoming-call-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "calls",
          filter: `callee_id=eq.${user.id}`,
        },
        (payload) => {
          void openIncomingCall(
            payload.new as VoiceCall
          );
        }
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
            void openIncomingCall(call);
            return;
          }

          // Keep accepted/terminal call IDs reserved during the same
          // provider lifetime so a stale ringing event cannot reopen them.
          acknowledgedCallIdsRef.current.add(call.id);
        }
      )
      .subscribe();

    return () => {
      active = false;
      clearInterval(recoveryTimer);
      void supabase.removeChannel(channel);
      openedCallIdsRef.current.clear();
      acknowledgedCallIdsRef.current.clear();
    };
  }, [user]);

  return children;
}
