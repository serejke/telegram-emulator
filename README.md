# telegram-emulator

A stateful Telegram Bot API emulator that runs in your test process, and a grammY test kit on top of it.
Your bot talks to it over HTTP instead of `api.telegram.org`; your test plays the users.

> **Status.** The emulator runs on a slightly older core of
> [vercel-labs/emulate](https://github.com/vercel-labs/emulate) (`@emulators/core` 0.9.0).
> It works for everything listed below.
> I don't actively maintain this repo. I've used it in a couple of pet projects,
> and if people need it, I'll put more time in. PRs are very welcome.

## How it fits together

```text
 test                                    emulator (one HTTP server)               your bot
 ────                                    ──────────────────────────               ────────
 act as Alice  ── /_emu/telegram/* ──▶   store message, enqueue Update
                                         getUpdates / webhook POST  ─────────▶   handler runs
                                         store the bot's message   ◀─ /bot<token>/sendMessage
 read replies  ◀─ /_emu/telegram/* ───   bots, users, chats, messages, queues
```

The bot uses only the real Bot API surface, so it runs unmodified.
The test uses a separate control plane to create fixtures, act as users, and read state back.

## Packages

| Package                                                    | What it is                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`@serejke/telegram-emulator`](packages/telegram-emulator) | The Bot API emulator, a CLI, and a control-plane test client. Works with any Telegram library or language. Apache-2.0.                |
| [`grammy-emulate`](packages/grammy-emulate)                | Fluent test API for [grammY](https://grammy.dev): seed fixtures, mount the bot, act as users, wait for replies, Vitest matchers. MIT. |

## Quick start

grammY:

```bash
npm install --save-dev grammy-emulate
```

```ts
import { test, expect } from "vitest";
import { Bot } from "grammy";
import { emulator } from "grammy-emulate";
import { emuVitest } from "grammy-emulate/vitest";

const emu = emulator();
emuVitest(emu);

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
  expect(await emu.in(dm).waitForReply()).toMatchReply("hello");
});
```

Any other library or language: start the server and set your bot's API root to it.

```bash
npx @serejke/telegram-emulator --port 4014
# default bot token: 100001:EMULATE_DEFAULT_TOKEN, inspector at http://localhost:4014/
```

## What works

- **Delivery:** long polling (`getUpdates` with offsets, 409 when a second poll takes over) and webhooks (`secret_token`, retries on 5xx).
- **Messages:** text, photo, document, video, audio, voice, animation, sticker; edits, deletes, chat actions.
- **Formatting:** MarkdownV2, HTML, and legacy Markdown, with Telegram-style errors on bad input.
- **Interaction:** inline keyboards and callback queries, reactions, bot commands.
- **Chats:** private, group (with Privacy Mode), supergroup with forum topics, channel.
- **Files:** `getFile` and file download; `file_id` stays the same on re-send.
- **Fault injection:** make the next N calls of a method fail with 400 / 401 / 403 / 404 / 429 (with `retry_after`).

Not covered: payments, games, Business API, Passport, inline mode, media groups, polls.
Full method list and known differences from Telegram: [emulator README](packages/telegram-emulator#bot-api-coverage).

## Example

[`examples/echo-bot`](examples/echo-bot) is a small grammY bot with 21 emulator-driven tests, plus one test written the old way, with hand-made mocks, for comparison.

## Develop

```bash
pnpm install
pnpm build   # grammy-emulate and the example consume the built packages
pnpm test
```

## License

`@serejke/telegram-emulator`: Apache-2.0. `grammy-emulate`: MIT.
