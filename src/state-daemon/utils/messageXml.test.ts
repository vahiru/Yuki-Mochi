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
      replyToMessageId: null,
      replyToUserId: null,
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
});
