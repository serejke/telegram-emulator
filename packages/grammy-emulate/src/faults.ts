import type { TelegramTestClient, TestBot } from "@emulators/telegram/test";

/** Status codes the emulator's fault injection supports. */
export type FaultCode = 400 | 401 | 403 | 404 | 429;

export interface FaultSpec {
  /** The bot whose calls should fail. */
  bot: TestBot;
  /** The Bot API method to fail, e.g. "sendMessage", "sendPhoto", "getUpdates". */
  method: string;
  /** The HTTP status code the emulator should respond with. */
  code: FaultCode;
  /** Optional human-readable description; defaults to a code-specific string. */
  description?: string;
  /** For 429, the `retry_after` seconds the emulator advertises. */
  retryAfter?: number;
  /**
   * How many consecutive calls to fail before the fault expires and subsequent
   * calls succeed again. Defaults to 1 — the narrowest useful scope.
   */
  count?: number;
}

export interface FaultsApi {
  /** Inject a fault. Returns a handle identifying the injected fault. */
  inject(spec: FaultSpec): Promise<{ fault_id: number }>;
  /** Clear every active fault. */
  clear(): Promise<void>;
  /**
   * Sugar: inject, run the async block, clear. The fault is cleared in a
   * `finally`, so test failures don't leak faults across tests.
   */
  during<T>(fn: () => Promise<T>, spec: FaultSpec): Promise<T>;
}

export function createFaults(tg: TelegramTestClient): FaultsApi {
  return {
    async inject(spec) {
      return tg.injectFault({
        botId: spec.bot.bot_id,
        method: spec.method,
        errorCode: spec.code,
        description: spec.description,
        retryAfter: spec.retryAfter,
        count: spec.count ?? 1,
      });
    },
    async clear() {
      return tg.clearFaults();
    },
    async during(fn, spec) {
      await tg.injectFault({
        botId: spec.bot.bot_id,
        method: spec.method,
        errorCode: spec.code,
        description: spec.description,
        retryAfter: spec.retryAfter,
        count: spec.count ?? 1,
      });
      try {
        return await fn();
      } finally {
        await tg.clearFaults();
      }
    },
  };
}
