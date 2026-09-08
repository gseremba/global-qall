import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useMemo, useState } from "react";
import { useAudioPlayer } from "expo-audio";
import { router, useLocalSearchParams } from "expo-router";
import {
  Alert,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { createVideoCall, createVoiceCall } from "../../lib/calling";
import { supabase } from "../../lib/supabase";

const KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "*",
  "0",
  "#",
];

const DTMF_SOURCES: Record<string, number> = {
  "1": require("../../assets/sounds/1.wav"),
  "2": require("../../assets/sounds/2.wav"),
  "3": require("../../assets/sounds/3.wav"),
  "4": require("../../assets/sounds/4.wav"),
  "5": require("../../assets/sounds/5.wav"),
  "6": require("../../assets/sounds/6.wav"),
  "7": require("../../assets/sounds/7.wav"),
  "8": require("../../assets/sounds/8.wav"),
  "9": require("../../assets/sounds/9.wav"),
  "0": require("../../assets/sounds/0.wav"),
  "*": require("../../assets/sounds/star.wav"),
  "#": require("../../assets/sounds/pound.wav"),
};

function formatQallId(value: string): string {
  const groups = value.match(/.{1,3}/g);
  return groups?.join("-") ?? value;
}

export default function QallScreen() {
  const params = useLocalSearchParams<{
    qallId?: string | string[];
    selectionKey?: string | string[];
  }>();

  const incomingQallId = Array.isArray(params.qallId)
    ? params.qallId[0]
    : params.qallId;

  const incomingSelectionKey = Array.isArray(params.selectionKey)
    ? params.selectionKey[0]
    : params.selectionKey;


  const [digits, setDigits] = useState("");
  const keypadPlayer = useAudioPlayer(null);

  useEffect(() => {
    if (!incomingQallId) {
      return;
    }

    const incomingDigits = incomingQallId
      .replace(/\D/g, "")
      .slice(0, 12);

    // Always replace the previous dialer value when a contact button
    // opens this already-mounted tab. selectionKey changes on every press,
    // even if Expo Router reuses the same /qall screen instance.
    setDigits(incomingDigits);
  }, [incomingQallId, incomingSelectionKey]);

  const formattedId = useMemo(
    () => formatQallId(digits),
    [digits]
  );



  function playKeyTone(value: string) {
    const source = DTMF_SOURCES[value];
    if (!source) return;

    try {
      keypadPlayer.replace(source);
      keypadPlayer.volume = 0.55;
      keypadPlayer.play();
    } catch (error) {
      console.warn("Could not play keypad tone:", error);
    }
  }

  function addDigit(value: string) {
    // Always give immediate keypad feedback, even if the Qall ID is full.
    playKeyTone(value);

    if (digits.length >= 12) {
      return;
    }

    setDigits((current) => current + value);
  }

  function deleteDigit() {
    setDigits((current) => current.slice(0, -1));
  }

  function cancel() {
    setDigits("");
  }

  async function beginCall(type: "Audio" | "Video") {
    if (digits.length !== 12) {
      Alert.alert(
        "Incomplete Qall ID",
        "Enter all 12 digits before starting the call."
      );
      return;
    }

    try {
      const { data, error } = await supabase.rpc(
        "find_profile_by_qall_id",
        { requested_qall_id: formattedId }
      );

      if (error) throw error;
      const profile = data?.[0] as { id?: string } | undefined;

      if (!profile?.id) {
        Alert.alert(
          "Contact not found",
          "No Global Qall account was found with that ID."
        );
        return;
      }

      const callId =
        type === "Video"
          ? await createVideoCall(profile.id)
          : await createVoiceCall(profile.id);
      router.push({
        pathname: "/call/[callId]",
        params: { callId, direction: "outgoing" },
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.screenHeader}>
          <View style={styles.headerSpacer} />
          <Text style={styles.screenTitle}>Qall</Text>
          <Pressable
            onPress={() => router.push("/calls")}
            style={({ pressed }) => [
              styles.historyButton,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="time-outline"
              size={23}
              color="#176B5B"
            />
          </Pressable>
        </View>

        <Text style={styles.instruction}>
          Enter a Global Qall ID
        </Text>

        <View style={styles.display}>
          <Text
            style={[
              styles.displayText,
              !digits && styles.placeholderText,
            ]}
            adjustsFontSizeToFit
            numberOfLines={1}
          >
            {formattedId || "000-000-000-000"}
          </Text>
        </View>

        <View style={styles.keypad}>
          {KEYS.map((key) => (
            <Pressable
              key={key}
              onPress={() => addDigit(key)}
              style={({ pressed }) => [
                styles.key,
                pressed && styles.keyPressed,
              ]}
            >
              <Text style={styles.keyText}>{key}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.editActions}>
          <Pressable
            onPress={deleteDigit}
            disabled={!digits}
            style={({ pressed }) => [
              styles.textButton,
              pressed && styles.pressed,
              !digits && styles.disabled,
            ]}
          >
            <Ionicons
              name="backspace-outline"
              size={20}
              color="#44504D"
            />
            <Text style={styles.textButtonLabel}>
              Delete
            </Text>
          </Pressable>

          <Pressable
            onPress={cancel}
            disabled={!digits}
            style={({ pressed }) => [
              styles.textButton,
              pressed && styles.pressed,
              !digits && styles.disabled,
            ]}
          >
            <Ionicons
              name="close-circle-outline"
              size={20}
              color="#B42318"
            />
            <Text style={styles.cancelLabel}>
              Cancel
            </Text>
          </Pressable>
        </View>

        <View style={styles.callActions}>
          <Pressable
            onPress={() => beginCall("Audio")}
            style={({ pressed }) => [
              styles.audioButton,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="call"
              size={22}
              color="#FFFFFF"
            />
            <Text style={styles.callButtonText}>
              Audio Call
            </Text>
          </Pressable>

          <Pressable
            onPress={() => beginCall("Video")}
            style={({ pressed }) => [
              styles.videoButton,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name="videocam"
              size={23}
              color="#FFFFFF"
            />
            <Text style={styles.callButtonText}>
              Video Call
            </Text>
          </Pressable>
        </View>
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
    paddingHorizontal: 22,
    paddingTop: 18,
  },
  screenHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 7,
  },
  headerSpacer: {
    width: 42,
  },
  screenTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#18201E",
  },
  historyButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: "#E6F2EF",
  },
  instruction: {
    marginBottom: 11,
    textAlign: "center",
    fontSize: 15,
    color: "#65706D",
  },
  display: {
    minHeight: 70,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  displayText: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: 1,
    color: "#18201E",
  },
  placeholderText: {
    color: "#BEC7C4",
  },
  keypad: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 13,
  },
  key: {
    width: "29%",
    height: 72,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#DCE3E0",
  },
  keyPressed: {
    backgroundColor: "#E6F2EF",
    transform: [{ scale: 0.96 }],
  },
  keyText: {
    fontSize: 32,
    fontWeight: "500",
    color: "#18201E",
    textAlign: "center",
  },
  editActions: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 16,
  },
  textButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 10,
  },
  textButtonLabel: {
    fontWeight: "600",
    color: "#44504D",
  },
  cancelLabel: {
    fontWeight: "600",
    color: "#B42318",
  },
  callActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 15,
  },
  audioButton: {
    flex: 1,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 15,
    backgroundColor: "#176B5B",
  },
  videoButton: {
    flex: 1,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 15,
    backgroundColor: "#3157A4",
  },
  callButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.35,
  },
});