import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientRuntime, RuntimeReplyStreamEvent } from "./clientRuntime";
import { createMessageGateway } from "./messageGateway";
import type { GatewayTriggerPolicy } from "./types";
import type {
  TelegramAdapter,
  TelegramOutgoingMediaItem,
  TelegramSendMediaBatchResult,
} from "../telegram/types";
import type { TelegramMessage } from "../types/message";

const ENV_KEYS = [
  "ENCLAVE_SEND_MESSAGE_MODE",
  "ENCLAVE_LONG_WAIT_HINT_MS",
  "STATE_DAEMON_GROUP_REPLY_SOFT_LIMIT",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

interface ReplyCall {
  chatId: number;
  text: string;
  messageId?: number;
  parseMode?: "markdown" | "html" | "plain";
}

interface MediaCall {
  chatId: number;
  items: TelegramOutgoingMediaItem[];
  caption?: string;
  replyToMessageId?: number;
}

type MessageHandler = (message: TelegramMessage) => void | Promise<void>;

let originalEnv: Record<EnvKey, string | undefined>;

beforeEach(() => {
  originalEnv = ENV_KEYS.reduce(
    (acc, key) => {
      acc[key] = process.env[key];
      return acc;
    },
    {} as Record<EnvKey, string | undefined>,
  );
  process.env.ENCLAVE_SEND_MESSAGE_MODE = "strict";
  process.env.ENCLAVE_LONG_WAIT_HINT_MS = "0";
  process.env.STATE_DAEMON_GROUP_REPLY_SOFT_LIMIT = "20";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("createMessageGateway visible output reply target", () => {
  test("defaults only the first send_message event to the trigger message", async () => {
    const telegram = createFakeTelegramAdapter();
    const runtime = createFakeRuntime([
      { type: "send_message", text: "first" },
      { type: "send_message", text: "second" },
    ]);
    const gateway = createMessageGateway({
      telegram: telegram.adapter,
      runtime,
      policies: [alwaysTriggerPolicy],
    });

    telegram.emit(createTriggerMessage());
    await waitFor(() => telegram.replies.length === 2);
    gateway.stop();

    expect(telegram.replies.map((reply) => reply.messageId)).toEqual([42, undefined]);
  });

  test("defaults only the first split group text chunk to the trigger message", async () => {
    const telegram = createFakeTelegramAdapter();
    const runtime = createFakeRuntime([
      {
        type: "send_message",
        text: "这是第一段内容。这里是第二段内容。还有第三段内容。",
      },
    ]);
    const gateway = createMessageGateway({
      telegram: telegram.adapter,
      runtime,
      policies: [alwaysTriggerPolicy],
    });

    telegram.emit(createTriggerMessage());
    await waitFor(() => telegram.replies.length > 1);
    gateway.stop();

    expect(telegram.replies[0]?.messageId).toBe(42);
    expect(telegram.replies.slice(1).map((reply) => reply.messageId)).toEqual(
      Array.from({ length: telegram.replies.length - 1 }, () => undefined),
    );
  });

  test("respects explicit reply_to while subsequent implicit messages send normally", async () => {
    const telegram = createFakeTelegramAdapter();
    const runtime = createFakeRuntime([
      { type: "send_message", text: "explicit", replyToMessageId: 777 },
      { type: "send_message", text: "normal" },
    ]);
    const gateway = createMessageGateway({
      telegram: telegram.adapter,
      runtime,
      policies: [alwaysTriggerPolicy],
    });

    telegram.emit(createTriggerMessage());
    await waitFor(() => telegram.replies.length === 2);
    gateway.stop();

    expect(telegram.replies.map((reply) => reply.messageId)).toEqual([777, undefined]);
  });

  test("splits an implicit first media batch so only the first item replies", async () => {
    const telegram = createFakeTelegramAdapter();
    const runtime = createFakeRuntime([
      {
        type: "send_file",
        caption: "caption",
        items: [
          { type: "image", source: "https://example.invalid/1.png" },
          { type: "image", source: "https://example.invalid/2.png" },
        ],
      },
    ]);
    const gateway = createMessageGateway({
      telegram: telegram.adapter,
      runtime,
      policies: [alwaysTriggerPolicy],
    });

    telegram.emit(createTriggerMessage());
    await waitFor(() => telegram.media.length === 2);
    gateway.stop();

    expect(telegram.media.map((call) => call.replyToMessageId)).toEqual([42, undefined]);
    expect(telegram.media.map((call) => call.items.length)).toEqual([1, 1]);
    expect(telegram.media.map((call) => call.caption)).toEqual(["caption", undefined]);
  });
});

const alwaysTriggerPolicy: GatewayTriggerPolicy = {
  name: "AlwaysTrigger",
  priority: 1,
  decide: (message) => ({
    shouldTrigger: true,
    reason: "mention_me",
    prompt: message.context,
  }),
};

function createFakeRuntime(events: RuntimeReplyStreamEvent[]): ClientRuntime {
  return {
    recordMessage: async () => {},
    probeShouldReply: async () => ({
      shouldReply: false,
      reason: "not_used",
      raw: "",
    }),
    streamReply: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createFakeTelegramAdapter(): {
  adapter: TelegramAdapter;
  replies: ReplyCall[];
  media: MediaCall[];
  emit: (message: TelegramMessage) => void;
} {
  const messageHandlers = new Set<MessageHandler>();
  const editedMessageHandlers = new Set<MessageHandler>();
  const replies: ReplyCall[] = [];
  const media: MediaCall[] = [];

  return {
    replies,
    media,
    emit: (message) => {
      for (const handler of messageHandlers) {
        void Promise.resolve(handler(message));
      }
    },
    adapter: {
      start: async () => {},
      stop: () => {},
      getMessages: () => [],
      onMessage: (handler) => {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      onEditedMessage: (handler) => {
        editedMessageHandlers.add(handler);
        return () => editedMessageHandlers.delete(handler);
      },
      reply: async (chatId, text, messageId, options) => {
        replies.push({
          chatId,
          text,
          messageId,
          parseMode: options?.parseMode,
        });
      },
      sendMediaBatch: async (chatId, items, options): Promise<TelegramSendMediaBatchResult> => {
        media.push({
          chatId,
          items,
          caption: options?.caption,
          replyToMessageId: options?.replyToMessageId,
        });
        return { sentCount: items.length, failures: [] };
      },
      sendTyping: async () => {},
      startStream: async () => 1,
      setStreamStatus: async () => {},
      appendStream: () => {},
      endStream: async () => "",
    },
  };
}

function createTriggerMessage(): TelegramMessage {
  return {
    userId: "1001",
    messageId: 42,
    chatId: 7,
    conversationType: "group",
    context: "@bot hello",
    timestamp: Date.now(),
    metadata: {
      isBot: false,
      isSelf: false,
      username: "alice",
      replyToMessageId: null,
      replyToUserId: null,
      replyToUsername: null,
      replyToUsernameHandle: null,
      replyToPreviewText: null,
      isReplyToMe: false,
      isMentionMe: true,
      mentions: ["bot"],
      mentionUserIds: [],
      usernameHandle: "@alice",
      senderEntityType: "user",
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 1000;
  while (Date.now() < timeoutAt) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
