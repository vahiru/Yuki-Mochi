import { createDenseEmbedder, type DenseEmbedder } from "../../../model/embedding";
import type { CloudModel, LocalModel } from "../../../model/llm";
import type { ActorRef, TelegramMessage } from "../../../types/message";
import { createArchiverService } from "../archiver";
import { createContextSearcher } from "../searcher";
import {
  decideSessionByLlm,
  decideSessionByReranker,
  type SessionDeciderResult,
  type SessionSummary,
} from "../decider/sessionDecider";
import type { SearchResult } from "../../../storage/vfs";
import type {
  ChatControlBlock,
  ContextAnchorSnapshot,
  ContextIdentityEvent,
  ContextStore,
  MessageNode,
  ParticipantState,
  ResolvedTarget,
  SessionControlBlock,
  SessionStatus,
} from "./types";
import {
  buildMentionActorRefs,
  buildReplyActorRef,
  buildSenderActorRef,
  createActorRef,
  hydrateMessageActors,
  inferSenderEntityTypeFromId,
  isKnownActorId,
  mergeActorRef,
  normalizeDisplayName,
  normalizeUsernameHandle,
} from "../../../utils/actor";

export interface CreateInMemoryContextStoreOptions {
  embedder?: DenseEmbedder;
  similarityThreshold?: number;
  shortMessageThreshold?: number;
  alphaTime?: number;
  lambda?: number;
  alphaCenter?: number;
  maxContextMessages?: number;
  maxSessionsPerChat?: number;
  /** When set with localModel, used as fallback when pickBestSession returns null. */
  sessionDecider?: (input: {
    message: TelegramMessage;
    sessions: SessionSummary[];
    localModel?: LocalModel;
    cloudModel?: CloudModel;
  }) => Promise<SessionDeciderResult>;
  localModel?: LocalModel;
  /** Optional cloud model for summarizing session topic when 5 new messages accumulate. */
  cloudModel?: CloudModel;
}

const GHOST_CONTEXT_WINDOW_MS = 30 * 1000;
const MEDIUM_MESSAGE_LENGTH = 8;
const SHORT_MESSAGE_LENGTH = 4;
const RECENT_SESSIONS_COUNT = 5;
const RECENT_CHAT_MESSAGES_COUNT = 10;
const SESSION_LRU_EXPIRE_MS = 10 * 60 * 1000;
const TOPIC_SUMMARY_CONCAT_MAX = 3;
const TOPIC_SUMMARY_CLOUD_BATCH = 5;
const IMPOSSIBLE_SIMILARITY_SCORE_THRESHOLD = 0.35;
const PRONOUN_REFERENCE_WINDOW_MESSAGES = 8;
const USERNAME_ALIAS_TTL_MS = 12 * 60 * 60 * 1000;
const TARGET_SPEAKER_SEMANTIC_THRESHOLD = 0.66;
const SELF_SPEAKER_SEMANTIC_THRESHOLD = 0.68;
const GROUP_SEMANTIC_THRESHOLD = 0.74;
const GROUP_RECALL_MIN_TEXT_LENGTH = 20;
const RECALL_RESULT_LIMIT = 6;
const PARTICIPANT_RECENT_MESSAGE_LIMIT = 5;
const PARTICIPANT_HISTORY_LIMIT = 5;
const IDENTITY_EVENT_HISTORY_LIMIT = 64;
const CONTEXT_PARTICIPANT_LIMIT = 12;
const CONTEXT_IDENTITY_EVENT_LIMIT = 12;

export function createInMemoryContextStore(
  options: CreateInMemoryContextStoreOptions = {}
): ContextStore {
  const embedder = options.embedder ?? createDenseEmbedder();
  const similarityThreshold = options.similarityThreshold ?? 0.60;
  const shortMessageThreshold = options.shortMessageThreshold ?? 0.45;
  // const alphaTime = options.alphaTime ?? 0.25;
  // const lambda = options.lambda ?? 1 / (2 * 60 * 1000);
  const gammaTime = 0.85;
  const lambda = options.lambda ?? 0.0022;
  const alphaCenter = options.alphaCenter ?? 0.4;
  const maxContextMessages = options.maxContextMessages ?? 250;
  const maxSessionsPerChat = options.maxSessionsPerChat ?? 32;
  const chatControlBlocks = new Map<number, ChatControlBlock>();
  // const sessionDecider = options.sessionDecider ?? decideSessionByLlm;
  const sessionDecider = options.sessionDecider ?? decideSessionByReranker;
  const localModel = options.localModel;
  const cloudModel = options.cloudModel;
  const archiverService = createArchiverService({ cloudModel });
  const contextSearcher = createContextSearcher();
  const recallDebugEnabled = parseBooleanEnv(process.env.STATE_DAEMON_RECALL_DEBUG);

  return {
    ingestMessage: async ({ message }) => {
      // console.log("ingestMessage", message);
      const now = message.timestamp;
      const chatId = message.chatId;
      const messageId = message.messageId;
      const ccb = getOrCreateChatControlBlock(chatControlBlocks, chatId);
      const materializedMessage = materializeMessageActors(ccb, message, now);
      const isShortMessage = materializedMessage.context.length <= SHORT_MESSAGE_LENGTH;
      refreshUsernameAlias(ccb, materializedMessage, now);
      void downgradeExpiredSessions(ccb, now, SESSION_LRU_EXPIRE_MS, archiverService);
      const existing = ccb.messageNodes.get(messageId);
      if (existing) {
        existing.message = materializedMessage;
        existing.timestamp = materializedMessage.timestamp;
        upsertParticipantState(ccb, materializedMessage, { incrementMessageCount: false });
        updateLastMessageNodeId(ccb, existing);
        return;
      }

      const textForEmbedding = buildEmbeddingTextWithGhostContext(ccb, materializedMessage);
      // const textForEmbedding = message.context;
      const vector = await embedMessage(embedder, textForEmbedding);
      // console.log("vector", vector);
      const replyToId = materializedMessage.metadata.replyToMessageId;
      const replyTarget = replyToId ? ccb.messageNodes.get(replyToId) ?? null : null;
      const replySession = replyTarget
        ? ccb.sessionControlBlocks.get(replyTarget.sessionId) ?? null
        : null;

      const node: MessageNode = {
        message: materializedMessage,
        messageId,
        timestamp: materializedMessage.timestamp,
        replyToId: replyTarget?.messageId ?? null,
        childrenIds: [],
        sessionId: "",
        vector,
      };

      let targetSession: SessionControlBlock | null = null;
      let shouldUpdateCenter = true;

      if (replySession) {
        targetSession = replySession;
        // let currentAlphaTime = alphaTime;
        // if (message.context.length < 15) {
        //   currentAlphaTime += 0.15;
        // }
        const score = scoreMessageToSession(vector, targetSession, now, gammaTime, lambda);
        // shouldUpdateCenter = score >= similarityThreshold && !isShortMessage;
        shouldUpdateCenter = !isShortMessage;
        setSessionActive(ccb, targetSession.sessionId);
      } else {
        if (materializedMessage.metadata.replyToMessageId !== null) {
          try {
            const searchExactResult = await contextSearcher.searchByMessageId({
              chatId,
              messageId: materializedMessage.metadata.replyToMessageId,
            });
            if (searchExactResult) {
              const recalledSession = recallSession(ccb, searchExactResult, now);
              if (recalledSession) {
                targetSession = recalledSession;
                setSessionActive(ccb, targetSession.sessionId);
              }
            }
          } catch (error) {
            console.error("context exact reply recall failed", error);
          }
        }
        if (!targetSession) {
          const best = pickBestSession(
            ccb,
            vector,
            now,
            gammaTime,
            lambda,
            materializedMessage.context.length <= MEDIUM_MESSAGE_LENGTH,
            isShortMessage,
            similarityThreshold,
            shortMessageThreshold
          );
          if (best && best.session) {
            targetSession = best.session;
          }
          // const start = performance.now();
          if (best.score >= IMPOSSIBLE_SIMILARITY_SCORE_THRESHOLD) {
            targetSession = await tryAssignSessionByDecider({
              targetSession,
              ccb,
              message: materializedMessage,
              localModel,
              cloudModel,
              sessionDecider,
            });
          }
        }
        // const elapsed = performance.now() - start;
        // console.log("tryAssignSessionByDecider", elapsed, "ms", ccb.sessionControlBlocks.size, "sessions");
      }

      if (!targetSession) {
        try {
          const explicitTargets = collectExplicitResolvedTargets(ccb, materializedMessage, now);
          const explicitTargetActorIds = collectKnownTargetActorIds(explicitTargets);
          const semanticResolution = resolveRecallTargetActorIds(
            ccb,
            materializedMessage,
            now,
            explicitTargetActorIds,
          );
          const targetScopedResults = filterSearchResultsByScore(
            await contextSearcher.searchSemantic({
              chatId,
              query: materializedMessage.context,
              limit: RECALL_RESULT_LIMIT,
              targetActorIds: semanticResolution.targetActorIds,
            }),
            TARGET_SPEAKER_SEMANTIC_THRESHOLD,
          );

          let semanticResults = targetScopedResults;
          let recallStage: "target" | "self" | "group" | "none" = semanticResults.length > 0 ? "target" : "none";

          if (semanticResults.length === 0 && !semanticResolution.targetActorIds.includes(materializedMessage.userId)) {
            const selfScopedResults = filterSearchResultsByScore(
              await contextSearcher.searchSemantic({
                chatId,
                query: materializedMessage.context,
                limit: RECALL_RESULT_LIMIT,
                targetActorIds: [materializedMessage.userId],
              }),
              SELF_SPEAKER_SEMANTIC_THRESHOLD,
            );
            if (selfScopedResults.length > 0) {
              semanticResults = selfScopedResults;
              recallStage = "self";
            }
          }

          if (
            semanticResults.length === 0 &&
            shouldAllowGroupWideSemanticRecall(materializedMessage, semanticResolution.reason, explicitTargetActorIds)
          ) {
            const groupScopedResults = filterSearchResultsByScore(
              await contextSearcher.searchSemantic({
                chatId,
                query: materializedMessage.context,
                limit: RECALL_RESULT_LIMIT,
              }),
              GROUP_SEMANTIC_THRESHOLD,
            );
            if (groupScopedResults.length > 0) {
              semanticResults = groupScopedResults;
              recallStage = "group";
            }
          }

          if (recallDebugEnabled) {
            console.log(
              `[recall] chat=${chatId} messageId=${materializedMessage.messageId} reason=${semanticResolution.reason} targets=${semanticResolution.targetActorIds.join(",") || "-"} stage=${recallStage} count=${semanticResults.length} topScore=${semanticResults[0]?.score ?? 0}`,
            );
          }

          const mostSimilarResult = semanticResults[0];
          if (mostSimilarResult) {
            const recalledSession = recallSession(ccb, mostSimilarResult, now);
            if (recalledSession) {
              targetSession = recalledSession;
              setSessionActive(ccb, targetSession.sessionId);
            }
          }
        } catch (error) {
          console.error("context search recall failed", error);
        }
        if (!targetSession) {
          targetSession = createSession(ccb, node, now, isShortMessage);
        }
      }

      node.sessionId = targetSession.sessionId;
      ccb.messageNodes.set(node.messageId, node);
      upsertParticipantState(ccb, materializedMessage, { incrementMessageCount: true });
      updateLastMessageNodeId(ccb, node);
      targetSession.messageIds.add(node.messageId);
      targetSession.lastActiveTime = now;
      if (!isShortMessage) {
        targetSession.recentVector = vector.slice();
      }

      const isReplyWithinSameSession = Boolean(
        replyTarget && replyTarget.sessionId === targetSession.sessionId
      ); // TODO: 需要修改
      if (isReplyWithinSameSession && node.replyToId) {
        const parent = ccb.messageNodes.get(node.replyToId);
        if (parent) {
          parent.childrenIds.push(node.messageId);
        }
        targetSession.rootMessageIds.delete(node.messageId);
      } else {
        node.replyToId = null;
        targetSession.rootMessageIds.add(node.messageId);
      }

      if (shouldUpdateCenter) {
        targetSession.centerVector = updateCenterVector(
          targetSession.centerVector,
          vector,
          alphaCenter
        );
      }
      // await updateTopicSummary(ccb, targetSession, cloudModel);
      void updateTopicSummary(ccb, targetSession, cloudModel).catch(error => console.error("updateTopicSummary error", error));
    },
    getContextByAnchor: ({ chatId, messageId }) => {
      const ccb = chatControlBlocks.get(chatId);
      if (!ccb) {
        return createEmptyContextAnchorSnapshot();
      }
      const node = ccb.messageNodes.get(messageId);
      if (!node) {
        return createEmptyContextAnchorSnapshot();
      }
      const anchorReplyToId = node.message.metadata.replyToMessageId;
      const anchorReplyTarget = anchorReplyToId !== null
        ? ccb.messageNodes.get(anchorReplyToId) ?? null
        : null;

      const session = ccb.sessionControlBlocks.get(node.sessionId);
      if (!session) {
        let recentMessages = Array.from(ccb.messageNodes.values())
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-RECENT_CHAT_MESSAGES_COUNT)
          .map((item) => item.message);
        if (anchorReplyTarget) {
          recentMessages = includePriorityMessage(
            recentMessages,
            anchorReplyTarget.message,
            RECENT_CHAT_MESSAGES_COUNT,
          );
        }
        return buildContextAnchorSnapshot(ccb, node, recentMessages, []);
      }

      const allSessionMessages = [...session.messageIds]
        .map((id) => ccb.messageNodes.get(id))
        .filter((item): item is MessageNode => Boolean(item))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((item) => item.message);
      let sessionMessages =
        allSessionMessages.length <= maxContextMessages
          ? allSessionMessages
          : allSessionMessages.slice(allSessionMessages.length - maxContextMessages);
      const sessionMessageIds = new Set<number>(sessionMessages.map((item) => item.messageId));
      let recentMessages = Array.from(ccb.messageNodes.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .filter((item) => !sessionMessageIds.has(item.messageId))
        .slice(0, RECENT_CHAT_MESSAGES_COUNT)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((item) => item.message);
      if (anchorReplyTarget) {
        const replyMessage = anchorReplyTarget.message;
        if (anchorReplyTarget.sessionId === session.sessionId) {
          sessionMessages = includePriorityMessage(
            sessionMessages,
            replyMessage,
            maxContextMessages,
          );
        } else {
          recentMessages = includePriorityMessage(
            recentMessages,
            replyMessage,
            RECENT_CHAT_MESSAGES_COUNT,
          );
        }
      }
      return buildContextAnchorSnapshot(ccb, node, recentMessages, sessionMessages);
    },
    getSessionIdForMessage: ({ chatId, messageId }) => {
      const ccb = chatControlBlocks.get(chatId);
      if (!ccb) return null;
      const node = ccb.messageNodes.get(messageId);
      return node?.sessionId ?? null;
    },
    debugPrintSessionControlBlocks: ({
      chatId,
      includeVectors = false,
      log = console.log,
    } = {}) => {
      const targetChatIds =
        typeof chatId === "number"
          ? [chatId]
          : Array.from(chatControlBlocks.keys()).sort((a, b) => a - b);

      if (targetChatIds.length === 0) {
        log("[context/debug] no chat control blocks.");
        return;
      }

      for (const targetChatId of targetChatIds) {
        const ccb = chatControlBlocks.get(targetChatId);
        if (!ccb) {
          log(`[context/debug] chat ${targetChatId} not found.`);
          continue;
        }

        const sessions = Array.from(ccb.sessionControlBlocks.values()).sort(
          (a, b) => b.lastActiveTime - a.lastActiveTime
        );
        log(
          `[context/debug] chat=${targetChatId} sessions=${sessions.length} messages=${ccb.messageNodes.size}`
        );
        for (const session of sessions) {
          const summary = {
            sessionId: session.sessionId,
            topicSummary: session.topicSummary,
            lastSummarizedMessageCount: session.lastSummarizedMessageCount,
            status: session.status,
            lastActiveTime: session.lastActiveTime,
            messageCount: session.messageIds.size,
            rootMessageCount: session.rootMessageIds.size,
            messageIds: Array.from(session.messageIds).sort((a, b) => a - b),
            rootMessageIds: Array.from(session.rootMessageIds).sort((a, b) => a - b),
            centerVectorDim: session.centerVector.length,
            recentVectorDim: session.recentVector?.length ?? 0,
            centerVector: includeVectors ? session.centerVector : undefined,
            recentVector: includeVectors ? session.recentVector : undefined,
          };
          log("[context/debug] session", summary);
        }
      }
    },
  };
}

function getOrCreateChatControlBlock(
  chatControlBlocks: Map<number, ChatControlBlock>,
  chatId: number
): ChatControlBlock {
  const existing = chatControlBlocks.get(chatId);
  if (existing) {
    return existing;
  }
  const next: ChatControlBlock = {
    chatId,
    sessionControlBlocks: new Map<string, SessionControlBlock>(),
    messageNodes: new Map<number, MessageNode>(),
    usernameHandleToUserId: new Map<string, { userId: string; expiresAt: number }>(),
    participantsById: new Map<string, ParticipantState>(),
    displayNameToActorIds: new Map<string, Set<string>>(),
    displayNameConflictSignatures: new Map<string, string>(),
    identityEvents: [],
    lastMessageNodeId: null,
    nextSessionSeq: 1,
  };
  chatControlBlocks.set(chatId, next);
  return next;
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function createEmptyContextAnchorSnapshot(): ContextAnchorSnapshot {
  return {
    recentMessages: [],
    sessionMessages: [],
    participants: [],
    identityEvents: [],
    resolvedTargets: [],
  };
}

function resolveKnownParticipantActor(
  ccb: ChatControlBlock,
  actorId: string | null | undefined,
): ActorRef | null {
  if (!isKnownActorId(actorId)) {
    return null;
  }
  const stableActorId = actorId.trim();
  const known = ccb.participantsById.get(stableActorId);
  if (known) {
    return { ...known.actor };
  }
  return createActorRef({
    id: stableActorId,
    entityType: inferSenderEntityTypeFromId(stableActorId),
  });
}

function materializeMessageActors(
  ccb: ChatControlBlock,
  message: TelegramMessage,
  now: number,
): TelegramMessage {
  const fallbackReplyToSender = resolveKnownParticipantActor(ccb, message.metadata.replyToUserId);
  return hydrateMessageActors(message, {
    fallbackReplyToSender,
    resolveHandleToActorId: (handle) => resolveUserIdByUsernameHandle(ccb, handle, now),
  });
}

function recordIdentityEvent(ccb: ChatControlBlock, event: ContextIdentityEvent): void {
  ccb.identityEvents.push(event);
  if (ccb.identityEvents.length > IDENTITY_EVENT_HISTORY_LIMIT) {
    ccb.identityEvents.splice(0, ccb.identityEvents.length - IDENTITY_EVENT_HISTORY_LIMIT);
  }
}

function pushHistoryValue(history: string[], value: string | null, limit: number): string[] {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return history;
  }
  const next = [...history.filter((item) => item !== normalized), normalized];
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function appendRecentMessageId(messageIds: number[], messageId: number): number[] {
  const next = [...messageIds.filter((item) => item !== messageId), messageId];
  if (next.length <= PARTICIPANT_RECENT_MESSAGE_LIMIT) {
    return next;
  }
  return next.slice(next.length - PARTICIPANT_RECENT_MESSAGE_LIMIT);
}

function normalizeDisplayNameKey(value: string | null | undefined): string | null {
  const normalized = normalizeDisplayName(value);
  return normalized ? normalized.toLowerCase() : null;
}

function syncDisplayNameConflictState(
  ccb: ChatControlBlock,
  displayNameKey: string | null,
  timestamp: number,
): void {
  if (!displayNameKey) {
    return;
  }
  const actorIds = Array.from(ccb.displayNameToActorIds.get(displayNameKey) ?? []).sort();
  const hasConflict = actorIds.length >= 2;
  for (const actorId of actorIds) {
    const participant = ccb.participantsById.get(actorId);
    if (participant) {
      participant.hasDisplayNameConflict = hasConflict;
    }
  }
  if (!hasConflict) {
    ccb.displayNameConflictSignatures.delete(displayNameKey);
    return;
  }
  const signature = actorIds.join(",");
  if (ccb.displayNameConflictSignatures.get(displayNameKey) === signature) {
    return;
  }
  ccb.displayNameConflictSignatures.set(displayNameKey, signature);
  const displayName =
    ccb.participantsById.get(actorIds[0] ?? "")?.actor.displayName ??
    displayNameKey;
  recordIdentityEvent(ccb, {
    type: "display_name_conflict",
    displayName,
    actorIds,
    timestamp,
  });
}

function moveParticipantDisplayNameIndex(
  ccb: ChatControlBlock,
  actorId: string,
  previousDisplayName: string | null,
  nextDisplayName: string | null,
  timestamp: number,
): void {
  const previousKey = normalizeDisplayNameKey(previousDisplayName);
  const nextKey = normalizeDisplayNameKey(nextDisplayName);
  if (previousKey && previousKey !== nextKey) {
    const previousBucket = ccb.displayNameToActorIds.get(previousKey);
    if (previousBucket) {
      previousBucket.delete(actorId);
      if (previousBucket.size === 0) {
        ccb.displayNameToActorIds.delete(previousKey);
      }
    }
    syncDisplayNameConflictState(ccb, previousKey, timestamp);
  }
  if (nextKey) {
    let nextBucket = ccb.displayNameToActorIds.get(nextKey);
    if (!nextBucket) {
      nextBucket = new Set<string>();
      ccb.displayNameToActorIds.set(nextKey, nextBucket);
    }
    nextBucket.add(actorId);
    syncDisplayNameConflictState(ccb, nextKey, timestamp);
  }
  const participant = ccb.participantsById.get(actorId);
  if (participant) {
    const activeKey = normalizeDisplayNameKey(participant.actor.displayName);
    participant.hasDisplayNameConflict = activeKey
      ? (ccb.displayNameToActorIds.get(activeKey)?.size ?? 0) >= 2
      : false;
  }
}

function upsertParticipantState(
  ccb: ChatControlBlock,
  message: TelegramMessage,
  options: { incrementMessageCount: boolean },
): void {
  const sender = buildSenderActorRef(message);
  if (!sender || !isKnownActorId(sender.id)) {
    return;
  }
  const existing = ccb.participantsById.get(sender.id);
  const previousDisplayName = existing?.actor.displayName ?? null;
  const previousUsernameHandle = existing?.actor.usernameHandle ?? null;
  const nextActor = mergeActorRef(existing?.actor, sender) ?? sender;

  if (!existing) {
    const participant: ParticipantState = {
      actor: nextActor,
      firstSeenAt: message.timestamp,
      lastSeenAt: message.timestamp,
      messageCount: options.incrementMessageCount ? 1 : 0,
      recentMessageIds: options.incrementMessageCount ? [message.messageId] : [],
      displayNameHistory: pushHistoryValue([], nextActor.displayName, PARTICIPANT_HISTORY_LIMIT),
      usernameHistory: pushHistoryValue([], nextActor.usernameHandle ?? nextActor.username, PARTICIPANT_HISTORY_LIMIT),
      hasDisplayNameConflict: false,
    };
    ccb.participantsById.set(sender.id, participant);
  } else {
    existing.actor = nextActor;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, message.timestamp);
    if (options.incrementMessageCount) {
      existing.messageCount += 1;
      existing.recentMessageIds = appendRecentMessageId(existing.recentMessageIds, message.messageId);
    }
    existing.displayNameHistory = pushHistoryValue(
      existing.displayNameHistory,
      nextActor.displayName,
      PARTICIPANT_HISTORY_LIMIT,
    );
    existing.usernameHistory = pushHistoryValue(
      existing.usernameHistory,
      nextActor.usernameHandle ?? nextActor.username,
      PARTICIPANT_HISTORY_LIMIT,
    );
  }

  const participant = ccb.participantsById.get(sender.id);
  if (!participant) {
    return;
  }

  if (
    existing &&
    (
      previousDisplayName !== participant.actor.displayName ||
      previousUsernameHandle !== participant.actor.usernameHandle
    )
  ) {
    recordIdentityEvent(ccb, {
      type: "name_change",
      actorId: sender.id,
      oldDisplayName: previousDisplayName,
      newDisplayName: participant.actor.displayName,
      oldUsernameHandle: previousUsernameHandle,
      newUsernameHandle: participant.actor.usernameHandle,
      timestamp: message.timestamp,
    });
  }

  moveParticipantDisplayNameIndex(
    ccb,
    sender.id,
    previousDisplayName,
    participant.actor.displayName,
    message.timestamp,
  );
}

function collectActorIdsFromMessage(message: TelegramMessage, actorIds: Set<string>): void {
  const sender = buildSenderActorRef(message);
  if (sender && isKnownActorId(sender.id)) {
    actorIds.add(sender.id);
  }
  const replyToSender = buildReplyActorRef(message);
  if (replyToSender && isKnownActorId(replyToSender.id)) {
    actorIds.add(replyToSender.id);
  }
  for (const mentionedActor of buildMentionActorRefs(message)) {
    if (isKnownActorId(mentionedActor.id)) {
      actorIds.add(mentionedActor.id);
    }
  }
}

function buildContextAnchorSnapshot(
  ccb: ChatControlBlock,
  node: MessageNode,
  recentMessages: TelegramMessage[],
  sessionMessages: TelegramMessage[],
): ContextAnchorSnapshot {
  const relevantMessages = [node.message, ...recentMessages, ...sessionMessages];
  const relevantActorIds = new Set<string>();
  for (const message of relevantMessages) {
    collectActorIdsFromMessage(message, relevantActorIds);
  }
  const resolvedTargets = collectResolvedTargetsForContext(ccb, node.message, node.timestamp);
  for (const target of resolvedTargets) {
    if (isKnownActorId(target.actorId)) {
      relevantActorIds.add(target.actorId.trim());
    }
  }
  const participants = Array.from(relevantActorIds)
    .map((actorId) => ccb.participantsById.get(actorId) ?? null)
    .filter((participant): participant is ParticipantState => Boolean(participant))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, CONTEXT_PARTICIPANT_LIMIT)
    .map((participant) => ({
      ...participant,
      actor: { ...participant.actor },
      recentMessageIds: participant.recentMessageIds.slice(),
      displayNameHistory: participant.displayNameHistory.slice(),
      usernameHistory: participant.usernameHistory.slice(),
    }));
  const participantIds = new Set(participants.map((participant) => participant.actor.id));
  const identityEvents = ccb.identityEvents
    .filter((event) => {
      if (event.type === "name_change") {
        return participantIds.has(event.actorId);
      }
      return event.actorIds.some((actorId) => participantIds.has(actorId));
    })
    .slice(-CONTEXT_IDENTITY_EVENT_LIMIT);
  return {
    recentMessages,
    sessionMessages,
    participants,
    identityEvents,
    resolvedTargets,
  };
}

function pruneExpiredUsernameAliases(ccb: ChatControlBlock, now: number): void {
  for (const [handle, binding] of ccb.usernameHandleToUserId.entries()) {
    if (binding.expiresAt > now) {
      continue;
    }
    ccb.usernameHandleToUserId.delete(handle);
  }
}

function refreshUsernameAlias(ccb: ChatControlBlock, message: TelegramMessage, now: number): void {
  pruneExpiredUsernameAliases(ccb, now);
  const handle = normalizeUsernameHandle(message.metadata.usernameHandle);
  if (!handle) {
    return;
  }
  ccb.usernameHandleToUserId.set(handle, {
    userId: message.userId,
    expiresAt: now + USERNAME_ALIAS_TTL_MS,
  });
}

function resolveUserIdByUsernameHandle(
  ccb: ChatControlBlock,
  handle: string,
  now: number,
): string | null {
  pruneExpiredUsernameAliases(ccb, now);
  const normalized = normalizeUsernameHandle(handle);
  if (!normalized) {
    return null;
  }
  const binding = ccb.usernameHandleToUserId.get(normalized);
  if (!binding) {
    return null;
  }
  if (binding.expiresAt <= now) {
    ccb.usernameHandleToUserId.delete(normalized);
    return null;
  }
  return binding.userId;
}

function collectExplicitResolvedTargets(
  ccb: ChatControlBlock,
  message: TelegramMessage,
  now: number,
): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  const seen = new Set<string>();
  const push = (target: ResolvedTarget) => {
    const key = `${target.via}:${target.actorId ?? target.usernameHandle ?? target.displayName ?? "unknown"}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(target);
  };

  const replyToSender = mergeActorRef(
    buildReplyActorRef(message),
    resolveKnownParticipantActor(ccb, message.metadata.replyToUserId),
  );
  if (replyToSender) {
    push({
      actorId: isKnownActorId(replyToSender.id) ? replyToSender.id : null,
      entityType: replyToSender.entityType,
      displayName: replyToSender.displayName,
      usernameHandle: replyToSender.usernameHandle,
      via: "reply",
    });
  }

  for (const mentionUserId of message.metadata.mentionUserIds ?? []) {
    const actor = mergeActorRef(
      resolveKnownParticipantActor(ccb, mentionUserId),
      createActorRef({
        id: mentionUserId,
        entityType: inferSenderEntityTypeFromId(mentionUserId),
      }),
    );
    if (!actor) {
      continue;
    }
    push({
      actorId: actor.id,
      entityType: actor.entityType,
      displayName: actor.displayName,
      usernameHandle: actor.usernameHandle,
      via: "mention_user",
    });
  }

  for (const mentionHandle of message.metadata.mentions ?? []) {
    const normalizedHandle = normalizeUsernameHandle(mentionHandle);
    if (!normalizedHandle) {
      continue;
    }
    const actorId = resolveUserIdByUsernameHandle(ccb, normalizedHandle, now);
    const actor = mergeActorRef(
      resolveKnownParticipantActor(ccb, actorId),
      createActorRef({
        id: actorId ?? "unknown",
        entityType: inferSenderEntityTypeFromId(actorId),
        usernameHandle: normalizedHandle,
      }),
    );
    if (!actor) {
      continue;
    }
    push({
      actorId: isKnownActorId(actor.id) ? actor.id : null,
      entityType: actor.entityType,
      displayName: actor.displayName,
      usernameHandle: actor.usernameHandle ?? normalizedHandle,
      via: "mention_handle",
    });
  }
  return out;
}

function collectKnownTargetActorIds(targets: ResolvedTarget[]): string[] {
  return targets
    .map((target) => target.actorId)
    .filter((actorId): actorId is string => isKnownActorId(actorId));
}

function collectResolvedTargetsForContext(
  ccb: ChatControlBlock,
  message: TelegramMessage,
  now: number,
): ResolvedTarget[] {
  const explicitTargets = collectExplicitResolvedTargets(ccb, message, now);
  if (explicitTargets.length > 0) {
    return explicitTargets;
  }
  const inferred = inferTargetActorIdFromPronoun(ccb, message, now);
  if (!inferred) {
    return [];
  }
  const actor = resolveKnownParticipantActor(ccb, inferred);
  return [{
    actorId: inferred,
    entityType: actor?.entityType ?? inferSenderEntityTypeFromId(inferred),
    displayName: actor?.displayName ?? null,
    usernameHandle: actor?.usernameHandle ?? null,
    via: "pronoun",
  }];
}

function hasPronounReference(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /(^|[^\w])(he|she|him|her|this person|that person|that guy|that girl)([^\w]|$)/i.test(normalized) ||
    /(他|她|这个人|那个人)/.test(text)
  );
}

function inferTargetActorIdFromPronoun(
  ccb: ChatControlBlock,
  message: TelegramMessage,
  now: number,
): string | null {
  if (!hasPronounReference(message.context)) {
    return null;
  }
  const candidates = Array.from(ccb.messageNodes.values())
    .filter((node) => node.messageId !== message.messageId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, PRONOUN_REFERENCE_WINDOW_MESSAGES);
  for (const node of candidates) {
    const explicitTargets = collectKnownTargetActorIds(
      collectExplicitResolvedTargets(ccb, node.message, now),
    );
    if (explicitTargets.length > 0) {
      return explicitTargets[explicitTargets.length - 1] ?? null;
    }
  }
  return null;
}

function resolveRecallTargetActorIds(
  ccb: ChatControlBlock,
  message: TelegramMessage,
  now: number,
  explicitTargets = collectKnownTargetActorIds(
    collectExplicitResolvedTargets(ccb, message, now),
  ),
): { targetActorIds: string[]; reason: "explicit" | "pronoun" | "self" } {
  if (explicitTargets.length > 0) {
    return {
      targetActorIds: explicitTargets,
      reason: "explicit",
    };
  }

  const inferred = inferTargetActorIdFromPronoun(ccb, message, now);
  if (inferred) {
    return {
      targetActorIds: [inferred],
      reason: "pronoun",
    };
  }

  return {
    targetActorIds: [message.userId],
    reason: "self",
  };
}

function shouldAllowGroupWideSemanticRecall(
  message: TelegramMessage,
  recallReason: "explicit" | "pronoun" | "self",
  explicitTargetActorIds: string[],
): boolean {
  if (message.metadata.replyToMessageId !== null) {
    return false;
  }
  if (explicitTargetActorIds.length > 0) {
    return false;
  }
  if (recallReason !== "self") {
    return false;
  }
  return message.context.trim().length >= GROUP_RECALL_MIN_TEXT_LENGTH;
}

function filterSearchResultsByScore(results: SearchResult[], minScore: number): SearchResult[] {
  return results
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, RECALL_RESULT_LIMIT);
}

function buildEmbeddingTextWithGhostContext(
  ccb: ChatControlBlock,
  message: TelegramMessage
): string {
  const currentText = message.context;
  if (message.metadata.replyToMessageId) {
    return currentText;
  }

  const lastNode =
    typeof ccb.lastMessageNodeId === "number"
      ? ccb.messageNodes.get(ccb.lastMessageNodeId) ?? null
      : null;
  if (!lastNode) {
    return currentText;
  }
  if (lastNode.message.userId !== message.userId) {
    return currentText;
  }

  // const delta = message.timestamp - lastNode.timestamp;
  // if (delta < 0 || delta >= GHOST_CONTEXT_WINDOW_MS) {
  //   return currentText;
  // }
  if (lastNode.message.context.length >= MEDIUM_MESSAGE_LENGTH && currentText.length >= MEDIUM_MESSAGE_LENGTH) {
    return currentText;
  }

  return `${lastNode.message.context}\n${currentText}`;
}

function updateLastMessageNodeId(ccb: ChatControlBlock, candidate: MessageNode): void {
  const previous =
    typeof ccb.lastMessageNodeId === "number"
      ? ccb.messageNodes.get(ccb.lastMessageNodeId) ?? null
      : null;
  if (!previous || candidate.timestamp >= previous.timestamp) {
    ccb.lastMessageNodeId = candidate.messageId;
  }
}

function includePriorityMessage(
  messages: TelegramMessage[],
  priority: TelegramMessage,
  maxCount: number,
): TelegramMessage[] {
  if (messages.some((item) => item.messageId === priority.messageId)) {
    return messages;
  }
  const sorted = [...messages, priority].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a.messageId - b.messageId;
  });
  if (sorted.length <= maxCount) {
    return sorted;
  }

  const rest = sorted.filter((item) => item.messageId !== priority.messageId);
  const keepCount = Math.max(0, maxCount - 1);
  const keptTail = rest.slice(Math.max(0, rest.length - keepCount));
  return [...keptTail, priority].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a.messageId - b.messageId;
  });
}

async function archiveSession(
  ccb: ChatControlBlock,
  session: SessionControlBlock,
  archiverService: { runBackgroundArchive: (session: {
    sessionId: string;
    chatId: number;
    centerVector: number[];
    topicSummary: string;
    messages: Array<{ message: TelegramMessage; vector: number[] }>;
  }) => Promise<void> }
): Promise<void> {
  const sortedMessages = Array.from(session.messageIds)
    .map((id) => ccb.messageNodes.get(id) ?? null)
    .filter((node): node is MessageNode => Boolean(node))
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((node) => ({
      message: node.message,
      vector: node.vector.slice(),
    }));

  await archiverService.runBackgroundArchive({
    sessionId: session.sessionId,
    chatId: ccb.chatId,
    centerVector: session.centerVector,
    topicSummary: session.topicSummary,
    messages: sortedMessages,
  });
}

function downgradeSessionStatus(session: SessionControlBlock): void {
  if (session.status === "L1_ACTIVE") {
    session.status = "L2_BACKGROUND";
  } else if (session.status === "L2_BACKGROUND") {
    session.status = "L3_ARCHIVED";

  }
}

async function downgradeExpiredSessions(
  ccb: ChatControlBlock,
  now: number,
  expireAfterMs: number,
  archiverService: { runBackgroundArchive: (session: {
    sessionId: string;
    chatId: number;
    centerVector: number[];
    topicSummary: string;
    messages: Array<{ message: TelegramMessage; vector: number[] }>;
  }) => Promise<void> }
): Promise<void> {
  for (const session of ccb.sessionControlBlocks.values()) {
    if (now - session.lastActiveTime > expireAfterMs) {
      downgradeSessionStatus(session);
      if (session.status === "L3_ARCHIVED") {
        if (!isRecoveredSessionId(session.sessionId)) {
          await archiveSession(ccb, session, archiverService);
        }
        ccb.sessionControlBlocks.delete(session.sessionId);
        for (const messageId of session.messageIds) {
          ccb.messageNodes.delete(messageId);
          // TODO：需要把 archivedMessage 的 id 和 sessionId 关联起来，以便 reply 召回。
        }
      }
    }
  }
}

async function embedMessage(embedder: DenseEmbedder, text: string): Promise<number[]> {
  const vector = await embedder.embedDense(text.trim() || "(empty)");
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Embedding provider returned an empty vector.");
  }
  return vector;
}

function pickBestSession(
  ccb: ChatControlBlock,
  vector: number[],
  now: number,
  alphaTime: number,
  lambda: number,
  isMediumMessage: boolean,
  isShortMessage: boolean,
  similarityThreshold: number,
  shortMessageThreshold: number
): { session: SessionControlBlock | null; score: number } {
  let winner: { session: SessionControlBlock; score: number } | null = null;
  for (const session of ccb.sessionControlBlocks.values()) {
    if (session.status === "L3_ARCHIVED") {
      continue;
    }
    const score = scoreMessageToSession(vector, session, now, alphaTime, lambda);
    console.log(session.sessionId, score);
    if (!winner || score > winner.score) {
      winner = { session, score };
    }
  }
  if (winner && winner.score >= similarityThreshold) {
    return winner;
  }
  
  if(isMediumMessage) {
    const recentSessions = Array.from(ccb.sessionControlBlocks.values())
      .sort((a, b) => b.lastActiveTime - a.lastActiveTime)
      .slice(0, RECENT_SESSIONS_COUNT);

    let shortWinner: { session: SessionControlBlock; score: number } | null = null;
    for (const session of recentSessions) {
      if (session.status === "L3_ARCHIVED") {
        continue;
      }
      const score = scoreMessageToSession(vector, session, now, alphaTime, lambda);
      // console.log("short", session.sessionId, score);
      if (!shortWinner || score > shortWinner.score) {
        shortWinner = { session, score };
      }
    }

    if (shortWinner && shortWinner.score > shortMessageThreshold) {
      return shortWinner;
    }
  }

  if(isShortMessage) {
    const recentSessions = Array.from(ccb.sessionControlBlocks.values())
      .sort((a, b) => b.lastActiveTime - a.lastActiveTime);
    return { session: recentSessions[0], score: 0 };
  }
  return {session: null, score: winner?.score ?? 0};
}

async function tryAssignSessionByDecider(input: {
  targetSession: SessionControlBlock | null;
  ccb: ChatControlBlock;
  message: TelegramMessage;
  localModel: LocalModel | undefined;
  cloudModel: CloudModel | undefined;
  sessionDecider: (input: {
    message: TelegramMessage;
    sessions: SessionSummary[];
    localModel?: LocalModel;
    cloudModel?: CloudModel;
  }) => Promise<SessionDeciderResult>;
}): Promise<SessionControlBlock | null> {
  const { targetSession, ccb, message, localModel, cloudModel, sessionDecider } = input;
  if (targetSession || (!localModel && !cloudModel) || ccb.sessionControlBlocks.size === 0) {
    return targetSession;
  }

  const sessions: SessionSummary[] = Array.from(ccb.sessionControlBlocks.values()).filter((s) => s.status !== "L3_ARCHIVED").map((s) => ({
    sessionId: s.sessionId,
    topicSummary: s.topicSummary,
  }));
  const decision = await sessionDecider({
    message,
    sessions,
    localModel,
    cloudModel,
  });
  if (decision.action === "assign" && ccb.sessionControlBlocks.has(decision.sessionId)) {
    return ccb.sessionControlBlocks.get(decision.sessionId)!;
  }
  return targetSession;
}
function scoreMessage(
  vector1: number[],
  vector2: number[] | null | undefined,
  now: number,
  lastActiveTime: number,
  gammaTime: number,
  lambda: number
): number | null {
  if(!vector2) {
    return null;
  }
  const cosineScore = cosine(vector1, vector2);
  const deltaT = Math.max(0, (now - lastActiveTime) / 3600000);
  const timeWeight = Math.exp(-lambda * deltaT);
  const timeScore = Math.pow(timeWeight, gammaTime);
  return timeScore * cosineScore;
}

function scoreMessageToSession(
  vector: number[],
  session: SessionControlBlock,
  now: number,
  gammaTime: number,
  lambda: number
): number {
  // const cosineScore = cosine(vector, session.centerVector);
  // const deltaT = Math.max(0, (now - session.lastActiveTime) / 3600000);
  // // const timeScore = alphaTime * Math.exp(-lambda * deltaT);
  // // return cosineScore + timeScore;
  // const timeWeight = Math.exp(-lambda * deltaT);
  // const timeScore = Math.pow(timeWeight, gammaTime);
  // return timeScore * cosineScore;
  const centerScore =
    scoreMessage(vector, session.centerVector, now, session.lastActiveTime, gammaTime, lambda) ?? 0.999;
  const recentScore =
    scoreMessage(vector, session.recentVector, now, session.lastActiveTime, gammaTime, lambda) ?? 0;
  return Math.max(centerScore, recentScore);
  // return Math.max(scoreMessage(vector, session.centerVector, now, session.lastActiveTime, gammaTime, lambda), scoreMessage(vector, session.centerVector, now, session.lastActiveTime, gammaTime, lambda));
}

function cosine(vecA: number[], vecB: number[]): number {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dot / (normA * normB);
}

function createSession(
  ccb: ChatControlBlock,
  node: MessageNode,
  now: number,
  isShortMessage: boolean
): SessionControlBlock {
  const sessionId = `${ccb.chatId}:${ccb.nextSessionSeq++}`;
  const session: SessionControlBlock = {
    sessionId,
    topicSummary: buildTopicSummary(node.message.context),
    lastSummarizedMessageCount: 1,
    centerVector: node.vector.slice(),
    recentVector: isShortMessage ? null : node.vector.slice(),
    status: "L2_BACKGROUND",
    lastActiveTime: now,
    messageIds: new Set<number>(),
    rootMessageIds: new Set<number>(),
  };
  ccb.sessionControlBlocks.set(sessionId, session);
  return session;
}

function createSessionFromSearchResult(searchResult: SearchResult, now: number): SessionControlBlock {
  const inferredCenter =
    searchResult.centerVector.length > 0
      ? searchResult.centerVector.slice()
      : searchResult.messages.find((message) => message.vector.length > 0)?.vector.slice() ?? [];
  const sessionId =
    searchResult.sessionId.trim().length > 0
      ? searchResult.sessionId
      : buildRecoveredSessionId(searchResult, now);
  return {
    sessionId,
    topicSummary: searchResult.abstractSummary || "(recalled)",
    lastSummarizedMessageCount: 0,
    centerVector: inferredCenter.slice(),
    recentVector: inferredCenter.length > 0 ? inferredCenter.slice() : null,
    messageIds: new Set<number>(),
    rootMessageIds: new Set(),
    status: "L1_ACTIVE",
    lastActiveTime: now,
  };
}

function buildRecoveredSessionId(searchResult: SearchResult, now: number): string {
  const firstMessage = searchResult.messages[0];
  const chatId = firstMessage?.chatId ?? "unknown";
  const messageId = firstMessage?.messageId ?? String(Math.trunc(now));
  return `recalled:${chatId}:${messageId}`;
}

function isRecoveredSessionId(sessionId: string): boolean {
  return sessionId.startsWith("recalled:");
}

function recallSession(ccb: ChatControlBlock, searchResult: SearchResult, now: number): SessionControlBlock | null {
  const session = createSessionFromSearchResult(searchResult, now);
  const recalledNodes: MessageNode[] = [];
  for (const storedMessage of searchResult.messages) {
    const recalledMessage = toTelegramMessage(storedMessage);
    if (!recalledMessage) {
      continue;
    }
    const materializedMessage = materializeMessageActors(ccb, recalledMessage, now);
    const fallbackVector = storedMessage.vector.length > 0 ? storedMessage.vector.slice() : session.centerVector.slice();
    const recalledNode: MessageNode = {
      message: materializedMessage,
      messageId: materializedMessage.messageId,
      timestamp: materializedMessage.timestamp,
      replyToId: materializedMessage.metadata.replyToMessageId,
      childrenIds: [],
      sessionId: session.sessionId,
      vector: fallbackVector,
    };
    recalledNodes.push(recalledNode);
  }

  if (recalledNodes.length === 0 && session.centerVector.length === 0) {
    return null;
  }

  ccb.sessionControlBlocks.set(session.sessionId, session);
  recalledNodes.sort((a, b) => a.timestamp - b.timestamp);
  for (const recalledNode of recalledNodes) {
    ccb.messageNodes.set(recalledNode.messageId, recalledNode);
    session.messageIds.add(recalledNode.messageId);
    refreshUsernameAlias(ccb, recalledNode.message, recalledNode.timestamp);
    upsertParticipantState(ccb, recalledNode.message, { incrementMessageCount: false });
  }
  for (const recalledNode of recalledNodes) {
    const parentId = recalledNode.replyToId;
    if (parentId !== null && session.messageIds.has(parentId)) {
      const parent = ccb.messageNodes.get(parentId);
      if (parent) {
        parent.childrenIds.push(recalledNode.messageId);
        continue;
      }
    }
    recalledNode.replyToId = null;
    session.rootMessageIds.add(recalledNode.messageId);
  }
  for (const recalledNode of recalledNodes) {
    updateLastMessageNodeId(ccb, recalledNode);
  }
  return session;
}

function toTelegramMessage(stored: SearchResult["messages"][number]): TelegramMessage | null {
  const messageId = Number(stored.messageId);
  const chatId = Number(stored.chatId);
  const timestamp = normalizeStoredTimestamp(stored.timestamp);
  if (!Number.isFinite(messageId) || !Number.isFinite(chatId) || !Number.isFinite(timestamp)) {
    return null;
  }
  const rawConversationType = stored.conversationType;
  const conversationType =
    rawConversationType === "private" ||
    rawConversationType === "group" ||
    rawConversationType === "supergroup" ||
    rawConversationType === "channel"
      ? rawConversationType
      : "supergroup";
  const metadata = stored.metadata;
  const metadataExt = metadata as
    | (typeof metadata & {
        mentionUserIds?: string[];
        usernameHandle?: string;
        replyToUsername?: string;
        replyToPreviewText?: string;
        senderEntityType?: TelegramMessage["metadata"]["senderEntityType"];
      })
    | undefined;
  const replyToMessageIdRaw = metadata?.replyToMessageId ?? "";
  const replyToMessageIdNum = Number(replyToMessageIdRaw);
  const replyToMessageId = Number.isFinite(replyToMessageIdNum) ? replyToMessageIdNum : null;
  return {
    userId: stored.userId,
    messageId,
    chatId,
    conversationType,
    context: stored.context,
    timestamp,
    metadata: {
      isBot: metadata?.isBot ?? false,
      isSelf: false,
      username: metadata?.username ? metadata.username : null,
      replyToMessageId,
      replyToUserId: metadata?.replyToUserId ? metadata.replyToUserId : null,
      replyToUsername: metadataExt?.replyToUsername ? metadataExt.replyToUsername : null,
      replyToPreviewText: metadataExt?.replyToPreviewText ? metadataExt.replyToPreviewText : null,
      isReplyToMe: metadata?.isReplyToMe ?? false,
      isMentionMe: metadata?.isMentionMe ?? false,
      mentions: metadata?.mentions ?? [],
      mentionUserIds: metadataExt?.mentionUserIds ?? [],
      usernameHandle: metadataExt?.usernameHandle ?? null,
      senderEntityType: metadataExt?.senderEntityType ?? "unknown",
    },
  };
}

function normalizeStoredTimestamp(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Date.now();
  }
  const truncated = Math.trunc(numeric);
  const abs = Math.abs(truncated);

  if (abs >= 1e17) {
    // nanoseconds
    return Math.trunc(truncated / 1e6);
  }
  if (abs >= 1e14) {
    // microseconds
    return Math.trunc(truncated / 1e3);
  }
  if (abs >= 1e11) {
    // milliseconds
    return truncated;
  }
  if (abs >= 1e9) {
    // seconds
    return Math.trunc(truncated * 1000);
  }
  return Date.now();
}

function setSessionActive(ccb: ChatControlBlock, activeSessionId: string): void {
  // for (const session of ccb.sessionControlBlocks.values()) {
  //   session.status = session.sessionId === activeSessionId ? "L1_ACTIVE" : "L2_BACKGROUND";
  // }
  const session = ccb.sessionControlBlocks.get(activeSessionId);
  if (session) {
    session.status = "L1_ACTIVE";
  }
}

function updateCenterVector(previous: number[], current: number[], alphaCenter: number): number[] {
    if (previous.length === 0 || previous.length !== current.length) {
      return current.slice();
    }
    return previous.map((p, i) => alphaCenter * current[i] + (1 - alphaCenter) * p);
}

function buildTopicSummary(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "(empty)";
  }
  const maxLength = 80;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getSessionMessagesSorted(
  ccb: ChatControlBlock,
  session: SessionControlBlock
): MessageNode[] {
  return [...session.messageIds]
    .map((id) => ccb.messageNodes.get(id))
    .filter((item): item is MessageNode => Boolean(item))
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function updateTopicSummary(
  ccb: ChatControlBlock,
  session: SessionControlBlock,
  cloudModel: CloudModel | undefined
): Promise<void> {
  const nodes = getSessionMessagesSorted(ccb, session);
  const N = nodes.length;
  const lastSummarized = session.lastSummarizedMessageCount ?? 0;
  if (N <= TOPIC_SUMMARY_CONCAT_MAX) {
    session.topicSummary = nodes
      .map((n) => n.message.context.trim())
      .filter(Boolean)
      .join("\n") || "(empty)";
    session.lastSummarizedMessageCount = N;
    return;
  }
  const newCount = N - lastSummarized;
  if (newCount < TOPIC_SUMMARY_CLOUD_BATCH) {
    return;
  }
  if (!cloudModel) {
    session.lastSummarizedMessageCount = N;
    return;
  }
  const from = lastSummarized;
  const batch = nodes.slice(from, from + TOPIC_SUMMARY_CLOUD_BATCH);
  const newTexts = batch.map((n) => n.message.context.trim()).filter(Boolean);
  const prompt = `You are a session summarizer. Given the previous topic summary and new messages, output a single short topic summary (one line, under 80 chars).

Previous topic summary:
${session.topicSummary}

New messages:
${newTexts.join("\n")}

Output only the new topic summary, no explanation:`;
  const { text } = await cloudModel.complete({
    messages: [{ role: "user", content: prompt }],
  });
  session.topicSummary = text.trim().slice(0, 80) || session.topicSummary;
  session.lastSummarizedMessageCount = from + TOPIC_SUMMARY_CLOUD_BATCH;
}
// function evictOldestSessionIfNeeded(ccb: ChatControlBlock, maxSessionsPerChat: number): void {
//   if (ccb.sessionControlBlocks.size < maxSessionsPerChat) {
//     return;
//   }
//   let oldest: SessionControlBlock | null = null;
//   for (const session of ccb.sessionControlBlocks.values()) {
//     if (!oldest || session.lastActiveTime < oldest.lastActiveTime) {
//       oldest = session;
//     }
//   }
//   if (!oldest) {
//     return;
//   }
//   ccb.sessionControlBlocks.delete(oldest.sessionId);
//   for (const messageId of oldest.messageIds) {
//     ccb.messageNodes.delete(messageId);
//   }
// }
