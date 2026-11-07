import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { botsDir } from "../extensions/bots.ts";
import type { RoutineView } from "../routines/service.ts";
import { type CreatureChanged, creatureHost } from "./host.ts";
import { type ChoreSwitchboard, type CreatureChores, choresOver, noChores } from "./pause.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-pause-");

const at = new Date("2026-11-06T09:00:00.000Z");

class FakeChores implements CreatureChores {
  readonly switches: string[] = [];

  constructor(readonly state: Map<string, boolean>) {}

  async enabled(): Promise<string[]> {
    return [...this.state].filter(([, enabled]) => enabled).map(([id]) => id);
  }

  async turn(_creature: string, id: string, enabled: boolean): Promise<boolean> {
    if (!this.state.has(id)) return false;
    this.state.set(id, enabled);
    this.switches.push(`${id} ${enabled ? "on" : "off"}`);
    return true;
  }
}

async function fixture() {
  const root = await scratch();
  const registry = new CreatureRegistry({ root, trusted: true, keeper: "Jordan", now: () => at });
  const changes: CreatureChanged[] = [];
  const host = creatureHost({
    registry,
    sessions: new FakeCreatureSessions(() => at),
    now: () => at,
  });
  host.subscribe((change) => changes.push(change));
  await host.create({ name: "Wren" });
  const file = async () =>
    JSON.parse(await readFile(join(root, botsDir, "wren", "creature.json"), "utf8"));
  return { host, changes, file };
}

describe("pausing a creature", () => {
  it("switches off its enabled chores, remembers which, and shows it paused", async () => {
    const { host, changes, file } = await fixture();
    const chores = new FakeChores(
      new Map([
        ["triage", true],
        ["digest", false],
        ["sweep", true],
      ]),
    );

    const paused = await host.pause("wren", chores);

    expect(paused).toEqual({
      slug: "wren",
      paused: true,
      since: at.toISOString(),
      chores: ["triage", "sweep"],
    });
    expect(await file()).toMatchObject({
      paused: { since: at.toISOString(), chores: ["triage", "sweep"] },
    });
    expect((await host.list())[0]?.paused).toBe(at.toISOString());
    expect(changes.at(-1)).toEqual({ slug: "wren", change: "paused" });
  });

  it("changes nothing when paused twice", async () => {
    const { host } = await fixture();
    const chores = new FakeChores(new Map([["triage", true]]));
    await host.pause("wren", chores);

    const again = await host.pause("wren", chores);

    expect(again?.chores).toEqual(["triage"]);
    expect(chores.switches).toEqual(["triage off"]);
  });

  it("resumes only the chores the pause switched off, skipping ones removed since", async () => {
    const { host, changes, file } = await fixture();
    const chores = new FakeChores(
      new Map([
        ["triage", true],
        ["digest", false],
        ["sweep", true],
      ]),
    );
    await host.pause("wren", chores);
    chores.state.delete("sweep");

    const resumed = await host.resume("wren", chores);

    expect(resumed).toEqual({ slug: "wren", paused: false, since: null, chores: ["triage"] });
    expect(chores.state).toEqual(
      new Map([
        ["triage", true],
        ["digest", false],
      ]),
    );
    expect(await file()).not.toHaveProperty("paused");
    expect(changes.at(-1)).toEqual({ slug: "wren", change: "resumed" });
  });

  it("resumes a running creature as a no-op and pauses without a chore service", async () => {
    const { host } = await fixture();

    expect(await host.resume("wren", noChores)).toEqual({
      slug: "wren",
      paused: false,
      since: null,
      chores: [],
    });
    expect(await host.pause("wren", noChores)).toMatchObject({ paused: true, chores: [] });
    expect(await host.pause("nobody", noChores)).toBeUndefined();
  });
});

describe("chores over the routine service", () => {
  it("lists enabled routines and switches one by putting it back with enabled flipped", async () => {
    const puts: Array<{ id: string; body: unknown }> = [];
    const triage = { id: "triage", title: "Morning triage", enabled: true };
    const views = [
      { id: "triage", routine: triage },
      { id: "digest", routine: { ...triage, id: "digest", enabled: false } },
      { id: "broken", routine: null },
    ] as unknown as RoutineView[];
    const switchboard: ChoreSwitchboard = {
      list: async () => views,
      read: async (_creature, id) => views.find((view) => view.id === id) ?? "missing-routine",
      put: async (_creature, id, body) => {
        puts.push({ id, body });
        return { routine: views[0] as RoutineView, created: false };
      },
    };
    const chores = choresOver(switchboard);

    expect(await chores.enabled("wren")).toEqual(["triage"]);
    expect(await chores.turn("wren", "triage", false)).toBe(true);
    expect(await chores.turn("wren", "broken", false)).toBe(false);
    expect(await chores.turn("wren", "gone", false)).toBe(false);
    expect(puts).toEqual([{ id: "triage", body: { ...triage, enabled: false } }]);
  });
});
