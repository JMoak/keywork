import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { exchangeResponse } from "../mcp/server.ts";
import { memoryAuditLog } from "../mesh/audit/log.ts";
import { houseNode, selfOf } from "../mesh/pairing/testing/identities.ts";
import { creatureHost } from "./host.ts";
import { type CreatureMcp, creatureMcp } from "./mcp.ts";
import { messageGuard } from "./messages/guard.ts";
import { defaultMessageLimits } from "./messages/message.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const vibrissa = process.env.KEYWORK_VIBRISSA;
const cli = vibrissa === undefined ? "" : join(vibrissa, "bin", "vib-test.js");
const config = join(import.meta.dirname, "..", "mcp", "vibrissa", "vibrissa.json");
const run = promisify(execFile);
const scratch = scratchDirs("keywork-creature-vibrissa-");

describe.skipIf(vibrissa === undefined || !existsSync(cli))("vibrissa's contract cases", () => {
  it.each([["auto"], ["legacy"]])("pass against pip over the %s era", async (era) => {
    const mcp = await servedPip();
    const server = createServer((incoming, outgoing) => void answer(mcp, incoming, outgoing));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/creatures/pip/mcp`;
    const profile = era === "legacy" ? ["--profile", "legacy"] : [];
    try {
      const { stdout } = await run(
        process.execPath,
        [cli, "run", "--config", config, "--check", ...profile],
        {
          env: { ...process.env, KEYWORK_CREATURE_MCP_URL: url, NO_COLOR: "1" },
        },
      ).catch((failure: { stdout?: string; stderr?: string }) => {
        throw new Error(`vibrissa failed:
${failure.stdout ?? ""}
${failure.stderr ?? ""}`);
      });
      expect(stdout).toContain("5 cases: 5 passed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function servedPip(): Promise<CreatureMcp> {
  const at = new Date("2026-11-06T09:00:00.000Z");
  const registry = new CreatureRegistry({
    root: await scratch(),
    trusted: true,
    keeper: "Jordan",
    now: () => at,
    seed: () => 7,
  });
  const sessions = new FakeCreatureSessions(() => at);
  const host = creatureHost({ registry, sessions, now: () => at });
  await host.create({ name: "Pip" });
  return creatureMcp({
    creatures: host,
    conversation: async () => ({
      messages: [],
      reports: sessions.injections.map((injection, index) => ({
        index: 0,
        entryId: `entry-${index}`,
        at: at.toISOString(),
        text: injection.text,
        origin: injection.origin,
      })),
      busy: false,
    }),
    guard: messageGuard({ ...defaultMessageLimits, perSenderHourly: 1000 }, Date.now),
    limits: { ...defaultMessageLimits, perSenderHourly: 1000 },
    audit: memoryAuditLog(),
    self: async () => selfOf(houseNode),
    machine: () => "house",
    version: "0.0.0-vibrissa",
  });
}

async function answer(
  mcp: CreatureMcp,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  if (incoming.method !== "POST") {
    outgoing.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const reply = await mcp.answer("pip", JSON.parse(Buffer.concat(chunks).toString("utf8")), {
    kind: "local",
  });
  const response =
    reply === "missing" ? new Response(null, { status: 404 }) : exchangeResponse(reply);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}
