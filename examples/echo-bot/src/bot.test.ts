import { describe, test, expect, beforeEach } from "vitest";
import { emulator } from "grammy-emulate";
import { emuVitest } from "grammy-emulate/vitest";
import type { TestBot, TestChat, TestUser, MountedBot } from "grammy-emulate";
import { buildEchoBot } from "./bot.js";
import type { Bot } from "grammy";

const emu = emulator();
emuVitest(emu);

describe("echo bot — end-to-end via the emulator", () => {
  let bot: TestBot;
  let alice: TestUser;
  let dm: TestChat;
  let mounted: MountedBot<Bot>;

  beforeEach(async () => {
    bot = await emu.seed.bot({
      username: "echo_e2e_bot",
      commands: [
        { command: "start", description: "Start" },
        { command: "echo", description: "Echo text" },
        { command: "menu", description: "Show menu" },
        { command: "connect", description: "Connect code" },
      ],
    });
    alice = await emu.seed.user({ first_name: "Alice", username: "alice" });
    dm = await emu.seed.privateChat(bot, alice);
    mounted = await emu.mount(bot, buildEchoBot);
  });

  test("/start replies with a welcome", async () => {
    await emu.as(alice).in(dm).send("/start");
    const reply = await emu.in(dm).waitForReply();
    expect(reply).toMatchReply(/Welcome/);
  });

  test("/echo hello echoes back 'hello'", async () => {
    await emu.as(alice).in(dm).send("/echo hello");
    const reply = await emu.in(dm).waitForReply();
    expect(reply).toMatchReply("hello");
  });

  test("/echo without text prompts usage", async () => {
    await emu.as(alice).in(dm).send("/echo");
    const reply = await emu.in(dm).waitForReply();
    expect(reply).toMatchReply(/Usage:/);
  });

  test("/menu shows inline keyboard; 'About' edits the message", async () => {
    await emu.as(alice).in(dm).send("/menu");
    const menu = await emu.in(dm).waitForReply();
    const markup = menu.reply_markup;
    expect(markup && "inline_keyboard" in markup && markup.inline_keyboard[0]?.[0]?.text).toBe(
      "About",
    );

    await emu.as(alice).in(dm).click(menu.message_id, "menu:about");

    // The bot edits the same message; wait for edit_date to populate.
    await waitUntil(async () => {
      const current = (await emu.in(dm).replies()).find(
        (m) => m.message_id === menu.message_id,
      );
      return !!current?.edit_date;
    });

    const edited = (await emu.in(dm).replies()).find(
      (m) => m.message_id === menu.message_id,
    );
    expect(edited).toMatchReply(/About:/);
  });

  test("/menu -> 'Close' deletes the message and answers the callback", async () => {
    await emu.as(alice).in(dm).send("/menu");
    const menu = await emu.in(dm).waitForReply();

    const click = await emu.as(alice).in(dm).click(menu.message_id, "menu:close");

    await waitUntil(async () => {
      const current = (await emu.in(dm).replies()).find(
        (m) => m.message_id === menu.message_id,
      );
      return current === undefined;
    });

    const answer = await emu.inspect.callbackAnswer(click.callback_query_id);
    await expect(answer).toHaveAnsweredCallback();
    expect(answer?.answer_text).toBe("closed");
  });

  test("/connect with a valid 6-char code succeeds", async () => {
    await emu.as(alice).in(dm).send("/connect ABC123");
    const reply = await emu.in(dm).waitForReply();
    expect(reply).toMatchReply("Connected with code ABC123.");
  });

  test("/connect with an invalid code is rejected", async () => {
    await emu.as(alice).in(dm).send("/connect bad");
    const reply = await emu.in(dm).waitForReply();
    expect(reply).toMatchReply(/Invalid code/);
  });

  test("group chat: bot ignores unaddressed plain text", async () => {
    // Build a group with Alice, Bob, and the bot. Privacy Mode is on by
    // default, so the bot should not see "hello everyone".
    const bob = await emu.seed.user({ first_name: "Bob", username: "bob" });
    const group = await emu.seed.group({
      title: "Test Group",
      users: [alice, bob],
      bots: [bot],
    });

    await emu.as(alice).in(group).send("hello everyone");
    // Give the bot a chance; there should be no reply.
    await new Promise((r) => setTimeout(r, 200));
    await expect(emu.in(group)).toHaveReplyCount(0);

    // Addressed /echo still works in groups (dispatched past Privacy Mode).
    await emu.as(alice).in(group).send("/echo@echo_e2e_bot hi from group");
    const reply = await emu.in(group).waitForReply();
    expect(reply).toMatchReply("hi from group");
  });

  // After-each stop for the mounted bot; reset is done globally via emuVitest
  // which also tears down the emulator store. We still need to stop the
  // polling bot explicitly between tests since mount() registers it on the
  // emulator instance.
  // (emu.reset() handles that by stopping all mounted bots.)
  return;
});

async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 3000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}
