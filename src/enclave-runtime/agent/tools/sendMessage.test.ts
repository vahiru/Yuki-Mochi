import { describe, expect, test } from "bun:test";
import { createSendMessageTool } from "./sendMessage";

describe("send_message tool", () => {
  test("defaults parseMode details to undefined for backward compatibility", async () => {
    const tool = createSendMessageTool();

    const result = await tool.execute("tool-call-1", {
      text: "hello",
    } as any);

    expect(result.details).toEqual({
      text: "hello",
      parseMode: undefined,
      replyTo: undefined,
      awaitResponse: false,
    });
  });

  test("accepts explicit html parse_mode", async () => {
    const tool = createSendMessageTool();

    const result = await tool.execute("tool-call-1", {
      text: "<b>hello</b>",
      parse_mode: "html",
      reply_to: 123,
      await_response: true,
    } as any);

    expect(result.details).toEqual({
      text: "<b>hello</b>",
      parseMode: "html",
      replyTo: "123",
      awaitResponse: true,
    });
  });

  test("rejects unsupported parse_mode", async () => {
    const tool = createSendMessageTool();

    await expect(
      tool.execute("tool-call-1", {
        text: "hello",
        parse_mode: "md2",
      } as any)
    ).rejects.toThrow("send_message.parse_mode must be one of");
  });
});
