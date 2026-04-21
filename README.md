# @emulators/telegram

Telegram Bot API emulator for `emulate`. Stateful, production-fidelity emulation of the Bot API so you can end-to-end test Telegram bots without creating a real bot, without clicking through Telegram clients, and without network.

## Quick start

```bash
npx emulate --service telegram
```

Boots on `http://localhost:4007` with a default seeded bot (`@emulate_bot`), a test user, and a private chat.

## Test client

For Vitest / Jest / Playwright:

```typescript
import { createEmulator } from "emulate";
import { createTelegramTestClient } from "@emulators/telegram/test";

const emu = await createEmulator({ service: "telegram", port: 4007 });
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
| Delivery   | `getUpdates` (with `allowed_updates` filter), `setWebhook` (with `secret_token` + `allowed_updates`), `deleteWebhook`, `getWebhookInfo`                                                           |
| Messaging  | `sendMessage`, `sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio`, `sendVoice`, `sendAnimation`, `sendSticker`, `editMessageText`, `editMessageReplyMarkup`, `deleteMessage`, `sendChatAction` |
| Formatting | `parse_mode = MarkdownV2` / `HTML` on text + caption surfaces                                                                                                                                     |
| Streaming  | `sendMessageDraft` (Bot API 9.3+, private chats)                                                                                                                                                  |
| Files      | `getFile`, `GET /file/bot<token>/<file_path>`. `file_id` preserved on re-send.                                                                                                                    |
| Reactions  | `setMessageReaction`                                                                                                                                                                              |
| Callbacks  | `answerCallbackQuery` (persists `text` / `show_alert` / `url` / `cache_time`)                                                                                                                     |
| Chats      | `getChat`, `getChatMember`, `getChatMemberCount`                                                                                                                                                  |
| Commands   | `setMyCommands`, `getMyCommands`                                                                                                                                                                  |

Chat types: `private`, `group`, `supergroup` (with forum topics via `message_thread_id`), `channel` (with `channel_post` / `edited_channel_post` + `sender_chat`-only messages).

Update types dispatched: `message`, `edited_message`, `callback_query`, `my_chat_member`, `message_reaction`, `channel_post`, `edited_channel_post`.

Validation (matches real Telegram — rejects, does not trim):

- Text: > 4096 chars → `400 Bad Request: message is too long`
- Caption: > 1024 chars → `400 Bad Request: message caption is too long`
- MarkdownV2 unescaped reserved char → `400 can't parse entities: character 'X' is reserved and must be escaped with the preceding '\'`
- `message_thread_id` in non-supergroup → `400 Bad Request: message thread not found`

Auto-detected entities in free text: `bot_command`, `mention`, `url`, `email`, `hashtag`, `cashtag`.

Fault injection for adapter error-path testing: `POST /_emu/telegram/faults` with `{bot_id, method, error_code, description?, retry_after?, count?}` produces controlled `401` / `403` / `404` / `429` / generic `400` responses on the next N calls.

Supported flows:

- **DM text messages** with parsed entities (`bot_command`, `mention`)
- **Group chats** with Telegram's privacy rules (non-privileged bots only see messages that mention them or are addressed via `/command` or `/command@bot_username`)
- **Photos** with three `PhotoSize` tiers, stable `file_id` round-trip, `getFile` → HTTP file download, `sendPhoto` re-send by `file_id`
- **Documents** — `sendDocument` with multipart upload or `file_id` re-send
- **Callback queries** + **inline keyboards** (`reply_markup.inline_keyboard`)
- **Bot-initiated edits** via `editMessageText` / `editMessageReplyMarkup` (sets `edit_date`, no Update fired — matches real Telegram)
- **Message deletions** via `deleteMessage` (soft-delete, hidden from `getAllMessages` and future `getUpdates`)
- **Streaming drafts** via `sendMessageDraft` — private chats only; each call appends a snapshot under `(chat_id, draft_id, bot_id)` so tests can inspect chunk-by-chunk output
- **Chat membership changes** via `addBotToChat` / `removeBotFromChat` test helpers, dispatching `my_chat_member` Updates
- **Webhook delivery** with retry on 5xx (up to 3 attempts, 1s/2s/4s backoff, terminal on 4xx), `X-Telegram-Bot-Api-Secret-Token` header
- **Long polling** with `offset` confirmation semantics

## Test API

Programmatic client returned by `createTelegramTestClient(baseUrl)`:

| Method                                                               | Description                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `createBot({ username, ... })`                                       | Create a new bot. Returns `{ bot_id, token, username, ... }`.      |
| `createUser({ first_name, ... })`                                    | Create a new user.                                                 |
| `createPrivateChat({ botId, userId })`                               | Create (or fetch) a DM between bot and user.                       |
| `createGroupChat({ title, memberIds, botIds })`                      | Create a group chat with members and bots.                         |
| `sendUserMessage({ chatId, userId, text, replyToMessageId? })`       | Simulate a user sending a text message.                            |
| `sendUserPhoto({ chatId, userId, photoBytes, mimeType?, caption? })` | Simulate a user sending a photo.                                   |
| `clickInlineButton({ chatId, userId, messageId, callbackData })`     | Simulate a user clicking an inline keyboard button.                |
| `editUserMessage({ chatId, messageId, userId, text })`               | Simulate a user editing their message.                             |
| `addBotToChat({ chatId, botId, byUserId })`                          | Add a bot to a group chat; dispatches a `my_chat_member` Update.   |
| `removeBotFromChat({ chatId, botId, byUserId })`                     | Remove a bot from a chat; dispatches a `my_chat_member` Update.    |
| `getDraftHistory({ chatId, draftId })`                               | Ordered list of `sendMessageDraft` snapshots for a streamed reply. |
| `getSentMessages({ chatId })`                                        | Messages sent by any bot in the chat (for assertions).             |
| `getAllMessages({ chatId })`                                         | All messages (user + bot) in the chat.                             |
| `reset()`                                                            | Full store wipe + seed replay (same as `emulator.reset()`).        |

All programmatic methods have matching HTTP routes under `/_emu/telegram/*` for cross-language drivers. See `src/routes/control.ts`.

## Seed configuration

```yaml
telegram:
  bots:
    - username: trip_bot
      first_name: Trip Bot
      token: "100001:SEEDED_TOKEN_TRIP_BOT"
      can_join_groups: true
      commands:
        - command: connect
          description: Connect this chat to a trip
  users:
    - first_name: Alice
      username: alice_tester
  chats:
    - type: private
      between: [trip_bot, alice_tester]
    - type: group
      title: Morocco Planning
      members: [alice_tester]
      bots: [trip_bot]
```

## Telegram privacy rules (groups)

Matches real Telegram:

- Bots in groups only receive messages that **mention** them (`@bot_username`) or are **addressed bot commands** (`/command` or `/command@bot_username`).
- Plain chatter between humans is **not** delivered.
- To receive every message, set `can_read_all_group_messages: true` when creating the bot (equivalent to disabling Privacy Mode in real Telegram).

## Ports

The CLI assigns the Telegram service to port `4007` by default (next after AWS at `4006`).

## Non-goals

This emulator deliberately does **not** implement:

- Payments (`invoice`, `successful_payment`, `pre_checkout_query`)
- Games (`sendGame`, `setGameScore`)
- Telegram Business API (`business_connection`, connected accounts)
- Telegram Passport (encrypted identity documents)
- TON wallet integrations
- Real BotFather account management

These are out of scope for the plugin's test-focused use case.

## Not implemented yet

Lands when a concrete flow demands it:

- **Keyboards** — custom `reply_markup.keyboard`, `force_reply`,
  `selective` flag.
- **Deep links** — `t.me/<bot>?start=<payload>` handoff simulation.
- **Message operations** — `forwardMessage`, `copyMessage`,
  `sendMediaGroup` (albums), `pinChatMessage`, non-bot `chat_member`
  - `chat_join_request` Updates.
- **Inline mode** — `inline_query` + `answerInlineQuery`.
- **Business API, payments, polls, stories, web apps.**
