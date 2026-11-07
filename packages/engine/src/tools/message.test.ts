import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { creatureHost } from "../creatures/host.ts";
import { creatureMail } from "../creatures/messages/mail.ts";
import { CreatureRegistry } from "../creatures/registry.ts";
import { FakeCreatureSessions } from "../creatures/testing.ts";
import { memoryAuditLog } from "../mesh/audit/log.ts";
import { houseNode, selfOf } from "../mesh/pairing/testing/identities.ts";
import { mutatingToolNames } from "../mutations.ts";
import { toolScope } from "./confine.ts";
import { coreTools, creatureTools } from "./core.ts";
import { messageTool } from "./message.ts";

const scratch = scratchDirs("keywork-message-tool-");

const at = new Date("2026-11-06T16:00:00.000Z");

async function twoCreatures(limits: { perSenderHourly?: number } = {}) {
  const root = await scratch();
  const registry = new CreatureRegistry({
    root,
    trusted: true,
    keeper: "Jordan",
    now: () => at,
    seed: () => 1,
  });
  const sessions = new FakeCreatureSessions(() => at);
  const host = creatureHost({ registry, sessions, now: () => at });
  for (const name of ["Hal", "Lark"]) await host.create({ name });
  const audit = memoryAuditLog({ now: () => at });
  const mail = creatureMail({
    mailboxes: host,
    pairs: () => [],
    client: {
      send: async () => {
        throw new Error("no machine is reachable in this test");
      },
    },
    audit,
    self: async () => selfOf(houseNode),
    machine: () => "house",
    now: () => at.getTime(),
    limits,
  });
  const conversationOf = async (slug: string) => (await host.read(slug))?.conversation ?? "";
  return { host, sessions, audit, mail, conversationOf };
}

describe("the message tool", () => {
  it("sends plain words from the seated creature to another, landing as a line in its conversation with no turn", async () => {
    const { sessions, mail, audit, conversationOf } = await twoCreatures();
    const tool = messageTool({ creature: "lark", mail });

    const said = await tool.execute({
      to: "Hal",
      text: "The five largest docs are listed in notes/largest.md; please check them when you can.",
    });

    const hal = await conversationOf("hal");
    expect(said).toMatch(
      /^Delivered to hal \(message [\w-]+\)\. It reaches hal's next turn as a note from you; hal answers, if at all, when it next works\.$/,
    );
    expect(sessions.injections).toEqual([
      {
        sessionId: hal,
        text: "Message from lark: The five largest docs are listed in notes/largest.md; please check them when you can.",
        origin: expect.objectContaining({ kind: "creature", creature: "lark", machine: "house" }),
      },
    ]);
    expect(sessions.turnsStarted(hal)).toBe(0);
    expect((await audit.rows()).map((row) => row.capability)).toEqual([
      "message.send",
      "message.receive",
    ]);
  });

  it("answers the inbound policy and the hourly limits in words instead of delivering", async () => {
    const { host, mail, sessions } = await twoCreatures({ perSenderHourly: 1 });
    const tool = messageTool({ creature: "lark", mail });

    await host.update("hal", { inbound: "nobody" });
    expect(await tool.execute({ to: "hal", text: "one" })).toBe(
      "Not delivered: hal takes messages from nobody.",
    );
    await host.update("hal", { inbound: "paired" });
    expect(await tool.execute({ to: "hal", text: "two" })).toMatch(/^Delivered to hal/);
    expect(await tool.execute({ to: "hal", text: "three" })).toMatch(/^Not delivered: /);
    expect(await tool.execute({ to: "wren", text: "four" })).toBe(
      "Not delivered: no creature here is called wren.",
    );
    expect(sessions.injections).toHaveLength(1);
  });

  it("refuses arguments beyond a name, plain text and a machine", async () => {
    const { mail } = await twoCreatures();
    const tool = messageTool({ creature: "lark", mail });
    await expect(tool.execute({ to: "hal", text: "hi", approve: true })).rejects.toThrow();
    await expect(tool.execute({ to: "hal", text: "   " })).rejects.toThrow();
    expect(tool.parameters).toMatchObject({ required: ["to", "text"] });
  });

  it("is read-only in grant terms and joins a creature's core tools beside schedule", async () => {
    const { mail } = await twoCreatures();
    const message = { creature: "lark", mail };
    const tool = messageTool(message);
    expect(tool.mutates).toBeUndefined();
    expect(mutatingToolNames.has(tool.name)).toBe(false);

    const scope = toolScope(await scratch());
    expect(coreTools(scope).map(({ name }) => name)).not.toContain("message");
    expect(coreTools(scope, { message }).map(({ name }) => name)).toContain("message");
    expect(creatureTools({ message }).map(({ name }) => name)).toEqual(["message"]);
    expect(creatureTools({}).map(({ name }) => name)).toEqual([]);
  });
});
