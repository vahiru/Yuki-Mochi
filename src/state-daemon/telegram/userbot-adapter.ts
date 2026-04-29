import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { CustomFile } from "telegram/client/uploads";
import type {
  TelegramAdapter,
  TelegramMessage,
  StreamState,
  TelegramOutgoingMediaItem,
  TelegramSendMediaBatchResult,
} from "./types";
import type { TelegramSenderEntityType } from "../types/message";
import fs from "node:fs/promises";
import { basename, extname } from "node:path";
import { createCustomEmojiToTextResolver } from "./custom-emoji-to-text";
import { createImageAltTextStore } from "./image-to-text-store";
import type { CustomEmojiToTextConfig } from "./index";
import { hydrateMessageActors } from "../utils/actor";

const DEFAULT_FINAL_TEXT = "(empty)";
const DEFAULT_STREAM_PLACEHOLDER = "Working on it... estimated 30-90 seconds.";
const STREAM_EDIT_THROTTLE_MS = 1200;
const MEDIA_GROUP_FLUSH_DELAY_MS = 300;

interface CustomEmojiOccurrence {
  customEmojiId: string;
  fallbackEmoji: string;
  offset: number;
  length: number;
}

interface ResolvedCustomEmojiInfo {
  packName?: string;
  altText?: string;
  errorText?: string;
}

interface MentionExtraction {
  mentions: string[];
  mentionUserIds: string[];
}

type TelegramResolvedEntity = Api.User | Api.Chat | Api.Channel;

export interface UserBotAdapterOptions {
  apiId: number;
  apiHash: string;
  phoneNumber?: string;
  password?: string;
  sessionString?: string;
  customEmojiToText?: CustomEmojiToTextConfig;
}

export function createUserBotAdapter(options: UserBotAdapterOptions): TelegramAdapter {
  const client = new TelegramClient(new StringSession(options.sessionString || ""), options.apiId, options.apiHash, { connectionRetries: 10, useWSS: false, autoReconnect: true });
  const sentMessageIds = new Set<string>();
  const SENT_IDS_MAX = 10_000;
  const messageAuthorByChat = new Map<number, Map<number, string>>();
  const AUTHOR_PER_CHAT_MAX = 5_000;
  const messagePreviewByChat = new Map<
    number,
    Map<number, { displayName: string | null; usernameHandle: string | null; previewText: string | null }>
  >();
  const streams = new Map<number, StreamState>();
  let nextStreamId = 1;
  const messageHandlers = new Set<any>();
  let me: Api.User | null = null;

  // Media-group cache, aligned with adapter.ts behavior.
  const pendingMediaGroups = new Map<
    string,
    {
      msg: Api.Message;
      photoCount: number;
      photoPaths: string[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const stickerSetNameCache = new Map<string, string | null>();
  const documentCache = new Map<string, Api.Document>();

  const resolveStickerSetName = async (stickerSet: Api.TypeInputStickerSet): Promise<string | undefined> => {
    if (stickerSet instanceof Api.InputStickerSetShortName) {
      const shortName = stickerSet.shortName?.trim() || "";
      if (shortName) {
        return shortName;
      }
    }

    const key = buildStickerSetCacheKey(stickerSet);
    if (!key) {
      return undefined;
    }
    if (stickerSetNameCache.has(key)) {
      return stickerSetNameCache.get(key) ?? undefined;
    }

    try {
      const result = await client.invoke(
        new Api.messages.GetStickerSet({
          stickerset: stickerSet,
          hash: 0,
        })
      );
      if (result instanceof Api.messages.StickerSet && result.set instanceof Api.StickerSet) {
        const title = result.set.title?.trim() || "";
        const shortName = result.set.shortName?.trim() || "";
        const resolved = title || shortName || null;
        stickerSetNameCache.set(key, resolved);
        return resolved ?? undefined;
      }
      stickerSetNameCache.set(key, null);
      return undefined;
    } catch (error) {
      console.warn("[userbot] GetStickerSet failed:", error);
      stickerSetNameCache.set(key, null);
      return undefined;
    }
  };

  const customEmojiStore = createImageAltTextStore(options.customEmojiToText?.dbPath);
  customEmojiStore.hydrate();

  const customEmojiResolver = createCustomEmojiToTextResolver({
    enabled: options.customEmojiToText?.enabled ?? false,
    model: options.customEmojiToText?.model
      ? {
          model: options.customEmojiToText.model,
          baseURL: options.customEmojiToText.baseURL,
          apiKey: options.customEmojiToText.apiKey,
        }
      : undefined,
    maxConcurrency: options.customEmojiToText?.maxConcurrency,
    maxFrames: options.customEmojiToText?.maxFrames,
    lookupByHash: customEmojiStore.lookupByHash,
    persist: customEmojiStore.persist,
    getCustomEmojiStickers: async (customEmojiIds) => {
      const docIds = customEmojiIds
        .map((item) => parseDocumentId(item))
        .filter((item): item is string => item !== null);
      if (docIds.length === 0) {
        return [];
      }

      const documents = await client.invoke(
        new Api.messages.GetCustomEmojiDocuments({
          documentId: docIds as any,
        })
      );

      const results: Array<{
        id: string;
        file_id: string;
        is_animated: boolean;
        is_video: boolean;
        mime_type?: string;
        set_name?: string;
      }> = [];
      for (const document of documents) {
        if (!(document instanceof Api.Document)) {
          continue;
        }
        const id = document.id.toString();
        documentCache.set(id, document);
        const mimeType = document.mimeType || undefined;

        let setName: string | undefined;
        let isAnimated = mimeType === "application/x-tgsticker";
        let isVideo = mimeType === "video/webm" || mimeType === "video/mp4";
        for (const attribute of document.attributes) {
          if (attribute instanceof Api.DocumentAttributeCustomEmoji) {
            setName = await resolveStickerSetName(attribute.stickerset);
            continue;
          }
          if (attribute instanceof Api.DocumentAttributeAnimated) {
            isAnimated = true;
          }
          if (attribute instanceof Api.DocumentAttributeVideo) {
            isVideo = true;
          }
        }

        results.push({
          id,
          file_id: id,
          is_animated: isAnimated,
          is_video: isVideo,
          mime_type: mimeType,
          set_name: setName,
        });
      }
      return results;
    },
    downloadFile: async (fileId) => {
      const existing = documentCache.get(fileId);
      let document = existing;
      if (!document) {
        const documents = await client.invoke(
          new Api.messages.GetCustomEmojiDocuments({
            documentId: [fileId as any],
          })
        );
        for (const item of documents) {
          if (item instanceof Api.Document && item.id.toString() === fileId) {
            document = item;
            documentCache.set(fileId, item);
            break;
          }
        }
      }
      if (!document) {
        throw new Error(`document not found for custom emoji id: ${fileId}`);
      }
      const media = await client.downloadMedia(document as any, { workers: 1 } as any);
      if (!(media instanceof Buffer)) {
        throw new Error(`failed to download document buffer for ${fileId}`);
      }
      return media;
    },
    resolvePackTitle: async (setName) => setName,
  });

  const getSafeEntity = async (id: any) => {
    const ids = [id, id.toString()];
    if (typeof id === 'number' && id > 0) ids.push(-id);
    for (const target of ids) {
      try { return await client.getEntity(target); } catch {}
    }
    try { return await client.getEntity(BigInt(id) as any); } catch {}
    throw new Error("Could not find entity for " + id);
  };

  const setTyping = async (chatId: any) => {
    try {
      const target = await getSafeEntity(chatId);
      await client.invoke(new Api.messages.SetTyping({
        peer: target,
        action: new Api.SendMessageTypingAction(),
      }));
    } catch (e) {}
  };


  const sentMessageKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

  const rememberSentMessage = (chatId: number, messageId: number): void => {
    sentMessageIds.add(sentMessageKey(chatId, messageId));
    if (sentMessageIds.size > SENT_IDS_MAX) {
      const first = sentMessageIds.values().next().value;
      if (first !== undefined) sentMessageIds.delete(first);
    }
  };

  const hasSentMessage = (chatId: number, messageId: number): boolean => {
    return sentMessageIds.has(sentMessageKey(chatId, messageId));
  };

  const rememberMessageAuthor = (
    chatId: number,
    messageId: number,
    userId: string | null | undefined,
  ): void => {
    const normalized = (userId ?? "").trim();
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId) || !normalized) {
      return;
    }
    let bucket = messageAuthorByChat.get(chatId);
    if (!bucket) {
      bucket = new Map<number, string>();
      messageAuthorByChat.set(chatId, bucket);
    }
    bucket.set(messageId, normalized);
    if (bucket.size > AUTHOR_PER_CHAT_MAX) {
      const firstKey = bucket.keys().next().value;
      if (firstKey !== undefined) bucket.delete(firstKey);
    }
  };

  const getRememberedMessageAuthor = (chatId: number, messageId: number): string | null => {
    return messageAuthorByChat.get(chatId)?.get(messageId) ?? null;
  };

  const rememberMessagePreview = (
    chatId: number,
    messageId: number,
    displayName: string | null | undefined,
    usernameHandle: string | null | undefined,
    previewText: string | null | undefined,
  ): void => {
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) {
      return;
    }
    let bucket = messagePreviewByChat.get(chatId);
    if (!bucket) {
      bucket = new Map<number, { displayName: string | null; usernameHandle: string | null; previewText: string | null }>();
      messagePreviewByChat.set(chatId, bucket);
    }
    bucket.set(messageId, {
      displayName: (displayName ?? "").trim() || null,
      usernameHandle: normalizeUsernameHandle(usernameHandle ?? undefined),
      previewText: normalizeReplyPreviewText(previewText),
    });
    if (bucket.size > AUTHOR_PER_CHAT_MAX) {
      const firstKey = bucket.keys().next().value;
      if (firstKey !== undefined) bucket.delete(firstKey);
    }
  };

  const getRememberedMessagePreview = (
    chatId: number,
    messageId: number,
  ): { displayName: string | null; usernameHandle: string | null; previewText: string | null } | null => {
    return messagePreviewByChat.get(chatId)?.get(messageId) ?? null;
  };

  const rememberOutgoingMessage = (chatId: number, message: Api.Message): void => {
    rememberSentMessage(chatId, message.id);
    const senderIdentity = resolveSenderIdentityFromPeer(message.fromId);
    const fromUserId =
      senderIdentity.userId !== "unknown"
        ? senderIdentity.userId
        : me?.id?.toString() ?? null;
    rememberMessageAuthor(chatId, message.id, fromUserId);
    const senderName = me ? buildDisplayNameFromUser(me) : null;
    rememberMessagePreview(
      chatId,
      message.id,
      senderName,
      normalizeUsernameHandle(me?.username),
      extractReplyPreviewFromApiMessage(message),
    );
  };

  const buildDisplayNameFromUser = (user: Api.User): string | null => {
    const firstName = (user.firstName || "").trim();
    const lastName = (user.lastName || "").trim();
    const fullName = `${firstName} ${lastName}`.trim();
    if (fullName) {
      return fullName;
    }
    const username = (user.username || "").trim();
    return username || null;
  };

  const buildDisplayNameFromEntity = (entity: Api.User | Api.Chat | Api.Channel): string | null => {
    if (entity instanceof Api.User) {
      return buildDisplayNameFromUser(entity);
    }
    return entity.title?.trim() || null;
  };

  const getResolvedEntityFromMessage = (
    message: Partial<{
      sender: unknown;
      _sender: unknown;
      getSender: () => Promise<unknown>;
    }>,
  ): Promise<TelegramResolvedEntity | null> | TelegramResolvedEntity | null => {
    const directCandidates = [message.sender, message._sender];
    for (const candidate of directCandidates) {
      if (
        candidate instanceof Api.User ||
        candidate instanceof Api.Chat ||
        candidate instanceof Api.Channel
      ) {
        return candidate;
      }
    }
    if (typeof message.getSender === "function") {
      return message.getSender().then((candidate) => {
        if (
          candidate instanceof Api.User ||
          candidate instanceof Api.Chat ||
          candidate instanceof Api.Channel
        ) {
          return candidate;
        }
        return null;
      }).catch(() => null);
    }
    return null;
  };

  const resolveSenderIdentityFromPeer = (
    peer: Api.TypePeer | undefined | null,
  ): { userId: string; senderEntityType: TelegramSenderEntityType } => {
    if (peer instanceof Api.PeerUser) {
      return {
        userId: peer.userId.toString(),
        senderEntityType: "user",
      };
    }
    if (peer instanceof Api.PeerChat) {
      return {
        userId: `chat:${peer.chatId.toString()}`,
        senderEntityType: "chat",
      };
    }
    if (peer instanceof Api.PeerChannel) {
      return {
        userId: `channel:${peer.channelId.toString()}`,
        senderEntityType: "channel",
      };
    }
    return {
      userId: "unknown",
      senderEntityType: "unknown",
    };
  };

  const downloadPhoto = async (msg: Api.Message): Promise<string | null> => {
    if (!(msg.media instanceof Api.MessageMediaPhoto)) return null;
    try {
      const downloaded = await client.downloadMedia(msg.media as any, { workers: 1 } as any);
      let buffer: Buffer | null = null;
      if (Buffer.isBuffer(downloaded)) {
        buffer = downloaded;
      } else if (ArrayBuffer.isView(downloaded)) {
        buffer = Buffer.from(downloaded.buffer, downloaded.byteOffset, downloaded.byteLength);
      }

      if (buffer) {
        const fileName = `vision-${msg.peerId?.toJSON()}-${msg.id}.jpg`;
        const filePath = `/tmp/kairos-vision/${fileName}`;
        await fs.mkdir("/tmp/kairos-vision", { recursive: true });
        await fs.writeFile(filePath, buffer);
        return filePath;
      }
      console.warn(
        "[userbot] downloadMedia returned unsupported photo payload type:",
        typeof downloaded,
      );
    } catch (e) {
      console.error("[userbot] Failed to download media:", e);
    }
    return null;
  };

  const flushMediaGroup = async (key: string) => {
    const pending = pendingMediaGroups.get(key);
    if (!pending) return;
    pendingMediaGroups.delete(key);

    const m = await toTelegramMessage(pending.msg, pending.photoCount, pending.photoPaths);
    if (m) {
      for (const h of messageHandlers) void Promise.resolve(h(m)).catch(e => console.error(e));
    }
  };


  const resolveReplyTarget = async (
    chatId: number,
    replyToMsgId: number | null,
  ): Promise<{
    isReplyToMe: boolean;
    replyToUserId: string | null;
    replyToUsername: string | null;
    replyToUsernameHandle: string | null;
    replyToPreviewText: string | null;
  }> => {
    if (!me || replyToMsgId === null) {
      return {
        isReplyToMe: false,
        replyToUserId: null,
        replyToUsername: null,
        replyToUsernameHandle: null,
        replyToPreviewText: null,
      };
    }

    const meUserId = me.id.toString();
    const rememberedUserId = getRememberedMessageAuthor(chatId, replyToMsgId);
    const rememberedPreview = getRememberedMessagePreview(chatId, replyToMsgId);
    if (rememberedUserId) {
      return {
        isReplyToMe: rememberedUserId === meUserId,
        replyToUserId: rememberedUserId,
        replyToUsername: rememberedPreview?.displayName ?? rememberedUserId,
        replyToUsernameHandle: rememberedPreview?.usernameHandle ?? null,
        replyToPreviewText: rememberedPreview?.previewText ?? null,
      };
    }

    if (hasSentMessage(chatId, replyToMsgId)) {
      rememberMessageAuthor(chatId, replyToMsgId, meUserId);
      const meName = buildDisplayNameFromUser(me);
      const meUsernameHandle = normalizeUsernameHandle(me.username);
      rememberMessagePreview(chatId, replyToMsgId, meName, meUsernameHandle, null);
      return {
        isReplyToMe: true,
        replyToUserId: meUserId,
        replyToUsername: meName ?? meUserId,
        replyToUsernameHandle: meUsernameHandle,
        replyToPreviewText: null,
      };
    }

    try {
      const target = await getSafeEntity(chatId);
      const fetched = await (client as any).getMessages(target, {
        ids: [replyToMsgId],
      });
      const repliedMessage = Array.isArray(fetched)
        ? fetched[0]
        : (fetched as { [index: number]: unknown })?.[0] ?? fetched;

      if (repliedMessage instanceof Api.Message) {
        const repliedFromId = repliedMessage.fromId;
        const replyIdentity = resolveSenderIdentityFromPeer(repliedFromId);
        if (replyIdentity.userId !== "unknown") {
          const replyToUserId = replyIdentity.userId;
          let replyToUsername: string | null = replyToUserId;
          let replyToUsernameHandle: string | null = null;
          const localEntity = await getResolvedEntityFromMessage(repliedMessage);
          if (
            localEntity instanceof Api.User ||
            localEntity instanceof Api.Chat ||
            localEntity instanceof Api.Channel
          ) {
            replyToUsername = buildDisplayNameFromEntity(localEntity) ?? replyToUserId;
            replyToUsernameHandle =
              localEntity instanceof Api.User || localEntity instanceof Api.Channel
                ? normalizeUsernameHandle(localEntity.username)
                : null;
          } else if (repliedFromId) {
            try {
              const entity = await client.getEntity(repliedFromId);
              if (
                entity instanceof Api.User ||
                entity instanceof Api.Chat ||
                entity instanceof Api.Channel
              ) {
                replyToUsername = buildDisplayNameFromEntity(entity) ?? replyToUserId;
                replyToUsernameHandle =
                  entity instanceof Api.User || entity instanceof Api.Channel
                    ? normalizeUsernameHandle(entity.username)
                    : null;
              }
            } catch {
              // Keep stable id fallback.
            }
          }
          const replyToPreviewText = extractReplyPreviewFromApiMessage(repliedMessage);
          rememberMessageAuthor(chatId, replyToMsgId, replyToUserId);
          rememberMessagePreview(chatId, replyToMsgId, replyToUsername, replyToUsernameHandle, replyToPreviewText);
          const isReplyToMe = replyToUserId === meUserId;
          if (isReplyToMe) {
            rememberSentMessage(chatId, replyToMsgId);
          }
          return {
            isReplyToMe,
            replyToUserId,
            replyToUsername,
            replyToUsernameHandle,
            replyToPreviewText,
          };
        }
      }
    } catch (error) {
      console.warn(
        `[userbot] Failed to resolve reply target chat=${chatId} replyTo=${replyToMsgId}:`,
        error,
      );
    }

    return {
      isReplyToMe: false,
      replyToUserId: null,
      replyToUsername: null,
      replyToUsernameHandle: null,
      replyToPreviewText: null,
    };
  };
  const toTelegramMessage = async (msg: Api.Message, photoCountOverride?: number, photoPaths?: string[]): Promise<TelegramMessage | null> => {
    if (!me || !msg.peerId) return null;
    const fromId = msg.fromId;
    const senderIdentity = resolveSenderIdentityFromPeer(fromId);
    const userId = senderIdentity.userId;
    const senderEntityType = senderIdentity.senderEntityType;

    const chatId = msg.peerId instanceof Api.PeerUser ? msg.peerId.userId.toJSNumber() :
                   (msg.peerId instanceof Api.PeerChat ? msg.peerId.chatId.toJSNumber() :
                   (msg.peerId instanceof Api.PeerChannel ? msg.peerId.channelId.toJSNumber() : 0));
    rememberMessageAuthor(chatId, msg.id, userId);

    if (senderEntityType === "user" && userId === me.id.toString()) return null;

    const conversationType = msg.peerId instanceof Api.PeerUser ? "private" : "group";
    const replyToMsgIdRaw =
      msg.replyTo instanceof Api.MessageReplyHeader ? msg.replyTo.replyToMsgId : null;
    const replyToMsgId = typeof replyToMsgIdRaw === "number" ? replyToMsgIdRaw : null;

    // Reply detection (cache + network fallback for post-restart historical replies).
    const replyTarget = await resolveReplyTarget(chatId, replyToMsgId);
    const isReplyToMe = replyTarget.isReplyToMe;
    
    // Detect bot-like sender and resolve display name.
    let isBot = false;
    let senderName: string | null = null;
    let senderUsernameHandle: string | null = null;
    let senderEntity = await getResolvedEntityFromMessage(msg);
    if (!senderEntity) {
      try {
        if (fromId) {
          senderEntity = await client.getEntity(fromId) as TelegramResolvedEntity;
        }
      } catch (e) {
        console.warn(`[userbot] Failed to get entity for ${fromId}:`, e);
      }
    }
    if (senderEntity instanceof Api.User) {
      const username = senderEntity.username || "";
      isBot = senderEntity.bot || username.toLowerCase().includes("bot") || false;
      senderName = buildDisplayNameFromEntity(senderEntity);
      senderUsernameHandle = normalizeUsernameHandle(senderEntity.username);
    } else if (senderEntity instanceof Api.Chat || senderEntity instanceof Api.Channel) {
      senderName = buildDisplayNameFromEntity(senderEntity);
    }

    const photoCount = photoCountOverride ?? (msg.media instanceof Api.MessageMediaPhoto ? 1 : 0);
    const photoPlaceholder = photoCount <= 0 ? "" : (photoCount === 1 ? " [photo]" : ` [photo x${photoCount}]`);

    const imageUrls = photoPaths || [];
    if (!photoPaths && msg.media instanceof Api.MessageMediaPhoto) {
      const path = await downloadPhoto(msg);
      if (path) imageUrls.push(path);
    }

    const rawContext = msg.message || "";
    const text = rawContext.toLowerCase();
    const mentionExtraction = extractMentionsFromMessageEntities(rawContext, msg.entities);
    const myUsername = (me.username || "").toLowerCase();
    const myUsernameHandle = normalizeUsernameHandle(me.username);
    const hasTextHandleMention = myUsername ? text.includes(`@${myUsername}`) : false;
    const hasEntityHandleMention = Boolean(
      myUsernameHandle && mentionExtraction.mentions.includes(myUsernameHandle),
    );
    const hasEntityUserIdMention = mentionExtraction.mentionUserIds.includes(me.id.toString());
    // Mention heuristic: always trigger in private chats, or when explicitly @mentioned / entity mentioned.
    const isMentionMe =
      conversationType === "private" ||
      hasTextHandleMention ||
      hasEntityHandleMention ||
      hasEntityUserIdMention;

    const customEmojiOccurrences = extractCustomEmojiOccurrencesFromMessage(
      rawContext,
      msg.entities
    );
    const emojiIds = new Map<string, string>();
    for (const occurrence of customEmojiOccurrences) {
      if (!emojiIds.has(occurrence.customEmojiId)) {
        emojiIds.set(occurrence.customEmojiId, occurrence.fallbackEmoji);
      }
    }
    await customEmojiResolver.resolve(emojiIds);
    const customEmojiInfoById = new Map<string, ResolvedCustomEmojiInfo>();
    for (const [id] of emojiIds) {
      const info = {
        packName: customEmojiResolver.getPackName(id),
        altText: customEmojiResolver.getAltText(id),
        errorText: customEmojiResolver.getError(id),
      };
      customEmojiInfoById.set(id, info);
    }
    const renderedContext = renderTextWithCustomEmojiTags(
      rawContext,
      customEmojiOccurrences,
      customEmojiInfoById
    );
    rememberMessagePreview(chatId, msg.id, senderName, senderUsernameHandle, renderedContext + photoPlaceholder);

    console.log(`[userbot] Ingested: from=${userId} (${senderName}) chat=${chatId} text="${text.slice(0, 20)}..." photo=${photoCount} mention=${isMentionMe} reply=${isReplyToMe} replyTo=${replyToMsgId === null ? "-" : replyToMsgId}`);

    return hydrateMessageActors({
      userId, messageId: msg.id, chatId, conversationType, 
      context: renderedContext + photoPlaceholder,
      timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
      imageUrls,
      metadata: {
        isBot,
        isSelf: false,
        username: senderName,
        usernameHandle: senderUsernameHandle,
        senderEntityType,
        replyToMessageId: replyToMsgId,
        replyToUserId: replyTarget.replyToUserId,
        replyToUsername: replyTarget.replyToUsername,
        replyToUsernameHandle: replyTarget.replyToUsernameHandle,
        replyToPreviewText: replyTarget.replyToPreviewText,
        isReplyToMe,
        isMentionMe,
        mentions: mentionExtraction.mentions,
        mentionUserIds: mentionExtraction.mentionUserIds,
      }
    });
  };

  const renderStreamPreview = (state: StreamState): string => {
    const content = state.chunks.join("");
    if (content) {
      if (state.statusText) {
        return `${state.statusText}\n\n${content}\n\n...`;
      }
      return `${content}\n\n...`;
    }
    return state.statusText ?? DEFAULT_STREAM_PLACEHOLDER;
  };

  const editStreamMessage = async (state: StreamState, text: string) => {
    if (!state.placeholderMessageId) {
      return;
    }
    const target = await getSafeEntity(state.chatId);
    await (client as any).editMessage(target, {
      message: state.placeholderMessageId,
      text,
    });
    state.lastRenderedText = text;
    state.lastFlushAtMs = Date.now();
  };

  const deleteStreamMessage = async (state: StreamState): Promise<void> => {
    if (!state.placeholderMessageId) {
      return;
    }
    try {
      const target = await getSafeEntity(state.chatId);
      await (client as any).deleteMessages(target, [state.placeholderMessageId], {
        revoke: true,
      });
    } catch (error) {
      console.warn("[userbot] failed to delete stream placeholder:", error);
    }
  };

  const flushStreamPreview = async (state: StreamState, force = false) => {
    if (!state.placeholderMessageId) {
      return;
    }
    const now = Date.now();
    if (!force && now - state.lastFlushAtMs < STREAM_EDIT_THROTTLE_MS) {
      return;
    }
    const preview = renderStreamPreview(state);
    if (!preview || preview === state.lastRenderedText) {
      return;
    }
    try {
      await editStreamMessage(state, preview);
    } catch (error) {
      console.warn("[userbot] stream preview edit failed:", error);
    }
  };


  return {
    start: async () => {
      await client.connect();
      me = await client.getMe() as Api.User;
      console.log(`UserBot logged in as ${me.firstName} (@${me.username}) (ID: ${me.id})`);

      client.addEventHandler(async (ev) => {
        const msg = ev.message;
        if (!(msg instanceof Api.Message)) return;

        try {
          const mediaGroupId = (msg as Api.Message & { mediaGroupId?: unknown }).mediaGroupId;
          const mediaGroupIdText = mediaGroupId != null ? String(mediaGroupId) : null;
          if (mediaGroupIdText) {
            const chatId = msg.peerId instanceof Api.PeerUser ? msg.peerId.userId.toJSNumber() :
                          (msg.peerId instanceof Api.PeerChat ? msg.peerId.chatId.toJSNumber() :
                          (msg.peerId instanceof Api.PeerChannel ? msg.peerId.channelId.toJSNumber() : 0));
            const key = `${chatId}:${mediaGroupIdText}`;
            const photoPath = await downloadPhoto(msg);

            let pending = pendingMediaGroups.get(key);
            if (!pending) {
              pending = {
                msg,
                photoCount: 0,
                photoPaths: [],
                timer: setTimeout(() => flushMediaGroup(key), MEDIA_GROUP_FLUSH_DELAY_MS),
              };
              pendingMediaGroups.set(key, pending);
            } else {
              clearTimeout(pending.timer);
              pending.timer = setTimeout(() => flushMediaGroup(key), MEDIA_GROUP_FLUSH_DELAY_MS);
            }

            if (photoPath) {
              pending.photoCount++;
              pending.photoPaths.push(photoPath);
            }
            // If a media-group message has text, it is usually on the first item.
            if (msg.message) {
              pending.msg = msg;
            }
            return;
          }

          const m = await toTelegramMessage(msg);
          if (m) {
            for (const h of messageHandlers) void Promise.resolve(h(m)).catch(e => console.error(e));
          }
        } catch (e) {
          console.error("[userbot] handler error:", e);
        }
      }, new NewMessage({}));
      return new Promise(() => {});
    },
    stop: () => client.disconnect(),
    getMessages: () => [],
    onMessage: (h) => { messageHandlers.add(h); return () => messageHandlers.delete(h); },
    onEditedMessage: () => () => {},
    reply: async (chatId, text, messageId) => {
      const target = await getSafeEntity(chatId);
      const sent = await client.sendMessage(target, { message: text, replyTo: messageId });
      if (sent instanceof Api.Message) {
        rememberOutgoingMessage(chatId, sent);
      }
    },
    sendMediaBatch: async (chatId, items, options) => {
      const result: TelegramSendMediaBatchResult = {
        sentCount: 0,
        failures: [],
      };

      if (!Array.isArray(items) || items.length === 0) {
        return result;
      }

      const target = await getSafeEntity(chatId);
      const groups = splitMediaItemsByType(items);
      let caption = options?.caption?.trim() || undefined;
      const replyTo = options?.replyToMessageId || undefined;
      let uploadSequence = 1;

      for (const group of groups) {
        for (let index = 0; index < group.length; index += 1) {
          const item = group[index];
          const effectiveCaption = caption && index === 0 ? caption : undefined;
          try {
            const fileInput = await resolveUserbotMediaInput(item, uploadSequence);
            const sendOptions: Record<string, unknown> = {
              file: fileInput,
              caption: effectiveCaption,
              replyTo,
            };
            if (item.type === "file") {
              sendOptions.forceDocument = true;
            }
            if (item.type === "audio") {
              sendOptions.voiceNote = false;
            }
            const sent = await (client as any).sendFile(target, sendOptions);
            if (sent instanceof Api.Message) {
              rememberOutgoingMessage(chatId, sent);
            }
            result.sentCount += 1;
            uploadSequence += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.failures.push({
              source: item.source,
              type: item.type,
              error: message,
            });
          }
        }
        caption = undefined;
      }

      return result;
    },
    sendTyping: async (chatId) => {
      await setTyping(chatId);
    },
    startStream: async (chatId, messageId, placeholder) => {
      void setTyping(chatId);
      const streamId = nextStreamId++;
      const initialStatus = (placeholder?.trim() || DEFAULT_STREAM_PLACEHOLDER).trim();
      let placeholderMessageId: number | null = null;
      try {
        const target = await getSafeEntity(chatId);
        const sent = await client.sendMessage(target, {
          message: initialStatus,
          replyTo: messageId || undefined,
        });
        if (sent instanceof Api.Message) {
          placeholderMessageId = sent.id;
          rememberOutgoingMessage(chatId, sent);
        }
      } catch (error) {
        console.warn("[userbot] failed to send stream placeholder:", error);
      }

      streams.set(streamId, {
        chatId,
        placeholderMessageId,
        conversationType: "group",
        username: null,
        replyToMessageId: messageId || null,
        replyToUserId: null,
        statusText: initialStatus,
        lastRenderedText: placeholderMessageId ? initialStatus : "",
        lastFlushAtMs: Date.now(),
        chunks: [],
      });
      return streamId;
    },
    setStreamStatus: async (id, status) => {
      const s = streams.get(id);
      if (!s) return;
      const normalized = status.trim();
      if (!normalized || normalized === s.statusText) {
        return;
      }
      s.statusText = normalized;
      await flushStreamPreview(s, true);
    },
    appendStream: (id, c) => {
      const s = streams.get(id);
      if (s) {
        s.chunks.push(c);
        if (s.chunks.length % 5 === 0) void setTyping(s.chatId);
        void flushStreamPreview(s);
      }
    },
    endStream: async (id) => {
      const s = streams.get(id);
      if (!s) return "";
      const text = s.chunks.join("") || DEFAULT_FINAL_TEXT;
      if (s.placeholderMessageId) {
        await deleteStreamMessage(s);
      }

      const target = await getSafeEntity(s.chatId);
      const sent = await client.sendMessage(target, {
        message: text,
        replyTo: s.replyToMessageId || undefined,
      });
      if (sent instanceof Api.Message) {
        rememberOutgoingMessage(s.chatId, sent);
        console.log(`[userbot] Record sent message ID: ${sent.id}`);
      }
      streams.delete(id);
      return text;
    }
  };
}

function parseDocumentId(documentId: string): string | null {
  const normalized = documentId.trim();
  if (!/^-?\d+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeReplyPreviewText(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
}

function extractReplyPreviewFromApiMessage(message: Api.Message): string | null {
  const raw = normalizeReplyPreviewText(message.message);
  if (raw) {
    return raw;
  }
  if (message.media instanceof Api.MessageMediaPhoto) {
    return "[photo]";
  }
  if (message.media instanceof Api.MessageMediaDocument) {
    return "[file]";
  }
  return null;
}

function buildStickerSetCacheKey(stickerSet: Api.TypeInputStickerSet): string | null {
  if (stickerSet instanceof Api.InputStickerSetShortName) {
    return `short:${stickerSet.shortName}`;
  }
  if (stickerSet instanceof Api.InputStickerSetID) {
    return `id:${stickerSet.id.toString()}:${stickerSet.accessHash.toString()}`;
  }
  const className = (stickerSet as { className?: string }).className;
  if (!className) {
    return null;
  }
  return `class:${className}`;
}

function extractCustomEmojiOccurrencesFromMessage(
  text: string,
  entities?: Api.TypeMessageEntity[]
): CustomEmojiOccurrence[] {
  if (!text || !entities?.length) {
    return [];
  }
  const occurrences: CustomEmojiOccurrence[] = [];
  for (const entity of entities) {
    if (!(entity instanceof Api.MessageEntityCustomEmoji)) {
      continue;
    }
    const offset = entity.offset;
    const length = entity.length;
    const fallbackEmoji = text.slice(offset, offset + length);
    if (!fallbackEmoji) {
      continue;
    }
    occurrences.push({
      customEmojiId: entity.documentId.toString(),
      fallbackEmoji,
      offset,
      length,
    });
  }
  return occurrences;
}

function extractMentionsFromMessageEntities(
  text: string,
  entities?: Api.TypeMessageEntity[]
): MentionExtraction {
  if (!text || !entities?.length) {
    return { mentions: [], mentionUserIds: [] };
  }

  const mentions: string[] = [];
  const mentionUserIds: string[] = [];
  for (const entity of entities) {
    if (entity instanceof Api.MessageEntityMention) {
      const mention = text.slice(entity.offset, entity.offset + entity.length).trim().toLowerCase();
      if (mention) {
        mentions.push(mention);
      }
      continue;
    }
    if (entity instanceof Api.MessageEntityMentionName) {
      const userId = entity.userId?.toString().trim();
      if (userId) {
        mentionUserIds.push(userId);
      }
    }
  }

  return {
    mentions: Array.from(new Set(mentions)),
    mentionUserIds: Array.from(new Set(mentionUserIds)),
  };
}

function normalizeUsernameHandle(username: string | undefined): string | null {
  const normalized = (username ?? "").trim().toLowerCase();
  return normalized ? `@${normalized}` : null;
}

function renderTextWithCustomEmojiTags(
  text: string,
  occurrences: CustomEmojiOccurrence[],
  infoById: Map<string, ResolvedCustomEmojiInfo>
): string {
  if (occurrences.length === 0) {
    return text;
  }
  const sorted = [...occurrences].sort((a, b) => b.offset - a.offset);
  let rendered = text;
  for (const occurrence of sorted) {
    const info = infoById.get(occurrence.customEmojiId);
    const attrs = [`id="${escapeXmlAttribute(occurrence.customEmojiId)}"`];
    const errorText = info?.errorText;
    const altText = info?.altText?.trim() || undefined;
    const effectiveAlt = altText || (errorText ? `[${errorText}]` : undefined);
    if (info?.packName) {
      attrs.push(`pack="${escapeXmlAttribute(info.packName)}"`);
    }
    if (effectiveAlt) {
      attrs.push(`alt="${escapeXmlAttribute(effectiveAlt)}"`);
    }
    if (errorText) {
      attrs.push('error="true"');
    }
    const textContent = errorText
      ? occurrence.fallbackEmoji
      : (altText || occurrence.fallbackEmoji);
    const replacement = `<custom-emoji ${attrs.join(" ")}>${escapeXmlText(textContent)}</custom-emoji>`;
    rendered =
      rendered.slice(0, occurrence.offset) +
      replacement +
      rendered.slice(occurrence.offset + occurrence.length);
  }
  return rendered;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function splitMediaItemsByType(
  items: TelegramOutgoingMediaItem[]
): TelegramOutgoingMediaItem[][] {
  const groups: TelegramOutgoingMediaItem[][] = [];
  for (const item of items) {
    if (!item?.source) {
      continue;
    }
    const lastGroup = groups[groups.length - 1];
    if (!lastGroup || lastGroup[0].type !== item.type) {
      groups.push([item]);
      continue;
    }
    lastGroup.push(item);
  }
  return groups;
}

async function resolveUserbotMediaInput(
  item: TelegramOutgoingMediaItem,
  sequence: number
): Promise<CustomFile> {
  if (isHttpMediaSource(item.source)) {
    const response = await fetch(item.source);
    if (!response.ok) {
      throw new Error(`download media failed (${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const responseMimeType = normalizeMimeType(response.headers.get("content-type") ?? undefined);
    const fileName = buildOutgoingFileName(item, sequence, responseMimeType);
    return new CustomFile(fileName, buffer.length, "", buffer);
  }

  const localPath = toLocalMediaPath(item.source);
  const stat = await fs.stat(localPath);
  const fileName = buildOutgoingFileName(item, sequence);
  return new CustomFile(fileName, stat.size, localPath);
}

function isHttpMediaSource(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toLocalMediaPath(source: string): string {
  try {
    const parsed = new URL(source);
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname);
    }
    return source;
  } catch {
    return source;
  }
}

function buildOutgoingFileName(
  item: TelegramOutgoingMediaItem,
  sequence: number,
  responseMimeType?: string
): string {
  const itemMimeType = normalizeMimeType(item.mimeType);
  const resolvedMimeType = itemMimeType || responseMimeType;
  const inferredExtension =
    inferExtensionFromMimeType(resolvedMimeType) || defaultExtensionForType(item.type);

  const explicitName = sanitizeFileName(item.fileName ?? "");
  if (explicitName) {
    if (extname(explicitName).trim()) {
      return explicitName;
    }
    return `${explicitName}${inferredExtension}`;
  }

  const sourceName = sanitizeFileName(extractSourceFileName(item.source));
  if (sourceName) {
    if (extname(sourceName).trim()) {
      return sourceName;
    }
    return `${sourceName}${inferredExtension}`;
  }

  return `${item.type}-${Date.now()}-${sequence}${inferredExtension}`;
}

function sanitizeFileName(name: string): string {
  const sanitized = name.trim().replaceAll("\\", "_").replaceAll("/", "_");
  return sanitized.slice(0, 200);
}

function extractSourceFileName(source: string): string {
  if (isHttpMediaSource(source)) {
    try {
      const parsed = new URL(source);
      return basename(decodeURIComponent(parsed.pathname));
    } catch {
      return "";
    }
  }
  const localPath = toLocalMediaPath(source);
  return basename(localPath);
}

function normalizeMimeType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase().split(";")[0]?.trim();
  return normalized || undefined;
}

function inferExtensionFromMimeType(mimeType?: string): string | undefined {
  if (!mimeType || mimeType === "application/octet-stream") {
    return undefined;
  }
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    case "audio/flac":
      return ".flac";
    default: {
      const slashIndex = mimeType.indexOf("/");
      if (slashIndex <= 0 || slashIndex === mimeType.length - 1) {
        return undefined;
      }
      const subtype = mimeType.slice(slashIndex + 1).split("+")[0]?.trim();
      if (!subtype || !/^[a-z0-9.-]+$/.test(subtype)) {
        return undefined;
      }
      return `.${subtype}`;
    }
  }
}

function defaultExtensionForType(type: TelegramOutgoingMediaItem["type"]): string {
  if (type === "image") {
    return ".jpg";
  }
  if (type === "audio") {
    return ".mp3";
  }
  return ".bin";
}
