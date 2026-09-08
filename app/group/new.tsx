import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { UserAvatar } from "../../components/UserAvatar";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";

type ContactProfile = {
  id: string;
  display_name: string | null;
  qall_id: string;
  avatar_url: string | null;
};

type Contact = {
  id: string;
  contact_user_id: string;
  contact_name: string;
  profile: ContactProfile | null;
};

export default function NewGroupScreen() {
  const { user } = useAuth();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set()
  );
  const [groupName, setGroupName] = useState("");
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [avatarAsset, setAvatarAsset] =
    useState<ImagePicker.ImagePickerAsset | null>(null);

  const loadContacts = useCallback(async () => {
    if (!user) return;

    try {
      const { data: contactRows, error } = await supabase
        .from("contacts")
        .select(
          "id, contact_user_id, contact_name"
        )
        .eq("owner_id", user.id)
        .order("contact_name", { ascending: true });

      if (error) throw error;

      const ids = (contactRows ?? []).map(
        (row: any) => row.contact_user_id
      );

      let profiles: ContactProfile[] = [];

      if (ids.length > 0) {
        const { data: profileRows, error: profileError } =
          await supabase
            .from("profiles")
            .select(
              "id, display_name, qall_id, avatar_url"
            )
            .in("id", ids);

        if (profileError) throw profileError;
        profiles = (profileRows ?? []) as ContactProfile[];
      }

      const map = new Map(
        profiles.map((profile) => [profile.id, profile])
      );

      setContacts(
        (contactRows ?? []).map((row: any) => ({
          id: row.id,
          contact_user_id: row.contact_user_id,
          contact_name: row.contact_name,
          profile:
            map.get(row.contact_user_id) ?? null,
        }))
      );
    } catch (error) {
      Alert.alert(
        "Contacts error",
        error instanceof Error
          ? error.message
          : "Could not load contacts."
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  const filteredContacts = useMemo(() => {
    const query = searchText.trim().toLowerCase();

    if (!query) return contacts;

    return contacts.filter((contact) => {
      return (
        contact.contact_name
          .toLowerCase()
          .includes(query) ||
        (contact.profile?.qall_id ?? "")
          .toLowerCase()
          .includes(query)
      );
    });
  }, [contacts, searchText]);

  function toggleContact(userId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function choosePhoto() {
    const permission =
      await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert(
        "Photo permission required",
        "Allow Global Qall to access your photos to choose a group picture."
      );
      return;
    }

    const result =
      await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.82,
      });

    if (!result.canceled && result.assets.length > 0) {
      setAvatarAsset(result.assets[0]);
    }
  }

  async function uploadGroupAvatar(
    conversationId: string
  ): Promise<string | null> {
    if (!user || !avatarAsset) return null;

    const extension =
      avatarAsset.fileName
        ?.split(".")
        .pop()
        ?.toLowerCase() ??
      avatarAsset.mimeType?.split("/").pop() ??
      "jpg";

    const path =
      `${user.id}/groups/${conversationId}/avatar-${Date.now()}.${extension}`;

    const response = await fetch(avatarAsset.uri);
    const fileData = await response.arrayBuffer();

    const { error } = await supabase.storage
      .from("avatars")
      .upload(path, fileData, {
        contentType:
          avatarAsset.mimeType ?? "image/jpeg",
        upsert: true,
      });

    if (error) throw error;

    const { data } = supabase.storage
      .from("avatars")
      .getPublicUrl(path);

    return `${data.publicUrl}?v=${Date.now()}`;
  }

  async function createGroup() {
    const name = groupName.trim();

    if (!name) {
      Alert.alert(
        "Group name required",
        "Enter a name for the group."
      );
      return;
    }

    if (name.length > 120) {
      Alert.alert(
        "Group name too long",
        "Group names can contain up to 120 characters."
      );
      return;
    }

    if (selectedIds.size < 1) {
      Alert.alert(
        "Select members",
        "Choose at least one contact to add to the group."
      );
      return;
    }

    try {
      setCreating(true);

      const { data, error } = await supabase.rpc(
        "create_group_conversation",
        {
          p_name: name,
          p_member_ids: Array.from(selectedIds),
          p_avatar_url: null,
        }
      );

      if (error) throw error;

      const conversationId = String(data);

      if (avatarAsset) {
        const avatarUrl =
          await uploadGroupAvatar(conversationId);

        if (avatarUrl) {
          const { error: metadataError } =
            await supabase.rpc(
              "update_group_metadata",
              {
                p_conversation_id: conversationId,
                p_name: name,
                p_avatar_url: avatarUrl,
              }
            );

          if (metadataError) throw metadataError;
        }
      }

      router.replace({
        pathname: "/group/[conversationId]",
        params: { conversationId },
      });
    } catch (error) {
      Alert.alert(
        "Group creation error",
        error instanceof Error
          ? error.message
          : "Could not create the group."
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={
          Platform.OS === "ios" ? "padding" : undefined
        }
      >
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.headerIcon}
            disabled={creating}
          >
            <Ionicons
              name="chevron-back"
              size={25}
              color="#18201E"
            />
          </Pressable>

          <Text style={styles.heading}>New Group</Text>

          <Pressable
            onPress={createGroup}
            disabled={creating}
            style={[
              styles.createButton,
              creating && styles.disabled,
            ]}
          >
            {creating ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
              />
            ) : (
              <Text style={styles.createButtonText}>
                Create
              </Text>
            )}
          </Pressable>
        </View>

        <View style={styles.groupIdentity}>
          <Pressable
            onPress={choosePhoto}
            style={styles.photoButton}
            disabled={creating}
          >
            {avatarAsset ? (
              <Image
                source={{ uri: avatarAsset.uri }}
                style={styles.photo}
              />
            ) : (
              <>
                <Ionicons
                  name="camera-outline"
                  size={26}
                  color="#176B5B"
                />
                <Text style={styles.photoText}>Photo</Text>
              </>
            )}
          </Pressable>

          <View style={styles.nameWrap}>
            <Text style={styles.label}>Group name</Text>
            <TextInput
              value={groupName}
              onChangeText={setGroupName}
              placeholder="Family, Project Team..."
              maxLength={120}
              style={styles.nameInput}
            />
          </View>
        </View>

        <View style={styles.selectedSummary}>
          <Text style={styles.sectionTitle}>
            Members
          </Text>
          <Text style={styles.selectedCount}>
            {selectedIds.size} selected
          </Text>
        </View>

        <View style={styles.searchBox}>
          <Ionicons
            name="search-outline"
            size={19}
            color="#72807C"
          />
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Search contacts"
            style={styles.searchInput}
          />
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
            data={filteredContacts}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            renderItem={({ item }) => {
              const selected =
                selectedIds.has(item.contact_user_id);

              return (
                <Pressable
                  onPress={() =>
                    toggleContact(item.contact_user_id)
                  }
                  style={({ pressed }) => [
                    styles.contactRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <UserAvatar
                    avatarUrl={item.profile?.avatar_url}
                    name={
                      item.contact_name ||
                      item.profile?.display_name ||
                      "Contact"
                    }
                    size={48}
                  />

                  <View style={styles.contactInfo}>
                    <Text
                      style={styles.contactName}
                      numberOfLines={1}
                    >
                      {item.contact_name}
                    </Text>
                    <Text style={styles.qallId}>
                      {item.profile?.qall_id ??
                        "Global Qall contact"}
                    </Text>
                  </View>

                  <View
                    style={[
                      styles.checkCircle,
                      selected && styles.checkCircleSelected,
                    ]}
                  >
                    {selected && (
                      <Ionicons
                        name="checkmark"
                        size={18}
                        color="#FFFFFF"
                      />
                    )}
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons
                  name="people-outline"
                  size={38}
                  color="#176B5B"
                />
                <Text style={styles.emptyTitle}>
                  No contacts found
                </Text>
                <Text style={styles.emptyText}>
                  Add contacts first, then return to create
                  your group.
                </Text>
              </View>
            }
          />
        )}
      </KeyboardAvoidingView>
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
  },
  header: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E6EBE9",
    backgroundColor: "#FFFFFF",
  },
  headerIcon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    flex: 1,
    marginLeft: 3,
    fontSize: 20,
    fontWeight: "800",
    color: "#18201E",
  },
  createButton: {
    minWidth: 78,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: 11,
    backgroundColor: "#176B5B",
  },
  createButtonText: {
    fontWeight: "800",
    color: "#FFFFFF",
  },
  disabled: {
    opacity: 0.6,
  },
  groupIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 18,
    backgroundColor: "#FFFFFF",
  },
  photoButton: {
    width: 72,
    height: 72,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 36,
    backgroundColor: "#E6F2EF",
    overflow: "hidden",
  },
  photo: {
    width: 72,
    height: 72,
  },
  photoText: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: "700",
    color: "#176B5B",
  },
  nameWrap: {
    flex: 1,
  },
  label: {
    marginBottom: 6,
    fontSize: 12,
    fontWeight: "700",
    color: "#687570",
  },
  nameInput: {
    minHeight: 46,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 12,
    fontSize: 16,
    color: "#18201E",
  },
  selectedSummary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#18201E",
  },
  selectedCount: {
    fontSize: 13,
    fontWeight: "700",
    color: "#176B5B",
  },
  searchBox: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 18,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#18201E",
  },
  list: {
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 30,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 68,
    borderBottomWidth: 1,
    borderBottomColor: "#E8ECEA",
  },
  contactInfo: {
    flex: 1,
    marginLeft: 12,
  },
  contactName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#18201E",
  },
  qallId: {
    marginTop: 3,
    fontSize: 12,
    color: "#7B8783",
  },
  checkCircle: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#B9C4C0",
    borderRadius: 13,
  },
  checkCircleSelected: {
    borderColor: "#176B5B",
    backgroundColor: "#176B5B",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    alignItems: "center",
    paddingTop: 70,
  },
  emptyTitle: {
    marginTop: 12,
    fontSize: 18,
    fontWeight: "800",
    color: "#18201E",
  },
  emptyText: {
    maxWidth: 260,
    marginTop: 6,
    textAlign: "center",
    lineHeight: 20,
    color: "#687570",
  },
  pressed: {
    opacity: 0.72,
  },
});
