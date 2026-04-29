import {
  createClientRuntime,
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createPrivateChatTriggerPolicy,
  createProbeGateTriggerPolicy,
  createReplyToMeTriggerPolicy,
} from "./gateway";
import { loadStateDaemonConfig } from "@kairos-runtime/app-config";
import { createAdapter, type TelegramConfig } from "./telegram";
import { createUserRolesStore } from "./storage";
import { createGrpcEnclaveClient } from "./enclave/client";

const config = loadStateDaemonConfig();
const AGENT_ENCLAVE_TARGET = config.grpc.enclaveTarget;
const OWNER_USER_ID = config.telegram.ownerUserId;

function setEnvIfBlank(name: string, value: string): void {
  if (!process.env[name]?.trim()) {
    process.env[name] = value;
  }
}

setEnvIfBlank("AGENT_ENCLAVE_TARGET", AGENT_ENCLAVE_TARGET);
setEnvIfBlank("MEMORY_VFS_TARGET", config.grpc.vfsTarget);
setEnvIfBlank("MEMORY_FILES_ROOT", config.runtime.memoryFilesRoot);
setEnvIfBlank("OLLAMA_BASE_URL", config.model.llm.ollama.baseUrl);
setEnvIfBlank("OLLAMA_SESSION_MODEL", config.model.llm.ollama.model);
setEnvIfBlank("OLLAMA_EMBED_MODEL", config.model.embedding.ollamaModel);
setEnvIfBlank("EMBED_PROVIDER", config.model.embedding.provider);
setEnvIfBlank("ARK_API_KEY", config.model.llm.cloud.apiKey);
console.log(`[state-daemon] MEMORY_FILES_ROOT=${process.env.MEMORY_FILES_ROOT}`);

if (config.telegram.mode === "bot" && !config.telegram.botToken) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}

if (config.telegram.mode === "userbot" && !config.telegram.userbot) {
  throw new Error("UserBot configuration is required for userbot mode.");
}

const telegram = createAdapter({
  ...(config.telegram as TelegramConfig),
  customEmojiToText: config.customEmojiToText,
});
const enclaveClient = createGrpcEnclaveClient({
  target: AGENT_ENCLAVE_TARGET,
});

console.log(`[state-daemon] AGENT_ENCLAVE_TARGET=${AGENT_ENCLAVE_TARGET}`);

// Survive terminal detach without terminating.
process.on("SIGHUP", () => {});

const userRoles = createUserRolesStore();
if (OWNER_USER_ID) {
  userRoles.setRole(OWNER_USER_ID, "owner");
  console.log(`Owner registered: ${OWNER_USER_ID}`);
}

const runtime = createClientRuntime({
  enclaveClient,
  modelConfig: config.model,
});

const policies = [
  createReplyToMeTriggerPolicy(),
  createMentionMeTriggerPolicy(),
  ...(config.triggers.privateChat ? [createPrivateChatTriggerPolicy()] : []),
  ...(config.triggers.probeGate ? [createProbeGateTriggerPolicy()] : []),
];

const gateway = createMessageGateway({
  telegram,
  runtime,
  policies,
  userRoles,
  enableEditedMessageTrigger: config.triggers.editedMessage,
  probe: {
    enabled: config.triggers.probeGate,
    cooldownMs: config.triggers.probeCooldownMs,
  },
});

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const gracefulShutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[state-daemon] Shutting down...");
  gateway.stop();
  telegram.stop();
  setTimeout(() => {
    console.warn("[state-daemon] Forced exit after timeout.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  process.exit(0);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

telegram.start().then(
  () => {
    console.log("Telegram bot stopped.");
  },
  (error) => {
    console.error("Failed to start telegram bot:", error);
    process.exit(1);
  }
);

console.log("Telegram bot and message gateway are running.");
