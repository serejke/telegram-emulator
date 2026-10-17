import type { Bot } from "grammy";
import type { TestBot, TestChat, TestUser } from "@emulators/telegram/test";
import { getDispatcher } from "@emulators/telegram";
import { startRuntime, type Runtime, type RuntimeOptions } from "./runtime.js";
import { createSeed, type SeedApi } from "./seed.js";
import { createSimulate, type SimulateUserApi } from "./simulate.js";
import { createInspect, type InspectApi, type InspectChatApi } from "./inspect.js";
import { mountBot, type MountOptions, type MountedBot } from "./mount/index.js";
import { createFaults, type FaultsApi } from "./faults.js";

export type {
  TestBot,
  TestUser,
  TestChat,
  TestMessage,
  TelegramTestClient,
} from "@emulators/telegram/test";

export type { SeedApi } from "./seed.js";
export type { SimulateUserApi, SimulateChatApi, SendMediaOptions, SendMediaResult } from "./simulate.js";
export type { InspectApi, InspectChatApi } from "./inspect.js";
export type { MountedBot, MountOptions, MountMode } from "./mount/index.js";
export type { FaultsApi, FaultSpec, FaultCode } from "./faults.js";

export interface Emulator {
  readonly url: string;
  readonly port: number;
  readonly seed: SeedApi;
  readonly as: (user: TestUser) => SimulateUserApi;
  readonly inspect: InspectApi;
  readonly faults: FaultsApi;

  in(chat: TestChat): InspectChatApi;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;

  mount<B extends Bot>(
    bot: TestBot,
    factory: (token: string, apiRoot: string) => B,
    opts?: MountOptions,
  ): Promise<MountedBot<B>>;
}

export function emulator(opts: RuntimeOptions = {}): Emulator {
  let runtime: Runtime | null = null;
  const mounted: Array<MountedBot<Bot>> = [];

  function rt(): Runtime {
    if (!runtime) throw new Error("emulator: not started. Call .start() first (or use emuVitest(tg)).");
    return runtime;
  }

  function lazySeed(): SeedApi {
    return {
      bot: (o) => createSeed(rt().client).bot(o),
      user: (o) => createSeed(rt().client).user(o),
      privateChat: (b, u) => createSeed(rt().client).privateChat(b, u),
      group: (o) => createSeed(rt().client).group(o),
      supergroup: (o) => createSeed(rt().client).supergroup(o),
      channel: (o) => createSeed(rt().client).channel(o),
      forumTopic: (c, n) => createSeed(rt().client).forumTopic(c, n),
    };
  }

  function lazyInspect(): InspectApi {
    return {
      in: (chat) => createInspect(rt().client).in(chat),
      callbackAnswer: (id) => createInspect(rt().client).callbackAnswer(id),
    };
  }

  function lazyFaults(): FaultsApi {
    return {
      inject: (spec) => createFaults(rt().client).inject(spec),
      clear: () => createFaults(rt().client).clear(),
      during: (fn, spec) => createFaults(rt().client).during(fn, spec),
    };
  }

  const api: Emulator = {
    get url() {
      return rt().url;
    },
    get port() {
      return rt().port;
    },
    seed: lazySeed(),
    as: (user: TestUser) => createSimulate(rt().client)(user),
    inspect: lazyInspect(),
    faults: lazyFaults(),
    in: (chat: TestChat) => createInspect(rt().client).in(chat),

    async start() {
      if (runtime) return;
      runtime = await startRuntime(opts);
    },

    async stop() {
      for (const m of mounted.splice(0)) {
        try {
          await m.stop();
        } catch {
          // swallow — already-stopped bots during test failures
        }
      }
      if (runtime) {
        await runtime.close();
        runtime = null;
      }
    },

    async reset() {
      for (const m of mounted.splice(0)) {
        try {
          await m.stop();
        } catch {
          /* ignore */
        }
      }
      if (runtime) {
        // Cancel any lingering long-poll waiters held by the dispatcher before
        // wiping the store. Without this, a waiter from the previous test's
        // bot (whose client-side fetch grammy already aborted) stays pending
        // and can race with the next test's initial poll.
        getDispatcher(runtime.store).clear();
        await runtime.client.reset();
      }
    },

    async mount<B extends Bot>(
      bot: TestBot,
      factory: (token: string, apiRoot: string) => B,
      mountOpts?: MountOptions,
    ): Promise<MountedBot<B>> {
      const m = await mountBot({ url: rt().url }, bot, factory, mountOpts);
      mounted.push(m as MountedBot<Bot>);
      return m;
    },
  };

  return api;
}
