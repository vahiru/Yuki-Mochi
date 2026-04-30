import type { ActorRef, LLMMessage, TelegramMessage } from "../../../types/message";

export interface MessageNode {
  message: TelegramMessage;
  messageId: number;
  timestamp: number;
  replyToId: number | null;
  childrenIds: number[];
  sessionId: string;
  vector: number[];
}

export type SessionStatus = "L1_ACTIVE" | "L2_BACKGROUND" | "L3_ARCHIVED";

export interface SessionControlBlock {
  sessionId: string;
  topicSummary: string;
  /** Number of messages in session when topicSummary was last updated (for cloud summarization). */
  lastSummarizedMessageCount: number;
  centerVector: number[];
  recentVector: number[] | null;
  status: SessionStatus;
  lastActiveTime: number;
  messageIds: Set<number>;
  rootMessageIds: Set<number>;
}

export interface ParticipantState {
  actor: ActorRef;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
  recentMessageIds: number[];
  displayNameHistory: string[];
  usernameHistory: string[];
  hasDisplayNameConflict: boolean;
}

export interface ContextNameChangeEvent {
  type: "name_change";
  actorId: string;
  oldDisplayName: string | null;
  newDisplayName: string | null;
  oldUsernameHandle: string | null;
  newUsernameHandle: string | null;
  timestamp: number;
}

export interface ContextDisplayNameConflictEvent {
  type: "display_name_conflict";
  displayName: string;
  actorIds: string[];
  timestamp: number;
}

export type ContextIdentityEvent =
  | ContextNameChangeEvent
  | ContextDisplayNameConflictEvent;

export interface ResolvedTarget {
  actorId: string | null;
  entityType: ActorRef["entityType"];
  displayName: string | null;
  usernameHandle: string | null;
  via: "reply" | "mention_user" | "mention_handle" | "display_name" | "pronoun";
}

export interface ChatControlBlock {
  chatId: number;
  sessionControlBlocks: Map<string, SessionControlBlock>;
  messageNodes: Map<number, MessageNode>;
  usernameHandleToUserId: Map<string, { userId: string; expiresAt: number }>;
  participantsById: Map<string, ParticipantState>;
  displayNameToActorIds: Map<string, Set<string>>;
  displayNameConflictSignatures: Map<string, string>;
  identityEvents: ContextIdentityEvent[];
  lastMessageNodeId: number | null;
  nextSessionSeq: number;
  lastExpirationCheckTime: number;
  lastActivityTime: number;
}

export interface ContextAnchorSnapshot {
  recentMessages: TelegramMessage[];
  sessionMessages: TelegramMessage[];
  targetMessages: TelegramMessage[];
  participants: ParticipantState[];
  identityEvents: ContextIdentityEvent[];
  resolvedTargets: ResolvedTarget[];
}

export interface ContextStore {
  ingestMessage: (input: { message: TelegramMessage }) => Promise<void>;
  getContextByAnchor: (input: { chatId: number; messageId: number }) => ContextAnchorSnapshot;
  /** For evaluation: return sessionId for a message, or null if not found. */
  getSessionIdForMessage?: (input: { chatId: number; messageId: number }) => string | null;
  debugPrintSessionControlBlocks: (input?: {
    chatId?: number;
    includeVectors?: boolean;
    log?: (...args: unknown[]) => void;
  }) => void;
}

export interface ContextAssemblerBuildInput {
  triggerMessage: TelegramMessage;
  contextMessages: TelegramMessage[];
  recentMessages: TelegramMessage[];
  targetMessages: TelegramMessage[];
  participants: ParticipantState[];
  identityEvents: ContextIdentityEvent[];
  resolvedTargets: ResolvedTarget[];
  systemPrompt: string;
}

export interface ContextAssembler {
  build: (input: ContextAssemblerBuildInput) => LLMMessage[];
}
