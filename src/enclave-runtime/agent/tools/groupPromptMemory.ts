import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const DEFAULT_MEMORY_FILES_ROOT = ".runtime/memory_files";
const GROUP_PROMPT_STORE_FILE = "group-prompts.json";
const MAX_PROMPT_CHARS = 8000;

type GroupPromptAction = "get" | "set" | "add" | "clear";

interface GroupPromptParams {
  action: GroupPromptAction;
  chat_id: string;
  content?: string;
}

interface GroupPromptToolDetails {
  action: GroupPromptAction;
  chatId: string;
  prompt: string;
  existed: boolean;
  updatedAt?: number;
}

interface GroupPromptRecord {
  prompt: string;
  updatedAt: number;
}

interface GroupPromptStoreData {
  version: number;
  groups: Record<string, GroupPromptRecord>;
}

const EMPTY_STORE: GroupPromptStoreData = {
  version: 1,
  groups: {},
};

export interface GroupPromptMemoryStore {
  get: (chatId: string) => Promise<GroupPromptRecord | null>;
  set: (chatId: string, prompt: string) => Promise<GroupPromptRecord>;
  add: (chatId: string, promptChunk: string) => Promise<GroupPromptRecord>;
  clear: (chatId: string) => Promise<boolean>;
  getStorePath: () => string;
}

function normalizeChatId(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("group_prompt_memory.chat_id cannot be empty.");
  }
  return normalized;
}

function normalizePrompt(input: string | undefined): string {
  const normalized = (input ?? "").trim();
  if (!normalized) {
    throw new Error("group_prompt_memory.content cannot be empty when action=set.");
  }
  if (normalized.length > MAX_PROMPT_CHARS) {
    throw new Error(`group_prompt_memory.content too long. Max ${MAX_PROMPT_CHARS} chars.`);
  }
  return normalized;
}

function normalizeForDedup(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function splitPromptBlocks(value: string): string[] {
  return value
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
}

function mergePromptWithDedup(existingPrompt: string, promptChunk: string): string {
  const existingBlocks = splitPromptBlocks(existingPrompt);
  const incomingBlocks = splitPromptBlocks(promptChunk);
  if (incomingBlocks.length === 0) {
    return existingPrompt.trim();
  }

  const dedupSet = new Set(existingBlocks.map((block) => normalizeForDedup(block)));
  const mergedBlocks = [...existingBlocks];
  for (const incomingBlock of incomingBlocks) {
    const dedupKey = normalizeForDedup(incomingBlock);
    if (dedupSet.has(dedupKey)) {
      continue;
    }
    dedupSet.add(dedupKey);
    mergedBlocks.push(incomingBlock);
  }
  return mergedBlocks.join("\n\n").trim();
}

function resolveMemoryFilesRoot(): string {
  const fromEnv = process.env.MEMORY_FILES_ROOT?.trim();
  return fromEnv || DEFAULT_MEMORY_FILES_ROOT;
}

function createStoreDataFromUnknown(raw: unknown): GroupPromptStoreData {
  if (!raw || typeof raw !== "object") {
    return { ...EMPTY_STORE, groups: {} };
  }
  const source = raw as {
    version?: unknown;
    groups?: unknown;
  };
  const version =
    typeof source.version === "number" && Number.isFinite(source.version)
      ? Math.max(1, Math.trunc(source.version))
      : 1;
  const groups: Record<string, GroupPromptRecord> = {};
  if (source.groups && typeof source.groups === "object" && !Array.isArray(source.groups)) {
    for (const [chatId, entry] of Object.entries(source.groups as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const parsed = entry as { prompt?: unknown; updatedAt?: unknown };
      const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
      const updatedAt =
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? Math.trunc(parsed.updatedAt)
          : 0;
      if (!prompt || updatedAt <= 0) {
        continue;
      }
      groups[chatId] = { prompt, updatedAt };
    }
  }
  return { version, groups };
}

async function readStore(path: string): Promise<GroupPromptStoreData> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return createStoreDataFromUnknown(parsed);
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError?.code !== "ENOENT") {
      console.warn("[group_prompt_memory] failed to parse store, fallback to empty:", error);
    }
    return { ...EMPTY_STORE, groups: {} };
  }
}

async function writeStoreAtomic(path: string, data: GroupPromptStoreData): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmpPath, payload, "utf8");
  try {
    await rename(tmpPath, path);
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError?.code === "EEXIST" || asNodeError?.code === "EPERM") {
      await rm(path, { force: true });
      await rename(tmpPath, path);
    } else {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }
}

export function createGroupPromptMemoryStore(memoryFilesRoot = resolveMemoryFilesRoot()): GroupPromptMemoryStore {
  const root = resolve(memoryFilesRoot);
  const storePath = resolve(root, GROUP_PROMPT_STORE_FILE);
  const locks = new Map<string, Promise<void>>();

  const withLock = async <T>(chatId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(chatId) ?? Promise.resolve();
    let result: T;
    const next = prev.then(async () => { result = await fn(); }, async () => { result = await fn(); });
    locks.set(chatId, next);
    await next;
    return result!;
  };

  const read = async () => readStore(storePath);

  const write = async (next: GroupPromptStoreData) => {
    await mkdir(root, { recursive: true });
    await writeStoreAtomic(storePath, next);
  };

  return {
    get: async (chatId) => {
      const data = await read();
      return data.groups[chatId] ?? null;
    },
    set: async (chatId, prompt) => {
      return withLock(chatId, async () => {
        const data = await read();
        const now = Date.now();
        const nextRecord: GroupPromptRecord = { prompt, updatedAt: now };
        const next: GroupPromptStoreData = {
          version: data.version || 1,
          groups: {
            ...data.groups,
            [chatId]: nextRecord,
          },
        };
        await write(next);
        return nextRecord;
      });
    },
    add: async (chatId, promptChunk) => {
      return withLock(chatId, async () => {
        const data = await read();
        const now = Date.now();
        const existingPrompt = data.groups[chatId]?.prompt ?? "";
        const mergedPrompt = mergePromptWithDedup(existingPrompt, promptChunk);
        if (mergedPrompt.length > MAX_PROMPT_CHARS) {
          throw new Error(
            `group_prompt_memory.add merged content too long. Max ${MAX_PROMPT_CHARS} chars.`,
          );
        }
        const nextRecord: GroupPromptRecord = { prompt: mergedPrompt, updatedAt: now };
        const next: GroupPromptStoreData = {
          version: data.version || 1,
          groups: {
            ...data.groups,
            [chatId]: nextRecord,
          },
        };
        await write(next);
        return nextRecord;
      });
    },
    clear: async (chatId) => {
      return withLock(chatId, async () => {
        const data = await read();
        if (!(chatId in data.groups)) {
          return false;
        }
        const groups = { ...data.groups };
        delete groups[chatId];
        await write({
          version: data.version || 1,
          groups,
        });
        return true;
      });
    },
    getStorePath: () => storePath,
  };
}

export function createGroupPromptMemoryTool(memoryFilesRoot?: string): AgentTool<any, GroupPromptToolDetails> {
  const store = createGroupPromptMemoryStore(memoryFilesRoot);
  const storePath = store.getStorePath();

  return {
    name: "group_prompt_memory",
    label: "Group prompt memory",
    description:
      "Manage chat-scoped long-term prompt memory by chat_id. Use get/set/add/clear for explicit user memory instructions.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("add"), Type.Literal("clear")], {
        description: "Operation: get/set/add/clear.",
      }),
      chat_id: Type.String({
        description: "Target chat id scope.",
      }),
      content: Type.Optional(
        Type.String({
          description: "Prompt content. Required when action=set.",
        })
      ),
    }),
    execute: async (_toolCallId, params: GroupPromptParams) => {
      const action = params.action;
      const chatId = normalizeChatId(params.chat_id);

      if (action === "get") {
        const record = await store.get(chatId);
        console.log(
          `[group_prompt_memory] action=get chat=${chatId} path=${storePath} found=${Boolean(record)}`
        );
        return {
          content: [{ type: "text", text: record ? "Group prompt found." : "Group prompt is empty." }],
          details: {
            action,
            chatId,
            prompt: record?.prompt ?? "",
            existed: Boolean(record),
            updatedAt: record?.updatedAt,
          },
        };
      }

      if (action === "set") {
        const prompt = normalizePrompt(params.content);
        const next = await store.set(chatId, prompt);
        console.log(
          `[group_prompt_memory] action=set chat=${chatId} path=${storePath} chars=${next.prompt.length}`
        );
        return {
          content: [{ type: "text", text: "Group prompt saved." }],
          details: {
            action,
            chatId,
            prompt: next.prompt,
            existed: true,
            updatedAt: next.updatedAt,
          },
        };
      }

      if (action === "add") {
        const promptChunk = normalizePrompt(params.content);
        const next = await store.add(chatId, promptChunk);
        console.log(
          `[group_prompt_memory] action=add chat=${chatId} path=${storePath} chars=${next.prompt.length}`
        );
        return {
          content: [{ type: "text", text: "Group prompt appended." }],
          details: {
            action,
            chatId,
            prompt: next.prompt,
            existed: true,
            updatedAt: next.updatedAt,
          },
        };
      }

      const existed = await store.clear(chatId);
      console.log(
        `[group_prompt_memory] action=clear chat=${chatId} path=${storePath} existed=${existed}`
      );
      return {
        content: [{ type: "text", text: existed ? "Group prompt cleared." : "Group prompt was already empty." }],
        details: {
          action,
          chatId,
          prompt: "",
          existed,
        },
      };
    },
  };
}
