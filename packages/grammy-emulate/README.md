# grammy-emulate

End-to-end tests for [grammY](https://grammy.dev) bots.
It starts a Telegram Bot API emulator in your test process, runs your unmodified bot against it, and lets the test act as users and read back what the bot did.

No bot token, no network, no second Telegram account.

- [Install](#install)
- [Quick start](#quick-start)
- [Why](#why)
- [How a test runs](#how-a-test-runs)
- [API](#api)
- [Recipes](#recipes)
- [Gotchas](#gotchas)

## Install

```bash
npm install --save-dev grammy-emulate
```

Peer dependencies: `grammy ^1.40.0`, and `vitest >=1.0.0` if you use `grammy-emulate/vitest`.

## Quick start

```ts
import { describe, test, expect } from "vitest";
import { Bot } from "grammy";
import { emulator } from "grammy-emulate";
import { emuVitest } from "grammy-emulate/vitest";

const emu = emulator();
emuVitest(emu); // start before all, reset after each, stop after all

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

The usual ways to test a grammY bot each fake a different layer.

| Approach                                           | What is fake                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Transformer mocks (`bot.api.config.use`)           | Every API response. You invent `message_id`s and chat shapes. There is no chat state across calls.     |
| `bot.handleUpdate(fakeUpdate)`                     | Every incoming Update. You write entity offsets by hand. No `getUpdates`, no webhook, no Privacy Mode. |
| Real bot on real Telegram, driven by a user client | Nothing, but it is slow, flaky, needs a second account, and does not run offline.                      |

grammY's own docs say about this: _"such testing frameworks largely do not exist"_ ([Deployment checklist, Testing](https://grammy.dev/advanced/deployment#testing)).

grammy-emulate moves the fake one level down, to the Telegram server.
Your bot runs with its real HTTP client, real polling or webhook loop, and real middleware.
The emulator keeps chat state, allocates ids, parses entities, and applies Privacy Mode, so multi-step flows (send, click, edit, react) work without hand-written fixtures.

The emulator is [`@serejke/telegram-emulator`](https://github.com/serejke/telegram-emulator/tree/main/packages/telegram-emulator), published from the same repository.

## How a test runs

```text
emu.start()
  server = startTelegramEmulator(port)        # in-process HTTP server, in-memory state
  client = control-plane client for server.url

emu.seed.bot / user / privateChat / group ...
  POST /_emu/telegram/...                     # creates rows; returns { bot_id, token }, { id }, ...

emu.mount(bot, factory)
  b = factory(bot.token, server.url)          # your Bot, with apiRoot pointing at the emulator
  b.init()                                    # getMe
  polling: b.start() in the background; resolve once grammY's onStart fires
  webhook: start a receiver on a free port; b.api.setWebhook(receiver, secret_token)

emu.as(alice).in(dm).send("/start")
  POST /_emu/telegram/chats/{dm}/messages     # stores the message, enqueues an Update
                                              # your bot receives it and calls sendMessage

emu.in(dm).waitForReply()
  every 25ms: GET /_emu/telegram/chats/{dm}/messages?scope=bot
  return the first bot message after afterMessageId, or throw after 3s

emu.reset()                                   # after each test, via emuVitest
  stop mounted bots; cancel pending long polls; wipe all emulator state
```

Two things follow from this.
The test and the bot run concurrently, so every read of bot output must wait (`waitForReply`, `waitForReplyCount`, or your own polling).
And the bot under test is ordinary grammY code: no test hooks inside it.

## API

### `emulator(options?)`

Creates an emulator handle. It does not start a server.

```ts
const emu = emulator({
  port: 4007,
  seed: {
    /* TelegramSeedConfig */
  },
});
```

| Option | Default                 | Meaning                                                                                                                                                                                       |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port` | random in `4100`–`4899` | Port for the emulator. The random port is not checked for availability.                                                                                                                       |
| `seed` | –                       | Startup fixtures, as in [`startTelegramEmulator`](https://github.com/serejke/telegram-emulator/tree/main/packages/telegram-emulator#starttelegramemulatoroptions). Applied once at `start()`. |

`emu.url` and `emu.port` are available after `start()`.
Every other method also requires a started emulator.

### Lifecycle

| Method        | What it does                                                                       |
| ------------- | ---------------------------------------------------------------------------------- |
| `emu.start()` | Starts the server. No-op if already started.                                       |
| `emu.stop()`  | Stops all mounted bots, then closes the server.                                    |
| `emu.reset()` | Stops all mounted bots, cancels pending long polls, and clears all emulator state. |

`emuVitest(emu, { resetBetweenTests = true })` from `grammy-emulate/vitest` registers `beforeAll(start)`, `afterAll(stop)`, and `afterEach(reset)`.

### `emu.seed`

Creates fixtures through the control plane.
Bots and users are matched by `username`; seeding an existing username returns the existing row.

```ts
emu.seed.bot({ username, first_name?, token?, can_join_groups?, can_read_all_group_messages?, commands? }) // → TestBot
emu.seed.user({ first_name, last_name?, username?, language_code? })                                       // → TestUser
emu.seed.privateChat(bot, user)                                                                            // → TestChat
emu.seed.group({ title, users, bots })                                                                     // → TestChat
emu.seed.supergroup({ title, users, bots })                                                                // → TestChat
emu.seed.channel({ title, bots, users?, username? })                                                       // → TestChat
emu.seed.forumTopic(supergroup, name)                                                                      // → { message_thread_id, name }
```

- `can_read_all_group_messages: true` turns Privacy Mode off for that bot.
- In a group, the first user becomes the creator.
- `forumTopic` marks the supergroup as a forum.

### `emu.mount(bot, factory, options?)`

Starts a grammY bot against the emulator and returns `{ bot, stop }`.
The factory receives the token and the emulator URL, and returns a `Bot` with its handlers registered.
Do not call `bot.start()` in the factory; `mount` does that.

```ts
const { bot: b, stop } = await emu.mount(bot, (token, apiRoot) => {
  const b = new Bot(token, { client: { apiRoot } });
  b.command("start", (ctx) => ctx.reply("hi"));
  return b;
});
```

| Option               | Default     | Meaning                                                                                                 |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `mode`               | `"polling"` | `"polling"` or `"webhook"`.                                                                             |
| `allowedUpdates`     | –           | Passed as `allowed_updates` to `getUpdates` (polling) or `setWebhook` (webhook).                        |
| `dropPendingUpdates` | `true`      | Passed to grammY as `drop_pending_updates`. The emulator currently ignores it; see [Gotchas](#gotchas). |

Mounted bots are stopped by `emu.reset()` and `emu.stop()`.
Call `stop()` yourself only to stop a bot in the middle of a test.

### `emu.as(user).in(chat)`

Acts as a user in a chat.
Each call stores a message (or click, edit, reaction) and enqueues Updates for the bots that may see it.

```ts
const act = emu.as(alice).in(dm);

act.send(text, { replyTo? })           // → { message_id, update_id }
act.reply(toMessageId, text)           // same as send(text, { replyTo: toMessageId })
act.edit(messageId, text)              // → { update_id }
act.click(messageId, callbackData)     // → { callback_query_id, update_id }
act.react(messageId, "👍")             // or an array of { type: "emoji", emoji }; → { update_id }

act.sendPhoto(bytes, { caption?, mimeType? })   // → { message_id, update_id, file_id }
act.sendDocument(bytes, opts?)                  // opts: caption, mimeType, fileName, duration, width, height
act.sendVideo(bytes, opts?)
act.sendAudio(bytes, opts?)
act.sendVoice(bytes, opts?)
act.sendAnimation(bytes, opts?)
act.sendSticker(bytes, { mimeType?, fileName? })
```

`update_id` is `0` when no bot received the action, for example a group message filtered by Privacy Mode.

### `emu.in(chat)`

Reads the chat's messages.
Deleted messages are excluded; lists are ordered by `message_id`.

```ts
const view = emu.in(dm);

view.messages()        // all messages, users and bots
view.replies()         // messages sent by bots
view.lastMessage()     // → TestMessage | undefined
view.lastReply()
view.waitForReply({ matcher?, timeoutMs = 3000, afterMessageId = 0 })
view.waitForReplyCount(n, { timeoutMs = 3000 })   // resolves when replies().length >= n
view.drafts(draftId)   // sendMessageDraft snapshots → { seq, text, bot_id }[]
```

`waitForReply` returns the earliest bot message with `message_id > afterMessageId` that passes `matcher`.

`emu.inspect.callbackAnswer(callbackQueryId)` returns `{ answered, answer_text?, answer_show_alert?, answer_url?, answer_cache_time? }` or `null`.
`emu.inspect.in(chat)` is the same as `emu.in(chat)`.

### `emu.faults`

Makes the next N calls of a Bot API method fail, so the bot's error paths run.

```ts
await emu.faults.inject({
  bot,
  method: "sendMessage",
  code: 429,
  retryAfter: 2,
  count: 1,
});
await emu.faults.clear();

// Inject, run, and always clear, even if the block throws.
await emu.faults.during(
  async () => {
    /* ... */
  },
  { bot, method: "sendMessage", code: 403 },
);
```

| Field         | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `bot`         | The `TestBot` whose calls fail.                                                      |
| `method`      | A Bot API method name, or `"*"` for any method (including `getUpdates`).             |
| `code`        | `400`, `401`, `403`, `404`, or `429`.                                                |
| `description` | Optional. Defaults to a code-specific text, e.g. `Too Many Requests: retry after 2`. |
| `retryAfter`  | Sent as `parameters.retry_after`.                                                    |
| `count`       | How many calls fail. Default `1`.                                                    |

### Vitest matchers (`grammy-emulate/vitest`)

Importing `grammy-emulate/vitest` registers the matchers.

```ts
expect(message).toMatchReply("exact text");
expect(message).toMatchReply(/regex/);
expect(message).toMatchReply({ message_id: 5 }); // each key compared with ===

await expect(emu.in(chat)).toHaveReplied("text" /* or /regex/ */);
await expect(emu.in(chat)).toHaveReplyCount(2);
await expect(answer).toHaveAnsweredCallback(); // answer from emu.inspect.callbackAnswer
```

`toMatchReply` is synchronous.
The other three are async and must be awaited.

## Recipes

### Multi-step flows

Each `waitForReply` should start after the message that triggers it.

```ts
const first = await emu.as(alice).in(dm).send("/echo one");
const r1 = await emu.in(dm).waitForReply({ afterMessageId: first.message_id });

const second = await emu.as(alice).in(dm).send("/echo two");
const r2 = await emu.in(dm).waitForReply({ afterMessageId: second.message_id });
```

### Inline keyboards and callbacks

```ts
await emu.as(alice).in(dm).send("/menu");
const menu = await emu.in(dm).waitForReply();

const click = await emu.as(alice).in(dm).click(menu.message_id, "menu:close");

// Wait for the bot's side effect, then check the callback answer.
const answer = await emu.inspect.callbackAnswer(click.callback_query_id);
await expect(answer).toHaveAnsweredCallback();
```

A bot edit keeps the `message_id` and sets `edit_date`.
To wait for an edit, poll `replies()` until that message has `edit_date`.

### Groups and Privacy Mode

```ts
const group = await emu.seed.group({
  title: "Team",
  users: [alice, bob],
  bots: [bot],
});

await emu.as(alice).in(group).send("hello everyone"); // not delivered: Privacy Mode
await emu.as(alice).in(group).send("/echo@my_bot hi"); // delivered: addressed command
```

With Privacy Mode on (the default), a bot in a group only receives messages that mention `@its_username` or use `/command@its_username`.
A bare `/command` is not delivered.
Seed the bot with `can_read_all_group_messages: true` to receive everything.

### Webhook mode

```ts
await emu.mount(bot, factory, { mode: "webhook", allowedUpdates: ["message"] });
```

`mount` starts an HTTP server on a free local port, wraps the bot in grammY's `webhookCallback` with a random secret token, and registers it with `setWebhook`.
The emulator posts each Update to that server with the `X-Telegram-Bot-Api-Secret-Token` header, and retries on 5xx.
Tests look the same as in polling mode.

### Error paths

```ts
const errors: unknown[] = [];

await emu.mount(bot, (token, apiRoot) => {
  const b = new Bot(token, { client: { apiRoot } });
  b.command("start", (ctx) => ctx.reply("welcome"));
  b.catch((err) => {
    errors.push(err.error);
  }); // GrammyError with error_code 403
  return b;
});

await emu.faults.inject({ bot, method: "sendMessage", code: 403 }); // user blocked the bot
await emu.as(alice).in(dm).send("/start");
// wait until errors.length === 1; the chat has no replies
```

### Media

```ts
const sent = await emu
  .as(alice)
  .in(dm)
  .sendPhoto(pngBytes, { caption: "look" });
// sent.file_id is the largest photo size, the same id the bot sees in ctx.message.photo
```

Photos get three sizes, computed from the image header.
Other kinds (`sendVideo`, `sendDocument`, ...) store the bytes as given.
The bot can call `getFile` and download from `${apiRoot}/file/bot${token}/${file_path}`, or re-send by `file_id`, which keeps the same id.

### Beyond the fluent API

Channel posts, adding or removing a bot, promoting admins, and other control-plane actions are on the lower-level test client.
Create one against the running emulator:

```ts
import { createTelegramTestClient } from "@serejke/telegram-emulator/test";

const tg = createTelegramTestClient(emu.url);
const channel = await emu.seed.channel({ title: "News", bots: [bot] });
await tg.postAsChannel({ chatId: channel.id, text: "hello subscribers" });
await tg.addBotToChat({
  chatId: group.id,
  botId: otherBot.bot_id,
  byUserId: alice.id,
});
```

`@serejke/telegram-emulator` is a dependency of `grammy-emulate`; add it to your own `package.json` if you import it directly.
See its [test client reference](https://github.com/serejke/telegram-emulator/tree/main/packages/telegram-emulator#test-client-serejketelegram-emulatortest).

## Gotchas

- **`reset()` clears everything, including startup `seed` fixtures and the default bot.** With `emuVitest`, the `seed` option only applies to the first test. Create fixtures in `beforeEach` instead.
- **`dropPendingUpdates` has no effect yet.** The emulator ignores `drop_pending_updates`, so a message sent before `mount` is still delivered after it.
- **Async matchers must be awaited.** An unawaited `toHaveReplied` or `toHaveReplyCount` fails as an unhandled rejection, not as a test failure.
- **Use `afterMessageId` in multi-step tests.** Without it, `waitForReply` returns the first bot reply in the chat.
- **Random ports can collide.** If parallel test files hit `EADDRINUSE`, pass `port` explicitly.
- **Request budget.** The emulator server accepts 5000 requests per hour, then answers 403. `waitForReply` polls every 25ms, so a single long test file can reach it. See [Limits](https://github.com/serejke/telegram-emulator/tree/main/packages/telegram-emulator#limits).

## What the emulator covers

Long polling and webhooks; text, photo, document, video, audio, voice, animation, and sticker messages; edits, deletes, and chat actions; MarkdownV2, HTML, and legacy Markdown; inline keyboards and callback queries; reactions; private chats, groups with Privacy Mode, supergroups with forum topics, and channels; `getFile` and file download; fault injection.

Not covered: payments, games, the Business API, Passport, inline mode, media groups, and polls.
Full method list and known differences from Telegram: [`@serejke/telegram-emulator`](https://github.com/serejke/telegram-emulator/tree/main/packages/telegram-emulator#bot-api-coverage).

## Example

[`examples/echo-bot`](https://github.com/serejke/telegram-emulator/tree/main/examples/echo-bot) is a small grammY bot with 21 emulator-driven tests (polling, webhook, media, faults) and one test in the hand-mocked style for comparison.

## License

MIT.
