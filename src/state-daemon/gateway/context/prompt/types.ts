export type SendMessageMode = "strict" | "compat";

export interface SystemPromptFile {
  filename: string;
  content: string;
}

export interface RenderSystemPromptInput {
  sendMessageMode: SendMessageMode;
  systemFiles: SystemPromptFile[];
  groupPrompt?: string;
}

export interface RenderLateBindingPromptInput {
  chatId: string | number;
  timeNow: string;
  timeZoneLabel?: string;
  conversationType?: "private" | "group" | "supergroup" | "channel";
  groupPrompt?: string;
  isProbeEnabled?: boolean;
  isProbing?: boolean;
  probeGroupPrompt?: string;
  isMentioned?: boolean;
  isReplied?: boolean;
  isReplyingToOther?: boolean;
  mentionsOtherUsers?: boolean;
  extraGuideline?: string;
  triggerReason?: string;
}
