import type { Context } from "hono";
import type { RouteContext, Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { generateCallbackQueryId, nextFileId } from "../ids.js";
import { ok, okRaw, parseTelegramBody, tgError } from "../http.js";
import {
  resolveBotFromToken,
  serializeBotAsUser,
  serializeChat,
  serializeChatFullInfo,
  serializeMessage,
  serializeUser,
} from "../serializers.js";
import { parseEntities } from "../entity-parser.js";
import { getDispatcher } from "../dispatcher.js";
import { MarkdownParseError, parseMarkdownV2 } from "../markdown.js";
import { HtmlParseError, parseHtml } from "../html.js";
import { allocateMessageId, buildMediaField, buildPhotoSizes } from "../services/media.js";
import {
  closeForumTopicMethod,
  createForumTopicMethod,
  deleteForumTopicMethod,
  editForumTopicMethod,
} from "./bot-api-forum.js";
import {
  getChat,
  getChatAdministrators,
  getChatMember,
  getChatMemberCount,
  sendChatAction,
} from "./bot-api-chats.js";
import {
  deleteWebhook,
  getMe,
  getUpdates,
  getWebhookInfo,
  setWebhook,
} from "./bot-api-delivery.js";
import type {
  InlineKeyboardMarkup,
  MessageEntity,
  PhotoSize,
  ReplyMarkup,
  TelegramAnimation,
  TelegramAudio,
  TelegramBot,
  TelegramChat,
  TelegramDocument,
  TelegramFault,
  TelegramMessage,
  TelegramSticker,
  TelegramVideo,
  TelegramVoice,
} from "../entities.js";

type MultipartFile = { __file: true; name: string; type: string; bytes: Buffer };

function isMultipartFile(v: unknown): v is MultipartFile {
  return typeof v === "object" && v !== null && (v as { __file?: boolean }).__file === true;
}

export function botApiRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ts = () => getTelegramStore(store);
  const dispatcher = () => getDispatcher(store);

  // All Bot API methods live under /bot<token>/<method>.
  // We accept both GET (query/form) and POST (json/form/multipart).
  // Hono's inline :param doesn't play well with tokens containing ":", so we
  // use a wildcard and parse the path ourselves.
  const methodHandler = async (c: Context) => {
    const path = new URL(c.req.url).pathname;
    const m = path.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!m) return tgError(c, "Not Found", 404, 404);
    const token = m[1];
    const method = m[2];

    const bot = resolveBotFromToken(store, token);
    if (!bot) return tgError(c, "Unauthorized", 401, 401);

    // Check injected faults before dispatching the real handler.
    const fault = consumeFault(store, bot.bot_id, method);
    if (fault) {
      const status = faultHttpStatus(fault.error_code);
      const parameters = fault.retry_after !== null ? { retry_after: fault.retry_after } : undefined;
      return c.json(
        { ok: false, error_code: fault.error_code, description: fault.description, ...(parameters ? { parameters } : {}) },
        status,
      );
    }

    const body =
      c.req.method === "GET"
        ? queryToBody(c)
        : await parseTelegramBody(c);

    switch (method) {
      case "getMe":
        return getMe(c, bot);
      case "getUpdates":
        return await getUpdates(c, bot, body, dispatcher());
      case "setWebhook":
        return setWebhook(c, bot, body, store);
      case "deleteWebhook":
        return deleteWebhook(c, bot, store);
      case "getWebhookInfo":
        return getWebhookInfo(c, bot);
      case "sendMessage":
        return sendMessage(c, bot, body, store);
      case "sendPhoto":
        return sendPhoto(c, bot, body, store);
      case "getFile":
        return getFile(c, bot, body, store);
      case "answerCallbackQuery":
        return answerCallbackQuery(c, bot, body, store);
      case "getChat":
        return getChat(c, body, store);
      case "getChatMember":
        return getChatMember(c, body, store);
      case "getChatAdministrators":
        return getChatAdministrators(c, body, store);
      case "setMyCommands":
        return setMyCommands(c, bot, body, store);
      case "getMyCommands":
        return getMyCommands(c, bot);
      case "editMessageReplyMarkup":
        return editMessageReplyMarkup(c, bot, body, store);
      case "editMessageText":
        return editMessageText(c, bot, body, store);
      case "deleteMessage":
        return deleteMessage(c, bot, body, store);
      case "sendMessageDraft":
        return sendMessageDraft(c, bot, body, store);
      case "sendDocument":
        return sendDocument(c, bot, body, store);
      case "sendChatAction":
        return sendChatAction(c);
      case "getChatMemberCount":
        return getChatMemberCount(c, body, store);
      case "setMessageReaction":
        return setMessageReaction(c, bot, body, store);
      case "sendVideo":
        return sendMediaMessage(c, bot, body, store, "video");
      case "sendAudio":
        return sendMediaMessage(c, bot, body, store, "audio");
      case "sendVoice":
        return sendMediaMessage(c, bot, body, store, "voice");
      case "sendAnimation":
        return sendMediaMessage(c, bot, body, store, "animation");
      case "sendSticker":
        return sendMediaMessage(c, bot, body, store, "sticker");
      case "createForumTopic":
        return createForumTopicMethod(c, body, store);
      case "editForumTopic":
        return editForumTopicMethod(c, body, store);
      case "closeForumTopic":
        return closeForumTopicMethod(c, body, store, true);
      case "reopenForumTopic":
        return closeForumTopicMethod(c, body, store, false);
      case "deleteForumTopic":
        return deleteForumTopicMethod(c, body, store);
      default:
        return tgError(c, `Method ${method} is not implemented in the emulator`, 404, 404);
    }
  };

  // Hono's parametric and wildcard routes do not cooperate with path segments
  // containing ":" (used by Telegram bot tokens). We register a catchall that
  // dispatches based on path shape — specific routes registered by other
  // modules still win because Hono prioritises specific matches over "*".
  app.all("*", async (c) => {
    const path = new URL(c.req.url).pathname;

    const botMatch = path.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (botMatch) return methodHandler(c);

    const fileMatch = path.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch) {
      const token = fileMatch[1];
      const bot = resolveBotFromToken(store, token);
      if (!bot) return c.text("Unauthorized", 401);
      const filePath = decodeURIComponent(fileMatch[2]);
      const file = ts()
        .files.all()
        .find((f) => f.file_path === filePath);
      if (!file) return c.text("File not found", 404);
      const bytes = Buffer.from(file.bytes_base64, "base64");
      return c.body(bytes, 200, {
        "Content-Type": file.mime_type,
        "Content-Length": String(bytes.length),
      });
    }

    return c.notFound();
  });
}

function queryToBody(c: Context): Record<string, unknown> {
  const url = new URL(c.req.url);
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function sendMessage(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  const rawText = typeof body.text === "string" ? (body.text as string) : "";
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");
  if (!rawText) return tgError(c, "Bad Request: text is required");

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found", 400);
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  const replyMarkup = body.reply_markup as ReplyMarkup | undefined;
  const replyTo = typeof body.reply_to_message_id === "number" ? (body.reply_to_message_id as number) : undefined;
  const customEntities = Array.isArray(body.entities) ? (body.entities as MessageEntity[]) : undefined;

  const parsed = applyParseMode(rawText, body.parse_mode, customEntities);
  if (!parsed.ok) return tgError(c, parsed.description, 400);

  // Real Telegram rejects messages whose visible text exceeds 4096 chars.
  // Length is counted in UTF-16 code units on the parsed (stripped) text.
  if (parsed.text.length > TEXT_LIMIT) {
    return tgError(c, "Bad Request: message is too long", 400, 400);
  }

  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);

  if (replyTo !== undefined) {
    const target = ts.messages
      .findBy("chat_id", chatId)
      .find((m) => m.message_id === replyTo && !m.deleted);
    if (!target) {
      return tgError(c, "Bad Request: message to be replied not found", 400, 400);
    }
  }

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: typeof body.message_thread_id === "number" ? (body.message_thread_id as number) : undefined,
    date: Math.floor(Date.now() / 1000),
    text: parsed.text,
    entities: parsed.entities,
    reply_to_message_id: replyTo,
    reply_markup: replyMarkup,
  });

  return ok(c, serializeMessage(msg, { store }));
}

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

function validateMessageThreadId(
  raw: unknown,
  chat: TelegramChat,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number") return null;
  if (chat.type !== "supergroup") return "Bad Request: message thread not found";
  return null;
}

/**
 * Interprets `parse_mode` against the raw text. Returns the stripped text
 * and the entities derived from markup. Caller-supplied `entities` are
 * preserved and appended to the parsed set (real Telegram behaviour: when
 * both are present, entities take precedence and parse_mode is ignored,
 * but we merge so tests can exercise either path without losing data).
 */
function applyParseMode(
  rawText: string,
  parseMode: unknown,
  callerEntities: MessageEntity[] | undefined,
): { ok: true; text: string; entities: MessageEntity[] | undefined } | { ok: false; description: string } {
  const mode = typeof parseMode === "string" ? parseMode : "";
  if (!mode) {
    return { ok: true, text: rawText, entities: callerEntities };
  }
  try {
    if (mode === "MarkdownV2") {
      const { text, entities } = parseMarkdownV2(rawText);
      const merged = mergeEntities(entities, callerEntities);
      return { ok: true, text, entities: merged.length > 0 ? merged : undefined };
    }
    if (mode === "HTML") {
      const { text, entities } = parseHtml(rawText);
      const merged = mergeEntities(entities, callerEntities);
      return { ok: true, text, entities: merged.length > 0 ? merged : undefined };
    }
    if (mode === "Markdown") {
      // Legacy Markdown v1: simpler grammar than V2 (no spoiler/underline/
      // strikethrough, `_` and `*` only, no escape syntax). Real Telegram
      // still accepts it; many older SDKs default to it.
      const { text, entities } = parseLegacyMarkdown(rawText);
      const merged = mergeEntities(entities, callerEntities);
      return { ok: true, text, entities: merged.length > 0 ? merged : undefined };
    }
    return { ok: false, description: `Bad Request: unknown parse_mode '${mode}'` };
  } catch (err) {
    if (err instanceof MarkdownParseError || err instanceof HtmlParseError) {
      return { ok: false, description: err.message };
    }
    throw err;
  }
}

function mergeEntities(
  parsed: MessageEntity[],
  caller: MessageEntity[] | undefined,
): MessageEntity[] {
  if (!caller || caller.length === 0) return parsed;
  // When caller supplies entities explicitly, real Telegram discards
  // parse_mode output — drop the parsed side.
  const all = [...caller];
  all.sort((a, b) => (a.offset !== b.offset ? a.offset - b.offset : b.length - a.length));
  return all;
}

// Minimal legacy Markdown (v1) parser: *bold*, _italic_, `code`,
// ```pre```, [text](url). No escape syntax; unmatched markers are
// emitted as literal text.
function parseLegacyMarkdown(input: string): { text: string; entities: MessageEntity[] } {
  const out: string[] = [];
  const entities: MessageEntity[] = [];
  let i = 0;
  const emit = (
    type: MessageEntity["type"],
    markerLen: number,
    closer: string,
    extras?: Partial<MessageEntity>,
  ): boolean => {
    const close = input.indexOf(closer, i + markerLen);
    if (close === -1) return false;
    const body = input.slice(i + markerLen, close);
    const start = out.join("").length;
    out.push(body);
    entities.push({ type, offset: start, length: body.length, ...extras });
    i = close + closer.length;
    return true;
  };
  while (i < input.length) {
    const ch = input[i];
    if (input.startsWith("```", i) && emit("pre", 3, "```")) continue;
    if (ch === "`" && emit("code", 1, "`")) continue;
    if (ch === "*" && emit("bold", 1, "*")) continue;
    if (ch === "_" && emit("italic", 1, "_")) continue;
    if (ch === "[") {
      const close = input.indexOf("]", i + 1);
      if (close !== -1 && input[close + 1] === "(") {
        const urlClose = input.indexOf(")", close + 2);
        if (urlClose !== -1) {
          const text = input.slice(i + 1, close);
          const url = input.slice(close + 2, urlClose);
          const start = out.join("").length;
          out.push(text);
          if (url.startsWith("tg://user?id=")) {
            const uid = Number(url.slice("tg://user?id=".length));
            if (Number.isFinite(uid)) {
              entities.push({
                type: "text_mention",
                offset: start,
                length: text.length,
                user: { id: uid, is_bot: false, first_name: "" },
              });
            }
          } else {
            entities.push({ type: "text_link", offset: start, length: text.length, url });
          }
          i = urlClose + 1;
          continue;
        }
      }
    }
    out.push(ch);
    i += 1;
  }
  entities.sort((a, b) => (a.offset !== b.offset ? a.offset - b.offset : b.length - a.length));
  return { text: out.join(""), entities };
}

async function sendPhoto(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  const rawCaption = typeof body.caption === "string" ? (body.caption as string) : undefined;
  const captionEntitiesCaller = Array.isArray(body.caption_entities)
    ? (body.caption_entities as MessageEntity[])
    : undefined;
  let caption = rawCaption;
  let captionEntities = captionEntitiesCaller;
  if (rawCaption !== undefined) {
    const parsed = applyParseMode(rawCaption, body.parse_mode, captionEntitiesCaller);
    if (!parsed.ok) return tgError(c, parsed.description, 400);
    if (parsed.text.length > CAPTION_LIMIT) {
      return tgError(c, "Bad Request: message caption is too long", 400, 400);
    }
    caption = parsed.text;
    captionEntities = parsed.entities;
  }
  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);
  const replyMarkup = body.reply_markup as ReplyMarkup | undefined;

  let photoSizes: PhotoSize[];

  const photoInput = body.photo;
  if (typeof photoInput === "string") {
    // Re-send by file_id — real Telegram preserves the file_id exactly.
    const file = ts.files.findOneBy("file_id", photoInput);
    if (!file) return tgError(c, "Bad Request: file not found");
    if (file.photo_sizes_json) {
      photoSizes = JSON.parse(file.photo_sizes_json) as PhotoSize[];
    } else {
      // Legacy row without saved tiers — fall back to synthesising but
      // keep the same file_id for the primary tier.
      photoSizes = [
        {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          width: file.width,
          height: file.height,
          file_size: file.file_size,
        },
      ];
    }
  } else if (isMultipartFile(photoInput)) {
    const bytes = photoInput.bytes;
    const { sizes } = buildPhotoSizes(store, bytes, bot.bot_id, chatId);
    const photoSizesJson = JSON.stringify(sizes);
    for (const size of sizes) {
      ts.files.insert({
        file_id: size.file_id,
        file_unique_id: size.file_unique_id,
        owner_bot_id: bot.bot_id,
        mime_type: photoInput.type || "image/jpeg",
        file_size: bytes.length,
        width: size.width,
        height: size.height,
        file_path: `photos/${bot.bot_id}/${size.file_id}`,
        bytes_base64: bytes.toString("base64"),
        kind: "photo" as const,
        photo_sizes_json: photoSizesJson,
      });
    }
    photoSizes = sizes;
  } else {
    return tgError(c, "Bad Request: photo must be a file_id string or multipart upload");
  }

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: typeof body.message_thread_id === "number" ? (body.message_thread_id as number) : undefined,
    date: Math.floor(Date.now() / 1000),
    photo: photoSizes,
    caption,
    caption_entities: captionEntities,
    reply_markup: replyMarkup,
  });

  return ok(c, serializeMessage(msg, { store }));
}

function setMessageReaction(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  const messageId = typeof body.message_id === "number" ? (body.message_id as number) : null;
  if (chatId === null || messageId === null) return tgError(c, "Bad Request: chat_id and message_id required");
  const reaction = Array.isArray(body.reaction)
    ? (body.reaction as Array<{ type: string; emoji?: string; custom_emoji_id?: string }>)
    : [];

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  const msg = ts.messages.findBy("chat_id", chatId).find((m) => m.message_id === messageId);
  if (!msg) return tgError(c, "Bad Request: message not found");

  // Upsert the reaction row for this bot on this message.
  const existing = ts.reactions.all().find(
    (r) => r.chat_id === chatId && r.message_id === messageId && r.sender_bot_id === bot.bot_id,
  );
  const typed = reaction
    .filter((r) => r.type === "emoji" || r.type === "custom_emoji")
    .map((r) =>
      r.type === "emoji"
        ? { type: "emoji" as const, emoji: r.emoji ?? "" }
        : { type: "custom_emoji" as const, custom_emoji_id: r.custom_emoji_id ?? "" },
    );

  if (existing) {
    if (typed.length === 0) {
      ts.reactions.delete(existing.id);
    } else {
      ts.reactions.update(existing.id, { reaction: typed });
    }
  } else if (typed.length > 0) {
    ts.reactions.insert({
      chat_id: chatId,
      message_id: messageId,
      sender_user_id: null,
      sender_bot_id: bot.bot_id,
      reaction: typed,
    });
  }

  return c.json({ ok: true, result: true });
}

function getFile(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const fileId = typeof body.file_id === "string" ? (body.file_id as string) : "";
  if (!fileId) return tgError(c, "Bad Request: file_id is required");

  const ts = getTelegramStore(store);
  const file = ts.files.findOneBy("file_id", fileId);
  if (!file) return tgError(c, "Bad Request: file not found");

  void bot;
  return ok(c, {
    file_id: file.file_id,
    file_unique_id: file.file_unique_id,
    file_size: file.file_size,
    file_path: file.file_path,
  });
}

function answerCallbackQuery(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const id = typeof body.callback_query_id === "string" ? (body.callback_query_id as string) : "";
  if (!id) return tgError(c, "Bad Request: callback_query_id is required");

  const ts = getTelegramStore(store);
  const cq = ts.callbackQueries.findOneBy("callback_query_id", id);
  if (!cq) return tgError(c, "Bad Request: callback_query not found");

  ts.callbackQueries.update(cq.id, {
    answered: true,
    answer_text: typeof body.text === "string" ? (body.text as string) : undefined,
    answer_show_alert: typeof body.show_alert === "boolean" ? (body.show_alert as boolean) : undefined,
    answer_url: typeof body.url === "string" ? (body.url as string) : undefined,
    answer_cache_time: typeof body.cache_time === "number" ? (body.cache_time as number) : undefined,
  });
  void bot;
  return c.json({ ok: true, result: true });
}

function setMyCommands(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const commands = Array.isArray(body.commands) ? (body.commands as Array<{ command: string; description: string }>) : [];
  const ts = getTelegramStore(store);
  ts.bots.update(bot.id, { commands });
  return okRaw(c, true);
}

function getMyCommands(c: Context, bot: TelegramBot) {
  return c.json({ ok: true, result: bot.commands });
}

function editMessageReplyMarkup(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  const messageId = typeof body.message_id === "number" ? (body.message_id as number) : null;
  if (chatId === null || messageId === null) return tgError(c, "Bad Request: chat_id and message_id required");

  const ts = getTelegramStore(store);
  const msg = ts.messages
    .findBy("chat_id", chatId)
    .find((m) => m.message_id === messageId);
  if (!msg) return tgError(c, "Bad Request: message not found");

  const newMarkup = body.reply_markup as InlineKeyboardMarkup | undefined;
  ts.messages.update(msg.id, { reply_markup: newMarkup, edited_date: Math.floor(Date.now() / 1000) });

  void bot;
  const updated = ts.messages.get(msg.id)!;
  return ok(c, serializeMessage(updated, { store }));
}

function coerceChatId(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  if (typeof v === "string" && v.startsWith("@")) {
    // Username lookup isn't supported in Phase 1; caller should use numeric chat_id.
    return null;
  }
  return null;
}

export function parseInlineKeyboard(markup: unknown): InlineKeyboardMarkup | null {
  if (!markup || typeof markup !== "object") return null;
  const m = markup as Record<string, unknown>;
  if (Array.isArray(m.inline_keyboard)) {
    return m as unknown as InlineKeyboardMarkup;
  }
  return null;
}

export { parseEntities };

// expose for control plane
export function simulateInsertMessage(
  store: Store,
  input: {
    chatId: number;
    fromUserId: number;
    text: string;
    entities?: MessageEntity[];
    replyTo?: number;
    messageThreadId?: number;
  },
): TelegramMessage {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  if (!chat.member_user_ids.includes(input.fromUserId)) {
    throw new Error(`user ${input.fromUserId} is not a member of chat ${input.chatId}`);
  }
  const messageId = allocateMessageId(store, chat);
  return ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: input.fromUserId,
    from_bot_id: null,
    sender_chat_id: null,
    message_thread_id: input.messageThreadId,
    date: Math.floor(Date.now() / 1000),
    text: input.text,
    entities: input.entities,
    reply_to_message_id: input.replyTo,
  });
}

// ---- Full-parity additions: faults, rich media, length limits ----

function consumeFault(
  store: Store,
  botId: number,
  method: string,
): TelegramFault | null {
  const ts = getTelegramStore(store);
  const matches = ts.faults.all().filter(
    (f) => f.bot_id === botId && (f.method === "*" || f.method === method) && f.remaining > 0,
  );
  if (matches.length === 0) return null;
  // Prefer specific-method faults over wildcards.
  matches.sort((a, b) => (a.method === "*" ? 1 : 0) - (b.method === "*" ? 1 : 0));
  const fault = matches[0];
  const remaining = fault.remaining - 1;
  if (remaining <= 0) {
    ts.faults.delete(fault.id);
  } else {
    ts.faults.update(fault.id, { remaining });
  }
  return fault;
}

function faultHttpStatus(errorCode: number): 400 | 401 | 403 | 404 | 429 {
  if (errorCode === 401 || errorCode === 403 || errorCode === 404 || errorCode === 429) {
    return errorCode;
  }
  return 400;
}

type MediaKind = "video" | "audio" | "voice" | "animation" | "sticker";

async function sendMediaMessage(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
  kind: MediaKind,
) {
  const chatId = coerceChatId(body.chat_id);
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  // Caption + parse_mode (sticker has no caption).
  const rawCaption = typeof body.caption === "string" ? (body.caption as string) : undefined;
  const callerCaptionEntities = Array.isArray(body.caption_entities)
    ? (body.caption_entities as MessageEntity[])
    : undefined;
  let caption = rawCaption;
  let captionEntities = callerCaptionEntities;
  if (rawCaption !== undefined) {
    if (kind === "sticker") {
      // Real Telegram silently ignores captions on stickers.
      caption = undefined;
      captionEntities = undefined;
    } else {
      const parsed = applyParseMode(rawCaption, body.parse_mode, callerCaptionEntities);
      if (!parsed.ok) return tgError(c, parsed.description, 400);
      if (parsed.text.length > CAPTION_LIMIT) {
        return tgError(c, "Bad Request: message caption is too long", 400, 400);
      }
      caption = parsed.text;
      captionEntities = parsed.entities;
    }
  }

  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);

  const replyMarkup = body.reply_markup as ReplyMarkup | undefined;

  const bodyKey = kind;
  const input = body[bodyKey];

  const duration = typeof body.duration === "number" ? (body.duration as number) : 0;
  const width = typeof body.width === "number" ? (body.width as number) : 0;
  const height = typeof body.height === "number" ? (body.height as number) : 0;

  let file_id: string;
  let file_unique_id: string;
  let file_name: string | undefined;
  let mime_type: string | undefined;
  let file_size = 0;

  if (typeof input === "string") {
    // Re-send by file_id.
    const file = ts.files.findOneBy("file_id", input);
    if (!file) return tgError(c, "Bad Request: file not found");
    file_id = file.file_id;
    file_unique_id = file.file_unique_id;
    file_name = file.file_name;
    mime_type = file.mime_type;
    file_size = file.file_size;
  } else if (isMultipartFile(input)) {
    const bytes = input.bytes;
    const ids = nextFileId(store, bot.bot_id, chatId, kind[0]);
    file_id = ids.file_id;
    file_unique_id = ids.file_unique_id;
    file_name = input.name;
    mime_type = input.type || defaultMimeForKind(kind);
    file_size = bytes.length;
    ts.files.insert({
      file_id,
      file_unique_id,
      owner_bot_id: bot.bot_id,
      mime_type,
      file_size,
      width,
      height,
      file_path: `${kind}s/${bot.bot_id}/${file_id}`,
      bytes_base64: bytes.toString("base64"),
      kind,
      file_name,
      duration,
    });
  } else {
    return tgError(c, `Bad Request: ${kind} must be a file_id string or multipart upload`);
  }

  const mediaField = buildMediaField({
    kind,
    file_id,
    file_unique_id,
    file_size,
    width,
    height,
    duration,
    mime_type,
    file_name,
    performer: typeof body.performer === "string" ? (body.performer as string) : undefined,
    title: typeof body.title === "string" ? (body.title as string) : undefined,
    emoji: typeof body.emoji === "string" ? (body.emoji as string) : undefined,
    is_animated: Boolean(body.is_animated),
    is_video: Boolean(body.is_video),
  });

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: typeof body.message_thread_id === "number" ? (body.message_thread_id as number) : undefined,
    date: Math.floor(Date.now() / 1000),
    [kind]: mediaField,
    caption,
    caption_entities: captionEntities,
    reply_markup: replyMarkup,
  });

  return ok(c, serializeMessage(msg, { store }));
}

function defaultMimeForKind(kind: MediaKind): string {
  switch (kind) {
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    case "voice":
      return "audio/ogg";
    case "animation":
      return "video/mp4";
    case "sticker":
      return "image/webp";
  }
}

// ---- editMessageText / deleteMessage / sendMessageDraft / sendDocument ----

function editMessageText(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  const messageId = typeof body.message_id === "number" ? (body.message_id as number) : null;
  const rawText = typeof body.text === "string" ? (body.text as string) : "";
  if (chatId === null || messageId === null || !rawText) {
    return tgError(c, "Bad Request: chat_id, message_id, text required");
  }
  const ts = getTelegramStore(store);
  const msg = ts.messages.findBy("chat_id", chatId).find((m) => m.message_id === messageId);
  if (!msg) return tgError(c, "Bad Request: message not found");
  if (msg.from_bot_id !== bot.bot_id) {
    return tgError(c, "Bad Request: message can't be edited by this bot", 403, 403);
  }
  const callerEntities = Array.isArray(body.entities) ? (body.entities as MessageEntity[]) : undefined;
  const parsed = applyParseMode(rawText, body.parse_mode, callerEntities);
  if (!parsed.ok) return tgError(c, parsed.description, 400);
  if (parsed.text.length > TEXT_LIMIT) {
    return tgError(c, "Bad Request: message is too long", 400, 400);
  }
  ts.messages.update(msg.id, {
    text: parsed.text,
    entities: parsed.entities,
    edited_date: Math.floor(Date.now() / 1000),
  });
  const updated = ts.messages.get(msg.id)!;
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (chat) dispatchEditedMessage(store, chat, bot.bot_id, updated);
  return ok(c, serializeMessage(updated, { store }));
}

function dispatchEditedMessage(
  store: Store,
  chat: TelegramChat,
  editorBotId: number,
  updated: TelegramMessage,
): void {
  const ts = getTelegramStore(store);
  const dispatcher = getDispatcher(store);
  const payload = serializeMessage(updated, { store });
  for (const otherBotId of chat.member_bot_ids) {
    if (otherBotId === editorBotId) continue;
    const bot = ts.bots.findOneBy("bot_id", otherBotId);
    if (!bot) continue;
    const type = chat.type === "channel" ? "edited_channel_post" : "edited_message";
    dispatcher.enqueue(otherBotId, type, payload);
  }
}

function deleteMessage(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  const messageId = typeof body.message_id === "number" ? (body.message_id as number) : null;
  if (chatId === null || messageId === null) return tgError(c, "Bad Request: chat_id and message_id required");
  const ts = getTelegramStore(store);
  const msg = ts.messages.findBy("chat_id", chatId).find((m) => m.message_id === messageId);
  if (!msg) return tgError(c, "Bad Request: message not found");
  // Telegram allows bots to delete their own messages unconditionally,
  // and messages from other senders only if the bot has sufficient rights
  // (which in our emulator we simplify to: always allowed for member bots).
  if (msg.from_bot_id !== null && msg.from_bot_id !== bot.bot_id) {
    return tgError(c, "Bad Request: message can't be deleted by this bot", 403, 403);
  }
  ts.messages.update(msg.id, { deleted: true });
  return c.json({ ok: true, result: true });
}

function sendMessageDraft(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  const draftId = typeof body.draft_id === "number" ? (body.draft_id as number) : 0;
  const text = typeof body.text === "string" ? (body.text as string) : "";
  if (chatId === null || draftId === 0 || !text) {
    return tgError(c, "Bad Request: chat_id, draft_id (non-zero), text required");
  }
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  // Real Telegram restricts sendMessageDraft to private chats.
  if (chat.type !== "private") {
    return tgError(c, "Bad Request: message drafts are supported only in private chats");
  }
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }
  const entities = Array.isArray(body.entities) ? (body.entities as MessageEntity[]) : undefined;

  const existing = ts.draftSnapshots
    .findBy("chat_id", chatId)
    .filter((s) => s.draft_id === draftId && s.bot_id === bot.bot_id);
  const seq = existing.length > 0 ? Math.max(...existing.map((s) => s.seq)) + 1 : 1;

  ts.draftSnapshots.insert({
    chat_id: chatId,
    draft_id: draftId,
    bot_id: bot.bot_id,
    seq,
    text,
    entities,
  });

  return c.json({ ok: true, result: true });
}

async function sendDocument(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const chatId = coerceChatId(body.chat_id);
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  const rawCaption = typeof body.caption === "string" ? (body.caption as string) : undefined;
  const callerCaptionEntities = Array.isArray(body.caption_entities)
    ? (body.caption_entities as MessageEntity[])
    : undefined;
  let caption = rawCaption;
  let captionEntities = callerCaptionEntities;
  if (rawCaption !== undefined) {
    const parsed = applyParseMode(rawCaption, body.parse_mode, callerCaptionEntities);
    if (!parsed.ok) return tgError(c, parsed.description, 400);
    if (parsed.text.length > CAPTION_LIMIT) {
      return tgError(c, "Bad Request: message caption is too long", 400, 400);
    }
    caption = parsed.text;
    captionEntities = parsed.entities;
  }
  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);
  const replyMarkup = body.reply_markup as ReplyMarkup | undefined;
  const docInput = body.document;

  let document: TelegramDocument;

  if (typeof docInput === "string") {
    // Re-send by file_id — Telegram preserves the same ids on echo.
    const file = ts.files.findOneBy("file_id", docInput);
    if (!file) return tgError(c, "Bad Request: file not found");
    document = {
      file_id: file.file_id,
      file_unique_id: file.file_unique_id,
      file_name: file.file_name,
      mime_type: file.mime_type,
      file_size: file.file_size,
    };
  } else if (isMultipartFile(docInput)) {
    const bytes = docInput.bytes;
    const { file_id, file_unique_id } = nextFileId(store, bot.bot_id, chatId, "d");
    ts.files.insert({
      file_id,
      file_unique_id,
      owner_bot_id: bot.bot_id,
      mime_type: docInput.type || "application/octet-stream",
      file_size: bytes.length,
      width: 0,
      height: 0,
      file_path: `documents/${bot.bot_id}/${file_id}`,
      bytes_base64: bytes.toString("base64"),
      kind: "document" as const,
      file_name: docInput.name,
    });
    document = {
      file_id,
      file_unique_id,
      file_name: docInput.name,
      mime_type: docInput.type || "application/octet-stream",
      file_size: bytes.length,
    };
  } else {
    return tgError(c, "Bad Request: document must be a file_id string or multipart upload");
  }

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: typeof body.message_thread_id === "number" ? (body.message_thread_id as number) : undefined,
    date: Math.floor(Date.now() / 1000),
    document,
    caption,
    caption_entities: captionEntities,
    reply_markup: replyMarkup,
  });

  return ok(c, serializeMessage(msg, { store }));
}
