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
  test("renders participant and identity sections into context XML", () => {
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

    expect(result[1]?.content).toContain("<participants>");
    expect(result[1]?.content).toContain("<identity_events>");
    expect(result[1]?.content).toContain("<resolved_targets>");
    expect(result[1]?.content).toContain('sender_entity_type="user"');
    expect(result[1]?.content).toContain('via="reply"');
  });
});
