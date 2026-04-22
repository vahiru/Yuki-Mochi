// export type MessageNodeInput = {
//   metadata: { isBot: boolean; username: string | null };
//   timestamp: number;
//   context: string;
// };
import type { TelegramMessage } from "../types/message";

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
  const attrs = buildReplyPreviewAttributes({
    senderId: getSenderId(message),
    speaker: getSpeaker(message),
    senderHandle: getSenderHandle(message),
  });
  return `<reply_to_preview ${attrs}>${escapeXml(message.context)}</reply_to_preview>`;
}

export function formatFallbackReplyToPreviewNode(message: TelegramMessage): string {
  const fallbackSpeaker =
    (message.metadata.replyToUsername ?? "").trim() ||
    (message.metadata.replyToUserId ?? "").trim() ||
    "unknown";
  const fallbackText =
    (message.metadata.replyToPreviewText ?? "").trim() ||
    `unavailable (reply_to=${message.metadata.replyToMessageId})`;
  const fallbackHandle = normalizeHandle(message.metadata.replyToUsername);
  const attrs = buildReplyPreviewAttributes({
    senderId: (message.metadata.replyToUserId ?? "").trim() || "unknown",
    speaker: fallbackSpeaker,
    senderHandle: fallbackHandle,
  });
  return `<reply_to_preview ${attrs}>${escapeXml(fallbackText)}</reply_to_preview>`;
}

export function getSpeaker(message: {
  metadata: { username: string | null; usernameHandle?: string | null };
  userId?: string;
}): string {
  const username = (message.metadata.username ?? "").trim();
  if (username) {
    return username;
  }
  const handle = (message.metadata.usernameHandle ?? "").trim();
  if (handle) {
    return handle;
  }
  const userId = (message.userId ?? "").trim();
  if (userId && userId !== "unknown") {
    return userId;
  }
  return "unknown";
}

export function getSenderId(message: { userId?: string | null }): string {
  const userId = (message.userId ?? "").trim();
  return userId || "unknown";
}

export function getSenderHandle(message: {
  metadata?: { usernameHandle?: string | null } | null;
}): string | null {
  return normalizeHandle(message.metadata?.usernameHandle);
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
  const parts = [
    `id="${message.messageId}"`,
    `sender_id="${escapeXml(getSenderId(message))}"`,
    `speaker="${escapeXml(getSpeaker(message))}"`,
  ];
  const senderHandle = getSenderHandle(message);
  if (senderHandle) {
    parts.push(`sender_handle="${escapeXml(senderHandle)}"`);
  }
  parts.push(`timestamp="${formatTimestampUtc8(message.timestamp)}"`);
  if (message.metadata.replyToMessageId) {
    parts.push(`reply_to="${message.metadata.replyToMessageId}"`);
  }
  return parts.join(" ");
}

function buildReplyPreviewAttributes(input: {
  senderId: string;
  speaker: string;
  senderHandle?: string | null;
}): string {
  const parts = [
    `sender_id="${escapeXml(input.senderId || "unknown")}"`,
    `speaker="${escapeXml(input.speaker || "unknown")}"`,
  ];
  if (input.senderHandle) {
    parts.push(`sender_handle="${escapeXml(input.senderHandle)}"`);
  }
  return parts.join(" ");
}

function normalizeHandle(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("@") ? trimmed : null;
}
