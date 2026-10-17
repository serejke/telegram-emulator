import type { Bot } from "grammy";
import type { TestBot } from "@emulators/telegram/test";
import type { MountContext, MountFactory, MountOptions, MountedBot } from "./types.js";

/**
 * Long-polling mount. Builds the grammy Bot via the factory, calls
 * `bot.init()`, then starts `bot.start()` in the background. The returned
 * promise resolves once the initial drop-pending phase completes — which
 * means any message the test sends afterwards is guaranteed to reach the
 * real poll loop rather than being discarded.
 */
export async function mountPolling<B extends Bot>(
  ctx: MountContext,
  bot: TestBot,
  factory: MountFactory<B>,
  opts: MountOptions = {},
): Promise<MountedBot<B>> {
  const b = factory(bot.token, ctx.url);
  await b.init();

  let startErr: unknown;
  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });

  const started = b
    .start({
      drop_pending_updates: opts.dropPendingUpdates ?? true,
      allowed_updates: opts.allowedUpdates as never,
      onStart: () => onReady(),
    })
    .catch((err: unknown) => {
      startErr = err;
      onReady();
    });

  await ready;
  if (startErr) throw startErr;

  return {
    bot: b,
    async stop() {
      await b.stop();
      await started;
    },
  };
}
