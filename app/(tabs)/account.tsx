import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";

type Profile = {
  display_name: string | null;
  email: string | null;
  qall_id: string;
  avatar_url: string | null;
};

export default function AccountScreen() {
  const { user, signOut } = useAuth();

  const [profile, setProfile] =
    useState<Profile | null>(null);
  const [displayName, setDisplayName] =
    useState("");
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] =
    useState(false);
  const [uploadingAvatar, setUploadingAvatar] =
    useState(false);
  const [signingOut, setSigningOut] =
    useState(false);

  useEffect(() => {
    if (user) {
      loadProfile();
    }
  }, [user]);

  async function loadProfile() {
    if (!user) {
      return;
    }

    try {
      setLoading(true);

      const { data, error } = await supabase
        .from("profiles")
        .select(
          "display_name, email, qall_id, avatar_url"
        )
        .eq("id", user.id)
        .single();

      if (error) {
        throw error;
      }

      const loadedProfile = data as Profile;

      setProfile(loadedProfile);
      setDisplayName(
        loadedProfile.display_name ?? ""
      );
    } catch (error) {
      Alert.alert(
        "Profile error",
        error instanceof Error
          ? error.message
          : "Could not load your account."
      );
    } finally {
      setLoading(false);
    }
  }

  async function saveProfile() {
    if (!user || savingProfile) {
      return;
    }

    const trimmedName = displayName.trim();

    if (!trimmedName) {
      Alert.alert(
        "Display name required",
        "Please enter a display name."
      );
      return;
    }

    if (trimmedName.length > 60) {
      Alert.alert(
        "Display name too long",
        "Display names can contain up to 60 characters."
      );
      return;
    }

    try {
      setSavingProfile(true);

      const { data, error } = await supabase
        .from("profiles")
        .update({
          display_name: trimmedName,
        })
        .eq("id", user.id)
        .select(
          "display_name, email, qall_id, avatar_url"
        )
        .single();

      if (error) {
        throw error;
      }

      setProfile(data as Profile);
      setDisplayName(
        (data as Profile).display_name ?? ""
      );

      Alert.alert(
        "Account updated",
        "Your profile information was saved."
      );
    } catch (error) {
      Alert.alert(
        "Update error",
        error instanceof Error
          ? error.message
          : "Could not update your account."
      );
    } finally {
      setSavingProfile(false);
    }
  }

  async function chooseAvatar() {
    if (!user || uploadingAvatar) {
      return;
    }

    const permission =
      await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert(
        "Photo permission required",
        "Allow Global Qall to access your photos so you can choose an account picture."
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

    if (
      result.canceled ||
      result.assets.length === 0
    ) {
      return;
    }

    const asset = result.assets[0];

    try {
      setUploadingAvatar(true);

      const extension =
        asset.fileName
          ?.split(".")
          .pop()
          ?.toLowerCase() ??
        asset.mimeType?.split("/").pop() ??
        "jpg";

      const avatarPath =
        `${user.id}/avatar-${Date.now()}.${extension}`;

      const response = await fetch(asset.uri);
      const fileData = await response.arrayBuffer();

      const { error: uploadError } =
        await supabase.storage
          .from("avatars")
          .upload(avatarPath, fileData, {
            contentType:
              asset.mimeType ?? "image/jpeg",
            upsert: true,
          });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } =
        supabase.storage
          .from("avatars")
          .getPublicUrl(avatarPath);

      const avatarUrl =
        `${publicUrlData.publicUrl}?v=${Date.now()}`;

      const { data, error } = await supabase
        .from("profiles")
        .update({
          avatar_url: avatarUrl,
        })
        .eq("id", user.id)
        .select(
          "display_name, email, qall_id, avatar_url"
        )
        .single();

      if (error) {
        throw error;
      }

      setProfile(data as Profile);
    } catch (error) {
      Alert.alert(
        "Avatar error",
        error instanceof Error
          ? error.message
          : "Could not upload your account picture."
      );
    } finally {
      setUploadingAvatar(false);
    }
  }

  function confirmRemoveAvatar() {
    if (!profile?.avatar_url) {
      return;
    }

    Alert.alert(
      "Remove account picture",
      "Your initials will be shown instead.",
      [
        {
          text: "Remove",
          style: "destructive",
          onPress: removeAvatar,
        },
        {
          text: "Cancel",
          style: "cancel",
        },
      ]
    );
  }

  async function removeAvatar() {
    if (!user || uploadingAvatar) {
      return;
    }

    try {
      setUploadingAvatar(true);

      const { data: objects, error: listError } =
        await supabase.storage
          .from("avatars")
          .list(user.id, {
            limit: 100,
          });

      if (listError) {
        throw listError;
      }

      const paths =
        (objects ?? []).map(
          (item) => `${user.id}/${item.name}`
        );

      if (paths.length > 0) {
        const { error: removeError } =
          await supabase.storage
            .from("avatars")
            .remove(paths);

        if (removeError) {
          throw removeError;
        }
      }

      const { data, error } = await supabase
        .from("profiles")
        .update({
          avatar_url: null,
        })
        .eq("id", user.id)
        .select(
          "display_name, email, qall_id, avatar_url"
        )
        .single();

      if (error) {
        throw error;
      }

      setProfile(data as Profile);
    } catch (error) {
      Alert.alert(
        "Avatar error",
        error instanceof Error
          ? error.message
          : "Could not remove your account picture."
      );
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function shareQallId() {
    if (!profile?.qall_id) {
      return;
    }

    await Share.share({
      message:
        `Connect with me on Global Qall. ` +
        `My Qall ID is ${profile.qall_id}.`,
    });
  }

  async function handleSignOut() {
    try {
      setSigningOut(true);
      await signOut();
    } catch (error) {
      Alert.alert(
        "Sign out error",
        error instanceof Error
          ? error.message
          : "Could not sign out."
      );
    } finally {
      setSigningOut(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator
          size="large"
          color="#176B5B"
        />
      </SafeAreaView>
    );
  }

  const initial =
    profile?.display_name
      ?.trim()
      .charAt(0)
      .toUpperCase() ??
    user?.email
      ?.trim()
      .charAt(0)
      .toUpperCase() ??
    "G";

  const canSaveProfile =
    displayName.trim().length > 0 &&
    displayName.trim().length <= 60;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.profileHeader}>
          <View style={styles.avatarContainer}>
            {profile?.avatar_url ? (
              <Image
                source={{
                  uri: profile.avatar_url,
                }}
                style={styles.avatarImage}
              />
            ) : (
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {initial}
                </Text>
              </View>
            )}

            {uploadingAvatar && (
              <View style={styles.avatarLoadingOverlay}>
                <ActivityIndicator
                  color="#FFFFFF"
                />
              </View>
            )}

            <Pressable
              onPress={chooseAvatar}
              disabled={uploadingAvatar}
              style={({ pressed }) => [
                styles.avatarEditButton,
                pressed && styles.pressed,
                uploadingAvatar && styles.disabled,
              ]}
            >
              <Ionicons
                name="camera"
                size={18}
                color="#FFFFFF"
              />
            </Pressable>
          </View>

          <Pressable
            onPress={chooseAvatar}
            disabled={uploadingAvatar}
            style={({ pressed }) => [
              styles.changePhotoButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.changePhotoText}>
              {profile?.avatar_url
                ? "Change account picture"
                : "Add account picture"}
            </Text>
          </Pressable>

          {profile?.avatar_url && (
            <Pressable
              onPress={confirmRemoveAvatar}
              disabled={uploadingAvatar}
              style={({ pressed }) => [
                styles.removePhotoButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.removePhotoText}>
                Remove picture
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.accountCard}>
          <View style={styles.fieldHeader}>
            <Text style={styles.fieldLabel}>
              Display name
            </Text>

            <View style={styles.editableBadge}>
              <Ionicons
                name="create-outline"
                size={14}
                color="#176B5B"
              />
              <Text style={styles.editableBadgeText}>
                Editable
              </Text>
            </View>
          </View>

          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your display name"
            maxLength={60}
            autoCapitalize="words"
            style={styles.input}
          />

          <Text style={styles.fieldLabel}>
            Email
          </Text>

          <View style={styles.readOnlyField}>
            <Ionicons
              name="mail-outline"
              size={19}
              color="#65706D"
            />
            <Text style={styles.readOnlyText}>
              {profile?.email ??
                user?.email ??
                "No email"}
            </Text>
          </View>

          <Text style={styles.emailHint}>
            Email changes are managed through your
            sign-in account.
          </Text>

          <Pressable
            onPress={saveProfile}
            disabled={
              savingProfile ||
              !canSaveProfile
            }
            style={({ pressed }) => [
              styles.saveButton,
              pressed && styles.pressed,
              (savingProfile ||
                !canSaveProfile) &&
                styles.disabled,
            ]}
          >
            {savingProfile ? (
              <ActivityIndicator
                color="#FFFFFF"
              />
            ) : (
              <>
                <Ionicons
                  name="checkmark-circle-outline"
                  size={21}
                  color="#FFFFFF"
                />
                <Text style={styles.saveText}>
                  Save Profile
                </Text>
              </>
            )}
          </Pressable>
        </View>

        <View style={styles.qallCard}>
          <Text style={styles.label}>
            Global Qall ID
          </Text>

          <Text style={styles.qallId}>
            {profile?.qall_id ?? "---"}
          </Text>

          <Pressable
            onPress={shareQallId}
            style={({ pressed }) => [
              styles.shareButton,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="share-social-outline"
              size={20}
              color="#176B5B"
            />
            <Text style={styles.shareText}>
              Share Qall ID
            </Text>
          </Pressable>
        </View>

        <Pressable
          onPress={handleSignOut}
          disabled={signingOut}
          style={({ pressed }) => [
            styles.signOutButton,
            pressed && styles.pressed,
            signingOut && styles.disabled,
          ]}
        >
          {signingOut ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Ionicons
                name="log-out-outline"
                size={21}
                color="#FFFFFF"
              />
              <Text style={styles.signOutText}>
                Sign Out
              </Text>
            </>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F7F8FA",
  },
  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F7F8FA",
  },
  container: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 36,
  },
  profileHeader: {
    alignItems: "center",
    paddingVertical: 14,
  },
  avatarContainer: {
    position: "relative",
    width: 96,
    height: 96,
  },
  avatar: {
    width: 96,
    height: 96,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 48,
    backgroundColor: "#176B5B",
  },
  avatarImage: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#DDE5E2",
  },
  avatarText: {
    fontSize: 36,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  avatarLoadingOverlay: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 48,
    backgroundColor: "rgba(0,0,0,0.42)",
  },
  avatarEditButton: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#F7F8FA",
    borderRadius: 18,
    backgroundColor: "#176B5B",
  },
  changePhotoButton: {
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  changePhotoText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#176B5B",
  },
  removePhotoButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  removePhotoText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#B42318",
  },
  accountCard: {
    marginTop: 10,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 17,
    backgroundColor: "#FFFFFF",
  },
  fieldHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 7,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#52615D",
  },
  editableBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: "#E6F2EF",
  },
  editableBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#176B5B",
  },
  input: {
    minHeight: 48,
    marginBottom: 17,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#D6E0DD",
    borderRadius: 12,
    backgroundColor: "#FAFCFB",
    fontSize: 16,
    color: "#18201E",
  },
  readOnlyField: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#E0E6E4",
    borderRadius: 12,
    backgroundColor: "#F1F4F3",
  },
  readOnlyText: {
    flex: 1,
    fontSize: 15,
    color: "#52615D",
  },
  emailHint: {
    marginTop: 7,
    fontSize: 11,
    lineHeight: 16,
    color: "#7A8582",
  },
  saveButton: {
    minHeight: 49,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 18,
    borderRadius: 12,
    backgroundColor: "#176B5B",
  },
  saveText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  qallCard: {
    marginTop: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 17,
    backgroundColor: "#FFFFFF",
  },
  label: {
    fontSize: 13,
    color: "#65706D",
  },
  qallId: {
    marginTop: 7,
    fontSize: 23,
    fontWeight: "800",
    letterSpacing: 1,
    color: "#18201E",
  },
  shareButton: {
    minHeight: 47,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 18,
    borderRadius: 12,
    backgroundColor: "#E6F2EF",
  },
  shareText: {
    fontWeight: "700",
    color: "#176B5B",
  },
  signOutButton: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 24,
    borderRadius: 14,
    backgroundColor: "#B42318",
  },
  signOutText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  pressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.55,
  },
});
