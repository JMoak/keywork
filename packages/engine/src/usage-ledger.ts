import { type Agent, addUsage } from "./agent.ts";
import { modelReferenceOf } from "./inference/adapters.ts";
import type { Usage } from "./messages.ts";
import { type CostRollup, carriesUsage, emptyCostRollup, mergeCostRollups } from "./pricing.ts";

export interface ModelTotals {
  usage: Usage;
  cost: CostRollup;
}

export interface ModelRow extends ModelTotals {
  reference: string;
}

export class UsageLedger {
  private readonly retired = new Map<string, ModelTotals>();

  retire(agent: Agent): void {
    const key = ledgerKey(agent);
    const carried = this.retired.get(key);
    this.retired.set(
      key,
      carried === undefined ? liveTotals(agent) : add(carried, liveTotals(agent)),
    );
  }

  rows(agent: Agent): ModelRow[] {
    const rows = new Map(this.retired);
    const key = ledgerKey(agent);
    const carried = rows.get(key);
    rows.set(key, carried === undefined ? liveTotals(agent) : add(carried, liveTotals(agent)));
    return [...rows]
      .filter(([, totals]) => carriesUsage(totals.usage) || totals.cost.unpricedTurns > 0)
      .map(([reference, totals]) => ({ reference, ...totals }));
  }

  totals(agent: Agent): ModelTotals {
    return this.rows(agent).reduce(add, emptyModelTotals());
  }
}

export function ledgerKey(agent: Agent): string {
  return modelReferenceOf(agent.provider) ?? agent.provider.name;
}

export function turnsOf(totals: ModelTotals): number {
  return totals.cost.pricedTurns + totals.cost.unpricedTurns;
}

function emptyModelTotals(): ModelTotals {
  return { usage: { inputTokens: 0, outputTokens: 0 }, cost: emptyCostRollup() };
}

function liveTotals(agent: Agent): ModelTotals {
  return { usage: agent.usage(), cost: agent.cost() };
}

function add(left: ModelTotals, right: ModelTotals): ModelTotals {
  return {
    usage: addUsage(left.usage, right.usage),
    cost: mergeCostRollups(left.cost, right.cost),
  };
}
