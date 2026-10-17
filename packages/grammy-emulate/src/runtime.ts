import type { Store } from "@emulators/core";
import { startTelegramEmulator, type TelegramSeedConfig } from "@serejke/telegram-emulator";
import { createTelegramTestClient, type TelegramTestClient } from "@serejke/telegram-emulator/test";

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
  const emu = await startTelegramEmulator({ port: pickPort(opts.port), seed: opts.seed });
  return { ...emu, client: createTelegramTestClient(emu.url) };
}
