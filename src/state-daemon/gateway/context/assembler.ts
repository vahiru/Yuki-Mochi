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
import type { ContextAssembler } from "./core/types";
import type { TelegramMessage } from "../../types/message";

export function createContextAssembler(): ContextAssembler {
  return {
    build: ({ contextMessages, recentMessages, triggerMessage, participants, identityEvents, resolvedTargets, systemPrompt }) => {
      const triggerId = triggerMessage.messageId;
      const normalizedRecent = recentMessages
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

      const xml = `<context>
  <participants>
${participantsXml}
  </participants>
  <identity_events>
${identityEventsXml}
  </identity_events>
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
