import type { GatewayTriggerPolicy } from "../types";

type ProbeReplyMode = "off" | "smart" | "all";

const DEFAULT_PROBE_REPLY_MODE: ProbeReplyMode = "smart";
const DEFAULT_REPLY_WAKE_WORDS = ["yuki", "yukimochi", "mochi", "机器人", "bot"];

function resolveProbeReplyMode(): ProbeReplyMode {
  const raw = (process.env.STATE_DAEMON_PROBE_REPLY_MODE ?? "")
    .trim()
    .toLowerCase();
  if (raw === "off" || raw === "smart" || raw === "all") {
    return raw;
  }
  return DEFAULT_PROBE_REPLY_MODE;
}

function resolveProbeReplyWakeWords(): string[] {
  const raw = (process.env.STATE_DAEMON_PROBE_REPLY_WAKE_WORDS ?? "").trim();
  if (!raw) {
    return DEFAULT_REPLY_WAKE_WORDS;
  }
  const tokens = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : DEFAULT_REPLY_WAKE_WORDS;
}

function hasExplicitAssistantCue(messageText: string, wakeWords: string[]): boolean {
  const text = messageText.trim().toLowerCase();
  if (!text) {
    return false;
  }

  if (wakeWords.some((word) => text.includes(word))) {
    return true;
  }

  const hasSecondPerson = /(你|您|机器人|bot)/i.test(text);
  const hasAskVerb = /(帮我|请问|解释|分析|建议|推荐|怎么看|你觉得|能不能|可以不可以|如何|怎么)/i.test(text);
  const hasQuestionMark = text.includes("?") || text.includes("？");
  return hasSecondPerson && (hasAskVerb || hasQuestionMark);
}

export function createProbeGateTriggerPolicy(): GatewayTriggerPolicy {
  return {
    name: "ProbeGate",
    priority: 40,
    decide: (message) => {
      if (message.conversationType !== "group" && message.conversationType !== "supergroup") {
        return { shouldTrigger: false, reason: "none" };
      }
      if (message.metadata.isBot) {
        return { shouldTrigger: false, reason: "none" };
      }
      if (message.metadata.isMentionMe || message.metadata.isReplyToMe) {
        return { shouldTrigger: false, reason: "none" };
      }

      const replyMode = resolveProbeReplyMode();
      const wakeWords = resolveProbeReplyWakeWords();
      const isReplyToOthers = message.metadata.replyToMessageId !== null;
      if (isReplyToOthers) {
        if (replyMode === "off") {
          return { shouldTrigger: false, reason: "none" };
        }
        if (replyMode === "smart" && !hasExplicitAssistantCue(message.context, wakeWords)) {
          return { shouldTrigger: false, reason: "none" };
        }
      }

      const prompt = message.context.trim();
      if (!prompt || prompt.startsWith("/")) {
        return { shouldTrigger: false, reason: "none" };
      }

      return { shouldTrigger: true, reason: "probe_gate", prompt };
    },
  };
}
