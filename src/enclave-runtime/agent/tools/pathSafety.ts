import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function getSafeToolsRoot(): string {
  const configuredRoot = process.env.MEMORY_FILES_ROOT?.trim();
  if (!configuredRoot) {
    throw new Error("MEMORY_FILES_ROOT is required for safe tools root.");
  }
  return configuredRoot;
}

export async function resolveSafePath(inputPath: string): Promise<string> {
  const normalized = inputPath.trim();
  if (!normalized) {
    throw new Error("Path is required.");
  }
  const safeRoot = resolve(getSafeToolsRoot());
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(safeRoot);
  } catch {
    canonicalRoot = safeRoot;
  }
  const absolutePath = resolve(canonicalRoot, normalized);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    canonicalPath = absolutePath;
  }
  if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("Path is outside the allowed tools directory.");
  }
  return canonicalPath;
}
