import { Link, router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { supabase } from "../lib/supabase";

export default function SignUpScreen() {
  const [displayName, setDisplayName] =
    useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] =
    useState("");
  const [confirmPassword, setConfirmPassword] =
    useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignUp() {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = displayName.trim();

    if (!normalizedName) {
      Alert.alert(
        "Display name required",
        "Please enter your display name."
      );
      return;
    }

    if (!normalizedEmail) {
      Alert.alert(
        "Email required",
        "Please enter your email address."
      );
      return;
    }

    if (password.length < 8) {
      Alert.alert(
        "Password too short",
        "Your password must contain at least 8 characters."
      );
      return;
    }

    if (password !== confirmPassword) {
      Alert.alert(
        "Passwords do not match",
        "Enter the same password in both fields."
      );
      return;
    }

    try {
      setLoading(true);

      const { data, error } =
        await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            data: {
              display_name: normalizedName,
            },
          },
        });

      if (error) {
        throw error;
      }

      if (!data.session) {
        Alert.alert(
          "Confirm your email",
          `We sent a confirmation link to ${normalizedEmail}. Open the email, confirm your account, and then return to Global Qall to sign in.`,
          [
            {
              text: "Go to Sign In",
              onPress: () => router.replace("/sign-in"),
            },
          ]
        );
        return;
      }

      router.replace("/");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Account creation failed.";

      Alert.alert(
        "Could not create account",
        message
      );
    } finally {
      setLoading(false);
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
          <Text style={styles.logo}>Global Qall</Text>
          <Text style={styles.title}>
            Create your account
          </Text>
          <Text style={styles.subtitle}>
            Your Global Qall ID will be generated
            automatically.
          </Text>
        </View>

        <View style={styles.form}>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Display name"
            autoCapitalize="words"
            style={styles.input}
          />

          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email address"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />

          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />

          <TextInput
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="Confirm password"
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />

          <Pressable
            onPress={handleSignUp}
            disabled={loading}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
              loading && styles.buttonDisabled,
            ]}
          >
            {loading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryButtonText}>
                Create Account
              </Text>
            )}
          </Pressable>

          <View style={styles.footerRow}>
            <Text style={styles.footerText}>
              Already have an account?
            </Text>

            <Link href="/sign-in" style={styles.link}>
              Sign In
            </Link>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f7f8fa",
  },
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  header: {
    marginBottom: 28,
  },
  logo: {
    marginBottom: 16,
    fontSize: 34,
    fontWeight: "800",
    color: "#176B5B",
  },
  title: {
    fontSize: 25,
    fontWeight: "700",
    color: "#18201E",
  },
  subtitle: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
    color: "#65706D",
  },
  form: {
    gap: 14,
  },
  input: {
    minHeight: 54,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#D9DFDD",
    borderRadius: 12,
    backgroundColor: "#ffffff",
    fontSize: 16,
  },
  primaryButton: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
    borderRadius: 12,
    backgroundColor: "#176B5B",
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#ffffff",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginTop: 12,
  },
  footerText: {
    color: "#65706D",
  },
  link: {
    fontWeight: "700",
    color: "#176B5B",
  },
});