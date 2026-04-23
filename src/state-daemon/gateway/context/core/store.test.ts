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
  usernameHandle?: string | null;
  isBot?: boolean;
  isSelf?: boolean;
  mentionMe?: boolean;
  replyToMessageId?: number | null;
  replyToUserId?: string | null;
  replyToUsername?: string | null;
  replyToUsernameHandle?: string | null;
  isReplyToMe?: boolean;
}): TelegramMessage {
  return {
    userId: input.userId,
    messageId: input.messageId,
    chatId: 100,
    conversationType: "group",
    context: input.context,
    timestamp: input.timestamp,
    metadata: {
      isBot: input.isBot ?? false,
      isSelf: input.isSelf ?? false,
      username: input.username,
      usernameHandle: input.usernameHandle ?? null,
      senderEntityType: "user",
      replyToMessageId: input.replyToMessageId ?? null,
      replyToUserId: input.replyToUserId ?? null,
      replyToUsername: input.replyToUsername ?? null,
      replyToUsernameHandle: input.replyToUsernameHandle ?? null,
      replyToPreviewText: null,
      isReplyToMe: input.isReplyToMe ?? false,
      isMentionMe: input.mentionMe ?? false,
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

  test("ignores leading bot vocative when resolving display-name targets", async () => {
    const store = createInMemoryContextStore({
      embedder,
      contextSearcher,
      similarityThreshold: 0.99,
      shortMessageThreshold: 0.99,
    });

    await store.ingestMessage({
      message: createMessage({
        userId: "user:m",
        messageId: 1,
        context: "收集数据很烦人",
        timestamp: 1710000000000,
        username: "Mizuki",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "bot",
        messageId: 2,
        context: "确实呢，反复填表很消磨热情。",
        timestamp: 1710000001000,
        username: "Yuki Mochi",
        usernameHandle: "@yuki_mochi",
        isBot: true,
        isSelf: true,
      }),
    });
    const trigger = createMessage({
      userId: "user:t",
      messageId: 3,
      context: "@Yuki_Mochi, Mizuki 讨厌什么",
      timestamp: 1710000002000,
      username: "Tester",
      mentionMe: true,
    });
    trigger.metadata.mentions = ["@Yuki_Mochi"];
    await store.ingestMessage({ message: trigger });

    const snapshot = store.getContextByAnchor({ chatId: 100, messageId: 3 });
    expect(snapshot.resolvedTargets).toEqual([
      expect.objectContaining({
        actorId: "user:m",
        displayName: "Mizuki",
        via: "display_name",
      }),
    ]);
    expect(snapshot.targetMessages).toEqual([
      expect.objectContaining({
        userId: "user:m",
        context: "收集数据很烦人",
      }),
    ]);
  });

  test("resolves no-username display names in group facts without mixing another speaker", async () => {
    const store = createInMemoryContextStore({
      embedder,
      contextSearcher,
      similarityThreshold: 0.99,
      shortMessageThreshold: 0.99,
    });

    await store.ingestMessage({
      message: createMessage({
        userId: "user:m",
        messageId: 1,
        context: "我w5",
        timestamp: 1710000000000,
        username: "Mizuki",
        usernameHandle: null,
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:b",
        messageId: 2,
        context: "我w6",
        timestamp: 1710000001000,
        username: "坏猫",
        usernameHandle: null,
      }),
    });
    const trigger = createMessage({
      userId: "user:t",
      messageId: 3,
      context: "@Yuki_Mochi, Mizuki w几",
      timestamp: 1710000002000,
      username: "Tester",
      usernameHandle: null,
      mentionMe: true,
    });
    trigger.metadata.mentions = ["@Yuki_Mochi"];
    await store.ingestMessage({ message: trigger });

    const snapshot = store.getContextByAnchor({ chatId: 100, messageId: 3 });
    expect(snapshot.resolvedTargets).toEqual([
      expect.objectContaining({
        actorId: "user:m",
        displayName: "Mizuki",
        via: "display_name",
      }),
    ]);
    expect(snapshot.targetMessages).toEqual([
      expect.objectContaining({
        userId: "user:m",
        context: "我w5",
      }),
    ]);
    expect(snapshot.targetMessages).not.toContainEqual(
      expect.objectContaining({
        userId: "user:b",
      }),
    );
  });

  test("prefers a unique display-name target over reply-to-bot when the text names someone", async () => {
    const store = createInMemoryContextStore({
      embedder,
      contextSearcher,
      similarityThreshold: 0.99,
      shortMessageThreshold: 0.99,
    });

    await store.ingestMessage({
      message: createMessage({
        userId: "user:m",
        messageId: 1,
        context: "我喜欢玩音击",
        timestamp: 1710000000000,
        username: "Mizuki",
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "bot",
        messageId: 2,
        context: "vahiru喜欢玫瑰花和山茶花哦~",
        timestamp: 1710000001000,
        username: "Yuki Mochi",
        usernameHandle: "@Yuki_Mochi",
        isBot: true,
        isSelf: true,
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:m",
        messageId: 3,
        context: "Mizuki喜欢玩什么",
        timestamp: 1710000002000,
        username: "Mizuki",
        replyToMessageId: 2,
        replyToUserId: "bot",
        replyToUsername: "Yuki Mochi",
        replyToUsernameHandle: "@Yuki_Mochi",
        isReplyToMe: true,
      }),
    });

    const snapshot = store.getContextByAnchor({ chatId: 100, messageId: 3 });
    expect(snapshot.resolvedTargets).toEqual([
      expect.objectContaining({
        actorId: "user:m",
        displayName: "Mizuki",
        via: "display_name",
      }),
    ]);
    expect(snapshot.targetMessages).toEqual([
      expect.objectContaining({
        userId: "user:m",
        context: "我喜欢玩音击",
      }),
    ]);
    expect(snapshot.targetMessages).not.toContainEqual(
      expect.objectContaining({
        userId: "bot",
      }),
    );
  });

  test("keeps target actor recall isolated when another user states a conflicting preference", async () => {
    const store = createInMemoryContextStore({
      embedder,
      contextSearcher,
      similarityThreshold: 0.99,
      shortMessageThreshold: 0.99,
    });

    await store.ingestMessage({
      message: createMessage({
        userId: "user:m",
        messageId: 1,
        context: "我喜欢玩音击",
        timestamp: 1710000000000,
        username: "Mizuki",
        usernameHandle: null,
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:b",
        messageId: 2,
        context: "我喜欢玩中二节奏",
        timestamp: 1710000001000,
        username: "坏猫",
        usernameHandle: null,
      }),
    });
    await store.ingestMessage({
      message: createMessage({
        userId: "user:t",
        messageId: 3,
        context: "Mizuki喜欢玩什么",
        timestamp: 1710000002000,
        username: "Tester",
        usernameHandle: null,
      }),
    });

    const snapshot = store.getContextByAnchor({ chatId: 100, messageId: 3 });
    expect(snapshot.resolvedTargets).toEqual([
      expect.objectContaining({
        actorId: "user:m",
        displayName: "Mizuki",
        via: "display_name",
      }),
    ]);
    expect(snapshot.targetMessages).toEqual([
      expect.objectContaining({
        userId: "user:m",
        context: "我喜欢玩音击",
      }),
    ]);
    expect(snapshot.sessionMessages).toEqual([
      expect.objectContaining({
        userId: "user:m",
        context: "我喜欢玩音击",
      }),
    ]);
  });
});
