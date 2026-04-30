import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const DEFAULT_MEMORY_FILES_ROOT = ".runtime/memory_files";
const USER_MEMORY_DIR = "user-memories";
const MAX_MEMORY_CHARS = 8000;

type UserMemoryAction = "get" | "set" | "add" | "clear";

interface UserMemoryParams {
  action: UserMemoryAction;
  user_id: string;
  content?: string;
}

interface UserMemoryToolDetails {
  action: UserMemoryAction;
  userId: string;
  memory: string;
  existed: boolean;
  updatedAt?: number;
}

interface UserMemoryRecord {
  memory: string;
  updatedAt: number;
}

interface UserMemoryStoreData {
  version: number;
  memory: string;
  updatedAt: number;
}

function normalizeUserId(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("user_memory.user_id cannot be empty.");
  }
  return normalized;
}

function normalizeContent(input: string | undefined): string {
  const normalized = (input ?? "").trim();
  if (!normalized) {
    throw new Error("user_memory.content cannot be empty when action=set or action=add.");
  }
  if (normalized.length > MAX_MEMORY_CHARS) {
    throw new Error(`user_memory.content too long. Max ${MAX_MEMORY_CHARS} chars.`);
  }
  return normalized;
}

function normalizeForDedup(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function splitMemoryBlocks(value: string): string[] {
  return value
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
}

function mergeMemoryWithDedup(existing: string, incoming: string): string {
  const existingBlocks = splitMemoryBlocks(existing);
  const incomingBlocks = splitMemoryBlocks(incoming);
  if (incomingBlocks.length === 0) {
    return existing.trim();
  }
  const dedupSet = new Set(existingBlocks.map((block) => normalizeForDedup(block)));
  const mergedBlocks = [...existingBlocks];
  for (const block of incomingBlocks) {
    const key = normalizeForDedup(block);
    if (dedupSet.has(key)) continue;
    dedupSet.add(key);
    mergedBlocks.push(block);
  }
  return mergedBlocks.join("\n\n").trim();
}

function resolveMemoryFilesRoot(): string {
  return process.env.MEMORY_FILES_ROOT?.trim() || DEFAULT_MEMORY_FILES_ROOT;
}

function sanitizeFileName(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_:.-]/g, "_");
}

const memoryCache = new Map<string, UserMemoryStoreData>();

async function readUserMemory(dirPath: string, userId: string): Promise<UserMemoryRecord | null> {
  const cached = memoryCache.get(userId);
  if (cached) {
    return { memory: cached.memory, updatedAt: cached.updatedAt };
  }
  const filePath = resolve(dirPath, `${sanitizeFileName(userId)}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as Partial<UserMemoryStoreData>;
    const memory = typeof data.memory === "string" ? data.memory.trim() : "";
    const updatedAt = typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
    if (!memory || updatedAt <= 0) return null;
    const storeData: UserMemoryStoreData = { version: 1, memory, updatedAt };
    memoryCache.set(userId, storeData);
    return { memory, updatedAt };
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError?.code !== "ENOENT") {
      console.warn("[user_memory] failed to parse store:", error);
    }
    return null;
  }
}

async function writeUserMemory(dirPath: string, userId: string, data: UserMemoryStoreData): Promise<void> {
  await mkdir(dirPath, { recursive: true });
  const filePath = resolve(dirPath, `${sanitizeFileName(userId)}.json`);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError?.code === "EEXIST" || asNodeError?.code === "EPERM") {
      await rm(filePath, { force: true });
      await rename(tmpPath, filePath);
    } else {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }
  memoryCache.set(userId, data);
}

const locks = new Map<string, Promise<void>>();

async function withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(userId) ?? Promise.resolve();
  let result: T;
  const next = prev.then(async () => { result = await fn(); }, async () => { result = await fn(); });
  locks.set(userId, next);
  await next;
  if (locks.get(userId) === next) {
    locks.delete(userId);
  }
  return result!;
}

export function loadUserMemoryByActorId(actorId: string): string {
  const cached = memoryCache.get(actorId);
  return cached?.memory ?? "";
}

export function createUserMemoryTool(memoryFilesRoot?: string): AgentTool<any, UserMemoryToolDetails> {
  const root = resolve(memoryFilesRoot || resolveMemoryFilesRoot());
  const dirPath = resolve(root, USER_MEMORY_DIR);

  return {
    name: "user_memory",
    label: "User memory",
    description:
      "Manage per-user long-term memory by user_id. Store personal facts, preferences, and context about individual users. Use get/set/add/clear.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("add"), Type.Literal("clear")], {
        description: "Operation: get (read memory), set (replace memory), add (append to memory), clear (delete memory).",
      }),
      user_id: Type.String({
        description: "Target user actor ID (sender_id from message context).",
      }),
      content: Type.Optional(
        Type.String({
          description: "Memory content. Required for set/add.",
        })
      ),
    }),
    execute: async (_toolCallId, params: UserMemoryParams) => {
      const action = params.action;
      const userId = normalizeUserId(params.user_id);

      if (action === "get") {
        const record = await readUserMemory(dirPath, userId);
        console.log(`[user_memory] action=get user=${userId} found=${Boolean(record)}`);
        return {
          content: [{ type: "text", text: record ? `User memory found:\n${record.memory}` : "No memory stored for this user." }],
          details: {
            action,
            userId,
            memory: record?.memory ?? "",
            existed: Boolean(record),
            updatedAt: record?.updatedAt,
          },
        };
      }

      if (action === "set") {
        const content = normalizeContent(params.content);
        return withLock(userId, async () => {
          const now = Date.now();
          const data: UserMemoryStoreData = { version: 1, memory: content, updatedAt: now };
          await writeUserMemory(dirPath, userId, data);
          console.log(`[user_memory] action=set user=${userId} chars=${content.length}`);
          return {
            content: [{ type: "text", text: "User memory saved." }],
            details: { action, userId, memory: content, existed: true, updatedAt: now },
          };
        });
      }

      if (action === "add") {
        const content = normalizeContent(params.content);
        return withLock(userId, async () => {
          const existing = await readUserMemory(dirPath, userId);
          const merged = mergeMemoryWithDedup(existing?.memory ?? "", content);
          if (merged.length > MAX_MEMORY_CHARS) {
            throw new Error(`user_memory.add merged content too long. Max ${MAX_MEMORY_CHARS} chars.`);
          }
          const now = Date.now();
          const data: UserMemoryStoreData = { version: 1, memory: merged, updatedAt: now };
          await writeUserMemory(dirPath, userId, data);
          console.log(`[user_memory] action=add user=${userId} chars=${merged.length}`);
          return {
            content: [{ type: "text", text: "User memory appended." }],
            details: { action, userId, memory: merged, existed: true, updatedAt: now },
          };
        });
      }

      return withLock(userId, async () => {
        const existing = await readUserMemory(dirPath, userId);
        if (!existing) {
          console.log(`[user_memory] action=clear user=${userId} existed=false`);
          return {
            content: [{ type: "text", text: "User memory was already empty." }],
            details: { action, userId, memory: "", existed: false },
          };
        }
        const filePath = resolve(dirPath, `${sanitizeFileName(userId)}.json`);
        await rm(filePath, { force: true });
        memoryCache.delete(userId);
        console.log(`[user_memory] action=clear user=${userId} existed=true`);
        return {
          content: [{ type: "text", text: "User memory cleared." }],
          details: { action, userId, memory: "", existed: true },
        };
      });
    },
  };
}
