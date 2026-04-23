import { describe, expect, test } from "bun:test";
import { createInMemoryContextStore } from "../index";
import type { DenseEmbedder } from "../../../model/embedding";
import type { ContextSearcher } from "../searcher";
import type { TelegramMessage } from "../../../types/message";

const embedder: DenseEmbedder = {
  dimension: 3,
  async embedDense() {
    return [1, 0, 0];
  },
};

const contextSearcher: ContextSearcher = {
  async searchByMessageId() {
    return null;
  },
  async searchSemantic() {
    return [];
  },
};

function createMessage(input: {
  userId: string;
  messageId: number;
  context: string;
  timestamp: number;
  username: string | null;
}): TelegramMessage {
  return {
    userId: input.userId,
    messageId: input.messageId,
    chatId: 100,
    conversationType: "group",
    context: input.context,
    timestamp: input.timestamp,
    metadata: {
      isBot: false,
      isSelf: false,
      username: input.username,
      usernameHandle: null,
      senderEntityType: "user",
      replyToMessageId: null,
      replyToUserId: null,
      replyToUsername: null,
      replyToUsernameHandle: null,
      replyToPreviewText: null,
      isReplyToMe: false,
      isMentionMe: false,
      mentions: [],
      mentionUserIds: [],
    },
  };
}

describe("createInMemoryContextStore display-name targeting", () => {
  test("resolves a unique display name in plain text into resolved_targets", async () => {
    const store = createInMemoryContextStore({
      embedder,
      contextSearcher,
      similarityThreshold: 0.99,
      shortMessageThreshold: 0.99,
    });

    await store.ingestMessage({
      message: createMessage({
        userId: "user:a",
        messageId: 1,
        context: "我喜欢骑车",
        timestamp: 1710000000000,
        username: "Mizuki",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:b",
        messageId: 2,
        context: "我喜欢打舞萌",
        timestamp: 1710000001000,
        username: "坏猫",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:t",
        messageId: 3,
        context: "Mizuki喜欢干什么",
        timestamp: 1710000002000,
        username: "Tester",
      }),
    });

    const snapshot = store.getContextByAnchor({ chatId: 100, messageId: 3 });
    expect(snapshot.resolvedTargets).toEqual([
      expect.objectContaining({
        actorId: "user:a",
        displayName: "Mizuki",
        via: "display_name",
      }),
    ]);
    expect(snapshot.targetMessages).toEqual([
      expect.objectContaining({
        userId: "user:a",
        context: "我喜欢骑车",
      }),
    ]);
    expect(snapshot.sessionMessages).toEqual([
      expect.objectContaining({
        userId: "user:a",
        context: "我喜欢骑车",
      }),
    ]);
  });

  test("does not resolve ambiguous display-name references", async () => {
    const store = createInMemoryContextStore({
      embedder,
      contextSearcher,
      similarityThreshold: 0.99,
      shortMessageThreshold: 0.99,
    });

    await store.ingestMessage({
      message: createMessage({
        userId: "user:a",
        messageId: 1,
        context: "我喜欢骑车",
        timestamp: 1710000000000,
        username: "Mizuki",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:b",
        messageId: 2,
        context: "我喜欢打舞萌",
        timestamp: 1710000001000,
        username: "Mizuki",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:t",
        messageId: 3,
        context: "Mizuki喜欢干什么",
        timestamp: 1710000002000,
        username: "Tester",
      }),
    });

    const snapshot = store.getContextByAnchor({ chatId: 100, messageId: 3 });
    expect(snapshot.resolvedTargets).toEqual([]);
    expect(snapshot.identityEvents).toContainEqual(
      expect.objectContaining({
        type: "display_name_conflict",
        displayName: "Mizuki",
      }),
    );
  });

  test("does not treat stale historical display names as an active ambiguity", async () => {
    const store = createInMemoryContextStore({
      embedder,
      contextSearcher,
      similarityThreshold: 0.99,
      shortMessageThreshold: 0.99,
    });

    await store.ingestMessage({
      message: createMessage({
        userId: "user:stale",
        messageId: 1,
        context: "我之前叫 Mizuki",
        timestamp: 1710000000000,
        username: "Mizuki",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:stale",
        messageId: 2,
        context: "我现在叫 坏猫",
        timestamp: 1710000001000,
        username: "坏猫",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:live",
        messageId: 3,
        context: "我是个小药娘",
        timestamp: 1710000002000,
        username: "Mizuki",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:t",
        messageId: 4,
        context: "Mizuki是什么娘",
        timestamp: 1710000003000,
        username: "Tester",
      }),
    });

    const snapshot = store.getContextByAnchor({ chatId: 100, messageId: 4 });
    expect(snapshot.resolvedTargets).toEqual([
      expect.objectContaining({
        actorId: "user:live",
        displayName: "Mizuki",
        via: "display_name",
      }),
    ]);
  });
});
