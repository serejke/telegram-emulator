import type { Entity } from "@emulators/core";

export type UpdateType =
  | "message"
  | "edited_message"
  | "callback_query"
  | "channel_post"
  | "edited_channel_post"
  | "my_chat_member"
  | "chat_member"
  | "message_reaction"
  | "message_reaction_count";

export type ChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export interface ChatMemberLike {
  status: ChatMemberStatus;
  // Tightened to WireUser in Phase 6.
  user: Record<string, unknown>;
}

export interface TelegramUpdate extends Entity {
  update_id: number;
  for_bot_id: number;
  type: UpdateType;
  // Tightened to WireUpdate in Phase 6.
  payload: Record<string, unknown>;
  delivered: boolean;
  delivered_at: string | null;
  delivery_mode: "webhook" | "polling" | "pending";
  delivery_attempts: number;
  delivery_error: string | null;
}
