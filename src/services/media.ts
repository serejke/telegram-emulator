import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import type { TelegramChat } from "../entities.js";

export type MediaKind = "video" | "animation" | "audio" | "voice" | "sticker" | "document";

export interface MediaFieldInput {
  kind: MediaKind | string;
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
  performer?: string;
  title?: string;
  emoji?: string;
  is_animated?: boolean;
  is_video?: boolean;
}

/** Build the media field object (video/animation/audio/voice/sticker/document)
 *  that lives on a Message, normalised so both the Bot API surface and
 *  the control-plane simulate routes emit identical shapes. */
export function buildMediaField(input: MediaFieldInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    file_id: input.file_id,
    file_unique_id: input.file_unique_id,
  };
  if (input.file_size !== undefined) base.file_size = input.file_size;
  switch (input.kind) {
    case "video":
    case "animation":
      return {
        ...base,
        width: input.width ?? 0,
        height: input.height ?? 0,
        duration: input.duration ?? 0,
        mime_type: input.mime_type,
        file_name: input.file_name,
      };
    case "audio":
      return {
        ...base,
        duration: input.duration ?? 0,
        performer: input.performer,
        title: input.title,
        mime_type: input.mime_type,
        file_name: input.file_name,
      };
    case "voice":
      return {
        ...base,
        duration: input.duration ?? 0,
        mime_type: input.mime_type,
      };
    case "sticker":
      return {
        ...base,
        width: input.width ?? 0,
        height: input.height ?? 0,
        is_animated: input.is_animated ?? false,
        is_video: input.is_video ?? false,
        emoji: input.emoji,
      };
    case "document":
      return {
        ...base,
        file_name: input.file_name,
        mime_type: input.mime_type,
      };
    default:
      return base;
  }
}

/** Allocate the next message_id for a chat and advance the per-chat counter.
 *  Consolidates the read-modify-write that was duplicated at 8+ call sites. */
export function allocateMessageId(store: Store, chat: TelegramChat): number {
  const ts = getTelegramStore(store);
  const messageId = chat.next_message_id;
  ts.chats.update(chat.id, { next_message_id: messageId + 1 });
  return messageId;
}

export function defaultMimeForMediaKind(kind: string): string {
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
    case "document":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}
