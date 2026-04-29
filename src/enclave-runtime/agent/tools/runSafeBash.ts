import { spawn } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { getSafeToolsRoot } from "./pathSafety";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_BUFFER_CHARS = MAX_OUTPUT_CHARS * 2;

// Defense-in-depth blocklist. Not a sandbox — real isolation comes from containerd.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bsudo\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bmv\b/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill(?:all)?\b/i,
  /\bpkill\b/i,
  /\bpoweroff\b/i,
  /\beval\b/i,
  /\bexec\b/i,
  /\bsource\b/i,
  /\bpython[23]?\b/i,
  /\bperl\b/i,
  /\bnode\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  />\s*\//,
];

const SENSITIVE_ENV_PATTERNS = [
  /^API_KEY$/i,
  /^ARK_API_KEY$/i,
  /^BOT_TOKEN$/i,
  /^TELEGRAM_API_HASH$/i,
  /^TELEGRAM_SESSION_STRING$/i,
  /^DASHBOARD_AUTH_TOKEN$/i,
  /^STATE_DAEMON_CLOUD_API_KEY$/i,
  /^CUSTOM_EMOJI_TO_TEXT_API_KEY$/i,
  /^VISION_API_KEY$/i,
  /^QWEN_API_KEY$/i,
  /SECRET/i,
  /PASSWORD/i,
  /TOKEN$/i,
  /PRIVATE.?KEY/i,
];

interface RunSafeBashDetails {
  command: string;
  cwd: string;
  timeoutMs: number;
  exitCode: number | null;
  signal: string | null;
}

function validateCommand(command: string): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new Error("Command is required.");
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`Command blocked by safety rule: ${pattern}`);
    }
  }
}

function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const isSensitive = SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      env[key] = value;
    }
  }
  return env;
}

function clampTimeout(timeoutMs?: number): number {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeoutMs), 1_000), MAX_TIMEOUT_MS);
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

export function createRunSafeBashTool(): AgentTool<any, RunSafeBashDetails> {
  const allowedWorkingDirectory = getSafeToolsRoot();
  const sanitizedEnv = buildSanitizedEnv();
  return {
    name: "run_safe_bash",
    label: "Run safe bash command",
    description:
      `Run a read-oriented bash command in ${allowedWorkingDirectory} with safety checks.`,
    parameters: Type.Object({
      command: Type.String({
        description: "Bash command to execute. Dangerous commands are blocked.",
      }),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Optional timeout in milliseconds. Default 15000, max 60000.",
        })
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      validateCommand(params.command);
      const timeoutMs = clampTimeout(params.timeoutMs);

      const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        signalName: string | null;
      }>((resolve, reject) => {
        const child = spawn("bash", ["-lc", params.command], {
          cwd: allowedWorkingDirectory,
          env: sanitizedEnv,
        });

        let stdout = "";
        let stderr = "";
        let finished = false;
        let timedOut = false;
        let bufferExceeded = false;

        const onAbort = () => {
          child.kill("SIGTERM");
          reject(new Error("Command aborted."));
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
          if (!bufferExceeded) {
            stdout += String(chunk);
            if (stdout.length > MAX_BUFFER_CHARS) {
              bufferExceeded = true;
              child.stdout.destroy();
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          if (!bufferExceeded) {
            stderr += String(chunk);
            if (stderr.length > MAX_BUFFER_CHARS) {
              bufferExceeded = true;
              child.stderr.destroy();
            }
          }
        });
        child.on("error", (error) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (exitCode, signalName) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (timedOut) {
            reject(new Error(`Command timed out after ${timeoutMs}ms.`));
            return;
          }
          resolve({ stdout, stderr, exitCode, signalName });
        });
      });

      const text = [
        `exitCode: ${result.exitCode ?? "null"}`,
        `signal: ${result.signalName ?? "null"}`,
        "",
        "stdout:",
        truncate(result.stdout || "(empty)"),
        "",
        "stderr:",
        truncate(result.stderr || "(empty)"),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          command: params.command,
          cwd: allowedWorkingDirectory,
          timeoutMs,
          exitCode: result.exitCode,
          signal: result.signalName,
        },
      };
    },
  };
}
