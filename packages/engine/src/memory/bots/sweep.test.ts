import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type CurationJudgmentPort,
  type DailyEntryCandidate,
  entryTokens,
  type PromotionProposal,
} from "../gardener.ts";
import { BotRegistry, botGenesisFile } from "./registry.ts";
import { botSweepTokenBudget, sweepBotLayer } from "./sweep.ts";

const scratch = scratchDirs("keywork-bot-sweep-");
const clock = () => new Date("2026-09-06T09:00:00.000Z");
const today = "2026-09-06";

async function fixture(trusted = true): Promise<{ registry: BotRegistry; root: string }> {
  const root = await scratch();
  return { registry: new BotRegistry({ vaultRoot: root, trusted, now: clock }), root };
}

function judgment(promotions: PromotionProposal[] = []): CurationJudgmentPort & {
  seen: DailyEntryCandidate[][];
} {
  const seen: DailyEntryCandidate[][] = [];
  return {
    id: "fake:bot-sweep",
    seen,
    async proposePromotions(entries) {
      seen.push(entries);
      return promotions;
    },
    async classifyPair() {
      return { relation: "distinct", confidence: 1 };
    },
  };
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await walk("");
  return files;

  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else files.set(child, await readFile(join(root, child), "utf8"));
    }
  }
}

describe("sweepBotLayer", () => {
  it("promotes daily craft into the bot's own inbox as proposals, never as notes", async () => {
    const { registry, root } = await fixture();
    await registry.materialize("reviewer");
    const store = registry.botStore("reviewer");
    await store.appendDaily("Jordan wants review comments short", "agent");
    const port = judgment([
      { entryId: `${today}#0`, title: "Terse Reviews", body: "short comments\n", confidence: 0.97 },
    ]);
    const outcome = await sweepBotLayer({ registry, slug: "reviewer", judgment: port });
    expect(outcome).toMatchObject({ slug: "reviewer", swept: true });
    if (!outcome.swept) return;
    expect(outcome.report.promoted).toEqual([]);
    expect(outcome.report.flagged).toEqual(["promotion:terse reviews"]);
    expect(await store.readNote("Terse Reviews")).toBeUndefined();
    const staged = await store.listStaged();
    expect(staged.map((item) => item.kind)).toEqual(["borderline-promotion"]);
    const files = [...(await snapshot(root)).keys()];
    expect(files.every((path) => path.startsWith("bots/reviewer/"))).toBe(true);
    await store.approve(staged[0]?.id ?? "");
    expect((await store.readNote("Terse Reviews"))?.learnedBy).toBe("reviewer");
  });

  it("pins the sweep cost: the judgment sees at most the budget in entry tokens", async () => {
    expect(botSweepTokenBudget).toBe(1024);
    const { registry } = await fixture();
    await registry.materialize("reviewer");
    const store = registry.botStore("reviewer");
    for (let index = 0; index < 12; index += 1) {
      await store.appendDaily(`${index}:${"craft ".repeat(100)}`, "agent");
    }
    const port = judgment();
    await sweepBotLayer({ registry, slug: "reviewer", judgment: port });
    const seen = port.seen[0] ?? [];
    const spent = seen.reduce((sum, entry) => sum + entryTokens(entry), 0);
    expect(spent).toBeLessThanOrEqual(botSweepTokenBudget);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(12);
    expect(seen.at(-1)?.id).toBe(`${today}#11`);
  });

  it("writes nothing for a bot with no layer, a retired one, or an untrusted vault", async () => {
    const { registry, root } = await fixture();
    const port = judgment([{ entryId: `${today}#0`, title: "Sneaky", body: "x\n", confidence: 1 }]);
    expect(await sweepBotLayer({ registry, slug: "ghost", judgment: port })).toEqual({
      slug: "ghost",
      swept: false,
      skipped: "no-layer",
    });
    expect(await readdir(root)).toEqual([]);
    await registry.materialize("old");
    await registry.retireBot("old");
    const before = await snapshot(root);
    expect(await sweepBotLayer({ registry, slug: "old", judgment: port })).toMatchObject({
      swept: false,
      skipped: "retired",
    });
    expect(await snapshot(root)).toEqual(before);
    const untrusted = new BotRegistry({ vaultRoot: root, trusted: false, now: clock });
    expect(await sweepBotLayer({ registry: untrusted, slug: "old", judgment: port })).toMatchObject(
      { swept: false, skipped: "inert" },
    );
    expect(port.seen).toEqual([]);
  });
});

describe("sweepBotLayer at the skills level", () => {
  const release = "shipped: `bun run check` then `bun run test` then `git tag v1`";
  const noSkills = { skills: [], telemetry: {} };

  async function reviewerWith(lines: readonly string[]) {
    const { registry, root } = await fixture();
    await registry.materialize("reviewer");
    const store = registry.botStore("reviewer");
    for (const line of lines) await store.appendDaily(line, "agent");
    return { registry, root, store };
  }

  function sweep(registry: BotRegistry, slug: string, port = judgment()) {
    return sweepBotLayer({ registry, slug, judgment: port, skills: noSkills });
  }

  it("proposes a skill once a command sequence recurs, then never again for that fingerprint", async () => {
    const { registry, store } = await reviewerWith([release]);
    const first = await sweep(registry, "reviewer");
    expect(first.swept && first.genesis).toEqual({ proposed: [], remembered: [] });
    expect(await store.listStaged()).toEqual([]);
    await store.appendDaily(`again: ${release}`, "agent");
    const second = await sweep(registry, "reviewer");
    const fingerprint = second.swept ? second.genesis.proposed[0] : undefined;
    expect(fingerprint).toBeDefined();
    const staged = await store.listStaged();
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      kind: "skill-proposal",
      name: "bun-run-check",
      commands: "bun run check\nbun run test\ngit tag v1",
      occurrences: 2,
      key: `skill-proposal:${fingerprint}`,
    });
    expect(await store.readReserved(botGenesisFile)).toContain(fingerprint);
    await store.discard(staged[0]?.id ?? "");
    await store.appendDaily(`third time: ${release}`, "agent");
    const third = await sweep(registry, "reviewer");
    expect(third.swept && third.genesis.proposed).toEqual([]);
    expect(await store.listStaged()).toEqual([]);
    const events = (await store.readAudit()).map((entry) => entry.event);
    expect(events.filter((event) => event === "skill genesis: proposed 1")).toHaveLength(1);
  });

  it("keeps genesis per bot: a second bot with the same routine gets its own single proposal", async () => {
    const { registry } = await reviewerWith([release, release]);
    await registry.materialize("scout");
    const scout = registry.botStore("scout");
    await scout.appendDaily(release, "agent");
    await scout.appendDaily(release, "agent");
    for (const slug of ["reviewer", "scout"]) {
      const outcome = await sweep(registry, slug);
      expect(outcome.swept && outcome.genesis.proposed).toHaveLength(1);
      expect(await registry.botStore(slug).listStaged()).toHaveLength(1);
    }
  });

  it("stays silent at the notes level and stays under the judgment cap with genesis on", async () => {
    const { registry, store } = await reviewerWith([release, release]);
    const notes = await sweepBotLayer({ registry, slug: "reviewer", judgment: judgment() });
    expect(notes.swept && notes.genesis).toEqual({ proposed: [], remembered: [] });
    expect(await store.listStaged()).toEqual([]);
    const routine = "`bun run check` then `bun run test` ";
    for (let index = 0; index < 12; index += 1) {
      await store.appendDaily(`${index}: ${routine}${"craft ".repeat(100)}`, "agent");
    }
    const port = judgment();
    await sweep(registry, "reviewer", port);
    const seen = port.seen[0] ?? [];
    expect(seen.reduce((sum, entry) => sum + entryTokens(entry), 0)).toBeLessThanOrEqual(
      botSweepTokenBudget,
    );
    expect(port.seen).toHaveLength(1);
  });

  it("routes telemetry-informed skill reviews into the bot's inbox with the counts cited", async () => {
    const { registry, store } = await reviewerWith([]);
    const outcome = await sweepBotLayer({
      registry,
      slug: "reviewer",
      judgment: judgment(),
      skills: {
        skills: [{ name: "release-tag", authoredBy: "keywork/reviewer" }],
        telemetry: {
          "release-tag": {
            counts: { use: 3, view: 0, reference: 0, patch: 2, rewrite: 1, create: 1 },
            lastActivityAt: "2026-09-01T00:00:00.000Z",
          },
        },
      },
    });
    expect(outcome.swept && outcome.report.flagged).toEqual(["skill-review:release-tag"]);
    expect(await store.listStaged()).toEqual([
      expect.objectContaining({
        kind: "skill-review",
        reason: "churning",
        uses: 3,
        patches: 2,
        rewrites: 1,
      }),
    ]);
  });
});
