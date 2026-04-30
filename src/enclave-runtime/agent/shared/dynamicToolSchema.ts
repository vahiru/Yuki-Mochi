import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";

export const DynamicToolSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String()),
    description: Type.String({ minLength: 1 }),
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: Type.Any(),
  },
  { additionalProperties: true }
);

export function validateDynamicTool(candidate: unknown): AgentTool<any> | null {
  if (!Value.Check(DynamicToolSchema, candidate)) {
    return null;
  }
  const tool = candidate as AgentTool<any> & { execute: unknown };
  if (typeof tool.execute !== "function") {
    return null;
  }
  return tool;
}
