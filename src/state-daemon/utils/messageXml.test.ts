import { describe, expect, test } from "bun:test";
import type { TelegramMessage } from "../types/message";
import { formatNormalMessageNode } from "./messageXml";

function createMessage(overrides?: Partial<TelegramMessage["metadata"]>): TelegramMessage {
  return {
    userId: "1001",
    messageId: 1,
    chatId: 100,
    conversationType: "group",
    context: "hello",
    timestamp: Date.now(),
    metadata: {
      isBot: false,
      username: "alice",
      usernameHandle: "@alice",
      senderEntityType: "user",
      replyToMessageId: null,
      replyToUserId: null,
      replyToUsername: null,
      replyToPreviewText: null,
      isReplyToMe: false,
      isMentionMe: false,
      mentions: [],
      ...overrides,
    },
  };
}

describe("formatNormalMessageNode", () => {
  test("renders agent_message only when isSelf=true", () => {
    const selfMessage = createMessage({ isSelf: true });
    const rendered = formatNormalMessageNode(selfMessage);
    expect(rendered.startsWith("<agent_message")).toBe(true);
  });

  test("does not treat other bot messages as self", () => {
    const externalBotMessage = createMessage({ isBot: true, isSelf: false });
    const rendered = formatNormalMessageNode(externalBotMessage);
    expect(rendered.startsWith("<message")).toBe(true);
    expect(rendered.includes("<agent_message")).toBe(false);
  });

  test("defaults to normal message when isSelf is absent", () => {
    const message = createMessage();
    const rendered = formatNormalMessageNode(message);
    expect(rendered.startsWith("<message")).toBe(true);
    expect(rendered.includes("<agent_message")).toBe(false);
  });

  test("renders sender identity attributes", () => {
    const rendered = formatNormalMessageNode(createMessage());
    expect(rendered).toContain('sender_id="1001"');
    expect(rendered).toContain('speaker="alice"');
    expect(rendered).toContain('sender_handle="@alice"');
  });

  test("renders reply preview sender identity from resolved target", () => {
    const replyTarget = createMessage({
      username: "bob",
      usernameHandle: "@bob",
      senderEntityType: "user",
    });
    replyTarget.userId = "2002";
    replyTarget.messageId = 9;
    replyTarget.context = "reply text";

    const message = createMessage({
      replyToMessageId: 9,
      replyToUserId: "2002",
    });
    const rendered = formatNormalMessageNode(message, replyTarget);
    expect(rendered).toContain('<reply_to_preview sender_id="2002" speaker="bob" sender_handle="@bob">reply text</reply_to_preview>');
  });

  test("renders fallback reply preview sender identity", () => {
    const message = createMessage({
      replyToMessageId: 9,
      replyToUserId: "channel:777",
      replyToUsername: "@announcements",
      replyToPreviewText: "latest update",
    });
    const rendered = formatNormalMessageNode(message);
    expect(rendered).toContain('<reply_to_preview sender_id="channel:777" speaker="@announcements" sender_handle="@announcements">latest update</reply_to_preview>');
  });
});
