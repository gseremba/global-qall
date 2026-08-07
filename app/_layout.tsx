import { Stack } from "expo-router";
import { useEffect } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  View,
} from "react-native";

import { IncomingCallProvider } from "../components/IncomingCallProvider";

import {
  AuthProvider,
  useAuth,
} from "../contexts/AuthContext";

import {
  initializeVoipPushEvents,
  setVoipPushUser,
} from "../lib/voipPush";

function VoipPushRegistration() {
  const { session, loading } = useAuth();

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    try {
      cleanup = initializeVoipPushEvents();
    } catch (error) {
      console.error("VoIP initialization failed:", error);
    }

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (loading) {
      return;
    }

    setVoipPushUser(session?.user?.id ?? null);
  }, [session?.user?.id, loading]);

  return null;
}

function RootNavigator() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#176B5B" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-up" />
      </Stack.Protected>

      <Stack.Protected guard={Boolean(session)}>
        <Stack.Screen name="(tabs)" />

        <Stack.Screen
          name="call/[callId]"
          options={{ headerShown: false }}
        />

        <Stack.Screen
          name="calls"
          options={{ headerShown: false }}
        />

        <Stack.Screen
          name="contact/[userId]"
          options={{ headerShown: false }}
        />

        <Stack.Screen
          name="chat/[conversationId]"
          options={{
            headerShown: true,
            title: "Chat",
            headerBackTitle: "Back",
          }}
        />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <VoipPushRegistration />

      <IncomingCallProvider>
        <RootNavigator />
      </IncomingCallProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
});