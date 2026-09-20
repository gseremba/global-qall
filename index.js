import { Platform } from "react-native";

// Register Android FCM background handling before Expo Router boots.
if (Platform.OS === "android") {
  require("./lib/androidNativeCallPush");
}

require("expo-router/entry");
