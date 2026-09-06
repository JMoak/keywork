import { type CurationJudgmentPort, Gardener, type SweepReport } from "../gardener.ts";
import type { BotRegistry } from "./registry.ts";

export const botSweepTokenBudget = 1024;

export type BotSweepSkip = "inert" | "no-layer" | "retired";

export type BotSweepReport =
  | { slug: string; swept: true; report: SweepReport }
  | { slug: string; swept: false; skipped: BotSweepSkip };

export interface BotSweepOptions {
  registry: BotRegistry;
  slug: string;
  judgment: CurationJudgmentPort;
  tokenBudget?: number;
}

export async function sweepBotLayer(options: BotSweepOptions): Promise<BotSweepReport> {
  const { registry, slug, judgment } = options;
  const skipped = await sweepSkip(registry, slug);
  if (skipped !== undefined) return { slug, swept: false, skipped };
  const gardener = new Gardener({ store: registry.botStore(slug), judgment, proposeOnly: true });
  const report = await gardener.sweep({
    entryTokenBudget: options.tokenBudget ?? botSweepTokenBudget,
  });
  return { slug, swept: true, report };
}

async function sweepSkip(registry: BotRegistry, slug: string): Promise<BotSweepSkip | undefined> {
  if (!registry.trusted) return "inert";
  const record = await registry.readBot(slug);
  if (record === undefined) return "no-layer";
  if (record.status === "retired") return "retired";
  return undefined;
}
