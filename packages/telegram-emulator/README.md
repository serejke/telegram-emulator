# @serejke/telegram-emulator

Stateful emulator of the Telegram Bot API. Point any Telegram bot at it instead of `https://api.telegram.org` and test it end to end: no real bot, no Telegram client, no network.

Runs on the HTTP core of [vercel-labs/emulate](https://github.com/vercel-labs/emulate) (`@emulators/core`). For grammY bots, [`grammy-emulate`](https://github.com/serejke/telegram-emulator/tree/main/packages/grammy-emulate) wraps it in a fluent test API.

## Install

```bash
npm install --save-dev @serejke/telegram-emulator
```

## Quick start

```bash
npx @serejke/telegram-emulator --port 4014
```

Boots on `http://localhost:4014` with a default seeded bot (`@emulate_bot`, token `100001:EMULATE_DEFAULT_TOKEN`), a test user, and a private chat. Open the URL in a browser for the inspector.

## Test client

For Vitest / Jest / Playwright:

```typescript
import { startTelegramEmulator } from "@serejke/telegram-emulator";
import { createTelegramTestClient } from "@serejke/telegram-emulator/test";

const emu = await startTelegramEmulator({ port: 4014 });
const tg = createTelegramTestClient(emu.url);

const bot = await tg.createBot({ username: "trip_test_bot", first_name: "Trip Test" });
const user = await tg.createUser({ first_name: "Alice" });
const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });

// Simulate a user sending a message; bot code running elsewhere picks it up.
await tg.sendUserMessage({ chatId: dm.id, userId: user.id, text: "/connect ABC123" });

// Inspect what the bot replied.
const replies = await tg.getSentMessages({ chatId: dm.id });
```

Point your bot code at `emu.url` instead of `https://api.telegram.org`:

```typescript
// grammY
new Bot(bot.token, { client: { apiRoot: emu.url } });

// telegraf
new Telegraf(bot.token, { telegram: { apiRoot: emu.url } });
```

## What is implemented

Full chat-SDK parity surface:

| Area       | Bot API methods                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity   | `getMe`                                                                                                                                                                                           |
| Delivery   | `getUpdates` (with `allowed_updates` filter), `setWebhook` (HTTPS for public URLs, plain HTTP for loopback hosts; with `secret_token` + `allowed_updates`), `deleteWebhook`, `getWebhookInfo`     |
| Messaging  | `sendMessage`, `sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio`, `sendVoice`, `sendAnimation`, `sendSticker`, `editMessageText`, `editMessageReplyMarkup`, `deleteMessage`, `sendChatAction` |
| Formatting | `parse_mode = MarkdownV2` / `HTML` / `Markdown` (legacy v1) on text + caption surfaces, including `blockquote` / `expandable_blockquote`                                                          |
| Streaming  | `sendMessageDraft` — emulator-only extension for testing animated streamed replies (no real Bot API method; appends snapshots under `(chat_id, draft_id, bot_id)`)                                |
| Files      | `getFile`, `GET /file/bot<token>/<file_path>`. `file_id` preserved on re-send.                                                                                                                    |
| Reactions  | `setMessageReaction` + dispatch of both `message_reaction` (per-user) and `message_reaction_count` (anonymous aggregate) Updates                                                                  |
| Callbacks  | `answerCallbackQuery` (persists `text` / `show_alert` / `url` / `cache_time`)                                                                                                                     |
| Chats      | `getChat` (returns `ChatFullInfo` with `permissions` / `accent_color_id` / `pinned_message`), `getChatMember`, `getChatAdministrators`, `getChatMemberCount`                                      |
| Forum      | `createForumTopic`, `editForumTopic`, `closeForumTopic`, `reopenForumTopic`, `deleteForumTopic` (requires a supergroup with `is_forum: true`)                                                     |
| Commands   | `setMyCommands`, `getMyCommands`                                                                                                                                                                  |

Chat types: `private`, `group`, `supergroup` (with forum topics via `message_thread_id`), `channel` (with `channel_post` / `edited_channel_post` + `sender_chat`-only messages).

Update types dispatched: `message`, `edited_message`, `callback_query`, `my_chat_member`, `message_reaction`, `message_reaction_count`, `channel_post`, `edited_channel_post`.

Validation (matches real Telegram — rejects, does not trim):

- Text: > 4096 chars → `400 Bad Request: message is too long`
- Caption: > 1024 chars → `400 Bad Request: message caption is too long`
- MarkdownV2 unescaped reserved char → `400 can't parse entities: character 'X' is reserved and must be escaped with the preceding '\'`
- `message_thread_id` in non-supergroup → `400 Bad Request: message thread not found`
- `setWebhook` with non-HTTPS URL pointing at a non-loopback host → `400 Bad Request: bad webhook: HTTPS url must be provided for webhook`. Loopback hosts (`localhost`, `127.0.0.1`, `::1`) are allowed to use plain HTTP so hermetic test setups can run a receiver on a random free port without terminating TLS.
- `sendMessage` with `reply_to_message_id` pointing at a missing message → `400 Bad Request: message to be replied not found`
- Concurrent `getUpdates` for the same bot → `409 Conflict: terminated by other getUpdates request` (real-Telegram wording)

Auto-detected entities in free text: `bot_command`, `mention`, `url`, `email`, `hashtag`, `cashtag`.

Fault injection for adapter error-path testing: `POST /_emu/telegram/faults` with `{bot_id, method, error_code, description?, retry_after?, count?}` produces controlled `401` / `403` / `404` / `429` / generic `400` responses on the next N calls.

Supported flows:

- **DM text messages** with parsed entities (`bot_command`, `mention`)
- **Group chats** with Telegram's privacy rules (non-privileged bots only see messages that `@bot_username`-mention them or are addressed via `/command@bot_username`; bare `/command` is dropped in privacy mode)
- **Photos** with three `PhotoSize` tiers, stable `file_id` round-trip, `getFile` → HTTP file download, `sendPhoto` re-send by `file_id`
- **Documents** — `sendDocument` with multipart upload or `file_id` re-send
- **Callback queries** + **inline keyboards** (`reply_markup.inline_keyboard`)
- **Bot-initiated edits** via `editMessageText` / `editMessageReplyMarkup` (sets `edit_date`; bot edits dispatch `edited_message` to other bots in the chat)
- **Message deletions** via `deleteMessage` (soft-delete, hidden from `getAllMessages` and future `getUpdates`)
- **Streaming drafts** via the emulator-only `sendMessageDraft` — private chats only; each call appends a snapshot under `(chat_id, draft_id, bot_id)` so tests can inspect chunk-by-chunk output
- **Chat membership changes** via `addBotToChat` / `removeBotFromChat` test helpers, dispatching `my_chat_member` Updates
- **Webhook delivery** with retry on 5xx (initial + up to 3 retries with 1s/2s/4s backoff, terminal on 4xx), `X-Telegram-Bot-Api-Secret-Token` header
- **Long polling** with `offset` confirmation semantics and 409 on concurrent polls

## Test API

Programmatic client returned by `createTelegramTestClient(baseUrl, options?)`:

| Method                                                                                       | Description                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `createBot({ username, ... })`                                                               | Create a new bot. Returns `{ bot_id, token, username, ... }`.                       |
| `createUser({ first_name, ... })`                                                            | Create a new user.                                                                  |
| `createPrivateChat({ botId, userId })`                                                       | Create (or fetch) a DM between bot and user.                                        |
| `createGroupChat({ title, memberIds, botIds, creatorUserId?, adminUserIds?, adminBotIds? })` | Create a group chat; optional creator + admin flags feed `getChatAdministrators`.   |
| `createSupergroup({ title, memberIds, botIds, isForum? })`                                   | Create a supergroup (set `isForum: true` to enable forum-topic methods).            |
| `createChannel({ title, username?, memberBotIds, memberUserIds? })`                          | Create a channel.                                                                   |
| `createForumTopic({ chatId, name })`                                                         | Create a forum topic in a supergroup.                                               |
| `promoteChatMember({ chatId, userId? / botId?, demote? })`                                   | Promote (or demote) a member to administrator.                                      |
| `sendUserMessage({ chatId, userId, text, replyToMessageId? })`                               | Simulate a user sending a text message.                                             |
| `sendUserPhoto({ chatId, userId, photoBytes, mimeType?, caption? })`                         | Simulate a user sending a photo.                                                    |
| `sendUserMedia({ chatId, userId, kind, bytes, ... })`                                        | Simulate a user sending video / audio / voice / animation / sticker / document.     |
| `clickInlineButton({ chatId, userId, messageId, callbackData })`                             | Simulate a user clicking an inline keyboard button.                                 |
| `editUserMessage({ chatId, messageId, userId, text })`                                       | Simulate a user editing their message.                                              |
| `reactToMessage({ chatId, messageId, userId, reaction })`                                    | Simulate a user reacting; dispatches `message_reaction` + `message_reaction_count`. |
| `postAsChannel({ chatId, text?, caption?, replyToMessageId?, messageThreadId? })`            | Post a `channel_post` as the channel itself.                                        |
| `editChannelPost({ chatId, messageId, text?, caption? })`                                    | Edit an existing channel post; dispatches `edited_channel_post`.                    |
| `addBotToChat({ chatId, botId, byUserId })`                                                  | Add a bot to a group chat; dispatches a `my_chat_member` Update.                    |
| `removeBotFromChat({ chatId, botId, byUserId })`                                             | Remove a bot from a chat; dispatches a `my_chat_member` Update.                     |
| `injectFault({ botId, method, errorCode, description?, retryAfter?, count? })`               | Queue a controlled 4xx / 429 on the next N calls to `method` (or `*`).              |
| `clearFaults()`                                                                              | Clear every pending fault.                                                          |
| `getCallbackAnswer({ callbackQueryId })`                                                     | Inspect what the bot answered on a callback query.                                  |
| `getDraftHistory({ chatId, draftId })`                                                       | Ordered list of `sendMessageDraft` snapshots for a streamed reply.                  |
| `getSentMessages({ chatId })`                                                                | Messages sent by any bot in the chat (for assertions).                              |
| `getAllMessages({ chatId })`                                                                 | All messages (user + bot) in the chat.                                              |
| `reset()`                                                                                    | Full store wipe + seed replay (same as `emulator.reset()`).                         |

`options.fetchImpl` lets you swap the HTTP client — useful when driving a Hono app in-process without booting a real server.

All programmatic methods have matching HTTP routes under `/_emu/telegram/*` for cross-language drivers. See `src/paths.ts` for the full URL map.

## Seed configuration

```typescript
await startTelegramEmulator({
  seed: {
    bots: [
      {
        username: "trip_bot",
        first_name: "Trip Bot",
        token: "100001:SEEDED_TOKEN_TRIP_BOT",
        can_join_groups: true,
        commands: [{ command: "connect", description: "Connect this chat to a trip" }],
      },
    ],
    users: [{ first_name: "Alice", username: "alice_tester" }],
    chats: [
      { type: "private", between: ["trip_bot", "alice_tester"] },
      { type: "group", title: "Morocco Planning", members: ["alice_tester"], bots: ["trip_bot"] },
    ],
  },
});
```

`chats[].type` currently supports `private` and `group`. Supergroups, channels, and forum topics are created at runtime via the control plane (`createSupergroup` / `createChannel` / `createForumTopic`).

## Telegram privacy rules (groups)

Matches real Telegram:

- Bots with privacy mode on (the default) only receive messages that **mention** them (`@bot_username`) or are **addressed bot commands** (`/command@bot_username`).
- Bare `/command` with no `@bot_username` is **dropped** in privacy mode.
- Plain chatter between humans is **not** delivered.
- To receive every message, set `can_read_all_group_messages: true` when creating the bot (equivalent to disabling Privacy Mode in real Telegram).

## Non-goals

This emulator deliberately does **not** implement:

- Payments (`invoice`, `successful_payment`, `pre_checkout_query`)
- Games (`sendGame`, `setGameScore`)
- Telegram Business API (`business_connection`, connected accounts)
- Telegram Passport (encrypted identity documents)
- TON wallet integrations
- Real BotFather account management

These are out of scope for a test-focused emulator.

## Not implemented yet

Lands when a concrete flow demands it:

- **Keyboards** — custom `reply_markup.keyboard`, `force_reply`, `selective` flag (inline keyboards are handled).
- **Deep links** — `t.me/<bot>?start=<payload>` handoff simulation.
- **Message operations** — `forwardMessage`, `copyMessage`, `sendMediaGroup` (albums), `pinChatMessage`, non-bot `chat_member` / `chat_join_request` Updates.
- **Inline mode** — `inline_query` + `answerInlineQuery`.
- **Business API, payments, polls, stories, web apps.**

## Links

- [Telegram Bot API reference](https://core.telegram.org/bots/api)
- [vercel-labs/emulate](https://github.com/vercel-labs/emulate) — the emulator framework this package runs on
- [grammY](https://grammy.dev) · [Telegraf](https://telegraf.js.org) — SDKs this emulator is wire-compatible with

## License

Apache-2.0.
