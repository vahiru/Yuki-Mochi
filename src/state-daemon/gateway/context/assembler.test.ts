import { describe, expect, test } from "bun:test";
import { createContextAssembler } from "./assembler";
import type { ParticipantState, ResolvedTarget } from "./core/types";
import type { TelegramMessage } from "../../types/message";

function createMessage(overrides?: Partial<TelegramMessage["metadata"]>): TelegramMessage {
  return {
    userId: "1001",
    messageId: 1,
    chatId: 100,
    conversationType: "group",
    context: "hello",
    timestamp: 1710000000000,
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
      mentionUserIds: [],
      ...overrides,
    },
  };
}

describe("createContextAssembler", () => {
  test("renders compact target_query XML for a unique resolved target with evidence", () => {
    const assembler = createContextAssembler();
    const triggerMessage = createMessage({
      replyToMessageId: 9,
      replyToUserId: "2002",
      replyToUsername: "Bob",
    });
    triggerMessage.context = "replying now";

    const replyMessage = createMessage({
      username: "Bob",
      usernameHandle: "@bob",
      senderEntityType: "user",
    });
    replyMessage.userId = "2002";
    replyMessage.messageId = 9;
    replyMessage.context = "previous message";

    const participants: ParticipantState[] = [
      {
        actor: {
          id: "1001",
          entityType: "user",
          displayName: "Alice",
          username: "alice",
          usernameHandle: "@alice",
          isBot: false,
        },
        firstSeenAt: 1710000000000,
        lastSeenAt: 1710000000000,
        messageCount: 1,
        recentMessageIds: [1],
        displayNameHistory: ["Alice"],
        usernameHistory: ["@alice"],
        hasDisplayNameConflict: false,
      },
    ];
    const resolvedTargets: ResolvedTarget[] = [
      {
        actorId: "2002",
        entityType: "user",
        displayName: "Bob",
        usernameHandle: "@bob",
        via: "reply",
      },
    ];

    const result = assembler.build({
      triggerMessage,
      contextMessages: [replyMessage],
      recentMessages: [],
      targetMessages: [replyMessage],
      participants,
      identityEvents: [
        {
          type: "name_change",
          actorId: "1001",
          oldDisplayName: "A",
          newDisplayName: "Alice",
          oldUsernameHandle: "@a",
          newUsernameHandle: "@alice",
          timestamp: 1710000000000,
        },
      ],
      resolvedTargets,
      systemPrompt: "system",
    });

    expect(result[1]?.content).toContain("<target_query>");
    expect(result[1]?.content).toContain("<evidence>");
    expect(result[1]?.content).toContain("<query");
    expect(result[1]?.content).not.toContain("<participants>");
    expect(result[1]?.content).not.toContain("<identity_events>");
    expect(result[1]?.content).not.toContain("<target_actor_messages>");
    expect(result[1]?.content).not.toContain("<resolved_targets>");
    expect(result[1]?.content).toContain('sender_entity_type="user"');
    expect(result[1]?.content).toContain('via="reply"');
  });

  test("falls back to the full context XML when target evidence is absent", () => {
    const assembler = createContextAssembler();
    const triggerMessage = createMessage();
    triggerMessage.context = "Mizuki likes what";

    const participants: ParticipantState[] = [
      {
        actor: {
          id: "1001",
          entityType: "user",
          displayName: "Alice",
          username: "alice",
          usernameHandle: "@alice",
          isBot: false,
        },
        firstSeenAt: 1710000000000,
        lastSeenAt: 1710000000000,
        messageCount: 1,
        recentMessageIds: [1],
        displayNameHistory: ["Alice"],
        usernameHistory: ["@alice"],
        hasDisplayNameConflict: false,
      },
    ];
    const resolvedTargets: ResolvedTarget[] = [
      {
        actorId: "2002",
        entityType: "user",
        displayName: "Mizuki",
        usernameHandle: null,
        via: "display_name",
      },
    ];

    const result = assembler.build({
      triggerMessage,
      contextMessages: [],
      recentMessages: [],
      targetMessages: [],
      participants,
      identityEvents: [],
      resolvedTargets,
      systemPrompt: "system",
    });

    expect(result[1]?.content).toContain("<context>");
    expect(result[1]?.content).toContain("<participants>");
    expect(result[1]?.content).toContain("<identity_events>");
    expect(result[1]?.content).toContain("<target_actor_messages>");
    expect(result[1]?.content).toContain("<resolved_targets>");
    expect(result[1]?.content).not.toContain("<target_query>");
  });

  test("renders unresolved_target_query for an unresolved display-name typo without leaking mixed history", () => {
    const assembler = createContextAssembler();
    const triggerMessage = createMessage();
    triggerMessage.context = "Mazuki喜欢什么花呢";

    const mizukiMessage = createMessage({
      username: "Mizuki",
      usernameHandle: null,
      senderEntityType: "user",
    });
    mizukiMessage.userId = "2002";
    mizukiMessage.messageId = 2;
    mizukiMessage.context = "我喜欢玫瑰花";

    const huaiMaoMessage = createMessage({
      username: "坏猫",
      usernameHandle: null,
      senderEntityType: "user",
    });
    huaiMaoMessage.userId = "3003";
    huaiMaoMessage.messageId = 3;
    huaiMaoMessage.context = "我喜欢百合";

    const participants: ParticipantState[] = [
      {
        actor: {
          id: "2002",
          entityType: "user",
          displayName: "Mizuki",
          username: null,
          usernameHandle: null,
          isBot: false,
        },
        firstSeenAt: 1710000000000,
        lastSeenAt: 1710000000000,
        messageCount: 1,
        recentMessageIds: [2],
        displayNameHistory: ["Mizuki"],
        usernameHistory: [],
        hasDisplayNameConflict: false,
      },
      {
        actor: {
          id: "3003",
          entityType: "user",
          displayName: "坏猫",
          username: null,
          usernameHandle: null,
          isBot: false,
        },
        firstSeenAt: 1710000001000,
        lastSeenAt: 1710000001000,
        messageCount: 1,
        recentMessageIds: [3],
        displayNameHistory: ["坏猫"],
        usernameHistory: [],
        hasDisplayNameConflict: false,
      },
    ];

    const result = assembler.build({
      triggerMessage,
      contextMessages: [mizukiMessage, huaiMaoMessage],
      recentMessages: [mizukiMessage, huaiMaoMessage],
      targetMessages: [],
      participants,
      identityEvents: [],
      resolvedTargets: [],
      systemPrompt: "system",
    });

    expect(result[1]?.content).toContain("<unresolved_target_query>");
    expect(result[1]?.content).toContain('match_type="approx_display_name"');
    expect(result[1]?.content).toContain('raw_text="mazuki"');
    expect(result[1]?.content).toContain('closest_display_name="Mizuki"');
    expect(result[1]?.content).toContain("<query");
    expect(result[1]?.content).not.toContain("<context>");
    expect(result[1]?.content).not.toContain("<recent_messages>");
    expect(result[1]?.content).not.toContain("<related_history>");
    expect(result[1]?.content).not.toContain("我喜欢玫瑰花");
    expect(result[1]?.content).not.toContain("我喜欢百合");
  });
});
