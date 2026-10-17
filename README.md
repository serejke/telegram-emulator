# grammy-emulate

End-to-end testing for Telegram bots against an in-process Telegram Bot API emulator.
No real bot token, no network, no second Telegram account.

> **Status.** The emulator runs on a slightly older core of
> [vercel-labs/emulate](https://github.com/vercel-labs/emulate) (`@emulators/core` 0.9.0).
> It works for everything listed below.
> I don't actively maintain this repo. I've used it in a couple of pet projects,
> and if people need it, I'll put more time in. PRs are very welcome.

## Packages

| Package                                                    | What it is                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`grammy-emulate`](packages/grammy-emulate)                | Fluent test API for [grammY](https://grammy.dev) bots: seed fixtures, simulate users, inspect replies, assert with Vitest matchers. |
| [`@serejke/telegram-emulator`](packages/telegram-emulator) | The Bot API emulator itself. Any Telegram library or language can talk to it over HTTP.                                             |

```bash
npm install --save-dev grammy-emulate          # grammY bots
npx @serejke/telegram-emulator --port 4014     # anything else: point your bot's API root here
```

## What works

- **Delivery:** long polling (`getUpdates`, 409 on concurrent polls) and webhooks (`setWebhook` with `secret_token`, retries on 5xx).
- **Messages:** text, photo, document, video, audio, voice, animation, sticker; edits, deletes, chat actions.
- **Formatting:** MarkdownV2, HTML, legacy Markdown, with real Telegram error messages on bad input.
- **Interaction:** inline keyboards and callback queries, reactions, bot commands.
- **Chats:** private, group (with Privacy Mode), supergroup with forum topics, channel.
- **Files:** `getFile` and file download, stable `file_id` on re-send.
- **Fault injection:** force 401 / 403 / 404 / 429 (with `retry_after`) on the next N calls to test error paths.

Not covered: payments, games, Business API, Passport, inline mode, media groups, polls.
Full method list: [telegram-emulator README](packages/telegram-emulator#what-is-implemented).

## Example

[`examples/echo-bot`](examples/echo-bot) is a small grammY bot with 22 end-to-end tests.
It also has the same test written the old way, with hand-made mocks, for comparison.

## Develop

```bash
pnpm install
pnpm build
pnpm test
```

## License

`grammy-emulate`: MIT. `@serejke/telegram-emulator`: Apache-2.0.
