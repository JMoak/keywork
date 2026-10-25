import {
  type Agent,
  addUsage,
  type CostRollup,
  emptyCostRollup,
  formatReference,
  knownCostNanos,
  mergeCostRollups,
  modelReferenceOf,
  type Provider,
  type SessionEntry,
  type Usage,
  withTurnCost,
} from "@keywork/engine";
import type { CostReport, ModelSpend } from "@keywork/server";

export class SpendLedger {
  private readonly retired: Map<string, ModelTotals>;

  constructor(logged: ReadonlyMap<string, ModelTotals> = new Map()) {
    this.retired = new Map(logged);
  }

  static fromLog(entries: readonly SessionEntry[], startedOn: Provider): SpendLedger {
    return new SpendLedger(spendInLog(entries, startedOn));
  }

  retire(agent: Agent): void {
    const key = spendKeyOf(agent.provider);
    this.retired.set(key, addTotals(this.retired.get(key), totalsOf(agent)));
  }

  report(agent: Agent): CostReport {
    const rows = new Map(this.retired);
    const key = spendKeyOf(agent.provider);
    rows.set(key, addTotals(rows.get(key), totalsOf(agent)));
    const models: ModelSpend[] = [...rows]
      .map(([reference, totals]) => ({ reference, turns: turnsOf(totals.rollup), ...totals }))
      .filter((model) => model.turns > 0);
    const total = models.reduce<ModelTotals | undefined>(addTotals, undefined) ?? totalsOf(agent);
    const modelId = agent.modelId();
    const cacheMiss = agent.cacheMiss();
    return {
      rollup: total.rollup,
      usage: total.usage,
      ...(modelId !== undefined && { modelId }),
      ...(cacheMiss !== undefined && { cacheMiss }),
      models,
    };
  }
}

export interface ModelTotals {
  usage: Usage;
  rollup: CostRollup;
}

export function spendInLog(
  entries: readonly SessionEntry[],
  startedOn: Provider,
): Map<string, ModelTotals> {
  const spent = new Map<string, ModelTotals>();
  let reference = spendKeyOf(startedOn);
  let modelId = startedOn.modelId;
  for (const entry of entries) {
    if (entry.type === "model_change") {
      reference = formatReference({ provider: entry.provider, model: entry.modelId });
      modelId = entry.modelId;
    } else if (entry.type === "message" && entry.usage !== undefined) {
      const turn = {
        usage: entry.usage,
        rollup: withTurnCost(emptyCostRollup(), entry.usage, modelId),
      };
      spent.set(reference, addTotals(spent.get(reference), turn));
    }
  }
  return spent;
}

export function loggedCostNanos(
  entries: readonly SessionEntry[],
  startedOn: Provider,
): number | undefined {
  const rollups = [...spendInLog(entries, startedOn).values()].map((totals) => totals.rollup);
  return knownCostNanos(rollups.reduce(mergeCostRollups, emptyCostRollup()));
}

function totalsOf(agent: Agent): ModelTotals {
  return { usage: agent.usage(), rollup: agent.cost() };
}

function turnsOf(rollup: CostRollup): number {
  return rollup.pricedTurns + rollup.unpricedTurns;
}

function addTotals(left: ModelTotals | undefined, right: ModelTotals): ModelTotals {
  if (left === undefined) return right;
  return {
    usage: addUsage(left.usage, right.usage),
    rollup: mergeCostRollups(left.rollup, right.rollup),
  };
}

function spendKeyOf(provider: Provider): string {
  return modelReferenceOf(provider) ?? provider.name;
}
