import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGroupPromptMemoryTool } from "./groupPromptMemory";

const STORE_FILE_NAME = "group-prompts.json";

describe("group_prompt_memory tool", () => {
  let memoryRoot = "";

  beforeEach(async () => {
    memoryRoot = await mkdtemp(join(tmpdir(), "group-prompt-memory-"));
  });

  afterEach(async () => {
    if (memoryRoot) {
      await rm(memoryRoot, { recursive: true, force: true });
    }
  });

  test("set -> add(dedup) -> get -> clear -> get", async () => {
    const tool = createGroupPromptMemoryTool(memoryRoot);
    const chatId = "-100123456";

    const setResult = await tool.execute("tool-call-1", {
      action: "set",
      chat_id: chatId,
      content: "  speak in concise style and remember this group's preference  ",
    });
    expect(setResult.details?.action).toBe("set");
    expect(setResult.details?.chatId).toBe(chatId);
    expect(setResult.details?.prompt).toBe("speak in concise style and remember this group's preference");
    expect(typeof setResult.details?.updatedAt).toBe("number");

    const storePath = resolve(memoryRoot, STORE_FILE_NAME);
    const rawStore = await readFile(storePath, "utf8");
    const parsedStore = JSON.parse(rawStore) as {
      version: number;
      groups: Record<string, { prompt: string; updatedAt: number }>;
    };
    expect(parsedStore.version).toBe(1);
    expect(parsedStore.groups[chatId]?.prompt).toBe(
      "speak in concise style and remember this group's preference",
    );
    expect(typeof parsedStore.groups[chatId]?.updatedAt).toBe("number");

    const getResult = await tool.execute("tool-call-2", {
      action: "add",
      chat_id: chatId,
      content: "always prefer bullet points in this chat",
    });
    expect(getResult.details?.action).toBe("add");
    expect(getResult.details?.existed).toBe(true);
    expect(getResult.details?.prompt).toBe(
      "speak in concise style and remember this group's preference\n\nalways prefer bullet points in this chat",
    );

    const addDuplicateResult = await tool.execute("tool-call-3", {
      action: "add",
      chat_id: chatId,
      content: "  always   prefer  bullet points in this chat  ",
    });
    expect(addDuplicateResult.details?.action).toBe("add");
    expect(addDuplicateResult.details?.prompt).toBe(
      "speak in concise style and remember this group's preference\n\nalways prefer bullet points in this chat",
    );

    const getAfterAddResult = await tool.execute("tool-call-4", {
      action: "get",
      chat_id: chatId,
    });
    expect(getAfterAddResult.details?.action).toBe("get");
    expect(getAfterAddResult.details?.existed).toBe(true);
    expect(getAfterAddResult.details?.prompt).toBe(
      "speak in concise style and remember this group's preference\n\nalways prefer bullet points in this chat",
    );

    const clearResult = await tool.execute("tool-call-5", {
      action: "clear",
      chat_id: chatId,
    });
    expect(clearResult.details?.action).toBe("clear");
    expect(clearResult.details?.existed).toBe(true);
    expect(clearResult.details?.prompt).toBe("");

    const getAfterClearResult = await tool.execute("tool-call-6", {
      action: "get",
      chat_id: chatId,
    });
    expect(getAfterClearResult.details?.action).toBe("get");
    expect(getAfterClearResult.details?.existed).toBe(false);
    expect(getAfterClearResult.details?.prompt).toBe("");
  });
});
