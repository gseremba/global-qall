import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { useVideoPlayer, VideoView } from "expo-video";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import {
  Stack,
  router,
  useLocalSearchParams,
} from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  NativeScrollEvent,
  Linking,
  Modal,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  GestureHandlerRootView,
  Swipeable,
} from "react-native-gesture-handler";

import { useAuth } from "../../contexts/AuthContext";
import {
  createVideoCall,
  createVoiceCall,
} from "../../lib/calling";
import { startGroupCall, type GroupCallType } from "../../lib/groupCalling";
import { supabase } from "../../lib/supabase";
import { UserAvatar } from "../../components/UserAvatar";

const PAGE_SIZE = 30;
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;
const TYPING_TIMEOUT_MS = 1400;
const BOTTOM_THRESHOLD_PX = 90;
const REACTION_OPTIONS = ["❤️", "👍", "😂", "😮", "😢", "🙏"] as const;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_VOICE_DURATION_SECONDS = 5 * 60;
const VIEWER_WIDTH = Dimensions.get("window").width;

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  message_type:
    | "text"
    | "image"
    | "video"
    | "file"
    | "voice"
    | "system";
  image_urls: string[];
  video_url: string | null;
  video_duration_seconds: number | null;
  file_url: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
  file_mime_type: string | null;
  voice_url: string | null;
  voice_duration_seconds: number | null;
  link_url: string | null;
  link_title: string | null;
  link_description: string | null;
  link_image_url: string | null;
  link_site_name: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  reply_to_message_id: string | null;
  reply_to?: {
    id: string;
    sender_id: string;
    body: string;
    deleted_at: string | null;
    message_type?:
      | "text"
      | "image"
      | "video"
      | "file"
      | "voice"
      | "system";
    image_urls?: string[];
    video_url?: string | null;
    video_duration_seconds?: number | null;
    file_url?: string | null;
    file_name?: string | null;
    file_size_bytes?: number | null;
    file_mime_type?: string | null;
    voice_url?: string | null;
    voice_duration_seconds?: number | null;
    link_url?: string | null;
    link_title?: string | null;
    link_description?: string | null;
    link_image_url?: string | null;
    link_site_name?: string | null;
  } | null;
  client_status?: "sending" | "failed";
};

type MessageReaction = {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
};

type Partner = {
  user_id: string;
  contact_name: string;
  display_name: string | null;
  qall_id: string;
  avatar_url: string | null;
};

type GroupConversation = {
  id: string;
  name: string;
  avatar_url: string | null;
};

type GroupMemberProfile = {
  user_id: string;
  role: "owner" | "admin" | "member";
  display_name: string | null;
  qall_id: string | null;
  avatar_url: string | null;
};

function createReplySnapshot(message: Message) {
  return {
    id: message.id,
    sender_id: message.sender_id,
    body: message.body,
    deleted_at: message.deleted_at,
    message_type: message.message_type,
    image_urls: message.image_urls,
    video_url: message.video_url,
    video_duration_seconds:
      message.video_duration_seconds,
    file_url: message.file_url,
    file_name: message.file_name,
    file_size_bytes: message.file_size_bytes,
    file_mime_type: message.file_mime_type,
    voice_url: message.voice_url,
    voice_duration_seconds:
      message.voice_duration_seconds,
    link_url: message.link_url,
    link_title: message.link_title,
    link_description: message.link_description,
    link_image_url: message.link_image_url,
    link_site_name: message.link_site_name,
  };
}

async function hydrateReplyPreviews(
  conversationId: string,
  sourceMessages: Message[]
): Promise<Message[]> {
  const replyIds = Array.from(
    new Set(
      sourceMessages
        .map((message) => message.reply_to_message_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  if (replyIds.length === 0) {
    return sourceMessages;
  }

  const localById = new Map(
    sourceMessages.map((message) => [
      message.id,
      message,
    ])
  );

  const missingIds = replyIds.filter(
    (id) => !localById.has(id)
  );

  if (missingIds.length > 0) {
    const { data, error } = await supabase
      .from("messages")
      .select(
        `
          id,
          conversation_id,
          sender_id,
          body,
          message_type,
          image_urls,
          video_url,
          video_duration_seconds,
          file_url,
          file_name,
          file_size_bytes,
          file_mime_type,
          voice_url,
          voice_duration_seconds,
          link_url,
          link_title,
          link_description,
          link_image_url,
          link_site_name,
          created_at,
          edited_at,
          deleted_at,
          delivered_at,
          read_at,
          reply_to_message_id
        `
      )
      .eq("conversation_id", conversationId)
      .in("id", missingIds);

    if (error) {
      console.warn(
        "Could not hydrate reply previews:",
        error.message
      );
    } else {
      for (const message of (data ?? []) as Message[]) {
        localById.set(message.id, message);
      }
    }
  }

  return sourceMessages.map((message) => {
    if (!message.reply_to_message_id) {
      return {
        ...message,
        reply_to: null,
      };
    }

    const target =
      localById.get(message.reply_to_message_id) ?? null;

    return {
      ...message,
      reply_to: target
        ? createReplySnapshot(target)
        : message.reply_to ?? null,
    };
  });
}

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPresenceTime(value: string | null): string {
  if (!value) {
    return "offline";
  }

  const lastSeen = new Date(value);
  const now = new Date();
  const elapsedMinutes = Math.floor(
    (now.getTime() - lastSeen.getTime()) / 60000
  );

  if (elapsedMinutes < 1) {
    return "last seen just now";
  }

  if (elapsedMinutes < 60) {
    return `last seen ${elapsedMinutes} min ago`;
  }

  if (isSameCalendarDay(value, now.toISOString())) {
    return `last seen today at ${formatMessageTime(value)}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (isSameCalendarDay(value, yesterday.toISOString())) {
    return `last seen yesterday at ${formatMessageTime(value)}`;
  }

  return `last seen ${lastSeen.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })}`;
}

function isSameCalendarDay(
  firstValue: string,
  secondValue: string
): boolean {
  const first = new Date(firstValue);
  const second = new Date(secondValue);

  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function formatDateSeparator(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();

  yesterday.setDate(today.getDate() - 1);

  if (isSameCalendarDay(value, today.toISOString())) {
    return "Today";
  }

  if (isSameCalendarDay(value, yesterday.toISOString())) {
    return "Yesterday";
  }

  const sameYear =
    date.getFullYear() === today.getFullYear();

  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function messagesBelongToSameGroup(
  first: Message | undefined,
  second: Message | undefined
): boolean {
  if (!first || !second) {
    return false;
  }

  if (
    first.sender_id !== second.sender_id ||
    !isSameCalendarDay(
      first.created_at,
      second.created_at
    )
  ) {
    return false;
  }

  const timeDifference =
    new Date(second.created_at).getTime() -
    new Date(first.created_at).getTime();

  return (
    timeDifference >= 0 &&
    timeDifference <= MESSAGE_GROUP_WINDOW_MS
  );
}

function mergeMessage(
  currentMessages: Message[],
  incomingMessage: Message
): Message[] {
  if (
    currentMessages.some(
      (message) => message.id === incomingMessage.id
    )
  ) {
    return currentMessages;
  }

  return [...currentMessages, incomingMessage].sort(
    (first, second) =>
      new Date(first.created_at).getTime() -
      new Date(second.created_at).getTime()
  );
}

function reconcileMessage(
  currentMessages: Message[],
  incomingMessage: Message,
  currentUserId: string
): Message[] {
  const withoutMatchingOptimistic = currentMessages.filter(
    (message) =>
      !(
        message.client_status === "sending" &&
        message.sender_id === currentUserId &&
        message.body === incomingMessage.body
      )
  );

  return mergeMessage(
    withoutMatchingOptimistic,
    incomingMessage
  );
}

function getMessageStatusLabel(message: Message): string {
  if (message.client_status === "sending") {
    return "Sending";
  }

  if (message.client_status === "failed") {
    return "Failed";
  }

  if (message.read_at) {
    return `Read ${formatMessageTime(message.read_at)}`;
  }

  if (message.delivered_at) {
    return `Delivered ${formatMessageTime(
      message.delivered_at
    )}`;
  }

  return "Sent";
}

function getReceiptSymbol(message: Message): string {
  if (message.read_at || message.delivered_at) {
    return "✓✓";
  }

  return "✓";
}

function extractFirstUrl(value: string): string | null {
  const match = value.match(
    /https?:\/\/[^\s<>{}\[\]"']+/i
  );

  if (!match) {
    return null;
  }

  return match[0].replace(/[.,!?;:)]*$/, "");
}

function formatLinkHost(value: string): string {
  try {
    return new URL(value).hostname.replace(
      /^www\./i,
      ""
    );
  } catch {
    return value;
  }
}

function formatFileSize(
  value: number | null | undefined
): string {
  const bytes = value ?? 0;

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(
    bytes /
    (1024 * 1024)
  ).toFixed(1)} MB`;
}

function getFileExtension(
  fileName: string | null | undefined
): string {
  return (
    fileName
      ?.split(".")
      .pop()
      ?.toUpperCase() ?? "FILE"
  );
}

function getFileIconName(
  fileName: string | null | undefined
):
  | "document-text-outline"
  | "document-outline"
  | "archive-outline" {
  const extension = getFileExtension(fileName);

  if (extension === "ZIP" || extension === "RAR") {
    return "archive-outline";
  }

  if (
    ["TXT", "DOC", "DOCX", "PDF"].includes(
      extension
    )
  ) {
    return "document-text-outline";
  }

  return "document-outline";
}

function formatVideoDuration(
  value: number | null | undefined
): string {
  const totalSeconds = Math.max(
    0,
    Math.round(value ?? 0)
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

type VoiceMessagePlayerProps = {
  uri: string;
  durationSeconds: number | null;
  isMine: boolean;
};

function VoiceMessagePlayer({
  uri,
  durationSeconds,
  isMine,
}: VoiceMessagePlayerProps) {
  const player = useAudioPlayer(uri, {
    updateInterval: 250,
    downloadFirst: false,
  });
  const status = useAudioPlayerStatus(player);
  const [playbackRate, setPlaybackRate] =
    useState(1);

  const displayedDuration =
    status.duration > 0
      ? status.duration
      : durationSeconds ?? 0;

  const progress =
    displayedDuration > 0
      ? Math.min(
          1,
          status.currentTime / displayedDuration
        )
      : 0;

  function togglePlayback() {
    if (
      displayedDuration > 0 &&
      status.currentTime >=
        displayedDuration - 0.15
    ) {
      player.seekTo(0);
    }

    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  }

  function changeSpeed() {
    const nextRate =
      playbackRate === 1
        ? 1.5
        : playbackRate === 1.5
          ? 2
          : 1;

    setPlaybackRate(nextRate);
    player.playbackRate = nextRate;
  }

  return (
    <View style={styles.voiceMessageCard}>
      <Pressable
        onPress={togglePlayback}
        style={[
          styles.voicePlayButton,
          isMine && styles.myVoicePlayButton,
        ]}
      >
        <Ionicons
          name={
            status.playing
              ? "pause"
              : "play"
          }
          size={20}
          color={
            isMine ? "#176B5B" : "#FFFFFF"
          }
        />
      </Pressable>

      <View style={styles.voiceMainContent}>
        <View style={styles.voiceWaveform}>
          {Array.from({ length: 24 }).map(
            (_, index) => {
              const barProgress =
                (index + 1) / 24;
              const played =
                barProgress <= progress;
              const height =
                8 + ((index * 7) % 17);

              return (
                <View
                  key={index}
                  style={[
                    styles.voiceWaveBar,
                    {
                      height,
                    },
                    isMine
                      ? styles.myVoiceWaveBar
                      : styles.theirVoiceWaveBar,
                    played &&
                      (isMine
                        ? styles.myVoiceWaveBarPlayed
                        : styles.theirVoiceWaveBarPlayed),
                  ]}
                />
              );
            }
          )}
        </View>

        <View style={styles.voiceFooterRow}>
          <Text
            style={[
              styles.voiceTimeText,
              isMine && styles.myVoiceTimeText,
            ]}
          >
            {formatVideoDuration(
              status.playing ||
                status.currentTime > 0
                ? status.currentTime
                : displayedDuration
            )}
          </Text>

          <Pressable
            onPress={changeSpeed}
            style={styles.voiceSpeedButton}
          >
            <Text
              style={[
                styles.voiceSpeedText,
                isMine &&
                  styles.myVoiceSpeedText,
              ]}
            >
              {playbackRate}x
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

type RecordedVoicePreviewProps = {
  uri: string;
  durationSeconds: number;
};

function RecordedVoicePreview({
  uri,
  durationSeconds,
}: RecordedVoicePreviewProps) {
  const player = useAudioPlayer(uri, {
    updateInterval: 200,
  });
  const status = useAudioPlayerStatus(player);

  const totalDuration =
    status.duration > 0
      ? status.duration
      : durationSeconds;

  const progress =
    totalDuration > 0
      ? Math.min(
          1,
          status.currentTime / totalDuration
        )
      : 0;

  function togglePreview() {
    if (
      totalDuration > 0 &&
      status.currentTime >= totalDuration - 0.15
    ) {
      player.seekTo(0);
    }

    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  }

  function restartPreview() {
    player.seekTo(0);
    player.play();
  }

  return (
    <View style={styles.recordedVoicePreview}>
      <Pressable
        onPress={togglePreview}
        style={styles.recordedVoicePlayButton}
        accessibilityRole="button"
        accessibilityLabel={
          status.playing
            ? "Pause voice message preview"
            : "Play voice message preview"
        }
      >
        <Ionicons
          name={status.playing ? "pause" : "play"}
          size={20}
          color="#FFFFFF"
        />
      </Pressable>

      <View style={styles.recordedVoicePreviewMain}>
        <View style={styles.recordedVoiceProgressTrack}>
          <View
            style={[
              styles.recordedVoiceProgressFill,
              {
                width: `${progress * 100}%`,
              },
            ]}
          />
        </View>

        <View style={styles.recordedVoicePreviewFooter}>
          <Text style={styles.recordedVoicePreviewTime}>
            {formatVideoDuration(status.currentTime)}
          </Text>

          <Text style={styles.recordedVoicePreviewTime}>
            {formatVideoDuration(totalDuration)}
          </Text>
        </View>
      </View>

      <Pressable
        onPress={restartPreview}
        style={styles.recordedVoiceRestartButton}
        accessibilityRole="button"
        accessibilityLabel="Replay voice message preview"
      >
        <Ionicons
          name="refresh"
          size={19}
          color="#176B5B"
        />
      </Pressable>
    </View>
  );
}

type VideoMessagePlayerProps = {
  uri: string;
  compact?: boolean;
};

function VideoMessagePlayer({
  uri,
  compact = false,
}: VideoMessagePlayerProps) {
  const player = useVideoPlayer(
    {
      uri,
      useCaching: true,
    },
    (videoPlayer) => {
      videoPlayer.loop = false;
    }
  );

  return (
    <VideoView
      player={player}
      style={
        compact
          ? styles.compactVideoPlayer
          : styles.videoPlayer
      }
      nativeControls
      contentFit="cover"
      fullscreenOptions={{
        enable: true,
      }}
      allowsPictureInPicture
    />
  );
}

function groupReactions(
  reactions: MessageReaction[]
): Array<{
  emoji: string;
  count: number;
  userIds: string[];
}> {
  const grouped = new Map<
    string,
    {
      emoji: string;
      count: number;
      userIds: string[];
    }
  >();

  reactions.forEach((reaction) => {
    const existing = grouped.get(reaction.emoji);

    if (existing) {
      existing.count += 1;
      existing.userIds.push(reaction.user_id);
      return;
    }

    grouped.set(reaction.emoji, {
      emoji: reaction.emoji,
      count: 1,
      userIds: [reaction.user_id],
    });
  });

  return Array.from(grouped.values());
}

export default function ChatScreen() {
  const { user } = useAuth();

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] =
    useState(true);

  const [editingMessage, setEditingMessage] =
    useState<Message | null>(null);
  const [replyingToMessage, setReplyingToMessage] =
    useState<Message | null>(null);

  const [selectedMessageId, setSelectedMessageId] =
    useState<string | null>(null);

  const params = useLocalSearchParams<{
    conversationId?: string | string[];
  }>();

  const conversationId = Array.isArray(
    params.conversationId
  )
    ? params.conversationId[0]
    : params.conversationId;

  const listRef = useRef<FlatList<Message>>(null);
  const swipeableRefs = useRef<
    Record<string, Swipeable | null>
  >({});
  const openSwipeableIdRef = useRef<string | null>(
    null
  );
  const initialScrollCompletedRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const realtimeChannelRef = useRef<
    ReturnType<typeof supabase.channel> | null
  >(null);
  const typingTimeoutRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const sentTypingStateRef = useRef(false);

  const [initialListReady, setInitialListReady] =
    useState(false);
  const [showJumpToLatest, setShowJumpToLatest] =
    useState(false);
  const [unseenMessageCount, setUnseenMessageCount] =
    useState(0);
  const [partnerOnline, setPartnerOnline] =
    useState(false);
  const [partnerTyping, setPartnerTyping] =
    useState(false);
  const [partnerLastSeenAt, setPartnerLastSeenAt] =
    useState<string | null>(null);

  const [partner, setPartner] =
    useState<Partner | null>(null);
  const [conversationType, setConversationType] =
    useState<"direct" | "group">("direct");
  const [groupConversation, setGroupConversation] =
    useState<GroupConversation | null>(null);
  const [groupMembers, setGroupMembers] =
    useState<Record<string, GroupMemberProfile>>({});
  const [groupTypingUserIds, setGroupTypingUserIds] =
    useState<string[]>([]);
  const [messages, setMessages] =
    useState<Message[]>([]);
  const [reactionsByMessage, setReactionsByMessage] =
    useState<Record<string, MessageReaction[]>>({});
  const [reactionSavingForMessageId, setReactionSavingForMessageId] =
    useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [startingGroupCallType, setStartingGroupCallType] =
    useState<GroupCallType | null>(null);
  const [uploadingImages, setUploadingImages] =
    useState(false);
  const [uploadingVideo, setUploadingVideo] =
    useState(false);
  const [uploadingFile, setUploadingFile] =
    useState(false);
  const [uploadingVoice, setUploadingVoice] =
    useState(false);
  const [recordedVoiceUri, setRecordedVoiceUri] =
    useState<string | null>(null);
  const [recordedVoiceDuration, setRecordedVoiceDuration] =
    useState(0);
  const [viewerImages, setViewerImages] =
    useState<string[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);

  const audioRecorder = useAudioRecorder(
    RecordingPresets.HIGH_QUALITY
  );
  const recorderState = useAudioRecorderState(
    audioRecorder,
    200
  );

  const markAsRead = useCallback(async (
    requestedType?: "direct" | "group"
  ) => {
    if (!conversationId) {
      return;
    }

    const effectiveType =
      requestedType ?? conversationType;

    const { error } = await supabase.rpc(
      effectiveType === "group"
        ? "mark_group_conversation_read"
        : "mark_conversation_read",
      {
        requested_conversation_id: conversationId,
      }
    );

    if (error) {
      console.warn(
        "Could not mark conversation as read:",
        error.message
      );
    }
  }, [conversationId, conversationType]);

  const loadConversation = useCallback(async () => {
    if (!conversationId || !user) {
      return;
    }

    try {
      setLoading(true);
      initialScrollCompletedRef.current = false;
      isNearBottomRef.current = true;
      setInitialListReady(false);
      setShowJumpToLatest(false);
      setUnseenMessageCount(0);

      const { data: conversationRow, error: conversationError } =
        await supabase
          .from("conversations")
          .select("id, conversation_type, name, avatar_url")
          .eq("id", conversationId)
          .single();

      if (conversationError) {
        throw conversationError;
      }

      const isGroup =
        conversationRow.conversation_type === "group";

      setConversationType(isGroup ? "group" : "direct");

      let loadedPartner: Partner | null = null;
      let loadedGroup: GroupConversation | null = null;
      let loadedGroupMembers:
        Record<string, GroupMemberProfile> = {};

      if (isGroup) {
        loadedGroup = {
          id: conversationRow.id,
          name: conversationRow.name ?? "Group",
          avatar_url: conversationRow.avatar_url ?? null,
        };

        const { data: membershipRows, error: membershipError } =
          await supabase
            .from("conversation_members")
            .select("user_id, role")
            .eq("conversation_id", conversationId);

        if (membershipError) {
          throw membershipError;
        }

        const memberIds = (membershipRows ?? []).map(
          (row: any) => row.user_id
        );

        let profileRows: any[] = [];

        if (memberIds.length > 0) {
          const { data, error } = await supabase
            .from("profiles")
            .select("id, display_name, qall_id, avatar_url")
            .in("id", memberIds);

          if (error) {
            throw error;
          }

          profileRows = data ?? [];
        }

        const profileById = new Map(
          profileRows.map((profile) => [
            profile.id,
            profile,
          ])
        );

        loadedGroupMembers = Object.fromEntries(
          (membershipRows ?? []).map((membership: any) => {
            const profile =
              profileById.get(membership.user_id);

            return [
              membership.user_id,
              {
                user_id: membership.user_id,
                role: membership.role,
                display_name:
                  profile?.display_name ?? null,
                qall_id: profile?.qall_id ?? null,
                avatar_url:
                  profile?.avatar_url ?? null,
              } satisfies GroupMemberProfile,
            ];
          })
        );
      } else {
        const { data: partnerData, error: partnerError } =
          await supabase.rpc(
            "get_conversation_partner",
            {
              requested_conversation_id:
                conversationId,
            }
          );

        if (partnerError) {
          throw partnerError;
        }

        const foundPartner =
          partnerData?.[0] as Partner | undefined;

        if (!foundPartner) {
          throw new Error(
            "Conversation not found or access denied."
          );
        }

        const { data: partnerProfileData } =
          await supabase
            .from("profiles")
            .select("avatar_url")
            .eq("id", foundPartner.user_id)
            .maybeSingle();

        loadedPartner = {
          ...foundPartner,
          avatar_url:
            partnerProfileData?.avatar_url ?? null,
        };
      }

      const [messagesResponse, hiddenResponse] =
        await Promise.all([
          supabase
            .from("messages")
            .select(
              `
                id,
                conversation_id,
                sender_id,
                body,
                message_type,
                image_urls,
                video_url,
                video_duration_seconds,
                file_url,
                file_name,
                file_size_bytes,
                file_mime_type,
                voice_url,
                voice_duration_seconds,
                link_url,
                link_title,
                link_description,
                link_image_url,
                link_site_name,
                created_at,
                edited_at,
                deleted_at,
                delivered_at,
                read_at,
                reply_to_message_id
              `
            )
            .eq("conversation_id", conversationId)
            .order("created_at", {
              ascending: true,
            })
            .limit(500),

          supabase
            .from("message_hidden_for_users")
            .select("message_id")
            .eq("user_id", user.id),
        ]);

      if (messagesResponse.error) {
        throw messagesResponse.error;
      }

      if (hiddenResponse.error) {
        throw hiddenResponse.error;
      }

      const hiddenMessageIds = new Set(
        (hiddenResponse.data ?? []).map(
          (row) => row.message_id
        )
      );

      const allLoadedMessages =
        (messagesResponse.data ?? []) as Message[];

      const visibleMessages = allLoadedMessages.filter(
        (message) => !hiddenMessageIds.has(message.id)
      );

      const hydratedVisibleMessages =
        await hydrateReplyPreviews(
          conversationId,
          visibleMessages
        );

      let loadedReactions: MessageReaction[] = [];

      if (hydratedVisibleMessages.length > 0) {
        const { data: reactionsData, error: reactionsError } =
          await supabase
            .from("message_reactions")
            .select(
              "id, message_id, user_id, emoji, created_at"
            )
            .in(
              "message_id",
              hydratedVisibleMessages.map(
                (message) => message.id
              )
            )
            .order("created_at", {
              ascending: true,
            });

        if (reactionsError) {
          throw reactionsError;
        }

        loadedReactions =
          (reactionsData ?? []) as MessageReaction[];
      }

      const groupedReactions =
        loadedReactions.reduce<
          Record<string, MessageReaction[]>
        >((result, reaction) => {
          result[reaction.message_id] = [
            ...(result[reaction.message_id] ?? []),
            reaction,
          ];
          return result;
        }, {});

      setPartner(loadedPartner);
      setGroupConversation(loadedGroup);
      setGroupMembers(loadedGroupMembers);
      setMessages(hydratedVisibleMessages);
      setReactionsByMessage(groupedReactions);

      await markAsRead(
        isGroup ? "group" : "direct"
      );

      if (hydratedVisibleMessages.length === 0) {
        initialScrollCompletedRef.current = true;
        setInitialListReady(true);
      }
    } catch (error) {
      Alert.alert(
        "Chat error",
        error instanceof Error
          ? error.message
          : "Could not load the conversation."
      );
    } finally {
      setLoading(false);
    }
  }, [
    conversationId,
    markAsRead,
    user,
  ]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const permission =
          await AudioModule
            .requestRecordingPermissionsAsync();

        if (!permission.granted && active) {
          console.warn(
            "Microphone permission was not granted."
          );
        }

        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: true,
        });
      } catch (error) {
        console.warn(
          "Could not prepare audio:",
          error
        );
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      recorderState.isRecording &&
      recorderState.durationMillis >=
        MAX_VOICE_DURATION_SECONDS * 1000
    ) {
      stopVoiceRecording();
    }
  }, [
    recorderState.durationMillis,
    recorderState.isRecording,
  ]);

  useEffect(() => {
    loadConversation();
  }, [loadConversation]);

  useEffect(() => {
    if (!conversationId || !user) {
      return;
    }

    const channel = supabase.channel(
      `conversation-${conversationId}`,
      {
        config: {
          presence: {
            key: user.id,
          },
        },
      }
    );

    realtimeChannelRef.current = channel;

    const updatePartnerPresence = () => {
      const presenceState = channel.presenceState();

      const partnerIsPresent = Object.values(
        presenceState
      )
        .flat()
        .some((presence) => {
          const presenceUserId = (
            presence as {
              user_id?: string;
            }
          ).user_id;

          return (
            presenceUserId &&
            presenceUserId !== user.id
          );
        });

      setPartnerOnline(partnerIsPresent);

      if (!partnerIsPresent) {
        setPartnerTyping(false);
      }
    };

    channel
      .on(
        "presence",
        {
          event: "sync",
        },
        updatePartnerPresence
      )
      .on(
        "presence",
        {
          event: "join",
        },
        updatePartnerPresence
      )
      .on(
        "presence",
        {
          event: "leave",
        },
        () => {
          updatePartnerPresence();
          setPartnerTyping(false);
          setPartnerLastSeenAt(
            new Date().toISOString()
          );
        }
      )
      .on(
        "broadcast",
        {
          event: "typing",
        },
        ({ payload }) => {
          const typingPayload = payload as {
            user_id?: string;
            is_typing?: boolean;
          };

          if (
            typingPayload.user_id &&
            typingPayload.user_id !== user.id
          ) {
            if (conversationType === "group") {
              setGroupTypingUserIds((current) => {
                const next = new Set(current);
                if (typingPayload.is_typing) {
                  next.add(typingPayload.user_id!);
                } else {
                  next.delete(typingPayload.user_id!);
                }
                return Array.from(next);
              });
            } else {
              setPartnerTyping(
                Boolean(typingPayload.is_typing)
              );
            }
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          let incomingMessage =
            payload.new as Message;

          if (incomingMessage.reply_to_message_id) {
            const localReplyTarget = messages.find(
              (message) =>
                message.id ===
                incomingMessage.reply_to_message_id
            );

            if (localReplyTarget) {
              incomingMessage = {
                ...incomingMessage,
                reply_to:
                  createReplySnapshot(localReplyTarget),
              };
            } else {
              const hydrated =
                await hydrateReplyPreviews(
                  conversationId,
                  [incomingMessage]
                );
              incomingMessage =
                hydrated[0] ?? incomingMessage;
            }
          }

          setMessages((current) =>
            reconcileMessage(
              current,
              incomingMessage,
              user.id
            )
          );

          if (
            incomingMessage.sender_id !== user.id
          ) {
            if (conversationType === "group") {
              setGroupTypingUserIds((current) =>
                current.filter(
                  (id) => id !== incomingMessage.sender_id
                )
              );
            } else {
              setPartnerTyping(false);
            }
            markAsRead();
          }

          if (
            incomingMessage.sender_id === user.id ||
            isNearBottomRef.current
          ) {
            setTimeout(() => {
              listRef.current?.scrollToEnd({
                animated: true,
              });
            }, 80);

            setShowJumpToLatest(false);
            setUnseenMessageCount(0);
          } else {
            setShowJumpToLatest(true);
            setUnseenMessageCount(
              (current) => current + 1
            );
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const updatedMessage =
            payload.new as Message;

          setMessages((current) =>
            current.map((message) =>
              message.id === updatedMessage.id
                ? {
                    ...message,
                    ...updatedMessage,
                    reply_to: message.reply_to,
                  }
                : message
            )
          );
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_reactions",
        },
        (payload) => {
          const reaction =
            payload.new as MessageReaction;

          setReactionsByMessage((current) => {
            const existing =
              current[reaction.message_id] ?? [];

            if (
              existing.some(
                (item) => item.id === reaction.id
              )
            ) {
              return current;
            }

            return {
              ...current,
              [reaction.message_id]: [
                ...existing,
                reaction,
              ],
            };
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "message_reactions",
        },
        (payload) => {
          const reaction =
            payload.new as MessageReaction;

          setReactionsByMessage((current) => ({
            ...current,
            [reaction.message_id]: (
              current[reaction.message_id] ?? []
            ).map((item) =>
              item.id === reaction.id
                ? reaction
                : item
            ),
          }));
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "message_reactions",
        },
        (payload) => {
          const deletedReaction =
            payload.old as MessageReaction;

          setReactionsByMessage((current) => {
            const messageId =
              deletedReaction.message_id;

            if (!messageId) {
              return current;
            }

            return {
              ...current,
              [messageId]: (
                current[messageId] ?? []
              ).filter(
                (item) =>
                  item.id !== deletedReaction.id
              ),
            };
          });
        }
      )
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            user_id: user.id,
            online_at: new Date().toISOString(),
          });
        }
      });

    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      channel.untrack();
      realtimeChannelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [
    conversationId,
    markAsRead,
    user,
  ]);

  const sendTypingState = useCallback(
    (isTyping: boolean) => {
      if (!user || !realtimeChannelRef.current) {
        return;
      }

      if (
        sentTypingStateRef.current === isTyping
      ) {
        return;
      }

      sentTypingStateRef.current = isTyping;

      realtimeChannelRef.current.send({
        type: "broadcast",
        event: "typing",
        payload: {
          user_id: user.id,
          is_typing: isTyping,
        },
      });
    },
    [user]
  );

  function handleMessageTextChange(value: string) {
    setMessageText(value);

    if (editingMessage) {
      return;
    }

    const hasText = value.trim().length > 0;

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    if (!hasText) {
      sendTypingState(false);
      return;
    }

    sendTypingState(true);

    typingTimeoutRef.current = setTimeout(() => {
      sendTypingState(false);
    }, TYPING_TIMEOUT_MS);
  }

  function stopTyping() {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    sendTypingState(false);
  }

  const completeInitialScroll = useCallback(() => {
    if (
      initialScrollCompletedRef.current ||
      messages.length === 0
    ) {
      return;
    }

    initialScrollCompletedRef.current = true;

    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({
        animated: false,
      });

      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({
          animated: false,
        });
        setInitialListReady(true);
      });
    });
  }, [messages.length]);

  function handleMessageListScroll(
    event: NativeSyntheticEvent<NativeScrollEvent>
  ) {
    const {
      contentOffset,
      contentSize,
      layoutMeasurement,
    } = event.nativeEvent;

    const distanceFromBottom =
      contentSize.height -
      layoutMeasurement.height -
      contentOffset.y;

    const isNearBottom =
      distanceFromBottom <= BOTTOM_THRESHOLD_PX;

    isNearBottomRef.current = isNearBottom;

    if (isNearBottom) {
      setShowJumpToLatest(false);
      setUnseenMessageCount(0);
    } else {
      setShowJumpToLatest(true);
    }
  }

  function jumpToLatest() {
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    setUnseenMessageCount(0);

    listRef.current?.scrollToEnd({
      animated: true,
    });
  }

  async function hydrateLinkPreview(
    messageId: string,
    body: string
  ) {
    const url = extractFirstUrl(body);

    if (!url) {
      return;
    }

    try {
      const { data, error } =
        await supabase.functions.invoke(
          "link-preview",
          {
            body: { url },
          }
        );

      if (error) {
        throw error;
      }

      if (!data?.url || !data?.title) {
        return;
      }

      const { data: updatedMessage, error: saveError } =
        await supabase.rpc(
          "set_message_link_preview",
          {
            requested_message_id: messageId,
            requested_link_url: data.url,
            requested_link_title: data.title,
            requested_link_description:
              data.description ?? null,
            requested_link_image_url:
              data.imageUrl ?? null,
            requested_link_site_name:
              data.siteName ?? null,
          }
        );

      if (saveError) {
        throw saveError;
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                ...(updatedMessage as Message),
              }
            : message
        )
      );
    } catch (error) {
      console.warn(
        "Could not create link preview:",
        error instanceof Error
          ? error.message
          : error
      );
    }
  }

  async function submitMessage(
    body: string,
    existingLocalId?: string,
    replyTarget: Message | null = replyingToMessage
  ) {
    if (!conversationId || !user) {
      return;
    }

    const localId =
      existingLocalId ??
      `local-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    const optimisticMessage: Message = {
      id: localId,
      conversation_id: conversationId,
      sender_id: user.id,
      body,
      message_type: "text",
      image_urls: [],
      video_url: null,
      video_duration_seconds: null,
      file_url: null,
      file_name: null,
      file_size_bytes: null,
      file_mime_type: null,
      voice_url: null,
      voice_duration_seconds: null,
      link_url: null,
      link_title: null,
      link_description: null,
      link_image_url: null,
      link_site_name: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      delivered_at: null,
      read_at: null,
      reply_to_message_id: replyTarget?.id ?? null,
      reply_to: replyTarget
        ? {
            id: replyTarget.id,
            sender_id: replyTarget.sender_id,
            body: replyTarget.body,
            deleted_at: replyTarget.deleted_at,
            message_type: replyTarget.message_type,
            image_urls: replyTarget.image_urls,
            video_url: replyTarget.video_url,
            video_duration_seconds:
              replyTarget.video_duration_seconds,
            file_url: replyTarget.file_url,
            file_name: replyTarget.file_name,
            file_size_bytes:
              replyTarget.file_size_bytes,
            file_mime_type:
              replyTarget.file_mime_type,
            voice_url: replyTarget.voice_url,
            voice_duration_seconds:
              replyTarget.voice_duration_seconds,
            link_url: replyTarget.link_url,
            link_title: replyTarget.link_title,
            link_description:
              replyTarget.link_description,
            link_image_url:
              replyTarget.link_image_url,
            link_site_name:
              replyTarget.link_site_name,
          }
        : null,
      client_status: "sending",
    };

    setMessages((current) => {
      const alreadyExists = current.some(
        (message) => message.id === localId
      );

      if (alreadyExists) {
        return current.map((message) =>
          message.id === localId
            ? {
                ...message,
                client_status: "sending",
              }
            : message
        );
      }

      return mergeMessage(
        current,
        optimisticMessage
      );
    });

    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    setUnseenMessageCount(0);

    setTimeout(() => {
      listRef.current?.scrollToEnd({
        animated: true,
      });
    }, 40);

    try {
      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body,
          message_type: "text",
          image_urls: [],
          video_url: null,
          video_duration_seconds: null,
          file_url: null,
          file_name: null,
          file_size_bytes: null,
          file_mime_type: null,
          voice_url: null,
          voice_duration_seconds: null,
          link_url: null,
          link_title: null,
          link_description: null,
          link_image_url: null,
          link_site_name: null,
          reply_to_message_id:
            replyTarget?.id ?? null,
        })
        .select(
          `
            id,
            conversation_id,
            sender_id,
            body,
            message_type,
            image_urls,
            video_url,
            video_duration_seconds,
            file_url,
            file_name,
            file_size_bytes,
            file_mime_type,
            voice_url,
            voice_duration_seconds,
            link_url,
            link_title,
            link_description,
            link_image_url,
            link_site_name,
            created_at,
            edited_at,
            deleted_at,
            delivered_at,
            read_at,
            reply_to_message_id
          `
        )
        .single();

      if (error) {
        throw error;
      }

      const savedMessage = {
        ...(data as Message),
        reply_to_message_id:
          (data as Message).reply_to_message_id ??
          replyTarget?.id ??
          null,
        reply_to: replyTarget
          ? createReplySnapshot(replyTarget)
          : null,
      } as Message;

      setMessages((current) => {
        const withoutLocal = current.filter(
          (message) => message.id !== localId
        );

        return reconcileMessage(
          withoutLocal,
          savedMessage,
          user.id
        );
      });

      setReplyingToMessage(null);
      void hydrateLinkPreview(
        savedMessage.id,
        body
      );
      await markAsRead();
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === localId
            ? {
                ...message,
                client_status: "failed",
              }
            : message
        )
      );

      console.warn(
        "Could not send message:",
        error instanceof Error
          ? error.message
          : error
      );
    }
  }

  async function sendMessage() {
    if (
      !conversationId ||
      !user ||
      sending
    ) {
      return;
    }

    const body = messageText.trim();

    if (!body) {
      return;
    }

    if (body.length > 4000) {
      Alert.alert(
        "Message too long",
        "Messages can contain up to 4,000 characters."
      );
      return;
    }

    try {
      setSending(true);
      stopTyping();
      setMessageText("");
      await submitMessage(body);
    } finally {
      setSending(false);
    }
  }

  async function retryMessage(message: Message) {
    if (
      message.client_status !== "failed" ||
      sending
    ) {
      return;
    }

    try {
      setSending(true);
      await submitMessage(
        message.body,
        message.id,
        (
          message.reply_to_message_id
            ? messages.find(
                (candidate) =>
                  candidate.id ===
                  message.reply_to_message_id
              )
            : null
        ) ??
          (message.reply_to
            ? {
                ...message.reply_to,
                conversation_id:
                  message.conversation_id,
                created_at: message.created_at,
                edited_at: null,
                delivered_at: null,
                read_at: null,
                reply_to_message_id: null,
                message_type:
                  message.reply_to.message_type ?? "text",
                image_urls:
                  message.reply_to.image_urls ?? [],
                video_url:
                  message.reply_to.video_url ?? null,
                video_duration_seconds:
                  message.reply_to
                    .video_duration_seconds ?? null,
                file_url:
                  message.reply_to.file_url ?? null,
                file_name:
                  message.reply_to.file_name ?? null,
                file_size_bytes:
                  message.reply_to
                    .file_size_bytes ?? null,
                file_mime_type:
                  message.reply_to
                    .file_mime_type ?? null,
                voice_url:
                  message.reply_to.voice_url ?? null,
                voice_duration_seconds:
                  message.reply_to
                    .voice_duration_seconds ?? null,
                link_url:
                  message.reply_to.link_url ?? null,
                link_title:
                  message.reply_to.link_title ?? null,
                link_description:
                  message.reply_to
                    .link_description ?? null,
                link_image_url:
                  message.reply_to
                    .link_image_url ?? null,
                link_site_name:
                  message.reply_to
                    .link_site_name ?? null,
              }
            : null)
      );
    } finally {
      setSending(false);
    }
  }


  function closeSwipeable(messageId: string) {
    swipeableRefs.current[messageId]?.close();

    if (openSwipeableIdRef.current === messageId) {
      openSwipeableIdRef.current = null;
    }
  }

  function handleSwipeableWillOpen(messageId: string) {
    const previouslyOpenId =
      openSwipeableIdRef.current;

    if (
      previouslyOpenId &&
      previouslyOpenId !== messageId
    ) {
      swipeableRefs.current[
        previouslyOpenId
      ]?.close();
    }

    openSwipeableIdRef.current = messageId;
    setSelectedMessageId(null);
  }

  function startReplying(message: Message) {
    if (message.deleted_at || message.client_status) {
      return;
    }

    setEditingMessage(null);
    setReplyingToMessage(message);
    setMessageText("");
    closeSwipeable(message.id);
  }

  function cancelReplying() {
    setReplyingToMessage(null);
  }

  async function copyMessage(message: Message) {
    if (message.deleted_at) {
      return;
    }

    try {
      await Clipboard.setStringAsync(message.body);
      closeSwipeable(message.id);
    } catch {
      Alert.alert(
        "Copy error",
        "Could not copy the message."
      );
    }
  }

  function showMoreActions(message: Message) {
    const isMine = message.sender_id === user?.id;

    closeSwipeable(message.id);

    Alert.alert(
      "Message actions",
      undefined,
      [
        {
          text: "Reply",
          onPress: () => startReplying(message),
        },
        {
          text: "Copy",
          onPress: () => copyMessage(message),
        },
        ...(isMine
          ? [
              {
                text: "Edit",
                onPress: () =>
                  startEditing(message),
              },
            ]
          : []),
        {
          text: "Delete",
          style: "destructive" as const,
          onPress: () =>
            confirmDeleteMessage(message),
        },
        {
          text: "Cancel",
          style: "cancel" as const,
        },
      ]
    );
  }

  function openImageViewer(
    images: string[],
    startIndex = 0
  ) {
    setViewerImages(images);
    setViewerIndex(startIndex);
  }

  function closeImageViewer() {
    setViewerImages([]);
    setViewerIndex(0);
  }

  async function shareCurrentImage() {
    const currentImage = viewerImages[viewerIndex];

    if (!currentImage) {
      return;
    }

    try {
      await Share.share({
        message: currentImage,
        url: currentImage,
      });
    } catch {
      Alert.alert(
        "Share error",
        "Could not share this image."
      );
    }
  }

  async function pickAndSendImages() {
    if (
      !conversationId ||
      !user ||
      sending ||
      uploadingImages ||
      editingMessage
    ) {
      return;
    }

    const permission =
      await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert(
        "Photo permission required",
        "Allow Global Qall to access your photos so you can send images."
      );
      return;
    }

    const result =
      await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: MAX_IMAGES_PER_MESSAGE,
        quality: 0.85,
      });

    if (
      result.canceled ||
      result.assets.length === 0
    ) {
      return;
    }

    const selectedAssets = result.assets.slice(
      0,
      MAX_IMAGES_PER_MESSAGE
    );

    try {
      setUploadingImages(true);
      stopTyping();

      const uploadedUrls: string[] = [];

      for (const [index, asset] of selectedAssets.entries()) {
        const extension =
          asset.fileName?.split(".").pop()?.toLowerCase() ??
          asset.mimeType?.split("/").pop() ??
          "jpg";

        const storagePath =
          `${conversationId}/${user.id}/` +
          `${Date.now()}-${index}-${Math.random()
            .toString(36)
            .slice(2, 9)}.${extension}`;

        const response = await fetch(asset.uri);
        const fileData = await response.arrayBuffer();

        const { error: uploadError } =
          await supabase.storage
            .from("chat-images")
            .upload(storagePath, fileData, {
              contentType:
                asset.mimeType ?? "image/jpeg",
              upsert: false,
            });

        if (uploadError) {
          throw uploadError;
        }

        const { data: publicUrlData } =
          supabase.storage
            .from("chat-images")
            .getPublicUrl(storagePath);

        uploadedUrls.push(
          publicUrlData.publicUrl
        );
      }

      const body =
        uploadedUrls.length === 1
          ? "Photo"
          : `${uploadedUrls.length} photos`;

      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body,
          message_type: "image",
          image_urls: uploadedUrls,
          reply_to_message_id:
            replyingToMessage?.id ?? null,
        })
        .select(
          `
            id,
            conversation_id,
            sender_id,
            body,
            message_type,
            image_urls,
            video_url,
            video_duration_seconds,
            file_url,
            file_name,
            file_size_bytes,
            file_mime_type,
            voice_url,
            voice_duration_seconds,
            link_url,
            link_title,
            link_description,
            link_image_url,
            link_site_name,
            created_at,
            edited_at,
            deleted_at,
            delivered_at,
            read_at,
            reply_to_message_id
          `
        )
        .single();

      if (error) {
        throw error;
      }

      setMessages((current) =>
        mergeMessage(current, data as Message)
      );
      setReplyingToMessage(null);
      isNearBottomRef.current = true;
      setShowJumpToLatest(false);
      setUnseenMessageCount(0);

      setTimeout(() => {
        listRef.current?.scrollToEnd({
          animated: true,
        });
      }, 60);
    } catch (error) {
      Alert.alert(
        "Image upload error",
        error instanceof Error
          ? error.message
          : "Could not send the selected images."
      );
    } finally {
      setUploadingImages(false);
    }
  }

  async function pickAndSendVideo() {
    if (
      !conversationId ||
      !user ||
      sending ||
      uploadingImages ||
      uploadingVideo ||
      editingMessage
    ) {
      return;
    }

    const permission =
      await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert(
        "Video permission required",
        "Allow Global Qall to access your videos so you can send them."
      );
      return;
    }

    let result: ImagePicker.ImagePickerResult;

    try {
      result =
        await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["videos"],
          allowsMultipleSelection: false,
          allowsEditing: false,
          quality: 1,
          videoMaxDuration: 300,
          videoExportPreset:
            ImagePicker.VideoExportPreset.Passthrough,
          preferredAssetRepresentationMode:
            ImagePicker
              .UIImagePickerPreferredAssetRepresentationMode
              .Current,
        });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      const isICloudAssetError =
        message.includes("PHPhotosErrorDomain") ||
        message.includes("3164");

      Alert.alert(
        isICloudAssetError
          ? "Download the video first"
          : "Video picker error",
        isICloudAssetError
          ? "This video appears to be stored in iCloud. Open it in the Photos app and wait until it finishes downloading to this iPhone, then select it again."
          : "The selected video could not be opened. Please try another video."
      );

      return;
    }

    if (
      result.canceled ||
      result.assets.length === 0
    ) {
      return;
    }

    const asset = result.assets[0];

    if (
      asset.fileSize &&
      asset.fileSize > MAX_VIDEO_SIZE_BYTES
    ) {
      Alert.alert(
        "Video too large",
        "Please select a video smaller than 100 MB."
      );
      return;
    }

    try {
      setUploadingVideo(true);
      stopTyping();

      const extension =
        asset.fileName
          ?.split(".")
          .pop()
          ?.toLowerCase() ??
        asset.mimeType?.split("/").pop() ??
        "mp4";

      const storagePath =
        `${conversationId}/${user.id}/` +
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 9)}.${extension}`;

      const response = await fetch(asset.uri);
      const fileData = await response.arrayBuffer();

      const { error: uploadError } =
        await supabase.storage
          .from("chat-videos")
          .upload(storagePath, fileData, {
            contentType:
              asset.mimeType ?? "video/mp4",
            upsert: false,
          });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } =
        supabase.storage
          .from("chat-videos")
          .getPublicUrl(storagePath);

      const videoUrl = publicUrlData.publicUrl;
      const durationSeconds =
        asset.duration != null
          ? asset.duration / 1000
          : null;

      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: "Video",
          message_type: "video",
          image_urls: [],
          video_url: videoUrl,
          video_duration_seconds: durationSeconds,
          reply_to_message_id:
            replyingToMessage?.id ?? null,
        })
        .select(
          `
            id,
            conversation_id,
            sender_id,
            body,
            message_type,
            image_urls,
            video_url,
            video_duration_seconds,
            file_url,
            file_name,
            file_size_bytes,
            file_mime_type,
            voice_url,
            voice_duration_seconds,
            link_url,
            link_title,
            link_description,
            link_image_url,
            link_site_name,
            created_at,
            edited_at,
            deleted_at,
            delivered_at,
            read_at,
            reply_to_message_id
          `
        )
        .single();

      if (error) {
        throw error;
      }

      setMessages((current) =>
        mergeMessage(current, data as Message)
      );
      setReplyingToMessage(null);
      isNearBottomRef.current = true;
      setShowJumpToLatest(false);
      setUnseenMessageCount(0);

      setTimeout(() => {
        listRef.current?.scrollToEnd({
          animated: true,
        });
      }, 60);
    } catch (error) {
      Alert.alert(
        "Video upload error",
        error instanceof Error
          ? error.message
          : "Could not send the selected video."
      );
    } finally {
      setUploadingVideo(false);
    }
  }

  async function openFileMessage(
    message: Message
  ) {
    if (!message.file_url) {
      return;
    }

    try {
      const supported = await Linking.canOpenURL(
        message.file_url
      );

      if (!supported) {
        Alert.alert(
          "Open file",
          "This file type cannot be opened on this device."
        );
        return;
      }

      await Linking.openURL(message.file_url);
    } catch {
      Alert.alert(
        "Open file error",
        "Could not open this file."
      );
    }
  }

  async function shareFileMessage(
    message: Message
  ) {
    if (!message.file_url) {
      return;
    }

    try {
      await Share.share({
        title: message.file_name ?? "File",
        message: message.file_url,
        url: message.file_url,
      });
    } catch {
      Alert.alert(
        "Share error",
        "Could not share this file."
      );
    }
  }

  async function pickAndSendFile() {
    if (
      !conversationId ||
      !user ||
      sending ||
      uploadingImages ||
      uploadingVideo ||
      uploadingFile ||
      editingMessage
    ) {
      return;
    }

    let result: DocumentPicker.DocumentPickerResult;

    try {
      result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/pdf",
          "text/plain",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/zip",
          "application/x-zip-compressed",
          "application/octet-stream",
        ],
        multiple: false,
        copyToCacheDirectory: true,
      });
    } catch {
      Alert.alert(
        "File picker error",
        "Could not open the file picker."
      );
      return;
    }

    if (
      result.canceled ||
      result.assets.length === 0
    ) {
      return;
    }

    const asset = result.assets[0];

    if (
      asset.size &&
      asset.size > MAX_FILE_SIZE_BYTES
    ) {
      Alert.alert(
        "File too large",
        "Please select a file smaller than 25 MB."
      );
      return;
    }

    try {
      setUploadingFile(true);
      stopTyping();

      const originalName =
        asset.name || `file-${Date.now()}`;
      const safeName = originalName.replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );

      const storagePath =
        `${conversationId}/${user.id}/` +
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 9)}-${safeName}`;

      const response = await fetch(asset.uri);
      const fileData = await response.arrayBuffer();

      const { error: uploadError } =
        await supabase.storage
          .from("chat-files")
          .upload(storagePath, fileData, {
            contentType:
              asset.mimeType ??
              "application/octet-stream",
            upsert: false,
          });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } =
        supabase.storage
          .from("chat-files")
          .getPublicUrl(storagePath);

      const fileUrl = publicUrlData.publicUrl;

      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: originalName,
          message_type: "file",
          image_urls: [],
          video_url: null,
          video_duration_seconds: null,
          file_url: fileUrl,
          file_name: originalName,
          file_size_bytes: asset.size ?? null,
          file_mime_type:
            asset.mimeType ??
            "application/octet-stream",
          reply_to_message_id:
            replyingToMessage?.id ?? null,
        })
        .select(
          `
            id,
            conversation_id,
            sender_id,
            body,
            message_type,
            image_urls,
            video_url,
            video_duration_seconds,
            file_url,
            file_name,
            file_size_bytes,
            file_mime_type,
            voice_url,
            voice_duration_seconds,
            link_url,
            link_title,
            link_description,
            link_image_url,
            link_site_name,
            created_at,
            edited_at,
            deleted_at,
            delivered_at,
            read_at,
            reply_to_message_id
          `
        )
        .single();

      if (error) {
        throw error;
      }

      setMessages((current) =>
        mergeMessage(current, data as Message)
      );
      setReplyingToMessage(null);
      isNearBottomRef.current = true;
      setShowJumpToLatest(false);
      setUnseenMessageCount(0);

      setTimeout(() => {
        listRef.current?.scrollToEnd({
          animated: true,
        });
      }, 60);
    } catch (error) {
      Alert.alert(
        "File upload error",
        error instanceof Error
          ? error.message
          : "Could not send the selected file."
      );
    } finally {
      setUploadingFile(false);
    }
  }

  async function startVoiceRecording() {
    if (
      sending ||
      uploadingImages ||
      uploadingVideo ||
      uploadingFile ||
      uploadingVoice ||
      editingMessage ||
      recorderState.isRecording
    ) {
      return;
    }

    try {
      const permission =
        await AudioModule
          .requestRecordingPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          "Microphone permission required",
          "Allow Global Qall to use your microphone so you can record voice messages."
        );
        return;
      }

      setRecordedVoiceUri(null);
      setRecordedVoiceDuration(0);
      stopTyping();

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
    } catch (error) {
      Alert.alert(
        "Recording error",
        error instanceof Error
          ? error.message
          : "Could not start recording."
      );
    }
  }

  async function stopVoiceRecording() {
    if (!recorderState.isRecording) {
      return;
    }

    try {
      const durationSeconds =
        recorderState.durationMillis / 1000;

      await audioRecorder.stop();

      const uri = audioRecorder.uri;

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
      });

      if (!uri) {
        throw new Error(
          "The recording file was not created."
        );
      }

      if (durationSeconds < 0.5) {
        setRecordedVoiceUri(null);
        setRecordedVoiceDuration(0);
        Alert.alert(
          "Recording too short",
          "Record for at least half a second."
        );
        return;
      }

      setRecordedVoiceUri(uri);
      setRecordedVoiceDuration(durationSeconds);
    } catch (error) {
      Alert.alert(
        "Recording error",
        error instanceof Error
          ? error.message
          : "Could not stop recording."
      );
    }
  }

  async function cancelVoiceRecording() {
    try {
      if (recorderState.isRecording) {
        await audioRecorder.stop();
      }
    } catch {
      // The recorder may already have stopped.
    } finally {
      setRecordedVoiceUri(null);
      setRecordedVoiceDuration(0);

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
      });
    }
  }

  async function sendRecordedVoice() {
    if (
      !conversationId ||
      !user ||
      !recordedVoiceUri ||
      uploadingVoice
    ) {
      return;
    }

    try {
      setUploadingVoice(true);

      const storagePath =
        `${conversationId}/${user.id}/` +
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 9)}.m4a`;

      const response = await fetch(
        recordedVoiceUri
      );
      const audioData =
        await response.arrayBuffer();

      const { error: uploadError } =
        await supabase.storage
          .from("chat-audio")
          .upload(storagePath, audioData, {
            contentType: "audio/m4a",
            upsert: false,
          });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } =
        supabase.storage
          .from("chat-audio")
          .getPublicUrl(storagePath);

      const voiceUrl =
        publicUrlData.publicUrl;

      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: "Voice message",
          message_type: "voice",
          image_urls: [],
          video_url: null,
          video_duration_seconds: null,
          file_url: null,
          file_name: null,
          file_size_bytes: null,
          file_mime_type: null,
          voice_url: voiceUrl,
          voice_duration_seconds:
            recordedVoiceDuration,
          reply_to_message_id:
            replyingToMessage?.id ?? null,
        })
        .select(
          `
            id,
            conversation_id,
            sender_id,
            body,
            message_type,
            image_urls,
            video_url,
            video_duration_seconds,
            file_url,
            file_name,
            file_size_bytes,
            file_mime_type,
            voice_url,
            voice_duration_seconds,
            link_url,
            link_title,
            link_description,
            link_image_url,
            link_site_name,
            created_at,
            edited_at,
            deleted_at,
            delivered_at,
            read_at,
            reply_to_message_id
          `
        )
        .single();

      if (error) {
        throw error;
      }

      setMessages((current) =>
        mergeMessage(current, data as Message)
      );
      setRecordedVoiceUri(null);
      setRecordedVoiceDuration(0);
      setReplyingToMessage(null);
      isNearBottomRef.current = true;
      setShowJumpToLatest(false);
      setUnseenMessageCount(0);

      setTimeout(() => {
        listRef.current?.scrollToEnd({
          animated: true,
        });
      }, 60);
    } catch (error) {
      Alert.alert(
        "Voice message error",
        error instanceof Error
          ? error.message
          : "Could not send the voice message."
      );
    } finally {
      setUploadingVoice(false);
    }
  }

  function toggleMessageActions(message: Message) {
    if (
      message.deleted_at ||
      message.client_status
    ) {
      setSelectedMessageId(null);
      return;
    }

    setSelectedMessageId((current) =>
      current === message.id ? null : message.id
    );
  }

  function startEditing(message: Message) {
    setReplyingToMessage(null);
    setEditingMessage(message);
    setMessageText(message.body);
    setSelectedMessageId(null);
  }

  function cancelEditing() {
    setEditingMessage(null);
    setMessageText("");
  }

  async function saveEditedMessage() {
    if (!editingMessage || sending) {
      return;
    }

    const body = messageText.trim();

    if (!body) {
      Alert.alert(
        "Empty message",
        "The edited message cannot be empty."
      );
      return;
    }

    try {
      setSending(true);

      const { data, error } = await supabase.rpc(
        "edit_message",
        {
          requested_message_id: editingMessage.id,
          new_body: body,
        }
      );

      if (error) {
        throw error;
      }

      const updatedMessage = data as Message;

      setMessages((current) =>
        current.map((message) =>
          message.id === updatedMessage.id
            ? updatedMessage
            : message
        )
      );

      setEditingMessage(null);
      setMessageText("");
    } catch (error) {
      Alert.alert(
        "Edit error",
        error instanceof Error
          ? error.message
          : "Could not edit the message."
      );
    } finally {
      setSending(false);
    }
  }

  function confirmDeleteMessage(message: Message) {
    const isMine = message.sender_id === user?.id;

    Alert.alert(
      "Delete message",
      isMine
        ? "Choose who should no longer see this message."
        : "This message will be removed from your chat only.",
      [
        {
          text: "Delete for me",
          onPress: () => deleteMessageForMe(message),
        },
        ...(isMine
          ? [
              {
                text: "Delete for everyone",
                style: "destructive" as const,
                onPress: () =>
                  deleteMessageForEveryone(message),
              },
            ]
          : []),
        {
          text: "Cancel",
          style: "cancel" as const,
        },
      ]
    );
  }

  async function deleteMessageForMe(message: Message) {
    try {
      const { error } = await supabase.rpc(
        "delete_message_for_me",
        {
          requested_message_id: message.id,
        }
      );

      if (error) {
        throw error;
      }

      setMessages((current) =>
        current.filter(
          (existingMessage) =>
            existingMessage.id !== message.id
        )
      );

      setSelectedMessageId(null);

      if (editingMessage?.id === message.id) {
        cancelEditing();
      }
    } catch (error) {
      Alert.alert(
        "Delete error",
        error instanceof Error
          ? error.message
          : "Could not delete the message for you."
      );
    }
  }

  async function deleteMessageForEveryone(
    message: Message
  ) {
    try {
      const { data, error } = await supabase.rpc(
        "delete_message",
        {
          requested_message_id: message.id,
        }
      );

      if (error) {
        throw error;
      }

      const deletedMessage = data as Message;

      setMessages((current) =>
        current.map((existingMessage) =>
          existingMessage.id === deletedMessage.id
            ? deletedMessage
            : existingMessage
        )
      );

      setSelectedMessageId(null);

      if (editingMessage?.id === message.id) {
        cancelEditing();
      }
    } catch (error) {
      Alert.alert(
        "Delete error",
        error instanceof Error
          ? error.message
          : "Could not delete the message for everyone."
      );
    }
  }

  async function toggleReaction(
    message: Message,
    emoji: string
  ) {
    if (
      !user ||
      message.deleted_at ||
      message.client_status ||
      reactionSavingForMessageId === message.id
    ) {
      return;
    }

    const currentReactions =
      reactionsByMessage[message.id] ?? [];

    const ownReaction = currentReactions.find(
      (reaction) => reaction.user_id === user.id
    );

    try {
      setReactionSavingForMessageId(message.id);

      if (ownReaction?.emoji === emoji) {
        const { error } = await supabase
          .from("message_reactions")
          .delete()
          .eq("id", ownReaction.id)
          .eq("user_id", user.id);

        if (error) {
          throw error;
        }

        setReactionsByMessage((current) => ({
          ...current,
          [message.id]: (
            current[message.id] ?? []
          ).filter(
            (reaction) =>
              reaction.id !== ownReaction.id
          ),
        }));
      } else {
        const { data, error } = await supabase
          .from("message_reactions")
          .upsert(
            {
              message_id: message.id,
              user_id: user.id,
              emoji,
            },
            {
              onConflict: "message_id,user_id",
            }
          )
          .select(
            "id, message_id, user_id, emoji, created_at"
          )
          .single();

        if (error) {
          throw error;
        }

        const savedReaction =
          data as MessageReaction;

        setReactionsByMessage((current) => {
          const withoutOwn = (
            current[message.id] ?? []
          ).filter(
            (reaction) =>
              reaction.user_id !== user.id
          );

          return {
            ...current,
            [message.id]: [
              ...withoutOwn,
              savedReaction,
            ],
          };
        });
      }

      setSelectedMessageId(null);
    } catch (error) {
      Alert.alert(
        "Reaction error",
        error instanceof Error
          ? error.message
          : "Could not update the reaction."
      );
    } finally {
      setReactionSavingForMessageId(null);
    }
  }

  async function startPartnerCall(
    callType: "voice" | "video"
  ) {
    if (!partner || conversationType !== "direct") {
      return;
    }

    try {
      const callId =
        callType === "video"
          ? await createVideoCall(partner.user_id)
          : await createVoiceCall(partner.user_id);

      if (!callId) {
        throw new Error("Call could not be created.");
      }

      router.push({
        pathname: "/call/[callId]",
        params: { callId },
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


  async function startConversationGroupCall(
    callType: GroupCallType
  ) {
    if (
      conversationType !== "group" ||
      !conversationId ||
      startingGroupCallType
    ) {
      return;
    }

    try {
      setStartingGroupCallType(callType);

      const groupCallId = await startGroupCall(
        conversationId,
        callType
      );

      if (!groupCallId) {
        throw new Error("Group call could not be created.");
      }

      router.push(
        `/group-call/${groupCallId}` as any
      );
    } catch (error) {
      Alert.alert(
        "Group call",
        error instanceof Error
          ? error.message
          : "Could not start the group call."
      );
    } finally {
      setStartingGroupCallType(null);
    }
  }


  function jumpToReplyTarget(
    replyToMessageId: string | null
  ) {
    if (!replyToMessageId) {
      return;
    }

    const targetIndex = messages.findIndex(
      (message) => message.id === replyToMessageId
    );

    if (targetIndex < 0) {
      Alert.alert(
        "Original message",
        "The original message is outside the currently loaded chat history."
      );
      return;
    }

    listRef.current?.scrollToIndex({
      index: targetIndex,
      animated: true,
      viewPosition: 0.45,
    });
  }


  function renderMessage({
    item,
    index,
  }: {
    item: Message;
    index: number;
  }) {
    const previousMessage = messages[index - 1];
    const nextMessage = messages[index + 1];

    const groupedWithPrevious =
      messagesBelongToSameGroup(
        previousMessage,
        item
      );

    const groupedWithNext =
      messagesBelongToSameGroup(
        item,
        nextMessage
      );

    const showDateSeparator =
      !previousMessage ||
      !isSameCalendarDay(
        previousMessage.created_at,
        item.created_at
      );

    const isMine = item.sender_id === user?.id;
    const isSystemMessage =
      item.message_type === "system";

    if (isSystemMessage) {
      return (
        <View style={styles.systemMessageRow}>
          <View style={styles.systemMessagePill}>
            <Ionicons
              name="information-circle-outline"
              size={14}
              color="#60706B"
            />
            <Text style={styles.systemMessageText}>
              {item.body}
            </Text>
          </View>
          <Text style={styles.systemMessageTime}>
            {formatMessageTime(item.created_at)}
          </Text>
        </View>
      );
    }
    const actionsVisible =
      selectedMessageId === item.id &&
      !item.deleted_at;

    const status = item.client_status === "sending"
      ? {
          icon: "time-outline" as const,
          color: "#D4ECE7",
        }
      : item.client_status === "failed"
        ? {
            icon: "alert-circle" as const,
            color: "#FFD2CC",
          }
        : item.read_at
          ? {
              icon: "checkmark-done" as const,
              color: "#78D5FF",
            }
          : item.delivered_at
            ? {
                icon: "checkmark-done" as const,
                color: "#D4ECE7",
              }
            : {
                icon: "checkmark" as const,
                color: "#D4ECE7",
              };

    const statusLabel =
      conversationType === "group" && isMine
        ? item.client_status === "sending"
          ? "Sending"
          : item.client_status === "failed"
            ? "Failed"
            : "Sent"
        : getMessageStatusLabel(item);
    const messageReactions =
      reactionsByMessage[item.id] ?? [];
    const groupedReactions =
      groupReactions(messageReactions);
    const isImageMessage =
      item.message_type === "image" &&
      item.image_urls.length > 0;
    const isVideoMessage =
      item.message_type === "video" &&
      Boolean(item.video_url);
    const isFileMessage =
      item.message_type === "file" &&
      Boolean(item.file_url);
    const isVoiceMessage =
      item.message_type === "voice" &&
      Boolean(item.voice_url);
    const hasLinkPreview = Boolean(
      item.link_url && item.link_title
    );
    const replyPreview =
      (item.reply_to_message_id
        ? messages.find(
            (message) =>
              message.id ===
              item.reply_to_message_id
          )
        : null) ??
      item.reply_to ??
      null;

    const renderLeftActions = () => (
      <Pressable
        onPress={() => startReplying(item)}
        style={styles.swipeReplyAction}
      >
        <Ionicons
          name="arrow-undo"
          size={22}
          color="#FFFFFF"
        />
        <Text style={styles.swipeActionText}>
          Reply
        </Text>
      </Pressable>
    );

    const renderRightActions = () => (
      <View style={styles.swipeRightActions}>
        <Pressable
          onPress={() => copyMessage(item)}
          style={[
            styles.swipeActionButton,
            styles.copySwipeAction,
          ]}
        >
          <Ionicons
            name="copy-outline"
            size={21}
            color="#FFFFFF"
          />
          <Text style={styles.swipeActionText}>
            Copy
          </Text>
        </Pressable>

        <Pressable
          onPress={() =>
            confirmDeleteMessage(item)
          }
          style={[
            styles.swipeActionButton,
            styles.deleteSwipeAction,
          ]}
        >
          <Ionicons
            name="trash-outline"
            size={21}
            color="#FFFFFF"
          />
          <Text style={styles.swipeActionText}>
            Delete
          </Text>
        </Pressable>

        <Pressable
          onPress={() => showMoreActions(item)}
          style={[
            styles.swipeActionButton,
            styles.moreSwipeAction,
          ]}
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={22}
            color="#FFFFFF"
          />
          <Text style={styles.swipeActionText}>
            More
          </Text>
        </Pressable>
      </View>
    );

    return (
      <>
        {showDateSeparator && (
          <View style={styles.dateSeparatorRow}>
            <View style={styles.dateSeparatorLine} />

            <View style={styles.dateSeparatorPill}>
              <Text style={styles.dateSeparatorText}>
                {formatDateSeparator(item.created_at)}
              </Text>
            </View>

            <View style={styles.dateSeparatorLine} />
          </View>
        )}

        <Swipeable
          ref={(reference) => {
            swipeableRefs.current[item.id] =
              reference;
          }}
          renderLeftActions={
            item.deleted_at ||
            item.client_status
              ? undefined
              : renderLeftActions
          }
          renderRightActions={
            item.deleted_at ||
            item.client_status
              ? undefined
              : renderRightActions
          }
          leftThreshold={42}
          rightThreshold={54}
          overshootLeft={false}
          overshootRight={false}
          friction={2}
          onSwipeableWillOpen={() =>
            handleSwipeableWillOpen(item.id)
          }
          onSwipeableClose={() => {
            if (
              openSwipeableIdRef.current ===
              item.id
            ) {
              openSwipeableIdRef.current = null;
            }
          }}
        >
          <View
            style={[
              styles.messageRow,
              isMine
                ? styles.myMessageRow
                : styles.theirMessageRow,
              groupedWithNext
                ? styles.groupedMessageRow
                : styles.lastMessageRow,
            ]}
          >
          {conversationType === "group" &&
            !isMine &&
            !groupedWithPrevious && (
              <View style={styles.groupSenderIdentity}>
                <UserAvatar
                  avatarUrl={
                    groupMembers[item.sender_id]?.avatar_url ??
                    null
                  }
                  name={
                    groupMembers[item.sender_id]?.display_name ??
                    groupMembers[item.sender_id]?.qall_id ??
                    "Member"
                  }
                  size={25}
                />
                <Text style={styles.groupSenderName}>
                  {groupMembers[item.sender_id]?.display_name ??
                    groupMembers[item.sender_id]?.qall_id ??
                    "Group member"}
                </Text>
              </View>
            )}

          <Pressable
            onPress={() => toggleMessageActions(item)}
            onLongPress={() =>
              toggleMessageActions(item)
            }
            delayLongPress={350}
            disabled={isVideoMessage}
            style={({ pressed }) => [
              styles.messageBubble,
              isMine
                ? styles.myMessageBubble
                : styles.theirMessageBubble,
              isMine &&
                groupedWithPrevious &&
                styles.myBubbleGroupedTop,
              isMine &&
                groupedWithNext &&
                styles.myBubbleGroupedBottom,
              !isMine &&
                groupedWithPrevious &&
                styles.theirBubbleGroupedTop,
              !isMine &&
                groupedWithNext &&
                styles.theirBubbleGroupedBottom,
              item.client_status === "failed" &&
                styles.failedMessageBubble,
              pressed &&
                !isVideoMessage &&
                styles.messagePressed,
            ]}
          >
            {replyPreview && (
              <Pressable
                onPress={() =>
                  jumpToReplyTarget(
                    item.reply_to_message_id
                  )
                }
                style={[
                  styles.replyQuote,
                  isMine
                    ? styles.myReplyQuote
                    : styles.theirReplyQuote,
                ]}
              >
                <View
                  style={[
                    styles.replyQuoteBar,
                    isMine &&
                      styles.myReplyQuoteBar,
                  ]}
                />
                <View style={styles.replyQuoteContent}>
                  <Text
                    style={[
                      styles.replyQuoteAuthor,
                      isMine &&
                        styles.myReplyQuoteAuthor,
                    ]}
                  >
                    {replyPreview.sender_id ===
                    user?.id
                      ? "You"
                      : conversationType === "group"
                        ? groupMembers[
                            replyPreview.sender_id
                          ]?.display_name ??
                          groupMembers[
                            replyPreview.sender_id
                          ]?.qall_id ??
                          "Group member"
                        : partner?.contact_name ??
                          "Contact"}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.replyQuoteText,
                      isMine &&
                        styles.myReplyQuoteText,
                    ]}
                  >
                    {replyPreview.deleted_at
                      ? "This message was deleted"
                      : replyPreview.message_type ===
                          "voice"
                        ? `🎤 Voice message${
                            replyPreview
                              .voice_duration_seconds
                              ? ` · ${formatVideoDuration(
                                  replyPreview
                                    .voice_duration_seconds
                                )}`
                              : ""
                          }`
                        : replyPreview.message_type ===
                            "file"
                          ? `📎 ${
                            replyPreview.file_name ??
                            "File"
                          }`
                        : replyPreview.message_type ===
                            "video"
                          ? `🎥 Video${
                            replyPreview
                              .video_duration_seconds
                              ? ` · ${formatVideoDuration(
                                  replyPreview
                                    .video_duration_seconds
                                )}`
                              : ""
                          }`
                        : replyPreview.message_type ===
                            "image"
                          ? `📷 ${
                            (replyPreview.image_urls
                              ?.length ?? 1) > 1
                              ? `${
                                  replyPreview.image_urls
                                    ?.length
                                } photos`
                              : "Photo"
                          }`
                        : replyPreview.body}
                  </Text>
                </View>
              </Pressable>
            )}

            {isImageMessage && !item.deleted_at && (
              <View
                style={[
                  styles.imageGrid,
                  item.image_urls.length === 1 &&
                    styles.singleImageGrid,
                ]}
              >
                {item.image_urls.map(
                  (imageUrl, imageIndex) => (
                    <Pressable
                      key={`${item.id}-${imageIndex}`}
                      onPress={() =>
                        openImageViewer(
                          item.image_urls,
                          imageIndex
                        )
                      }
                      style={[
                        styles.imageTile,
                        item.image_urls.length === 1 &&
                          styles.singleImageTile,
                      ]}
                    >
                      <Image
                        source={{ uri: imageUrl }}
                        style={styles.messageImage}
                        resizeMode="cover"
                      />
                    </Pressable>
                  )
                )}
              </View>
            )}

            {isVideoMessage &&
              !item.deleted_at &&
              item.video_url && (
                <View style={styles.videoMessageCard}>
                  <VideoMessagePlayer
                    uri={item.video_url}
                  />

                  <Pressable
                    onPress={() =>
                      toggleMessageActions(item)
                    }
                    onLongPress={() =>
                      toggleMessageActions(item)
                    }
                    delayLongPress={350}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.videoMenuButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Ionicons
                      name="ellipsis-horizontal"
                      size={20}
                      color="#FFFFFF"
                    />
                  </Pressable>

                  <View
                    pointerEvents="none"
                    style={styles.videoMessageMeta}
                  >
                    <Ionicons
                      name="videocam"
                      size={14}
                      color={
                        isMine
                          ? "#E2F3EF"
                          : "#52615D"
                      }
                    />

                    <Text
                      style={[
                        styles.videoDurationText,
                        isMine &&
                          styles.myVideoDurationText,
                      ]}
                    >
                      {formatVideoDuration(
                        item.video_duration_seconds
                      )}
                    </Text>
                  </View>
                </View>
              )}

            {isFileMessage &&
              !item.deleted_at && (
                <View style={styles.fileMessageCard}>
                  <View style={styles.fileIconContainer}>
                    <Ionicons
                      name={getFileIconName(
                        item.file_name
                      )}
                      size={28}
                      color={
                        isMine
                          ? "#DDF4EE"
                          : "#176B5B"
                      }
                    />
                  </View>

                  <View style={styles.fileMessageDetails}>
                    <Text
                      numberOfLines={2}
                      style={[
                        styles.fileMessageName,
                        isMine &&
                          styles.myFileMessageName,
                      ]}
                    >
                      {item.file_name ?? "File"}
                    </Text>

                    <Text
                      style={[
                        styles.fileMessageMeta,
                        isMine &&
                          styles.myFileMessageMeta,
                      ]}
                    >
                      {getFileExtension(
                        item.file_name
                      )}{" "}
                      ·{" "}
                      {formatFileSize(
                        item.file_size_bytes
                      )}
                    </Text>
                  </View>

                  <View style={styles.fileActionColumn}>
                    <Pressable
                      onPress={() =>
                        openFileMessage(item)
                      }
                      style={styles.fileActionButton}
                    >
                      <Ionicons
                        name="open-outline"
                        size={20}
                        color={
                          isMine
                            ? "#FFFFFF"
                            : "#176B5B"
                        }
                      />
                    </Pressable>

                    <Pressable
                      onPress={() =>
                        shareFileMessage(item)
                      }
                      style={styles.fileActionButton}
                    >
                      <Ionicons
                        name="share-outline"
                        size={20}
                        color={
                          isMine
                            ? "#FFFFFF"
                            : "#176B5B"
                        }
                      />
                    </Pressable>
                  </View>
                </View>
              )}

            {isVoiceMessage &&
              !item.deleted_at &&
              item.voice_url && (
                <VoiceMessagePlayer
                  uri={item.voice_url}
                  durationSeconds={
                    item.voice_duration_seconds
                  }
                  isMine={isMine}
                />
              )}

            {item.deleted_at ? (
              <View style={styles.deletedMessageRow}>
                <Ionicons
                  name="ban-outline"
                  size={15}
                  color={
                    isMine ? "#D4ECE7" : "#71807B"
                  }
                />

                <Text
                  style={[
                    styles.deletedMessageText,
                    isMine &&
                      styles.myDeletedMessageText,
                  ]}
                >
                  This message was deleted
                </Text>
              </View>
            ) : (
              <Text
                style={[
                  styles.messageBody,
                  isMine && styles.myMessageBody,
                ]}
              >
                {item.body}
              </Text>
            )}

            {hasLinkPreview &&
              item.link_url &&
              item.link_title &&
              !item.deleted_at && (
                <Pressable
                  onPress={() =>
                    Linking.openURL(
                      item.link_url as string
                    )
                  }
                  style={({ pressed }) => [
                    styles.linkPreviewCard,
                    isMine &&
                      styles.myLinkPreviewCard,
                    pressed && styles.pressed,
                  ]}
                >
                  {item.link_image_url && (
                    <Image
                      source={{
                        uri: item.link_image_url,
                      }}
                      style={styles.linkPreviewImage}
                      resizeMode="cover"
                    />
                  )}

                  <View
                    style={styles.linkPreviewContent}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.linkPreviewSite,
                        isMine &&
                          styles.myLinkPreviewSite,
                      ]}
                    >
                      {item.link_site_name ||
                        formatLinkHost(
                          item.link_url
                        )}
                    </Text>

                    <Text
                      numberOfLines={2}
                      style={[
                        styles.linkPreviewTitle,
                        isMine &&
                          styles.myLinkPreviewTitle,
                      ]}
                    >
                      {item.link_title}
                    </Text>

                    {item.link_description && (
                      <Text
                        numberOfLines={2}
                        style={[
                          styles.linkPreviewDescription,
                          isMine &&
                            styles.myLinkPreviewDescription,
                        ]}
                      >
                        {item.link_description}
                      </Text>
                    )}
                  </View>
                </Pressable>
              )}

            {!groupedWithNext && (
              <View style={styles.messageFooter}>
                {item.edited_at &&
                  !item.deleted_at && (
                    <Text
                      style={[
                        styles.editedText,
                        isMine &&
                          styles.myEditedText,
                      ]}
                    >
                      edited
                    </Text>
                  )}

                <Text
                  style={[
                    styles.messageTime,
                    isMine &&
                      styles.myMessageTime,
                  ]}
                >
                  {formatMessageTime(
                    item.created_at
                  )}
                </Text>

                {isMine && (
                  <View style={styles.receiptContainer}>
                    {item.client_status ? (
                      <Ionicons
                        name={status.icon}
                        size={15}
                        color={status.color}
                      />
                    ) : (
                      <Text
                        style={[
                          styles.receiptSymbol,
                          item.read_at &&
                            styles.readReceiptSymbol,
                        ]}
                      >
                        {getReceiptSymbol(item)}
                      </Text>
                    )}

                    {item.client_status === "failed" && (
                      <Pressable
                        onPress={() =>
                          retryMessage(item)
                        }
                        hitSlop={8}
                      >
                        <Text style={styles.retryText}>
                          Retry
                        </Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            )}
          </Pressable>

          {groupedReactions.length > 0 && (
            <View
              style={[
                styles.reactionSummaryRow,
                isMine
                  ? styles.myReactionSummaryRow
                  : styles.theirReactionSummaryRow,
              ]}
            >
              {groupedReactions.map((reaction) => {
                const reactedByMe =
                  user?.id
                    ? reaction.userIds.includes(user.id)
                    : false;

                return (
                  <Pressable
                    key={reaction.emoji}
                    onPress={() =>
                      toggleReaction(
                        item,
                        reaction.emoji
                      )
                    }
                    disabled={
                      reactionSavingForMessageId ===
                      item.id
                    }
                    style={({ pressed }) => [
                      styles.reactionChip,
                      reactedByMe &&
                        styles.myReactionChip,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.reactionEmoji}>
                      {reaction.emoji}
                    </Text>

                    {reaction.count > 1 && (
                      <Text
                        style={[
                          styles.reactionCount,
                          reactedByMe &&
                            styles.myReactionCount,
                        ]}
                      >
                        {reaction.count}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}

          {isMine &&
            selectedMessageId === item.id &&
            !item.client_status &&
            !item.deleted_at && (
              <View style={styles.receiptDetail}>
                <Text
                  style={[
                    styles.receiptDetailSymbol,
                    item.read_at &&
                      styles.readReceiptDetailSymbol,
                  ]}
                >
                  {getReceiptSymbol(item)}
                </Text>
                <Text style={styles.receiptDetailText}>
                  {statusLabel}
                </Text>
              </View>
            )}

          {actionsVisible && (
            <View
              style={[
                styles.reactionPicker,
                isMine
                  ? styles.myReactionPicker
                  : styles.theirReactionPicker,
              ]}
            >
              {REACTION_OPTIONS.map((emoji) => {
                const selectedByMe = (
                  reactionsByMessage[item.id] ?? []
                ).some(
                  (reaction) =>
                    reaction.user_id === user?.id &&
                    reaction.emoji === emoji
                );

                return (
                  <Pressable
                    key={emoji}
                    onPress={() =>
                      toggleReaction(item, emoji)
                    }
                    disabled={
                      reactionSavingForMessageId ===
                      item.id
                    }
                    style={({ pressed }) => [
                      styles.reactionPickerButton,
                      selectedByMe &&
                        styles.selectedReactionButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={
                        styles.reactionPickerEmoji
                      }
                    >
                      {emoji}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {actionsVisible && (
            <View
              style={[
                styles.inlineActions,
                !isMine &&
                  styles.theirInlineActions,
              ]}
            >
              {isMine && (
                <Pressable
                  onPress={() =>
                    startEditing(item)
                  }
                  style={({ pressed }) => [
                    styles.inlineActionButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Ionicons
                    name="create-outline"
                    size={17}
                    color="#176B5B"
                  />
                  <Text
                    style={styles.inlineEditText}
                  >
                    Edit
                  </Text>
                </Pressable>
              )}

              <Pressable
                onPress={() =>
                  confirmDeleteMessage(item)
                }
                style={({ pressed }) => [
                  styles.inlineActionButton,
                  pressed && styles.pressed,
                ]}
              >
                <Ionicons
                  name="trash-outline"
                  size={17}
                  color="#B42318"
                />
                <Text
                  style={styles.inlineDeleteText}
                >
                  Delete
                </Text>
              </Pressable>
            </View>
          )}
          </View>
        </Swipeable>
      </>
    );
  }

  const renderMessageRef = useRef(renderMessage);
  renderMessageRef.current = renderMessage;

  const stableRenderMessage = useCallback(
    (info: {
      item: Message;
      index: number;
    }) => renderMessageRef.current(info),
    []
  );

  const messageKeyExtractor = useCallback(
    (item: Message) => item.id,
    []
  );

  const listExtraData = useMemo(
    () => ({
      selectedMessageId,
      reactionsByMessage,
      reactionSavingForMessageId,
      partnerName: partner?.contact_name ?? null,
      currentUserId: user?.id ?? null,
    }),
    [
      selectedMessageId,
      reactionsByMessage,
      reactionSavingForMessageId,
      partner?.contact_name,
      user?.id,
    ]
  );

  if (!conversationId) {
    return (
      <SafeAreaView style={styles.centerScreen}>
        <Text>Conversation ID is missing.</Text>
      </SafeAreaView>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title:
            conversationType === "group"
              ? groupConversation?.name ?? "Group"
              : partner?.contact_name ?? "Chat",
          headerBackTitle: "Chats",
        }}
      />

      <GestureHandlerRootView style={styles.gestureRoot}>
        <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.keyboardView}
          behavior={
            Platform.OS === "ios"
              ? "padding"
              : undefined
          }
          keyboardVerticalOffset={
            Platform.OS === "ios" ? 88 : 0
          }
        >
          {loading ? (
            <View style={styles.centerScreen}>
              <ActivityIndicator
                size="large"
                color="#176B5B"
              />
            </View>
          ) : (
            <>
              {conversationType === "group" &&
                groupConversation && (
                  <View style={styles.partnerBar}>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname:
                            "/group/[conversationId]",
                          params: { conversationId },
                        })
                      }
                      style={styles.groupHeaderIdentity}
                    >
                      <UserAvatar
                        avatarUrl={groupConversation.avatar_url}
                        name={groupConversation.name}
                        size={45}
                      />

                      <View style={styles.partnerDetails}>
                        <Text style={styles.partnerName}>
                          {groupConversation.name}
                        </Text>
                        <Text
                          style={[
                            styles.partnerPresence,
                            groupTypingUserIds.length > 0 &&
                              styles.activePresence,
                          ]}
                        >
                          {groupTypingUserIds.length > 0
                            ? `${
                                groupMembers[
                                  groupTypingUserIds[0]
                                ]?.display_name ??
                                groupMembers[
                                  groupTypingUserIds[0]
                                ]?.qall_id ??
                                "Someone"
                              }${
                                groupTypingUserIds.length > 1
                                  ? ` +${
                                      groupTypingUserIds.length - 1
                                    }`
                                  : ""
                              } typing...`
                            : (() => {
                                const memberList =
                                  Object.values(groupMembers);
                                const count = memberList.length;
                                const firstNames = memberList
                                  .filter(
                                    (member) =>
                                      member.user_id !== user?.id
                                  )
                                  .slice(0, 2)
                                  .map(
                                    (member) =>
                                      member.display_name ??
                                      member.qall_id ??
                                      "Member"
                                  );

                                return firstNames.length > 0
                                  ? `${count} members • ${firstNames.join(
                                      ", "
                                    )}${
                                      count - 1 >
                                      firstNames.length
                                        ? "…"
                                        : ""
                                    }`
                                  : `${count} members`;
                              })()}
                        </Text>
                      </View>
                    </Pressable>

                    <View style={styles.partnerCallActions}>
                      <Pressable
                        onPress={() =>
                          void startConversationGroupCall("voice")
                        }
                        disabled={startingGroupCallType !== null}
                        style={[
                          styles.partnerCallButton,
                          startingGroupCallType !== null &&
                            styles.groupCallButtonDisabled,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Start group voice call"
                      >
                        {startingGroupCallType === "voice" ? (
                          <ActivityIndicator
                            size="small"
                            color="#176B5B"
                          />
                        ) : (
                          <Ionicons
                            name="call-outline"
                            size={21}
                            color="#176B5B"
                          />
                        )}
                      </Pressable>

                      <Pressable
                        onPress={() =>
                          void startConversationGroupCall("video")
                        }
                        disabled={startingGroupCallType !== null}
                        style={[
                          styles.partnerCallButton,
                          startingGroupCallType !== null &&
                            styles.groupCallButtonDisabled,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Start group video call"
                      >
                        {startingGroupCallType === "video" ? (
                          <ActivityIndicator
                            size="small"
                            color="#176B5B"
                          />
                        ) : (
                          <Ionicons
                            name="videocam-outline"
                            size={22}
                            color="#176B5B"
                          />
                        )}
                      </Pressable>

                      <Pressable
                        onPress={() =>
                          router.push({
                            pathname:
                              "/group/[conversationId]",
                            params: { conversationId },
                          })
                        }
                        style={styles.partnerCallButton}
                        accessibilityRole="button"
                        accessibilityLabel="Group information"
                      >
                        <Ionicons
                          name="information-circle-outline"
                          size={23}
                          color="#176B5B"
                        />
                      </Pressable>
                    </View>
                  </View>
                )}

              {conversationType === "direct" && partner && (
                <View style={styles.partnerBar}>
                  <View style={styles.avatarContainer}>
                    {partner.avatar_url ? (
                      <Image
                        source={{
                          uri: partner.avatar_url,
                        }}
                        style={styles.partnerAvatarImage}
                      />
                    ) : (
                      <View style={styles.partnerAvatar}>
                        <Text style={styles.partnerInitial}>
                          {partner.contact_name
                            .charAt(0)
                            .toUpperCase()}
                        </Text>
                      </View>
                    )}

                    {partnerOnline && (
                      <View style={styles.onlineDot} />
                    )}
                  </View>

                  <View style={styles.partnerDetails}>
                    <Text style={styles.partnerName}>
                      {partner.contact_name}
                    </Text>

                    <Text
                      style={[
                        styles.partnerPresence,
                        (partnerTyping ||
                          partnerOnline) &&
                          styles.activePresence,
                      ]}
                    >
                      {partnerTyping
                        ? "typing..."
                        : partnerOnline
                          ? "online"
                          : partnerLastSeenAt
                            ? formatPresenceTime(
                                partnerLastSeenAt
                              )
                            : partner.qall_id}
                    </Text>
                  </View>

                  <View style={styles.partnerCallActions}>
                    <Pressable
                      onPress={() =>
                        void startPartnerCall("voice")
                      }
                      style={styles.partnerCallButton}
                    >
                      <Ionicons
                        name="call-outline"
                        size={21}
                        color="#176B5B"
                      />
                    </Pressable>

                    <Pressable
                      onPress={() =>
                        void startPartnerCall("video")
                      }
                      style={styles.partnerCallButton}
                    >
                      <Ionicons
                        name="videocam-outline"
                        size={22}
                        color="#176B5B"
                      />
                    </Pressable>
                  </View>
                </View>
              )}

              <View style={styles.messageListContainer}>
                <FlatList
                  ref={listRef}
                  data={messages}
                  extraData={listExtraData}
                  style={[
                    styles.messageListView,
                    !initialListReady &&
                      styles.messageListHidden,
                  ]}
                  keyExtractor={messageKeyExtractor}
                  renderItem={stableRenderMessage}
                  initialNumToRender={12}
                  maxToRenderPerBatch={8}
                  updateCellsBatchingPeriod={50}
                  windowSize={7}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={[
                    styles.messageList,
                    messages.length === 0 &&
                      styles.emptyMessageList,
                  ]}
                  onLayout={completeInitialScroll}
                  onContentSizeChange={
                    completeInitialScroll
                  }
                  onScroll={handleMessageListScroll}
                  scrollEventThrottle={32}
                  ListEmptyComponent={
                    <View style={styles.emptyChat}>
                    <View style={styles.emptyChatIcon}>
                      <Ionicons
                        name="chatbubble-ellipses-outline"
                        size={38}
                        color="#176B5B"
                      />
                    </View>

                    <Text style={styles.emptyChatTitle}>
                      Start the conversation
                    </Text>

                    <Text style={styles.emptyChatText}>
                      Send a message to{" "}
                      {partner?.contact_name ??
                        "your contact"}.
                    </Text>
                    </View>
                  }
                />

                {showJumpToLatest &&
                  messages.length > 0 && (
                    <Pressable
                      onPress={jumpToLatest}
                      style={({ pressed }) => [
                        styles.jumpToLatestButton,
                        pressed && styles.jumpToLatestPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={
                        unseenMessageCount > 0
                          ? `Jump to ${unseenMessageCount} new messages`
                          : "Jump to latest message"
                      }
                    >
                      <Ionicons
                        name="arrow-down"
                        size={20}
                        color="#176B5B"
                      />

                      {unseenMessageCount > 0 && (
                        <View
                          style={
                            styles.unseenMessageBadge
                          }
                        >
                          <Text
                            style={
                              styles.unseenMessageBadgeText
                            }
                          >
                            {unseenMessageCount > 99
                              ? "99+"
                              : unseenMessageCount}
                          </Text>
                        </View>
                      )}
                    </Pressable>
                  )}
              </View>

              {partnerTyping && !editingMessage && (
                <View style={styles.typingIndicatorRow}>
                  <View style={styles.typingBubble}>
                    <View style={styles.typingDot} />
                    <View style={styles.typingDot} />
                    <View style={styles.typingDot} />
                  </View>

                  <Text style={styles.typingLabel}>
                    {partner?.contact_name ?? "Contact"} is
                    typing
                  </Text>
                </View>
              )}

              {replyingToMessage && !editingMessage && (
                <View style={styles.replyBanner}>
                  <View style={styles.replyBannerIndicator} />

                  <View style={styles.editContent}>
                    <Text style={styles.replyBannerTitle}>
                      Replying to{" "}
                      {replyingToMessage.sender_id ===
                      user?.id
                        ? "yourself"
                        : conversationType === "group"
                          ? groupMembers[
                              replyingToMessage.sender_id
                            ]?.display_name ??
                            groupMembers[
                              replyingToMessage.sender_id
                            ]?.qall_id ??
                            "group member"
                          : partner?.contact_name ??
                            "contact"}
                    </Text>

                    <Text
                      style={styles.editPreview}
                      numberOfLines={1}
                    >
                      {replyingToMessage.body}
                    </Text>
                  </View>

                  <Pressable
                    onPress={cancelReplying}
                    hitSlop={10}
                  >
                    <Ionicons
                      name="close-circle"
                      size={23}
                      color="#65706D"
                    />
                  </Pressable>
                </View>
              )}

              {editingMessage && (
                <View style={styles.editBanner}>
                  <View style={styles.editIndicator} />

                  <View style={styles.editContent}>
                    <Text style={styles.editTitle}>
                      Editing message
                    </Text>

                    <Text
                      style={styles.editPreview}
                      numberOfLines={1}
                    >
                      {editingMessage.body}
                    </Text>
                  </View>

                  <Pressable
                    onPress={cancelEditing}
                    hitSlop={10}
                  >
                    <Ionicons
                      name="close-circle"
                      size={23}
                      color="#65706D"
                    />
                  </Pressable>
                </View>
              )}

              {recorderState.isRecording ? (
                <View style={styles.recordingComposer}>
                  <View style={styles.recordingPulse} />

                  <Text style={styles.recordingLabel}>
                    Recording
                  </Text>

                  <Text style={styles.recordingTimer}>
                    {formatVideoDuration(
                      recorderState.durationMillis /
                        1000
                    )}
                  </Text>

                  <View style={styles.recordingSpacer} />

                  <Pressable
                    onPress={cancelVoiceRecording}
                    style={styles.cancelRecordingButton}
                  >
                    <Text
                      style={
                        styles.cancelRecordingText
                      }
                    >
                      Cancel
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={stopVoiceRecording}
                    style={styles.stopRecordingButton}
                  >
                    <Ionicons
                      name="stop"
                      size={19}
                      color="#FFFFFF"
                    />
                  </Pressable>
                </View>
              ) : recordedVoiceUri ? (
                <View style={styles.recordedVoiceComposer}>
                  <View style={styles.recordedVoiceHeader}>
                    <View style={styles.recordedVoiceTitleRow}>
                      <Ionicons
                        name="mic"
                        size={21}
                        color="#176B5B"
                      />

                      <Text style={styles.recordedVoiceLabel}>
                        Listen before sending
                      </Text>
                    </View>

                    <Text style={styles.recordedVoiceDuration}>
                      {formatVideoDuration(
                        recordedVoiceDuration
                      )}
                    </Text>
                  </View>

                  <RecordedVoicePreview
                    uri={recordedVoiceUri}
                    durationSeconds={
                      recordedVoiceDuration
                    }
                  />

                  <View style={styles.recordedVoiceActions}>
                    <Pressable
                      onPress={cancelVoiceRecording}
                      disabled={uploadingVoice}
                      style={styles.discardVoiceButton}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={21}
                        color="#B42318"
                      />
                      <Text style={styles.discardVoiceText}>
                        Delete
                      </Text>
                    </Pressable>

                    <Pressable
                      onPress={sendRecordedVoice}
                      disabled={uploadingVoice}
                      style={[
                        styles.sendRecordedVoiceButton,
                        uploadingVoice &&
                          styles.sendDisabled,
                      ]}
                    >
                      {uploadingVoice ? (
                        <ActivityIndicator
                          size="small"
                          color="#FFFFFF"
                        />
                      ) : (
                        <>
                          <Ionicons
                            name="send"
                            size={20}
                            color="#FFFFFF"
                          />
                          <Text
                            style={
                              styles.sendRecordedVoiceText
                            }
                          >
                            Send
                          </Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.composer}>
                  <Pressable
                    onPress={pickAndSendImages}
                    disabled={
                      sending ||
                      uploadingImages ||
                      uploadingVideo ||
                      uploadingFile ||
                      uploadingVoice ||
                      Boolean(editingMessage)
                    }
                    style={({ pressed }) => [
                      styles.attachmentButton,
                      pressed && styles.pressed,
                      (sending ||
                        uploadingImages ||
                        uploadingVideo ||
                        uploadingFile ||
                        uploadingVoice ||
                        editingMessage) &&
                        styles.attachmentDisabled,
                    ]}
                  >
                    {uploadingImages ? (
                      <ActivityIndicator
                        size="small"
                        color="#176B5B"
                      />
                    ) : (
                      <Ionicons
                        name="image-outline"
                        size={22}
                        color="#176B5B"
                      />
                    )}
                  </Pressable>

                  <Pressable
                    onPress={pickAndSendVideo}
                    disabled={
                      sending ||
                      uploadingImages ||
                      uploadingVideo ||
                      uploadingFile ||
                      uploadingVoice ||
                      Boolean(editingMessage)
                    }
                    style={({ pressed }) => [
                      styles.attachmentButton,
                      pressed && styles.pressed,
                      (sending ||
                        uploadingImages ||
                        uploadingVideo ||
                        uploadingFile ||
                        uploadingVoice ||
                        editingMessage) &&
                        styles.attachmentDisabled,
                    ]}
                  >
                    {uploadingVideo ? (
                      <ActivityIndicator
                        size="small"
                        color="#176B5B"
                      />
                    ) : (
                      <Ionicons
                        name="videocam-outline"
                        size={22}
                        color="#176B5B"
                      />
                    )}
                  </Pressable>

                  <Pressable
                    onPress={pickAndSendFile}
                    disabled={
                      sending ||
                      uploadingImages ||
                      uploadingVideo ||
                      uploadingFile ||
                      uploadingVoice ||
                      Boolean(editingMessage)
                    }
                    style={({ pressed }) => [
                      styles.attachmentButton,
                      pressed && styles.pressed,
                      (sending ||
                        uploadingImages ||
                        uploadingVideo ||
                        uploadingFile ||
                        uploadingVoice ||
                        editingMessage) &&
                        styles.attachmentDisabled,
                    ]}
                  >
                    {uploadingFile ? (
                      <ActivityIndicator
                        size="small"
                        color="#176B5B"
                      />
                    ) : (
                      <Ionicons
                        name="attach-outline"
                        size={22}
                        color="#176B5B"
                      />
                    )}
                  </Pressable>

                  <TextInput
                    value={messageText}
                    onChangeText={
                      handleMessageTextChange
                    }
                    placeholder="Message"
                    multiline
                    maxLength={4000}
                    style={styles.messageInput}
                  />

                  {messageText.trim() ||
                  editingMessage ? (
                    <Pressable
                      onPress={
                        editingMessage
                          ? saveEditedMessage
                          : sendMessage
                      }
                      disabled={
                        sending ||
                        !messageText.trim()
                      }
                      style={({ pressed }) => [
                        styles.sendButton,
                        pressed && styles.pressed,
                        (sending ||
                          !messageText.trim()) &&
                          styles.sendDisabled,
                      ]}
                    >
                      {sending ? (
                        <ActivityIndicator
                          size="small"
                          color="#FFFFFF"
                        />
                      ) : (
                        <Ionicons
                          name={
                            editingMessage
                              ? "checkmark"
                              : "send"
                          }
                          size={22}
                          color="#FFFFFF"
                        />
                      )}
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={startVoiceRecording}
                      style={({ pressed }) => [
                        styles.microphoneButton,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Ionicons
                        name="mic"
                        size={23}
                        color="#FFFFFF"
                      />
                    </Pressable>
                  )}
                </View>
              )}
            </>
          )}
        </KeyboardAvoidingView>
        </SafeAreaView>

        <Modal
          visible={viewerImages.length > 0}
          animationType="fade"
          presentationStyle="fullScreen"
          onRequestClose={closeImageViewer}
        >
          <SafeAreaView style={styles.viewerScreen}>
            <View style={styles.viewerHeader}>
              <Pressable
                onPress={closeImageViewer}
                style={styles.viewerHeaderButton}
              >
                <Ionicons
                  name="close"
                  size={27}
                  color="#FFFFFF"
                />
              </Pressable>

              <Text style={styles.viewerCounter}>
                {viewerIndex + 1} /{" "}
                {viewerImages.length}
              </Text>

              <Pressable
                onPress={shareCurrentImage}
                style={styles.viewerHeaderButton}
              >
                <Ionicons
                  name="share-outline"
                  size={25}
                  color="#FFFFFF"
                />
              </Pressable>
            </View>

            <FlatList
              data={viewerImages}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              keyExtractor={(item, index) =>
                `${item}-${index}`
              }
              initialScrollIndex={viewerIndex}
              getItemLayout={(_, index) => ({
                length: VIEWER_WIDTH,
                offset: VIEWER_WIDTH * index,
                index,
              })}
              onMomentumScrollEnd={(event) => {
                const index = Math.round(
                  event.nativeEvent.contentOffset.x /
                    VIEWER_WIDTH
                );
                setViewerIndex(index);
              }}
              renderItem={({ item }) => (
                <View style={styles.viewerPage}>
                  <Image
                    source={{ uri: item }}
                    style={styles.viewerImage}
                    resizeMode="contain"
                  />
                </View>
              )}
            />
          </SafeAreaView>
        </Modal>
      </GestureHandlerRootView>
    </>
  );
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: "#EEF3F1",
  },
  keyboardView: {
    flex: 1,
  },
  centerScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F7F8FA",
  },
  partnerBar: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#DDE5E2",
    backgroundColor: "#FFFFFF",
  },
  avatarContainer: {
    position: "relative",
  },
  partnerAvatarImage: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#DDE5E2",
  },
  partnerAvatar: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: "#176B5B",
  },
  onlineDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 13,
    height: 13,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    borderRadius: 7,
    backgroundColor: "#22A06B",
  },
  partnerInitial: {
    fontSize: 17,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  partnerDetails: {
    flex: 1,
    marginLeft: 11,
  },
  partnerName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#18201E",
  },
  partnerPresence: {
    marginTop: 2,
    fontSize: 12,
    color: "#71807B",
  },
  activePresence: {
    fontWeight: "600",
    color: "#17845F",
  },
  messageListContainer: {
    flex: 1,
    position: "relative",
  },
  messageListView: {
    flex: 1,
  },
  messageListHidden: {
    opacity: 0,
  },
  messageList: {
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 16,
  },
  emptyMessageList: {
    flexGrow: 1,
  },
  jumpToLatestButton: {
    position: "absolute",
    right: 14,
    bottom: 12,
    minWidth: 44,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#C7D5D1",
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
    shadowColor: "#000000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.16,
    shadowRadius: 4,
    elevation: 4,
  },
  jumpToLatestPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.97 }],
  },
  unseenMessageBadge: {
    minWidth: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 5,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: "#176B5B",
  },
  unseenMessageBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  dateSeparatorRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 14,
    paddingHorizontal: 20,
  },
  dateSeparatorLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#C9D5D1",
  },
  dateSeparatorPill: {
    marginHorizontal: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: "#DCE8E4",
  },
  dateSeparatorText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#52615D",
  },
  messageRow: {
    width: "100%",
  },
  groupedMessageRow: {
    marginBottom: 2,
  },
  lastMessageRow: {
    marginBottom: 10,
  },
  myMessageRow: {
    alignItems: "flex-end",
  },
  theirMessageRow: {
    alignItems: "flex-start",
  },
  messageBubble: {
    maxWidth: "82%",
    minWidth: 66,
    paddingHorizontal: 13,
    paddingTop: 8,
    paddingBottom: 6,
    borderRadius: 18,
  },
  myMessageBubble: {
    borderBottomRightRadius: 4,
    backgroundColor: "#176B5B",
  },
  theirMessageBubble: {
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E0E7E4",
    backgroundColor: "#FFFFFF",
  },
  myBubbleGroupedTop: {
    borderTopRightRadius: 7,
  },
  myBubbleGroupedBottom: {
    borderBottomRightRadius: 7,
  },
  theirBubbleGroupedTop: {
    borderTopLeftRadius: 7,
  },
  theirBubbleGroupedBottom: {
    borderBottomLeftRadius: 7,
  },
  replyQuote: {
    flexDirection: "row",
    marginBottom: 7,
    paddingVertical: 6,
    paddingRight: 8,
    borderRadius: 8,
    overflow: "hidden",
  },
  myReplyQuote: {
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  theirReplyQuote: {
    backgroundColor: "#EEF4F2",
  },
  replyQuoteBar: {
    width: 3,
    marginRight: 8,
    borderRadius: 2,
    backgroundColor: "#176B5B",
  },
  myReplyQuoteBar: {
    backgroundColor: "#8FE0CF",
  },
  replyQuoteContent: {
    flex: 1,
  },
  replyQuoteAuthor: {
    fontSize: 11,
    fontWeight: "800",
    color: "#176B5B",
  },
  myReplyQuoteAuthor: {
    color: "#A9EEE0",
  },
  replyQuoteText: {
    marginTop: 1,
    fontSize: 12,
    color: "#66736F",
  },
  myReplyQuoteText: {
    color: "#E2F3EF",
  },
  voiceMessageCard: {
    width: 252,
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 3,
    paddingHorizontal: 9,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  voicePlayButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: "#176B5B",
  },
  myVoicePlayButton: {
    backgroundColor: "#FFFFFF",
  },
  voiceMainContent: {
    flex: 1,
  },
  voiceWaveform: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  voiceWaveBar: {
    width: 3,
    borderRadius: 2,
  },
  myVoiceWaveBar: {
    backgroundColor: "#9AC8BE",
  },
  theirVoiceWaveBar: {
    backgroundColor: "#AAB7B3",
  },
  myVoiceWaveBarPlayed: {
    backgroundColor: "#FFFFFF",
  },
  theirVoiceWaveBarPlayed: {
    backgroundColor: "#176B5B",
  },
  voiceFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  voiceTimeText: {
    fontSize: 10,
    color: "#66736F",
  },
  myVoiceTimeText: {
    color: "#D4ECE7",
  },
  voiceSpeedButton: {
    minWidth: 28,
    alignItems: "center",
    paddingVertical: 2,
  },
  voiceSpeedText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#176B5B",
  },
  myVoiceSpeedText: {
    color: "#FFFFFF",
  },
  fileMessageCard: {
    width: 252,
    minHeight: 76,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 3,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  fileIconContainer: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  fileMessageDetails: {
    flex: 1,
  },
  fileMessageName: {
    fontSize: 13,
    fontWeight: "800",
    color: "#18201E",
  },
  myFileMessageName: {
    color: "#FFFFFF",
  },
  fileMessageMeta: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: "700",
    color: "#66736F",
  },
  myFileMessageMeta: {
    color: "#D4ECE7",
  },
  fileActionColumn: {
    flexDirection: "row",
    gap: 4,
  },
  fileActionButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  videoMessageCard: {
    width: 252,
    marginBottom: 3,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#101312",
  },
  videoPlayer: {
    width: 252,
    height: 174,
    backgroundColor: "#000000",
  },
  compactVideoPlayer: {
    width: 210,
    height: 118,
    backgroundColor: "#000000",
  },
  videoMenuButton: {
    position: "absolute",
    top: 7,
    right: 7,
    zIndex: 3,
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: "rgba(0,0,0,0.62)",
  },
  videoMessageMeta: {
    position: "absolute",
    right: 7,
    bottom: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.62)",
  },
  videoDurationText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  myVideoDurationText: {
    color: "#FFFFFF",
  },
  imageGrid: {
    width: 252,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 3,
    marginBottom: 3,
    borderRadius: 12,
    overflow: "hidden",
  },
  singleImageGrid: {
    width: 252,
  },
  imageTile: {
    width: 124,
    height: 124,
    backgroundColor: "#DDE5E2",
  },
  singleImageTile: {
    width: 252,
    height: 220,
  },
  messageImage: {
    width: "100%",
    height: "100%",
  },
  linkPreviewCard: {
    width: 252,
    marginTop: 7,
    marginBottom: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#D2DDD9",
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#F4F7F6",
  },
  myLinkPreviewCard: {
    borderColor: "rgba(255,255,255,0.22)",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  linkPreviewImage: {
    width: "100%",
    height: 128,
    backgroundColor: "#DDE5E2",
  },
  linkPreviewContent: {
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  linkPreviewSite: {
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    color: "#176B5B",
  },
  myLinkPreviewSite: {
    color: "#A9EEE0",
  },
  linkPreviewTitle: {
    marginTop: 3,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
    color: "#18201E",
  },
  myLinkPreviewTitle: {
    color: "#FFFFFF",
  },
  linkPreviewDescription: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 16,
    color: "#66736F",
  },
  myLinkPreviewDescription: {
    color: "#D4ECE7",
  },
  messageBody: {
    fontSize: 16,
    lineHeight: 21,
    color: "#18201E",
  },
  myMessageBody: {
    color: "#FFFFFF",
  },
  messageFooter: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-end",
    gap: 3,
    marginTop: 3,
  },
  messageTime: {
    fontSize: 10,
    color: "#7C8884",
  },
  myMessageTime: {
    color: "#D4ECE7",
  },
  emptyChat: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 80,
  },
  emptyChatIcon: {
    width: 76,
    height: 76,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 38,
    backgroundColor: "#DAEBE7",
  },
  emptyChatTitle: {
    marginTop: 15,
    fontSize: 18,
    fontWeight: "700",
    color: "#18201E",
  },
  emptyChatText: {
    marginTop: 6,
    color: "#697571",
  },
  messagePressed: {
    opacity: 0.82,
  },
  failedMessageBubble: {
    borderWidth: 1,
    borderColor: "#F59C93",
    backgroundColor: "#A93A32",
  },
  receiptContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  receiptSymbol: {
    minWidth: 13,
    fontSize: 12,
    lineHeight: 14,
    fontWeight: "800",
    letterSpacing: -3,
    color: "#D4ECE7",
  },
  readReceiptSymbol: {
    color: "#78D5FF",
  },
  retryText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#FFD2CC",
  },
  receiptDetail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 4,
    marginRight: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "#DCE8E4",
  },
  receiptDetailSymbol: {
    minWidth: 16,
    fontSize: 12,
    lineHeight: 14,
    fontWeight: "800",
    letterSpacing: -3,
    color: "#60716C",
  },
  readReceiptDetailSymbol: {
    color: "#2589B8",
  },
  receiptDetailText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#52615D",
  },
  swipeReplyAction: {
    width: 82,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    marginBottom: 2,
    backgroundColor: "#2B8A74",
  },
  swipeRightActions: {
    flexDirection: "row",
    marginBottom: 2,
  },
  swipeActionButton: {
    width: 72,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  copySwipeAction: {
    backgroundColor: "#527A92",
  },
  deleteSwipeAction: {
    backgroundColor: "#B5473E",
  },
  moreSwipeAction: {
    backgroundColor: "#5E6865",
  },
  swipeActionText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  reactionSummaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 3,
  },
  myReactionSummaryRow: {
    justifyContent: "flex-end",
    marginRight: 4,
  },
  theirReactionSummaryRow: {
    justifyContent: "flex-start",
    marginLeft: 4,
  },
  reactionChip: {
    minHeight: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: "#D7E0DD",
    borderRadius: 13,
    backgroundColor: "#FFFFFF",
  },
  myReactionChip: {
    borderColor: "#75B7A9",
    backgroundColor: "#DDF0EB",
  },
  reactionEmoji: {
    fontSize: 14,
  },
  reactionCount: {
    fontSize: 11,
    fontWeight: "700",
    color: "#60706C",
  },
  myReactionCount: {
    color: "#176B5B",
  },
  reactionPicker: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginTop: 6,
    paddingHorizontal: 5,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
  },
  myReactionPicker: {
    alignSelf: "flex-end",
    marginRight: 4,
  },
  theirReactionPicker: {
    alignSelf: "flex-start",
    marginLeft: 4,
  },
  reactionPickerButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
  },
  selectedReactionButton: {
    backgroundColor: "#DDF0EB",
  },
  reactionPickerEmoji: {
    fontSize: 20,
  },
  inlineActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    marginRight: 4,
  },
  theirInlineActions: {
    alignSelf: "flex-start",
    marginLeft: 4,
    marginRight: 0,
  },
  inlineActionButton: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: "#DCE3E0",
    borderRadius: 17,
    backgroundColor: "#FFFFFF",
  },
  inlineEditText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#176B5B",
  },
  inlineDeleteText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#B42318",
  },
  deletedMessageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  deletedMessageText: {
    fontSize: 14,
    fontStyle: "italic",
    color: "#71807B",
  },
  myDeletedMessageText: {
    color: "#D4ECE7",
  },
  editedText: {
    marginRight: 3,
    fontSize: 9,
    fontStyle: "italic",
    color: "#7C8884",
  },
  myEditedText: {
    color: "#D4ECE7",
  },
  systemMessageRow: {
    alignItems: "center",
    paddingHorizontal: 28,
    paddingVertical: 7,
  },
  systemMessagePill: {
    maxWidth: "92%",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: "#EEF2F0",
  },
  systemMessageText: {
    flexShrink: 1,
    textAlign: "center",
    fontSize: 12,
    lineHeight: 17,
    color: "#53615D",
  },
  systemMessageTime: {
    marginTop: 3,
    fontSize: 10,
    color: "#98A39F",
  },
  groupSenderIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginBottom: 4,
    marginLeft: 2,
  },
  groupSenderName: {
    maxWidth: 210,
    fontSize: 12,
    fontWeight: "700",
    color: "#52605C",
  },
  typingIndicatorRow: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 5,
    backgroundColor: "#F7FAF9",
  },
  typingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#DCE5E2",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  typingDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#7B8A85",
  },
  typingLabel: {
    marginLeft: 8,
    fontSize: 11,
    color: "#71807B",
  },
  replyBanner: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#DDE5E2",
    backgroundColor: "#F2F7F5",
  },
  replyBannerIndicator: {
    width: 3,
    alignSelf: "stretch",
    marginRight: 10,
    borderRadius: 2,
    backgroundColor: "#2B8A74",
  },
  replyBannerTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#2B8A74",
  },
  editBanner: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#DDE5E2",
    backgroundColor: "#F2F7F5",
  },
  editIndicator: {
    width: 3,
    alignSelf: "stretch",
    marginRight: 10,
    borderRadius: 2,
    backgroundColor: "#176B5B",
  },
  editContent: {
    flex: 1,
  },
  editTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#176B5B",
  },
  editPreview: {
    marginTop: 2,
    fontSize: 13,
    color: "#65706D",
  },
  recordingComposer: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#D5DFDC",
    backgroundColor: "#FFFFFF",
  },
  recordingPulse: {
    width: 10,
    height: 10,
    marginRight: 8,
    borderRadius: 5,
    backgroundColor: "#D92D20",
  },
  recordingLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: "#B42318",
  },
  recordingTimer: {
    marginLeft: 8,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    color: "#52615D",
  },
  recordingSpacer: {
    flex: 1,
  },
  cancelRecordingButton: {
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  cancelRecordingText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#B42318",
  },
  stopRecordingButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 5,
    borderRadius: 21,
    backgroundColor: "#D92D20",
  },
  recordedVoiceComposer: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#D5DFDC",
    backgroundColor: "#FFFFFF",
  },
  recordedVoiceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  recordedVoiceTitleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  recordedVoiceLabel: {
    marginLeft: 7,
    fontSize: 13,
    fontWeight: "700",
    color: "#176B5B",
  },
  recordedVoiceDuration: {
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    color: "#52615D",
  },
  recordedVoicePreview: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#CFE0DB",
    borderRadius: 14,
    backgroundColor: "#F2F7F5",
  },
  recordedVoicePlayButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    backgroundColor: "#176B5B",
  },
  recordedVoicePreviewMain: {
    flex: 1,
  },
  recordedVoiceProgressTrack: {
    height: 5,
    overflow: "hidden",
    borderRadius: 3,
    backgroundColor: "#C8D8D4",
  },
  recordedVoiceProgressFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: "#176B5B",
  },
  recordedVoicePreviewFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 5,
  },
  recordedVoicePreviewTime: {
    fontSize: 10,
    fontVariant: ["tabular-nums"],
    color: "#65726E",
  },
  recordedVoiceRestartButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: "#DCEBE7",
  },
  recordedVoiceActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 9,
    marginTop: 9,
  },
  discardVoiceButton: {
    minWidth: 92,
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 13,
    borderRadius: 21,
    backgroundColor: "#FDECEA",
  },
  discardVoiceText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#B42318",
  },
  sendRecordedVoiceButton: {
    minWidth: 98,
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 15,
    borderRadius: 21,
    backgroundColor: "#176B5B",
  },
  sendRecordedVoiceText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  microphoneButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 23,
    backgroundColor: "#176B5B",
  },
  attachmentButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: "#E6F1EE",
  },
  attachmentDisabled: {
    opacity: 0.45,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: "#DDE5E2",
    backgroundColor: "#FFFFFF",
  },
  messageInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: 15,
    paddingTop: 11,
    paddingBottom: 10,
    borderWidth: 1,
    borderColor: "#D8E0DD",
    borderRadius: 22,
    backgroundColor: "#F7F9F8",
    fontSize: 16,
    color: "#18201E",
  },
  sendButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 23,
    backgroundColor: "#176B5B",
  },
  sendDisabled: {
    opacity: 0.42,
  },
  viewerScreen: {
    flex: 1,
    backgroundColor: "#000000",
  },
  viewerHeader: {
    height: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    backgroundColor: "#000000",
  },
  viewerHeaderButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  viewerCounter: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  viewerPage: {
    width: VIEWER_WIDTH,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  viewerImage: {
    width: VIEWER_WIDTH,
    height: "100%",
  },
  pressed: {
    opacity: 0.78,
  },

  groupHeaderIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  groupCallButtonDisabled: {
    opacity: 0.5,
  },

  partnerCallActions: {
    flexDirection: "row",
    gap: 7,
    marginLeft: 8,
  },
  partnerCallButton: {
    width: 39,
    height: 39,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    backgroundColor: "#E6F2EF",
  },
});
