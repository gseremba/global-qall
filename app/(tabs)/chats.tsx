import Ionicons from "@expo/vector-icons/Ionicons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import {UserAvatar } from "../../components/UserAvatar";

type Conversation = {
  conversation_id: string;
  other_user_id: string;
  contact_name: string;
  display_name: string | null;
  avatar_url: string | null;
  qall_id: string;
  last_message: string | null;
  last_message_at: string | null;
  last_sender_id: string | null;
  unread_count: number;
};


function formatMessageTime(value: string | null): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const now = new Date();

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

export default function ChatsScreen() {
  const { user } = useAuth();

  const [conversations, setConversations] =
    useState<Conversation[]>([]);
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadConversations = useCallback(async () => {
    if (!user) {
      setConversations([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      const { data, error } = await supabase.rpc(
        "get_my_conversations"
      );

      if (error) {
        throw error;
      }

      const baseRows = (data ?? []).map((row: any) => ({
        ...row,
        avatar_url: null,
        unread_count: Number(row.unread_count ?? 0),
      }));

      const otherUserIds = Array.from(
        new Set(
          baseRows
            .map((row: any) => row.other_user_id)
            .filter(Boolean)
        )
      );

      let avatarByUserId: Record<string, string | null> = {};

      if (otherUserIds.length > 0) {
        const { data: profileRows, error: profileError } =
          await supabase
            .from("profiles")
            .select("id, avatar_url")
            .in("id", otherUserIds);

        if (profileError) {
          throw profileError;
        }

        avatarByUserId = Object.fromEntries(
          (profileRows ?? []).map((profile: any) => [
            profile.id,
            profile.avatar_url ?? null,
          ])
        );
      }

      const rows = baseRows.map((row: any) => ({
        ...row,
        avatar_url:
          avatarByUserId[row.other_user_id] ?? null,
      }));

      setConversations(rows);
    } catch (error) {
      Alert.alert(
        "Chats error",
        error instanceof Error
          ? error.message
          : "Could not load conversations."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      loadConversations();

      const channel = supabase
        .channel(`chat-list-${user?.id ?? "guest"}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
          },
          () => {
            loadConversations();
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }, [loadConversations, user?.id])
  );

  const normalizedSearch = searchText
    .trim()
    .toLowerCase();

  const filteredConversations = conversations.filter(
    (conversation) => {
      if (!normalizedSearch) {
        return true;
      }

      return (
        conversation.contact_name
          .toLowerCase()
          .includes(normalizedSearch) ||
        conversation.qall_id
          .toLowerCase()
          .includes(normalizedSearch)
      );
    }
  );

  function openConversation(conversationId: string) {
    router.push({
      pathname: "/chat/[conversationId]",
      params: {
        conversationId,
      },
    });
  }

  function openContacts() {
    router.push("/contacts");
  }

  function renderConversation({
    item,
  }: {
    item: Conversation;
  }) {
    const sentByCurrentUser =
      item.last_sender_id === user?.id;

    return (
      <Pressable
        onPress={() =>
          openConversation(item.conversation_id)
        }
        style={({ pressed }) => [
          styles.conversationCard,
          pressed && styles.pressed,
        ]}
      >
        <UserAvatar
          avatarUrl={item.avatar_url}
          name={item.display_name ?? item.contact_name}
          size={54}
        />

        <View style={styles.conversationContent}>
          <View style={styles.conversationHeader}>
            <Text
              style={[
                styles.contactName,
                item.unread_count > 0 &&
                  styles.unreadName,
              ]}
              numberOfLines={1}
            >
              {item.contact_name}
            </Text>

            <Text
              style={[
                styles.messageTime,
                item.unread_count > 0 &&
                  styles.unreadTime,
              ]}
            >
              {formatMessageTime(item.last_message_at)}
            </Text>
          </View>

          <View style={styles.messageRow}>
            <Text
              style={[
                styles.lastMessage,
                item.unread_count > 0 &&
                  styles.unreadMessage,
              ]}
              numberOfLines={1}
            >
              {item.last_message
                ? `${
                    sentByCurrentUser ? "You: " : ""
                  }${item.last_message}`
                : "Start a conversation"}
            </Text>

            {item.unread_count > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>
                  {item.unread_count > 99
                    ? "99+"
                    : item.unread_count}
                </Text>
              </View>
            )}
          </View>

          <Text style={styles.qallId}>
            {item.qall_id}
          </Text>
        </View>
      </Pressable>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.topRow}>
          <Text style={styles.heading}>Chats</Text>

          <Pressable
            onPress={openContacts}
            style={({ pressed }) => [
              styles.newChatButton,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="create-outline"
              size={19}
              color="#FFFFFF"
            />
            <Text style={styles.newChatText}>
              New Chat
            </Text>
          </Pressable>
        </View>

        <View style={styles.searchContainer}>
          <Ionicons
            name="search-outline"
            size={20}
            color="#72807C"
          />

          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Search chats"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />

          {searchText.length > 0 && (
            <Pressable
              onPress={() => setSearchText("")}
              hitSlop={8}
            >
              <Ionicons
                name="close-circle"
                size={20}
                color="#9AA5A1"
              />
            </Pressable>
          )}
        </View>

        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator
              size="large"
              color="#176B5B"
            />
          </View>
        ) : (
          <FlatList
            data={filteredConversations}
            keyExtractor={(item) =>
              item.conversation_id
            }
            renderItem={renderConversation}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[
              styles.listContent,
              filteredConversations.length === 0 &&
                styles.emptyListContent,
            ]}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor="#176B5B"
                onRefresh={() => {
                  setRefreshing(true);
                  loadConversations();
                }}
              />
            }
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <View style={styles.emptyIcon}>
                  <Ionicons
                    name={
                      searchText
                        ? "search-outline"
                        : "chatbubbles-outline"
                    }
                    size={42}
                    color="#176B5B"
                  />
                </View>

                <Text style={styles.emptyTitle}>
                  {searchText
                    ? "No matching chats"
                    : "No conversations yet"}
                </Text>

                <Text style={styles.emptyText}>
                  {searchText
                    ? "Try another contact name or Qall ID."
                    : "Choose a contact and send your first message."}
                </Text>

                {!searchText && (
                  <Pressable
                    onPress={openContacts}
                    style={({ pressed }) => [
                      styles.emptyButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Ionicons
                      name="people-outline"
                      size={19}
                      color="#FFFFFF"
                    />
                    <Text style={styles.emptyButtonText}>
                      Open Contacts
                    </Text>
                  </Pressable>
                )}
              </View>
            }
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F7F8FA",
  },
  container: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 15,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 15,
  },
  heading: {
    fontSize: 23,
    fontWeight: "800",
    color: "#18201E",
  },
  newChatButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#176B5B",
  },
  newChatText: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  searchContainer: {
    minHeight: 49,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#18201E",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    paddingBottom: 24,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  conversationCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E6EBE9",
  },
  conversationContent: {
    flex: 1,
    marginLeft: 12,
  },
  conversationHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  contactName: {
    flex: 1,
    marginRight: 8,
    fontSize: 16,
    fontWeight: "600",
    color: "#18201E",
  },
  unreadName: {
    fontWeight: "800",
  },
  messageTime: {
    fontSize: 12,
    color: "#7B8783",
  },
  unreadTime: {
    fontWeight: "700",
    color: "#176B5B",
  },
  messageRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
  },
  lastMessage: {
    flex: 1,
    marginRight: 8,
    fontSize: 14,
    color: "#697571",
  },
  unreadMessage: {
    fontWeight: "600",
    color: "#34413D",
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: "#176B5B",
  },
  unreadBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  qallId: {
    marginTop: 4,
    fontSize: 11,
    color: "#9AA5A1",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 70,
  },
  emptyIcon: {
    width: 82,
    height: 82,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 41,
    backgroundColor: "#E6F2EF",
  },
  emptyTitle: {
    marginTop: 18,
    fontSize: 20,
    fontWeight: "700",
    color: "#18201E",
  },
  emptyText: {
    maxWidth: 280,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 21,
    color: "#65706D",
  },
  emptyButton: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 20,
    paddingHorizontal: 18,
    borderRadius: 13,
    backgroundColor: "#176B5B",
  },
  emptyButtonText: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  pressed: {
    opacity: 0.78,
  },
});