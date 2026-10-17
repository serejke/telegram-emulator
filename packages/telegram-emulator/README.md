# @serejke/telegram-emulator

A stateful emulator of the Telegram Bot API that runs in your test process.
Point a bot at it instead of `https://api.telegram.org`, play the users from your test, and assert on what the bot did.

It works with any Telegram library in any language, because the bot only sees HTTP.
For grammY bots, [`grammy-emulate`](https://github.com/serejke/telegram-emulator/tree/main/packages/grammy-emulate) wraps it in a fluent test API.

- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Bot API coverage](#bot-api-coverage)
- [Known differences from Telegram](#known-differences-from-telegram)
- [Limits](#limits)
- [Not implemented](#not-implemented)

## Install

```bash
npm install --save-dev @serejke/telegram-emulator
```

Tested on Node.js 22 and 24.

## Quick start

As a standalone server:

```bash
npx @serejke/telegram-emulator --port 4014
```

It starts on `http://127.0.0.1:4014` with one bot (`@emulate_bot`, token `100001:EMULATE_DEFAULT_TOKEN`), one user (`@tester`), and a private chat between them.
Open the URL in a browser to see the inspector.

From a test:

```ts
import { startTelegramEmulator } from "@serejke/telegram-emulator";
import { createTelegramTestClient } from "@serejke/telegram-emulator/test";

const emu = await startTelegramEmulator({ port: 4014 });
const tg = createTelegramTestClient(emu.url);

const bot = await tg.createBot({
  username: "trip_test_bot",
  first_name: "Trip Test",
});
const user = await tg.createUser({ first_name: "Alice" });
const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });

// Start your bot with bot.token and apiRoot = emu.url (see below), then:
await tg.sendUserMessage({
  chatId: dm.id,
  userId: user.id,
  text: "/connect ABC123",
});

// The bot replies asynchronously. Poll until the reply shows up.
const replies = await tg.getSentMessages({ chatId: dm.id });

await emu.close();
```

Point the bot at the emulator by changing its API root:

```ts
// grammY
new Bot(bot.token, { client: { apiRoot: emu.url } });

// Telegraf
new Telegraf(bot.token, { telegram: { apiRoot: emu.url } });
```

## How it works

### Two surfaces on one server

The emulator is one HTTP server with two kinds of routes.

| Surface       | Routes                                            | Who calls it       | What it does                                           |
| ------------- | ------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| Bot API       | `/bot<token>/<method>`, `/file/bot<token>/<path>` | The bot under test | Same wire format as `api.telegram.org`.                |
| Control plane | `/_emu/telegram/*`                                | The test           | Creates fixtures, acts as users, reads state back.     |
| Inspector     | `/`                                               | You, in a browser  | HTML view of chats, bots, and each bot's update queue. |

The bot never sees the control plane.
The test never pretends to be the bot.
Both surfaces read and write the same in-memory state.

### State

All state is a set of in-memory collections.

| Collection                 | Holds                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| `bots`                     | Token, username, privacy flag, webhook config, commands.          |
| `users`                    | Human accounts the test can act as.                               |
| `chats`                    | Type, member user ids, member bot ids, admins, next `message_id`. |
| `messages`                 | Every message in every chat, from users, bots, or channels.       |
| `updates`                  | A per-bot queue of `Update` objects, with delivery status.        |
| `files`                    | Uploaded bytes, keyed by `file_id`.                               |
| `callbackQueries`          | Button clicks and the bot's `answerCallbackQuery` reply.          |
| `reactions`, `forumTopics` | Per-message reactions and forum topics.                           |
| `draftSnapshots`, `faults` | `sendMessageDraft` snapshots and pending injected errors.         |

Ids follow Telegram's conventions:

| Id                 | Allocation                                                 |
| ------------------ | ---------------------------------------------------------- |
| bot id             | `100001`, `100002`, ... The token is `<bot_id>:<secret>`.  |
| user id            | `1001`, `1002`, ...                                        |
| private chat id    | Equal to the user id.                                      |
| group chat id      | `-1000000001`, `-1000000002`, ...                          |
| supergroup chat id | `-1001000000001`, ...                                      |
| channel chat id    | `-1002000000001`, ...                                      |
| `message_id`       | Per chat, starting at 1. Users and bots share the counter. |
| `update_id`        | Per bot, starting at 1.                                    |

### From a user action to an Update

Every control-plane action follows the same shape: write the state change, then enqueue an Update for each bot that is allowed to see it.

```text
simulateUserMessage(chat, user, text):
  require user in chat.member_user_ids
  entities = autodetect(text)              # bot_command, mention, url, email, hashtag, cashtag
  msg = messages.insert(chat, from=user, message_id=chat.next_message_id++)
  for bot in chat.member_bot_ids:
    if chat.type != private and not privacyAllows(bot, text, entities):
      continue
    dispatcher.enqueue(bot, "message", serialize(msg))

privacyAllows(bot, text, entities):        # Telegram's Privacy Mode
  if bot.can_read_all_group_messages: return true
  return any entity is "@bot_username" or "/cmd@bot_username"
```

Other actions differ only in what they write and who receives the Update.

| Action                           | Update type                                   | Receivers                                                              |
| -------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| User sends text                  | `message`                                     | Bots in the chat that pass Privacy Mode.                               |
| User sends photo or other media  | `message`                                     | All bots in private chats; in groups, only bots with Privacy Mode off. |
| User edits a message             | `edited_message`                              | Same rule as text.                                                     |
| User clicks an inline button     | `callback_query`                              | The bot that sent the message with the keyboard.                       |
| User reacts                      | `message_reaction` + `message_reaction_count` | All bots in the chat.                                                  |
| Channel posts or edits a post    | `channel_post` / `edited_channel_post`        | All bots in the channel.                                               |
| Bot added to / removed from chat | `my_chat_member`                              | That bot.                                                              |
| Bot calls `editMessageText`      | `edited_message` / `edited_channel_post`      | The other bots in the chat.                                            |

Bot calls like `sendMessage` only write state.
They do not create Updates for other bots.

### Delivery

`enqueue` writes the Update to the bot's queue, then delivers it one of two ways.

```text
enqueue(bot, type, payload):
  update = updates.insert(bot, update_id = ++bot.update_seq, delivered = false)
  if bot.webhook_url:
    if allowed(bot.webhook_allowed_updates, type): deliverWebhook(update)   # async, not awaited
    else: mark delivered with error "filtered by allowed_updates"
  else:
    wake the bot's pending long poll, if any

deliverWebhook(update):
  for attempt in 0..3:                                  # 1 try + 3 retries
    res = POST bot.webhook_url, json(update),
          header X-Telegram-Bot-Api-Secret-Token = bot.webhook_secret,
          timeout 10s
    if res is 2xx: mark delivered; return
    if res is 4xx: record error; return                 # terminal
    sleep [1s, 2s, 4s][attempt]                         # 5xx or network error
```

Long polling confirms updates by offset, like Telegram.

```text
getUpdates(bot, offset, limit <= 100, timeout <= 50):
  if bot.webhook_url: 409 "can't use getUpdates method while webhook is active"
  mark every update with update_id < offset as delivered
  ready = undelivered updates with update_id >= offset
  if ready or timeout == 0: return ready
  cancel this bot's previous long poll with 409 "terminated by other getUpdates request"
  wait until an update is enqueued or the timeout expires
```

### A Bot API call

```text
POST /bot<token>/<method>:
  bot = find bot by token                     else 401 Unauthorized
  if a fault is queued for (bot, method or "*"): consume one, return it
  body = parse JSON, form-urlencoded, multipart, or query string
  validate body against the method's schema   else 400 "Bad Request: <field> ..."
  run the handler: check chat exists and bot is a member, apply parse_mode,
                   enforce limits, write state, return the wire object
  unknown method                              -> 404 "Method X is not implemented in the emulator"
```

### Reset and seeding

`startTelegramEmulator` seeds the default bot, user, and private chat, then applies your `seed` config on top.
`POST /_emu/telegram/reset` (and `tg.reset()`) clears every collection and every id counter.
It does not replay the default fixtures or your seed config.
After a reset the store is empty and ids start again from `100001` and `1001`.

## API reference

### `startTelegramEmulator(options?)`

```ts
import { startTelegramEmulator } from "@serejke/telegram-emulator";

const emu = await startTelegramEmulator({
  port: 4014,
  seed: {
    /* ... */
  },
});
emu.url; // "http://127.0.0.1:4014"
emu.port; // 4014
emu.store; // the underlying Store, for in-process access
await emu.close();
```

| Option     | Default     | Meaning                                                                                                                                      |
| ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`     | `4014`      | Port to listen on.                                                                                                                           |
| `hostname` | `127.0.0.1` | Interface to bind. The default accepts only local connections. Pass `"0.0.0.0"` to listen on all interfaces, for example inside a container. `url` then advertises `127.0.0.1`. |
| `seed`     | –           | Fixtures added on top of the default bot, user, and chat.                                                                                    |

The emulator has no authentication beyond bot tokens, and the control plane has none at all.
Bind to a non-loopback interface only on a network you trust.

Seed config:

```ts
await startTelegramEmulator({
  seed: {
    bots: [
      {
        username: "trip_bot",
        first_name: "Trip Bot",
        token: "100001:SEEDED_TOKEN_TRIP_BOT",
        can_read_all_group_messages: false,
        commands: [
          { command: "connect", description: "Connect this chat to a trip" },
        ],
      },
    ],
    users: [{ first_name: "Alice", username: "alice_tester" }],
    chats: [
      { type: "private", between: ["trip_bot", "alice_tester"] },
      {
        type: "group",
        title: "Morocco Planning",
        members: ["alice_tester"],
        bots: ["trip_bot"],
      },
    ],
  },
});
```

- Bots and users are matched by `username`. An existing username is skipped.
- `chats[].type` is `"private"` or `"group"`. Create supergroups, channels, and forum topics through the control plane.
- Chats refer to bots and users by username. Unknown usernames are skipped.

Other exports, for in-process use:

| Export                                                        | Use                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `telegramPlugin` (also the default export)                    | The `@emulators/core` service plugin. Register it on your own Hono app to run without a socket.                                                                    |
| `getTelegramStore(store)`                                     | Typed access to the collections.                                                                                                                                   |
| `getDispatcher(store)`                                        | The update dispatcher. `setRetryPolicy({ maxRetries, backoffMs })`, `setBackoffEnabled(false)`, and `setFetchImpl(fn)` speed up or stub webhook delivery in tests. |
| `simulateUserMessage`, `simulateCallback`, `injectFault`, ... | The control-plane operations as plain functions of `(store, input)`.                                                                                               |
| `seedDefaults`, `seedFromConfig`                              | The seeding used by `startTelegramEmulator`.                                                                                                                       |

### CLI

```text
telegram-emulator [--port <n>] [--host <addr>]   # -p, default 4014; --host default 127.0.0.1
telegram-emulator --host 0.0.0.0                 # listen on all interfaces
telegram-emulator --help                         # -h
```

It prints the URL and the default bot token, and stops on SIGINT or SIGTERM.

### Test client (`@serejke/telegram-emulator/test`)

`createTelegramTestClient(baseUrl, options?)` returns a typed wrapper over the control plane.
`options.fetchImpl` replaces `fetch`, for example with `app.request` to drive an in-process Hono app.
Every method throws if the emulator returns an error.

Fixtures:

| Method                                                                                                           | Returns / notes                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `createBot({ username, first_name?, name?, token?, can_join_groups?, can_read_all_group_messages?, commands? })` | `TestBot` `{ bot_id, token, username, first_name, webhook_url, commands }`. Returns the existing bot if the username is taken. |
| `createUser({ first_name, last_name?, username?, language_code? })`                                              | `TestUser` `{ id, first_name, ... }`. Returns the existing user if the username is taken.                                      |
| `createPrivateChat({ botId, userId })`                                                                           | `TestChat`. The chat id equals the user id.                                                                                    |
| `createGroupChat({ title, type?, memberIds, botIds })`                                                           | `TestChat`. The first member becomes the creator.                                                                              |
| `createSupergroup({ title, memberIds, botIds })`                                                                 | `TestChat`.                                                                                                                    |
| `createChannel({ title, username?, memberBotIds, memberUserIds? })`                                              | `TestChat`.                                                                                                                    |
| `createForumTopic({ chatId, name })`                                                                             | `{ message_thread_id, name }`. Marks the supergroup as a forum.                                                                |
| `promoteChatMember({ chatId, userId?, botId?, demote? })`                                                        | Adds or removes an admin. Affects `getChatMember` and `getChatAdministrators`.                                                 |
| `addBotToChat({ chatId, botId, byUserId })`                                                                      | `{ update_id }`. Sends `my_chat_member` (left → member).                                                                       |
| `removeBotFromChat({ chatId, botId, byUserId })`                                                                 | `{ update_id }`. Sends `my_chat_member` (member → left).                                                                       |

User and channel actions:

| Method                                                                                                                         | Returns / notes                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `sendUserMessage({ chatId, userId, text, replyToMessageId? })`                                                                 | `{ message_id, update_id }`                                                                                  |
| `sendUserPhoto({ chatId, userId, photoBytes, mimeType?, caption? })`                                                           | `{ message_id, update_id, file_id }`. `file_id` is the largest size.                                         |
| `sendUserMedia({ chatId, userId, kind, bytes, mimeType?, caption?, duration?, width?, height?, fileName?, messageThreadId? })` | `{ message_id, update_id, file_id }`. `kind`: `video`, `audio`, `voice`, `animation`, `sticker`, `document`. |
| `editUserMessage({ chatId, messageId, userId, text })`                                                                         | `{ update_id }`. Only the author can edit.                                                                   |
| `clickInlineButton({ chatId, userId, messageId, callbackData })`                                                               | `{ callback_query_id, update_id }`                                                                           |
| `reactToMessage({ chatId, messageId, userId, reaction })`                                                                      | `{ update_id }`. `reaction` is a `ReactionType[]`; `[]` removes it.                                          |
| `postAsChannel({ chatId, text?, caption?, replyToMessageId?, messageThreadId? })`                                              | `{ message_id, update_id }`. The message has `sender_chat` and no `from`.                                    |
| `editChannelPost({ chatId, messageId, text?, caption? })`                                                                      | `{ message_id, update_id }`                                                                                  |

`update_id` is the id of the first Update enqueued.
It is `0` when no bot received the action, for example because of Privacy Mode.

Inspection and faults:

| Method                                                                         | Returns / notes                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `getSentMessages({ chatId })`                                                  | `TestMessage[]` sent by bots, ordered by `message_id`, deleted excluded.                      |
| `getAllMessages({ chatId })`                                                   | Same, for every sender.                                                                       |
| `getCallbackAnswer({ callbackQueryId })`                                       | `{ answered, answer_text?, answer_show_alert?, answer_url?, answer_cache_time? }`, or `null`. |
| `getDraftHistory({ chatId, draftId })`                                         | `sendMessageDraft` snapshots `{ seq, text, entities?, bot_id }[]`.                            |
| `injectFault({ botId, method, errorCode, description?, retryAfter?, count? })` | `{ fault_id }`. See [Fault injection](#fault-injection).                                      |
| `clearFaults()`                                                                | Removes all pending faults.                                                                   |
| `reset()`                                                                      | Clears all state. See [Reset and seeding](#reset-and-seeding).                                |

### HTTP control plane

For drivers in other languages.
All paths are under `/_emu/telegram`.
Bodies are JSON.
Path builders live in [`src/paths.ts`](https://github.com/serejke/telegram-emulator/blob/main/packages/telegram-emulator/src/paths.ts).

| Method   | Path                            | Body                                                                                                          |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/reset`                        | –                                                                                                             |
| `POST`   | `/bots`                         | `{ username, first_name?, name?, token?, can_join_groups?, can_read_all_group_messages?, commands? }`         |
| `GET`    | `/bots`                         | –                                                                                                             |
| `POST`   | `/users`                        | `{ first_name, last_name?, username?, language_code? }`                                                       |
| `POST`   | `/chats/private`                | `{ botId, userId }`                                                                                           |
| `POST`   | `/chats/group`                  | `{ title, type?, memberIds, botIds, creatorUserId?, adminUserIds?, adminBotIds?, isForum? }`                  |
| `POST`   | `/chats/supergroup`             | Same as `/chats/group`, without `type`.                                                                       |
| `POST`   | `/chats/channel`                | `{ title, username?, memberBotIds, memberUserIds? }`                                                          |
| `POST`   | `/chats/:id/promote`            | `{ userId?, botId?, demote? }`                                                                                |
| `POST`   | `/chats/:id/add-bot`            | `{ botId, byUserId }`                                                                                         |
| `POST`   | `/chats/:id/remove-bot`         | `{ botId, byUserId }`                                                                                         |
| `POST`   | `/chats/:id/topics`             | `{ name }`                                                                                                    |
| `POST`   | `/chats/:id/messages`           | `{ userId, text, replyToMessageId?, messageThreadId? }`                                                       |
| `GET`    | `/chats/:id/messages?scope=`    | `scope` is `all` (default) or `bot`.                                                                          |
| `POST`   | `/chats/:id/photos`             | `{ userId, photoBase64, mimeType?, caption? }`                                                                |
| `POST`   | `/chats/:id/media`              | `{ userId, kind, bytesBase64, mimeType?, caption?, duration?, width?, height?, fileName?, messageThreadId? }` |
| `POST`   | `/chats/:id/edits`              | `{ userId, messageId, text }`                                                                                 |
| `POST`   | `/chats/:id/callbacks`          | `{ userId, messageId, data }`                                                                                 |
| `POST`   | `/chats/:id/reactions`          | `{ userId, messageId, reaction }`                                                                             |
| `POST`   | `/chats/:id/channel-posts`      | `{ text?, caption?, entities?, reply_to_message_id?, message_thread_id? }`                                    |
| `POST`   | `/chats/:id/channel-post-edits` | `{ messageId, text?, caption? }`                                                                              |
| `GET`    | `/chats/:id/drafts/:draftId`    | –                                                                                                             |
| `GET`    | `/callbacks/:id`                | – (404 if unknown)                                                                                            |
| `POST`   | `/faults`                       | `{ bot_id, error_code, method?, description?, retry_after?, count? }`                                         |
| `DELETE` | `/faults`                       | –                                                                                                             |

The HTTP routes accept a few fields the TypeScript client does not expose: `creatorUserId`, `adminUserIds`, `adminBotIds`, and `isForum` on group and supergroup creation.

### Inspector

`GET /` renders an HTML page with two views.
The chats view shows each chat's messages.
The bots view (`/?view=bots`) shows each bot's config and its update queue with delivery mode, status, attempts, and the last delivery error.

## Bot API coverage

| Area      | Methods                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity  | `getMe`                                                                                                                                                |
| Delivery  | `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`                                                                                          |
| Messages  | `sendMessage`, `editMessageText`, `editMessageReplyMarkup`, `deleteMessage`, `sendChatAction`                                                          |
| Media     | `sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio`, `sendVoice`, `sendAnimation`, `sendSticker`, `getFile`, plus `GET /file/bot<token>/<file_path>` |
| Streaming | `sendMessageDraft` (private chats only; each call is stored as a snapshot, not a message)                                                              |
| Callbacks | `answerCallbackQuery` (stores `text`, `show_alert`, `url`, `cache_time`)                                                                               |
| Reactions | `setMessageReaction`                                                                                                                                   |
| Chats     | `getChat` (`ChatFullInfo`), `getChatMember`, `getChatAdministrators`, `getChatMemberCount`                                                             |
| Forum     | `createForumTopic`, `editForumTopic`, `closeForumTopic`, `reopenForumTopic`, `deleteForumTopic` (supergroup with `is_forum`)                           |
| Commands  | `setMyCommands`, `getMyCommands`                                                                                                                       |

Chat types: `private`, `group`, `supergroup` (with forum topics via `message_thread_id`), `channel`.

Update types: `message`, `edited_message`, `channel_post`, `edited_channel_post`, `callback_query`, `my_chat_member`, `message_reaction`, `message_reaction_count`.

Formatting: `parse_mode` `MarkdownV2`, `HTML`, and legacy `Markdown` on text and captions.
Supported entities: bold, italic, underline, strikethrough, spoiler, code, pre, text links, text mentions, blockquote, expandable blockquote.
Offsets are in UTF-16 code units.
If you pass `entities` explicitly, they replace the ones derived from `parse_mode`.

Media: uploads work as multipart or as a `file_id` re-send.
A re-send keeps the same `file_id`.
Photos get three sizes (up to 160px, up to 800px, original), read from PNG, JPEG, GIF, or WebP headers.
Any authorized bot token can download any stored file.

Reply markup: inline keyboards, reply keyboards, `force_reply`, and `remove_keyboard` are validated and stored on the message.
Inline buttons keep `text`, `callback_data`, and `url`; other button fields are dropped.

Errors use Telegram's wording:

| Condition                                             | Response                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Unknown token                                         | `401 Unauthorized`                                                                         |
| Bot is not a member of the chat                       | `403 Forbidden: bot is not a member of the chat`                                           |
| Text over 4096 UTF-16 units (after parsing)           | `400 Bad Request: message is too long`                                                     |
| Caption over 1024 units                               | `400 Bad Request: message caption is too long`                                             |
| Bad MarkdownV2 or HTML                                | `400 Bad Request: can't parse entities: ...` (for example an unescaped reserved character) |
| `message_thread_id` outside a supergroup              | `400 Bad Request: message thread not found`                                                |
| `reply_to_message_id` that does not exist             | `400 Bad Request: message to be replied not found`                                         |
| `editMessageText` on a message the bot did not send   | `403 Bad Request: message can't be edited by this bot`                                     |
| `deleteMessage` on another bot's message              | `403 Bad Request: message can't be deleted by this bot`                                    |
| Non-HTTPS webhook URL on a non-loopback host          | `400 Bad Request: bad webhook: HTTPS url must be provided for webhook`                     |
| `getUpdates` while a webhook is set                   | `409 Conflict: can't use getUpdates method while webhook is active`                        |
| A second long poll for the same bot                   | The earlier poll gets `409 Conflict: terminated by other getUpdates request; ...`          |
| Forum method on a chat that is not a forum supergroup | `400 Bad Request: CHAT_NOT_FORUM`                                                          |

Plain-HTTP webhooks are allowed on `localhost`, `127.0.0.1`, and `::1`, so a test can run a receiver on a random port without TLS.

### Fault injection

A fault makes the next N calls of one method fail with a chosen error, before the real handler runs.

```text
injectFault(bot, method = "sendMessage" | "*", error_code, count = 1, retry_after?)

on each Bot API call by that bot:
  pick a matching fault; a specific method wins over "*"
  respond { ok: false, error_code, description, parameters: { retry_after } }
  decrement count; delete the fault at 0
```

HTTP status equals `error_code` for 401, 403, 404, and 429; any other code is sent with HTTP 400.
The default description depends on the code, for example `Too Many Requests: retry after 2`.
Faults also apply to `getUpdates`, so a `"*"` fault can stall a polling bot.

## Known differences from Telegram

- **Private chats are shared.** A private chat's id is the user id, and there is one such chat per user. If two bots each have a private chat with the same user, they share one chat record and both receive the user's messages.
- **Opt-in update types are on by default.** Telegram skips `message_reaction` and `message_reaction_count` unless `allowed_updates` lists them. The emulator delivers every type when `allowed_updates` is not set. It also does not require admin rights for reaction updates.
- **`drop_pending_updates` is ignored.** `setWebhook` and `deleteWebhook` accept it but keep the queue.
- **`getWebhookInfo`** always reports `pending_update_count: 0` and has no error fields.
- **Permissions are not modeled.** Sending requires chat membership, nothing more. Deleting a user's message is always allowed. Admin rights only change what `getChatMember` and `getChatAdministrators` return.
- **Bot edits reach other bots.** `editMessageText` enqueues `edited_message` for the other bots in the chat; `sendMessage` does not enqueue anything.
- **Media in groups** reaches only bots with Privacy Mode off. A caption that mentions the bot does not count.
- **Webhook deliveries are concurrent.** Each Update is posted on its own, so retries can reorder them.

## Limits

- **Request budget.** `@emulators/core` applies a rate limiter of 5000 requests per hour per server. After that, every request returns `403 {"message":"API rate limit exceeded"}`. Restart the server to reset it. Registering `telegramPlugin` on your own Hono app skips the limiter.
- **Retention.** Per bot, the queue keeps at most 1000 pending and 200 delivered Updates. Files (2000), callback queries (500), draft snapshots (2000), and faults (500) drop the oldest entries past their cap.
- **Memory only.** Nothing is persisted. `close()` discards everything.

## Not implemented

Out of scope for a test emulator: payments, games, the Business API, Telegram Passport, TON, and BotFather account management.

Not built yet:

- Inline mode (`inline_query`, `answerInlineQuery`).
- `forwardMessage`, `copyMessage`, `sendMediaGroup`, `pinChatMessage`, polls, stories, web apps.
- `chat_member` and `chat_join_request` Updates for human members.
- Deep-link `/start <payload>` handoff (you can send the text `/start payload` yourself).

## Relationship to vercel-labs/emulate

The emulator is a service plugin for [vercel-labs/emulate](https://github.com/vercel-labs/emulate).
It was proposed upstream in [vercel-labs/emulate#75](https://github.com/vercel-labs/emulate/pull/75) and now ships from this repository.
It uses core's internal plugin API (`ServicePlugin`, `Store`), not the public `defineEmulator`, so it pins `@emulators/core` to exactly `0.9.0`.

## License

Apache-2.0.
