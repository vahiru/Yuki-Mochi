import type { CloudModel } from "../../../model/llm";
import type { TelegramMessage } from "../../../types/message";
import { getSharedMemoryVfsClient, type ChatMessage, type MessageMetadata } from "../../../storage/vfs";
import { buildMentionActorRefs, buildReplyActorRef, buildSenderActorRef } from "../../../utils/actor";
import { createArchiveAssembler } from "./assembler";
import { ARCHIVER_SYSTEM_PROMPT } from "./prompt";

type ArchivePatchFile = "preferences" | "tech_projects" | "relations";

interface ArchivePatch {
  user_id: string;
  file: ArchivePatchFile;
  content: Record<string, unknown>;
}

type ExtendedMessageMetadata = MessageMetadata & {
  replyToUsername?: string;
  replyToPreviewText?: string;
  mentionUserIds?: string[];
  usernameHandle?: string;
  senderEntityType?: TelegramMessage["metadata"]["senderEntityType"];
  actorId?: string;
  actorDisplayName?: string;
  actorUsername?: string;
  actorUsernameHandle?: string;
  actorEntityType?: TelegramMessage["metadata"]["senderEntityType"];
  replyToActorId?: string;
  replyToActorDisplayName?: string;
  replyToActorUsername?: string;
  replyToActorUsernameHandle?: string;
  replyToActorEntityType?: TelegramMessage["metadata"]["senderEntityType"];
  mentionedActorIds?: string[];
};

export interface BackgroundArchiveSession {
  sessionId: string;
  chatId: number;
  centerVector: number[];
  topicSummary: string;
  messages: Array<{
    message: TelegramMessage;
    vector: number[];
  }>;
}

export interface ArchiverService {
  runBackgroundArchive: (session: BackgroundArchiveSession) => Promise<void>;
}

export interface CreateArchiverServiceOptions {
  cloudModel?: CloudModel;
  vfsClient?: InstanceType<typeof import("../../../storage/vfs").MemoryVfsClient>;
}

export function createArchiverService(options: CreateArchiverServiceOptions = {}): ArchiverService {
  const cloudModel = options.cloudModel;
  const vfsClient = options.vfsClient ?? getSharedMemoryVfsClient();
  const assembler = createArchiveAssembler();

  return {
    runBackgroundArchive: async (session) => {
      await vfsClient.archive({
        sessionId: session.sessionId,
        chatId: String(session.chatId),
        centroidVector: session.centerVector,
        abstractSummary: session.topicSummary,
        messages: session.messages.map((item) => toVfsChatMessage(item.message, item.vector)),
      });

      if (!cloudModel || session.messages.length === 0) {
        return;
      }

      const llmMessages = assembler.build({
        sessionMessages: session.messages.map((item) => item.message),
        sessionId: session.sessionId,
        systemPrompt: ARCHIVER_SYSTEM_PROMPT,
      });
      const { text } = await cloudModel.complete({ messages: llmMessages });
      const patches = parseArchivePatches(text);
      if (patches.length === 0) {
        return;
      }

      for (const patch of patches) {
        await vfsClient.patch({
          path: `mem://users/${patch.user_id}/${patch.file}.json`,
          partialContent: JSON.stringify(patch.content),
        });
      }
    },
  };
}

function toVfsChatMessage(message: TelegramMessage, vector: number[]): ChatMessage {
  const sender = buildSenderActorRef(message);
  const replyToSender = buildReplyActorRef(message);
  const mentionedActors = buildMentionActorRefs(message).filter((actor) => actor.id !== "unknown");
  const metadata: ExtendedMessageMetadata = {
    isBot: message.metadata.isBot,
    username: message.metadata.username ?? "",
    replyToMessageId: String(message.metadata.replyToMessageId ?? ""),
    replyToUserId: message.metadata.replyToUserId ?? "",
    replyToUsername: message.metadata.replyToUsername ?? "",
    replyToPreviewText: message.metadata.replyToPreviewText ?? "",
    isReplyToMe: message.metadata.isReplyToMe,
    isMentionMe: message.metadata.isMentionMe,
    mentions: message.metadata.mentions,
    mentionUserIds: message.metadata.mentionUserIds ?? [],
    usernameHandle: message.metadata.usernameHandle ?? "",
    senderEntityType: message.metadata.senderEntityType ?? "unknown",
    actorId: sender?.id ?? message.userId,
    actorDisplayName: sender?.displayName ?? message.metadata.username ?? "",
    actorUsername: sender?.username ?? "",
    actorUsernameHandle: sender?.usernameHandle ?? message.metadata.usernameHandle ?? "",
    actorEntityType: sender?.entityType ?? message.metadata.senderEntityType ?? "unknown",
    replyToActorId: replyToSender?.id ?? message.metadata.replyToUserId ?? "",
    replyToActorDisplayName: replyToSender?.displayName ?? message.metadata.replyToUsername ?? "",
    replyToActorUsername: replyToSender?.username ?? "",
    replyToActorUsernameHandle: replyToSender?.usernameHandle ?? "",
    replyToActorEntityType: replyToSender?.entityType ?? "unknown",
    mentionedActorIds: mentionedActors.map((actor) => actor.id),
  };
  return {
    userId: message.userId,
    messageId: String(message.messageId),
    chatId: String(message.chatId),
    conversationType: message.conversationType,
    context: message.context,
    timestamp: message.timestamp,
    metadata: metadata as MessageMetadata,
    vector: vector.slice(),
  };
}

function parseArchivePatches(raw: string): ArchivePatch[] {
  const direct = tryParseJson(raw);
  if (Array.isArray(direct)) {
    return sanitizeArchivePatches(direct);
  }

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  const extracted = tryParseJson(match[0]);
  if (!Array.isArray(extracted)) {
    return [];
  }
  return sanitizeArchivePatches(extracted);
}

function tryParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function sanitizeArchivePatches(input: unknown[]): ArchivePatch[] {
  return input.filter(isArchivePatch);
}

function isArchivePatch(value: unknown): value is ArchivePatch {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ArchivePatch>;
  const isValidFile =
    candidate.file === "preferences" ||
    candidate.file === "tech_projects" ||
    candidate.file === "relations";
  return (
    typeof candidate.user_id === "string" &&
    candidate.user_id.length > 0 &&
    isValidFile &&
    Boolean(candidate.content) &&
    typeof candidate.content === "object" &&
    !Array.isArray(candidate.content)
  );
}
