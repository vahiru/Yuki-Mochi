import type { ContextIdentityEvent, ParticipantState, ResolvedTarget } from "../gateway/context/core/types";
import type { ActorRef, TelegramMessage } from "../types/message";
import {
  buildReplyActorRef,
  buildSenderActorRef,
  createActorRef,
  inferSenderEntityTypeFromId,
  normalizeUsernameHandle,
} from "./actor";

export function formatNormalMessageNode(message: TelegramMessage, replyToMessage?: TelegramMessage): string {
  const messageTemplate = buildMessageAttributes(message);
  let replyToPreview = replyToMessage ? formatReplyToPreviewNode(replyToMessage) : "";
  if (message.metadata.replyToMessageId && !replyToMessage) {
    replyToPreview = formatFallbackReplyToPreviewNode(message);
  }
  if (message.metadata.isSelf === true) {
    return `<agent_message ${messageTemplate}>
    ${replyToPreview ? `${replyToPreview}` : ""}
    ${escapeXml(message.context)}
    </agent_message>`;
  }
  return `<message ${messageTemplate}>
  ${replyToPreview ? `${replyToPreview}` : ""}
  ${escapeXml(message.context)}
  </message>`;
}

export function formatReplyToPreviewNode(message: TelegramMessage): string {
  const actor = buildReplyActorRef({
    ...message,
    metadata: {
      ...message.metadata,
      replyToSender: buildSenderActorRef(message) ?? undefined,
      replyToUserId: getSenderId(message),
      replyToUsername: getDisplayName(message),
    },
  }) ?? buildSenderActorRef(message);
  const attrs = buildActorAttributes(actor, {
    speaker: getSpeaker(message),
    senderId: getSenderId(message),
  });
  return `<reply_to_preview ${attrs.join(" ")}>${escapeXml(message.context)}</reply_to_preview>`;
}

export function formatFallbackReplyToPreviewNode(message: TelegramMessage): string {
  const fallbackText =
    (message.metadata.replyToPreviewText ?? "").trim() ||
    `unavailable (reply_to=${message.metadata.replyToMessageId})`;
  const fallbackActor = buildReplyActorRef(message) ?? createActorRef({
    id: (message.metadata.replyToUserId ?? "").trim() || "unknown",
    entityType: inferSenderEntityTypeFromId(message.metadata.replyToUserId),
    displayName: message.metadata.replyToUsername,
    usernameHandle: normalizeUsernameHandle(message.metadata.replyToUsername),
  });
  const attrs = buildActorAttributes(fallbackActor, {
    speaker:
      (message.metadata.replyToUsername ?? "").trim() ||
      (message.metadata.replyToUserId ?? "").trim() ||
      "unknown",
    senderId: (message.metadata.replyToUserId ?? "").trim() || "unknown",
  });
  return `<reply_to_preview ${attrs.join(" ")}>${escapeXml(fallbackText)}</reply_to_preview>`;
}

export function formatParticipantNode(participant: ParticipantState): string {
  const attrs = buildActorAttributes(participant.actor, {
    speaker: participant.actor.displayName ?? participant.actor.usernameHandle ?? participant.actor.id,
    senderId: participant.actor.id,
  });
  attrs.push(`first_seen="${formatTimestampUtc8(participant.firstSeenAt)}"`);
  attrs.push(`last_seen="${formatTimestampUtc8(participant.lastSeenAt)}"`);
  attrs.push(`message_count="${participant.messageCount}"`);
  if (participant.hasDisplayNameConflict) {
    attrs.push('name_conflict="true"');
  }
  if (participant.displayNameHistory.length > 0) {
    attrs.push(`display_name_history="${escapeXml(participant.displayNameHistory.join(" | "))}"`);
  }
  if (participant.usernameHistory.length > 0) {
    attrs.push(`username_history="${escapeXml(participant.usernameHistory.join(" | "))}"`);
  }
  return `<participant ${attrs.join(" ")} />`;
}

export function formatIdentityEventNode(event: ContextIdentityEvent): string {
  if (event.type === "name_change") {
    const parts = [
      'type="name_change"',
      `sender_id="${escapeXml(event.actorId)}"`,
      `timestamp="${formatTimestampUtc8(event.timestamp)}"`,
    ];
    addOptionalAttribute(parts, "old_display_name", event.oldDisplayName);
    addOptionalAttribute(parts, "new_display_name", event.newDisplayName);
    addOptionalAttribute(parts, "old_sender_handle", event.oldUsernameHandle);
    addOptionalAttribute(parts, "new_sender_handle", event.newUsernameHandle);
    return `<identity_event ${parts.join(" ")} />`;
  }
  const parts = [
    'type="display_name_conflict"',
    `display_name="${escapeXml(event.displayName)}"`,
    `actor_ids="${escapeXml(event.actorIds.join(","))}"`,
    `timestamp="${formatTimestampUtc8(event.timestamp)}"`,
  ];
  return `<identity_event ${parts.join(" ")} />`;
}

export function formatResolvedTargetNode(target: ResolvedTarget): string {
  const actor = createActorRef({
    id: target.actorId ?? "unknown",
    entityType: target.entityType,
    displayName: target.displayName,
    usernameHandle: target.usernameHandle,
  });
  const attrs = buildActorAttributes(actor, {
    speaker: target.displayName ?? target.usernameHandle ?? target.actorId ?? "unknown",
    senderId: target.actorId ?? "unknown",
  });
  attrs.push(`via="${escapeXml(target.via)}"`);
  return `<target ${attrs.join(" ")} />`;
}

export function getSpeaker(message: {
  sender?: ActorRef;
  metadata: { username: string | null; usernameHandle?: string | null; senderEntityType?: string | null };
  userId?: string;
}): string {
  const sender = buildSenderActorRef(message as TelegramMessage);
  if (sender?.displayName) {
    return sender.displayName;
  }
  if (sender?.usernameHandle) {
    return sender.usernameHandle;
  }
  const userId = (message.userId ?? "").trim();
  if (userId && userId !== "unknown") {
    return userId;
  }
  return "unknown";
}

export function getDisplayName(message: TelegramMessage): string {
  return buildSenderActorRef(message)?.displayName ?? getSpeaker(message);
}

export function getSenderId(message: { userId?: string | null; sender?: ActorRef | null }): string {
  const senderId = (message.sender?.id ?? message.userId ?? "").trim();
  return senderId || "unknown";
}

export function getSenderEntityType(message: {
  userId?: string | null;
  sender?: ActorRef | null;
  metadata?: { senderEntityType?: string | null } | null;
}): string {
  return (
    message.sender?.entityType ??
    inferSenderEntityTypeFromId(message.userId, (message.metadata?.senderEntityType as ActorRef["entityType"] | undefined) ?? "unknown")
  );
}

export function getSenderHandle(message: {
  sender?: ActorRef | null;
  metadata?: { usernameHandle?: string | null } | null;
}): string | null {
  return normalizeUsernameHandle(message.sender?.usernameHandle ?? message.metadata?.usernameHandle);
}

export function formatTimestampUtc8(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", { timeZone: "Asia/Shanghai" });
}

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildMessageAttributes(message: TelegramMessage): string {
  const attrs = buildActorAttributes(buildSenderActorRef(message), {
    senderId: getSenderId(message),
    speaker: getSpeaker(message),
  });
  attrs.unshift(`id="${message.messageId}"`);
  attrs.push(`timestamp="${formatTimestampUtc8(message.timestamp)}"`);
  if (message.metadata.replyToMessageId) {
    attrs.push(`reply_to="${message.metadata.replyToMessageId}"`);
  }
  return attrs.join(" ");
}

function buildActorAttributes(
  actor: ActorRef | null,
  fallback: { senderId: string; speaker: string },
): string[] {
  const senderId = actor?.id ?? fallback.senderId ?? "unknown";
  const speaker = actor?.displayName ?? fallback.speaker ?? "unknown";
  const parts = [
    `sender_id="${escapeXml(senderId)}"`,
    `sender_entity_type="${escapeXml(actor?.entityType ?? inferSenderEntityTypeFromId(senderId))}"`,
    `speaker="${escapeXml(speaker)}"`,
  ];
  addOptionalAttribute(parts, "display_name", actor?.displayName ?? null);
  addOptionalAttribute(parts, "username", actor?.username ?? null);
  addOptionalAttribute(parts, "sender_handle", actor?.usernameHandle ?? null);
  if (actor?.isBot) {
    parts.push('is_bot="true"');
  }
  return parts;
}

function addOptionalAttribute(parts: string[], name: string, value: string | null | undefined): void {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return;
  }
  parts.push(`${name}="${escapeXml(normalized)}"`);
}
