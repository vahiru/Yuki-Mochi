import { describe, expect, test } from "bun:test";
import { injectVisionDescription, type AgentLoopMessage } from "./loopRunner";

describe("injectVisionDescription", () => {
  test("injects only into current_message and leaves historical photos untouched", () => {
    const messages: AgentLoopMessage[] = [
      {
        role: "user",
        content: `<context>
  <recent_messages>
<message id="1">
  历史截图 [photo]
</message>
  </recent_messages>
</context>
<current_message id="2">
  当前截图 [photo]
</current_message>`,
      },
    ];

    const result = injectVisionDescription(messages, "这是当前图片");
    const content = result[0]?.content ?? "";

    expect(content).toContain("历史截图 [photo]");
    expect(content).toContain("当前截图 [图片内容: 这是当前图片]");
    expect(content).not.toContain("历史截图 [图片内容: 这是当前图片]");
  });

  test("does not overwrite reply_to_preview photos inside query blocks", () => {
    const messages: AgentLoopMessage[] = [
      {
        role: "user",
        content: `<target_query>
  <query id="2">
    <reply_to_preview>旧图 [photo]</reply_to_preview>
    新图 [photo]
  </query>
</target_query>`,
      },
    ];

    const result = injectVisionDescription(messages, "这是当前图片");
    const content = result[0]?.content ?? "";

    expect(content).toContain("<reply_to_preview>旧图 [photo]</reply_to_preview>");
    expect(content).toContain("新图 [图片内容: 这是当前图片]");
    expect(content).not.toContain("<reply_to_preview>旧图 [图片内容: 这是当前图片]</reply_to_preview>");
  });

  test("appends the description to the current scoped block when no placeholder exists", () => {
    const messages: AgentLoopMessage[] = [
      {
        role: "user",
        content: `<context>
</context>
<current_message id="2">
  只有文字
</current_message>`,
      },
    ];

    const result = injectVisionDescription(messages, "这是当前图片");
    const content = result[0]?.content ?? "";

    expect(content).toContain("只有文字");
    expect(content).toContain("[图片内容: 这是当前图片]");
    expect(content).not.toContain("<context>\n</context>\n[图片内容: 这是当前图片]");
  });
});
