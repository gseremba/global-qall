import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect } from "react";
import { Tabs, useNavigation } from "expo-router";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  useEffect(() => {
    const logTabState = () => {
      const rootState = navigation.getState();

      const findTabState = (state: any): any => {
        if (!state) return null;

        if (state.type === "tab") {
          return state;
        }

        const activeRoute = state.routes?.[state.index ?? 0];
        return findTabState(activeRoute?.state);
      };

      const tabState = findTabState(rootState);

      console.log("[TAB STATE]", {
        index: tabState?.index ?? null,
        activeRoute:
          tabState?.routes?.[tabState?.index ?? 0]?.name ?? null,
        routes:
          tabState?.routes?.map((route: any) => route.name) ?? [],
        timestamp: new Date().toISOString(),
      });
    };

    logTabState();

    const unsubscribe = navigation.addListener("state", logTabState);

    return unsubscribe;
  }, [navigation]);

  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerStyle: {
          backgroundColor: "#FFFFFF",
        },
        headerTitleStyle: {
          color: "#18201E",
          fontWeight: "700",
        },
        headerShadowVisible: false,
        tabBarActiveTintColor: "#176B5B",
        tabBarInactiveTintColor: "#7B8582",
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          height:
            Platform.OS === "android"
              ? 58 + Math.max(insets.bottom, 12)
              : 66,
          paddingTop: 7,
          paddingBottom:
            Platform.OS === "android"
              ? Math.max(insets.bottom, 12)
              : 8,
          backgroundColor: "#FFFFFF",
          borderTopColor: "#E4E9E7",
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          headerTitle: "Global Qall",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? "home" : "home-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />

      <Tabs.Screen
        name="chats"
        options={{
          title: "Chats",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={
                focused
                  ? "chatbubbles"
                  : "chatbubbles-outline"
              }
              color={color}
              size={size}
            />
          ),
        }}
      />

      <Tabs.Screen
        name="qall"
        options={{
          title: "Qall",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? "call" : "call-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />

      <Tabs.Screen
        name="contacts"
        options={{
          title: "Contacts",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? "people" : "people-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />

      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? "person" : "person-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />
    </Tabs>
  );
}