import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDynamicTool } from "./shared/dynamicToolSchema";

export interface LoadDynamicToolsResult {
  tools: AgentTool<any>[];
  errors: Array<{ filePath: string; error: unknown }>;
}

async function unwrapExportedTool(exportedValue: unknown): Promise<AgentTool<any> | null> {
  if (typeof exportedValue === "function") {
    const created = await exportedValue();
    return validateDynamicTool(created);
  }
  return validateDynamicTool(exportedValue);
}

async function loadToolFromFile(filePath: string): Promise<AgentTool<any>> {
  const fileStat = await stat(filePath);
  const moduleUrl = `${pathToFileURL(filePath).href}?v=${fileStat.mtimeMs}`;
  const loaded = await import(moduleUrl);

  const candidates = [loaded.default, ...Object.values(loaded)];
  for (const candidate of candidates) {
    try {
      const tool = await unwrapExportedTool(candidate);
      if (tool) {
        return tool;
      }
    } catch {
      // Ignore values that are not tool factories.
    }
  }

  throw new Error("No valid AgentTool export found.");
}

export async function loadDynamicToolsFromDirectory(
  directoryPath: string
): Promise<LoadDynamicToolsResult> {
  let entries: string[] = [];
  try {
    entries = await readdir(directoryPath);
  } catch (error) {
    return {
      tools: [],
      errors: [{ filePath: directoryPath, error }],
    };
  }

  const toolFiles = entries
    .filter((entry) => extname(entry).toLowerCase() === ".ts")
    .map((entry) => join(directoryPath, entry));

  const tools: AgentTool<any>[] = [];
  const errors: Array<{ filePath: string; error: unknown }> = [];
  for (const filePath of toolFiles) {
    try {
      tools.push(await loadToolFromFile(filePath));
    } catch (error) {
      errors.push({ filePath, error });
    }
  }

  return { tools, errors };
}
