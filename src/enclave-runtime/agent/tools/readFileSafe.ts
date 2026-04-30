import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWED_ROOT = resolve(CURRENT_DIR, "../../../../");
const MAX_FILE_BYTES = 200_000;

interface ReadFileSafeDetails {
  requestedPath: string;
  resolvedPath: string;
  byteLength: number;
}

async function resolveInsideAllowedRoot(inputPath: string): Promise<string> {
  const allowedRoot = process.env.READ_FILE_SAFE_ROOT?.trim() || DEFAULT_ALLOWED_ROOT;
  const canonicalRoot = await realpath(allowedRoot);
  const resolved = path.resolve(canonicalRoot, inputPath);
  let canonicalResolved: string;
  try {
    canonicalResolved = await realpath(resolved);
  } catch {
    canonicalResolved = resolved;
  }
  if (canonicalResolved !== canonicalRoot && !canonicalResolved.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("Path is outside allowed root.");
  }
  return canonicalResolved;
}

export function createReadFileSafeTool(): AgentTool<any, ReadFileSafeDetails> {
  return {
    name: "read_file_safe",
    label: "Read file safely",
    description:
      "Read a UTF-8 text file under project root with file-size and path safety checks.",
    parameters: Type.Object({
      path: Type.String({
        description: "File path relative to READ_FILE_SAFE_ROOT.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const resolvedPath = await resolveInsideAllowedRoot(params.path);
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        throw new Error("Target path is not a file.");
      }
      if (fileStat.size > MAX_FILE_BYTES) {
        throw new Error(
          `File is too large (${fileStat.size} bytes). Limit is ${MAX_FILE_BYTES} bytes.`
        );
      }
      const text = await readFile(resolvedPath, "utf8");
      return {
        content: [{ type: "text", text }],
        details: {
          requestedPath: params.path,
          resolvedPath,
          byteLength: Buffer.byteLength(text, "utf8"),
        },
      };
    },
  };
}
