import type { TelegramTestClient, TestChat, TestUser } from "@emulators/telegram/test";

export interface SendMediaOptions {
  caption?: string;
  mimeType?: string;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
}

export type SendMediaResult = { message_id: number; update_id: number; file_id: string };

export interface SimulateChatApi {
  send(text: string, opts?: { replyTo?: number }): Promise<{ message_id: number; update_id: number }>;
  sendPhoto(bytes: Buffer | Uint8Array, opts?: Pick<SendMediaOptions, "caption" | "mimeType">): Promise<SendMediaResult>;
  sendDocument(bytes: Buffer | Uint8Array, opts?: SendMediaOptions): Promise<SendMediaResult>;
  sendVideo(bytes: Buffer | Uint8Array, opts?: SendMediaOptions): Promise<SendMediaResult>;
  sendAudio(bytes: Buffer | Uint8Array, opts?: SendMediaOptions): Promise<SendMediaResult>;
  sendVoice(bytes: Buffer | Uint8Array, opts?: SendMediaOptions): Promise<SendMediaResult>;
  sendAnimation(bytes: Buffer | Uint8Array, opts?: SendMediaOptions): Promise<SendMediaResult>;
  sendSticker(bytes: Buffer | Uint8Array, opts?: Pick<SendMediaOptions, "mimeType" | "fileName">): Promise<SendMediaResult>;
  edit(messageId: number, text: string): Promise<{ update_id: number }>;
  click(messageId: number, callbackData: string): Promise<{ callback_query_id: string; update_id: number }>;
  react(
    messageId: number,
    emoji: string | Array<{ type: "emoji"; emoji: string }>,
  ): Promise<{ update_id: number }>;
  reply(toMessageId: number, text: string): Promise<{ message_id: number; update_id: number }>;
}

export interface SimulateUserApi {
  in(chat: TestChat): SimulateChatApi;
}

export function createSimulate(tg: TelegramTestClient) {
  return function as(user: TestUser): SimulateUserApi {
    return {
      in(chat) {
        const sendUserMediaKind = (
          kind: "video" | "audio" | "voice" | "animation" | "sticker" | "document",
          bytes: Buffer | Uint8Array,
          opts: SendMediaOptions | undefined,
        ) =>
          tg.sendUserMedia({
            chatId: chat.id,
            userId: user.id,
            kind,
            bytes,
            caption: opts?.caption,
            mimeType: opts?.mimeType,
            fileName: opts?.fileName,
            duration: opts?.duration,
            width: opts?.width,
            height: opts?.height,
          });

        return {
          send(text, opts) {
            return tg.sendUserMessage({
              chatId: chat.id,
              userId: user.id,
              text,
              replyToMessageId: opts?.replyTo,
            });
          },
          sendPhoto(bytes, opts) {
            return tg.sendUserPhoto({
              chatId: chat.id,
              userId: user.id,
              photoBytes: bytes,
              mimeType: opts?.mimeType,
              caption: opts?.caption,
            });
          },
          sendDocument(bytes, opts) {
            return sendUserMediaKind("document", bytes, opts);
          },
          sendVideo(bytes, opts) {
            return sendUserMediaKind("video", bytes, opts);
          },
          sendAudio(bytes, opts) {
            return sendUserMediaKind("audio", bytes, opts);
          },
          sendVoice(bytes, opts) {
            return sendUserMediaKind("voice", bytes, opts);
          },
          sendAnimation(bytes, opts) {
            return sendUserMediaKind("animation", bytes, opts);
          },
          sendSticker(bytes, opts) {
            return sendUserMediaKind("sticker", bytes, opts);
          },
          edit(messageId, text) {
            return tg.editUserMessage({
              chatId: chat.id,
              messageId,
              userId: user.id,
              text,
            });
          },
          click(messageId, callbackData) {
            return tg.clickInlineButton({
              chatId: chat.id,
              userId: user.id,
              messageId,
              callbackData,
            });
          },
          react(messageId, emoji) {
            const reaction =
              typeof emoji === "string" ? [{ type: "emoji" as const, emoji }] : emoji;
            return tg.reactToMessage({
              chatId: chat.id,
              messageId,
              userId: user.id,
              reaction,
            });
          },
          reply(toMessageId, text) {
            return tg.sendUserMessage({
              chatId: chat.id,
              userId: user.id,
              text,
              replyToMessageId: toMessageId,
            });
          },
        };
      },
    };
  };
}
