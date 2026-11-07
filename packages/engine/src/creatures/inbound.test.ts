import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { botsDir } from "../extensions/bots.ts";
import { parseCreatureFile } from "./file.ts";
import { creatureHost } from "./host.ts";
import {
  admitsSender,
  inboundPolicySchema,
  isSenderHandle,
  type MessageSender,
} from "./inbound.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-inbound-");

const at = new Date("2026-11-06T09:00:00.000Z");

const ada: MessageSender = { creature: "ada", node: "nLaptopCNTRL", machine: "laptop" };

describe("a creature's inbound policy", () => {
  it("admits paired senders, refuses everyone under nobody, and names the refusal in words", () => {
    expect(admitsSender("paired", "pip", ada)).toEqual({ admitted: true });
    expect(admitsSender("nobody", "pip", ada)).toEqual({
      admitted: false,
      reason: "pip takes messages from nobody",
    });
  });

  it("admits a named sender by slug alone, or pinned to its machine by name or StableID", () => {
    expect(admitsSender({ named: ["ada"] }, "pip", ada)).toEqual({ admitted: true });
    expect(admitsSender({ named: ["ada@laptop"] }, "pip", ada)).toEqual({ admitted: true });
    expect(admitsSender({ named: ["ada@nLaptopCNTRL"] }, "pip", ada)).toEqual({ admitted: true });
    expect(admitsSender({ named: ["mo", "ada@desk"] }, "pip", ada)).toEqual({
      admitted: false,
      reason: "pip takes messages only from mo, ada@desk, not from ada on laptop",
    });
  });

  it("takes only creature slugs, optionally with one machine, as named senders", () => {
    expect(isSenderHandle("ada")).toBe(true);
    expect(isSenderHandle("ada@laptop")).toBe(true);
    expect(isSenderHandle("Ada")).toBe(false);
    expect(isSenderHandle("ada@")).toBe(false);
    expect(isSenderHandle("ada@a@b")).toBe(false);
    expect(inboundPolicySchema.safeParse({ named: [] }).success).toBe(false);
    expect(inboundPolicySchema.safeParse("everyone").success).toBe(false);
    expect(inboundPolicySchema.safeParse({ named: ["ada"], grants: [] }).success).toBe(false);
  });

  it("is absent from a default creature's file, reads as paired, and is written only when the keeper sets it", async () => {
    const root = await scratch();
    const registry = new CreatureRegistry({
      root,
      trusted: true,
      keeper: "Jordan",
      now: () => at,
      seed: () => 7,
    });
    const host = creatureHost({ registry, sessions: new FakeCreatureSessions(() => at) });
    const file = join(root, botsDir, "pip", "creature.json");
    const created = await host.create({ name: "Pip" });
    expect(created.inbound).toBe("paired");
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("inbound");
    expect(await host.inbound("pip")).toBe("paired");

    const updated = await host.update("pip", { inbound: { named: ["ada@laptop"] } });
    expect(updated?.inbound).toEqual({ named: ["ada@laptop"] });
    expect(parseCreatureFile(await readFile(file, "utf8"), file).inbound).toEqual({
      named: ["ada@laptop"],
    });
    expect(await host.inbound("pip")).toEqual({ named: ["ada@laptop"] });
    expect(await host.inbound("nobody-here")).toBeUndefined();
  });
});
