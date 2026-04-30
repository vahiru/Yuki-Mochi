import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import {
  getSharedMemoryVfsClient,
  SearchMode,
  type MemoryVfsClient,
  type SearchResult,
} from "../../../state-daemon/storage/vfs";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const MAX_MESSAGE_CHARS = 500;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

interface RecallMemoryParams {
  query: string;
  chat_id: string;
  user_id?: string;
  limit?: number;
}

interface RecallMemoryToolDetails {
  query: string;
  chatId: string;
  userId?: string;
  resultCount: number;
  topScore: number;
}

let vfsClient: MemoryVfsClient | null = null;

function getVfsClient(): MemoryVfsClient {
  if (!vfsClient) {
    vfsClient = getSharedMemoryVfsClient();
  }
  return vfsClient;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts < 1e12 ? ts * 1000 : ts);
  try {
    return date.toLocaleString("zh-CN", {
      timeZone: DEFAULT_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function extractSpeaker(msg: SearchResult["messages"][number]): string {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  return (
    (meta?.actorDisplayName as string) ||
    (meta?.username as string) ||
    msg.userId ||
    "unknown"
  );
}

function formatResults(query: string, results: SearchResult[]): string {
  const messages: Array<{ speaker: string; timestamp: number; text: string }> = [];
  for (const result of results) {
    for (const msg of result.messages) {
      messages.push({
        speaker: extractSpeaker(msg),
        timestamp: msg.timestamp,
        text: msg.context,
      });
    }
  }
  messages.sort((a, b) => a.timestamp - b.timestamp);

  if (messages.length === 0) {
    return `No matching memories found for "${query}".`;
  }

  const lines: string[] = [`[Recalled — ${messages.length} result(s) for "${query}"]`, ""];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    lines.push(`${i + 1}. ${m.speaker} (${formatTimestamp(m.timestamp)}):`);
    lines.push(`   ${truncate(m.text.trim(), MAX_MESSAGE_CHARS)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function createRecallMemoryTool(): AgentTool<any, RecallMemoryToolDetails> {
  return {
    name: "recall_memory",
    label: "Recall memory",
    description:
      "Search archived conversation history for past messages. Use when someone asks about past conversations, what someone said before, or references events not in the current context.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Natural language search query describing what to recall from past conversations.",
      }),
      chat_id: Type.String({
        description: "Chat ID to search within. Use the current chat_id.",
      }),
      user_id: Type.Optional(
        Type.String({
          description:
            "Optional user/actor ID to search only messages from a specific person.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (1-8, default 5).",
        }),
      ),
    }),
    execute: async (_toolCallId, params: RecallMemoryParams) => {
      const query = params.query.trim();
      const chatId = params.chat_id.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "recall_memory: query cannot be empty." }],
          details: { query: "", chatId, resultCount: 0, topScore: 0 },
        };
      }
      if (!chatId) {
        return {
          content: [{ type: "text", text: "recall_memory: chat_id cannot be empty." }],
          details: { query, chatId: "", resultCount: 0, topScore: 0 },
        };
      }

      const limit = Math.max(1, Math.min(MAX_LIMIT, params.limit ?? DEFAULT_LIMIT));
      const userId = params.user_id?.trim() || undefined;

      try {
        const client = getVfsClient();
        let results: SearchResult[];

        if (userId) {
          const resp = await client.searchSemanticByActor({
            chatId,
            actorId: userId,
            query,
            limit,
          });
          results = resp.results;
          console.log(
            `[recall_memory] chat=${chatId} user=${userId} query="${truncate(query, 60)}" results=${results.length}`,
          );
        } else {
          const resp = await client.search({
            query,
            scope: chatId,
            limit,
            mode: SearchMode.SEARCH_MODE_SEMANTIC,
          });
          results = resp.results;
          console.log(
            `[recall_memory] chat=${chatId} query="${truncate(query, 60)}" results=${results.length}`,
          );
        }

        const topScore = results.length > 0 ? results[0].score : 0;
        const text = formatResults(query, results);

        return {
          content: [{ type: "text", text }],
          details: {
            query,
            chatId,
            userId,
            resultCount: results.length,
            topScore,
          },
        };
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        console.error(`[recall_memory] search failed: ${errorMsg}`);
        return {
          content: [
            {
              type: "text",
              text: "Memory search temporarily unavailable. Try again later.",
            },
          ],
          details: { query, chatId, userId, resultCount: 0, topScore: 0 },
        };
      }
    },
  };
}
