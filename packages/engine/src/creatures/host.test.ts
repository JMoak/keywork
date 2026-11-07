import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { botsDir } from "../extensions/bots.ts";
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

  it("opens the conversation on the first read, announces it once, and paints the detail", async () => {
    const nextRun = { routineId: "triage", at: "2026-11-06T09:00:00.000Z" };
    const { host, sessions, changes } = await fixture({
      nextRun: async (slug) => (slug === "pip" ? nextRun : undefined),
      spentToday: async () => 1_500_000_000,
    });
    await host.create({ name: "Pip" });
    const thread = await host.openThread("pip", "thread");
    sessions.add({ creature: "pip", kind: "child" }, { parent: thread });
    const first = await host.read("pip");
    const second = await host.read("pip");
    expect(first?.conversation).toBe("s3");
    expect(second?.conversation).toBe("s3");
    expect(sessions.opened.filter((tag) => tag.kind === "conversation")).toHaveLength(1);
    expect(first).toMatchObject({
      slug: "pip",
      introduction: expect.stringContaining("You are Pip, Jordan's creature"),
      threads: [{ id: thread, kind: "thread", state: "back", children: 1 }],
      nextRun,
      usage: { date: "2026-11-05", sessions: 3, costNanos: 1_500_000_000 },
      routines: "routines",
    });
    expect(changes.filter((change) => change.change === "conversation")).toEqual([
      { slug: "pip", change: "conversation" },
    ]);
    expect(await host.read("ghost")).toBeUndefined();
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

  it("lands a finished thread in the conversation and announces threads", async () => {
    const { host, sessions, changes } = await fixture();
    await host.create({ name: "Pip" });
    const thread = await host.openThread("pip", "routine");
    const outcome = await host.finish("pip", thread, {
      title: "triage",
      outcome: "completed",
      summary: "nothing needs you",
    });
    expect(outcome).toBe("noted");
    const conversation = await host.threads.conversationOf("pip");
    expect(sessions.transcripts.get(conversation ?? "")).toEqual([
      'Thread "triage" finished: nothing needs you',
    ]);
    expect(changes.at(-1)).toEqual({ slug: "pip", change: "threads" });
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
