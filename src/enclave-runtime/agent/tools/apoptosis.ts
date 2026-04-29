import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const PROTECTED_TOOLS = new Set(["send_message", "send_file", "evolute", "apoptosis"]);

interface ApoptosisDetails {
  targetToolName: string;
  stagedToolCallId: string;
}

export function createApoptosisTool(): AgentTool<any, ApoptosisDetails> {
  return {
    name: "apoptosis",
    label: "Apoptosis tool",
    description:
      "Request removing a registered tool by name. Actual removal is handled by the loop runner event listener.",
    parameters: Type.Object({
      toolName: Type.String({
        minLength: 1,
        description: "Tool name to remove from dynamicToolRegistry.",
      }),
    }),
    execute: async (toolCallId, params) => {
      const targetToolName = params.toolName.trim();
      if (!targetToolName) {
        throw new Error("toolName is required.");
      }
      if (PROTECTED_TOOLS.has(targetToolName)) {
        throw new Error(`Cannot remove core tool '${targetToolName}'.`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Apoptosis requested for tool '${targetToolName}'. Loop runner will process the actual removal.`,
          },
        ],
        details: {
          targetToolName,
          stagedToolCallId: toolCallId,
        },
      };
    },
  };
}
