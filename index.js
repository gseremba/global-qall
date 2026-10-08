import { Platform } from "react-native";

console.log("[ANDROID 12.5D] index.js started", {
  platform: Platform.OS,
});

if (Platform.OS === "android") {
  console.log("[ANDROID 12.5D] Loading native call push module");

  require("./lib/androidNativeCallPush");

  console.log("[ANDROID 12.5D] Native call push module loaded");
}

console.log("[ANDROID 12.5D] Loading Expo Router");

require("expo-router/entry");
