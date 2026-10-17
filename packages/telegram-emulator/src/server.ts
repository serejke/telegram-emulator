import { once } from "node:events";
import { createServer, serve, type Store } from "@emulators/core";
import { telegramPlugin, seedFromConfig, type TelegramSeedConfig } from "./index.js";

export interface StartOptions {
  /** Port to listen on. Defaults to 4014. */
  port?: number;
  /**
   * Listening address. Defaults to IPv4 loopback (`127.0.0.1`), so the
   * emulator — which accepts any seeded bot token and exposes control
   * routes — is unreachable from other hosts. Pass `"0.0.0.0"` to expose it
   * on all interfaces (e.g. from inside a container).
   */
  hostname?: string;
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
export const DEFAULT_HOSTNAME = "127.0.0.1";

/** Host to put in the advertised URL so it reaches the bound address. */
function urlHost(hostname: string): string {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

/** Boot the Telegram Bot API emulator on `http://127.0.0.1:<port>` (by default). */
export async function startTelegramEmulator(opts: StartOptions = {}): Promise<TelegramEmulator> {
  const port = opts.port ?? DEFAULT_PORT;
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  const url = `http://${urlHost(hostname)}:${port}`;

  const { app, store } = createServer(telegramPlugin, { port, baseUrl: url, tokens: {} });
  telegramPlugin.seed?.(store, url);
  if (opts.seed) seedFromConfig(store, url, opts.seed);

  const server = serve({ fetch: app.fetch, port, hostname });
  // Resolve only once bound; a bind failure (e.g. EADDRINUSE) rejects here
  // instead of surfacing as an unhandled 'error' event.
  await once(server, "listening");

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
