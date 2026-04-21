// Update-delivery Bot API methods: getMe, getUpdates, setWebhook,
// deleteWebhook, getWebhookInfo.
import type { Context } from "hono";
import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { ok, okRaw, tgError } from "../http.js";
import { getDispatcher } from "../dispatcher.js";
import type { TelegramBot } from "../entities.js";

export function getMe(c: Context, bot: TelegramBot) {
  return ok(c, {
    id: bot.bot_id,
    is_bot: true,
    first_name: bot.first_name,
    username: bot.username,
    can_join_groups: bot.can_join_groups,
    can_read_all_group_messages: bot.can_read_all_group_messages,
    supports_inline_queries: bot.supports_inline_queries,
  });
}

export async function getUpdates(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  dispatcher: ReturnType<typeof getDispatcher>,
) {
  const offset = typeof body.offset === "number" ? (body.offset as number) : undefined;
  const limit = typeof body.limit === "number" ? Math.min(body.limit as number, 100) : 100;
  const timeout = typeof body.timeout === "number" ? Math.min(body.timeout as number, 50) : 0;
  const allowedUpdates = Array.isArray(body.allowed_updates)
    ? (body.allowed_updates as string[])
    : bot.webhook_allowed_updates ?? null;

  if (bot.webhook_url) {
    return tgError(c, "Conflict: can't use getUpdates method while webhook is active", 409, 409);
  }
  if (dispatcher.isPolling(bot.bot_id)) {
    return tgError(
      c,
      "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      409,
      409,
    );
  }

  const updates = await dispatcher.getUpdates(bot.bot_id, offset, limit, timeout);
  const filtered =
    allowedUpdates && allowedUpdates.length > 0
      ? updates.filter((u) => allowedUpdates.includes(u.type))
      : updates;
  return c.json({
    ok: true,
    result: filtered.map((u) => u.payload),
  });
}

export function setWebhook(
  c: Context,
  bot: TelegramBot,
  body: Record<string, unknown>,
  store: Store,
) {
  const url = typeof body.url === "string" ? (body.url as string) : "";
  const secret = typeof body.secret_token === "string" ? (body.secret_token as string) : null;
  const allowed = Array.isArray(body.allowed_updates) ? (body.allowed_updates as string[]) : null;

  if (!url) {
    // Empty URL removes the webhook, matching real behaviour.
    return deleteWebhook(c, bot, store);
  }
  // Real Telegram only allows HTTPS webhooks (and rejects localhost, though
  // the emulator is lenient there for hermetic testing).
  if (!/^https:\/\//i.test(url)) {
    return tgError(c, "Bad Request: bad webhook: HTTPS url must be provided for webhook", 400, 400);
  }

  const ts = getTelegramStore(store);
  ts.bots.update(bot.id, {
    webhook_url: url,
    webhook_secret: secret,
    webhook_allowed_updates: allowed,
  });
  return okRaw(c, true);
}

export function deleteWebhook(c: Context, bot: TelegramBot, store: Store) {
  const ts = getTelegramStore(store);
  ts.bots.update(bot.id, { webhook_url: null, webhook_secret: null, webhook_allowed_updates: null });
  return okRaw(c, true);
}

export function getWebhookInfo(c: Context, bot: TelegramBot) {
  return ok(c, {
    url: bot.webhook_url ?? "",
    has_custom_certificate: false,
    pending_update_count: 0,
    allowed_updates: bot.webhook_allowed_updates ?? undefined,
  });
}
