import type { LLMMessage, TelegramMessage } from "../../../types/message";
import { escapeXml, formatTimestampUtc8 } from "../../../utils/messageXml";

export interface ArchiveAssemblerBuildInput {
  sessionMessages: TelegramMessage[];
  sessionId: string;
  systemPrompt: string;
  existingProfiles?: Map<string, Record<string, unknown>>;
}

export interface ArchiveAssembler {
  build: (input: ArchiveAssemblerBuildInput) => LLMMessage[];
}

export function createArchiveAssembler(): ArchiveAssembler {
  return {
    build: ({ sessionMessages, sessionId, systemPrompt, existingProfiles }) => {
      const sortedMessages = sessionMessages.slice().sort((a, b) => a.timestamp - b.timestamp);
      const existingProfilesXml = formatExistingProfilesXml(existingProfiles);
      const xml = `<session_archive id="${escapeXml(sessionId)}">
  <messages>
${sortedMessages.map(formatArchiveMessageNode).join("\n")}
  </messages>
</session_archive>${existingProfilesXml}`;

      return [
        { role: "system", content: systemPrompt },
        { role: "user", content: xml },
      ];
    },
  };
}

function formatArchiveMessageNode(message: TelegramMessage): string {
  return `    <message sender_id="${escapeXml(message.userId)}" speaker="${escapeXml(message.metadata.username ?? "unknown")}" timestamp="${formatTimestampUtc8(message.timestamp)}">${escapeXml(message.context)}</message>`;
}

function formatExistingProfilesXml(profiles?: Map<string, Record<string, unknown>>): string {
  if (!profiles || profiles.size === 0) {
    return "";
  }
  const nodes: string[] = [];
  for (const [actorId, data] of profiles) {
    const compact = JSON.stringify(data);
    if (compact.length > 2000) {
      nodes.push(`  <existing_profile user_id="${escapeXml(actorId)}">${escapeXml(compact.slice(0, 2000))}...</existing_profile>`);
    } else {
      nodes.push(`  <existing_profile user_id="${escapeXml(actorId)}">${escapeXml(compact)}</existing_profile>`);
    }
  }
  return `\n<existing_profiles>\n${nodes.join("\n")}\n</existing_profiles>`;
}
