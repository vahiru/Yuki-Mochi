import type { TelegramParseMode } from "./types";
import { markdownToTelegramHtml } from "./markdownToHtml";

export interface TelegramFormattedText {
  text: string;
  kind: "html" | "plain";
}

export function normalizeTelegramParseMode(
  input: unknown,
  fallback: TelegramParseMode = "markdown"
): TelegramParseMode {
  if (typeof input !== "string") {
    return fallback;
  }
  const normalized = input.trim().toLowerCase();
  if (normalized === "markdown" || normalized === "html" || normalized === "plain") {
    return normalized;
  }
  return fallback;
}

export function formatTelegramText(
  text: string,
  parseMode?: TelegramParseMode
): TelegramFormattedText {
  const mode = normalizeTelegramParseMode(parseMode);
  if (mode === "plain") {
    return { text, kind: "plain" };
  }
  if (mode === "html") {
    return { text, kind: "html" };
  }

  try {
    const htmlText = markdownToTelegramHtml(text);
    if (htmlText) {
      return { text: htmlText, kind: "html" };
    }
  } catch {
    // Fall through to plain text if Markdown rendering fails.
  }
  return { text, kind: "plain" };
}

export async function withTelegramFormattingFallback<T>(input: {
  text: string;
  parseMode?: TelegramParseMode;
  fallbackLogPrefix: string;
  sendFormatted: (payload: TelegramFormattedText) => Promise<T>;
  sendPlain: () => Promise<T>;
}): Promise<T> {
  const payload = formatTelegramText(input.text, input.parseMode);
  try {
    return await input.sendFormatted(payload);
  } catch (error) {
    if (payload.kind !== "html") {
      throw error;
    }
    console.warn(`${input.fallbackLogPrefix}, retrying as plain text:`, error);
    return input.sendPlain();
  }
}
