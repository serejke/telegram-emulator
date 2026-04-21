import { telegramPaths } from "./paths.js";

/**
 * Programmatic test client for the Telegram emulator.
 *
 * Create one with a running emulator URL:
 *
 *   const emu = await createEmulator({ service: "telegram", port: 4007 });
 *   const tg = createTelegramTestClient(emu.url);
 *   const bot = await tg.createBot({ username: "trip_test_bot" });
 *   const user = await tg.createUser({ first_name: "Alice" });
 *   const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });
 *   await tg.sendUserMessage({ chatId: dm.id, userId: user.id, text: "/connect ABC" });
 */

export interface TestBot {
  bot_id: number;
  token: string;
  username: string;
  first_name: string;
  webhook_url: string | null;
  commands: Array<{ command: string; description: string }>;
}

export interface TestUser {
  id: number;
  is_bot: false;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TestChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TestMessage {
  message_id: number;
  chat: TestChat;
  from?: { id: number; is_bot: boolean; first_name: string; username?: string };
  date: number;
  text?: string;
  entities?: unknown[];
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  caption?: string;
  reply_to_message_id?: number;
  reply_markup?: Record<string, unknown>;
  edit_date?: number;
}

export interface TelegramTestClient {
  baseUrl: string;

  createBot(input: {
    username: string;
    name?: string;
    first_name?: string;
    token?: string;
    can_join_groups?: boolean;
    can_read_all_group_messages?: boolean;
    commands?: Array<{ command: string; description: string }>;
  }): Promise<TestBot>;

  createUser(input: {
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  }): Promise<TestUser>;

  createPrivateChat(input: { botId: number; userId: number }): Promise<TestChat>;

  createGroupChat(input: {
    title: string;
    type?: "group" | "supergroup";
    memberIds: number[];
    botIds: number[];
  }): Promise<TestChat>;

  sendUserMessage(input: {
    chatId: number;
    userId: number;
    text: string;
    replyToMessageId?: number;
  }): Promise<{ message_id: number; update_id: number }>;

  sendUserPhoto(input: {
    chatId: number;
    userId: number;
    photoBytes: Buffer | Uint8Array;
    mimeType?: string;
    caption?: string;
  }): Promise<{ message_id: number; update_id: number; file_id: string }>;

  clickInlineButton(input: {
    chatId: number;
    userId: number;
    messageId: number;
    callbackData: string;
  }): Promise<{ callback_query_id: string; update_id: number }>;

  editUserMessage(input: {
    chatId: number;
    messageId: number;
    userId: number;
    text: string;
  }): Promise<{ update_id: number }>;

  addBotToChat(input: { chatId: number; botId: number; byUserId: number }): Promise<{ update_id: number }>;
  removeBotFromChat(input: { chatId: number; botId: number; byUserId: number }): Promise<{ update_id: number }>;

  promoteChatMember(input: {
    chatId: number;
    userId?: number;
    botId?: number;
    demote?: boolean;
  }): Promise<void>;

  reactToMessage(input: {
    chatId: number;
    messageId: number;
    userId: number;
    reaction: Array<{ type: "emoji"; emoji: string } | { type: "custom_emoji"; custom_emoji_id: string }>;
  }): Promise<{ update_id: number }>;

  createSupergroup(input: { title: string; memberIds: number[]; botIds: number[] }): Promise<TestChat>;
  createChannel(input: {
    title: string;
    username?: string;
    memberBotIds: number[];
    memberUserIds?: number[];
  }): Promise<TestChat>;
  createForumTopic(input: { chatId: number; name: string }): Promise<{ message_thread_id: number; name: string }>;

  postAsChannel(input: {
    chatId: number;
    text?: string;
    caption?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
  }): Promise<{ message_id: number; update_id: number }>;

  editChannelPost(input: {
    chatId: number;
    messageId: number;
    text?: string;
    caption?: string;
  }): Promise<{ message_id: number; update_id: number }>;

  sendUserMedia(input: {
    chatId: number;
    userId: number;
    kind: "video" | "audio" | "voice" | "animation" | "sticker" | "document";
    bytes: Buffer | Uint8Array;
    mimeType?: string;
    caption?: string;
    duration?: number;
    width?: number;
    height?: number;
    fileName?: string;
    messageThreadId?: number;
  }): Promise<{ message_id: number; update_id: number; file_id: string }>;

  injectFault(input: {
    botId: number;
    method: string;
    errorCode: number;
    description?: string;
    retryAfter?: number;
    count?: number;
  }): Promise<{ fault_id: number }>;

  clearFaults(): Promise<void>;

  getCallbackAnswer(input: { callbackQueryId: string }): Promise<{
    callback_query_id: string;
    answered: boolean;
    answer_text?: string;
    answer_show_alert?: boolean;
    answer_url?: string;
    answer_cache_time?: number;
  } | null>;

  getDraftHistory(input: { chatId: number; draftId: number }): Promise<
    Array<{ seq: number; text: string; entities?: unknown[]; bot_id: number }>
  >;

  getSentMessages(input: { chatId: number }): Promise<TestMessage[]>;
  getAllMessages(input: { chatId: number }): Promise<TestMessage[]>;

  reset(): Promise<void>;
}

interface JsonResponse<T> {
  ok: true;
  [key: string]: unknown;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

async function postJsonOuter<T>(
  fetchImpl: FetchImpl,
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<JsonResponse<T>> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} failed: ${res.status} ${text}`);
  }
  const parsed = (await res.json()) as JsonResponse<T>;
  if (!parsed.ok) throw new Error(`POST ${path} returned ok=false: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function getJsonOuter<T>(fetchImpl: FetchImpl, baseUrl: string, path: string): Promise<JsonResponse<T>> {
  const res = await fetchImpl(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as JsonResponse<T>;
}

export interface CreateTelegramTestClientOptions {
  /** Override the HTTP client used for control-plane calls. Useful in
   *  tests that want to drive a Hono app in-process via `app.request`
   *  without booting a real HTTP server. Defaults to global fetch. */
  fetchImpl?: FetchImpl;
}

export function createTelegramTestClient(
  baseUrl: string,
  options?: CreateTelegramTestClientOptions,
): TelegramTestClient {
  const stripTrailingSlash = baseUrl.replace(/\/+$/, "");
  const root = stripTrailingSlash;
  const fetchImpl: FetchImpl = options?.fetchImpl ?? ((input, init) => fetch(input, init));
  // Local closures shadowing the top-level postJson/getJson names so the
  // existing call sites below still look like postJson(root, ...) without
  // needing to thread fetchImpl through each one.
  const postJson = <T>(r: string, path: string, body: unknown) =>
    postJsonOuter<T>(fetchImpl, r, path, body);
  const getJson = <T>(r: string, path: string) => getJsonOuter<T>(fetchImpl, r, path);

  return {
    baseUrl: root,

    async createBot(input) {
      const r = await postJson(root, telegramPaths.bots(), input);
      return r.bot as TestBot;
    },

    async createUser(input) {
      const r = await postJson(root, telegramPaths.users(), input);
      return r.user as TestUser;
    },

    async createPrivateChat(input) {
      const r = await postJson(root, telegramPaths.privateChat(), input);
      return r.chat as TestChat;
    },

    async createGroupChat(input) {
      const r = await postJson(root, telegramPaths.groupChat(), input);
      return r.chat as TestChat;
    },

    async sendUserMessage(input) {
      const r = await postJson(root, telegramPaths.chatMessages(input.chatId), {
        userId: input.userId,
        text: input.text,
        replyToMessageId: input.replyToMessageId,
      });
      return { message_id: r.message_id as number, update_id: r.update_id as number };
    },

    async sendUserPhoto(input) {
      const buf = Buffer.isBuffer(input.photoBytes) ? input.photoBytes : Buffer.from(input.photoBytes);
      const r = await postJson(root, telegramPaths.chatPhotos(input.chatId), {
        userId: input.userId,
        photoBase64: buf.toString("base64"),
        mimeType: input.mimeType,
        caption: input.caption,
      });
      return {
        message_id: r.message_id as number,
        update_id: r.update_id as number,
        file_id: r.file_id as string,
      };
    },

    async clickInlineButton(input) {
      const r = await postJson(root, telegramPaths.chatCallbacks(input.chatId), {
        userId: input.userId,
        messageId: input.messageId,
        data: input.callbackData,
      });
      return {
        callback_query_id: r.callback_query_id as string,
        update_id: r.update_id as number,
      };
    },

    async editUserMessage(input) {
      const r = await postJson(root, telegramPaths.chatEdits(input.chatId), {
        messageId: input.messageId,
        userId: input.userId,
        text: input.text,
      });
      return { update_id: r.update_id as number };
    },

    async addBotToChat(input) {
      const r = await postJson(root, telegramPaths.chatAddBot(input.chatId), {
        botId: input.botId,
        byUserId: input.byUserId,
      });
      return { update_id: r.update_id as number };
    },

    async removeBotFromChat(input) {
      const r = await postJson(root, telegramPaths.chatRemoveBot(input.chatId), {
        botId: input.botId,
        byUserId: input.byUserId,
      });
      return { update_id: r.update_id as number };
    },

    async promoteChatMember(input) {
      await postJson(root, telegramPaths.chatPromote(input.chatId), {
        userId: input.userId,
        botId: input.botId,
        demote: input.demote,
      });
    },

    async reactToMessage(input) {
      const r = await postJson(root, telegramPaths.chatReactions(input.chatId), {
        messageId: input.messageId,
        userId: input.userId,
        reaction: input.reaction,
      });
      return { update_id: r.update_id as number };
    },

    async createSupergroup(input) {
      const r = await postJson(root, telegramPaths.supergroup(), input);
      return r.chat as TestChat;
    },

    async createChannel(input) {
      const r = await postJson(root, telegramPaths.channel(), input);
      return r.chat as TestChat;
    },

    async createForumTopic(input) {
      const r = await postJson(root, telegramPaths.chatTopics(input.chatId), { name: input.name });
      return { message_thread_id: r.message_thread_id as number, name: r.name as string };
    },

    async postAsChannel(input) {
      const r = await postJson(root, telegramPaths.channelPosts(input.chatId), {
        text: input.text,
        caption: input.caption,
        reply_to_message_id: input.replyToMessageId,
        message_thread_id: input.messageThreadId,
      });
      return { message_id: r.message_id as number, update_id: r.update_id as number };
    },

    async editChannelPost(input) {
      const r = await postJson(root, telegramPaths.channelPostEdits(input.chatId), {
        messageId: input.messageId,
        text: input.text,
        caption: input.caption,
      });
      return { message_id: r.message_id as number, update_id: r.update_id as number };
    },

    async sendUserMedia(input) {
      const buf = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
      const r = await postJson(root, telegramPaths.chatMedia(input.chatId), {
        userId: input.userId,
        kind: input.kind,
        bytesBase64: buf.toString("base64"),
        mimeType: input.mimeType,
        caption: input.caption,
        duration: input.duration,
        width: input.width,
        height: input.height,
        fileName: input.fileName,
        messageThreadId: input.messageThreadId,
      });
      return {
        message_id: r.message_id as number,
        update_id: r.update_id as number,
        file_id: r.file_id as string,
      };
    },

    async injectFault(input) {
      const r = await postJson(root, telegramPaths.faults(), {
        bot_id: input.botId,
        method: input.method,
        error_code: input.errorCode,
        description: input.description,
        retry_after: input.retryAfter,
        count: input.count,
      });
      return { fault_id: r.fault_id as number };
    },

    async clearFaults() {
      const res = await fetch(`${root}${telegramPaths.faults()}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`DELETE ${telegramPaths.faults()} failed: ${res.status}`);
    },

    async getCallbackAnswer(input) {
      const path = telegramPaths.callbackById(encodeURIComponent(input.callbackQueryId));
      const res = await fetch(`${root}${path}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
      return (await res.json()) as {
        callback_query_id: string;
        answered: boolean;
        answer_text?: string;
        answer_show_alert?: boolean;
        answer_url?: string;
        answer_cache_time?: number;
      };
    },

    async getDraftHistory(input) {
      const r = await getJson(root, telegramPaths.chatDraft(input.chatId, input.draftId));
      return r.snapshots as Array<{ seq: number; text: string; entities?: unknown[]; bot_id: number }>;
    },

    async getSentMessages(input) {
      const r = await getJson(root, `${telegramPaths.chatMessages(input.chatId)}?scope=bot`);
      return r.messages as TestMessage[];
    },

    async getAllMessages(input) {
      const r = await getJson(root, `${telegramPaths.chatMessages(input.chatId)}?scope=all`);
      return r.messages as TestMessage[];
    },

    async reset() {
      await postJson(root, telegramPaths.reset(), {});
    },
  };
}
