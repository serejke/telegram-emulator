import { createServer as createNetServer, connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startTelegramEmulator, type TelegramEmulator } from "../server.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** A non-loopback IPv4 address of this host, if it has one. */
function externalIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("startTelegramEmulator — network binding", () => {
  let emu: TelegramEmulator | undefined;
  afterEach(async () => {
    await emu?.close();
    emu = undefined;
  });

  it("listens on loopback by default and serves via localhost", async () => {
    emu = await startTelegramEmulator({ port: await freePort() });

    const res = await fetch(`${emu.url}/bot100001:EMULATE_DEFAULT_TOKEN/getMe`);
    expect(res.status).toBe(200);
    expect(await canConnect("127.0.0.1", emu.port)).toBe(true);

    const external = externalIPv4();
    if (external) expect(await canConnect(external, emu.port)).toBe(false);
  });

  it("exposes all interfaces only when hostname 0.0.0.0 is requested", async (ctx) => {
    const external = externalIPv4();
    if (!external) ctx.skip();
    emu = await startTelegramEmulator({ port: await freePort(), hostname: "0.0.0.0" });

    expect(await canConnect(external!, emu.port)).toBe(true);
  });

  it("rejects when the port is already taken instead of crashing", async () => {
    emu = await startTelegramEmulator({ port: await freePort() });

    await expect(startTelegramEmulator({ port: emu.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});
