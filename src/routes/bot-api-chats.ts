// Chat-inspection Bot API methods: getChat, getChatMember,
// getChatAdministrators, getChatMemberCount, sendChatAction.
import type { Context } from "hono";
import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { ok, okRaw, tgError } from "../http.js";
import { serializeBotAsUser, serializeChatFullInfo, serializeUser } from "../serializers.js";
import type { TelegramChat } from "../entities.js";

function coerceChatId(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type MemberStatus = "creator" | "administrator" | "member" | "left";

function chatMemberStatus(chat: TelegramChat, subjectId: number, isBot: boolean): MemberStatus {
  if (isBot) {
    if (!chat.member_bot_ids.includes(subjectId)) return "left";
    if ((chat.admin_bot_ids ?? []).includes(subjectId)) return "administrator";
    // Bots in their own private chat effectively behave as admins.
    if (chat.type === "private") return "administrator";
    return "member";
  }
  if (!chat.member_user_ids.includes(subjectId)) return "left";
  if (chat.creator_user_id === subjectId) return "creator";
  if ((chat.admin_user_ids ?? []).includes(subjectId)) return "administrator";
  return "member";
}

function adminMemberExtras(status: MemberStatus, chat: TelegramChat): Record<string, unknown> {
  if (status !== "creator" && status !== "administrator") return {};
  const isForum = chat.type === "supergroup" && chat.is_forum === true;
  return {
    can_be_edited: status === "administrator",
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: true,
    can_restrict_members: status === "creator",
    can_promote_members: status === "creator",
    can_change_info: true,
    can_invite_users: true,
    can_post_messages: chat.type === "channel" ? true : undefined,
    can_edit_messages: chat.type === "channel" ? true : undefined,
    can_pin_messages: chat.type !== "channel" ? true : undefined,
    can_manage_topics: isForum ? true : undefined,
  };
}

export function getChat(c: Context, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  return ok(c, serializeChatFullInfo(chat, { store }));
}

export function getChatMember(c: Context, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  const userId = typeof body.user_id === "number" ? (body.user_id as number) : null;
  if (chatId === null || userId === null) return tgError(c, "Bad Request: chat_id and user_id are required");
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");

  const user = ts.users.findOneBy("user_id", userId);
  const bot = ts.bots.findOneBy("bot_id", userId);
  const isBotSubject = !!bot && !user;
  const knownMember =
    (user && chat.member_user_ids.includes(userId)) || (bot && chat.member_bot_ids.includes(userId));

  if (!user && !bot) return tgError(c, "Bad Request: user not found");
  if (!knownMember) return tgError(c, "Bad Request: user not found in chat");

  const status = chatMemberStatus(chat, userId, isBotSubject);
  const userField = user ? serializeUser(user) : bot ? serializeBotAsUser(bot) : undefined;
  const extras = adminMemberExtras(status, chat);
  const out: Record<string, unknown> = { status, user: userField };
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined) out[k] = v;
  }
  return ok(c, out);
}

export function getChatAdministrators(c: Context, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");

  const admins: Record<string, unknown>[] = [];
  const push = (status: "creator" | "administrator", subject: Record<string, unknown>) => {
    const base: Record<string, unknown> = { status, user: subject };
    const extras = adminMemberExtras(status, chat);
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) base[k] = v;
    }
    admins.push(base);
  };

  if (chat.creator_user_id !== undefined) {
    const u = ts.users.findOneBy("user_id", chat.creator_user_id);
    if (u) push("creator", serializeUser(u));
  }
  for (const uid of chat.admin_user_ids ?? []) {
    if (uid === chat.creator_user_id) continue;
    const u = ts.users.findOneBy("user_id", uid);
    if (u) push("administrator", serializeUser(u));
  }
  for (const bid of chat.admin_bot_ids ?? []) {
    const b = ts.bots.findOneBy("bot_id", bid);
    if (b) push("administrator", serializeBotAsUser(b));
  }
  return okRaw(c, admins);
}

export function getChatMemberCount(c: Context, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  const count = chat.member_user_ids.length + chat.member_bot_ids.length;
  return c.json({ ok: true, result: count });
}

export function sendChatAction(c: Context) {
  return c.json({ ok: true, result: true });
}
