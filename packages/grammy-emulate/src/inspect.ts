import type { TelegramTestClient, TestChat, TestMessage } from "@emulators/telegram/test";

export interface InspectChatApi {
  messages(): Promise<TestMessage[]>;
  replies(): Promise<TestMessage[]>;
  lastMessage(): Promise<TestMessage | undefined>;
  lastReply(): Promise<TestMessage | undefined>;
  drafts(messageId: number): Promise<
    Array<{ seq: number; text: string; bot_id: number }>
  >;
  waitForReply(opts?: {
    timeoutMs?: number;
    matcher?: (msg: TestMessage) => boolean;
    afterMessageId?: number;
  }): Promise<TestMessage>;
  waitForReplyCount(
    count: number,
    opts?: { timeoutMs?: number },
  ): Promise<TestMessage[]>;
}

export interface InspectApi {
  in(chat: TestChat): InspectChatApi;
  callbackAnswer(callbackQueryId: string): Promise<{
    callback_query_id: string;
    answered: boolean;
    answer_text?: string;
    answer_show_alert?: boolean;
    answer_url?: string;
    answer_cache_time?: number;
  } | null>;
}

const DEFAULT_WAIT_MS = 3000;
const POLL_INTERVAL_MS = 25;

export function createInspect(tg: TelegramTestClient): InspectApi {
  return {
    in(chat: TestChat): InspectChatApi {
      const messages = () => tg.getAllMessages({ chatId: chat.id });
      const replies = () => tg.getSentMessages({ chatId: chat.id });
      return {
        messages,
        replies,
        async lastMessage() {
          const all = await messages();
          return all[all.length - 1];
        },
        async lastReply() {
          const r = await replies();
          return r[r.length - 1];
        },
        async drafts(messageId: number) {
          const snaps = await tg.getDraftHistory({ chatId: chat.id, draftId: messageId });
          return snaps.map((s) => ({ seq: s.seq, text: s.text, bot_id: s.bot_id }));
        },
        async waitForReply(opts) {
          const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_MS;
          const deadline = Date.now() + timeoutMs;
          const matcher = opts?.matcher ?? (() => true);
          const after = opts?.afterMessageId ?? 0;
          while (Date.now() < deadline) {
            const r = await replies();
            const hit = r.find((m) => m.message_id > after && matcher(m));
            if (hit) return hit;
            await sleep(POLL_INTERVAL_MS);
          }
          const latest = await replies();
          throw new Error(
            `waitForReply timed out after ${timeoutMs}ms; last ${latest.length} replies: ${latest
              .slice(-3)
              .map((m) => JSON.stringify({ id: m.message_id, text: m.text }))
              .join(", ")}`,
          );
        },
        async waitForReplyCount(count, opts) {
          const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_MS;
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const r = await replies();
            if (r.length >= count) return r;
            await sleep(POLL_INTERVAL_MS);
          }
          const latest = await replies();
          throw new Error(
            `waitForReplyCount(${count}) timed out after ${timeoutMs}ms; got ${latest.length}`,
          );
        },
      };
    },
    async callbackAnswer(callbackQueryId) {
      return tg.getCallbackAnswer({ callbackQueryId });
    },
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
