import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type AppEnv } from "@emulators/core";
import { telegramPlugin } from "../index.js";
import { createTelegramTestClient } from "../test.js";
import type { AddressInfo } from "net";

describe("Telegram test client + real HTTP round-trip", () => {
  let server: ReturnType<typeof serve>;
  let baseUrl: string;

  beforeEach(async () => {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(new Map()));
    telegramPlugin.register(app, store, webhooks, "http://localhost", new Map());

    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("end-to-end: create bot, user, DM, send and receive text", async () => {
    const tg = createTelegramTestClient(baseUrl);

    const bot = await tg.createBot({ username: "trip_test_bot", first_name: "Trip Test" });
    const user = await tg.createUser({ first_name: "Alice" });
    const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });

    const sendRes = await fetch(`${baseUrl}/bot${bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: dm.id, text: "hello from bot" }),
    });
    const sendBody = (await sendRes.json()) as { ok: boolean; result: { text: string } };
    expect(sendBody.ok).toBe(true);
    expect(sendBody.result.text).toBe("hello from bot");

    await tg.sendUserMessage({ chatId: dm.id, userId: user.id, text: "/connect ABC123" });

    const updatesRes = await fetch(`${baseUrl}/bot${bot.token}/getUpdates`);
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
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Telegram");
  });

  it("simulated photo upload and sendPhoto echo via test client", async () => {
    const tg = createTelegramTestClient(baseUrl);
    const bot = await tg.createBot({ username: "b" });
    const user = await tg.createUser({ first_name: "A" });
    const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQIW2P4//8/AAX+Av4zhb9VAAAAAElFTkSuQmCC",
      "base64",
    );

    const up = await tg.sendUserPhoto({ chatId: dm.id, userId: user.id, photoBytes: png, caption: "test" });
    expect(up.file_id).toMatch(/^tg_emu_/);

    const send = await fetch(`${baseUrl}/bot${bot.token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: dm.id, photo: up.file_id, caption: "echo" }),
    });
    const body = (await send.json()) as { ok: boolean; result: { photo: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.result.photo)).toBe(true);
  });
});
