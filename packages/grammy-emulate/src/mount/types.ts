import type { Bot } from "grammy";

export type MountMode = "polling" | "webhook";

export interface MountOptions {
  /** Delivery mode. Defaults to `"polling"`. */
  mode?: MountMode;
  /**
   * Restrict the update types grammy receives. Passes through to
   * `getUpdates`'s `allowed_updates` in polling mode and to `setWebhook`'s
   * `allowed_updates` in webhook mode.
   */
  allowedUpdates?: string[];
  /**
   * Drop any updates already queued before the bot mounted. Defaults to
   * `true` — matches the typical "fresh test" semantics.
   */
  dropPendingUpdates?: boolean;
}

export interface MountedBot<B extends Bot> {
  /** The grammy Bot instance returned by your factory. */
  bot: B;
  /** Stop polling (or tear the webhook receiver down) and await clean exit. */
  stop: () => Promise<void>;
}

export interface MountContext {
  /** The emulator's base URL, e.g. `http://localhost:4007`. */
  url: string;
}

export type MountFactory<B extends Bot> = (token: string, apiRoot: string) => B;
