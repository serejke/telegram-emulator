import { expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Emulator } from "./index.js";
import type { TestMessage } from "@emulators/telegram/test";

export interface EmuVitestOptions {
  /** Reset the emulator store between each test. Defaults to true. */
  resetBetweenTests?: boolean;
}

/**
 * Wire emulator lifecycle into the current vitest file.
 *
 *   import { emulator } from "grammy-emulate";
 *   import { emuVitest } from "grammy-emulate/vitest";
 *
 *   const tg = emulator();
 *   emuVitest(tg);
 *
 * Starts before all tests, resets after each test (by default), stops after all.
 */
export function emuVitest(emu: Emulator, opts: EmuVitestOptions = {}): void {
  const resetBetween = opts.resetBetweenTests ?? true;
  beforeAll(async () => {
    await emu.start();
  });
  afterAll(async () => {
    await emu.stop();
  });
  if (resetBetween) {
    afterEach(async () => {
      await emu.reset();
    });
  }
}

interface ReplyMatcherTarget {
  replies: () => Promise<TestMessage[]>;
}

function asReplyTarget(v: unknown): ReplyMatcherTarget | null {
  if (!v || typeof v !== "object") return null;
  const replies = (v as { replies?: unknown }).replies;
  if (typeof replies !== "function") return null;
  return v as ReplyMatcherTarget;
}

interface ExtendMatchers {
  toMatchReply(expected: string | RegExp | Partial<TestMessage>): unknown;
  toHaveReplied(expected: string | RegExp): Promise<unknown>;
  toHaveReplyCount(expected: number): Promise<unknown>;
  toHaveAnsweredCallback(): Promise<unknown>;
}

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T> extends ExtendMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends ExtendMatchers {}
}

expect.extend({
  toMatchReply(
    received: TestMessage | undefined,
    expected: string | RegExp | Partial<TestMessage>,
  ) {
    if (!received) {
      return { pass: false, message: () => `Expected a reply, got undefined` };
    }
    if (typeof expected === "string") {
      const pass = received.text === expected;
      return {
        pass,
        message: () =>
          pass
            ? `Expected reply text NOT to equal ${JSON.stringify(expected)}`
            : `Expected reply text to equal ${JSON.stringify(expected)}, got ${JSON.stringify(received.text)}`,
      };
    }
    if (expected instanceof RegExp) {
      const pass = typeof received.text === "string" && expected.test(received.text);
      return {
        pass,
        message: () =>
          pass
            ? `Expected reply text NOT to match ${expected}`
            : `Expected reply text to match ${expected}, got ${JSON.stringify(received.text)}`,
      };
    }
    const rec = received as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(expected)) {
      if (rec[k] !== v) {
        return {
          pass: false,
          message: () =>
            `Expected reply.${k} to equal ${JSON.stringify(v)}, got ${JSON.stringify(rec[k])}`,
        };
      }
    }
    return { pass: true, message: () => `Reply matched` };
  },

  async toHaveReplied(target: unknown, expected: string | RegExp) {
    const t = asReplyTarget(target);
    if (!t) {
      return {
        pass: false,
        message: () => `toHaveReplied: expected an inspect target (use emu.in(chat))`,
      };
    }
    const replies = await t.replies();
    const matches = replies.filter((m) => {
      if (typeof expected === "string") return m.text === expected;
      return typeof m.text === "string" && expected.test(m.text);
    });
    const pass = matches.length > 0;
    return {
      pass,
      message: () =>
        pass
          ? `Expected chat NOT to have a reply matching ${expected}`
          : `Expected a reply matching ${expected}; got ${replies
              .map((r) => JSON.stringify(r.text))
              .join(", ")}`,
    };
  },

  async toHaveReplyCount(target: unknown, expected: number) {
    const t = asReplyTarget(target);
    if (!t) {
      return { pass: false, message: () => `toHaveReplyCount: not a reply target` };
    }
    const replies = await t.replies();
    const pass = replies.length === expected;
    return {
      pass,
      message: () =>
        pass
          ? `Expected chat NOT to have ${expected} replies`
          : `Expected ${expected} replies; got ${replies.length}`,
    };
  },

  async toHaveAnsweredCallback(received: unknown) {
    const answered =
      received && typeof received === "object" && "answered" in received
        ? (received as { answered: boolean }).answered
        : false;
    return {
      pass: !!answered,
      message: () =>
        answered
          ? `Expected callback NOT to be answered`
          : `Expected callback to be answered, got ${JSON.stringify(received)}`,
    };
  },
});
