import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEnclaveClient, StreamReplyRequest } from "../enclave/protocol";
import type { ContextAssembler, ContextStore } from "./context";
import { createClientRuntime } from "./clientRuntime";
import type { LLMMessage, TelegramMessage } from "../types/message";

const ENV_KEYS = [
  "MEMORY_FILES_ROOT",
  "STATE_DAEMON_PROBE_MODEL_PROVIDER",
  "STATE_DAEMON_PROBE_CLOUD_API_KEY",
  "STATE_DAEMON_PROBE_CLOUD_BASE_URL",
  "STATE_DAEMON_PROBE_CLOUD_MODEL",
] as const;

type CapturedPayload = {
  messages?: Array<{ role?: string; content?: string }>;
};

const originalFetch = globalThis.fetch;
let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let memoryRoot = "";
let capturedPayloads: CapturedPayload[] = [];
let capturedEnclaveRequests: StreamReplyRequest[] = [];

const stubEnclaveClient: AgentEnclaveClient = {
  streamReply: async function* (request) {
    capturedEnclaveRequests.push(request);
    yield { type: "completed" } as const;
  },
};

const stubContextStore: ContextStore = {
  ingestMessage: async () => {},
  getContextByAnchor: () => ({
    recentMessages: [],
    sessionMessages: [],
    targetMessages: [],
    participants: [],
    identityEvents: [],
    resolvedTargets: [],
  }),
  debugPrintSessionControlBlocks: () => {},
};

const stubContextAssembler: ContextAssembler = {
  build: ({ systemPrompt }): LLMMessage[] => [
    { role: "system", content: systemPrompt },
    { role: "user", content: "<context />" },
  ],
};

beforeEach(async () => {
  originalEnv = ENV_KEYS.reduce(
    (acc, key) => {
      acc[key] = process.env[key];
      return acc;
    },
    {} as Record<(typeof ENV_KEYS)[number], string | undefined>,
  );

  memoryRoot = await mkdtemp(join(tmpdir(), "kairos-probe-test-"));
  for (const name of ["Soul.md", "Identity.md", "Tools.md"]) {
    await writeFile(join(memoryRoot, name), `# ${name}\n`, "utf8");
  }

  process.env.MEMORY_FILES_ROOT = memoryRoot;
  process.env.STATE_DAEMON_PROBE_MODEL_PROVIDER = "cloud";
  process.env.STATE_DAEMON_PROBE_CLOUD_API_KEY = "probe-test-key";
  process.env.STATE_DAEMON_PROBE_CLOUD_BASE_URL = "https://probe.example.invalid/v1";
  process.env.STATE_DAEMON_PROBE_CLOUD_MODEL = "probe-test-model";

  capturedPayloads = [];
  capturedEnclaveRequests = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    capturedPayloads.push(body ? (JSON.parse(body) as CapturedPayload) : {});
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"action\":\"silent\",\"reason\":\"not_targeted\"}" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  globalThis.fetch = originalFetch;
  if (memoryRoot) {
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

function createTriggerMessage(chatId: number): TelegramMessage {
  return {
    userId: "1001",
    messageId: 42,
    chatId,
    conversationType: "group",
    context: "What do you think about this plan?",
    timestamp: Date.now(),
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
      usernameHandle: null,
    },
  };
}

async function writeGroupPromptStore(groups: Record<string, string>): Promise<void> {
  const payload = {
    version: 1,
    groups: Object.fromEntries(
      Object.entries(groups).map(([chatId, prompt]) => [
        chatId,
        {
          prompt,
          updatedAt: Date.now(),
        },
      ]),
    ),
  };
  await writeFile(join(memoryRoot, "group-prompts.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getLatestLateBindingPrompt(): string {
  expect(capturedPayloads.length).toBeGreaterThan(0);
  const messages = capturedPayloads.at(-1)?.messages ?? [];
  expect(messages.length).toBeGreaterThan(0);
  return messages.at(-1)?.content ?? "";
}

function getLatestEnclaveLateBindingPrompt(): string {
  expect(capturedEnclaveRequests.length).toBeGreaterThan(0);
  const messages = capturedEnclaveRequests.at(-1)?.messages ?? [];
  expect(messages.length).toBeGreaterThan(0);
  return messages.at(-1)?.content ?? "";
}

describe("probe late-binding group prompt injection", () => {
  test("injects chat-scoped group prompt into probe late-binding prompt", async () => {
    const groupPrompt = "Only respond in this chat when a direct ask is present.";
    await writeGroupPromptStore({
      "100": groupPrompt,
    });

    const runtime = createClientRuntime({
      enclaveClient: stubEnclaveClient,
      contextStore: stubContextStore,
      contextAssembler: stubContextAssembler,
    });

    const decision = await runtime.probeShouldReply({
      triggerMessage: createTriggerMessage(100),
    });

    expect(decision.shouldReply).toBe(false);
    const lateBindingPrompt = getLatestLateBindingPrompt();
    expect(lateBindingPrompt).toContain("Chat-Scoped Probe Memory");
    expect(lateBindingPrompt).toContain(groupPrompt);
    expect(lateBindingPrompt).toContain("deterministic gate/safety constraints win");
  });

  test("does not inject probe group prompt section when chat-scoped prompt is absent", async () => {
    await writeGroupPromptStore({
      "999": "This prompt belongs to another chat id.",
    });

    const runtime = createClientRuntime({
      enclaveClient: stubEnclaveClient,
      contextStore: stubContextStore,
      contextAssembler: stubContextAssembler,
    });

    const decision = await runtime.probeShouldReply({
      triggerMessage: createTriggerMessage(100),
    });

    expect(decision.shouldReply).toBe(false);
    const lateBindingPrompt = getLatestLateBindingPrompt();
    expect(lateBindingPrompt).not.toContain("Chat-Scoped Probe Memory");
    expect(lateBindingPrompt).not.toContain("This prompt belongs to another chat id.");
  });
});

describe("normal late-binding group prompt injection", () => {
  test("injects chat-scoped group prompt into normal late-binding prompt", async () => {
    const groupPrompt = "In this chat, answer with terse technical Chinese by default.";
    await writeGroupPromptStore({
      "100": groupPrompt,
    });

    const runtime = createClientRuntime({
      enclaveClient: stubEnclaveClient,
      contextStore: stubContextStore,
      contextAssembler: stubContextAssembler,
    });

    const events: Array<{ type: string }> = [];
    for await (const event of runtime.streamReply({
      triggerMessage: createTriggerMessage(100),
      prompt: "Keep the answer compact.",
    })) {
      events.push({ type: event.type });
    }

    expect(events.some((event) => event.type === "status_update")).toBe(true);
    const lateBindingPrompt = getLatestEnclaveLateBindingPrompt();
    expect(lateBindingPrompt).toContain("Chat-Scoped Memory For Current Chat");
    expect(lateBindingPrompt).toContain(groupPrompt);
    expect(lateBindingPrompt).toContain("Keep the answer compact.");
  });

  test("does not inject normal late-binding group prompt section when chat-scoped prompt is absent", async () => {
    await writeGroupPromptStore({
      "999": "This prompt belongs to another chat id.",
    });

    const runtime = createClientRuntime({
      enclaveClient: stubEnclaveClient,
      contextStore: stubContextStore,
      contextAssembler: stubContextAssembler,
    });

    for await (const _event of runtime.streamReply({
      triggerMessage: createTriggerMessage(100),
      prompt: "",
    })) {
    }

    const lateBindingPrompt = getLatestEnclaveLateBindingPrompt();
    expect(lateBindingPrompt).not.toContain("Chat-Scoped Memory For Current Chat");
    expect(lateBindingPrompt).not.toContain("This prompt belongs to another chat id.");
  });
});
