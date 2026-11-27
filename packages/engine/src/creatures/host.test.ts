import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it, vi } from "vitest";
import { botsDir } from "../extensions/bots.ts";
import { minuteMs } from "../routines/clock.ts";
import { FakeClock } from "../routines/testing.ts";
import { type CreatureChanged, type CreatureHostSeams, creatureHost } from "./host.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-host-");

const at = new Date("2026-11-05T09:00:00.000Z");

async function fixture(seams: Partial<CreatureHostSeams> = {}) {
  const root = await scratch();
  const registry = new CreatureRegistry({
    root,
    trusted: true,
    keeper: "Jordan",
    now: () => at,
    seed: () => 7,
  });
  const sessions = new FakeCreatureSessions(() => at);
  const changes: CreatureChanged[] = [];
  const host = creatureHost({ registry, sessions, now: () => at, ...seams });
  host.subscribe((change) => changes.push(change));
  return { root, registry, sessions, host, changes };
}

describe("the creatures port", () => {
  it("creates from a draft and lists summaries with the conversation and thread count", async () => {
    const { host, changes } = await fixture();
    const created = await host.create({ name: "Pip", skin: "otter" });
    expect(created).toEqual({
      slug: "pip",
      name: "Pip",
      sigil: "P",
      created: at.toISOString(),
      skin: "otter",
      seed: 7,
      workshop: "host",
      models: { strong: "inherit", loop: "inherit", decide: "inherit", vision: "inherit" },
      conversation: null,
      threads: 0,
      paused: null,
      inbound: "paired",
      temperament: "brisk",
      range: ["calm", "brisk", "eager"],
      manner: "brisk",
    });
    await host.create({ name: "Mo" });
    await host.openThread("pip", "thread");
    await host.openThread("pip", "routine");
    const listed = await host.list();
    expect(
      listed.map((creature) => [creature.slug, creature.conversation, creature.threads]),
    ).toEqual([
      ["mo", null, 0],
      ["pip", null, 2],
    ]);
    expect(changes).toEqual([
      { slug: "pip", change: "created" },
      { slug: "mo", change: "created" },
      { slug: "pip", change: "threads" },
      { slug: "pip", change: "threads" },
    ]);
  });

  it("reports an unknown spend as null, never zero", async () => {
    const { host } = await fixture();
    await host.create({ name: "Pip" });
    expect((await host.read("pip"))?.usage).toEqual({
      date: "2026-11-05",
      sessions: 1,
      costNanos: null,
    });
  });

  it("lists what goes and what stays before removing, and keeps the workshop on request", async () => {
    const { root, host } = await fixture();
    await host.create({ name: "Pip", workshop: "ws-7" });
    const thread = await host.openThread("pip", "thread");
    const conversation = (await host.read("pip"))?.conversation;
    expect(await host.removal("pip")).toEqual({
      slug: "pip",
      goes: {
        definition: join(root, botsDir, "pip"),
        conversation,
        threads: [thread],
        notes: 0,
        routines: 0,
        workshop: "ws-7",
      },
      stays: { workspace: root, workshop: null },
    });
    expect((await host.removal("pip", { keepWorkshop: true }))?.goes.workshop).toBeNull();
    expect((await host.removal("pip", { keepWorkshop: true }))?.stays.workshop).toBe("ws-7");
    expect(await host.removal("ghost")).toBeUndefined();
  });

  it("removes threads first, the conversation last, then the definition, and announces", async () => {
    const { root, host, sessions, changes } = await fixture();
    await host.create({ name: "Pip" });
    const thread = await host.openThread("pip", "thread");
    const conversation = (await host.read("pip"))?.conversation ?? "";
    const removal = await host.remove("pip");
    expect(removal?.goes.threads).toEqual([thread]);
    expect(sessions.trashed).toEqual([thread, conversation]);
    expect(existsSync(join(root, botsDir, "pip"))).toBe(false);
    expect(await host.list()).toEqual([]);
    expect(changes.at(-1)).toEqual({ slug: "pip", change: "removed" });
    expect(await host.remove("pip")).toBeUndefined();
  });
});

describe("a creature's temperaments", () => {
  it("holds a manner it took on while it keeps working, and settles back to its favourite after a quiet half hour", async () => {
    const clock = new FakeClock(at.getTime());
    const { host, sessions, changes } = await fixture({ clock });
    await host.create({ name: "Pip" });
    const turn = sessions.add({ creature: "pip", kind: "conversation" }, { working: true });
    const minutes = (count: number) => at.getTime() + count * minuteMs;
    const mannerNow = async () => (await host.list())[0]?.manner;
    const passTo = (count: number) => clock.advanceTo(minutes(count), () => breathe());

    expect(await host.takeManner("pip", "eager")).toMatchObject({
      temperament: "brisk",
      range: ["calm", "brisk", "eager"],
      manner: "eager",
    });
    await passTo(45);
    expect(await mannerNow()).toBe("eager");

    turn.working = false;
    turn.lastActivityAt = new Date(minutes(50)).toISOString();
    await passTo(50);
    host.worked("pip");
    await breathe();
    await passTo(79);
    expect(await mannerNow()).toBe("eager");

    await passTo(81);
    await vi.waitFor(async () => expect(await mannerNow()).toBe("brisk"));
    expect(changes.filter(({ change }) => change === "updated")).toHaveLength(2);
    host.close();
  });
});

function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
