import {
  escapeXml,
  formatFallbackReplyToPreviewNode,
  formatIdentityEventNode,
  formatNormalMessageNode,
  formatParticipantNode,
  formatReplyToPreviewNode,
  formatResolvedTargetNode,
  formatTimestampUtc8,
  getDisplayName,
  getSenderEntityType,
  getSenderHandle,
  getSenderId,
  getSpeaker,
} from "../../utils/messageXml";
import type { ContextAssembler, ParticipantState, ResolvedTarget, UserProfileSummary } from "./core/types";
import type { TelegramMessage } from "../../types/message";
import { isKnownActorId } from "../../utils/actor";

type UnresolvedTargetQuery = {
  source: "display_name" | "mention_handle";
  matchType:
    | "ambiguous_display_name"
    | "display_name_not_resolved"
    | "approx_display_name"
    | "unknown_handle";
  rawText: string;
  closestDisplayName?: string;
  distance?: number;
};

export function createContextAssembler(): ContextAssembler {
  return {
    build: ({ contextMessages, recentMessages, targetMessages, supplementaryContext, triggerMessage, participants, identityEvents, resolvedTargets, systemPrompt, userProfiles }) => {
      const triggerId = triggerMessage.messageId;
      const normalizedRecent = recentMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const normalizedTargetMessages = targetMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const normalizedContext = contextMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const normalizedSupplementary = (supplementaryContext ?? [])
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const messageIndex = new Map<number, TelegramMessage>();
      for (const message of normalizedRecent) {
        messageIndex.set(message.messageId, message);
      }
      for (const message of normalizedTargetMessages) {
        messageIndex.set(message.messageId, message);
      }
      for (const message of normalizedContext) {
        messageIndex.set(message.messageId, message);
      }
      for (const message of normalizedSupplementary) {
        messageIndex.set(message.messageId, message);
      }

      const findReplyTarget = (replyToMessageId: number | null): TelegramMessage | undefined => {
        if (replyToMessageId === null) {
          return undefined;
        }
        return messageIndex.get(replyToMessageId);
      };

      const currentReplyPreview = buildReplyPreviewNode(
        triggerMessage,
        findReplyTarget(triggerMessage.metadata.replyToMessageId),
      );
      const currentReplyToAttribute = triggerMessage.metadata.replyToMessageId
        ? ` reply_to="${triggerMessage.metadata.replyToMessageId}"`
        : "";
      const currentSenderHandle = getSenderHandle(triggerMessage);
      const currentSenderHandleAttribute = currentSenderHandle
        ? ` sender_handle="${escapeXml(currentSenderHandle)}"`
        : "";
      const currentDisplayName = getDisplayName(triggerMessage);
      const currentDisplayNameAttribute = currentDisplayName
        ? ` display_name="${escapeXml(currentDisplayName)}"`
        : "";
      const participantsXml = participants.length > 0
        ? participants.map((participant) => `    ${formatParticipantNode(participant)}`).join("\n")
        : "";
      const identityEventsXml = identityEvents.length > 0
        ? identityEvents.map((event) => `    ${formatIdentityEventNode(event)}`).join("\n")
        : "";
      const resolvedTargetsXml = resolvedTargets.length > 0
        ? resolvedTargets.map((target) => `    ${formatResolvedTargetNode(target)}`).join("\n")
        : "";
      const userProfilesXml = formatUserProfilesXml(userProfiles);
      const supplementaryXml = normalizedSupplementary.length > 0
        ? `\n  <supplementary_context>\n${normalizedSupplementary.map((message) => formatNormalMessageNode(message,
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}\n  </supplementary_context>`
        : "";
      const compactTarget = pickCompactResolvedTarget(resolvedTargets, normalizedTargetMessages);
      const unresolvedTarget = compactTarget
        ? null
        : pickUnresolvedTargetQuery(triggerMessage, participants, resolvedTargets);
      const xml = compactTarget
        ? `<target_query>
  ${formatResolvedTargetNode(compactTarget)}
  <evidence>
${normalizedTargetMessages.map((message) => formatNormalMessageNode(
  message,
  findReplyTarget(message.metadata.replyToMessageId),
)).join("\n")}
  </evidence>
  <query id="${triggerMessage.messageId}" sender_id="${escapeXml(getSenderId(triggerMessage))}" sender_entity_type="${escapeXml(getSenderEntityType(triggerMessage))}" speaker="${escapeXml(getSpeaker(triggerMessage))}"${currentDisplayNameAttribute}${currentSenderHandleAttribute} timestamp="${formatTimestampUtc8(triggerMessage.timestamp)}"${currentReplyToAttribute}>
    ${currentReplyPreview}
    ${escapeXml(triggerMessage.context)}
  </query>
</target_query>`
        : unresolvedTarget
          ? `<unresolved_target_query>
  ${formatUnresolvedTargetNode(unresolvedTarget)}
  <query id="${triggerMessage.messageId}" sender_id="${escapeXml(getSenderId(triggerMessage))}" sender_entity_type="${escapeXml(getSenderEntityType(triggerMessage))}" speaker="${escapeXml(getSpeaker(triggerMessage))}"${currentDisplayNameAttribute}${currentSenderHandleAttribute} timestamp="${formatTimestampUtc8(triggerMessage.timestamp)}"${currentReplyToAttribute}>
    ${currentReplyPreview}
    ${escapeXml(triggerMessage.context)}
  </query>
</unresolved_target_query>`
        : `<context>
  <participants>
${participantsXml}
  </participants>
  <identity_events>
${identityEventsXml}
  </identity_events>
${userProfilesXml}  <target_actor_messages>
${normalizedTargetMessages.map((message) => formatNormalMessageNode(message,
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </target_actor_messages>
  <recent_messages>
${normalizedRecent.map((message) => formatNormalMessageNode(message,
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </recent_messages>
  <related_history>
${normalizedContext.map((message) => formatNormalMessageNode(message,
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </related_history>${supplementaryXml}
</context>
<current_message id="${triggerMessage.messageId}" sender_id="${escapeXml(getSenderId(triggerMessage))}" sender_entity_type="${escapeXml(getSenderEntityType(triggerMessage))}" speaker="${escapeXml(getSpeaker(triggerMessage))}"${currentDisplayNameAttribute}${currentSenderHandleAttribute} timestamp="${formatTimestampUtc8(triggerMessage.timestamp)}"${currentReplyToAttribute}>
  <resolved_targets>
${resolvedTargetsXml}
  </resolved_targets>
  ${currentReplyPreview}
  ${escapeXml(triggerMessage.context)}
</current_message>`;

      return [
        { role: "system", content: systemPrompt},
        { role: "user", content: xml }
      ];
    },
  };
}

function buildReplyPreviewNode(
  message: TelegramMessage,
  replyToMessage?: TelegramMessage
): string {
  if (replyToMessage) {
    return formatReplyToPreviewNode(replyToMessage);
  }
  if (message.metadata.replyToMessageId) {
    return formatFallbackReplyToPreviewNode(message);
  }
  return "";
}

function pickCompactResolvedTarget(
  resolvedTargets: ResolvedTarget[],
  targetMessages: TelegramMessage[],
) {
  if (targetMessages.length === 0) {
    return null;
  }
  const uniqueKnownActorIds = Array.from(new Set(
    resolvedTargets
      .map((target) => target.actorId)
      .filter((actorId): actorId is string => isKnownActorId(actorId)),
  ));
  if (uniqueKnownActorIds.length !== 1) {
    return null;
  }
  return resolvedTargets.find((target) => target.actorId === uniqueKnownActorIds[0]) ?? null;
}

function formatUnresolvedTargetNode(target: UnresolvedTargetQuery): string {
  const attrs = [
    `source="${escapeXml(target.source)}"`,
    `match_type="${escapeXml(target.matchType)}"`,
    `raw_text="${escapeXml(target.rawText)}"`,
  ];
  if (target.closestDisplayName) {
    attrs.push(`closest_display_name="${escapeXml(target.closestDisplayName)}"`);
  }
  if (typeof target.distance === "number") {
    attrs.push(`distance="${target.distance}"`);
  }
  return `<unresolved_target ${attrs.join(" ")} />`;
}

function pickUnresolvedTargetQuery(
  triggerMessage: TelegramMessage,
  participants: ParticipantState[],
  resolvedTargets: ResolvedTarget[],
): UnresolvedTargetQuery | null {
  const knownResolvedActorIds = resolvedTargets
    .map((target) => target.actorId)
    .filter((actorId): actorId is string => isKnownActorId(actorId));
  if (knownResolvedActorIds.length > 0) {
    return null;
  }

  const unresolvedHandle = resolvedTargets.find(
    (target) => target.via === "mention_handle" && !isKnownActorId(target.actorId),
  );
  if (unresolvedHandle) {
    const rawText = unresolvedHandle.usernameHandle ?? unresolvedHandle.displayName ?? "unknown";
    return {
      source: "mention_handle",
      matchType: "unknown_handle",
      rawText,
    };
  }

  const normalizedText = normalizeDisplayNameKey(
    stripLeadingVocative(triggerMessage.context, triggerMessage.metadata.isMentionMe),
  );
  if (!normalizedText) {
    return null;
  }

  const displayNameAliases = collectCurrentDisplayNameAliases(participants);
  if (displayNameAliases.length === 0) {
    return null;
  }

  const exactMatches = displayNameAliases
    .filter((alias) => containsDisplayNameReference(normalizedText, alias.key))
    .sort((a, b) => b.key.length - a.key.length);
  if (exactMatches.length > 0) {
    const primaryMatch = exactMatches[0];
    return {
      source: "display_name",
      matchType: primaryMatch.actorIds.length > 1
        ? "ambiguous_display_name"
        : "display_name_not_resolved",
      rawText: primaryMatch.displayName,
      closestDisplayName: primaryMatch.actorIds.length === 1 ? primaryMatch.displayName : undefined,
    };
  }

  const approximateMatch = findApproximateDisplayNameMatch(normalizedText, displayNameAliases);
  if (!approximateMatch) {
    return null;
  }
  return {
    source: "display_name",
    matchType: approximateMatch.actorIds.length > 1
      ? "ambiguous_display_name"
      : "approx_display_name",
    rawText: approximateMatch.rawText,
    closestDisplayName: approximateMatch.displayName,
    distance: approximateMatch.distance,
  };
}

function stripLeadingVocative(text: string, isMentionMe: boolean): string {
  if (!isMentionMe) {
    return text;
  }
  return text.trim().replace(/^[^,，:：]{1,64}[,，:：]\s*/u, "");
}

function normalizeDisplayNameKey(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim();
  return normalized ? normalized.toLowerCase() : null;
}

const displayNameRegexCache = new Map<string, RegExp>();
const DISPLAY_NAME_REGEX_CACHE_MAX = 500;

function containsDisplayNameReference(text: string, displayNameKey: string): boolean {
  if (displayNameKey.length < 2) {
    return false;
  }
  if (/^[a-z0-9_]+$/.test(displayNameKey)) {
    let re = displayNameRegexCache.get(displayNameKey);
    if (!re) {
      if (displayNameRegexCache.size >= DISPLAY_NAME_REGEX_CACHE_MAX) {
        const firstKey = displayNameRegexCache.keys().next().value;
        if (firstKey !== undefined) displayNameRegexCache.delete(firstKey);
      }
      const escaped = displayNameKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`);
      displayNameRegexCache.set(displayNameKey, re);
    }
    return re.test(text);
  }
  return text.includes(displayNameKey);
}

function collectCurrentDisplayNameAliases(
  participants: ParticipantState[],
): Array<{ key: string; displayName: string; actorIds: string[] }> {
  const aliases = new Map<string, { displayName: string; actorIds: Set<string> }>();
  for (const participant of participants) {
    if (!isKnownActorId(participant.actor.id)) {
      continue;
    }
    const displayName = (participant.actor.displayName ?? "").trim();
    const key = normalizeDisplayNameKey(displayName);
    if (!key || key.length < 2) {
      continue;
    }
    const existing = aliases.get(key);
    if (existing) {
      existing.actorIds.add(participant.actor.id);
      continue;
    }
    aliases.set(key, {
      displayName,
      actorIds: new Set([participant.actor.id]),
    });
  }
  return Array.from(aliases.entries()).map(([key, value]) => ({
    key,
    displayName: value.displayName,
    actorIds: Array.from(value.actorIds).sort(),
  }));
}

function findApproximateDisplayNameMatch(
  normalizedText: string,
  aliases: Array<{ key: string; displayName: string; actorIds: string[] }>,
): {
  rawText: string;
  displayName: string;
  actorIds: string[];
  distance: number;
} | null {
  const fragments = collectApproximateTargetFragments(normalizedText, aliases);
  let bestMatch: {
    rawText: string;
    displayName: string;
    actorIds: string[];
    distance: number;
    aliasKeyLength: number;
  } | null = null;

  for (const fragment of fragments) {
    for (const alias of aliases) {
      const maxDistance = 1;
      const distance = damerauLevenshtein(fragment, alias.key);
      if (distance > maxDistance) {
        continue;
      }
      if (
        !bestMatch ||
        distance < bestMatch.distance ||
        (distance === bestMatch.distance && alias.key.length > bestMatch.aliasKeyLength)
      ) {
        bestMatch = {
          rawText: fragment,
          displayName: alias.displayName,
          actorIds: alias.actorIds,
          distance,
          aliasKeyLength: alias.key.length,
        };
      }
    }
  }
  if (!bestMatch) {
    return null;
  }
  return {
    rawText: bestMatch.rawText,
    displayName: bestMatch.displayName,
    actorIds: bestMatch.actorIds,
    distance: bestMatch.distance,
  };
}

function collectApproximateTargetFragments(
  normalizedText: string,
  aliases: Array<{ key: string }>,
): string[] {
  const fragments = new Set<string>();
  for (const token of normalizedText.match(/[a-z0-9_@.\-]+/giu) ?? []) {
    const normalized = token.trim().toLowerCase();
    if (normalized.length >= 2) {
      fragments.add(normalized);
    }
  }

  const nonAsciiAliasLengths = Array.from(new Set(
    aliases
      .filter((alias) => !/^[a-z0-9_]+$/.test(alias.key))
      .map((alias) => Array.from(alias.key).length),
  ));
  if (nonAsciiAliasLengths.length === 0) {
    return Array.from(fragments);
  }

  const trimmed = normalizedText.trim();
  const leadingRun = extractLeadingNonAsciiRun(trimmed);
  if (!leadingRun) {
    return Array.from(fragments);
  }
  const leadingChars = Array.from(leadingRun);
  for (const aliasLength of nonAsciiAliasLengths) {
    for (const candidateLength of new Set([aliasLength - 1, aliasLength, aliasLength + 1])) {
      if (candidateLength < 2 || candidateLength > leadingChars.length) {
        continue;
      }
      fragments.add(leadingChars.slice(0, candidateLength).join(""));
    }
  }

  return Array.from(fragments);
}

function extractLeadingNonAsciiRun(value: string): string {
  const match = value.match(/^[^\s,，:：!?？！]+/u);
  return match?.[0] ?? "";
}

function damerauLevenshtein(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i += 1) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      let distance = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + substitutionCost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        distance = Math.min(distance, matrix[i - 2]![j - 2]! + 1);
      }
      matrix[i]![j] = distance;
    }
  }

  return matrix[a.length]![b.length]!;
}

const PROFILE_SUMMARY_MAX_LENGTH = 200;

function formatUserProfilesXml(profiles?: UserProfileSummary[]): string {
  if (!profiles || profiles.length === 0) return "";
  const nodes: string[] = [];
  for (const profile of profiles) {
    const summary = summarizeProfile(profile);
    if (!summary) continue;
    const displayNameAttr = profile.displayName
      ? ` display_name="${escapeXml(profile.displayName)}"`
      : "";
    nodes.push(`    <profile actor_id="${escapeXml(profile.actorId)}"${displayNameAttr}>${escapeXml(summary)}</profile>`);
  }
  if (nodes.length === 0) return "";
  return `  <user_profiles>\n${nodes.join("\n")}\n  </user_profiles>\n`;
}

function summarizeProfile(profile: UserProfileSummary): string {
  const parts: string[] = [];
  if (profile.preferences && typeof profile.preferences === "object") {
    const entries = flattenProfileObject(profile.preferences);
    if (entries) parts.push(entries);
  }
  if (profile.techProjects && typeof profile.techProjects === "object") {
    const entries = flattenProfileObject(profile.techProjects);
    if (entries) parts.push(entries);
  }
  if (profile.relations && Array.isArray(profile.relations) && profile.relations.length > 0) {
    const relSummary = profile.relations
      .slice(0, 3)
      .map((r) => typeof r === "object" && r ? flattenProfileObject(r as Record<string, unknown>) : String(r))
      .filter(Boolean)
      .join("; ");
    if (relSummary) parts.push(relSummary);
  }
  const combined = parts.join(" | ");
  if (combined.length > PROFILE_SUMMARY_MAX_LENGTH) {
    return combined.slice(0, PROFILE_SUMMARY_MAX_LENGTH - 3) + "...";
  }
  return combined;
}

function flattenProfileObject(obj: Record<string, unknown>): string {
  const entries: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      entries.push(`${key}: ${value.join(", ")}`);
    } else if (typeof value === "object") {
      const nested = flattenProfileObject(value as Record<string, unknown>);
      if (nested) entries.push(`${key}: ${nested}`);
    } else {
      entries.push(`${key}: ${String(value)}`);
    }
  }
  return entries.join("; ");
}
