import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { hostSubstrate } from "../workshop/host.ts";
import { sbxSubstrate } from "../workshop/sbx.ts";
import { fakeSbx, refusingSandboxHost } from "../workshop/testing.ts";
import { Workshops } from "../workshop/workshops.ts";
import { creatureHost } from "./host.ts";
import { raiseCreature } from "./raise.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-raise-");

async function fixture(sbx = fakeSbx()) {
  const stateDir = await scratch();
  const registry = new CreatureRegistry({ root: await scratch(), trusted: true, keeper: "Jordan" });
  const creatures = creatureHost({ registry, sessions: new FakeCreatureSessions() });
  const workshops = new Workshops({
    stateDir,
    substrates: {
      host: hostSubstrate({ stateDir, sandboxHost: refusingSandboxHost }),
      sbx: sbxSubstrate({ run: sbx.run, stateDir, pause: async () => undefined }),
    },
  });
  return { creatures, workshops, registry };
}

describe("raising a creature on a substrate", () => {
  it("raises its workshop first, records the workshop id in creature.json, and leaves it running", async () => {
    const { creatures, workshops, registry } = await fixture();

    const created = await raiseCreature(creatures, workshops, { name: "Wren" }, "sbx");

    const [workshop] = await workshops.list();
    expect(workshop).toMatchObject({ creature: "wren", substrate: "sbx", state: "running" });
    expect(created).toMatchObject({ slug: "wren", workshop: workshop?.id });
    expect((await registry.read("wren"))?.file.workshop).toBe(workshop?.id);
  });

  it("leaves a bare host workshop running before the creature's first turn", async () => {
    const { creatures, workshops } = await fixture();

    await raiseCreature(creatures, workshops, { name: "Osk" }, "host");

    expect((await workshops.list())[0]?.state).toBe("running");
  });

  it("keeps the creature made when its workshop will not start, so its first tool call can try again", async () => {
    const refusingStart = fakeSbx({
      refuse: (args) => (args[0] === "start" ? "the microVM would not boot" : undefined),
    });
    const { creatures, workshops } = await fixture(refusingStart);

    const created = await raiseCreature(creatures, workshops, { name: "Wren" }, "sbx");

    const [workshop] = await workshops.list();
    expect(created).toMatchObject({ slug: "wren", workshop: workshop?.id });
    expect(workshop?.state).toBe("stopped");
  });

  it("refuses a substrate this node cannot run and writes no creature", async () => {
    const { creatures, workshops } = await fixture(fakeSbx({ version: "0.44.0" }));

    const refused = await raiseCreature(creatures, workshops, { name: "Wren" }, "sbx");

    expect(refused).toMatchObject({ refused: "unavailable" });
    expect(await creatures.list()).toEqual([]);
    expect(await workshops.list()).toEqual([]);
  });

  it("refuses a name that is taken before raising anything", async () => {
    const { creatures, workshops } = await fixture();
    await creatures.create({ name: "Wren" });

    const refused = await raiseCreature(creatures, workshops, { name: "Wren" }, "host");

    expect(refused).toMatchObject({ refused: "conflict" });
    expect(await workshops.list()).toEqual([]);
  });

  it("removes the raised workshop again when the creature cannot be written", async () => {
    const { workshops } = await fixture();
    const failing = {
      list: async () => [],
      create: async () => {
        throw new Error("creatures need a trusted workspace · keywork trust");
      },
    };

    await expect(raiseCreature(failing, workshops, { name: "Wren" }, "host")).rejects.toThrow(
      "trusted workspace",
    );
    expect(await workshops.list()).toEqual([]);
  });
});
