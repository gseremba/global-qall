import Ionicons from "@expo/vector-icons/Ionicons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { UserAvatar } from "../../components/UserAvatar";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";

type Role = "owner" | "admin" | "member";

type Group = {
  id: string;
  name: string;
  avatar_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type Member = {
  conversation_id: string;
  user_id: string;
  role: Role;
  joined_at: string;
  display_name: string | null;
  qall_id: string | null;
  avatar_url: string | null;
};

type ContactChoice = {
  user_id: string;
  contact_name: string;
  display_name: string | null;
  qall_id: string | null;
  avatar_url: string | null;
};

export default function GroupInfoScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams<{
    conversationId: string;
  }>();
  const conversationId = params.conversationId;

  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingName, setSavingName] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] =
    useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [addModalVisible, setAddModalVisible] =
    useState(false);
  const [contactChoices, setContactChoices] =
    useState<ContactChoice[]>([]);
  const [loadingContacts, setLoadingContacts] =
    useState(false);

  const canManage =
    myRole === "owner" || myRole === "admin";

  const loadGroup = useCallback(async () => {
    if (!conversationId || !user) return;

    try {
      const { data: groupRow, error: groupError } =
        await supabase
          .from("conversations")
          .select(
            "id, name, avatar_url, created_by, created_at, updated_at"
          )
          .eq("id", conversationId)
          .eq("conversation_type", "group")
          .single();

      if (groupError) throw groupError;

      const { data: membershipRows, error: memberError } =
        await supabase
          .from("conversation_members")
          .select(
            "conversation_id, user_id, role, joined_at"
          )
          .eq("conversation_id", conversationId)
          .order("joined_at", { ascending: true });

      if (memberError) throw memberError;

      const userIds = (membershipRows ?? []).map(
        (row: any) => row.user_id
      );

      let profileRows: any[] = [];
      if (userIds.length > 0) {
        const { data, error } = await supabase
          .from("profiles")
          .select(
            "id, display_name, qall_id, avatar_url"
          )
          .in("id", userIds);

        if (error) throw error;
        profileRows = data ?? [];
      }

      const profileMap = new Map(
        profileRows.map((profile) => [
          profile.id,
          profile,
        ])
      );

      const combined: Member[] = (
        membershipRows ?? []
      ).map((row: any) => {
        const profile = profileMap.get(row.user_id);
        return {
          ...row,
          display_name: profile?.display_name ?? null,
          qall_id: profile?.qall_id ?? null,
          avatar_url: profile?.avatar_url ?? null,
        };
      });

      const mine = combined.find(
        (member) => member.user_id === user.id
      );

      setGroup(groupRow as Group);
      setNameDraft(groupRow.name ?? "");
      setMembers(combined);
      setMyRole(mine?.role ?? null);
    } catch (error) {
      Alert.alert(
        "Group error",
        error instanceof Error
          ? error.message
          : "Could not load this group."
      );
    } finally {
      setLoading(false);
    }
  }, [conversationId, user]);

  useFocusEffect(
    useCallback(() => {
      loadGroup();
    }, [loadGroup])
  );

  const sortedMembers = useMemo(() => {
    const rank: Record<Role, number> = {
      owner: 0,
      admin: 1,
      member: 2,
    };

    return [...members].sort((a, b) => {
      const byRole = rank[a.role] - rank[b.role];
      if (byRole !== 0) return byRole;
      return (a.display_name ?? a.qall_id ?? "").localeCompare(
        b.display_name ?? b.qall_id ?? ""
      );
    });
  }, [members]);

  async function saveName() {
    if (!group || !canManage) return;

    const name = nameDraft.trim();

    if (!name) {
      Alert.alert(
        "Group name required",
        "Group name cannot be empty."
      );
      return;
    }

    try {
      setSavingName(true);
      const { error } = await supabase.rpc(
        "update_group_metadata",
        {
          p_conversation_id: group.id,
          p_name: name,
          p_avatar_url: null,
        }
      );

      if (error) throw error;
      await loadGroup();
    } catch (error) {
      Alert.alert(
        "Update error",
        error instanceof Error
          ? error.message
          : "Could not update group name."
      );
    } finally {
      setSavingName(false);
    }
  }

  async function choosePhoto() {
    if (!user || !group || !canManage) return;

    const permission =
      await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert(
        "Photo permission required",
        "Allow Global Qall to access your photos to change the group picture."
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

    if (result.canceled || result.assets.length === 0) {
      return;
    }

    const asset = result.assets[0];

    try {
      setUploadingPhoto(true);

      const extension =
        asset.fileName
          ?.split(".")
          .pop()
          ?.toLowerCase() ??
        asset.mimeType?.split("/").pop() ??
        "jpg";

      const path =
        `${user.id}/groups/${group.id}/avatar-${Date.now()}.${extension}`;

      const response = await fetch(asset.uri);
      const fileData = await response.arrayBuffer();

      const { error: uploadError } =
        await supabase.storage
          .from("avatars")
          .upload(path, fileData, {
            contentType:
              asset.mimeType ?? "image/jpeg",
            upsert: true,
          });

      if (uploadError) throw uploadError;

      const { data } = supabase.storage
        .from("avatars")
        .getPublicUrl(path);

      const avatarUrl =
        `${data.publicUrl}?v=${Date.now()}`;

      const { error } = await supabase.rpc(
        "update_group_metadata",
        {
          p_conversation_id: group.id,
          p_name: null,
          p_avatar_url: avatarUrl,
        }
      );

      if (error) throw error;

      await loadGroup();
    } catch (error) {
      Alert.alert(
        "Photo update error",
        error instanceof Error
          ? error.message
          : "Could not update the group photo."
      );
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function loadAddableContacts() {
    if (!user) return;

    try {
      setLoadingContacts(true);

      const { data: contactRows, error } =
        await supabase
          .from("contacts")
          .select("contact_user_id, contact_name")
          .eq("owner_id", user.id)
          .order("contact_name");

      if (error) throw error;

      const existing = new Set(
        members.map((member) => member.user_id)
      );

      const eligible = (contactRows ?? []).filter(
        (row: any) =>
          !existing.has(row.contact_user_id)
      );

      const ids = eligible.map(
        (row: any) => row.contact_user_id
      );

      let profiles: any[] = [];
      if (ids.length > 0) {
        const { data, error: profileError } =
          await supabase
            .from("profiles")
            .select(
              "id, display_name, qall_id, avatar_url"
            )
            .in("id", ids);

        if (profileError) throw profileError;
        profiles = data ?? [];
      }

      const map = new Map(
        profiles.map((profile) => [
          profile.id,
          profile,
        ])
      );

      setContactChoices(
        eligible.map((row: any) => {
          const profile = map.get(row.contact_user_id);
          return {
            user_id: row.contact_user_id,
            contact_name: row.contact_name,
            display_name: profile?.display_name ?? null,
            qall_id: profile?.qall_id ?? null,
            avatar_url: profile?.avatar_url ?? null,
          };
        })
      );

      setAddModalVisible(true);
    } catch (error) {
      Alert.alert(
        "Contacts error",
        error instanceof Error
          ? error.message
          : "Could not load contacts."
      );
    } finally {
      setLoadingContacts(false);
    }
  }

  async function addMember(choice: ContactChoice) {
    if (!group || !canManage) return;

    try {
      const { error } = await supabase
        .from("conversation_members")
        .insert({
          conversation_id: group.id,
          user_id: choice.user_id,
          role: "member",
        });

      if (error) throw error;

      setAddModalVisible(false);
      await loadGroup();
    } catch (error) {
      Alert.alert(
        "Add member error",
        error instanceof Error
          ? error.message
          : "Could not add this member."
      );
    }
  }

  function confirmRemove(member: Member) {
    if (!group || !user) return;

    const isSelf = member.user_id === user.id;

    if (isSelf) {
      if (member.role === "owner") {
        Alert.alert(
          "Owner cannot leave yet",
          "Ownership transfer will be added as a dedicated safe action. The current owner cannot leave the group."
        );
        return;
      }

      Alert.alert(
        "Leave group?",
        "You will immediately lose access to this group's messages.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Leave",
            style: "destructive",
            onPress: () => removeMember(member),
          },
        ]
      );
      return;
    }

    Alert.alert(
      "Remove member?",
      `Remove ${
        member.display_name ?? member.qall_id ?? "this member"
      } from the group?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => removeMember(member),
        },
      ]
    );
  }

  async function removeMember(member: Member) {
    if (!group || !user) return;

    try {
      const { error } = await supabase
        .from("conversation_members")
        .delete()
        .eq("conversation_id", group.id)
        .eq("user_id", member.user_id);

      if (error) throw error;

      if (member.user_id === user.id) {
        router.replace("/chats");
        return;
      }

      await loadGroup();
    } catch (error) {
      Alert.alert(
        "Membership error",
        error instanceof Error
          ? error.message
          : "Could not update group membership."
      );
    }
  }

  async function changeRole(
    member: Member,
    nextRole: "admin" | "member"
  ) {
    if (!group || myRole !== "owner") return;

    try {
      const { error } = await supabase
        .from("conversation_members")
        .update({ role: nextRole })
        .eq("conversation_id", group.id)
        .eq("user_id", member.user_id);

      if (error) throw error;

      await loadGroup();
    } catch (error) {
      Alert.alert(
        "Role update error",
        error instanceof Error
          ? error.message
          : "Could not change this member's role."
      );
    }
  }

  function showMemberActions(member: Member) {
    if (!user || member.user_id === user.id) {
      confirmRemove(member);
      return;
    }

    const actions: any[] = [];

    if (myRole === "owner" && member.role !== "owner") {
      actions.push({
        text:
          member.role === "admin"
            ? "Make Member"
            : "Make Admin",
        onPress: () =>
          changeRole(
            member,
            member.role === "admin"
              ? "member"
              : "admin"
          ),
      });
    }

    const canRemove =
      myRole === "owner" ||
      (myRole === "admin" && member.role === "member");

    if (canRemove) {
      actions.push({
        text: "Remove from Group",
        style: "destructive",
        onPress: () => confirmRemove(member),
      });
    }

    actions.push({ text: "Cancel", style: "cancel" });

    if (actions.length === 1) return;

    Alert.alert(
      member.display_name ?? member.qall_id ?? "Member",
      member.role.toUpperCase(),
      actions
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.center}>
          <ActivityIndicator
            size="large"
            color="#176B5B"
          />
        </View>
      </SafeAreaView>
    );
  }

  if (!group) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>
            Group unavailable
          </Text>
          <Pressable
            onPress={() => router.replace("/chats")}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>
              Back to Chats
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.headerIcon}
        >
          <Ionicons
            name="chevron-back"
            size={25}
            color="#18201E"
          />
        </Pressable>
        <Text style={styles.headerTitle}>Group Info</Text>
        <View style={styles.headerIcon} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.identityCard}>
          <Pressable
            onPress={canManage ? choosePhoto : undefined}
            style={styles.avatarWrap}
          >
            {group.avatar_url ? (
              <Image
                source={{ uri: group.avatar_url }}
                style={styles.avatarImage}
              />
            ) : (
              <View style={styles.avatarFallback}>
                <Ionicons
                  name="people"
                  size={34}
                  color="#176B5B"
                />
              </View>
            )}

            {canManage && (
              <View style={styles.cameraBadge}>
                {uploadingPhoto ? (
                  <ActivityIndicator
                    size="small"
                    color="#FFFFFF"
                  />
                ) : (
                  <Ionicons
                    name="camera"
                    size={14}
                    color="#FFFFFF"
                  />
                )}
              </View>
            )}
          </Pressable>

          {canManage ? (
            <View style={styles.nameEditRow}>
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                maxLength={120}
                style={styles.nameInput}
              />
              <Pressable
                onPress={saveName}
                disabled={
                  savingName ||
                  nameDraft.trim() === group.name
                }
                style={[
                  styles.saveButton,
                  (savingName ||
                    nameDraft.trim() === group.name) &&
                    styles.disabled,
                ]}
              >
                {savingName ? (
                  <ActivityIndicator
                    size="small"
                    color="#FFFFFF"
                  />
                ) : (
                  <Text style={styles.saveButtonText}>
                    Save
                  </Text>
                )}
              </Pressable>
            </View>
          ) : (
            <Text style={styles.groupName}>{group.name}</Text>
          )}

          <Text style={styles.groupMeta}>
            {members.length}{" "}
            {members.length === 1 ? "member" : "members"}
            {myRole ? ` • You are ${myRole}` : ""}
          </Text>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Members</Text>
          {canManage && (
            <Pressable
              onPress={loadAddableContacts}
              disabled={loadingContacts}
              style={styles.addButton}
            >
              <Ionicons
                name="person-add-outline"
                size={17}
                color="#176B5B"
              />
              <Text style={styles.addButtonText}>
                Add
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.membersCard}>
          {sortedMembers.map((member, index) => {
            const self = member.user_id === user?.id;
            const actionable =
              self ||
              myRole === "owner" ||
              (myRole === "admin" &&
                member.role === "member");

            return (
              <Pressable
                key={member.user_id}
                onPress={
                  actionable
                    ? () => showMemberActions(member)
                    : undefined
                }
                style={[
                  styles.memberRow,
                  index < sortedMembers.length - 1 &&
                    styles.memberBorder,
                ]}
              >
                <UserAvatar
                  avatarUrl={member.avatar_url}
                  name={
                    member.display_name ??
                    member.qall_id ??
                    "Member"
                  }
                  size={47}
                />

                <View style={styles.memberInfo}>
                  <Text style={styles.memberName}>
                    {member.display_name ??
                      member.qall_id ??
                      "Global Qall user"}
                    {self ? " (You)" : ""}
                  </Text>
                  <Text style={styles.memberSub}>
                    {member.qall_id ?? ""}
                  </Text>
                </View>

                <View style={styles.roleWrap}>
                  <Text
                    style={[
                      styles.roleText,
                      member.role === "owner" &&
                        styles.ownerRole,
                    ]}
                  >
                    {member.role}
                  </Text>
                  {actionable && (
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color="#A0AAA6"
                    />
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>

        {myRole !== "owner" && (
          <Pressable
            onPress={() => {
              const mine = members.find(
                (member) => member.user_id === user?.id
              );
              if (mine) confirmRemove(mine);
            }}
            style={styles.leaveButton}
          >
            <Ionicons
              name="exit-outline"
              size={20}
              color="#B42318"
            />
            <Text style={styles.leaveText}>
              Leave Group
            </Text>
          </Pressable>
        )}

        {myRole === "owner" && (
          <View style={styles.ownerNotice}>
            <Ionicons
              name="shield-checkmark-outline"
              size={18}
              color="#176B5B"
            />
            <Text style={styles.ownerNoticeText}>
              The owner is protected from leaving or being
              removed. Ownership transfer will be added as a
              dedicated safe action.
            </Text>
          </View>
        )}

        <View style={styles.chatNotice}>
          <Ionicons
            name="chatbubbles-outline"
            size={19}
            color="#176B5B"
          />
          <Text style={styles.chatNoticeText}>
            Group creation and management are active. Group
            message UI is the next Sprint 11.3 stage.
          </Text>
        </View>
      </ScrollView>

      <Modal
        visible={addModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() =>
          setAddModalVisible(false)
        }
      >
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <Pressable
              onPress={() => setAddModalVisible(false)}
              style={styles.headerIcon}
            >
              <Ionicons
                name="close"
                size={24}
                color="#18201E"
              />
            </Pressable>
            <Text style={styles.modalTitle}>
              Add Members
            </Text>
            <View style={styles.headerIcon} />
          </View>

          {loadingContacts ? (
            <View style={styles.center}>
              <ActivityIndicator
                size="large"
                color="#176B5B"
              />
            </View>
          ) : (
            <FlatList
              data={contactChoices}
              keyExtractor={(item) => item.user_id}
              contentContainerStyle={styles.modalList}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => addMember(item)}
                  style={({ pressed }) => [
                    styles.memberRow,
                    styles.memberBorder,
                    pressed && styles.pressed,
                  ]}
                >
                  <UserAvatar
                    avatarUrl={item.avatar_url}
                    name={
                      item.contact_name ||
                      item.display_name ||
                      "Contact"
                    }
                    size={47}
                  />
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberName}>
                      {item.contact_name}
                    </Text>
                    <Text style={styles.memberSub}>
                      {item.qall_id ?? ""}
                    </Text>
                  </View>
                  <Ionicons
                    name="add-circle-outline"
                    size={24}
                    color="#176B5B"
                  />
                </Pressable>
              )}
              ListEmptyComponent={
                <View style={styles.center}>
                  <Text style={styles.emptyTitle}>
                    No contacts to add
                  </Text>
                  <Text style={styles.emptyText}>
                    Everyone in your contacts is already in
                    this group.
                  </Text>
                </View>
              }
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F7F8FA",
  },
  modalSafe: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  header: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E6EBE9",
    backgroundColor: "#FFFFFF",
  },
  headerIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "800",
    color: "#18201E",
  },
  content: {
    padding: 18,
    paddingBottom: 40,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 30,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#18201E",
  },
  emptyText: {
    marginTop: 6,
    textAlign: "center",
    color: "#697571",
  },
  primaryButton: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#176B5B",
  },
  primaryButtonText: {
    fontWeight: "800",
    color: "#FFFFFF",
  },
  identityCard: {
    alignItems: "center",
    padding: 20,
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
  },
  avatarWrap: {
    position: "relative",
  },
  avatarImage: {
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  avatarFallback: {
    width: 88,
    height: 88,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 44,
    backgroundColor: "#E6F2EF",
  },
  cameraBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 29,
    height: 29,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    backgroundColor: "#176B5B",
  },
  nameEditRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 17,
  },
  nameInput: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 11,
    fontSize: 17,
    fontWeight: "700",
    color: "#18201E",
  },
  saveButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 15,
    borderRadius: 11,
    backgroundColor: "#176B5B",
  },
  saveButtonText: {
    fontWeight: "800",
    color: "#FFFFFF",
  },
  disabled: {
    opacity: 0.45,
  },
  groupName: {
    marginTop: 16,
    fontSize: 22,
    fontWeight: "800",
    color: "#18201E",
  },
  groupMeta: {
    marginTop: 7,
    fontSize: 13,
    color: "#77827E",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 20,
    marginBottom: 9,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#18201E",
  },
  addButton: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: "#E6F2EF",
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#176B5B",
  },
  membersCard: {
    overflow: "hidden",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  memberRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
  },
  memberBorder: {
    borderBottomWidth: 1,
    borderBottomColor: "#E8ECEA",
  },
  memberInfo: {
    flex: 1,
    marginLeft: 11,
  },
  memberName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#18201E",
  },
  memberSub: {
    marginTop: 3,
    fontSize: 11,
    color: "#84908C",
  },
  roleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  roleText: {
    textTransform: "capitalize",
    fontSize: 12,
    fontWeight: "700",
    color: "#74807C",
  },
  ownerRole: {
    color: "#176B5B",
  },
  leaveButton: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 20,
    borderWidth: 1,
    borderColor: "#F1C6C1",
    borderRadius: 14,
    backgroundColor: "#FFF8F7",
  },
  leaveText: {
    fontWeight: "800",
    color: "#B42318",
  },
  ownerNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 20,
    padding: 13,
    borderRadius: 13,
    backgroundColor: "#EAF4F1",
  },
  ownerNoticeText: {
    flex: 1,
    lineHeight: 18,
    fontSize: 12,
    color: "#48605A",
  },
  chatNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 12,
    padding: 13,
    borderRadius: 13,
    backgroundColor: "#FFFFFF",
  },
  chatNoticeText: {
    flex: 1,
    lineHeight: 18,
    fontSize: 12,
    color: "#5E6B67",
  },
  modalHeader: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#E6EBE9",
  },
  modalTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "800",
    color: "#18201E",
  },
  modalList: {
    paddingHorizontal: 14,
    paddingBottom: 30,
  },
  pressed: {
    opacity: 0.72,
  },
});
