import { createServer, serve, type Store } from "@emulators/core";
import telegramPlugin, { seedFromConfig, type TelegramSeedConfig } from "@emulators/telegram";
import { createTelegramTestClient, type TelegramTestClient } from "@emulators/telegram/test";

export interface RuntimeOptions {
  port?: number;
  seed?: TelegramSeedConfig;
  quiet?: boolean;
}

export interface Runtime {
  url: string;
  port: number;
  store: Store;
  client: TelegramTestClient;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 4100;

function pickPort(requested: number | undefined): number {
  if (requested !== undefined) return requested;
  return DEFAULT_PORT + Math.floor(Math.random() * 800);
}

export async function startRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const port = pickPort(opts.port);
  const baseUrl = `http://localhost:${port}`;

  const { app, store } = createServer(telegramPlugin, {
    port,
    baseUrl,
    tokens: {},
  });

  telegramPlugin.seed?.(store, baseUrl);
  if (opts.seed) seedFromConfig(store, baseUrl, opts.seed);

  const server = serve({ fetch: app.fetch, port });
  const client = createTelegramTestClient(baseUrl);

  if (!opts.quiet) {
    // Single-line boot signal; quiet by default in test output.
  }

  return {
    url: baseUrl,
    port,
    store,
    client,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
