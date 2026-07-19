import Ionicons from "@expo/vector-icons/Ionicons";
import {
  Stack,
  router,
  useLocalSearchParams,
} from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { UserAvatar } from "../../components/UserAvatar";
import {
  createVideoCall,
  createVoiceCall,
} from "../../lib/calling";
import { supabase } from "../../lib/supabase";
import { useEffect, useState } from "react";

type ContactProfile = {
  id: string;
  display_name: string | null;
  qall_id: string;
  avatar_url: string | null;
};

export default function ContactProfileScreen() {
  const params = useLocalSearchParams<{
    userId?: string | string[];
    contactId?: string | string[];
    contactName?: string | string[];
  }>();

  const userId = Array.isArray(params.userId)
    ? params.userId[0]
    : params.userId;

  const contactId = Array.isArray(params.contactId)
    ? params.contactId[0]
    : params.contactId;

  const savedContactName = Array.isArray(
    params.contactName
  )
    ? params.contactName[0]
    : params.contactName;

  const [profile, setProfile] =
    useState<ContactProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadProfile();
  }, [userId]);

  async function loadProfile() {
    if (!userId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);

      const { data, error } = await supabase
        .from("profiles")
        .select(
          "id, display_name, qall_id, avatar_url"
        )
        .eq("id", userId)
        .single();

      if (error) {
        throw error;
      }

      setProfile(data as ContactProfile);
    } catch (error) {
      Alert.alert(
        "Profile error",
        error instanceof Error
          ? error.message
          : "Could not load this contact."
      );
    } finally {
      setLoading(false);
    }
  }

  async function openChat() {
    if (!userId) {
      return;
    }

    try {
      const { data, error } = await supabase.rpc(
        "get_or_create_direct_conversation",
        {
          other_user_id: userId,
        }
      );

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error(
          "Could not create the conversation."
        );
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

  async function startCall(
    type: "voice" | "video"
  ) {
    if (!userId) {
      return;
    }

    try {
      const callId =
        type === "video"
          ? await createVideoCall(userId)
          : await createVoiceCall(userId);

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

  function confirmDeleteContact() {
    if (!contactId) {
      return;
    }

    Alert.alert(
      "Delete contact?",
      `${
        savedContactName ??
        profile?.display_name ??
        "This contact"
      } will be removed from your contacts.`,
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: deleteContact,
        },
      ]
    );
  }

  async function deleteContact() {
    if (!contactId || deleting) {
      return;
    }

    try {
      setDeleting(true);

      const { error } = await supabase
        .from("contacts")
        .delete()
        .eq("id", contactId);

      if (error) {
        throw error;
      }

      router.back();
    } catch (error) {
      Alert.alert(
        "Delete error",
        error instanceof Error
          ? error.message
          : "Could not delete this contact."
      );
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.centerScreen}>
        <ActivityIndicator
          size="large"
          color="#176B5B"
        />
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.centerScreen}>
        <Text style={styles.notFoundTitle}>
          Contact unavailable
        </Text>
        <Text style={styles.notFoundText}>
          This profile could not be loaded.
        </Text>
      </SafeAreaView>
    );
  }

  const visibleName =
    savedContactName?.trim() ||
    profile.display_name?.trim() ||
    "Global Qall User";

  return (
    <>
      <Stack.Screen
        options={{
          title: "Contact Info",
          headerBackTitle: "Contacts",
        }}
      />

      <SafeAreaView style={styles.safeArea}>
	  
		<View style={styles.topBar}>
			<Pressable
			  onPress={() => router.back()}
			  style={({ pressed }) => [
				styles.backButton,
				pressed && styles.pressed,
			  ]}
			>
			  <Ionicons
				name="chevron-back"
				size={24}
				color="#176B5B"
			  />
			  <Text style={styles.backText}>
				Contacts
			  </Text>
			</Pressable>
		</View>	  
	  
        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
        >
		
          <View style={styles.profileHeader}>
            <UserAvatar
              avatarUrl={profile.avatar_url}
              name={visibleName}
              size={112}
            />

            <Text style={styles.displayName}>
              {visibleName}
            </Text>

            {savedContactName &&
              profile.display_name &&
              savedContactName !==
                profile.display_name && (
                <Text style={styles.accountName}>
                  {profile.display_name}
                </Text>
              )}

            <Text style={styles.qallId}>
              {profile.qall_id}
            </Text>
          </View>

          <View style={styles.primaryActions}>
            <Pressable
              onPress={openChat}
              style={({ pressed }) => [
                styles.primaryAction,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.primaryActionIcon}>
                <Ionicons
                  name="chatbubble-outline"
                  size={23}
                  color="#176B5B"
                />
              </View>
              <Text style={styles.primaryActionText}>
                Message
              </Text>
            </Pressable>

            <Pressable
              onPress={() => void startCall("voice")}
              style={({ pressed }) => [
                styles.primaryAction,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.primaryActionIcon}>
                <Ionicons
                  name="call-outline"
                  size={23}
                  color="#176B5B"
                />
              </View>
              <Text style={styles.primaryActionText}>
                Qall
              </Text>
            </Pressable>

            <Pressable
              onPress={() => void startCall("video")}
              style={({ pressed }) => [
                styles.primaryAction,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.primaryActionIcon}>
                <Ionicons
                  name="videocam-outline"
                  size={24}
                  color="#176B5B"
                />
              </View>
              <Text style={styles.primaryActionText}>
                Video
              </Text>
            </Pressable>
          </View>

          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <View style={styles.infoIcon}>
                <Ionicons
                  name="person-outline"
                  size={20}
                  color="#176B5B"
                />
              </View>
              <View style={styles.infoContent}>
                <Text style={styles.infoLabel}>
                  Account name
                </Text>
                <Text style={styles.infoValue}>
                  {profile.display_name ??
                    "Global Qall User"}
                </Text>
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.infoRow}>
              <View style={styles.infoIcon}>
                <Ionicons
                  name="keypad-outline"
                  size={20}
                  color="#176B5B"
                />
              </View>
              <View style={styles.infoContent}>
                <Text style={styles.infoLabel}>
                  Global Qall ID
                </Text>
                <Text style={styles.infoValue}>
                  {profile.qall_id}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.sectionCard}>
            <Pressable
              onPress={openChat}
              style={({ pressed }) => [
                styles.menuRow,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons
                name="images-outline"
                size={22}
                color="#52615D"
              />
              <Text style={styles.menuText}>
                Shared media, links and files
              </Text>
              <Ionicons
                name="chevron-forward"
                size={20}
                color="#9AA5A1"
              />
            </Pressable>
          </View>

          {contactId && (
            <Pressable
              onPress={confirmDeleteContact}
              disabled={deleting}
              style={({ pressed }) => [
                styles.deleteButton,
                pressed && styles.pressed,
                deleting && styles.disabled,
              ]}
            >
              {deleting ? (
                <ActivityIndicator color="#B42318" />
              ) : (
                <>
                  <Ionicons
                    name="person-remove-outline"
                    size={21}
                    color="#B42318"
                  />
                  <Text style={styles.deleteText}>
                    Delete Contact
                  </Text>
                </>
              )}
            </Pressable>
          )}
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F7F8FA",
  },
  centerScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#F7F8FA",
  },
  container: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 36,
  },
  profileHeader: {
    alignItems: "center",
    paddingTop: 12,
    paddingBottom: 24,
  },
  displayName: {
    marginTop: 16,
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
    color: "#18201E",
  },
  accountName: {
    marginTop: 4,
    fontSize: 14,
    color: "#65706D",
  },
  qallId: {
    marginTop: 7,
    fontSize: 14,
    letterSpacing: 0.5,
    color: "#65706D",
  },
  primaryActions: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 18,
  },
  primaryAction: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: "#DDE5E2",
    borderRadius: 15,
    backgroundColor: "#FFFFFF",
  },
  primaryActionIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: "#E6F2EF",
  },
  primaryActionText: {
    marginTop: 7,
    fontSize: 12,
    fontWeight: "700",
    color: "#176B5B",
  },
  infoCard: {
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 17,
    backgroundColor: "#FFFFFF",
  },
  infoRow: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
  },
  infoIcon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    backgroundColor: "#EAF5F2",
  },
  infoContent: {
    flex: 1,
    marginLeft: 12,
  },
  infoLabel: {
    fontSize: 12,
    color: "#7A8582",
  },
  infoValue: {
    marginTop: 3,
    fontSize: 15,
    fontWeight: "700",
    color: "#18201E",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 52,
    backgroundColor: "#E3E8E6",
  },
  sectionCard: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 17,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
  },
  menuRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
  },
  menuText: {
    flex: 1,
    fontSize: 15,
    color: "#18201E",
  },
  deleteButton: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 22,
    borderWidth: 1,
    borderColor: "#F2C8C4",
    borderRadius: 14,
    backgroundColor: "#FFF5F4",
  },
  deleteText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#B42318",
  },
  notFoundTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#18201E",
  },
  notFoundText: {
    marginTop: 7,
    textAlign: "center",
    color: "#65706D",
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.5,
  },
  
topBar: {
  flexDirection: "row",
  alignItems: "center",
  paddingHorizontal: 16,
  paddingTop: 12,
  paddingBottom: 8,
},

backButton: {
  flexDirection: "row",
  alignItems: "center",
},

backText: {
  marginLeft: 4,
  fontSize: 16,
  fontWeight: "600",
  color: "#176B5B",
},

  
});
