import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type AppEnv } from "@emulators/core";
import { telegramPlugin } from "../index.js";
import { createTelegramTestClient } from "../test.js";

describe("Telegram test client + in-process HTTP round-trip", () => {
  let app: Hono<AppEnv>;
  let baseUrl: string;

  beforeEach(() => {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    app = new Hono<AppEnv>();
    app.use("*", authMiddleware(new Map()));
    telegramPlugin.register(app, store, webhooks, "http://localhost", new Map());
    baseUrl = "http://localhost:0";
  });

  // Drive the client via Hono's in-process request() API so tests don't
  // need to boot a real HTTP server. Same observable behaviour, no
  // @hono/node-server dependency.
  const makeClient = () =>
    createTelegramTestClient(baseUrl, {
      fetchImpl: async (input, init) => app.request(input, init),
    });

  it("end-to-end: create bot, user, DM, send and receive text", async () => {
    const tg = makeClient();

    const bot = await tg.createBot({ username: "trip_test_bot", first_name: "Trip Test" });
    const user = await tg.createUser({ first_name: "Alice" });
    const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });

    const sendRes = await app.request(`${baseUrl}/bot${bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: dm.id, text: "hello from bot" }),
    });
    const sendBody = (await sendRes.json()) as { ok: boolean; result: { text: string } };
    expect(sendBody.ok).toBe(true);
    expect(sendBody.result.text).toBe("hello from bot");

    await tg.sendUserMessage({ chatId: dm.id, userId: user.id, text: "/connect ABC123" });

    const updatesRes = await app.request(`${baseUrl}/bot${bot.token}/getUpdates`);
    const updates = (await updatesRes.json()) as {
      ok: boolean;
      result: Array<{ message: { text: string; entities: Array<{ type: string }> } }>;
    };
    expect(updates.result).toHaveLength(1);
    expect(updates.result[0].message.text).toBe("/connect ABC123");
    expect(updates.result[0].message.entities[0].type).toBe("bot_command");

    const all = await tg.getAllMessages({ chatId: dm.id });
    expect(all).toHaveLength(2);
  });

  it("inspector returns HTML with Telegram label", async () => {
    const res = await app.request(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Telegram");
  });

  it("simulated photo upload and sendPhoto echo via test client", async () => {
    const tg = makeClient();
    const bot = await tg.createBot({ username: "b" });
    const user = await tg.createUser({ first_name: "A" });
    const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQIW2P4//8/AAX+Av4zhb9VAAAAAElFTkSuQmCC",
      "base64",
    );

    const up = await tg.sendUserPhoto({ chatId: dm.id, userId: user.id, photoBytes: png, caption: "test" });
    expect(up.file_id).toMatch(/^tg_emu_/);

    const send = await app.request(`${baseUrl}/bot${bot.token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: dm.id, photo: up.file_id, caption: "echo" }),
    });
    const body = (await send.json()) as { ok: boolean; result: { photo: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.result.photo)).toBe(true);
  });
});
