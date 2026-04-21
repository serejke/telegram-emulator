// Forum-topic Bot API methods: createForumTopic / editForumTopic /
// closeForumTopic / reopenForumTopic / deleteForumTopic. All four
// require a supergroup with is_forum=true.
import type { Context } from "hono";
import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { ok, okRaw, tgError } from "../http.js";

function coerceChatId(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function requireForumChat(c: Context, chatId: number | null, store: Store) {
  if (chatId === null) return { error: tgError(c, "Bad Request: chat_id is required") };
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return { error: tgError(c, "Bad Request: chat not found") };
  if (chat.type !== "supergroup" || !chat.is_forum) {
    return { error: tgError(c, "Bad Request: CHAT_NOT_FORUM") };
  }
  return { chat };
}

function findForumTopic(store: Store, chatId: number, threadId: number) {
  const ts = getTelegramStore(store);
  return ts.forumTopics
    .findBy("chat_id", chatId)
    .find((t) => t.message_thread_id === threadId && !t.is_deleted);
}

export function createForumTopicMethod(c: Context, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  const name = typeof body.name === "string" ? (body.name as string).trim() : "";
  if (!name) return tgError(c, "Bad Request: name is required");
  const { chat, error } = requireForumChat(c, chatId, store);
  if (error) return error;
  const ts = getTelegramStore(store);
  const existing = ts.forumTopics.findBy("chat_id", chat.chat_id);
  const maxId = existing.reduce((m, t) => Math.max(m, t.message_thread_id), 1);
  const message_thread_id = maxId + 1;
  const iconColor = typeof body.icon_color === "number" ? (body.icon_color as number) : 0x6FB9F0;
  const iconCustomEmojiId =
    typeof body.icon_custom_emoji_id === "string" ? (body.icon_custom_emoji_id as string) : undefined;
  ts.forumTopics.insert({
    chat_id: chat.chat_id,
    message_thread_id,
    name,
    icon_color: iconColor,
    icon_custom_emoji_id: iconCustomEmojiId,
  });
  const out: Record<string, unknown> = { message_thread_id, name, icon_color: iconColor };
  if (iconCustomEmojiId) out.icon_custom_emoji_id = iconCustomEmojiId;
  return ok(c, out);
}

export function editForumTopicMethod(c: Context, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  const threadId = typeof body.message_thread_id === "number" ? (body.message_thread_id as number) : null;
  if (threadId === null) return tgError(c, "Bad Request: message_thread_id is required");
  const { chat, error } = requireForumChat(c, chatId, store);
  if (error) return error;
  const topic = findForumTopic(store, chat.chat_id, threadId);
  if (!topic) return tgError(c, "Bad Request: topic not found");
  const ts = getTelegramStore(store);
  const updates: Partial<typeof topic> = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.icon_custom_emoji_id === "string") updates.icon_custom_emoji_id = body.icon_custom_emoji_id;
  ts.forumTopics.update(topic.id, updates);
  return okRaw(c, true);
}

export function closeForumTopicMethod(c: Context, body: Record<string, unknown>, store: Store, close: boolean) {
  const chatId = coerceChatId(body.chat_id);
  const threadId = typeof body.message_thread_id === "number" ? (body.message_thread_id as number) : null;
  if (threadId === null) return tgError(c, "Bad Request: message_thread_id is required");
  const { chat, error } = requireForumChat(c, chatId, store);
  if (error) return error;
  const topic = findForumTopic(store, chat.chat_id, threadId);
  if (!topic) return tgError(c, "Bad Request: topic not found");
  const ts = getTelegramStore(store);
  ts.forumTopics.update(topic.id, { is_closed: close });
  return okRaw(c, true);
}

export function deleteForumTopicMethod(c: Context, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  const threadId = typeof body.message_thread_id === "number" ? (body.message_thread_id as number) : null;
  if (threadId === null) return tgError(c, "Bad Request: message_thread_id is required");
  const { chat, error } = requireForumChat(c, chatId, store);
  if (error) return error;
  const topic = findForumTopic(store, chat.chat_id, threadId);
  if (!topic) return tgError(c, "Bad Request: topic not found");
  const ts = getTelegramStore(store);
  ts.forumTopics.update(topic.id, { is_deleted: true });
  return okRaw(c, true);
}
