import type { Bot } from "grammy";
import type { TestBot } from "@emulators/telegram/test";
import type { MountContext, MountFactory, MountOptions, MountedBot } from "./types.js";
import { mountPolling } from "./polling.js";
import { mountWebhook } from "./webhook.js";

export type { MountOptions, MountedBot, MountContext, MountMode, MountFactory } from "./types.js";

/**
 * Boot a grammy bot against the running emulator. Defaults to long-polling.
 * Pass `{ mode: "webhook" }` to use webhook delivery instead — the plugin
 * stands up a random-port HTTP receiver and registers it with the emulator.
 */
export async function mountBot<B extends Bot>(
  ctx: MountContext,
  bot: TestBot,
  factory: MountFactory<B>,
  opts: MountOptions = {},
): Promise<MountedBot<B>> {
  const mode = opts.mode ?? "polling";
  if (mode === "webhook") return mountWebhook(ctx, bot, factory, opts);
  return mountPolling(ctx, bot, factory, opts);
}
