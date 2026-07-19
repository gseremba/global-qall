import Ionicons from "@expo/vector-icons/Ionicons";
import {
  router,
  Stack,
} from "expo-router";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  useCallback,
  useEffect,
  useState,
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

function statusLabel(item: HistoryItem): string {
  if (
    item.status === "missed" &&
    item.direction === "incoming"
  ) {
    return "Missed incoming call";
  }

  const labels: Record<string, string> = {
    ringing: "Ringing",
    accepted: "Connected",
    declined: "Declined",
    ended: "Completed",
    missed: "No answer",
    failed: "Failed",
  };

  return `${
    item.direction === "incoming"
      ? "Incoming"
      : "Outgoing"
  } · ${labels[item.status] ?? item.status}`;
}

export default function CallHistoryScreen() {
  const { user } = useAuth();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] =
    useState<"all" | "missed">("all");

  const loadHistory = useCallback(async () => {
    if (!user) {
      return;
    }

    try {
      await expireStaleCalls();

      const { data: calls, error } = await supabase
        .from("calls")
        .select("*")
        .or(
          `caller_id.eq.${user.id},callee_id.eq.${user.id}`
        )
        .order("created_at", {
          ascending: false,
        })
        .limit(100);

      if (error) {
        throw error;
      }

      const callRows = (calls ?? []) as VoiceCall[];
      const otherIds = Array.from(
        new Set(
          callRows.map((call) =>
            call.caller_id === user.id
              ? call.callee_id
              : call.caller_id
          )
        )
      );

      const { data: profiles, error: profileError } =
        otherIds.length > 0
          ? await supabase
              .from("profiles")
              .select(
                "id, display_name, qall_id, avatar_url"
              )
              .in("id", otherIds)
          : { data: [], error: null };

      if (profileError) {
        throw profileError;
      }

      const profileMap = new Map(
        (profiles ?? []).map((profile) => [
          profile.id,
          profile,
        ])
      );

      setItems(
        callRows.map((call) => {
          const outgoing =
            call.caller_id === user.id;
          const otherId = outgoing
            ? call.callee_id
            : call.caller_id;
          const profile = profileMap.get(otherId);

          return {
            ...call,
            other_user_id: otherId,
            other_name:
              profile?.display_name ??
              "Global Qall User",
            other_qall_id:
              profile?.qall_id ?? "",
            other_avatar_url:
              profile?.avatar_url ?? null,
            direction: outgoing
              ? "outgoing"
              : "incoming",
          };
        })
      );
    } catch (error) {
      Alert.alert(
        "Call history error",
        error instanceof Error
          ? error.message
          : "Could not load call history."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadHistory, user]);

  const missedItems = items.filter(
    (item) =>
      item.status === "missed" &&
      item.direction === "incoming"
  );

  const displayedItems =
    filter === "missed" ? missedItems : items;

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

          <View style={styles.headerSpacer} />
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
              {missedItems.length > 0
                ? ` (${missedItems.length})`
                : ""}
            </Text>
          </Pressable>
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
                  {filter === "missed"
                    ? "No missed calls"
                    : "No calls yet"}
                </Text>
                <Text style={styles.emptyText}>
                  {filter === "missed"
                    ? "Missed incoming calls will appear here."
                    : "Your Global Qall call history will appear here."}
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const missed =
                item.status === "missed" &&
                item.direction === "incoming";

              return (
                <View style={styles.row}>
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
                        {item.call_type === "video"
                          ? `Video · ${statusLabel(item)}`
                          : `Voice · ${statusLabel(item)}`}
                      </Text>
                    </View>

                    <Text style={styles.time}>
                      {formatWhen(item.created_at)}
                    </Text>
                  </View>

                  <Pressable
                    onPress={() => void callAgain(item)}
                    style={styles.callButton}
                  >
                    <Ionicons
                      name="call-outline"
                      size={22}
                      color="#176B5B"
                    />
                  </Pressable>
                </View>
              );
            }}
          />
        )}
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
