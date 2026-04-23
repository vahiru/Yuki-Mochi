import {
  escapeXml,
  formatFallbackReplyToPreviewNode,
  formatIdentityEventNode,
  formatNormalMessageNode,
  formatParticipantNode,
  formatReplyToPreviewNode,
  formatResolvedTargetNode,
  formatTimestampUtc8,
  getDisplayName,
  getSenderEntityType,
  getSenderHandle,
  getSenderId,
  getSpeaker,
} from "../../utils/messageXml";
import type { ContextAssembler, ResolvedTarget } from "./core/types";
import type { TelegramMessage } from "../../types/message";
import { isKnownActorId } from "../../utils/actor";

export function createContextAssembler(): ContextAssembler {
  return {
    build: ({ contextMessages, recentMessages, targetMessages, triggerMessage, participants, identityEvents, resolvedTargets, systemPrompt }) => {
      const triggerId = triggerMessage.messageId;
      const normalizedRecent = recentMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const normalizedTargetMessages = targetMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const normalizedContext = contextMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const messageIndex = new Map<number, TelegramMessage>();
      for (const message of normalizedRecent) {
        messageIndex.set(message.messageId, message);
      }
      for (const message of normalizedTargetMessages) {
        messageIndex.set(message.messageId, message);
      }
      for (const message of normalizedContext) {
        messageIndex.set(message.messageId, message);
      }

      const findReplyTarget = (replyToMessageId: number | null): TelegramMessage | undefined => {
        if (replyToMessageId === null) {
          return undefined;
        }
        return messageIndex.get(replyToMessageId);
      };

      const currentReplyPreview = buildReplyPreviewNode(
        triggerMessage,
        findReplyTarget(triggerMessage.metadata.replyToMessageId),
      );
      const currentReplyToAttribute = triggerMessage.metadata.replyToMessageId
        ? ` reply_to="${triggerMessage.metadata.replyToMessageId}"`
        : "";
      const currentSenderHandle = getSenderHandle(triggerMessage);
      const currentSenderHandleAttribute = currentSenderHandle
        ? ` sender_handle="${escapeXml(currentSenderHandle)}"`
        : "";
      const currentDisplayName = getDisplayName(triggerMessage);
      const currentDisplayNameAttribute = currentDisplayName
        ? ` display_name="${escapeXml(currentDisplayName)}"`
        : "";
      const participantsXml = participants.length > 0
        ? participants.map((participant) => `    ${formatParticipantNode(participant)}`).join("\n")
        : "";
      const identityEventsXml = identityEvents.length > 0
        ? identityEvents.map((event) => `    ${formatIdentityEventNode(event)}`).join("\n")
        : "";
      const resolvedTargetsXml = resolvedTargets.length > 0
        ? resolvedTargets.map((target) => `    ${formatResolvedTargetNode(target)}`).join("\n")
        : "";
      const compactTarget = pickCompactResolvedTarget(resolvedTargets, normalizedTargetMessages);
      const xml = compactTarget
        ? `<target_query>
  ${formatResolvedTargetNode(compactTarget)}
  <evidence>
${normalizedTargetMessages.map((message) => formatNormalMessageNode(
  message,
  findReplyTarget(message.metadata.replyToMessageId),
)).join("\n")}
  </evidence>
  <query id="${triggerMessage.messageId}" sender_id="${escapeXml(getSenderId(triggerMessage))}" sender_entity_type="${escapeXml(getSenderEntityType(triggerMessage))}" speaker="${escapeXml(getSpeaker(triggerMessage))}"${currentDisplayNameAttribute}${currentSenderHandleAttribute} timestamp="${formatTimestampUtc8(triggerMessage.timestamp)}"${currentReplyToAttribute}>
    ${currentReplyPreview}
    ${escapeXml(triggerMessage.context)}
  </query>
</target_query>`
        : `<context>
  <participants>
${participantsXml}
  </participants>
  <identity_events>
${identityEventsXml}
  </identity_events>
  <target_actor_messages>
${normalizedTargetMessages.map((message) => formatNormalMessageNode(message,
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </target_actor_messages>
  <recent_messages>
${normalizedRecent.map((message) => formatNormalMessageNode(message,
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </recent_messages>
  <related_history>
${normalizedContext.map((message) => formatNormalMessageNode(message,
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </related_history>
</context>
<current_message id="${triggerMessage.messageId}" sender_id="${escapeXml(getSenderId(triggerMessage))}" sender_entity_type="${escapeXml(getSenderEntityType(triggerMessage))}" speaker="${escapeXml(getSpeaker(triggerMessage))}"${currentDisplayNameAttribute}${currentSenderHandleAttribute} timestamp="${formatTimestampUtc8(triggerMessage.timestamp)}"${currentReplyToAttribute}>
  <resolved_targets>
${resolvedTargetsXml}
  </resolved_targets>
  ${currentReplyPreview}
  ${escapeXml(triggerMessage.context)}
</current_message>`;

      return [
        { role: "system", content: systemPrompt},
        { role: "user", content: xml }
      ];
    },
  };
}

function buildReplyPreviewNode(
  message: TelegramMessage,
  replyToMessage?: TelegramMessage
): string {
  if (replyToMessage) {
    return formatReplyToPreviewNode(replyToMessage);
  }
  if (message.metadata.replyToMessageId) {
    return formatFallbackReplyToPreviewNode(message);
  }
  return "";
}

function pickCompactResolvedTarget(
  resolvedTargets: ResolvedTarget[],
  targetMessages: TelegramMessage[],
) {
  if (targetMessages.length === 0) {
    return null;
  }
  const uniqueKnownActorIds = Array.from(new Set(
    resolvedTargets
      .map((target) => target.actorId)
      .filter((actorId): actorId is string => isKnownActorId(actorId)),
  ));
  if (uniqueKnownActorIds.length !== 1) {
    return null;
  }
  return resolvedTargets.find((target) => target.actorId === uniqueKnownActorIds[0]) ?? null;
}
