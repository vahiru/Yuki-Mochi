import { describe, expect, test } from "bun:test";
import type { TelegramMessage, TelegramSenderEntityType } from "../types/message";
import { createEventNormalizer } from "./eventNormalizer";

function createMessage(input: {
  messageId: number;
  userId?: string;
  context?: string;
  timestamp?: number;
  senderEntityType?: TelegramSenderEntityType;
}): TelegramMessage {
  return {
    userId: input.userId ?? "1001",
    messageId: input.messageId,
    chatId: 1,
    conversationType: "group",
    context: input.context ?? `msg-${input.messageId}`,
    timestamp: input.timestamp ?? input.messageId * 1000,
    metadata: {
      isBot: false,
      isSelf: false,
      username: "alice",
      replyToMessageId: null,
      replyToUserId: null,
      replyToUsername: null,
      replyToPreviewText: null,
      isReplyToMe: false,
      isMentionMe: false,
      mentions: [],
      mentionUserIds: [],
      usernameHandle: "@alice",
      senderEntityType: input.senderEntityType ?? "user",
    },
  };
}

describe("createEventNormalizer", () => {
  test("does not merge unknown senders", () => {
    const upserts: TelegramMessage[] = [];
    const normalizer = createEventNormalizer({
      mergeWindowMs: 60_000,
      onUpsert: (message) => {
        upserts.push(message);
      },
    });

    normalizer.ingestMessage(
      createMessage({ messageId: 1, userId: "unknown", senderEntityType: "unknown", context: "first" }),
    );
    normalizer.ingestMessage(
      createMessage({ messageId: 2, userId: "unknown", senderEntityType: "unknown", context: "second" }),
    );

    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.context).toBe("first");
    expect(upserts[1]?.context).toBe("second");
    normalizer.stop();
  });

  test("does not merge messages when sender entity type differs", () => {
    const upserts: TelegramMessage[] = [];
    const normalizer = createEventNormalizer({
      mergeWindowMs: 60_000,
      onUpsert: (message) => {
        upserts.push(message);
      },
    });

    normalizer.ingestMessage(
      createMessage({ messageId: 1, userId: "1001", senderEntityType: "user", context: "first" }),
    );
    normalizer.ingestMessage(
      createMessage({ messageId: 2, userId: "1001", senderEntityType: "channel", context: "second", timestamp: 1_500 }),
    );
    normalizer.stop();

    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.metadata.senderEntityType).toBe("user");
    expect(upserts[1]?.metadata.senderEntityType).toBe("channel");
    expect(upserts[0]?.context).toBe("first");
    expect(upserts[1]?.context).toBe("second");
  });
});
