// ---------------------------------------------------------------------------
// BEFORE: testing a grammy bot without grammy-emulate.
//
// The official grammy docs recommend two primitives:
//   1. `bot.api.config.use(...)` transformers — stub outgoing Bot API calls
//      one at a time, no chat state, no message_id allocation, no flows.
//   2. `bot.handleUpdate(update)` — hand-craft Update objects and feed them
//      to the dispatcher directly, no network.
//
// Here's the same "/echo hello" test written both ways, for comparison with
// bot.test.ts which uses grammy-emulate.
//
// The transformer approach:
//   - no chat state (we mock each call in isolation)
//   - no message_id allocation (the mock has to invent one)
//   - no multi-turn flows (no way to assert on the second reply after an edit)
//   - no real entity parsing (we're not going through the real Bot API path)
//   - no webhook / getUpdates round-trip
// ---------------------------------------------------------------------------
import { describe, test, expect } from "vitest";
import { Bot } from "grammy";

describe("echo bot — transformer-mock style (the 'before')", () => {
  test("/echo hello echoes back — but only by mocking sendMessage one call at a time", async () => {
    const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];

    // Every field below is one you have to hand-fake even though your test
    // doesn't care about it. grammy validates botInfo shape at construction.
    const bot = new Bot("test-token", {
      botInfo: {
        id: 42,
        is_bot: true,
        first_name: "Echo",
        username: "echo_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        can_manage_bots: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        supports_join_request_queries: false,
      },
    });

    // Stub every outgoing Bot API call — we invent shapes the dispatcher won't
    // use, but that are shaped correctly enough that grammy doesn't throw.
    bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ method, payload: payload as Record<string, unknown> });
      if (method === "sendMessage") {
        const chatId = (payload as { chat_id: number }).chat_id;
        return {
          ok: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result: {
            message_id: sent.length,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private", first_name: "Alice" },
            text: (payload as { text: string }).text,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: true, result: true as any };
    });

    bot.command("echo", async (ctx) => {
      const text = ctx.match?.toString().trim();
      if (!text) {
        await ctx.reply("Usage: /echo <text>");
        return;
      }
      await ctx.reply(text);
    });

    // Hand-craft an Update — we have to know exactly what the Bot API would emit.
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 111, type: "private", first_name: "Alice" },
        from: { id: 222, is_bot: false, first_name: "Alice" },
        text: "/echo hello",
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("sendMessage");
    expect((sent[0]?.payload as { text: string }).text).toBe("hello");
  });
});
