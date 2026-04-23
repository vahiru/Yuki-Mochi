export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type TelegramConversationType =
  | "private"
  | "group"
  | "supergroup"
  | "channel";

export type TelegramSenderEntityType =
  | "user"
  | "chat"
  | "channel"
  | "unknown";

export interface ActorRef {
  id: string;
  entityType: TelegramSenderEntityType;
  displayName: string | null;
  username: string | null;
  usernameHandle: string | null;
  isBot: boolean;
}

export interface TelegramMessage {
  userId: string;
  sender?: ActorRef;
  messageId: number;
  chatId: number;
  conversationType: TelegramConversationType;
  context: string;
  timestamp: number;
  imageUrls?: string[];
  metadata: {
    isBot: boolean;
    isSelf?: boolean;
    username: string | null;
    replyToMessageId: number | null;
    replyToUserId: string | null;
    replyToUsername?: string | null;
    replyToUsernameHandle?: string | null;
    replyToPreviewText?: string | null;
    isReplyToMe: boolean;
    isMentionMe: boolean;
    mentions: string[];
    mentionUserIds?: string[];
    usernameHandle?: string | null;
    senderEntityType?: TelegramSenderEntityType;
    replyToSender?: ActorRef | null;
    mentionedActors?: ActorRef[];
  };
}
