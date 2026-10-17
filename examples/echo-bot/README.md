# echo-bot example

A small grammY bot tested end to end with `grammy-emulate`.

## The bot

[`src/bot.ts`](src/bot.ts) exports `buildEchoBot(token, apiRoot)`:

- Commands: `/start`, `/echo <text>`, `/menu`, `/connect <code>`.
- `/menu` shows an inline keyboard. `menu:about` and `menu:help` edit the message; `menu:close` answers the callback and deletes it.
- Any other text gets `You said: <text>`.

## The tests

| File                                           | Tests | What it covers                                                                                        |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| [`bot.test.ts`](src/bot.test.ts)               | 8     | Commands, inline keyboard edits and deletes, callback answers, Privacy Mode in a group. Long polling. |
| [`webhook.test.ts`](src/webhook.test.ts)       | 3     | The same flows in webhook mode, and `allowedUpdates` filtering.                                       |
| [`media.test.ts`](src/media.test.ts)           | 6     | Video, audio, voice, animation, sticker, and document; the bot sees the same `file_id`.               |
| [`faults.test.ts`](src/faults.test.ts)         | 4     | Injected 429 and 403 errors reaching `bot.catch`; `count`; `faults.during` cleanup on throw.          |
| [`bot.before.test.ts`](src/bot.before.test.ts) | 1     | `/echo hello` with transformer mocks and a hand-written `Update`, for comparison.                     |

## Run

From the repository root:

```bash
pnpm install
pnpm build
pnpm --filter echo-bot-example test
```

## Before and after

Before, with mocks:

```ts
const sent: Array<{ method: string; payload: unknown }> = [];
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload });
  // Invent a response shaped well enough that grammY accepts it.
  return {
    ok: true,
    result: {
      message_id: sent.length,
      date: 0,
      chat: { id: 111, type: "private" },
    } as any,
  };
});

await bot.handleUpdate({
  update_id: 1,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 111, type: "private", first_name: "Alice" },
    from: { id: 222, is_bot: false, first_name: "Alice" },
    text: "/echo hello",
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  },
});

expect(sent[0]).toMatchObject({
  method: "sendMessage",
  payload: { text: "hello" },
});
```

The full version, including the hand-written `botInfo`, is in [`bot.before.test.ts`](src/bot.before.test.ts).

You invent ids, chat shapes, and entity offsets.
The wire format and the polling loop never run.
Each extra step (a click, an edit, a follow-up message) needs more fakes.

After, with `grammy-emulate`:

```ts
const bot = await emu.seed.bot({ username: "echo_bot" });
const alice = await emu.seed.user({ first_name: "Alice" });
const dm = await emu.seed.privateChat(bot, alice);
await emu.mount(bot, buildEchoBot);

await emu.as(alice).in(dm).send("/echo hello");
const reply = await emu.in(dm).waitForReply();
expect(reply).toMatchReply("hello");
```

grammY polls a real HTTP Bot API.
The emulator allocates ids, parses entities, and applies Privacy Mode, and the test can continue the flow as a user would.
