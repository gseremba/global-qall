import Ionicons from "@expo/vector-icons/Ionicons";
import {
  router,
  Stack,
  useFocusEffect,
} from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Modal,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  TextInput,
  Text,
  View,
} from "react-native";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
} from "react";

import { UserAvatar } from "../components/UserAvatar";
import { useAuth } from "../contexts/AuthContext";
import {
  createVideoCall,
  createVoiceCall,
  expireStaleCalls,
  type VoiceCall,
} from "../lib/calling";
import { supabase } from "../lib/supabase";

type HistoryItem = VoiceCall & {
  other_user_id: string;
  other_name: string;
  other_qall_id: string;
  other_avatar_url: string | null;
  direction: "incoming" | "outgoing";
};

function formatWhen(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(item: HistoryItem): string | null {
  if (!item.answered_at || !item.ended_at) return null;

  const startedAt = new Date(item.answered_at).getTime();
  const endedAt = new Date(item.ended_at).getTime();
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));

  if (!Number.isFinite(totalSeconds)) return null;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

type DateFilter = "all" | "today" | "7days" | "30days";

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function historyDayLabel(value: string, now: Date): string {
  const date = new Date(value);
  const day = startOfLocalDay(date).getTime();
  const today = startOfLocalDay(now).getTime();
  if (day === today) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (day === yesterday) return "Yesterday";
  return date.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

function statusLabel(item: HistoryItem): string {
  if (
    item.status === "missed" &&
    item.direction === "incoming"
  ) {
    return "Missed incoming call";
  }

  const direction =
    item.direction === "incoming"
      ? "Incoming"
      : "Outgoing";

  if (item.status === "missed") {
    return `${direction}: No answer`;
  }

  if (item.status === "declined") {
    return `${direction}: Call declined`;
  }

  if (item.status === "failed") {
    const failureLabel =
      item.end_reason === "unreachable"
        ? "User unavailable"
        : item.end_reason === "connecting_timeout"
          ? "Unable to connect"
          : item.end_reason === "connection_lost"
            ? "Connection lost"
            : item.end_reason === "busy"
              ? "User is busy"
              : "Call failed";

    return `${direction}: ${failureLabel}`;
  }

  const labels: Record<string, string> = {
    ringing: "Ringing",
    accepted: "Connected",
    ended: "Completed",
  };

  return `${direction}: ${
    labels[item.status] ?? item.status
  }`;
}

export default function CallHistoryScreen() {
  const { user } = useAuth();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] =
    useState<"all" | "missed" | "incoming" | "outgoing">("all");

  const [searchText, setSearchText] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [queryDay, setQueryDay] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchText.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchText]);
  useFocusEffect(useCallback(() => {
    setQueryDay(new Date());
  }, []));
  const dateStart = dateFilter === "all" ? null :
    dateFilter === "today" ? startOfLocalDay(queryDay).toISOString() :
    new Date(queryDay.getFullYear(), queryDay.getMonth(),
      queryDay.getDate() - (dateFilter === "7days" ? 6 : 29)).toISOString();
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Server-side filters determine the returned page, not the client list.
  const pageRef = useRef(0);
  const requestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(false);
  const PAGE_SIZE = 30;

  const loadHistory = useCallback(async (append = false) => {
    if (!user) return;
    if (!append) {
      // Invalidate an older page request before starting a new query.
      hasMoreRef.current = false;
      setHasMore(false);
      setLoading(true);
    }
    if (append) {
      if (loadingMoreRef.current || !hasMoreRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }
    const requestId = ++requestRef.current;
    const page = append ? pageRef.current : 0;
    try {
      if (!append) await expireStaleCalls();
      const { data: calls, error } = await supabase.rpc("search_visible_call_history", {
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
        p_search: debouncedSearch,
        p_direction: filter,
        p_since: dateStart,
      });
      if (error) throw error;
      const callRows = (calls ?? []) as VoiceCall[];
      const otherIds = Array.from(new Set(callRows.map(call =>
        call.caller_id === user.id ? call.callee_id : call.caller_id
      )));
      const { data: profiles, error: profileError } = otherIds.length
        ? await supabase.from("profiles")
            .select("id, display_name, qall_id, avatar_url")
            .in("id", otherIds)
        : { data: [], error: null };
      if (profileError) throw profileError;
      const profileMap = new Map((profiles ?? []).map(profile => [profile.id, profile]));
      const nextItems: HistoryItem[] = callRows.map(call => {
        const outgoing = call.caller_id === user.id;
        const otherId = outgoing ? call.callee_id : call.caller_id;
        const profile = profileMap.get(otherId);
        return {
          ...call,
          other_user_id: otherId,
          other_name: profile?.display_name ?? "Global Qall User",
          other_qall_id: profile?.qall_id ?? "",
          other_avatar_url: profile?.avatar_url ?? null,
          direction: outgoing ? "outgoing" : "incoming",
        };
      });
      if (requestId !== requestRef.current) return;
      pageRef.current = page + 1;
      hasMoreRef.current = callRows.length === PAGE_SIZE;
      setHasMore(hasMoreRef.current);
      setItems(previous => append
        ? Array.from(new Map([...previous, ...nextItems].map(item => [item.id, item])).values())
        : nextItems);
    } catch (error) {
      if (requestId === requestRef.current) Alert.alert("Call history error",
        error instanceof Error ? error.message : "Could not load call history.");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
      if (append) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [user, debouncedSearch, filter, dateStart]);

  // Opening Call History acknowledges missed calls up to the current time.
  // A call becoming missed later remains unread until the next visit.
  useFocusEffect(useCallback(() => {
    if (!user) return;
    void (async () => {
      const viewedAt = new Date().toISOString();
      const { error } = await supabase.from("profiles")
        .update({ call_history_last_viewed_at: viewedAt })
        .eq("id", user.id);
      if (error) console.warn("[CALL HISTORY] Could not mark viewed:", error.message);
      await loadHistory();
    })();
  }, [user, loadHistory]));

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!user) {
      return;
    }

    const channel = supabase
      .channel(`call-history-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "calls",
        },
        (payload) => {
          const row = (
            payload.new ?? payload.old
          ) as Partial<VoiceCall>;

          if (
            row.caller_id === user.id ||
            row.callee_id === user.id
          ) {
            void loadHistory();
          }
        }
      )
      .on("postgres_changes", {
        event: "*", schema: "public", table: "call_history_hidden", filter: `user_id=eq.${user.id}`,
      }, () => { void loadHistory(); })
      .on("postgres_changes", {
        event: "*", schema: "public", table: "call_history_settings", filter: `user_id=eq.${user.id}`,
      }, () => { void loadHistory(); })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadHistory, user]);

  const normalizedSearch = debouncedSearch.toLocaleLowerCase();
  const nowForFilters = new Date();
  const displayedItems = items;

  const emptyTitle = normalizedSearch
    ? "No matching calls"
    : dateFilter !== "all"
      ? "No calls in this period"
      : filter === "missed"
        ? "No missed calls"
        : filter === "incoming"
          ? "No incoming calls"
          : filter === "outgoing"
            ? "No outgoing calls"
            : "No calls yet";
  const emptyDescription = normalizedSearch || dateFilter !== "all"
    ? "Try another search or change your filters."
    : filter === "missed"
      ? "Missed incoming calls will appear here."
      : "Your Global Qall call history will appear here.";

  async function hideCalls(callIds: string[]) {
    if (!user || busy || callIds.length === 0) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("call_history_hidden").upsert(
        callIds.map((call_id) => ({ user_id: user.id, call_id })),
        { onConflict: "user_id,call_id" }
      );
      if (error) throw error;
      setSelected(null);
      await loadHistory();
    } catch (error) {
      Alert.alert("Call history error", error instanceof Error ? error.message : "Could not update history.");
    } finally {
      setBusy(false);
    }
  }

  function confirmHide(item: HistoryItem) {
    Alert.alert("Delete from history?", "This call will be hidden only from your history.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void hideCalls([item.id]) },
    ]);
  }

  async function clearEntireHistory() {
    if (!user || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("clear_my_call_history");
      if (error) throw error;
      setSelected(null);
      await loadHistory();
    } catch (error) {
      Alert.alert("Call history error", error instanceof Error ? error.message : "Could not clear history.");
    } finally {
      setBusy(false);
    }
  }

  function confirmClear() {
    if (busy) return;
    Alert.alert("Clear call history?", "Your entire call history, including older calls, will be hidden from your account only. This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear history", style: "destructive", onPress: () => void clearEntireHistory() },
    ]);
  }

  async function callAgain(item: HistoryItem) {
    try {
      const callId =
        item.call_type === "video"
          ? await createVideoCall(
              item.other_user_id
            )
          : await createVoiceCall(
              item.other_user_id
            );

      router.push({
        pathname: "/call/[callId]",
        params: {
          callId,
          direction: "outgoing",
        },
      });
    } catch (error) {
      Alert.alert(
        "Call error",
        error instanceof Error
          ? error.message
          : "Could not start the call."
      );
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Ionicons
              name="chevron-back"
              size={24}
              color="#176B5B"
            />
            <Text style={styles.backText}>Qall</Text>
          </Pressable>

          <Text style={styles.heading}>Call History</Text>

          <Pressable onPress={confirmClear} disabled={busy} style={styles.headerSpacer} accessibilityLabel="Clear call history">
            <Ionicons name="trash-outline" size={21} color="#B42318" />
          </Pressable>
        </View>

        <View style={styles.filters}>
          <Pressable
            onPress={() => setFilter("all")}
            style={[
              styles.filterButton,
              filter === "all" &&
                styles.filterButtonActive,
            ]}
          >
            <Text
              style={[
                styles.filterText,
                filter === "all" &&
                  styles.filterTextActive,
              ]}
            >
              All
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setFilter("missed")}
            style={[
              styles.filterButton,
              filter === "missed" &&
                styles.filterButtonActive,
            ]}
          >
            <Text
              style={[
                styles.filterText,
                filter === "missed" &&
                  styles.filterTextActive,
              ]}
            >
              Missed

            </Text>
          </Pressable>
          {(["incoming", "outgoing"] as const).map((value) => (
            <Pressable key={value} onPress={() => setFilter(value)} style={[styles.filterButton, filter === value && styles.filterButtonActive]}>
              <Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{value === "incoming" ? "Incoming" : "Outgoing"}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.searchContainer}>
          <Ionicons name="search-outline" size={19} color="#65706D" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search name or Qall ID"
            placeholderTextColor="#8A9591"
            value={searchText}
            onChangeText={setSearchText}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search call history"
          />
          {searchText.length > 0 && (
            <Pressable onPress={() => setSearchText("")} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={19} color="#65706D" />
            </Pressable>
          )}
        </View>
        <View style={styles.dateFilters}>
          {([
            ["all", "All Time"],
            ["today", "Today"],
            ["7days", "Last 7 Days"],
            ["30days", "Last 30 Days"],
          ] as const).map(([value, label]) => (
            <Pressable
              key={value}
              onPress={() => setDateFilter(value)}
              style={[styles.dateButton, dateFilter === value && styles.dateButtonActive]}
            >
              <Text style={[styles.dateButtonText, dateFilter === value && styles.dateButtonTextActive]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator
              size="large"
              color="#176B5B"
            />
          </View>
        ) : (
          <FlatList
            data={displayedItems}
            onEndReached={() => { if (hasMore && !loadingMore) void loadHistory(true); }}
            onEndReachedThreshold={0.4}
            ListFooterComponent={loadingMore ? <ActivityIndicator color="#176B5B" style={{ padding: 16 }} /> : null}
            keyExtractor={(item) => item.id}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => {
                  setRefreshing(true);
                  void loadHistory();
                }}
                tintColor="#176B5B"
              />
            }
            contentContainerStyle={[
              styles.list,
              displayedItems.length === 0 && styles.emptyList,
            ]}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons
                  name="time-outline"
                  size={48}
                  color="#176B5B"
                />
                <Text style={styles.emptyTitle}>
                  {emptyTitle}
                </Text>
                <Text style={styles.emptyText}>
                  {emptyDescription}
                </Text>
              </View>
            }
            renderItem={({ item, index }) => {
              const dayLabel = historyDayLabel(item.created_at, nowForFilters);
              const previousDayLabel = index > 0
                ? historyDayLabel(displayedItems[index - 1].created_at, nowForFilters)
                : null;
              const showDayHeader = dayLabel !== previousDayLabel;
              const missed =
                item.status === "missed" &&
                item.direction === "incoming";
              const duration = formatDuration(item);

              return (
                <View>
                  {showDayHeader && <Text style={styles.dayHeader}>{dayLabel}</Text>}
                <View style={styles.row}>
                  <Pressable onPress={() => setSelected(item)} style={styles.rowMain} accessibilityLabel={`View details for ${item.other_name}`}>
                  <UserAvatar
                    avatarUrl={item.other_avatar_url}
                    name={item.other_name}
                    size={50}
                  />

                  <View style={styles.details}>
                    <Text
                      style={[
                        styles.name,
                        missed && styles.missed,
                      ]}
                    >
                      {item.other_name}
                    </Text>

                    <View style={styles.metaRow}>
                      <Ionicons
                        name={
                          item.call_type === "video"
                            ? "videocam-outline"
                            : item.direction === "incoming"
                              ? "arrow-down"
                              : "arrow-up"
                        }
                        size={14}
                        color={
                          missed
                            ? "#B42318"
                            : "#65706D"
                        }
                      />
                      <Text
                        style={[
                          styles.meta,
                          missed && styles.missed,
                        ]}
                      >
                        {`${item.call_type === "video" ? "Video" : "Voice"} · ${statusLabel(item)}${duration ? ` · ${duration}` : ""}`}
                      </Text>
                    </View>

                    <Text style={styles.time}>
                      {formatWhen(item.created_at)}
                    </Text>
                  </View>

                  </Pressable>
                  <Pressable
                    onPress={() => void callAgain(item)}
                    style={styles.callButton}
                  >
                    <Ionicons
                      name={
                        item.call_type === "video"
                          ? "videocam-outline"
                          : "call-outline"
                      }
                      size={22}
                      color="#176B5B"
                    />
                  </Pressable>
                </View>
                </View>
              );
            }}
          />
        )}
        <Modal visible={selected !== null} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Call details</Text>
              {selected && <>
                <Text style={styles.modalName}>{selected.other_name}</Text>
                <Text style={styles.modalLine}>Qall ID: {selected.other_qall_id || "Unavailable"}</Text>
                <Text style={styles.modalLine}>Type: {selected.call_type === "video" ? "Video" : "Voice"}</Text>
                <Text style={styles.modalLine}>Direction: {selected.direction}</Text>
                <Text style={styles.modalLine}>Status: {statusLabel(selected)}</Text>
                <Text style={styles.modalLine}>Date: {new Date(selected.created_at).toLocaleString()}</Text>
                <Text style={styles.modalLine}>Duration: {formatDuration(selected) ?? "Not connected"}</Text>
                <View style={styles.modalActions}>
                  <Pressable style={styles.modalAction} onPress={() => setSelected(null)}><Text>Close</Text></Pressable>
                  <Pressable style={styles.modalAction} onPress={() => confirmHide(selected)} disabled={busy}><Text style={styles.missed}>Delete</Text></Pressable>
                </View>
              </>}
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F7F8FA",
  },
  header: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#DCE3E0",
    backgroundColor: "#FFFFFF",
  },
  backButton: {
    width: 82,
    flexDirection: "row",
    alignItems: "center",
  },
  backText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#176B5B",
  },
  heading: {
    fontSize: 17,
    fontWeight: "800",
    color: "#18201E",
  },
  headerSpacer: {
    width: 82,
  },
  filters: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 2,
  },
  filterButton: {
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 17,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 19,
    backgroundColor: "#FFFFFF",
  },
  filterButtonActive: {
    borderColor: "#176B5B",
    backgroundColor: "#E6F2EF",
  },
  filterText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#65706D",
  },
  filterTextActive: {
    color: "#176B5B",
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 12,
    marginHorizontal: 14,
    marginTop: 12,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  searchInput: {
    flex: 1,
    minHeight: 44,
    color: "#18201E",
    fontSize: 14,
  },
  dateFilters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
  },
  dateButton: {
    paddingHorizontal: 11,
    minHeight: 32,
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    backgroundColor: "#FFFFFF",
  },
  dateButtonActive: {
    backgroundColor: "#E6F2EF",
    borderColor: "#176B5B",
  },
  dateButtonText: { fontSize: 12, fontWeight: "600", color: "#65706D" },
  dateButtonTextActive: { color: "#176B5B" },
  dayHeader: {
    fontSize: 13,
    fontWeight: "800",
    color: "#65706D",
    marginTop: 8,
    marginBottom: 9,
    marginLeft: 3,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    padding: 14,
    gap: 10,
  },
  emptyList: {
    flexGrow: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  rowMain: { flex: 1, flexDirection: "row", alignItems: "center" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: "#FFFFFF", borderRadius: 18, padding: 22 },
  modalTitle: { fontSize: 20, fontWeight: "800", marginBottom: 12, color: "#18201E" },
  modalName: { fontSize: 17, fontWeight: "700", marginBottom: 8 },
  modalLine: { fontSize: 14, marginBottom: 7, color: "#35433F" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 24, marginTop: 18 },
  modalAction: { padding: 8 },
  details: {
    flex: 1,
    marginLeft: 12,
  },
  name: {
    fontSize: 16,
    fontWeight: "700",
    color: "#18201E",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  meta: {
    fontSize: 13,
    color: "#65706D",
  },
  time: {
    marginTop: 3,
    fontSize: 12,
    color: "#8A9591",
  },
  missed: {
    color: "#B42318",
  },
  callButton: {
    width: 43,
    height: 43,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: "#E6F2EF",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 80,
  },
  emptyTitle: {
    marginTop: 14,
    fontSize: 20,
    fontWeight: "800",
    color: "#18201E",
  },
  emptyText: {
    marginTop: 7,
    textAlign: "center",
    color: "#65706D",
  },
});
