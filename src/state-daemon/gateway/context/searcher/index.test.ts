import { describe, expect, test } from "bun:test";
import { SearchMode, type SearchResult } from "../../../storage/vfs";
import { createContextSearcher } from "./index";

const sampleResult: SearchResult = {
  sessionId: "s1",
  centerVector: [],
  abstractSummary: "summary",
  score: 0.9,
  messages: [
    {
      userId: "user:1",
      messageId: "1",
      chatId: "100",
      conversationType: "group",
      context: "hello",
      timestamp: Date.now(),
      metadata: {
        isBot: false,
        username: "alice",
        replyToMessageId: "",
        replyToUserId: "",
        isReplyToMe: false,
        isMentionMe: false,
        mentions: [],
      },
      vector: [],
    },
  ],
};

describe("createContextSearcher", () => {
  test("uses actor-scoped recall when actor ids are provided", async () => {
    const calls: string[] = [];
    const searcher = createContextSearcher({
      vfsClient: {
        search: async () => ({ results: [] }),
        searchSemanticByActor: async ({ actorId }) => {
          calls.push(actorId);
          return { results: [{ ...sampleResult, sessionId: `s:${actorId}` }] };
        },
      },
    });

    const results = await searcher.searchSemantic({
      chatId: 100,
      query: "hello",
      targetActorIds: ["user:1", "user:2"],
    });

    expect(calls).toEqual(["user:1", "user:2"]);
    expect(results.length).toBe(2);
  });

  test("falls back to legacy speaker-scoped method when actor method is unavailable", async () => {
    const calls: string[] = [];
    const searcher = createContextSearcher({
      vfsClient: {
        search: async () => ({ results: [] }),
        searchSemanticBySpeaker: async ({ speaker }) => {
          calls.push(speaker);
          return { results: [sampleResult] };
        },
      },
    });

    const results = await searcher.searchSemantic({
      chatId: 100,
      query: "hello",
      actorId: "user:1",
    });

    expect(calls).toEqual(["user:1"]);
    expect(results.length).toBe(1);
  });

  test("uses generic semantic search when no actor ids are provided", async () => {
    const calls: Array<{ query: string; scope: string; mode: SearchMode }> = [];
    const searcher = createContextSearcher({
      vfsClient: {
        search: async (request) => {
          calls.push({
            query: request.query,
            scope: request.scope,
            mode: request.mode,
          });
          return { results: [sampleResult] };
        },
      },
    });

    const results = await searcher.searchSemantic({
      chatId: 100,
      query: "hello",
    });

    expect(calls).toEqual([{ query: "hello", scope: "100", mode: SearchMode.SEARCH_MODE_SEMANTIC }]);
    expect(results.length).toBe(1);
  });
});
