import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
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

import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";

type Profile = {
  display_name: string | null;
  email: string | null;
  qall_id: string;
};

type QuickActionProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
};

function QuickAction({
  icon,
  label,
  onPress,
}: QuickActionProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.quickAction,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.quickIcon}>
        <Ionicons
          name={icon}
          size={23}
          color="#176B5B"
        />
      </View>

      <Text style={styles.quickLabel}>{label}</Text>
    </Pressable>
  );
}

export default function HomeScreen() {
  const { user } = useAuth();

  const [profile, setProfile] =
    useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

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
        .select("display_name, email, qall_id")
        .eq("id", user.id)
        .single();

      if (error) {
        throw error;
      }

      setProfile(data);
    } catch (error) {
      Alert.alert(
        "Profile error",
        error instanceof Error
          ? error.message
          : "Could not load your profile."
      );
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#176B5B" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.welcome}>
          Welcome, {profile?.display_name ?? "Global Qall User"}
        </Text>

        <Text style={styles.subtitle}>
          Connect without sharing a telephone number.
        </Text>

        <View style={styles.qallCard}>
          <Text style={styles.cardLabel}>
            Your Global Qall ID
          </Text>

          <Text
            style={styles.qallId}
            adjustsFontSizeToFit
            numberOfLines={1}
          >
            {profile?.qall_id ?? "---"}
          </Text>

          <Text style={styles.cardHint}>
            People can use this ID to call or message you.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Quick actions</Text>

        <View style={styles.quickGrid}>
          <QuickAction
            icon="call-outline"
            label="Audio Call"
            onPress={() => router.push("/qall")}
          />

          <QuickAction
            icon="videocam-outline"
            label="Video Call"
            onPress={() => router.push("/qall")}
          />

          <QuickAction
            icon="chatbubble-outline"
            label="New Chat"
            onPress={() => router.push("/chats")}
          />

          <QuickAction
            icon="person-add-outline"
            label="Add Contact"
            onPress={() => router.push("/contacts")}
          />
        </View>

        <Text style={styles.sectionTitle}>
          Recent activity
        </Text>

        <View style={styles.emptyCard}>
          <Ionicons
            name="time-outline"
            size={34}
            color="#82908C"
          />

          <Text style={styles.emptyTitle}>
            No recent activity
          </Text>

          <Text style={styles.emptyText}>
            Your recent calls and messages will appear here.
          </Text>
        </View>
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
    padding: 20,
    paddingBottom: 30,
  },
  welcome: {
    fontSize: 25,
    fontWeight: "800",
    color: "#18201E",
  },
  subtitle: {
    marginTop: 6,
    marginBottom: 22,
    fontSize: 15,
    color: "#65706D",
  },
  qallCard: {
    padding: 22,
    borderRadius: 20,
    backgroundColor: "#176B5B",
  },
  cardLabel: {
    fontSize: 14,
    color: "#D8F0EB",
  },
  qallId: {
    marginVertical: 12,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: 1,
    color: "#FFFFFF",
  },
  cardHint: {
    lineHeight: 20,
    color: "#D8F0EB",
  },
  sectionTitle: {
    marginTop: 26,
    marginBottom: 13,
    fontSize: 18,
    fontWeight: "700",
    color: "#18201E",
  },
  quickGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  quickAction: {
    width: "48%",
    minHeight: 102,
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  quickIcon: {
    width: 45,
    height: 45,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 9,
    borderRadius: 23,
    backgroundColor: "#E6F2EF",
  },
  quickLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: "#26312E",
  },
  emptyCard: {
    alignItems: "center",
    padding: 28,
    borderWidth: 1,
    borderColor: "#E3E8E6",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  emptyTitle: {
    marginTop: 10,
    fontSize: 16,
    fontWeight: "700",
    color: "#26312E",
  },
  emptyText: {
    marginTop: 6,
    textAlign: "center",
    lineHeight: 20,
    color: "#72807C",
  },
  pressed: {
    opacity: 0.75,
  },
});