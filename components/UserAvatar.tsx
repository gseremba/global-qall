import { Image, StyleSheet, Text, View } from "react-native";

type UserAvatarProps = {
  avatarUrl?: string | null;
  name?: string | null;
  size?: number;
  online?: boolean;
};

export function UserAvatar({
  avatarUrl,
  name,
  size = 44,
  online = false,
}: UserAvatarProps) {
  const initial =
    name?.trim().charAt(0).toUpperCase() || "G";

  return (
    <View
      style={{
        width: size,
        height: size,
        position: "relative",
      }}
    >
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: "#DDE5E2",
          }}
        />
      ) : (
        <View
          style={[
            styles.fallback,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
            },
          ]}
        >
          <Text
            style={[
              styles.initial,
              {
                fontSize: Math.max(14, size * 0.38),
              },
            ]}
          >
            {initial}
          </Text>
        </View>
      )}

      {online && (
        <View
          style={[
            styles.onlineDot,
            {
              width: Math.max(11, size * 0.28),
              height: Math.max(11, size * 0.28),
              borderRadius: Math.max(11, size * 0.28) / 2,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#176B5B",
  },
  initial: {
    fontWeight: "800",
    color: "#FFFFFF",
  },
  onlineDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    backgroundColor: "#22A06B",
  },
});
