import { lookup } from "node:dns/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface FetchWebpageToolDetails {
  sourceUrl: string;
}

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RANGES.some((pattern) => pattern.test(ip));
}

async function validateNotInternal(hostname: string): Promise<void> {
  if (isPrivateIp(hostname)) {
    throw new Error("Requests to private/internal IP addresses are blocked.");
  }
  try {
    const result = await lookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    for (const entry of addresses) {
      if (isPrivateIp(entry.address)) {
        throw new Error(`Hostname '${hostname}' resolves to private IP — blocked.`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("blocked")) {
      throw error;
    }
  }
}

function toJinaUrl(rawUrl: string): { jinaUrl: string; hostname: string } {
  const normalized = rawUrl.trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported.");
  }
  const withoutProtocol = normalized.replace(/^https?:\/\//i, "");
  return {
    jinaUrl: `https://r.jina.ai/${withoutProtocol}`,
    hostname: parsed.hostname,
  };
}

export function createFetchWebpageTool(): AgentTool<any, FetchWebpageToolDetails> {
  return {
    name: "fetch_webpage",
    label: "Fetch webpage",
    description:
      "Fetch webpage content through r.jina.ai by passing a normal URL.",
    parameters: Type.Object({
      url: Type.String({
        description: "Target webpage URL, e.g. https://example.com/page",
      }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { jinaUrl, hostname } = toJinaUrl(params.url);
      await validateNotInternal(hostname);
      const response = await fetch(jinaUrl, { signal });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch webpage via r.jina.ai: ${response.status} ${response.statusText}`
        );
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body.");
      }
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          reader.cancel();
          chunks.push(value.slice(0, value.byteLength - (totalBytes - MAX_RESPONSE_BYTES)));
          break;
        }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return {
        content: [{ type: "text", text }],
        details: {
          sourceUrl: params.url,
        },
      };
    },
  };
}
