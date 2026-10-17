import { createServer, serve, type Store } from "@emulators/core";
import { telegramPlugin, seedFromConfig, type TelegramSeedConfig } from "./index.js";

export interface StartOptions {
  /** Port to listen on. Defaults to 4014. */
  port?: number;
  /** Fixtures applied on top of the default bot/user/chat. */
  seed?: TelegramSeedConfig;
}

export interface TelegramEmulator {
  url: string;
  port: number;
  store: Store;
  close: () => Promise<void>;
}

export const DEFAULT_PORT = 4014;

/** Boot the Telegram Bot API emulator on `http://localhost:<port>`. */
export async function startTelegramEmulator(opts: StartOptions = {}): Promise<TelegramEmulator> {
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://localhost:${port}`;

  const { app, store } = createServer(telegramPlugin, { port, baseUrl: url, tokens: {} });
  telegramPlugin.seed?.(store, url);
  if (opts.seed) seedFromConfig(store, url, opts.seed);

  const server = serve({ fetch: app.fetch, port });

  return {
    url,
    port,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
