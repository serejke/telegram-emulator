import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import type { Bot } from "grammy";
import { webhookCallback } from "grammy";
import { serve } from "@emulators/core";
import type { TestBot } from "@emulators/telegram/test";
import type { MountContext, MountFactory, MountOptions, MountedBot } from "./types.js";

/**
 * Webhook mount. Builds the grammy Bot via the factory, stands up an HTTP
 * receiver on a random free port, registers it with the emulator via
 * `setWebhook(url, { secret_token })`, and relies on the emulator to POST
 * every Update to the receiver. grammy's `webhookCallback` verifies the
 * secret-token header on each delivery, so authentication is exercised
 * end-to-end exactly as in production.
 *
 * Requires `@emulators/telegram >= 0.9.0` (which accepts plain-HTTP loopback
 * URLs for setWebhook).
 */
export async function mountWebhook<B extends Bot>(
  ctx: MountContext,
  bot: TestBot,
  factory: MountFactory<B>,
  opts: MountOptions = {},
): Promise<MountedBot<B>> {
  const b = factory(bot.token, ctx.url);
  await b.init();

  const secretToken = randomUUID().replace(/-/g, "");
  const port = await pickFreePort();
  const receiverUrl = `http://localhost:${port}/`;

  const handler = webhookCallback(b, "std/http", { secretToken });
  const server = serve({ fetch: (req) => handler(req), port });

  try {
    await b.api.setWebhook(receiverUrl, {
      secret_token: secretToken,
      allowed_updates: opts.allowedUpdates as never,
      drop_pending_updates: opts.dropPendingUpdates ?? true,
    });
  } catch (err) {
    await closeServer(server);
    throw err;
  }

  return {
    bot: b,
    async stop() {
      try {
        await b.api.deleteWebhook();
      } catch {
        // Teardown path — swallow so test failures surface the real error.
      }
      await closeServer(server);
    },
  };
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("failed to pick a free port"));
      }
    });
  });
}

function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
