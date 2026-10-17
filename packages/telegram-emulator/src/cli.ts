#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_PORT, startTelegramEmulator } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: String(DEFAULT_PORT) },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: telegram-emulator [--port 4014]");
  process.exit(0);
}

const emu = await startTelegramEmulator({ port: Number(values.port) });
console.log(`Telegram Bot API emulator on ${emu.url}`);
console.log(`Default bot token: 100001:EMULATE_DEFAULT_TOKEN`);
console.log(`Inspector: ${emu.url}/`);

const stop = () => void emu.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
