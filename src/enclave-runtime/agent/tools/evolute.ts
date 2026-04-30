import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { $ } from "bun";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface EvoluteDetails {
  registeredToolName: string;
  stagedToolCallId: string;
}

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CURRENT_DIR, "../../../../");
const ENCLAVE_WORKSPACE_DIR = resolve(CURRENT_DIR, "../../");
const configuredModuleDir = process.env.EVOLUTE_MODULE_DIR?.trim();
const EVOLUTE_MODULE_DIR =
  configuredModuleDir && configuredModuleDir.length > 0
    ? resolve(ENCLAVE_WORKSPACE_DIR, configuredModuleDir)
    : resolve(ENCLAVE_WORKSPACE_DIR, ".evolute-modules");
const KEEP_EVOLUTE_MODULES = process.env.EVOLUTE_KEEP_MODULES === "1";
const EVOLUTE_MANAGED_DEPS_FILE = join(EVOLUTE_MODULE_DIR, "package.json");
const BUILTIN_PLAIN_NAMES = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const ESM_LEXER_READY = initEsmLexer;
const pendingEvolutedTools = new Map<string, { tool: AgentTool<any>; createdAt: number }>();
const PENDING_TOOL_TTL_MS = 60_000;

const SENSITIVE_ENV_PREFIXES = [
  "API_KEY", "ARK_API_KEY", "BOT_TOKEN", "TELEGRAM_API_HASH",
  "TELEGRAM_SESSION_STRING", "DASHBOARD_AUTH_TOKEN",
  "STATE_DAEMON_CLOUD_API_KEY", "CUSTOM_EMOJI_TO_TEXT_API_KEY",
  "VISION_API_KEY", "QWEN_API_KEY",
];

const SAFE_PACKAGE_NAME_PATTERN = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const requireResolver = createRequire(import.meta.url);

function getToolCodeDirFromEnv(): string {
  const toolCodeDir = process.env.EVOLUTIONS_ROOT?.trim();
  if (!toolCodeDir) {
    throw new Error("EVOLUTIONS_ROOT is required for evolute tool.");
  }
  return toolCodeDir;
}

const IGNORED_PACKAGE_NAMES = new Set<string>([
  "bun",
  "node",
  "typescript",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@sinclair/typebox",
]);

const DynamicToolSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String()),
    description: Type.String({ minLength: 1 }),
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: Type.Any(),
  },
  { additionalProperties: true }
);

function validateDynamicTool(candidate: unknown): AgentTool<any> {
  if (!Value.Check(DynamicToolSchema, candidate)) {
    const firstError = [...Value.Errors(DynamicToolSchema, candidate)][0];
    const message = firstError ? `${firstError.path} ${firstError.message}` : "invalid shape";
    throw new Error(`Dynamic tool schema validation failed: ${message}`);
  }
  const tool = candidate as AgentTool<any> & { execute: unknown };
  if (typeof tool.execute !== "function") {
    throw new Error("Dynamic tool must provide execute().");
  }
  return tool;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function compileToolFromCode(code: string): Promise<AgentTool<any>> {
  const source = code.trim();
  if (!source) {
    throw new Error("code is required.");
  }

  const moduleSource = buildModuleSource(source);
  await mkdir(EVOLUTE_MODULE_DIR, { recursive: true });
  const detectedDeps = await detectExternalDependencies(source);
  await ensureDependencies(detectedDeps, EVOLUTE_MODULE_DIR);
  const modulePath = join(
    EVOLUTE_MODULE_DIR,
    `tool-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`
  );

  await writeFile(modulePath, moduleSource, "utf8");
  let tool: unknown;
  let hasError = false;
  let validatedTool: AgentTool<any> | null = null;
  try {
    const moduleUrl = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
    const loaded = await import(moduleUrl);
    tool = loaded.default;

    if (tool === undefined) {
      for (const exportedValue of Object.values(loaded)) {
        if (typeof exportedValue === "function") {
          try {
            const instance = await exportedValue();
            if (instance && typeof (instance as any).execute === "function" && (instance as any).name) {
              tool = instance;
              break;
            }
          } catch {
            // Ignore helper functions that are not tool factories.
          }
        } else if (
          exportedValue &&
          typeof exportedValue === "object" &&
          typeof (exportedValue as any).execute === "function" &&
          typeof (exportedValue as any).name === "string"
        ) {
          tool = exportedValue;
          break;
        }
      }
    }

    if (!tool) {
      throw new Error("Cannot find any valid Tool object or factory function in exports.");
    }

    if (typeof tool === "function") {
      tool = await tool();
    }

    validatedTool = validateDynamicTool(tool);
    const toolCodeDir = getToolCodeDirFromEnv();
    await mkdir(toolCodeDir, { recursive: true });
    const codeUrl = `${toolCodeDir}/${validatedTool.name}.ts`;
    await writeFile(codeUrl, code, "utf8");
    await writeDependencySnapshot(validatedTool.name, detectedDeps);
    return validatedTool;
  } catch (error) {
    hasError = true;
    throw new Error(`Failed to compile tool from code: ${toErrorMessage(error)}`);
  } finally {
    if (!KEEP_EVOLUTE_MODULES && !hasError && validatedTool) {
      await unlink(modulePath).catch(() => undefined);
    }
  }
}

function buildModuleSource(source: string): string {
  const trimmed = source.trim();

  if (/\bexport\s+default\b/.test(source)) {
    return source;
  }

  const exportedFunction = source.match(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (exportedFunction?.[1]) {
    return `${source}\n\nexport default ${exportedFunction[1]}();\n`;
  }

  const exportedVar = source.match(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/);
  if (exportedVar?.[1]) {
    return `${source}\n\nexport default ${exportedVar[1]};\n`;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return `
import { Type } from "@mariozechner/pi-ai";
const __tool = (
${source}
);
export default __tool;
`;
  }

  throw new Error("Invalid tool code format: LLM must provide 'export default' or a raw object expression.");
}

function normalizePackageName(specifier: string): string | null {
  if (!specifier) {
    return null;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    return null;
  }
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return null;
  }

  const bareSpecifier = specifier.split("?")[0].split("#")[0];
  if (!bareSpecifier) {
    return null;
  }

  if (bareSpecifier.startsWith("@")) {
    const parts = bareSpecifier.split("/");
    if (parts.length < 2) {
      return bareSpecifier;
    }
    return `${parts[0]}/${parts[1]}`;
  }
  return bareSpecifier.split("/")[0];
}

function isIgnoredPackage(packageName: string): boolean {
  if (!packageName) {
    return true;
  }
  if (IGNORED_PACKAGE_NAMES.has(packageName)) {
    return true;
  }
  const plainName = packageName.replace(/^node:/, "");
  if (plainName === "node") {
    return true;
  }
  return BUILTIN_PLAIN_NAMES.has(plainName);
}

async function detectExternalDependencies(code: string): Promise<string[]> {
  const detected = new Set<string>();
  await ESM_LEXER_READY;
  const [imports] = parseEsm(code);
  for (const item of imports) {
    const specifier = (item.n ?? code.slice(item.s, item.e)).trim();
    if (!specifier) {
      continue;
    }
    const packageName = normalizePackageName(specifier);
    if (!packageName || isIgnoredPackage(packageName)) {
      continue;
    }
    detected.add(packageName);
  }
  return [...detected];
}

async function ensureDependencies(packageNames: string[], workDir: string): Promise<void> {
  if (packageNames.length === 0) {
    return;
  }
  const allowedPackages = parseAllowedPackages();
  for (const name of packageNames) {
    if (!SAFE_PACKAGE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid package name rejected: ${name}`);
    }
    if (allowedPackages && !allowedPackages.has(name)) {
      throw new Error(`Package '${name}' is not in EVOLUTE_ALLOWED_PACKAGES allowlist.`);
    }
  }
  const missingDependencies = packageNames.filter(
    (name) => !isDependencyResolvable(name, workDir)
  );
  if (missingDependencies.length === 0) {
    console.log("[evolute] dependencies already satisfied, skip install.");
    return;
  }
  const startedAt = Date.now();
  console.log(
    `[evolute] installing dependencies: ${missingDependencies.join(", ")} (cwd=${workDir})`
  );
  await ensureEvolutePackageManifest(workDir);
  try {
    await $`bun add ${missingDependencies}`.cwd(workDir).quiet();
    console.log(
      `[evolute] dependencies installed in ${Date.now() - startedAt}ms: ${missingDependencies.join(", ")}`
    );
  } catch (error) {
    console.error(
      `[evolute] dependency install failed after ${Date.now() - startedAt}ms: ${missingDependencies.join(", ")}`
    );
    throw new Error(
      `Failed installing dynamic tool deps (${missingDependencies.join(", ")}): ${toErrorMessage(error)}`
    );
  }
}

function parseAllowedPackages(): Set<string> | null {
  const raw = process.env.EVOLUTE_ALLOWED_PACKAGES?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function ensureEvolutePackageManifest(workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  const packageJsonPath = join(workDir, "package.json");
  try {
    await readFile(packageJsonPath, "utf8");
  } catch {
    const initialManifest = {
      name: "@kairos-runtime/evolute-modules",
      private: true,
      type: "module",
    };
    await writeFile(packageJsonPath, `${JSON.stringify(initialManifest, null, 2)}\n`, "utf8");
  }
}

function isDependencyResolvable(packageName: string, workDir: string): boolean {
  try {
    requireResolver.resolve(packageName, {
      paths: [workDir, ENCLAVE_WORKSPACE_DIR, process.cwd(), REPO_ROOT],
    });
    return true;
  } catch {
    return false;
  }
}

async function getManagedDependencyVersions(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(EVOLUTE_MANAGED_DEPS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return parsed.dependencies ?? {};
  } catch {
    return {};
  }
}

async function writeDependencySnapshot(
  toolName: string,
  detectedPackageNames: string[]
): Promise<void> {
  const installedVersions = await getManagedDependencyVersions();
  const dependencies: Record<string, string> = {};
  for (const name of detectedPackageNames) {
    if (isIgnoredPackage(name)) {
      continue;
    }
    dependencies[name] = installedVersions[name] ?? "latest";
  }
  const outputPath = join(EVOLUTE_MODULE_DIR, `${toolName}.json`);
  const payload = JSON.stringify({ dependencies }, null, 2);
  await writeFile(outputPath, `${payload}\n`, "utf8");
}

export function consumePendingEvolutedTool(toolCallId: string): AgentTool<any> | undefined {
  purgeStalePendingTools();
  const entry = pendingEvolutedTools.get(toolCallId);
  if (entry) {
    pendingEvolutedTools.delete(toolCallId);
    return entry.tool;
  }
  return undefined;
}

function purgeStalePendingTools(): void {
  const now = Date.now();
  for (const [id, entry] of pendingEvolutedTools) {
    if (now - entry.createdAt > PENDING_TOOL_TTL_MS) {
      pendingEvolutedTools.delete(id);
    }
  }
}

export function createEvoluteTool(): AgentTool<any, EvoluteDetails> {
  return {
    name: "evolute",
    label: "Evolute tool",
    description:
      "Register a new tool at runtime from Typescript code (supports import/export module style).",
    parameters: Type.Object({
        code: Type.String({
            description:
              `
              🚨 **STRICT CODING STANDARDS (MANDATORY):**
              1. **Language:** You MUST write **Strict TypeScript**.
              2. **Type Safety & The \`any\` Keyword:**
                - **For Business Logic & API:** Usage of \`any\` is STRICTLY FORBIDDEN. You MUST define strict \`interface\` or \`type\` for all intermediate variables, API responses, and parsed JSON (e.g., \`interface GithubCommit { ... }\`).
                - **For Framework Signatures & Generics:** You are ALLOWED (and expected) to use \`any\` ONLY to satisfy base framework interfaces, complex generic parameters, or external library boundaries (e.g., \`AgentTool<any, any>\`). 
                - **Rule of thumb:** Never use \`unknown\` as a generic parameter if it breaks function signature compatibility. Use \`any\` for structural compatibility, but use strict types for your actual data payloads.
              3. **Imports:** - You MUST explicitly import all external dependencies using ESM syntax (e.g., \`import * as cheerio from 'cheerio';\`).
                - For standard Bun/Node built-ins, use \`node:\` prefix (e.g., \`import { join } from 'node:path';\`).
                - Even though \`fetch\` is global in Bun, prefer defining return types for it.
                - DON't USE REQUIRE TO IMPORT ANYTHING.
              4. **Structure:** - Your code MUST export a factory function that returns the tool object.
                - Keep the code self-contained in a single file.
              5. DON'T IMPORT ANYTHING TWICE (e.g. import type { AgentTool } from "@mariozechner/pi-ai" and import  from "@mariozechner/pi-ai" is not allowed).
    
              Typescript code for a tool. You can either provide:
              1) a module with imports + export default,
              2) an exported factory function, e.g. export function createXxxTool(){...},
              3) an object expression (Type is available as Type).
              
              Here is an example:
              \`\`\`ts
              import { Type } from "@mariozechner/pi-ai";
              import type { AgentTool } from "@mariozechner/pi-agent-core";
    
              interface EvoluteDetails {
                EvoluteToolName: string;
              }
    
              export function createEchoTool(): AgentTool<any, EvoluteDetails> {
                return {
                  name: "echo_tool",
                  label: "Echo tool",
                  description: "Echo the input text",
                  parameters: Type.Object({
                    text: Type.String({ description: "Text to echo" }),
                  }),
                  execute: async (_toolCallId, params) => ({
                    content: [{ type: "text", text: params.text }],
                    details: { ok: true },
                  }),
                };
              \`\`\`
              
              The code will be evaluated in the context of the tool registry, so you can use the tools registered in the tool registry in the code.
              `,
          }),
    }),
    execute: async (toolCallId, params) => {
      const dynamicTool = await compileToolFromCode(params.code);
      pendingEvolutedTools.set(toolCallId, { tool: dynamicTool, createdAt: Date.now() });
      return {
        content: [
          {
            type: "text",
            text: `SUCCESS: Tool '${dynamicTool.name}' is now available.`,
          },
        ],
        details: {
          registeredToolName: dynamicTool.name,
          stagedToolCallId: toolCallId,
        },
      };
    },
  };
}
