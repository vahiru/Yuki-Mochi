import type { ActorRef, TelegramMessage, TelegramSenderEntityType } from "../types/message";

export function isKnownActorId(value: string | null | undefined): value is string {
  const normalized = (value ?? "").trim();
  return normalized !== "" && normalized !== "unknown";
}

export function normalizeUsernameHandle(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("@") ? normalized : `@${normalized}`;
}

export function usernameFromHandle(value: string | null | undefined): string | null {
  const normalized = normalizeUsernameHandle(value);
  if (!normalized) {
    return null;
  }
  return normalized.slice(1) || null;
}

export function normalizeDisplayName(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim();
  return normalized || null;
}

export function inferSenderEntityTypeFromId(
  actorId: string | null | undefined,
  fallback: TelegramSenderEntityType = "unknown",
): TelegramSenderEntityType {
  const normalized = (actorId ?? "").trim();
  if (!normalized || normalized === "unknown") {
    return fallback;
  }
  if (normalized.startsWith("channel:")) {
    return "channel";
  }
  if (normalized.startsWith("chat:")) {
    return "chat";
  }
  return "user";
}

export function createActorRef(input: {
  id: string | null | undefined;
  entityType?: TelegramSenderEntityType | null;
  displayName?: string | null;
  username?: string | null;
  usernameHandle?: string | null;
  isBot?: boolean;
}): ActorRef | null {
  const id = (input.id ?? "").trim();
  if (!id) {
    return null;
  }
  const usernameHandle = normalizeUsernameHandle(input.usernameHandle ?? input.username);
  const username = (input.username ?? "").trim() || usernameFromHandle(usernameHandle);
  return {
    id,
    entityType: inferSenderEntityTypeFromId(id, input.entityType ?? "unknown"),
    displayName: normalizeDisplayName(input.displayName),
    username: username || null,
    usernameHandle,
    isBot: input.isBot ?? false,
  };
}

export function mergeActorRef(base: ActorRef | null | undefined, incoming: ActorRef | null | undefined): ActorRef | null {
  if (!base && !incoming) {
    return null;
  }
  if (!base) {
    return incoming ? { ...incoming } : null;
  }
  if (!incoming) {
    return { ...base };
  }
  return {
    id: incoming.id || base.id,
    entityType:
      incoming.entityType !== "unknown"
        ? incoming.entityType
        : base.entityType,
    displayName: normalizeDisplayName(incoming.displayName) ?? normalizeDisplayName(base.displayName),
    username: (incoming.username ?? "").trim() || (base.username ?? "").trim() || null,
    usernameHandle: normalizeUsernameHandle(incoming.usernameHandle) ?? normalizeUsernameHandle(base.usernameHandle),
    isBot: incoming.isBot || base.isBot,
  };
}

export function buildSenderActorRef(message: TelegramMessage): ActorRef | null {
  return mergeActorRef(
    message.sender,
    createActorRef({
      id: message.userId,
      entityType: message.metadata.senderEntityType,
      displayName: message.metadata.username,
      usernameHandle: message.metadata.usernameHandle,
      isBot: message.metadata.isBot,
    }),
  );
}

export function buildReplyActorRef(message: TelegramMessage): ActorRef | null {
  return mergeActorRef(
    message.metadata.replyToSender,
    createActorRef({
      id: message.metadata.replyToUserId,
      entityType: inferSenderEntityTypeFromId(message.metadata.replyToUserId),
      displayName: message.metadata.replyToUsername,
      usernameHandle: message.metadata.replyToUsername,
      isBot: false,
    }),
  );
}

export function buildMentionActorRefs(
  message: TelegramMessage,
  resolveHandleToActorId?: (handle: string) => string | null,
): ActorRef[] {
  const out: ActorRef[] = [];
  const seen = new Set<string>();
  const push = (actor: ActorRef | null, dedupeKey?: string) => {
    if (!actor) {
      return;
    }
    const key = dedupeKey ?? actor.id;
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(actor);
  };

  for (const actor of message.metadata.mentionedActors ?? []) {
    push(actor);
  }
  for (const actorId of message.metadata.mentionUserIds ?? []) {
    push(
      createActorRef({
        id: actorId,
        entityType: inferSenderEntityTypeFromId(actorId),
      }),
    );
  }
  for (const handle of message.metadata.mentions ?? []) {
    const usernameHandle = normalizeUsernameHandle(handle);
    if (!usernameHandle) {
      continue;
    }
    const resolvedActorId = resolveHandleToActorId?.(usernameHandle) ?? null;
    push(
      createActorRef({
        id: resolvedActorId ?? "unknown",
        entityType: inferSenderEntityTypeFromId(resolvedActorId),
        usernameHandle,
        username: usernameFromHandle(usernameHandle),
      }),
      resolvedActorId ?? `handle:${usernameHandle}`,
    );
  }
  return out;
}

export function hydrateMessageActors(
  message: TelegramMessage,
  options?: {
    resolveHandleToActorId?: (handle: string) => string | null;
    fallbackReplyToSender?: ActorRef | null;
  },
): TelegramMessage {
  const sender = buildSenderActorRef(message);
  const replyToSender = mergeActorRef(buildReplyActorRef(message), options?.fallbackReplyToSender);
  const mentionedActors = buildMentionActorRefs(message, options?.resolveHandleToActorId)
    .filter((actor) => isKnownActorId(actor.id));
  return {
    ...message,
    ...(sender ? { sender } : {}),
    metadata: {
      ...message.metadata,
      ...(replyToSender ? { replyToSender } : {}),
      mentionedActors,
    },
  };
}
