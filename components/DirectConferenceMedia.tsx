import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import InCallManager from "react-native-incall-manager";
import { setAudioModeAsync } from "expo-audio";
import { MediaStream, mediaDevices, RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, RTCView } from "react-native-webrtc";
import { supabase } from "../lib/supabase";

type PeerRow = { id: string; peer_a_id: string; peer_b_id: string; offerer_id: string; generation: number; offer: any; answer: any; status: string };
type CandidateRow = { id: number; sender_id: string; generation: number; candidate: any };
type PeerRuntime = { pc: RTCPeerConnection; generation: number; remote: MediaStream | null; seen: Set<number>; pending: CandidateRow[]; offered: boolean; answering: boolean; answered: boolean };
const FALLBACK = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const VOIP = (process.env.EXPO_PUBLIC_VOIP_SERVER_URL || "https://globalqall-voip.onrender.com").replace(/\/+$/, "");
async function iceServers(): Promise<any[]> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return FALLBACK;
    const response = await fetch(`${VOIP}/api/turn-credentials`, { headers: { authorization: `Bearer ${session.access_token}` } });
    if (!response.ok) return FALLBACK;
    const body = await response.json();
    return Array.isArray(body.iceServers) && body.iceServers.length ? [...FALLBACK, ...body.iceServers] : FALLBACK;
  } catch { return FALLBACK; }
}

/** Independent conference mesh. Never accesses the existing A-B peer or direct signaling tables. */
export function DirectConferenceMedia({ callId, userId, sharedStream, invitee = false, video = false, onLeave, onToggleMute, onToggleCamera, onToggleSpeaker, onAddParticipant, mutedExternal, cameraEnabledExternal, speakerOnExternal }: {
  callId: string; userId: string; sharedStream?: MediaStream | null; invitee?: boolean; video?: boolean; onLeave?: () => void; onToggleMute?: () => void; onToggleCamera?: () => void; onToggleSpeaker?: () => void; onAddParticipant?: () => void; mutedExternal?: boolean; cameraEnabledExternal?: boolean; speakerOnExternal?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [speakerLocal, setSpeakerLocal] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [originalIds, setOriginalIds] = useState<string[]>([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [rosterReady, setRosterReady] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, { name: string; avatar: string | null }>>({});
  useEffect(() => {
    if (!participantIds.length) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from("profiles")
        .select("id,display_name,qall_id,avatar_url").in("id", participantIds);
      if (error) { console.warn("[CONF PROFILES]", error.message); return; }
      if (cancelled) return;
      const next: Record<string, { name: string; avatar: string | null }> = {};
      for (const p of data || []) next[p.id] = {
        name: p.display_name?.trim() || p.qall_id || "Participant",
        avatar: p.avatar_url || null,
      };
      setProfiles(next);
    })();
    return () => { cancelled = true; };
  }, [participantIds]);
  const peers = useRef(new Map<string, PeerRuntime>());
  const sessionPeersRef = useRef(new Map<string, { peer_a_id: string; peer_b_id: string }>());
  const streamRef = useRef<MediaStream | null>(null);
  const ownedRef = useRef(false);
  const stoppedRef = useRef(false);
  const busyRef = useRef(false);
  const [remotes, setRemotes] = useState<Array<{ id: string; stream: MediaStream }>>([]);
  const [state, setState] = useState("Waiting for conference peers…");
  const [ownStream, setOwnStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const updateRemotes = useCallback(() => {
    if (stoppedRef.current) return;
    setRemotes([...peers.current.entries()].filter(([, p]) => p.remote).map(([id, p]) => ({ id, stream: p.remote! })));
  }, []);
  const closeAll = useCallback(() => {
    stoppedRef.current = true;
    for (const runtime of peers.current.values()) { try { runtime.pc.close(); } catch {} }
    peers.current.clear();
    if (ownedRef.current) streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    ownedRef.current = false;
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || stoppedRef.current || busyRef.current || AppState.currentState !== "active") return;
      busyRef.current = true;
      try {
        const { data: conference, error: confError } = await supabase.from("direct_call_conferences").select("id,status").eq("call_id", callId).maybeSingle();
        if (confError) throw confError;
        if (!conference || conference.status === "ended") { setState("Conference unavailable"); return; }
        // The participant table is the authoritative roster, independent of ICE/media timing.
        // Fetch all members on EVERY device, including original callers A and B.
        const { data: members, error: memberError } = await supabase.from("direct_call_conference_participants")
          .select("user_id,status").eq("conference_id", conference.id);
        if (memberError) throw memberError;
        const activeParticipantIds = [...new Set((members || [])
          .filter(m => m.status !== "left" && m.status !== "declined" && m.status !== "removed")
          .map(m => m.user_id as string))];
        if (!activeParticipantIds.includes(userId)) {
          setParticipantIds([]);
          setRosterReady(false);
          setState("Conference membership ended");
          if (invitee && !leavingRef.current) { leavingRef.current = true; closeAll(); onLeaveRef.current?.(); }
          return;
        }
        // Original caller then callee, followed by other participants in stable ID order.
        // All devices compute exactly the same order; only the local 'You' label differs.
        const { data: originalCall, error: callError } = await supabase.from("calls")
          .select("caller_id,callee_id").eq("id", callId).maybeSingle();
        if (callError) throw callError;
		
        const originalOrder = [originalCall?.caller_id, originalCall?.callee_id]
          .filter((id): id is string => Boolean(id) && activeParticipantIds.includes(id as string));
        setOriginalIds(previous => previous.join("|") === originalOrder.join("|") ? previous : originalOrder);
        const ordered = [...new Set([...originalOrder, ...activeParticipantIds.sort()])].slice(0, 8);
        setParticipantIds(previous => previous.join("|") === ordered.join("|") ? previous : ordered);
        setRosterReady(true);
        const { data: rows, error: rowsError } = await supabase.rpc("ensure_direct_conference_peers", { requested_call_id: callId });
        if (rowsError) throw rowsError;
        const sessions = (rows || []) as PeerRow[];
        sessionPeersRef.current = new Map(sessions.map(s => [s.id, { peer_a_id: s.peer_a_id, peer_b_id: s.peer_b_id }]));
        if (!sessions.length) {
          for (const runtime of peers.current.values()) { try { runtime.pc.close(); } catch {} }
          peers.current.clear();
          sessionPeersRef.current.clear();
          updateRemotes();
          setState("Waiting for another participant…");
          return;
        }
        if (!streamRef.current) {
          if (sharedStream) streamRef.current = sharedStream;
          else if (invitee) {
            await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: "doNotMix" });
            const media = await mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: "user" } : false });
            if (cancelled || stoppedRef.current) { media.getTracks().forEach(t => t.stop()); return; }
            streamRef.current = media; ownedRef.current = true; setOwnStream(media);
          } else { setState("Waiting for original call media…"); return; }
        }
        const activeIds = new Set(sessions.map(s => s.id));
        for (const [id, runtime] of peers.current) {
          if (!activeIds.has(id)) { runtime.pc.close(); peers.current.delete(id); updateRemotes(); }
        }
        for (const row of sessions) {
          if (cancelled || stoppedRef.current) return;
          let runtime = peers.current.get(row.id);
          if (runtime && runtime.generation !== row.generation) { runtime.pc.close(); peers.current.delete(row.id); runtime = undefined; }
          if (!runtime) {
            const pc = new RTCPeerConnection({ iceServers: await iceServers(), iceTransportPolicy: "all" } as any);
            runtime = { pc, generation: row.generation, remote: null, seen: new Set(), pending: [], offered: false, answering: false, answered: false };
            peers.current.set(row.id, runtime);
            const local = streamRef.current;
            if (local) local.getTracks().forEach(track => pc.addTrack(track, local));
            const sessionId = row.id, generation = row.generation;
            pc.onicecandidate = (event: any) => {
              if (!event.candidate || stoppedRef.current) return;
              const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
              void supabase.rpc("add_direct_conference_ice", { requested_peer_session_id: sessionId, requested_candidate: candidate, requested_generation: generation }).then(({ error }) => { if (error) console.warn("[CONF ICE]", error.message); });
            };
            pc.ontrack = (event: any) => {
              const current = peers.current.get(sessionId);
              if (!current || stoppedRef.current) return;
              if (event.streams?.[0]) current.remote = event.streams[0];
              else {
                if (!current.remote) current.remote = new MediaStream();
                if (event.track && !current.remote.getTracks().some(t => t.id === event.track.id)) current.remote.addTrack(event.track);
              }
              updateRemotes();
            };
            pc.onconnectionstatechange = () => { if (!stoppedRef.current) setState(`Conference peer: ${pc.connectionState}`); };
          }
          const pc = runtime.pc;
          // The database assigns a deterministic offerer. No glare or A-B renegotiation.
          if (row.offerer_id === userId && !row.offer && !runtime.offered && pc.signalingState === "stable") {
            runtime.offered = true;
            try {
              const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: video });
              await pc.setLocalDescription(offer);
              const { error } = await supabase.rpc("write_direct_conference_sdp", { requested_peer_session_id: row.id, requested_kind: "offer", requested_description: offer.toJSON ? offer.toJSON() : offer, requested_generation: row.generation });
              if (error) throw error;
            } catch (e) { console.warn("[CONF OFFER]", e); runtime.offered = false; }
          }
          if (row.offerer_id !== userId && row.offer && !runtime.answering && !runtime.answered && pc.signalingState === "stable") {
            runtime.answering = true;
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(row.offer));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              const { error } = await supabase.rpc("write_direct_conference_sdp", { requested_peer_session_id: row.id, requested_kind: "answer", requested_description: answer.toJSON ? answer.toJSON() : answer, requested_generation: row.generation });
              if (error) throw error;
              runtime.answered = true;
            } catch (e) { console.warn("[CONF ANSWER]", e); }
            finally { runtime.answering = false; }
          }
          if (row.offerer_id === userId && row.answer && !runtime.answered && pc.signalingState === "have-local-offer") {
            try { await pc.setRemoteDescription(new RTCSessionDescription(row.answer)); runtime.answered = true; }
            catch (e) { console.warn("[CONF REMOTE ANSWER]", e); }
          }
          const { data: candidates, error: iceError } = await supabase.from("direct_conference_ice_candidates").select("id,sender_id,generation,candidate").eq("peer_session_id", row.id).eq("generation", row.generation).neq("sender_id", userId).order("id", { ascending: true });
          if (iceError) throw iceError;
          for (const c of (candidates || []) as CandidateRow[]) {
            if (runtime.seen.has(c.id)) continue;
            if (!pc.remoteDescription) { if (!runtime.pending.some(p => p.id === c.id)) runtime.pending.push(c); continue; }
            try { await pc.addIceCandidate(new RTCIceCandidate(c.candidate)); runtime.seen.add(c.id); }
            catch (e) { console.warn("[CONF REMOTE ICE]", e); }
          }
          if (pc.remoteDescription && runtime.pending.length) {
            const pending = runtime.pending.splice(0);
            for (const c of pending) {
              if (runtime.seen.has(c.id)) continue;
              try { await pc.addIceCandidate(new RTCIceCandidate(c.candidate)); runtime.seen.add(c.id); }
              catch (e) { console.warn("[CONF PENDING ICE]", e); }
            }
          }
        }
      } catch (error) { console.warn("[CONF MEDIA]", error); if (!stoppedRef.current) setState("Conference connection issue"); }
      finally { busyRef.current = false; }
    };
    void tick();
    const interval = setInterval(() => { void tick(); }, 1500);
    return () => { cancelled = true; clearInterval(interval); closeAll(); };
  }, [callId, userId, invitee, video, sharedStream, closeAll, updateRemotes]);

  const local = sharedStream || ownStream;
  const mutedNow = mutedExternal ?? muted;
  const cameraNow = cameraEnabledExternal ?? cameraOn;
  const speakerNow = speakerOnExternal ?? speakerLocal;
  const remoteById = new Map<string, MediaStream>();
  // Each mesh session is one other participant; never touch the direct A-B peer.
  for (const [sessionId, runtime] of peers.current) {
    const session = sessionPeersRef.current.get(sessionId);
    if (!session || !runtime.remote) continue;
    const otherId = session.peer_a_id === userId ? session.peer_b_id : session.peer_a_id;
    remoteById.set(otherId, runtime.remote);
  }
  const orderedIds = rosterReady ? participantIds : [userId];
  const tiles = orderedIds.map((id, index) => ({
    id, index, isSelf: id === userId,
    stream: id === userId ? local : remoteById.get(id) || null,
  }));
  // Invitees leave only their conference membership. A/B retain the existing
  // direct-call end behavior, which must not be changed by this sprint.
  const leaveConference = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);

    // Exit immediately on C. Never block screen dismissal on network/RLS.
    // A/B keep their existing direct-call leave/end callback.
    closeAll();
    onLeaveRef.current?.();
    if (!invitee) return;

    // Best-effort membership synchronization after local exit.
    // Failure is logged rather than trapping the user on the conference screen.
    void (async () => {
      try {
        const { data: conference, error: conferenceError } = await supabase
          .from("direct_call_conferences").select("id").eq("call_id", callId).maybeSingle();
        if (conferenceError) throw conferenceError;
        if (!conference) throw new Error("Conference not found");
        const { data: changed, error: leaveError } = await supabase
          .from("direct_call_conference_participants")
          .update({ status: "left" })
          .eq("conference_id", conference.id)
          .eq("user_id", userId)
          .neq("status", "left")
          .select("user_id");
        if (leaveError) throw leaveError;
        if (!changed?.length) throw new Error("Membership was not updated; verify conference RLS policy.");
      } catch (error) {
        console.warn("[CONF LEAVE] Local exit succeeded; membership sync failed:", error);
      }
    })();
  };

  // Server RPC enforces original-caller authorization; UI visibility is not security.
  const removeParticipant = async (targetId: string) => {
    if (invitee || !originalIds.includes(userId) || originalIds.includes(targetId) || removingId) return;
    setRemovingId(targetId);
    try {
      const { error } = await supabase.rpc("remove_direct_conference_participant", {
        requested_call_id: callId,
        requested_user_id: targetId,
      });
      if (error) throw error;
      setParticipantIds(previous => previous.filter(id => id !== targetId));
      setManageOpen(false);
    } catch (error) {
      console.warn("[CONF REMOVE]", error);
      Alert.alert("Could not remove participant", error instanceof Error ? error.message : "Please try again.");
    } finally { setRemovingId(null); }
  };
  const confirmRemove = (targetId: string) => {
    const name = profiles[targetId]?.name || "this participant";
    Alert.alert("Remove participant", `Remove ${name} from this conference?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => { void removeParticipant(targetId); } },
    ]);
  };
  const toggleMuteLocal = () => {
    if (onToggleMute) { onToggleMute(); return; }
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach(track => { track.enabled = !next; });
    setMuted(next);
  };
  const toggleCameraLocal = () => {
    if (onToggleCamera) { onToggleCamera(); return; }
    const next = !cameraOn;
    streamRef.current?.getVideoTracks().forEach(track => { track.enabled = next; });
    setCameraOn(next);
  };
  const toggleSpeakerLocal = () => {
    if (onToggleSpeaker) { onToggleSpeaker(); return; }
    const next = !speakerLocal;
    InCallManager.setForceSpeakerphoneOn(next);
    setSpeakerLocal(next);
  };
  return <View style={styles.fullScreen}>
    <View style={styles.header}>
      <Text style={styles.heading}>Global Qall — Conference</Text>
      <Text style={styles.count}>{orderedIds.length} participant{orderedIds.length === 1 ? "" : "s"}</Text>
    </View>
    <Text style={styles.status} numberOfLines={1}>{state}</Text>
    {!video ? (
      <ScrollView style={styles.audioScroll} contentContainerStyle={styles.audioGrid} showsVerticalScrollIndicator={false}>
        {tiles.slice(0, 8).map((tile, index) => {
          const profile = profiles[tile.id];
          const label = tile.isSelf ? "You" : (profile?.name || `Participant ${index + 1}`);
          const shades = ["#B43D64", "#B82C78", "#597CA1", "#C35C70", "#656B87", "#A94752", "#A16A60", "#9B8B59"];
          return <View key={tile.id} style={[styles.audioTile, { backgroundColor: shades[index % shades.length], width: landscape ? "23%" : "48%" }]}>
            <View style={styles.audioTileTop}>
              {tile.isSelf && mutedNow && <Ionicons name="mic-off" size={15} color="#FFFFFF" />}
            </View>
            <View style={styles.avatarCircle}>
              {profile?.avatar ? <Image source={{ uri: profile.avatar }} style={styles.avatarImage} /> :
                <Text style={styles.avatarInitial}>{(profile?.name || label).charAt(0).toUpperCase()}</Text>}
            </View>
            <Text style={styles.audioName} numberOfLines={1}>{label}</Text>
          </View>;
        })}
      </ScrollView>
    ) : (
    <View style={[styles.stage, landscape && styles.stageLandscape]}>
      {tiles.map((tile, index) => {
        const activeVideo = Boolean(video && tile.stream && (!tile.isSelf || cameraNow) && tile.stream.getVideoTracks().length);
        return <View key={tile.id} style={[styles.tile, index === 0 && !landscape && styles.featuredTile, landscape && styles.landscapeTile]}>
          {activeVideo ? <RTCView streamURL={tile.stream!.toURL()} style={styles.video} objectFit="cover" mirror={tile.isSelf} /> :
            <View style={styles.placeholder}><Ionicons name={video ? "person" : "mic"} size={42} color="#E2E8F0" /></View>}
          <View style={styles.nameTag}><Text style={styles.tileText}>{tile.isSelf ? "You" : `Participant ${index + 1}`}</Text></View>
        </View>;
      })}
    </View>
    )}
    {!video && !invitee && originalIds.includes(userId) && <Pressable accessibilityRole="button" accessibilityLabel="Manage conference participants" onPress={() => setManageOpen(true)} style={styles.manageButton}>
      <Ionicons name="people-outline" size={18} color="#FFFFFF" />
      <Text style={styles.manageText}>Manage participants</Text>
    </Pressable>}
    <Modal visible={manageOpen && !video} transparent animationType="fade" onRequestClose={() => setManageOpen(false)}>
      <View style={styles.manageBackdrop}>
        <View style={styles.managePanel}>
          <Text style={styles.manageHeading}>Conference participants</Text>
          <ScrollView style={styles.manageList}>
            {participantIds.map(id => {
              const isOriginal = originalIds.includes(id);
              const canRemove = !isOriginal && id !== userId && !invitee;
              return <View key={id} style={styles.manageRow}>
                <Text style={styles.manageName} numberOfLines={1}>{id === userId ? "You" : (profiles[id]?.name || "Participant")}</Text>
                <Text style={styles.manageRole}>{isOriginal ? "Original" : "Invited"}</Text>
                {canRemove && <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${profiles[id]?.name || "participant"}`} disabled={Boolean(removingId)} onPress={() => confirmRemove(id)} style={styles.removeButton}>
                  <Text style={styles.removeText}>{removingId === id ? "Removing…" : "Remove"}</Text>
                </Pressable>}
              </View>;
            })}
          </ScrollView>
          <Pressable accessibilityRole="button" accessibilityLabel="Close participant management" onPress={() => setManageOpen(false)} style={styles.manageClose}>
            <Text style={styles.manageCloseText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={mutedNow ? "Unmute" : "Mute"} onPress={toggleMuteLocal} style={styles.control}>
        <View style={[styles.controlCircle, mutedNow && styles.controlActive]}><Ionicons name={mutedNow ? "mic-off" : "mic"} size={24} color="white" /></View>
        <Text style={styles.controlText}>{mutedNow ? "Unmute" : "Mute"}</Text>
      </Pressable>
      {video && <Pressable accessibilityRole="button" accessibilityLabel={cameraNow ? "Camera off" : "Camera on"} onPress={toggleCameraLocal} style={styles.control}>
        <View style={[styles.controlCircle, !cameraNow && styles.controlActive]}><Ionicons name={cameraNow ? "videocam" : "videocam-off"} size={24} color="white" /></View>
        <Text style={styles.controlText}>Camera</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="Speaker" onPress={toggleSpeakerLocal} style={styles.control}>
        <View style={[styles.controlCircle, speakerNow && styles.controlActive]}><Ionicons name={speakerNow ? "volume-high" : "volume-medium"} size={24} color="white" /></View>
        <Text style={styles.controlText}>Speaker</Text>
      </Pressable>
      {!video && onAddParticipant && <Pressable accessibilityRole="button" accessibilityLabel="Add participant" onPress={onAddParticipant} style={styles.control}>
        <View style={styles.controlCircle}><Ionicons name="person-add" size={23} color="white" /></View>
        <Text style={styles.controlText}>Add</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="Leave conference" disabled={leaving} onPress={() => { void leaveConference(); }} style={styles.control}>
        <View style={[styles.controlCircle, styles.leave]}><Ionicons name="call" size={24} color="white" style={{ transform: [{ rotate: "135deg" }] }} /></View>
        <Text style={styles.controlText}>Leave</Text>
      </Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  manageButton: { flexDirection: "row", alignSelf: "center", alignItems: "center", gap: 7, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 20, backgroundColor: "#334155" },
  manageText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  manageBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "center", padding: 22 },
  managePanel: { backgroundColor: "#1E293B", borderRadius: 18, padding: 18, maxHeight: "75%" },
  manageHeading: { color: "white", fontSize: 18, fontWeight: "800", marginBottom: 14 },
  manageList: { flexGrow: 0 },
  manageRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#475569" },
  manageName: { color: "white", flex: 1, fontSize: 13, fontWeight: "600" },
  manageRole: { color: "#CBD5E1", fontSize: 11 },
  removeButton: { backgroundColor: "#B91C1C", borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9 },
  removeText: { color: "white", fontSize: 12, fontWeight: "700" },
  manageClose: { alignSelf: "flex-end", padding: 12, marginTop: 10 },
  manageCloseText: { color: "#FFFFFF", fontWeight: "700" },
  fullScreen: { ...StyleSheet.absoluteFillObject, zIndex: 200, elevation: 20, backgroundColor: "#101820", paddingTop: 58, paddingHorizontal: 14, paddingBottom: 22 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 },
  heading: { color: "white", fontSize: 18, fontWeight: "800", flexShrink: 1 },
  count: { color: "#E2E8F0", fontSize: 12, backgroundColor: "#334155", paddingHorizontal: 9, paddingVertical: 6, borderRadius: 14 },
  status: { color: "#94A3B8", fontSize: 11, textAlign: "center", marginBottom: 12 },
  stage: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignContent: "center", justifyContent: "center", gap: 8, minHeight: 0 },
  stageLandscape: { flexWrap: "nowrap", alignItems: "center" },
  tile: { width: "48%", height: "33%", minHeight: 110, borderRadius: 12, overflow: "hidden", backgroundColor: "#334155" },
  featuredTile: { width: "100%", height: "52%" },
  landscapeTile: { flex: 1, width: undefined, height: "92%" },
  video: { width: "100%", height: "100%" },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  nameTag: { position: "absolute", bottom: 7, left: 7, backgroundColor: "rgba(15,23,42,0.75)", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8 },
  tileText: { color: "white", fontSize: 12, fontWeight: "700" },
  audioScroll: { flex: 1, minHeight: 0 },
  audioGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignContent: "flex-start", gap: 9, paddingBottom: 12 },
  audioTile: { height: 126, borderRadius: 12, alignItems: "center", justifyContent: "center", overflow: "hidden", paddingHorizontal: 8 },
  audioTileTop: { position: "absolute", top: 9, right: 10 },
  avatarCircle: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFFFFF40", overflow: "hidden", alignItems: "center", justifyContent: "center" },
  avatarImage: { width: 58, height: 58, borderRadius: 29 },
  avatarInitial: { color: "#FFFFFF", fontWeight: "800", fontSize: 24 },
  audioName: { color: "#FFFFFF", fontSize: 12, marginTop: 8, fontWeight: "600", textAlign: "center" },
  actions: { flexDirection: "row", justifyContent: "space-evenly", alignItems: "center", paddingTop: 12, gap: 4 },
  control: { alignItems: "center", gap: 5, minWidth: 58 },
  controlCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: "#475569", alignItems: "center", justifyContent: "center" },
  controlActive: { backgroundColor: "#176B5B" },
  leave: { backgroundColor: "#DC2626" },
  controlText: { color: "white", fontSize: 11 },
});
