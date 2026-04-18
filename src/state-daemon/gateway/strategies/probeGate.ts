import type { GatewayTriggerPolicy } from "../types";

export function createProbeGateTriggerPolicy(): GatewayTriggerPolicy {
  return {
    name: "ProbeGate",
    priority: 40,
    decide: (message) => {
      if (message.conversationType !== "group" && message.conversationType !== "supergroup") {
        return { shouldTrigger: false, reason: "none" };
      }

      const prompt = message.context.trim();
      if (!prompt) {
        console.log(
          `[probe_gate] gate_code=deny_empty chat=${message.chatId} messageId=${message.messageId} replyTo=${message.metadata.replyToMessageId ?? "-"} isMention=${message.metadata.isMentionMe} isReply=${message.metadata.isReplyToMe}`
        );
        return { shouldTrigger: false, reason: "none" };
      }
      if (prompt.startsWith("/")) {
        console.log(
          `[probe_gate] gate_code=deny_command chat=${message.chatId} messageId=${message.messageId} replyTo=${message.metadata.replyToMessageId ?? "-"} isMention=${message.metadata.isMentionMe} isReply=${message.metadata.isReplyToMe}`
        );
        return { shouldTrigger: false, reason: "none" };
      }

      if (message.metadata.isMentionMe || message.metadata.isReplyToMe) {
        console.log(
          `[probe_gate] gate_code=skip_direct_trigger chat=${message.chatId} messageId=${message.messageId} replyTo=${message.metadata.replyToMessageId ?? "-"} isMention=${message.metadata.isMentionMe} isReply=${message.metadata.isReplyToMe}`
        );
        return { shouldTrigger: false, reason: "none" };
      }

      console.log(
        `[probe_gate] gate_code=allow_probe_candidate chat=${message.chatId} messageId=${message.messageId} replyTo=${message.metadata.replyToMessageId ?? "-"} isMention=${message.metadata.isMentionMe} isReply=${message.metadata.isReplyToMe} isBotSender=${message.metadata.isBot}`
      );

      return { shouldTrigger: true, reason: "probe_gate", prompt };
    },
  };
}
