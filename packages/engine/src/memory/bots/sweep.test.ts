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
import { BotRegistry } from "./registry.ts";
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
