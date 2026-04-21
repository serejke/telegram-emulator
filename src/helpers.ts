import { randomBytes, createHash } from "crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Store } from "@emulators/core";
import { getTelegramStore } from "./store.js";
import type {
  MessageEntity,
  PhotoSize,
  TelegramBot,
  TelegramChat,
  TelegramMessage,
  TelegramUser,
} from "./entities.js";

let botIdCounter = 100000;
let userIdCounter = 1000;
let fileSequenceCounter = 1;
let updateSequenceCounter = new Map<number, number>();

export function nextBotId(): number {
  botIdCounter += 1;
  return botIdCounter;
}

export function nextUserId(): number {
  userIdCounter += 1;
  return userIdCounter;
}

export function generateBotToken(botId: number): string {
  const secret = randomBytes(24).toString("base64url").slice(0, 35);
  return `${botId}:${secret}`;
}

export function parseBotIdFromToken(token: string): number | null {
  const m = token.match(/^(\d+):/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function nextFileId(botId: number, chatId: number, tier: string): { file_id: string; file_unique_id: string } {
  fileSequenceCounter += 1;
  const seq = fileSequenceCounter;
  const raw = `${botId}:${chatId}:${seq}:${tier}`;
  const file_id = `tg_emu_${Buffer.from(raw).toString("base64url")}`;
  const file_unique_id = `uq_${createHash("sha1").update(raw).digest("hex").slice(0, 16)}`;
  return { file_id, file_unique_id };
}

export function nextUpdateId(botId: number): number {
  const current = updateSequenceCounter.get(botId) ?? 0;
  const next = current + 1;
  updateSequenceCounter.set(botId, next);
  return next;
}

export function resetCounters(): void {
  botIdCounter = 100000;
  userIdCounter = 1000;
  fileSequenceCounter = 1;
  updateSequenceCounter = new Map();
}

export function ok<T extends Record<string, unknown>>(c: Context, result: T) {
  return c.json({ ok: true, result });
}

export function okRaw(c: Context, result: unknown) {
  return c.json({ ok: true, result });
}

export function tgError(
  c: Context,
  description: string,
  error_code: number = 400,
  status: ContentfulStatusCode = 400,
) {
  return c.json({ ok: false, error_code, description }, status);
}

export async function parseTelegramBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const raw = await c.req.text();
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = await c.req.text();
    const params = new URLSearchParams(raw);
    const result: Record<string, unknown> = {};
    for (const [key, value] of params) {
      result[key] = tryParseJsonScalar(value);
    }
    return result;
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const result: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value !== "string" && typeof (value as File).arrayBuffer === "function") {
        const file = value as File;
        const bytes = Buffer.from(await file.arrayBuffer());
        result[key] = { __file: true, name: file.name, type: file.type, bytes };
      } else {
        result[key] = tryParseJsonScalar(String(value));
      }
    }
    return result;
  }

  return {};
}

function tryParseJsonScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first === "{" || first === "[" || first === '"' || trimmed === "true" || trimmed === "false" || /^-?\d/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

export function resolveBotFromToken(store: Store, token: string): TelegramBot | null {
  const ts = getTelegramStore(store);
  const direct = ts.bots.findOneBy("token", token);
  return direct ?? null;
}

export function parseEntities(text: string, bot?: TelegramBot | null): MessageEntity[] {
  const entities: MessageEntity[] = [];
  if (!text) return entities;
  void bot;

  const overlapsExisting = (start: number, end: number) =>
    entities.some((e) => start < e.offset + e.length && end > e.offset);

  // Bot commands: /command or /command@botname at the start or after whitespace
  const cmdRe = /(?:^|\s)(\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?)/g;
  for (const m of text.matchAll(cmdRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    entities.push({ type: "bot_command", offset: start, length: full.length });
  }

  // Mentions: @username anywhere.
  const mentionRe = /(?:^|[^A-Za-z0-9_\/])(@[A-Za-z0-9_]+)/g;
  for (const m of text.matchAll(mentionRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "mention", offset: start, length: full.length });
    }
  }

  // URLs: http:// or https://... (strip trailing .,!?)]})
  const urlRe = /\bhttps?:\/\/[^\s<]+/g;
  for (const m of text.matchAll(urlRe)) {
    let full = m[0];
    // Trim trailing punctuation not part of a URL.
    full = full.replace(/[.,!?)\]}]+$/, "");
    const start = m.index ?? 0;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "url", offset: start, length: full.length });
    }
  }

  // Emails
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  for (const m of text.matchAll(emailRe)) {
    const full = m[0];
    const start = m.index ?? 0;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "email", offset: start, length: full.length });
    }
  }

  // Hashtags: #tag after whitespace or start
  const hashRe = /(?:^|\s)(#[A-Za-z0-9_]+)/g;
  for (const m of text.matchAll(hashRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "hashtag", offset: start, length: full.length });
    }
  }

  // Cashtags: $AAPL style
  const cashRe = /(?:^|\s)(\$[A-Z]{1,8})\b/g;
  for (const m of text.matchAll(cashRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "cashtag", offset: start, length: full.length });
    }
  }

  entities.sort((a, b) => a.offset - b.offset);
  return entities;
}

export function serializeUser(u: TelegramUser): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: u.user_id,
    is_bot: u.is_bot,
    first_name: u.first_name,
  };
  if (u.last_name) out.last_name = u.last_name;
  if (u.username) out.username = u.username;
  if (u.language_code) out.language_code = u.language_code;
  return out;
}

export function serializeBotAsUser(b: TelegramBot): Record<string, unknown> {
  return {
    id: b.bot_id,
    is_bot: true,
    first_name: b.first_name,
    username: b.username,
  };
}

export function serializeChat(ch: TelegramChat): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: ch.chat_id,
    type: ch.type,
  };
  if (ch.title) out.title = ch.title;
  if (ch.username) out.username = ch.username;
  if (ch.first_name) out.first_name = ch.first_name;
  if (ch.last_name) out.last_name = ch.last_name;
  return out;
}

export function serializeMessage(
  msg: TelegramMessage,
  ctx: { store: Store; depth?: number },
): Record<string, unknown> {
  const ts = getTelegramStore(ctx.store);
  const chat = ts.chats.findOneBy("chat_id", msg.chat_id);
  const fromUser = msg.from_user_id !== null ? ts.users.findOneBy("user_id", msg.from_user_id) : undefined;
  const fromBot = msg.from_bot_id !== null ? ts.bots.findOneBy("bot_id", msg.from_bot_id) : undefined;
  const senderChat =
    msg.sender_chat_id !== null && msg.sender_chat_id !== undefined
      ? ts.chats.findOneBy("chat_id", msg.sender_chat_id)
      : undefined;

  const from = fromUser
    ? serializeUser(fromUser)
    : fromBot
      ? serializeBotAsUser(fromBot)
      : undefined;

  const out: Record<string, unknown> = {
    message_id: msg.message_id,
    date: msg.date,
    chat: chat ? serializeChat(chat) : { id: msg.chat_id, type: "private" },
  };
  if (from) out.from = from;
  if (senderChat) out.sender_chat = serializeChat(senderChat);
  if (msg.message_thread_id !== undefined) out.message_thread_id = msg.message_thread_id;
  if (msg.text !== undefined) out.text = msg.text;
  if (msg.entities && msg.entities.length > 0) out.entities = msg.entities;
  if (msg.photo && msg.photo.length > 0) out.photo = msg.photo;
  if (msg.document) out.document = msg.document;
  if (msg.audio) out.audio = msg.audio;
  if (msg.voice) out.voice = msg.voice;
  if (msg.video) out.video = msg.video;
  if (msg.animation) out.animation = msg.animation;
  if (msg.sticker) out.sticker = msg.sticker;
  if (msg.caption !== undefined) out.caption = msg.caption;
  if (msg.caption_entities && msg.caption_entities.length > 0) out.caption_entities = msg.caption_entities;
  if (msg.reply_to_message_id !== undefined) {
    out.reply_to_message_id = msg.reply_to_message_id;
    const depth = ctx.depth ?? 0;
    if (depth < 1) {
      const quoted = ts.messages
        .findBy("chat_id", msg.chat_id)
        .find((m) => m.message_id === msg.reply_to_message_id && !m.deleted);
      if (quoted) {
        out.reply_to_message = serializeMessage(quoted, { store: ctx.store, depth: depth + 1 });
      }
    }
  }
  if (msg.reply_markup) out.reply_markup = msg.reply_markup;
  if (msg.edited_date !== undefined) out.edit_date = msg.edited_date;
  return out;
}

export function buildPhotoSizes(
  bytes: Buffer,
  botId: number,
  chatId: number,
): { sizes: PhotoSize[]; originalFileId: string; originalUniqueId: string } {
  const { width, height } = readImageDimensions(bytes);
  const tiers: Array<{ tier: string; w: number; h: number }> = [
    { tier: "s", w: Math.min(width, 160), h: Math.max(1, Math.round((Math.min(width, 160) / width) * height)) },
    { tier: "m", w: Math.min(width, 800), h: Math.max(1, Math.round((Math.min(width, 800) / width) * height)) },
    { tier: "x", w: width, h: height },
  ];
  const sizes: PhotoSize[] = [];
  let originalFileId = "";
  let originalUniqueId = "";
  for (const t of tiers) {
    const { file_id, file_unique_id } = nextFileId(botId, chatId, t.tier);
    sizes.push({
      file_id,
      file_unique_id,
      width: t.w,
      height: t.h,
      file_size: bytes.length,
    });
    if (t.tier === "x") {
      originalFileId = file_id;
      originalUniqueId = file_unique_id;
    }
  }
  return { sizes, originalFileId, originalUniqueId };
}

export function readImageDimensions(bytes: Buffer): { width: number; height: number } {
  // PNG: width at offset 16 (BE uint32), height at 20
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: walk markers
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = bytes.readUInt16BE(i + 5);
        const width = bytes.readUInt16BE(i + 7);
        return { width, height };
      }
      const segLen = bytes.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
  }
  // GIF
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // WebP (VP8/VP8L/VP8X)
  if (
    bytes.length >= 30 &&
    bytes.slice(0, 4).toString("ascii") === "RIFF" &&
    bytes.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = bytes.slice(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      const w = (bytes.readUIntLE(24, 3) + 1) & 0xffffff;
      const h = (bytes.readUIntLE(27, 3) + 1) & 0xffffff;
      return { width: w, height: h };
    }
    if (chunk === "VP8 ") {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const b = bytes.slice(21, 25);
      const w = ((b[0] | ((b[1] & 0x3f) << 8)) + 1) & 0xffff;
      const h = ((((b[1] & 0xc0) >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)) + 1) & 0xffff;
      return { width: w, height: h };
    }
  }
  // Fallback for unknown formats (tests often pass tiny bytes)
  return { width: 100, height: 100 };
}

export function generateCallbackQueryId(): string {
  return randomBytes(8).toString("hex");
}
