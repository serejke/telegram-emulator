#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_HOSTNAME, DEFAULT_PORT, startTelegramEmulator } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: String(DEFAULT_PORT) },
    host: { type: "string", default: DEFAULT_HOSTNAME },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: telegram-emulator [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOSTNAME}]`);
  console.log("  --host 0.0.0.0 exposes the emulator on all network interfaces.");
  process.exit(0);
}

const emu = await startTelegramEmulator({ port: Number(values.port), hostname: values.host });
console.log(`Telegram Bot API emulator on ${emu.url} (listening on ${values.host})`);
console.log(`Default bot token: 100001:EMULATE_DEFAULT_TOKEN`);
console.log(`Inspector: ${emu.url}/`);

const stop = () => void emu.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
