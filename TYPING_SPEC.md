# Telegram Emulator — Comprehensive Typing Spec

> **Purpose.** Replace every `Record<string, unknown>`, `as unknown as X`, and per-field `typeof` validator in `packages/@emulators/telegram/` with a proper, hand-authored type system backed by runtime validators. This spec is the single source of truth for the refactor; it is self-contained and intended to be executed end-to-end in a separate worker session.

> **Non-negotiables (owner's words).** Self-contained — **do not** import types from grammY, telegraf, or telegram-bot-api. Dedicated subdirectory under `src/types/`. API types vs store types vs internals must live in separate files. Internals get typed too (the owner is "a type fan"). The mass of `Record<string, unknown>` is what we're here to delete.

---

## Table of Contents

0. [Session Context — What's Already Done](#0-session-context)
1. [Inventory](#1-inventory)
2. [Directory Layout](#2-directory-layout)
3. [Validator Strategy — zod](#3-validator-strategy--zod)
4. [Migration Plan — 7 Phases](#4-migration-plan)
5. [Types That Are Genuinely Hard](#5-types-that-are-genuinely-hard)
6. [What to Leave Loose](#6-what-to-leave-loose)
7. [Estimated Scope + Risk](#7-estimated-scope--risk)
8. [Execution Rules for the Worker](#8-execution-rules-for-the-worker)

---

## 0. Session Context

Work completed in the preceding session (already on `feat/telegram-emulator`, all commits pushed):

**Correctness fixes**

- Module-level counters → per-store (botId, userId, fileSequence, updateSequence, chat-id allocators). `store.reset()` now resets them for free.
- Privacy-mode filter: bare `/command` without `@bot_username` is dropped (matches real Telegram).
- Concurrent `getUpdates` returns `409 Conflict: terminated by other getUpdates request`. A new **long-poll** cancels the prior one; short polls (`timeout=0`) pass through without cancelling so `bot.stop()` in grammY/telegraf works.
- `getChat` returns `ChatFullInfo` (adds `accent_color_id`, `max_reaction_count`, `permissions`, `pinned_message`, `bio`, `description`, `invite_link`, etc.).
- Chat-member status modelled: `creator_user_id`, `admin_user_ids`, `admin_bot_ids` on `TelegramChat`. `getChatMember` returns real status; `getChatAdministrators` added; control-plane `promoteChatMember` endpoint + test-client method added.
- Forum-topic Bot API methods added: `createForumTopic` / `editForumTopic` / `closeForumTopic` / `reopenForumTopic` / `deleteForumTopic`. Require `supergroup` + `is_forum: true`.
- `setWebhook` / `deleteWebhook` / `setMyCommands` return bare `true` (were wrapping in `{webhook_set:true}` etc.).
- MarkdownV2 + HTML blockquote + expandable blockquote parsing.
- `message_reaction_count` dispatched alongside `message_reaction` (anonymous aggregate).
- Bot-driven `editMessageText` dispatches `edited_message` to other bots in the chat (`edited_channel_post` for channels).
- Validation: `setWebhook` requires HTTPS; `sendMessage` rejects `reply_to_message_id` pointing at a missing message; `sendSticker` silently strips captions (was 400); legacy `parse_mode=Markdown` accepted.
- `mergeEntities` discards parse_mode output when caller supplies `entities` explicitly (real Bot API precedence).

**Abstraction / structure**

- `src/paths.ts` — shared control-plane URL builders used by both `control.ts` and `test.ts`.
- `src/services/media.ts` — shared `buildMediaField` + `allocateMessageId` + `buildPhotoSizes` + `readImageDimensions` + `defaultMimeForMediaKind`.
- `src/services/sweeper.ts` — caps `files` / `callbackQueries` / `draftSnapshots` / `faults` on dispatcher activity.
- `helpers.ts` split into `ids.ts` / `http.ts` / `serializers.ts` / `entity-parser.ts` + `services/media.ts`. `helpers.ts` is now a thin re-export barrel for backward compat.
- `routes/bot-api.ts` split: `bot-api-forum.ts` (5 forum methods), `bot-api-chats.ts` (getChat/member/admins/count + sendChatAction), `bot-api-delivery.ts` (getMe/getUpdates/setWebhook/deleteWebhook/getWebhookInfo). Main `bot-api.ts` dropped from 1401 → 1081 LOC.
- `routes/control.ts` partial split: `control-diagnostics.ts` (faults + callback-answer inspection).
- `__tests__/phase2.test.ts` renamed to `bot-api-extended.test.ts` (roadmap vocabulary removed).
- `@hono/node-server` devDep dropped — `createTelegramTestClient` now accepts a `fetchImpl` override; tests drive Hono via in-process `app.request`.
- All inline `import("@emulators/core").Store` type refs (25+) hoisted to proper top-of-file imports.

**Docs**

- README Test API table rewritten to include every method.
- `Bot API 9.3+` claim on `sendMessageDraft` removed (labelled as emulator-only extension).
- CHANGELOG entry added under `## Unreleased`.
- Root README Telegram section synced.
- `test.ts` header docblock uses `user.id` (matches runtime).
- Install + Links sections added to match sibling emulators.

**Baseline for this spec's execution:**

- 112 telegram tests pass, TypeScript clean, 9/9 grammY parity tests pass.
- Source: ~5,466 LOC across 23 `.ts` files. Tests: 2,104 LOC across 7 files.
- Telegram branch commits ahead of `main` (starting from the original feature commit `6276e1a`, proceeding through ~22 commits of fixes + refactor).

---

## 1. Inventory

### 1.1 Current-pattern counts (source only, not tests)

| Pattern                                          | Count                  | Notes                                                                                                                                             |
| ------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Record<string, unknown>`                        | **42** across 10 files | Handler `body` params (17), serializer return types (5), media/forum intermediate builders (8), control-plane DTOs (4), payload/entity fields (8) |
| `as unknown as X` (double cast)                  | **7**                  | 6 in `control.ts` (body → Create\*Input), 1 in `bot-api.ts:654` (InlineKeyboardMarkup)                                                            |
| `body.X as Y` (single cast)                      | **81**                 | `bot-api.ts` 41, `bot-api-delivery.ts` 7, `bot-api-forum.ts` 6, `bot-api-chats.ts` 1, `control.ts` 26                                             |
| `typeof body.X === …` guards                     | **42**                 | `bot-api.ts` 28, `bot-api-forum.ts` 8, `bot-api-delivery.ts` 5, `bot-api-chats.ts` 1                                                              |
| `serialize*` returning `Record<string, unknown>` | **5 functions**        | `serializers.ts:16,28,37,67,95`                                                                                                                   |
| `: any` / `as any`                               | **0**                  | Already clean                                                                                                                                     |
| Test-side `as { … }` after `.json()`             | **~11**                | `integration.test.ts:378,585`; `parse-mode.test.ts:62,122`; `bot-api.test.ts:62,63,101`; `test-client.test.ts:40,47,86`; `webhook.test.ts:45`     |
| `json<{ result: Record<string, unknown> }>()`    | 3                      | `bot-api.test.ts:24,57,96`                                                                                                                        |

### 1.2 Per-file hotspots

| File                         | LOC  | Worst patterns                                                                                              | Current → proposed                                                                                                                                                                    |
| ---------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/bot-api.ts`          | 1082 | 28 `typeof body.X`, 41 `body.X as`, 28 `Record<string, unknown>` params                                     | `body: Record<string, unknown>` → `body: unknown` → `parseBody(c, zSendMessage)` returns typed discriminated input; per-field `typeof` ladders collapse into one validator per method |
| `routes/control.ts`          | 1095 | 26 `body.X as …`, 6 `as unknown as X`                                                                       | Shared `parseJsonBody(c, Schema)` helper; simulate\* input interfaces already exist — keep, just attach their validators                                                              |
| `serializers.ts`             | 148  | 5 returns of `Record<string, unknown>`                                                                      | Each returns typed `WireUser`, `WireChat`, `WireChatFullInfo`, `WireMessage`, `WireBotAsUser`                                                                                         |
| `routes/bot-api-forum.ts`    | 101  | 8 `typeof body.X`, 6 `body.X as`                                                                            | One typed parse per endpoint                                                                                                                                                          |
| `routes/bot-api-chats.ts`    | 136  | `adminMemberExtras` returns `Record<string, unknown>` with undefined-holes                                  | Return discriminated `WireChatMember` (creator \| administrator \| member \| restricted \| left \| kicked)                                                                            |
| `routes/bot-api-delivery.ts` | 100  | 5 `typeof body.X`, 7 `body.X as`                                                                            | Typed `GetUpdatesBody`, `SetWebhookBody` parsers                                                                                                                                      |
| `http.ts`                    | 73   | `parseTelegramBody` returns `Record<string, unknown>`                                                       | Return `Promise<unknown>`; all narrowing via validators downstream                                                                                                                    |
| `dispatcher.ts`              | 294  | `enqueue(botId, type, payload: Record<string, unknown>)`; `TelegramUpdate.payload: Record<string, unknown>` | Generic `enqueue<T extends UpdateType>(botId, type: T, payload: PayloadFor<T>)`; payload persisted as `WireUpdate` discriminated union                                                |
| `entities.ts`                | 323  | `ChatMemberLike.user` and `TelegramUpdate.payload` both `Record<string, unknown>`                           | `ChatMemberLike.user: WireUser`; `payload: WireUpdate`                                                                                                                                |
| `services/media.ts`          | 207  | `buildMediaField` returns `Record<string, unknown>`                                                         | Discriminated `WireMediaField` keyed on `kind`                                                                                                                                        |
| `routes/inspector.ts`        | 300  | 1 `as Record<string, unknown>` cast on `reply_markup`                                                       | `msg.reply_markup` is already typed — use `"inline_keyboard" in rm` guard                                                                                                             |
| `test.ts`                    | 464  | 22 `r.X as Y` casts on `postJson` return                                                                    | Generic `postJson<TResponse>(path, body)` per-endpoint envelope                                                                                                                       |
| `__tests__/*`                | 2104 | 11 `as { … }` casts                                                                                         | `json<T>()` typed with `WireMessage` / `WireUpdate` / etc.                                                                                                                            |

---

## 2. Directory Layout

```
src/types/
  index.ts                  # Barrel: re-exports public surface

  wire/                     # What the emulator emits over HTTP (Bot API wire format)
    primitives.ts           # ChatId, FileId, MessageId branded types
    user.ts                 # WireUser (= output of serializeUser / serializeBotAsUser)
    chat.ts                 # WireChat, WireChatFullInfo, WireChatPhoto, WireChatPermissions
    message.ts              # WireMessage (top-level out of serializeMessage)
    message-entity.ts       # WireMessageEntity (= current MessageEntity, promoted)
    media.ts                # WirePhotoSize, WireDocument, WireAudio, WireVoice,
                            # WireVideo, WireAnimation, WireSticker, WireMediaField union
    reply-markup.ts         # WireInlineKeyboardMarkup, WireReplyKeyboardMarkup,
                            # WireForceReply, WireReplyKeyboardRemove, WireReplyMarkup
    chat-member.ts          # WireChatMember discriminated union on status
    callback-query.ts       # WireCallbackQuery
    reaction.ts             # WireReactionType, WireMessageReactionUpdated,
                            # WireMessageReactionCountUpdated
    update.ts               # WireUpdate discriminated on UpdateType, PayloadFor<T>
    webhook-info.ts         # WireWebhookInfo
    file.ts                 # WireFile (response of getFile), WireBotCommand
    forum.ts                # WireForumTopic + create/edit response shapes
    response.ts             # OkResponse<T>, ErrResponse, TgResponse<T> envelopes

  request/                  # Inbound Bot API request bodies (derived via z.infer)
    common.ts               # ChatIdInput (number | `@${string}` | digit-string)
    send-message.ts         # SendMessageBody
    send-photo.ts           # SendPhotoBody
    send-media.ts           # SendMediaBody<Kind> discriminated per method
    send-document.ts        # SendDocumentBody
    edit-message.ts         # EditMessageTextBody, EditMessageReplyMarkupBody, DeleteMessageBody
    callback-query.ts       # AnswerCallbackQueryBody
    chats.ts                # GetChatBody, GetChatMemberBody, GetChatAdministratorsBody,
                            # GetChatMemberCountBody
    forum.ts                # Create/Edit/Close/Delete ForumTopicBody
    delivery.ts             # GetUpdatesBody, SetWebhookBody
    reaction.ts             # SetMessageReactionBody
    commands.ts             # SetMyCommandsBody
    draft.ts                # SendMessageDraftBody
    multipart.ts            # MultipartFileRef = { __file: true; name; type; bytes }

  store/                    # Persisted row shapes (current entities.ts split here)
    bot.ts
    user.ts
    chat.ts                 # ChatPermissions stays here too
    message.ts
    file.ts
    callback-query.ts
    update.ts               # TelegramUpdate, UpdateType, payload: WireUpdate
    reaction.ts
    fault.ts
    forum-topic.ts
    draft.ts
    index.ts                # Barrel

  internal/                 # Types read only by dispatcher/services/handlers
    dispatcher.ts           # RetryPolicy, LongPollWaiter, GetUpdatesResult
    media-input.ts          # MediaFieldInput (= current services/media.ts), PhotoTier
    handler-context.ts      # Shape of { c, bot, body, store } passed to route handlers
    simulate.ts             # Simulate*Input interfaces currently in control.ts
    control-dto.ts          # CreateBotInput / CreateUserInput / CreatePrivateChatInput /
                            # CreateGroupChatInput / CreateChannelInput / CreateSupergroupInput /
                            # PromoteChatMemberInput

  control/                  # Outbound control-plane response envelopes
    responses.ts            # CreateBotResponse, SentMessagesResponse, ControlOkResponse, etc.

  validators/               # Runtime validators (zod)
    body.ts                 # parseJsonBody(c, schema) + firstZodError helpers
    primitives.ts           # zChatId, zMessageId
    message-entity.ts       # zMessageEntity
    reply-markup.ts         # zReplyMarkup union
    multipart.ts            # zMultipartFile
    send-message.ts         # zSendMessageBody
    send-photo.ts
    send-media.ts           # BODY_FOR: Record<MediaKind, z.ZodSchema>
    send-document.ts
    edit-message.ts
    callback-query.ts
    chats.ts
    forum.ts
    delivery.ts
    reaction.ts
    commands.ts
    draft.ts
    control.ts              # CreateBot / CreateUser / Create*Chat / Promote schemas
    index.ts
```

Existing `src/entities.ts` is split and moved to `src/types/store/*.ts`. `src/entities.ts` stays as a thin re-export barrel during and after migration (same pattern as `helpers.ts` post-Phase-1).

Promote `MessageEntity`, `PhotoSize`, `InlineKeyboardMarkup`, `InlineKeyboardButton`, `ReplyKeyboardMarkup`, `ForceReply`, `ReplyKeyboardRemove`, `ReplyMarkup` into `src/types/wire/*.ts` (these shapes are identical on wire and in store — wire is canonical).

**Key derivation rule:**

- **Store row** = persistence shape; uses DB-like snake_case keys that reference IDs (`from_user_id`, `sender_chat_id`, `chat_id`).
- **Wire shape** = Bot API emission; uses object-nested `from`, `chat`, `sender_chat` keys.
- The serializer in `src/serializers.ts` is the _only_ place that maps one to the other.

---

## 3. Validator Strategy — zod

### 3.1 Why zod

| Option                 | Bundle        | DX                                                                                   | Objections                                                     |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Hand-written narrowing | 0 kB          | Verbose, merge-bait, **IS the current code** we're replacing                         | Enshrines the problem                                          |
| **zod**                | ~11 kB min+gz | `z.infer<typeof S>` = type; battle-tested; coerce transforms (string→number chat_id) | Size — mitigated by server-only usage                          |
| valibot                | ~1 kB         | Similar DX, tree-shakable                                                            | Pipe API less idiomatic; no browser gain here                  |
| arktype                | ~6 kB         | Type-level parsing                                                                   | Beta API, smaller community                                    |
| typia                  | ~0 runtime    | Zero parser cost                                                                     | Requires TS transformer + `tsup` plugin — toolchain commitment |

**Chosen: zod**

1. Server-only package — 11 kB is noise next to `hono`.
2. **zod is ALREADY in the lockfile** — transitively pulled in by `ai` (3.25.76 and 4.3.6). We're just declaring an explicit dep we already load.
3. Schema→type single source — `z.infer<typeof zSendMessageBody>` produces `SendMessageBody`.
4. Coerce transforms match Telegram (`chat_id` is `number | digit-string`).
5. Hono integration exists via `@hono/zod-validator` — we don't need it but the ecosystem is warm.

### 3.2 Version choice: zod 4

Repo already has zod 4.3.6 installed (via `@ai-sdk/*`). **Adopt zod 4.** Stable since May 2025, ~3× smaller bundle than zod 3, faster parser, same API for 99% of what we write.

### 3.3 Installation

```bash
pnpm add zod@^4 --filter @emulators/telegram
```

Declares the dep we already consume. Lockfile gets one new entry; no install cost.

### 3.4 Example 1 — `sendMessage` before/after

Current (`bot-api.ts:211–271`):

```ts
function sendMessage(c: Context, bot: TelegramBot, body: Record<string, unknown>, store: Store) {
  const chatId = coerceChatId(body.chat_id);
  const rawText = typeof body.text === "string" ? (body.text as string) : "";
  if (chatId === null) return tgError(c, "Bad Request: chat_id is required");
  if (!rawText) return tgError(c, "Bad Request: text is required");
  const replyMarkup = body.reply_markup as ReplyMarkup | undefined;
  const replyTo = typeof body.reply_to_message_id === "number" ? (body.reply_to_message_id as number) : undefined;
  const customEntities = Array.isArray(body.entities) ? (body.entities as MessageEntity[]) : undefined;
  // ...12 more lines...
}
```

Proposed:

```ts
// src/types/validators/primitives.ts
export const zChatId = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^-?\d+$/)
    .transform(Number),
]);

// src/types/validators/send-message.ts
export const zSendMessageBody = z.object({
  chat_id: zChatId,
  text: z.string().min(1).max(4096),
  parse_mode: z.enum(["MarkdownV2", "HTML", "Markdown"]).optional(),
  entities: z.array(zMessageEntity).optional(),
  reply_to_message_id: z.number().int().optional(),
  message_thread_id: z.number().int().optional(),
  reply_markup: zReplyMarkup.optional(),
});
export type SendMessageBody = z.infer<typeof zSendMessageBody>;

// src/routes/bot-api.ts
function sendMessage(c: Context, bot: TelegramBot, body: unknown, store: Store) {
  const r = await parseJsonBody(c, zSendMessageBody);
  if (!r.ok) return r.response;
  const input = r.data; // fully typed SendMessageBody
  // chat lookup + privacy rules + dispatch unchanged
}
```

### 3.5 Example 2 — Discriminated `sendMediaMessage`

```ts
// src/types/validators/send-media.ts
const zMediaFileInput = z.union([z.string(), zMultipartFile]);

const zSendMediaCommon = z.object({
  chat_id: zChatId,
  caption: z.string().optional(),
  caption_entities: z.array(zMessageEntity).optional(),
  parse_mode: z.enum(["MarkdownV2", "HTML", "Markdown"]).optional(),
  message_thread_id: z.number().int().optional(),
  reply_markup: zReplyMarkup.optional(),
  duration: z.number().int().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

export const zSendVideoBody = zSendMediaCommon.extend({ video: zMediaFileInput });
export const zSendAudioBody = zSendMediaCommon.extend({
  audio: zMediaFileInput,
  performer: z.string().optional(),
  title: z.string().optional(),
});
export const zSendVoiceBody = zSendMediaCommon.extend({ voice: zMediaFileInput });
export const zSendAnimationBody = zSendMediaCommon.extend({ animation: zMediaFileInput });
export const zSendStickerBody = zSendMediaCommon.extend({ sticker: zMediaFileInput, emoji: z.string().optional() });

export const BODY_FOR: Record<MediaKind, z.ZodSchema> = {
  video: zSendVideoBody,
  audio: zSendAudioBody,
  voice: zSendVoiceBody,
  animation: zSendAnimationBody,
  sticker: zSendStickerBody,
};

// handler
async function sendMediaMessage(c: Context, bot: TelegramBot, raw: unknown, store: Store, kind: MediaKind) {
  const parsed = BODY_FOR[kind].safeParse(raw);
  if (!parsed.success) return tgError(c, firstZodError(parsed.error));
  const body = parsed.data; // type depends on kind
  const input = body[kind as keyof typeof body]; // string | MultipartFile (one sanctioned cast)
}
```

### 3.6 Example 3 — `parseJsonBody` helper

```ts
// src/types/validators/body.ts
export async function parseJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const raw = await parseTelegramBody(c);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: tgError(c, firstZodError(parsed.error)) };
  return { ok: true, data: parsed.data };
}

export function firstZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  const path = issue.path.length ? issue.path.join(".") : "body";
  // Normalise to Telegram-style "Bad Request: X is required" / "Bad Request: invalid X"
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `Bad Request: ${path} is required`;
  }
  return `Bad Request: ${path}: ${issue.message}`;
}
```

Handler usage:

```ts
const r = await parseJsonBody(c, zSendMessageBody);
if (!r.ok) return r.response;
const body = r.data; // fully typed
```

---

## 4. Migration Plan — 7 Phases

Ordered so each phase: (a) is committable in isolation, (b) leaves the test suite green, (c) progressively removes untyped paths. **Outbound serializers first** — they are pure functions of typed store rows and require no new validator surface.

### Phase 1 — Scaffold `src/types/` + split `entities.ts`

- Create `src/types/{wire,request,store,internal,control,validators}/*.ts` stubs.
- Split `src/entities.ts` into `src/types/store/*.ts`, re-exported from `src/types/store/index.ts`.
- `src/entities.ts` becomes a thin re-export barrel for backward compat.
- Promote `MessageEntity`, `PhotoSize`, `InlineKeyboardMarkup`, `InlineKeyboardButton`, `ReplyKeyboardMarkup`, `ForceReply`, `ReplyKeyboardRemove`, `ReplyMarkup`, `ReactionType` to `src/types/wire/*` (wire is canonical; store re-imports).
- **Commits:** 1. **Risk:** zero. Test suite must stay green unchanged.

### Phase 2 — Type the serializers (outbound boundary)

- Define `WireUser`, `WireChat`, `WireChatFullInfo`, `WireMessage`, `WireBotAsUser` in `src/types/wire/`.
- Change `serializers.ts` returns from `Record<string, unknown>` → typed wire shapes.
- `control.ts:805 getSentMessages` and `:814 getAllMessages` → return `WireMessage[]`.
- Update `test.ts` `TestMessage` interface to _be_ `WireMessage` (they already overlap).
- **Commits:** 1–2 (split chat vs. message if needed). **Risk:** low.

### Phase 3 — Add zod, write validators for the `request/` surface

- `pnpm add zod@^4 --filter @emulators/telegram`.
- Write `zChatId`, `zMessageEntity`, `zReplyMarkup`, `zMultipartFile` primitives.
- Write schemas for **every** Bot API method under `src/types/validators/*.ts`.
- Derive `request/*.ts` types via `z.infer`.
- Write `parseJsonBody` + `firstZodError` in `src/types/validators/body.ts`.
- **Do not** wire into handlers yet — purely additive.
- Add `__tests__/validators.test.ts` round-tripping a real body per schema.
- **Commits:** 2–3 (split by family: delivery, messaging, media, forum, chats, control).
- **Risk:** low.

### Phase 4 — Swap Bot API handlers to typed input

- Rewrite `routes/bot-api.ts`, `bot-api-chats.ts`, `bot-api-delivery.ts`, `bot-api-forum.ts`.
- Each handler: `body: unknown` → `parseJsonBody(c, zX)` → typed `input`.
- Delete every `typeof body.X ===` and `body.X as Y` in the process.
- Fix `as unknown as InlineKeyboardMarkup` at `bot-api.ts:654` with `isInlineKeyboardMarkup(markup)` guard.
- **Commits:** 3–4 (by file). **Risk:** medium.
- **Specific risk:** zod default error messages don't match Telegram's; `firstZodError` must normalise. Three tests assert on exact error text (`integration.test.ts` especially).
- **Mitigation:** test each sub-commit; add `firstZodError` test cases for every expected `Bad Request: …` wording.

### Phase 5 — Type the control plane + simulate inputs

- Move `CreateBotInput` / `CreateUserInput` / `Create*ChatInput` / `Simulate*Input` / `PromoteChatMemberInput` into `src/types/internal/control-dto.ts` and `simulate.ts`.
- Write zod schemas for each control endpoint body.
- Delete all 6 `as unknown as X` casts in `control.ts`.
- Tighten `body.photo_bytes_base64 !== undefined` / `body.bytesBase64` paths into typed unions: `{ photoBase64: string } | { photo: MultipartFileRef }`.
- **Commits:** 1–2. **Risk:** low.

### Phase 6 — Dispatcher payload union + media builder discriminated

- `src/types/wire/update.ts`: `WireUpdate` discriminated union on `UpdateType` + `PayloadFor<T extends UpdateType>` lookup type.
- `src/types/store/update.ts`: `TelegramUpdate.payload: WireUpdate` (was `Record<string, unknown>`).
- `Dispatcher.enqueue` becomes generic: `enqueue<T extends UpdateType>(botId: number, type: T, payload: PayloadFor<T>): TelegramUpdate`.
- Central `wrapPayload<T>(update_id, type, payload)` helper isolates the one sanctioned cast on the computed-key construction.
- `buildMediaField` returns discriminated `WireMediaField` union on `kind`.
- Delete `ChatMemberLike.user: Record<string, unknown>` — replace with `WireUser`.
- **Commits:** 2. **Risk:** medium.
- **Specific risk:** `simulateReaction` (`control.ts:745,755`) builds two heterogeneous payloads inline (per-user + count); `dispatchEditedMessage` (`bot-api.ts:908`) dispatches `edited_message | edited_channel_post` based on chat type — narrowing may fight. Use `wrapPayload` everywhere.

### Phase 7 — Tighten tests + `test.ts` generics

- `__tests__/helpers.ts:json<T>()` — populate with `WireMessage`, `WireUpdate`.
- Replace 11 `as { … }` test assertions with typed accesses.
- Make `test.ts` `postJsonOuter` generic on per-endpoint response envelope.
- Replace every `r.X as Y` in client methods with `postJson<SpecificResponse>(…)`.
- Tighten `TestMessage.entities: unknown[]` → `WireMessageEntity[]`; `TestMessage.reply_markup: Record<string, unknown>` → `WireReplyMarkup`.
- **Commits:** 1. **Risk:** low.
- **Hidden risk:** `test.ts` `JsonResponse<T>` index signature (`[key: string]: unknown`) currently hides type errors; replacing it may surface latent bugs in downstream consumers. Grep the monorepo for `@emulators/telegram/test` imports before committing.

---

## 5. Types That Are Genuinely Hard

### 5.1 `reply_markup` — four-way union, no discriminator field

```ts
export type WireReplyMarkup =
  | WireInlineKeyboardMarkup // { inline_keyboard: ... }
  | WireReplyKeyboardMarkup // { keyboard: ..., ... }
  | WireForceReply // { force_reply: true, ... }
  | WireReplyKeyboardRemove; // { remove_keyboard: true, ... }
```

Telegram's wire format has no shared tag. Ship type guards alongside:

```ts
export const isInlineKeyboard = (m: WireReplyMarkup): m is WireInlineKeyboardMarkup => "inline_keyboard" in m;
export const isForceReply = (m: WireReplyMarkup): m is WireForceReply => "force_reply" in m;
// etc.
```

Zod validator uses `z.union([...])` — zod infers the branch from required-key presence. 2 call sites currently inspect `reply_markup` (`bot-api.ts:653`, `inspector.ts:49`).

### 5.2 `sendMediaMessage` — body shape varies by `kind`

Solution in §3.5. `Record<MediaKind, z.ZodSchema>` lookup; one `as keyof typeof body` cast remains at dispatch because TS can't prove `body.video` when `kind === "video"` equals `body[kind]`. Acceptable.

### 5.3 `WireUpdate` — discriminated wrapper with dynamic key

```ts
export type WireUpdate =
  | { update_id: number; message: WireMessage }
  | { update_id: number; edited_message: WireMessage }
  | { update_id: number; callback_query: WireCallbackQuery }
  | { update_id: number; channel_post: WireMessage }
  | { update_id: number; edited_channel_post: WireMessage }
  | { update_id: number; my_chat_member: WireChatMemberUpdated }
  | { update_id: number; chat_member: WireChatMemberUpdated }
  | { update_id: number; message_reaction: WireMessageReactionUpdated }
  | { update_id: number; message_reaction_count: WireMessageReactionCountUpdated };

export type PayloadFor<T extends UpdateType> = T extends
  | "message"
  | "edited_message"
  | "channel_post"
  | "edited_channel_post"
  ? WireMessage
  : T extends "callback_query"
    ? WireCallbackQuery
    : T extends "my_chat_member" | "chat_member"
      ? WireChatMemberUpdated
      : T extends "message_reaction"
        ? WireMessageReactionUpdated
        : T extends "message_reaction_count"
          ? WireMessageReactionCountUpdated
          : never;
```

Pain: `dispatcher.ts:65` builds `{ update_id, [type]: payload }` — dynamic computed keys defeat narrowing. Centralise the cast:

```ts
function wrapPayload<T extends UpdateType>(update_id: number, type: T, payload: PayloadFor<T>): WireUpdate {
  return { update_id, [type]: payload } as WireUpdate;
}
```

Everything else stays typed.

### 5.4 `adminMemberExtras` returning partial record

Delete it. `WireChatMember` is a discriminated union on `status`; `getChatMember` and `getChatAdministrators` construct the _correct_ variant per status:

```ts
export type WireChatMember =
  | { status: "creator"; user: WireUser; is_anonymous: boolean }
  | {
      status: "administrator";
      user: WireUser;
      can_be_edited: boolean;
      can_manage_chat: boolean; /* full admin rights set */
    }
  | { status: "member"; user: WireUser }
  | { status: "restricted"; user: WireUser; until_date: number /* restrictions */ }
  | { status: "left"; user: WireUser }
  | { status: "kicked"; user: WireUser; until_date: number };
```

The undefined-stripping loops at `bot-api-chats.ts:85–87` and `:101–104` disappear.

### 5.5 Persisted `TelegramUpdate.payload` vs. wire

Payload stored = emitted wire (no transform). Type it directly:

```ts
export interface TelegramUpdate extends Entity {
  update_id: number;
  for_bot_id: number;
  type: UpdateType;
  payload: WireUpdate; // was Record<string, unknown>
  delivered: boolean;
  // ...
}
```

`JSON.stringify(update.payload)` at `dispatcher.ts:117` still works.

---

## 6. What to Leave Loose (Legitimate `unknown`)

Each explicitly typed `unknown` with a comment — **not** `Record<string, unknown>` (which falsely claims object-ness without structure).

| Field                                                             | Why                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TelegramFile.bytes_base64: string`                               | Opaque content; base64 is `string`. Already typed — keep.                                                    |
| `InlineKeyboardButton.callback_data: string`                      | User-supplied opaque payload. Already `string`.                                                              |
| `parseTelegramBody(c): Promise<unknown>`                          | Transport-layer raw. Only `unknown` entry point; narrowing happens at validators. Tighten current signature. |
| `webhook.test.ts:15` received body                                | Test captures raw transport. Acceptable `unknown`; could tighten to `WireUpdate` if wanted.                  |
| Multipart `bytes: Buffer`                                         | `Buffer` is correct. Already typed.                                                                          |
| `TelegramDraftSnapshot.entities?: MessageEntity[]` in test client | Tighten to `WireMessageEntity[]` (currently `unknown[]`).                                                    |

**Rejected as loose:** `reply_markup` (has clear union), `TelegramUpdate.payload` (discriminated), any `body.X` (has request schema).

---

## 7. Estimated Scope + Risk

| Component                             | Adds   | Deletes | Net            |
| ------------------------------------- | ------ | ------- | -------------- |
| `src/types/store/*` (from entities)   | +340   | -323    | ~0             |
| `src/types/wire/*`                    | +450   | 0       | +450           |
| `src/types/request/*`                 | +250   | 0       | +250           |
| `src/types/internal/*`                | +180   | 0       | +180           |
| `src/types/validators/*` (zod)        | +500   | 0       | +500           |
| `routes/bot-api*.ts` refactor         | +50    | -280    | -230           |
| `routes/control.ts` refactor          | +30    | -90     | -60            |
| `serializers.ts` retype               | +10    | -5      | +5             |
| `dispatcher.ts` + `services/media.ts` | +40    | -20     | +20            |
| `test.ts` + `__tests__/*`             | +60    | -80     | -20            |
| **Net**                               | ~1,910 | ~800    | **+1,110 LOC** |

Types + schemas = ~1,720 LOC (zero runtime cost for interfaces; ~11 kB runtime for zod).

**Commits:** ~10–12 across 7 phases.

**Risk profile:**

- **Low**: Phases 1, 2, 3, 7 (additive or mechanical).
- **Medium**: Phases 4, 5 — zod default error strings drift from Telegram's wording. Budget ~2h for `firstZodError` reconciliation. Existing tests that assert exact `Bad Request: X` strings are the tripwire.
- **Medium**: Phase 6 — `enqueue` generic touches ~12 call sites; `simulateReaction` and `dispatchEditedMessage` have heterogeneous payloads. Use `wrapPayload` uniformly.
- **Hidden**: Phase 7 — `test.ts` index signature hides errors; fix may surface latent bugs in downstream consumers. Grep the monorepo before committing.

---

## 8. Execution Rules for the Worker

**Branch:** continue on `feat/telegram-emulator`. Commits stack on top of the existing work.

**Test protocol per phase:**

```bash
pnpm --filter @emulators/telegram exec tsc --noEmit   # must be clean
pnpm --filter @emulators/telegram test                # must pass 112/112 (may grow)
pnpm --filter telegram-grammy-demo test                # must pass 9/9 (takes ~58s)
```

Run all three before every commit. Never commit with failing tests.

**Commit style:** follow the existing history on the branch — `feat(telegram): …`, `refactor(telegram): …`, `fix(telegram): …`, imperative mood, blank line, wrap body at ~72 cols, NO Claude footer (per user's global CLAUDE.md).

**Sequencing rules:**

- Phases must go in order 1 → 7. Later phases depend on earlier ones.
- Inside a phase, sub-commits may reorder if it keeps tests green.
- If a phase risks breaking downstream (especially Phase 7), pause and grep for external consumers before committing.
- Do not refactor outside the typing scope. The preceding session already did the correctness + structural work; the worker's job is typing only.

**Owner preferences (global CLAUDE.md):**

- No Claude Code footer in commit messages.
- Always rebase, never merge.
- Propose before asked — if a better structure emerges during the work, document and proceed.
- Make calls, not menus — decide; don't produce option lists.

**Completion criteria:**

1. Zero occurrences of `Record<string, unknown>` in `src/` outside comments and the explicit-`unknown` allowlist in §6.
2. Zero `as unknown as X` casts.
3. Zero inline `typeof body.X === …` ladders in route handlers (should all be inside zod schemas).
4. `serialize*` functions have named return types.
5. `TelegramUpdate.payload` is `WireUpdate`.
6. `Dispatcher.enqueue` is generic on `UpdateType`.
7. All tests pass. TypeScript clean.
8. `src/types/` exists with the layout in §2.
9. `zod` is declared in `packages/@emulators/telegram/package.json` dependencies.
10. The CHANGELOG `## Unreleased` section gains a "Typing" bullet.

**Non-goals:**

- Don't touch sibling emulators (slack, stripe, etc.).
- Don't publish / bump version — leave that to the release workflow.
- Don't add new Bot API methods beyond what exists today.
- Don't adopt `@hono/zod-validator` — the simple `parseJsonBody` helper is enough and keeps Hono coupling minimal.

**If stuck:**

- If zod 4's API diverges from expectation, check `node_modules/.pnpm/zod@4.3.6/` for the version actually resolved.
- If Telegram Bot API reference is needed, fetch https://core.telegram.org/bots/api (public, no auth).
- If a test expects a specific error string that zod can't produce, tighten `firstZodError`. Do not loosen the test.

**Do not change:**

- The runtime behaviour of any emulator method. Types don't move requirements.
- The file layout outside `src/types/` beyond what's needed to wire the new types in.
- Dependencies beyond adding `zod`.
