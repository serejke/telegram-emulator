# grammy-emulate

End-to-end testing for [grammY](https://grammy.dev) bots. Boots an in-process
Telegram Bot API emulator, points your bot at it, and gives you a fluent
surface for seeding, simulation, inspection, and vitest assertions.

No real bot token, no network, no second Telegram account.

> **Status: pre-release.** The underlying Bot API emulator lives in
> [`@emulators/telegram`](https://github.com/vercel-labs/emulate/tree/main/packages/%40emulators/telegram)
> and is still awaiting review at [vercel-labs/emulate#75](https://github.com/vercel-labs/emulate/pull/75),
> so it is not on npm yet. This package targets `@emulators/telegram ^0.9.0`
> and is verified against that build; once the upstream PR lands, the install
> below works end-to-end. Until then, the source here is the artifact.

## Install

```bash
pnpm add -D grammy-emulate
# or
npm i -D grammy-emulate
```

Peer deps: `grammy ^1.40`, optionally `vitest` if you use the matchers.

## Quick start

```ts
import { describe, test, expect } from "vitest";
import { Bot } from "grammy";
import { emulator } from "grammy-emulate";
import { emuVitest } from "grammy-emulate/vitest";

const emu = emulator();
emuVitest(emu);

describe("my bot", () => {
  test("replies to /start", async () => {
    const bot = await emu.seed.bot({ username: "my_bot" });
    const alice = await emu.seed.user({ first_name: "Alice" });
    const dm = await emu.seed.privateChat(bot, alice);

    await emu.mount(bot, (token, apiRoot) => {
      const b = new Bot(token, { client: { apiRoot } });
      b.command("start", (ctx) => ctx.reply("hello"));
      return b;
    });

    await emu.as(alice).in(dm).send("/start");
    const reply = await emu.in(dm).waitForReply();
    expect(reply).toMatchReply("hello");
  });
});
```

## Why

Today, testing a grammY bot means one of these:

1. **Transformer mocks** (`bot.api.config.use`) — stub outgoing API calls one
   at a time. No chat state, no `message_id` allocation, no multi-turn flows.
2. **`bot.handleUpdate(fake)`** — hand-craft `Update` objects and feed them to
   the dispatcher. No wire format, no entity parsing, no Privacy Mode.
3. **Real bot against real Telegram + Telethon driver** — ~4 min / 50 tests,
   flaky, requires a second Telegram account, can't run offline.

The [official docs](https://grammy.dev/advanced/deployment#testing) acknowledge
the gap: _"such testing frameworks largely do not exist."_

`grammy-emulate` fills it. Your bot runs unmodified. You get stateful chats,
real `getUpdates` / webhook semantics, entity parsing, Privacy Mode,
inline-keyboard callback round-trips, media file IDs — everything the real
Bot API has, served by an in-process HTTP server.

Built on top of [`@emulators/telegram`](https://github.com/vercel-labs/emulate/tree/main/packages/%40emulators/telegram)
from [vercel-labs/emulate](https://github.com/vercel-labs/emulate).

## API

### `emulator(opts?)`

Creates an emulator instance. Does not start it yet.

```ts
const emu = emulator({ port: 4007 /* optional; random free port otherwise */ });
```

### Lifecycle

| Method        | Notes                                                       |
| ------------- | ----------------------------------------------------------- |
| `emu.start()` | Boots the HTTP server.                                      |
| `emu.stop()`  | Stops all mounted grammY bots, then closes the server.      |
| `emu.reset()` | Stops mounted bots, clears the dispatcher, wipes the store. |

Use `emuVitest(emu)` to wire these into `beforeAll` / `afterAll` / `afterEach`.

### `emu.seed.*`

Fluent fixture builders.

```ts
emu.seed.bot({ username, first_name?, token?, commands? })
emu.seed.user({ first_name, username?, language_code? })
emu.seed.privateChat(bot, user)
emu.seed.group({ title, users, bots })
emu.seed.supergroup({ title, users, bots })
emu.seed.channel({ title, bots, users?, username? })
emu.seed.forumTopic(supergroup, name)
```

### `emu.mount(bot, factory, opts?)`

Boots a grammY bot against the emulator. Factory receives the token and
`apiRoot` and returns a `Bot` with its handlers already registered.

```ts
// polling (default)
await emu.mount(bot, (token, apiRoot) => {
  const b = new Bot(token, { client: { apiRoot } });
  b.command("start", (ctx) => ctx.reply("hi"));
  return b;
});

// webhook — the plugin stands up a random-port HTTP receiver, calls
// setWebhook on the emulator pointing at it, and verifies the
// X-Telegram-Bot-Api-Secret-Token header on every delivery.
await emu.mount(bot, factory, { mode: "webhook", allowedUpdates: ["message"] });
```

Options:

| Option               | Default     | Meaning                                            |
| -------------------- | ----------- | -------------------------------------------------- |
| `mode`               | `"polling"` | `"polling"` or `"webhook"`.                        |
| `allowedUpdates`     | –           | Filter which update types grammy receives.         |
| `dropPendingUpdates` | `true`      | Discard any updates queued before the bot started. |

### `emu.as(user).in(chat).*`

Simulate user actions.

```ts
emu.as(alice).in(dm).send("/echo hello")
emu.as(alice).in(dm).sendPhoto(bytes, { caption?, mimeType? })
emu.as(alice).in(dm).sendVideo(bytes, { caption?, duration?, width?, height? })
emu.as(alice).in(dm).sendAudio(bytes, { mimeType? })
emu.as(alice).in(dm).sendVoice(bytes, { mimeType?, duration? })
emu.as(alice).in(dm).sendAnimation(bytes, { mimeType? })
emu.as(alice).in(dm).sendSticker(bytes, { mimeType? })
emu.as(alice).in(dm).sendDocument(bytes, { fileName?, mimeType? })
emu.as(alice).in(dm).edit(messageId, "new text")
emu.as(alice).in(dm).click(messageId, "callback:data")
emu.as(alice).in(dm).react(messageId, "👍")
emu.as(alice).in(dm).reply(toMessageId, "reply text")
```

### `emu.in(chat).*`

Inspect bot output.

```ts
emu.in(chat).messages()                    // all messages (user + bot)
emu.in(chat).replies()                     // bot-sent only
emu.in(chat).lastReply()
emu.in(chat).lastMessage()
emu.in(chat).drafts(messageId)             // sendMessageDraft snapshots
emu.in(chat).waitForReply({ matcher?, timeoutMs?, afterMessageId? })
emu.in(chat).waitForReplyCount(n, { timeoutMs? })
```

And:

```ts
emu.inspect.callbackAnswer(callbackQueryId);
```

### `emu.faults.*`

Inject controlled failures to exercise error paths like retry logic, 429
rate-limit handling, and 403 "blocked by user" flows.

```ts
// One-shot inject + clear
await emu.faults.inject({
  bot,
  method: "sendMessage",
  code: 429,
  retryAfter: 2,
  count: 1,
});
await emu.faults.clear();

// Scoped sugar — always cleared on exit, even if the block throws
await emu.faults.during(
  async () => {
    await emu.as(alice).in(dm).send("/start");
    // Bot's sendMessage fails; bot.catch fires with a GrammyError(429).
  },
  { bot, method: "sendMessage", code: 429, retryAfter: 2 },
);
```

Supported codes: `400`, `401`, `403`, `404`, `429`. `count` defaults to `1`.

### Vitest matchers (`grammy-emulate/vitest`)

```ts
expect(msg).toMatchReply(text | regex | Partial<TestMessage>);
expect(emu.in(chat)).toHaveReplied(text | regex);
expect(emu.in(chat)).toHaveReplyCount(n);
expect(answer).toHaveAnsweredCallback();
```

## Showcase

See [`examples/echo-bot`](./examples/echo-bot) for a production-shaped grammY
bot with 22 end-to-end tests across polling, webhook delivery, media kinds, and
fault injection — plus a before/after comparison against transformer-mock style.

```bash
pnpm install
pnpm --filter echo-bot-example test
```

## What the emulator covers

From [`@emulators/telegram`](https://github.com/vercel-labs/emulate/tree/main/packages/%40emulators/telegram):

- **Delivery**: `getUpdates` + long-poll takeover 409, `setWebhook` with
  `secret_token` + 5xx retry, `deleteWebhook`, `getWebhookInfo`.
- **Messaging**: `sendMessage/Photo/Document/Video/Audio/Voice/Animation/Sticker`,
  `editMessageText`, `editMessageReplyMarkup`, `deleteMessage`,
  `sendChatAction`.
- **Parse modes**: MarkdownV2, HTML, legacy Markdown — with UTF-16 entity
  offsets and real Telegram-style error wording on unescaped reserved chars.
- **Callbacks & inline keyboards**: `answerCallbackQuery` with
  text/show_alert/url/cache_time round-trip.
- **Reactions**: `setMessageReaction`, per-user + anonymous count updates.
- **Chats**: private, group, supergroup (with forum topics), channel
  (with `channel_post` / `edited_channel_post`).
- **Forum topics**: create / edit / close / reopen / delete.
- **Privacy Mode** on groups — bare `/cmd` is dropped; `@bot_username` and
  `/cmd@bot_username` pass through.
- **Files**: `getFile` + `/file/bot<token>/...`, stable `file_id` across
  resends.
- **Fault injection**: 401 / 403 / 404 / 429 with `retry_after` for adapter
  retry testing.

Not covered: payments, games, Business API, Passport, inline mode, media
groups, polls. See the upstream [non-goals](https://github.com/vercel-labs/emulate/tree/main/packages/%40emulators/telegram#non-goals).

## License

MIT.
