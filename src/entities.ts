import type { Entity } from "@emulators/core";

export type MessageEntityType =
  | "mention"
  | "hashtag"
  | "cashtag"
  | "bot_command"
  | "url"
  | "email"
  | "phone_number"
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "spoiler"
  | "code"
  | "pre"
  | "text_link"
  | "text_mention"
  | "custom_emoji";

export interface MessageEntity {
  type: MessageEntityType;
  offset: number;
  length: number;
  url?: string;
  user?: { id: number; is_bot: boolean; first_name: string; username?: string };
  language?: string;
}

export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ReplyKeyboardButton {
  text: string;
}

export interface ReplyKeyboardMarkup {
  keyboard: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  selective?: boolean;
}

export interface ForceReply {
  force_reply: true;
  selective?: boolean;
}

export interface ReplyKeyboardRemove {
  remove_keyboard: true;
  selective?: boolean;
}

export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ForceReply | ReplyKeyboardRemove;

export interface TelegramBot extends Entity {
  bot_id: number;
  token: string;
  username: string;
  first_name: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_allowed_updates: string[] | null;
  commands: Array<{ command: string; description: string }>;
}

export interface TelegramUser extends Entity {
  user_id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface ChatPermissions {
  can_send_messages?: boolean;
  can_send_audios?: boolean;
  can_send_documents?: boolean;
  can_send_photos?: boolean;
  can_send_videos?: boolean;
  can_send_video_notes?: boolean;
  can_send_voice_notes?: boolean;
  can_send_polls?: boolean;
  can_send_other_messages?: boolean;
  can_add_web_page_previews?: boolean;
  can_change_info?: boolean;
  can_invite_users?: boolean;
  can_pin_messages?: boolean;
  can_manage_topics?: boolean;
}

export interface TelegramChat extends Entity {
  chat_id: number;
  type: ChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  member_user_ids: number[];
  member_bot_ids: number[];
  creator_user_id?: number;
  admin_user_ids?: number[];
  admin_bot_ids?: number[];
  next_message_id: number;
  // ChatFullInfo extras — defaulted, mutable via control plane.
  bio?: string;
  description?: string;
  invite_link?: string;
  pinned_message_id?: number;
  permissions?: ChatPermissions;
  slow_mode_delay?: number;
  message_auto_delete_time?: number;
  has_protected_content?: boolean;
  linked_chat_id?: number;
  available_reactions?: ReactionType[];
  accent_color_id?: number;
  max_reaction_count?: number;
  is_forum?: boolean;
}

export interface TelegramMessage extends Entity {
  message_id: number;
  chat_id: number;
  from_user_id: number | null;
  from_bot_id: number | null;
  sender_chat_id: number | null;
  message_thread_id?: number;
  date: number;
  text?: string;
  entities?: MessageEntity[];
  photo?: PhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
  caption?: string;
  caption_entities?: MessageEntity[];
  reply_to_message_id?: number;
  reply_markup?: ReplyMarkup;
  edited_date?: number;
  deleted?: boolean;
}

export interface TelegramFile extends Entity {
  file_id: string;
  file_unique_id: string;
  owner_bot_id: number | null;
  mime_type: string;
  file_size: number;
  width: number;
  height: number;
  file_path: string;
  bytes_base64: string;
  kind: "photo" | "document" | "voice" | "video" | "audio" | "sticker" | "animation";
  file_name?: string;
  duration?: number;
  is_animated?: boolean;
  is_video?: boolean;
  // For photos, the full PhotoSize[] so echoes can reuse the same tiers.
  photo_sizes_json?: string;
}

export interface TelegramFault extends Entity {
  bot_id: number;
  method: string; // "*" or specific method name
  error_code: number;
  description: string;
  retry_after: number | null;
  remaining: number;
}

export interface TelegramForumTopic extends Entity {
  chat_id: number;
  message_thread_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: PhotoSize;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
  thumbnail?: PhotoSize;
}

export interface TelegramAnimation extends TelegramVideo {}

export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  emoji?: string;
  set_name?: string;
}

export interface TelegramDraftSnapshot extends Entity {
  chat_id: number;
  draft_id: number;
  bot_id: number;
  seq: number;
  text: string;
  entities?: MessageEntity[];
}

export interface TelegramCallbackQuery extends Entity {
  callback_query_id: string;
  from_user_id: number;
  message_id: number;
  chat_id: number;
  data: string;
  answered: boolean;
  answer_text?: string;
  answer_show_alert?: boolean;
  answer_url?: string;
  answer_cache_time?: number;
}

export type ReactionType =
  | { type: "emoji"; emoji: string }
  | { type: "custom_emoji"; custom_emoji_id: string };

export interface TelegramReaction extends Entity {
  chat_id: number;
  message_id: number;
  sender_user_id: number | null;
  sender_bot_id: number | null;
  reaction: ReactionType[];
}

export type UpdateType =
  | "message"
  | "edited_message"
  | "callback_query"
  | "channel_post"
  | "edited_channel_post"
  | "my_chat_member"
  | "chat_member"
  | "message_reaction";

export type ChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export interface ChatMemberLike {
  status: ChatMemberStatus;
  user: Record<string, unknown>;
}

export interface TelegramUpdate extends Entity {
  update_id: number;
  for_bot_id: number;
  type: UpdateType;
  payload: Record<string, unknown>;
  delivered: boolean;
  delivered_at: string | null;
  delivery_mode: "webhook" | "polling" | "pending";
  delivery_attempts: number;
  delivery_error: string | null;
}
