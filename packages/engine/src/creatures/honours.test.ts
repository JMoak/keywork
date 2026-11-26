import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { creatureHonours, type HonourChange, honoursFileIn } from "./honours.ts";
import type { CreatureChanged } from "./host.ts";

const scratch = scratchDirs("keywork-creature-honours-");

const started = Date.parse("2026-11-24T10:00:00.000Z");

describe("the book of honours", () => {
  it("never takes back or fires again what was earned, and a removed creature takes only its own", async () => {
    const file = honoursFileIn(await scratch());
    const lark = { slug: "lark", created: "2026-11-20T08:00:00.000Z" };
    const stead = openedAt(file, [lark]);
    const lark10 = (from: number) => ({ creature: "lark", conversation: `c${from}` });
    const minute = (count: number) => new Date(started + count * 60_000).toISOString();

    for (let count = 1; count <= 10; count += 1) stead.honours.began(lark10(count), minute(count));
    const earned = await stead.honours.list();
    for (let count = 1; count <= 10; count += 1) stead.honours.began(lark10(count), minute(count));
    for (let count = 11; count <= 15; count += 1) stead.honours.began(lark10(count), minute(count));
    stead.honours.visited("9c1d2e3f4a5b", [
      { creature: "lark", conversations: [], night: null, tools: {}, days: [] },
    ]);

    expect(earned).toEqual([
      expect.objectContaining({ holder: null, kind: "first-creature", earnedAt: lark.created }),
      {
        holder: "lark",
        kind: "conversations",
        tier: 1,
        with: null,
        earnedAt: minute(10),
        proof: `Ten conversations; the tenth began on 24 November 2026.`,
      },
    ]);
    expect(await stead.honours.list()).toEqual(earned);
    expect(stead.changes).toEqual([{ change: "earned", honour: earned[1] }]);
    stead.honours.close();

    const reopened = openedAt(file, [lark]);
    expect(await reopened.honours.list()).toEqual(earned);
    reopened.remove("lark");
    expect(await reopened.honours.list()).toEqual([earned[0]]);
    expect(reopened.changes).toEqual([{ change: "dropped", honour: earned[1] }]);
    reopened.honours.close();
  });
});

function openedAt(file: string, standing: { slug: string; created: string }[]) {
  const listeners = new Set<(change: CreatureChanged) => void>();
  const changes: HonourChange[] = [];
  let creatures = [...standing];
  const honours = creatureHonours({
    file,
    creatures: {
      list: async () => creatures.map(summaryOf),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    history: async () => ({ conversations: [] }),
    notice: (line) => {
      throw new Error(line);
    },
    now: () => new Date(started),
  });
  honours.subscribe((change) => changes.push(change));
  return {
    honours,
    changes,
    remove: (slug: string) => {
      creatures = creatures.filter((creature) => creature.slug !== slug);
      for (const listener of listeners) listener({ slug, change: "removed" });
    },
  };
}

function summaryOf({ slug, created }: { slug: string; created: string }) {
  return {
    slug,
    name: slug,
    sigil: slug.slice(0, 1).toUpperCase(),
    created,
    skin: "otter",
    seed: 7,
    workshop: "host",
    models: { strong: "inherit", loop: "inherit", decide: "inherit", vision: "inherit" } as const,
    conversation: null,
    threads: 0,
    paused: null,
    inbound: "paired" as const,
    temperament: "brisk" as const,
  };
}
