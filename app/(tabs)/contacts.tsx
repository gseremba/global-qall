import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
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

import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import { UserAvatar } from "../../components/UserAvatar";

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [qallId, setQallId] = useState("");
  const [contactName, setContactName] = useState("");
  const [foundProfile, setFoundProfile] =
    useState<ContactProfile | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  const filteredContacts = useMemo(() => {
    const query = searchText.trim().toLowerCase();

    if (!query) {
      return contacts;
    }

    return contacts.filter((contact) => {
      const name = contact.contact_name.toLowerCase();
      const qallIdValue =
        contact.profile?.qall_id.toLowerCase() ?? "";

      return (
        name.includes(query) ||
        qallIdValue.includes(query)
      );
    });
  }, [contacts, searchText]);

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

  function openQall(contact: Contact) {
    const contactQallId = contact.profile?.qall_id;

    if (!contactQallId) {
      Alert.alert(
        "Qall ID unavailable",
        "This contact's Qall ID could not be loaded."
      );
      return;
    }

    router.push({
      pathname: "/qall",
      params: {
        qallId: contactQallId,
      },
    });
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

  function openContactProfile(contact: Contact) {
    router.push({
      pathname: "/contact/[userId]",
      params: {
        userId: contact.contact_user_id,
        contactId: contact.id,
        contactName: contact.contact_name,
      },
    });
  }

  function renderContact({
    item,
  }: {
    item: Contact;
  }) {
    return (
      <View style={styles.contactCard}>
        <View style={styles.contactTopRow}>
          <Pressable
            onPress={() => openContactProfile(item)}
            style={({ pressed }) => [
              styles.contactProfileButton,
              pressed && styles.pressed,
            ]}
          >
            <UserAvatar
              avatarUrl={item.profile?.avatar_url}
              name={
                item.profile?.display_name ??
                item.contact_name
              }
              size={48}
            />

            <View style={styles.contactDetails}>
              <Text style={styles.contactName}>
                {item.contact_name}
              </Text>

              <Text style={styles.contactQallId}>
                {item.profile?.qall_id ??
                  "Qall ID unavailable"}
              </Text>
            </View>

            <Ionicons
              name="chevron-forward"
              size={20}
              color="#9AA5A1"
            />
          </Pressable>

          <Pressable
            onPress={() => confirmDelete(item)}
            hitSlop={10}
            style={({ pressed }) => [
              styles.deleteIcon,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="trash-outline"
              size={21}
              color="#B42318"
            />
          </Pressable>
        </View>

        <View style={styles.contactActions}>
          <Pressable
            onPress={() => openChat(item)}
            style={({ pressed }) => [
              styles.contactAction,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="chatbubble-outline"
              size={19}
              color="#176B5B"
            />
            <Text style={styles.contactActionText}>
              Chat
            </Text>
          </Pressable>

          <Pressable
            onPress={() => openQall(item)}
            style={({ pressed }) => [
              styles.contactAction,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="call-outline"
              size={19}
              color="#176B5B"
            />
            <Text style={styles.contactActionText}>
              Qall
            </Text>
          </Pressable>

          <Pressable
            onPress={() => openQall(item)}
            style={({ pressed }) => [
              styles.contactAction,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="videocam-outline"
              size={20}
              color="#176B5B"
            />
            <Text style={styles.contactActionText}>
              Video
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.topRow}>
          <Text style={styles.heading}>Your contacts</Text>

          <Pressable
            onPress={openAddContact}
            style={({ pressed }) => [
              styles.addButton,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="person-add-outline"
              size={18}
              color="#FFFFFF"
            />
            <Text style={styles.addButtonText}>Add</Text>
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
            placeholder="Search contacts or Qall ID"
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
                    : "Add someone using their Global Qall ID."}
                </Text>

                {!searchText && (
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
                  <UserAvatar
                    avatarUrl={foundProfile.avatar_url}
                    name={
                      foundProfile.display_name ??
                      "Global Qall User"
                    }
                    size={45}
                  />

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
  contactProfileButton: {
    flex: 1,
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
    minHeight: 40,
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