# grammy-emulate

End-to-end testing for Telegram bots against an in-process Bot API emulator.
No real bot token, no network, no second Telegram account.

| Package | What it is |
| --- | --- |
| [`grammy-emulate`](packages/grammy-emulate) | Fluent test API for [grammY](https://grammy.dev) bots: seeding, simulation, inspection, vitest matchers. |
| [`@serejke/telegram-emulator`](packages/telegram-emulator) | The Bot API emulator itself. Works with any Telegram bot library or language. |

A runnable showcase with 22 end-to-end tests lives in [`examples/echo-bot`](examples/echo-bot).

## Develop

```bash
pnpm install
pnpm build
pnpm test
```
