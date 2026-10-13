import Ionicons from "@expo/vector-icons/Ionicons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { UserAvatar } from "../../components/UserAvatar";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import { startGroupCall, type GroupCallType } from "../../lib/groupCalling";
import {
  createVideoCall,
  createVoiceCall,
  isUserBusyError,
} from "../../lib/calling";

type ContactProfile = {
  id: string;
  display_name: string | null;
  qall_id: string;
  avatar_url: string | null;
};

type Contact = {
  id: string;
  owner_id: string;
  contact_user_id: string;
  contact_name: string;
  created_at: string;
  profile: ContactProfile | null;
};

type SavedGroup = {
  conversation_id: string;
  group_name: string;
  avatar_url: string | null;
  member_count: number;
};

type ContactRow = {
  id: string;
  owner_id: string;
  contact_user_id: string;
  contact_name: string;
  created_at: string;
};

function normalizeQallId(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 12);

  return digits
    .match(/.{1,3}/g)
    ?.join("-") ?? digits;
}

function isValidQallId(value: string): boolean {
  return /^\d{3}-\d{3}-\d{3}-\d{3}$/.test(value);
}

function getInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

export default function ContactsScreen() {
  const { user } = useAuth();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [searchText, setSearchText] = useState("");
  const [showBlocked, setShowBlocked] = useState(false);
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set());
  const [blockSavingId, setBlockSavingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"people" | "groups">("people");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [qallId, setQallId] = useState("");
  const [contactName, setContactName] = useState("");
  const [foundProfile, setFoundProfile] =
    useState<ContactProfile | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [editedName, setEditedName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [groups, setGroups] = useState<SavedGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsRefreshing, setGroupsRefreshing] = useState(false);
  const [startingGroupCallId, setStartingGroupCallId] = useState<string | null>(null);

  const loadContacts = useCallback(async () => {
    if (!user) {
      setContacts([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      const { data: contactRows, error: contactError } =
        await supabase
          .from("contacts")
          .select(
            "id, owner_id, contact_user_id, contact_name, created_at"
          )
          .eq("owner_id", user.id)
          .order("contact_name", { ascending: true });

      if (contactError) {
        throw contactError;
      }

      const rows = (contactRows ?? []) as ContactRow[];

      if (rows.length === 0) {
        setContacts([]);
        return;
      }

      const profileIds = rows.map(
        (contact) => contact.contact_user_id
      );

      const { data: profileRows, error: profileError } =
        await supabase
          .from("profiles")
          .select("id, display_name, qall_id, avatar_url")
          .in("id", profileIds);

      if (profileError) {
        throw profileError;
      }

      const profileMap = new Map(
        ((profileRows ?? []) as ContactProfile[]).map(
          (profile) => [profile.id, profile]
        )
      );

      const combinedContacts: Contact[] = rows.map((contact) => ({
        ...contact,
        profile:
          profileMap.get(contact.contact_user_id) ?? null,
      }));

      setContacts(combinedContacts);
    } catch (error) {
      Alert.alert(
        "Contacts error",
        error instanceof Error
          ? error.message
          : "Could not load your contacts."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  const loadBlockedUsers = useCallback(async () => {
    if (!user) { setBlockedUserIds(new Set()); return; }
    const { data, error } = await supabase
      .from("blocked_users")
      .select("blocked_user_id")
      .eq("blocker_id", user.id);
    if (error) {
      Alert.alert("Blocked contacts", error.message);
      return;
    }
    setBlockedUserIds(new Set((data ?? []).map(row => row.blocked_user_id)));
  }, [user]);

  useFocusEffect(useCallback(() => {
    void loadContacts();
    void loadBlockedUsers();
  }, [loadContacts, loadBlockedUsers]));

  async function updateBlock(contact: Contact, shouldBlock: boolean) {
    if (!user || blockSavingId) return;
    try {
      setBlockSavingId(contact.contact_user_id);
      if (shouldBlock) {
        const { error } = await supabase.from("blocked_users").insert({
          blocker_id: user.id,
          blocked_user_id: contact.contact_user_id,
        });
        if (error && error.code !== "23505") throw error;
      } else {
        const { error } = await supabase.from("blocked_users")
          .delete()
          .eq("blocker_id", user.id)
          .eq("blocked_user_id", contact.contact_user_id);
        if (error) throw error;
      }
      setBlockedUserIds(current => {
        const next = new Set(current);
        if (shouldBlock) next.add(contact.contact_user_id);
        else next.delete(contact.contact_user_id);
        return next;
      });
    } catch (error) {
      Alert.alert("Block contact", error instanceof Error ? error.message : "Could not update blocked contact.");
    } finally {
      setBlockSavingId(null);
    }
  }

  function confirmBlock(contact: Contact) {
    const blocked = blockedUserIds.has(contact.contact_user_id);
    Alert.alert(
      blocked ? "Unblock contact?" : "Block contact?",
      blocked
        ? `Allow ${contact.contact_name} to contact you again?`
        : `Block ${contact.contact_name}? Their direct chat and call buttons will be disabled here. Full incoming-message and call enforcement is scheduled for the next stages.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: blocked ? "Unblock" : "Block", style: blocked ? "default" : "destructive", onPress: () => void updateBlock(contact, !blocked) },
      ]
    );
  }

  const filteredContacts = useMemo(() => {
    const query = searchText.trim().toLowerCase();

    const visible = contacts.filter(contact =>
      blockedUserIds.has(contact.contact_user_id) === showBlocked
    );
    if (!query) return visible;

    return visible.filter((contact) => {
      const name = contact.contact_name.toLowerCase();
      const qallIdValue =
        contact.profile?.qall_id.toLowerCase() ?? "";

      return (
        name.includes(query) ||
        qallIdValue.includes(query)
      );
    });
  }, [contacts, searchText, blockedUserIds, showBlocked]);

  const loadGroups = useCallback(async () => {
    if (!user) {
      setGroups([]);
      setGroupsLoading(false);
      setGroupsRefreshing(false);
      return;
    }
    try {
      const { data, error } = await supabase.rpc("get_my_group_conversations");
      if (error) throw error;
      setGroups((data ?? []).map((row: any) => ({
        conversation_id: row.conversation_id,
        group_name: row.group_name ?? "Group",
        avatar_url: row.avatar_url ?? null,
        member_count: Number(row.member_count ?? 0),
      })));
    } catch (error) {
      Alert.alert("Groups error", error instanceof Error ? error.message : "Could not load groups.");
    } finally {
      setGroupsLoading(false);
      setGroupsRefreshing(false);
    }
  }, [user]);

  useFocusEffect(useCallback(() => {
    setGroupsLoading(true);
    void loadGroups();
  }, [loadGroups]));

  async function startContactGroupCall(group: SavedGroup, callType: GroupCallType) {
    if (startingGroupCallId) return;
    try {
      setStartingGroupCallId(group.conversation_id);
      const groupCallId = await startGroupCall(group.conversation_id, callType);
      if (!groupCallId) throw new Error("Group call could not be created.");
      router.push(`/group-call/${groupCallId}` as any);
    } catch (error) {
      Alert.alert("Group call", error instanceof Error ? error.message : "Could not start the group call.");
    } finally {
      setStartingGroupCallId(null);
    }
  }

  function openAddGroup() {
    router.push("/group/new" as any);
  }

  function openAddContact() {
    setQallId("");
    setContactName("");
    setFoundProfile(null);
    setModalVisible(true);
  }

  function closeAddContact() {
    if (lookingUp || saving) {
      return;
    }

    setModalVisible(false);
    setQallId("");
    setContactName("");
    setFoundProfile(null);
  }

  function handleQallIdChange(value: string) {
    setQallId(normalizeQallId(value));
    setFoundProfile(null);
  }

  async function findContact() {
    const normalizedId = normalizeQallId(qallId);

    if (!isValidQallId(normalizedId)) {
      Alert.alert(
        "Invalid Qall ID",
        "Enter a complete Qall ID in the format 123-456-789-012."
      );
      return;
    }

    try {
      setLookingUp(true);
      setFoundProfile(null);

      const { data, error } = await supabase.rpc(
        "find_profile_by_qall_id",
        {
          requested_qall_id: normalizedId,
        }
      );

      if (error) {
        throw error;
      }

      const profile = data?.[0] as
        | ContactProfile
        | undefined;

      if (!profile) {
        Alert.alert(
          "Contact not found",
          "No Global Qall account was found with that ID."
        );
        return;
      }

      const alreadySaved = contacts.some(
        (contact) =>
          contact.contact_user_id === profile.id
      );

      if (alreadySaved) {
        Alert.alert(
          "Contact already saved",
          "This Global Qall user is already in your contacts."
        );
        return;
      }

      setFoundProfile(profile);
      setContactName(profile.display_name?.trim() ?? "");
    } catch (error) {
      Alert.alert(
        "Lookup error",
        error instanceof Error
          ? error.message
          : "Could not find that Global Qall ID."
      );
    } finally {
      setLookingUp(false);
    }
  }

  async function saveContact() {
    if (!user || !foundProfile) {
      return;
    }

    const name = contactName.trim();

    if (!name) {
      Alert.alert(
        "Contact name required",
        "Enter a name for this contact."
      );
      return;
    }

    try {
      setSaving(true);

      const { error } = await supabase
        .from("contacts")
        .insert({
          owner_id: user.id,
          contact_user_id: foundProfile.id,
          contact_name: name,
        });

      if (error) {
        if (error.code === "23505") {
          Alert.alert(
            "Contact already saved",
            "This person is already in your contacts."
          );
          return;
        }

        throw error;
      }

      closeAddContact();
      await loadContacts();
    } catch (error) {
      Alert.alert(
        "Save error",
        error instanceof Error
          ? error.message
          : "Could not save the contact."
      );
    } finally {
      setSaving(false);
    }
  }

  function openEditContact(contact: Contact) {
    setEditingContact(contact);
    setEditedName(contact.contact_name);
  }

  function closeEditContact() {
    if (savingEdit) return;
    setEditingContact(null);
    setEditedName("");
  }

  async function saveEditedName() {
    if (!user || !editingContact || savingEdit) return;
    const name = editedName.trim();
    if (!name) {
      Alert.alert("Contact name required", "Enter a name for this contact.");
      return;
    }
    try {
      setSavingEdit(true);
      const { data, error } = await supabase
        .from("contacts")
        .update({ contact_name: name })
        .eq("id", editingContact.id)
        .eq("owner_id", user.id)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("Contact could not be updated. Check your contacts update permission.");
      setContacts(current => current.map(contact =>
        contact.id === editingContact.id ? { ...contact, contact_name: name } : contact
      ).sort((a, b) => a.contact_name.localeCompare(b.contact_name)));
      setEditingContact(null);
      setEditedName("");
    } catch (error) {
      Alert.alert("Rename error", error instanceof Error ? error.message : "Could not rename contact.");
    } finally {
      setSavingEdit(false);
    }
  }

  function confirmDelete(contact: Contact) {
    Alert.alert(
      "Delete contact?",
      `${contact.contact_name} will be removed from your contacts.`,
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteContact(contact.id),
        },
      ]
    );
  }

  async function deleteContact(contactId: string) {
    try {
      const { error } = await supabase
        .from("contacts")
        .delete()
        .eq("id", contactId);

      if (error) {
        throw error;
      }

      setContacts((current) =>
        current.filter(
          (contact) => contact.id !== contactId
        )
      );
    } catch (error) {
      Alert.alert(
        "Delete error",
        error instanceof Error
          ? error.message
          : "Could not delete the contact."
      );
    }
  }

  async function startContactCall(
    contact: Contact,
    type: "voice" | "video"
  ) {
    if (!contact.contact_user_id) {
      Alert.alert(
        "Call unavailable",
        "This contact could not be loaded."
      );
      return;
    }

    try {
      const callId =
        type === "video"
          ? await createVideoCall(contact.contact_user_id)
          : await createVoiceCall(contact.contact_user_id);

      router.push({
        pathname: "/call/[callId]",
        params: {
          callId,
          direction: "outgoing",
        },
      });
    } catch (error) {
      if (isUserBusyError(error)) {
        Alert.alert(
          "User busy",
          `${contact.contact_name} is already on another call.`
        );
        return;
      }

      Alert.alert(
        "Call error",
        error instanceof Error
          ? error.message
          : "Could not start the call."
      );
    }
  }

  async function openChat(contact: Contact) {
    try {
      const { data, error } = await supabase.rpc(
        "get_or_create_direct_conversation",
        {
          other_user_id: contact.contact_user_id,
        }
      );

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error("Could not create the conversation.");
      }

      router.push({
        pathname: "/chat/[conversationId]",
        params: {
          conversationId: data,
        },
      });
    } catch (error) {
      Alert.alert(
        "Chat error",
        error instanceof Error
          ? error.message
          : "Could not open the conversation."
      );
    }
  }

  function renderContact({
    item,
  }: {
    item: Contact;
  }) {
    const isBlocked = blockedUserIds.has(item.contact_user_id);
    return (
      <View style={styles.contactCard}>
        <View style={styles.contactTopRow}>
          <UserAvatar
            avatarUrl={item.profile?.avatar_url}
            name={
              item.contact_name ||
              item.profile?.display_name ||
              "Global Qall User"
            }
            size={48}
          />

          <View style={styles.contactDetails}>
            <Text style={styles.contactName}>
              {item.contact_name}
            </Text>

            <Text style={styles.contactQallId}>
              {item.profile?.qall_id ?? "Qall ID unavailable"}
            </Text>
          </View>

          <Pressable
            onPress={() => openEditContact(item)}
            hitSlop={10}
            style={({ pressed }) => [styles.deleteIcon, pressed && styles.pressed]}
            accessibilityLabel={`Edit name for ${item.contact_name}`}
          >
            <Ionicons name="create-outline" size={21} color="#176B5B" />
          </Pressable>

          <Pressable
            onPress={() => Alert.alert(
              item.contact_name,
              "Contact options",
              [
                { text: "Edit name", onPress: () => openEditContact(item) },
                { text: isBlocked ? "Unblock Contact" : "Block Contact", onPress: () => confirmBlock(item) },
                { text: "Delete contact", style: "destructive", onPress: () => confirmDelete(item) },
                { text: "Cancel", style: "cancel" },
              ]
            )}
            hitSlop={10}
            style={({ pressed }) => [
              styles.deleteIcon,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="ellipsis-vertical"
              size={21}
              color="#65706D"
            />
          </Pressable>
        </View>

        {isBlocked ? (
          <View style={styles.blockedNotice}>
            <Ionicons name="ban-outline" size={16} color="#B42318" />
            <Text style={styles.blockedNoticeText}>Blocked — direct contact actions unavailable</Text>
            <Pressable onPress={() => confirmBlock(item)} disabled={blockSavingId !== null}>
              <Text style={styles.unblockText}>Unblock</Text>
            </Pressable>
          </View>
        ) : <View style={styles.contactActions}>
          {([
            { icon: "chatbubble-outline" as const, label: "Chat", action: () => void openChat(item) },
            { icon: "call-outline" as const, label: "Voice call", action: () => void startContactCall(item, "voice") },
            { icon: "videocam-outline" as const, label: "Video call", action: () => void startContactCall(item, "video") },
          ]).map((action) => (
            <Pressable
              key={action.label}
              onPress={action.action}
              accessibilityRole="button"
              accessibilityLabel={`${action.label} ${item.contact_name}`}
              style={({ pressed }) => [styles.contactAction, pressed && styles.pressed]}
            >
              <Ionicons name={action.icon} size={20} color="#176B5B" />
            </Pressable>
          ))}
        </View>}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.topRow}>
          <Text style={styles.heading}>Contacts</Text>
          <Pressable
            onPress={activeTab === "people" ? openAddContact : openAddGroup}
            accessibilityRole="button"
            accessibilityLabel={activeTab === "people" ? "Add contact" : "Add group"}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
          >
            <Ionicons name={activeTab === "people" ? "person-add-outline" : "people-outline"} size={18} color="#FFFFFF" />
            <Text style={styles.addButtonText}>Add</Text>
          </Pressable>
        </View>

        <View style={styles.tabBar}>
          {(["people", "groups"] as const).map((tab) => (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab }}
              onPress={() => { setActiveTab(tab); setSearchText(""); }}
              style={[styles.tabButton, activeTab === tab && styles.tabButtonActive]}
            >
              <Ionicons
                name={tab === "people" ? "person-outline" : "people-outline"}
                size={17}
                color={activeTab === tab ? "#FFFFFF" : "#52605D"}
              />
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === "people" ? "People" : "Groups"}
              </Text>
            </Pressable>
          ))}
        </View>

        {activeTab === "people" ? (
          <View>
            <View style={styles.blockedFilterRow}>
              <Pressable onPress={() => { setShowBlocked(false); setSearchText(""); }} style={[styles.blockedFilter, !showBlocked && styles.blockedFilterActive]}>
                <Text style={[styles.blockedFilterText, !showBlocked && styles.blockedFilterTextActive]}>Contacts</Text>
              </Pressable>
              <Pressable onPress={() => { setShowBlocked(true); setSearchText(""); }} style={[styles.blockedFilter, showBlocked && styles.blockedFilterActive]}>
                <Ionicons name="ban-outline" size={15} color={showBlocked ? "#FFFFFF" : "#52605D"} />
                <Text style={[styles.blockedFilterText, showBlocked && styles.blockedFilterTextActive]}>Blocked ({contacts.filter(c => blockedUserIds.has(c.contact_user_id)).length})</Text>
              </Pressable>
            </View>
          <View style={styles.searchContainer}>
            <Ionicons name="search-outline" size={20} color="#72807C" />
            <TextInput
              value={searchText}
              onChangeText={setSearchText}
              placeholder="Search contacts or Qall ID"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
            {searchText.length > 0 && (
              <Pressable onPress={() => setSearchText("")} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color="#9AA5A1" />
              </Pressable>
            )}
          </View>
          </View>
        ) : null}

        {activeTab === "groups" ? (
          groupsLoading ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="large" color="#176B5B" />
            </View>
          ) : (
            <FlatList
              data={groups}
              keyExtractor={(item) => item.conversation_id}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.listContent, groups.length === 0 && styles.emptyListContent]}
              refreshControl={
                <RefreshControl
                  refreshing={groupsRefreshing}
                  tintColor="#176B5B"
                  onRefresh={() => { setGroupsRefreshing(true); void loadGroups(); }}
                />
              }
              renderItem={({ item }) => (
                <View style={styles.contactCard}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open group ${item.group_name}`}
                    onPress={() => router.push({ pathname: "/chat/[conversationId]", params: { conversationId: item.conversation_id } })}
                    style={({ pressed }) => [styles.savedGroupRow, pressed && styles.pressed]}
                  >
                    <UserAvatar avatarUrl={item.avatar_url} name={item.group_name} size={48} />
                    <View style={styles.contactDetails}>
                      <Text style={styles.contactName} numberOfLines={1}>{item.group_name}</Text>
                      <Text style={styles.contactQallId}>
                        {item.member_count} {item.member_count === 1 ? "member" : "members"}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color="#65706D" />
                  </Pressable>
                  <View style={styles.contactActions}>
                    {([
                      { icon: "chatbubble-outline" as const, label: "Chat", action: () => router.push({ pathname: "/chat/[conversationId]", params: { conversationId: item.conversation_id } }) },
                      { icon: "call-outline" as const, label: "Audio", action: () => void startContactGroupCall(item, "voice") },
                      { icon: "videocam-outline" as const, label: "Video", action: () => void startContactGroupCall(item, "video") },
                    ]).map((action) => (
                      <Pressable
                        key={action.label}
                        onPress={action.action}
                        disabled={startingGroupCallId !== null}
                        accessibilityRole="button"
                        accessibilityLabel={`${action.label} ${item.group_name}`}
                        style={({ pressed }) => [styles.contactAction, pressed && styles.pressed]}
                      >
                        {startingGroupCallId === item.conversation_id && action.label !== "Chat" ? (
                          <ActivityIndicator size="small" color="#176B5B" />
                        ) : (
                          <Ionicons name={action.icon} size={20} color="#176B5B" />
                        )}
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <View style={styles.emptyIcon}>
                    <Ionicons name="people-outline" size={42} color="#176B5B" />
                  </View>
                  <Text style={styles.emptyTitle}>No groups yet</Text>
                  <Text style={styles.emptyText}>Create a group to start chatting with multiple contacts.</Text>
                  <Pressable
                    onPress={openAddGroup}
                    style={({ pressed }) => [styles.emptyAddButton, pressed && styles.pressed]}
                  >
                    <Ionicons name="people-outline" size={19} color="#FFFFFF" />
                    <Text style={styles.emptyAddText}>Add Group</Text>
                  </Pressable>
                </View>
              }
            />
          )
        ) : loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator
              size="large"
              color="#176B5B"
            />
          </View>
        ) : (
          <FlatList
            data={filteredContacts}
            keyExtractor={(item) => item.id}
            renderItem={renderContact}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[
              styles.listContent,
              filteredContacts.length === 0 &&
                styles.emptyListContent,
            ]}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor="#176B5B"
                onRefresh={() => {
                  setRefreshing(true);
                  loadContacts();
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
                        : "people-outline"
                    }
                    size={42}
                    color="#176B5B"
                  />
                </View>

                <Text style={styles.emptyTitle}>
                  {searchText
                    ? "No matching contacts"
                    : "No contacts yet"}
                </Text>

                <Text style={styles.emptyText}>
                  {searchText
                    ? "Try another name or Global Qall ID."
                    : showBlocked ? "Contacts you block will appear here." : "Add someone using their Global Qall ID."}
                </Text>

                {!searchText && !showBlocked && (
                  <Pressable
                    onPress={openAddContact}
                    style={({ pressed }) => [
                      styles.emptyAddButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Ionicons
                      name="person-add-outline"
                      size={19}
                      color="#FFFFFF"
                    />
                    <Text style={styles.emptyAddText}>
                      Add Contact
                    </Text>
                  </Pressable>
                )}
              </View>
            }
          />
        )}
      </View>

      <Modal
        visible={editingContact !== null}
        animationType="slide"
        transparent
        onRequestClose={closeEditContact}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable style={styles.modalBackdrop} onPress={closeEditContact} />
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Edit Contact Name</Text>
                <Text style={styles.modalSubtitle}>
                  Only you will see this name. The user's profile will not change.
                </Text>
              </View>
              <Pressable onPress={closeEditContact} disabled={savingEdit} hitSlop={10}>
                <Ionicons name="close" size={25} color="#44504D" />
              </Pressable>
            </View>
            <Text style={styles.inputLabel}>Personal contact name</Text>
            <TextInput
              value={editedName}
              onChangeText={setEditedName}
              placeholder="Contact name"
              autoCapitalize="words"
              maxLength={80}
              autoFocus
              style={styles.input}
              editable={!savingEdit}
            />
            {editingContact?.profile?.display_name ? (
              <Text style={styles.modalSubtitle}>
                Registered name: {editingContact.profile.display_name}
              </Text>
            ) : null}
            <Pressable
              onPress={() => void saveEditedName()}
              disabled={savingEdit || !editedName.trim()}
              style={({ pressed }) => [
                styles.saveButton,
                pressed && styles.pressed,
                (savingEdit || !editedName.trim()) && styles.disabled,
              ]}
            >
              {savingEdit ? <ActivityIndicator color="#FFFFFF" /> : (
                <Text style={styles.saveButtonText}>Save Name</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeAddContact}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={
            Platform.OS === "ios" ? "padding" : undefined
          }
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={closeAddContact}
          />

          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>
                  Add Contact
                </Text>
                <Text style={styles.modalSubtitle}>
                  Find someone by Global Qall ID.
                </Text>
              </View>

              <Pressable
                onPress={closeAddContact}
                hitSlop={10}
                disabled={lookingUp || saving}
              >
                <Ionicons
                  name="close"
                  size={25}
                  color="#44504D"
                />
              </Pressable>
            </View>

            <Text style={styles.inputLabel}>
              Global Qall ID
            </Text>

            <TextInput
              value={qallId}
              onChangeText={handleQallIdChange}
              placeholder="123-456-789-012"
              keyboardType="number-pad"
              maxLength={15}
              autoFocus
              style={styles.input}
            />

            <Pressable
              onPress={findContact}
              disabled={lookingUp || saving}
              style={({ pressed }) => [
                styles.findButton,
                pressed && styles.pressed,
                (lookingUp || saving) && styles.disabled,
              ]}
            >
              {lookingUp ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Ionicons
                    name="search-outline"
                    size={19}
                    color="#FFFFFF"
                  />
                  <Text style={styles.findButtonText}>
                    Find Contact
                  </Text>
                </>
              )}
            </Pressable>

            {foundProfile && (
              <View style={styles.foundSection}>
                <View style={styles.foundProfile}>
                  <View style={styles.foundAvatar}>
                    <Text style={styles.foundAvatarText}>
                      {getInitial(
                        foundProfile.display_name ?? "?"
                      )}
                    </Text>
                  </View>

                  <View style={styles.foundDetails}>
                    <Text style={styles.foundName}>
                      {foundProfile.display_name ??
                        "Global Qall User"}
                    </Text>
                    <Text style={styles.foundQallId}>
                      {foundProfile.qall_id}
                    </Text>
                  </View>

                  <Ionicons
                    name="checkmark-circle"
                    size={25}
                    color="#176B5B"
                  />
                </View>

                <Text style={styles.inputLabel}>
                  Contact name
                </Text>

                <TextInput
                  value={contactName}
                  onChangeText={setContactName}
                  placeholder="Contact name"
                  autoCapitalize="words"
                  maxLength={80}
                  style={styles.input}
                />

                <Pressable
                  onPress={saveContact}
                  disabled={saving}
                  style={({ pressed }) => [
                    styles.saveButton,
                    pressed && styles.pressed,
                    saving && styles.disabled,
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons
                        name="person-add-outline"
                        size={19}
                        color="#FFFFFF"
                      />
                      <Text style={styles.saveButtonText}>
                        Save Contact
                      </Text>
                    </>
                  )}
                </Pressable>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  heading: {
    fontSize: 21,
    fontWeight: "700",
    color: "#18201E",
  },
  addButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 15,
    borderRadius: 12,
    backgroundColor: "#176B5B",
  },
  addButtonText: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#E9EFED",
    padding: 4,
    borderRadius: 13,
    marginBottom: 15,
  },
  tabButton: {
    flex: 1,
    minHeight: 43,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 10,
  },
  tabButtonActive: { backgroundColor: "#176B5B" },
  tabText: { fontSize: 14, fontWeight: "700", color: "#52605D" },
  tabTextActive: { color: "#FFFFFF" },
  savedGroupRow: { flexDirection: "row", alignItems: "center" },
  groupsPanel: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    paddingBottom: 90,
  },
  groupsIcon: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: "#E6F2EF", alignItems: "center", justifyContent: "center",
  },
  groupsTitle: { marginTop: 18, fontSize: 20, fontWeight: "700", color: "#18201E" },
  groupsDescription: {
    marginTop: 10, textAlign: "center", lineHeight: 21, color: "#65706D",
  },
  groupTestButton: {
    marginTop: 24, flexDirection: "row", alignItems: "center", gap: 9,
    paddingHorizontal: 16, minHeight: 46, borderRadius: 12, backgroundColor: "#E6F2EF",
  },
  groupTestText: { fontWeight: "700", color: "#176B5B" },
  blockedFilterRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  blockedFilter: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingVertical: 9, paddingHorizontal: 13, borderRadius: 10, backgroundColor: "#E9EFED" },
  blockedFilterActive: { backgroundColor: "#176B5B" },
  blockedFilterText: { fontSize: 13, fontWeight: "700", color: "#52605D" },
  blockedFilterTextActive: { color: "#FFFFFF" },
  blockedNotice: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#EDF0EF" },
  blockedNoticeText: { flex: 1, fontSize: 12, color: "#B42318" },
  unblockText: { fontSize: 13, fontWeight: "700", color: "#176B5B" },
  searchContainer: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 14,
    marginBottom: 15,
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
    paddingBottom: 28,
    gap: 12,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  contactCard: {
    padding: 16,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 17,
    backgroundColor: "#FFFFFF",
  },
  contactTopRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatar: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    backgroundColor: "#176B5B",
  },
  avatarText: {
    fontSize: 19,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  contactDetails: {
    flex: 1,
    marginLeft: 12,
  },
  contactName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#18201E",
  },
  contactQallId: {
    marginTop: 4,
    fontSize: 13,
    letterSpacing: 0.4,
    color: "#65706D",
  },
  deleteIcon: {
    padding: 7,
  },
  contactActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
    paddingTop: 13,
    borderTopWidth: 1,
    borderTopColor: "#EDF0EF",
  },
  contactAction: {
    flex: 1,
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderRadius: 11,
    backgroundColor: "#E6F2EF",
  },
  contactActionText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#176B5B",
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
    marginTop: 8,
    textAlign: "center",
    lineHeight: 21,
    color: "#65706D",
  },
  emptyAddButton: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 20,
    paddingHorizontal: 19,
    borderRadius: 13,
    backgroundColor: "#176B5B",
  },
  emptyAddText: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.42)",
  },
  modalCard: {
    padding: 22,
    paddingBottom: Platform.OS === "ios" ? 34 : 24,
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    backgroundColor: "#FFFFFF",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 22,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#18201E",
  },
  modalSubtitle: {
    marginTop: 5,
    color: "#65706D",
  },
  inputLabel: {
    marginBottom: 7,
    fontSize: 13,
    fontWeight: "700",
    color: "#44504D",
  },
  input: {
    minHeight: 52,
    paddingHorizontal: 15,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 13,
    backgroundColor: "#F9FAFA",
    fontSize: 16,
    color: "#18201E",
  },
  findButton: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 13,
    borderRadius: 13,
    backgroundColor: "#3157A4",
  },
  findButtonText: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  foundSection: {
    marginTop: 20,
  },
  foundProfile: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#EAF5F2",
  },
  foundAvatar: {
    width: 45,
    height: 45,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 23,
    backgroundColor: "#176B5B",
  },
  foundAvatarText: {
    fontSize: 18,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  foundDetails: {
    flex: 1,
    marginLeft: 11,
  },
  foundName: {
    fontWeight: "700",
    color: "#18201E",
  },
  foundQallId: {
    marginTop: 3,
    fontSize: 13,
    color: "#65706D",
  },
  saveButton: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 14,
    borderRadius: 13,
    backgroundColor: "#176B5B",
  },
  saveButtonText: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.5,
  },
});