import { describe, expect, test } from "bun:test";
import {
  formatTelegramText,
  normalizeTelegramParseMode,
  withTelegramFormattingFallback,
} from "./formatting";

describe("formatTelegramText", () => {
  test("converts default markdown to Telegram HTML", () => {
    const result = formatTelegramText("**bold** and _italic_");

    expect(result).toEqual({
      text: "<b>bold</b> and <i>italic</i>",
      kind: "html",
    });
  });

  test("escapes raw HTML in markdown mode", () => {
    const result = formatTelegramText("<b>raw</b> & text");

    expect(result.text).toBe("&lt;b&gt;raw&lt;/b&gt; &amp; text");
    expect(result.kind).toBe("html");
  });

  test("passes explicit Telegram HTML through", () => {
    const result = formatTelegramText("<b>raw</b>", "html");

    expect(result).toEqual({
      text: "<b>raw</b>",
      kind: "html",
    });
  });

  test("disables parsing for plain mode", () => {
    const result = formatTelegramText("**not bold**", "plain");

    expect(result).toEqual({
      text: "**not bold**",
      kind: "plain",
    });
  });
});

describe("normalizeTelegramParseMode", () => {
  test("normalizes supported modes and falls back for unknown values", () => {
    expect(normalizeTelegramParseMode("HTML")).toBe("html");
    expect(normalizeTelegramParseMode("plain")).toBe("plain");
    expect(normalizeTelegramParseMode("md")).toBe("markdown");
  });
});

describe("withTelegramFormattingFallback", () => {
  test("retries formatted HTML as plain text when formatted send fails", async () => {
    const calls: string[] = [];
    const originalWarn = console.warn;
    console.warn = () => {};

    let result = "";
    try {
      result = await withTelegramFormattingFallback({
        text: "<b>hello</b>",
        parseMode: "html",
        fallbackLogPrefix: "test formatted send failed",
        sendFormatted: async () => {
          calls.push("formatted");
          throw new Error("bad html");
        },
        sendPlain: async () => {
          calls.push("plain");
          return "ok";
        },
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(result).toBe("ok");
    expect(calls).toEqual(["formatted", "plain"]);
  });

  test("does not retry plain text failures", async () => {
    await expect(
      withTelegramFormattingFallback({
        text: "hello",
        parseMode: "plain",
        fallbackLogPrefix: "test plain send failed",
        sendFormatted: async () => {
          throw new Error("network");
        },
        sendPlain: async () => "unused",
      })
    ).rejects.toThrow("network");
  });
});
