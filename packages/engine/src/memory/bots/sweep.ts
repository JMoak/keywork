import {
  type CurationJudgmentPort,
  Gardener,
  type SkillEvidence,
  type SweepReport,
} from "../gardener.ts";
import type { BotRegistry } from "./registry.ts";
import { proposeSkillGenesis, type SkillGenesisReport } from "./skill-genesis.ts";

export const botSweepTokenBudget = 1024;

export type BotSweepSkip = "inert" | "no-layer" | "retired";

export type BotSweepReport =
  | { slug: string; swept: true; report: SweepReport; genesis: SkillGenesisReport }
  | { slug: string; swept: false; skipped: BotSweepSkip };

export interface BotSweepOptions {
  registry: BotRegistry;
  slug: string;
  judgment: CurationJudgmentPort;
  tokenBudget?: number;
  skills?: SkillEvidence;
}

export async function sweepBotLayer(options: BotSweepOptions): Promise<BotSweepReport> {
  const { registry, slug, judgment, skills } = options;
  const skipped = await sweepSkip(registry, slug);
  if (skipped !== undefined) return { slug, swept: false, skipped };
  const store = registry.botStore(slug);
  const genesis =
    skills === undefined ? { proposed: [], remembered: [] } : await proposeSkillGenesis(store);
  const gardener = new Gardener({ store, judgment, proposeOnly: true });
  const report = await gardener.sweep({
    entryTokenBudget: options.tokenBudget ?? botSweepTokenBudget,
    ...(skills !== undefined && { skills }),
  });
  return { slug, swept: true, report, genesis };
}

async function sweepSkip(registry: BotRegistry, slug: string): Promise<BotSweepSkip | undefined> {
  if (!registry.trusted) return "inert";
  const record = await registry.readBot(slug);
  if (record === undefined) return "no-layer";
  if (record.status === "retired") return "retired";
  return undefined;
}
