import type { Store } from "@emulators/core";
import { getTelegramStore } from "./store.js";
import { nextUpdateId } from "./ids.js";
import { sweep } from "./services/sweeper.js";
import type { TelegramBot, TelegramUpdate, UpdateType } from "./entities.js";

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number[];
}

const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [1000, 2000, 4000],
};

const MAX_QUEUE_PER_BOT = 1000;
const MAX_DELIVERED_HISTORY = 200;

interface LongPollWaiter {
  botId: number;
  offset: number;
  resolve: (updates: TelegramUpdate[]) => void;
}

export class TelegramDispatcher {
  private waiters: LongPollWaiter[] = [];
  private activePolls = new Set<number>();
  private retryPolicy: RetryPolicy = DEFAULT_RETRY;
  private fetchImpl: typeof fetch = fetch;
  private backoffEnabled = true;

  constructor(private store: Store) {}

  setRetryPolicy(policy: Partial<RetryPolicy>): void {
    this.retryPolicy = { ...this.retryPolicy, ...policy };
  }

  setFetchImpl(impl: typeof fetch): void {
    this.fetchImpl = impl;
  }

  setBackoffEnabled(enabled: boolean): void {
    this.backoffEnabled = enabled;
  }

  enqueue(botId: number, type: UpdateType, payload: Record<string, unknown>): TelegramUpdate {
    const ts = getTelegramStore(this.store);
    const bot = ts.bots.findOneBy("bot_id", botId);
    if (!bot) {
      throw new Error(`enqueue: bot ${botId} not found`);
    }

    const update_id = nextUpdateId(this.store, botId);
    const mode: TelegramUpdate["delivery_mode"] = bot.webhook_url ? "webhook" : "pending";

    const inserted = ts.updates.insert({
      update_id,
      for_bot_id: botId,
      type,
      payload: { update_id, [type]: payload },
      delivered: false,
      delivered_at: null,
      delivery_mode: mode,
      delivery_attempts: 0,
      delivery_error: null,
    });

    this.pruneQueue(botId);
    sweep(this.store);

    if (bot.webhook_url) {
      if (!isAllowed(bot.webhook_allowed_updates, type)) {
        // Matches real Telegram's webhook allowlist: filtered updates are
        // never delivered. Mark the row so the inspector shows why.
        ts.updates.update(inserted.id, {
          delivered: true,
          delivered_at: new Date().toISOString(),
          delivery_mode: "webhook",
          delivery_error: "filtered by allowed_updates",
        });
      } else {
        void this.deliverWebhook(inserted, bot);
      }
    } else {
      this.notifyWaiters(botId);
    }

    return inserted;
  }

  private pruneQueue(botId: number): void {
    const ts = getTelegramStore(this.store);
    const forBot = ts.updates
      .findBy("for_bot_id", botId)
      .sort((a, b) => a.update_id - b.update_id);
    const delivered = forBot.filter((u) => u.delivered);
    while (delivered.length > MAX_DELIVERED_HISTORY) {
      const drop = delivered.shift()!;
      ts.updates.delete(drop.id);
    }
    const pending = forBot.filter((u) => !u.delivered);
    while (pending.length > MAX_QUEUE_PER_BOT) {
      const drop = pending.shift()!;
      ts.updates.delete(drop.id);
    }
  }

  private async deliverWebhook(update: TelegramUpdate, bot: TelegramBot): Promise<void> {
    const ts = getTelegramStore(this.store);
    if (!bot.webhook_url) return;

    const body = JSON.stringify(update.payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "emulate-telegram-bot-api/1",
    };
    if (bot.webhook_secret) {
      headers["X-Telegram-Bot-Api-Secret-Token"] = bot.webhook_secret;
    }

    let attempt = 0;
    // Per spec: retry on 5xx up to maxRetries with backoff.
    // 4xx is terminal (matches real Telegram behaviour).
    while (attempt <= this.retryPolicy.maxRetries) {
      try {
        const res = await this.fetchImpl(bot.webhook_url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });

        ts.updates.update(update.id, { delivery_attempts: attempt + 1 });

        if (res.ok) {
          ts.updates.update(update.id, {
            delivered: true,
            delivered_at: new Date().toISOString(),
            delivery_mode: "webhook",
          });
          return;
        }
        if (res.status >= 400 && res.status < 500) {
          ts.updates.update(update.id, {
            delivered: false,
            delivery_error: `webhook responded ${res.status}`,
          });
          return;
        }
        // 5xx -> retry
        ts.updates.update(update.id, {
          delivery_error: `webhook responded ${res.status}`,
        });
      } catch (err) {
        ts.updates.update(update.id, {
          delivery_attempts: attempt + 1,
          delivery_error: err instanceof Error ? err.message : String(err),
        });
      }

      attempt += 1;
      if (attempt > this.retryPolicy.maxRetries) break;
      if (this.backoffEnabled) {
        const delay = this.retryPolicy.backoffMs[attempt - 1] ?? this.retryPolicy.backoffMs[this.retryPolicy.backoffMs.length - 1];
        await sleep(delay);
      }
    }
  }

  isPolling(botId: number): boolean {
    return this.activePolls.has(botId);
  }

  getUpdates(botId: number, offset?: number, limit = 100, timeoutSec = 0): Promise<TelegramUpdate[]> {
    this.activePolls.add(botId);
    const release = () => this.activePolls.delete(botId);

    const ready = this.drain(botId, offset, limit);
    if (ready.length > 0 || timeoutSec === 0) {
      release();
      return Promise.resolve(ready);
    }
    return new Promise<TelegramUpdate[]>((resolve) => {
      const waiter: LongPollWaiter = {
        botId,
        offset: offset ?? 0,
        resolve: (updates) => {
          release();
          resolve(updates.slice(0, limit));
        },
      };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          release();
          resolve(this.drain(botId, offset, limit));
        }
      }, timeoutSec * 1000);
      // Unref so the process can exit if only a long-poll is pending.
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  private drain(botId: number, offset: number | undefined, limit: number): TelegramUpdate[] {
    const ts = getTelegramStore(this.store);
    const all = ts.updates
      .findBy("for_bot_id", botId)
      .sort((a, b) => a.update_id - b.update_id);

    // offset semantics: if set, confirm-and-drop updates with update_id < offset.
    if (offset !== undefined && offset > 0) {
      for (const u of all) {
        if (u.update_id < offset && !u.delivered) {
          ts.updates.update(u.id, {
            delivered: true,
            delivered_at: new Date().toISOString(),
            delivery_mode: "polling",
          });
        }
      }
    }

    const ready = ts.updates
      .findBy("for_bot_id", botId)
      .filter((u) => !u.delivered && (offset === undefined || u.update_id >= (offset ?? 0)))
      .sort((a, b) => a.update_id - b.update_id)
      .slice(0, limit);

    for (const u of ready) {
      ts.updates.update(u.id, {
        delivery_mode: "polling",
      });
    }

    return ready;
  }

  private notifyWaiters(botId: number): void {
    const matching = this.waiters.filter((w) => w.botId === botId);
    for (const waiter of matching) {
      const updates = this.drain(botId, waiter.offset, 100);
      if (updates.length > 0) {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        waiter.resolve(updates);
      }
    }
  }

  clear(): void {
    for (const w of this.waiters) w.resolve([]);
    this.waiters.length = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

function isAllowed(allowed: string[] | null, type: string): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(type);
}

let singleton: WeakMap<Store, TelegramDispatcher> | null = null;

export function getDispatcher(store: Store): TelegramDispatcher {
  if (!singleton) singleton = new WeakMap();
  let d = singleton.get(store);
  if (!d) {
    d = new TelegramDispatcher(store);
    singleton.set(store, d);
  }
  return d;
}
