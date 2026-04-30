import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderSystemPromptInput, SendMessageMode, SystemPromptFile } from "./types";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_MEMORY_DIR = resolve(CURRENT_DIR, "../../../../../.runtime/memory_files");
const DEFAULT_SEND_MESSAGE_MODE: SendMessageMode = "strict";
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const GROUP_PROMPT_STORE_FILE = "group-prompts.json";
const USER_MEMORY_DIR = "user-memories";
const FILE_CACHE_TTL_MS = 30_000;

const DEFAULT_SYSTEM_FILE_NAMES = ["Soul.md", "Identity.md", "Tools.md"] as const;

const fileCache = new Map<string, { content: string; expiresAt: number }>();

function readCachedFile(filePath: string): string {
  const now = Date.now();
  const cached = fileCache.get(filePath);
  if (cached && now < cached.expiresAt) {
    return cached.content;
  }
  try {
    const content = readFileSync(filePath, "utf8");
    fileCache.set(filePath, { content, expiresAt: now + FILE_CACHE_TTL_MS });
    return content;
  } catch {
    fileCache.delete(filePath);
    return "";
  }
}

export function resolveSendMessageMode(): SendMessageMode {
  const raw = process.env.ENCLAVE_SEND_MESSAGE_MODE?.trim().toLowerCase();
  if (raw === "compat") {
    return "compat";
  }
  return DEFAULT_SEND_MESSAGE_MODE;
}

export function resolveMemoryDir(): string {
  return process.env.MEMORY_FILES_ROOT?.trim() || SHARED_MEMORY_DIR;
}

function readMemoryFile(fileName: string): string {
  const filePath = resolve(resolveMemoryDir(), fileName);
  const content = readCachedFile(filePath);
  if (!content) {
    console.warn(`[system] memory file not found, skipping: ${filePath}`);
  }
  return content;
}

export function loadSystemFilesFromMemory(
  fileNames: readonly string[] = DEFAULT_SYSTEM_FILE_NAMES,
): SystemPromptFile[] {
  return fileNames.map((fileName) => ({
    filename: fileName,
    content: readMemoryFile(fileName),
  }));
}

interface GroupPromptStoreData {
  version?: unknown;
  groups?: Record<string, { prompt?: unknown; updatedAt?: unknown }>;
}

export function loadGroupPromptByChatId(chatId: string | number): string | undefined {
  const normalizedChatId = String(chatId).trim();
  if (!normalizedChatId) {
    return undefined;
  }

  const filePath = resolve(resolveMemoryDir(), GROUP_PROMPT_STORE_FILE);
  const raw = readCachedFile(filePath);
  if (!raw) {
    return undefined;
  }

  let parsed: GroupPromptStoreData;
  try {
    parsed = JSON.parse(raw) as GroupPromptStoreData;
  } catch {
    console.warn(`[system] group prompt store malformed, skipping: ${filePath}`);
    return undefined;
  }

  const groups = parsed.groups;
  if (!groups || typeof groups !== "object") {
    return undefined;
  }
  const record = groups[normalizedChatId];
  const prompt = typeof record?.prompt === "string" ? record.prompt.trim() : "";
  if (!prompt) {
    return undefined;
  }
  return prompt;
}

export function buildSystemPromptInput(params?: {
  sendMessageMode?: SendMessageMode;
  systemFiles?: SystemPromptFile[];
  groupPrompt?: string;
}): RenderSystemPromptInput {
  return {
    sendMessageMode: params?.sendMessageMode ?? resolveSendMessageMode(),
    systemFiles: params?.systemFiles ?? loadSystemFilesFromMemory(),
    groupPrompt: params?.groupPrompt?.trim() || undefined,
  };
}

export function formatTimeNow(timeZone: string = DEFAULT_TIME_ZONE): string {
  try {
    return new Date().toLocaleString("en-US", {
      timeZone,
      hour12: false,
    });
  } catch {
    return new Date().toISOString();
  }
}

export interface UserMemoryEntry {
  actorId: string;
  memory: string;
}

export function loadUserMemoriesByActorIds(actorIds: string[]): UserMemoryEntry[] {
  if (actorIds.length === 0) return [];
  const memoryDir = resolve(resolveMemoryDir(), USER_MEMORY_DIR);
  const entries: UserMemoryEntry[] = [];
  for (const actorId of actorIds) {
    const normalized = actorId.trim();
    if (!normalized) continue;
    const sanitized = normalized.replace(/[^a-zA-Z0-9_:.-]/g, "_");
    const filePath = resolve(memoryDir, `${sanitized}.json`);
    const raw = readCachedFile(filePath);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { memory?: unknown };
      const memory = typeof parsed.memory === "string" ? parsed.memory.trim() : "";
      if (memory) {
        entries.push({ actorId: normalized, memory });
      }
    } catch {}
  }
  return entries;
}
