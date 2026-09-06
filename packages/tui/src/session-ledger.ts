import {
  type Agent,
  addUsage,
  type ContextReading,
  type CostRollup,
  carriesUsage,
  contextBudgetFor,
  declaredContextWindow,
  emptyCostRollup,
  estimateConversationTokens,
  formatCostNanos,
  knownCostNanos,
  mergeCostRollups,
  modelReferenceOf,
  readContext,
  type Usage,
} from "@keywork/engine";
import { contextReadout } from "./context-gauge.ts";

export class SessionLedger {
  sessionId: string | undefined;
  arc: string | undefined;
  bot: string | undefined;
  private readonly retired = new Map<string, ModelTotals>();
  private context: { agent: Agent; messages: number; reading: ContextReading } | undefined;

  retire(agent: Agent): void {
    const key = ledgerKey(agent);
    const carried = this.retired.get(key);
    this.retired.set(
      key,
      carried === undefined ? liveTotals(agent) : add(carried, liveTotals(agent)),
    );
  }

  usageSummary(agent: Agent | undefined): string {
    if (agent === undefined) return "";
    const { usage, cost } = this.sessionTotals(agent);
    const known = knownCostNanos(cost);
    if (known !== undefined) return formatCostNanos(known);
    return usage.inputTokens + usage.outputTokens === 0
      ? ""
      : `${usage.inputTokens}▸${usage.outputTokens}`;
  }

  costReport(agent: Agent | undefined): string {
    if (agent === undefined) return "no provider · nothing to meter";
    const { usage, cost } = this.sessionTotals(agent);
    if (!carriesUsage(usage) && cost.unpricedTurns === 0) {
      return "no usage yet · send a prompt first";
    }
    const rows = this.rows(agent);
    const perModel =
      rows.length < 2 ? [] : rows.map(([reference, totals]) => modelLine(reference, totals));
    return [tokenLine(usage), costLine(cost, agent.modelId()), ...perModel].join("\n");
  }

  contextReading(agent: Agent | undefined): ContextReading | undefined {
    if (agent === undefined) return undefined;
    const messages = agent.history().length;
    if (this.context?.agent === agent && this.context.messages === messages) {
      return this.context.reading;
    }
    const reading = readContext(
      estimateConversationTokens(agent.history()),
      contextBudgetFor(declaredContextWindow(agent.provider)),
    );
    this.context = { agent, messages, reading };
    return reading;
  }

  contextReport(agent: Agent | undefined): string {
    const reading = this.contextReading(agent);
    if (reading === undefined) return "no provider · nothing to measure";
    return contextReadout(reading).join("\n");
  }

  private sessionTotals(agent: Agent): ModelTotals {
    return this.rows(agent)
      .map(([, totals]) => totals)
      .reduce(add, { usage: { inputTokens: 0, outputTokens: 0 }, cost: emptyCostRollup() });
  }

  private rows(agent: Agent): [string, ModelTotals][] {
    const rows = new Map(this.retired);
    const key = ledgerKey(agent);
    const carried = rows.get(key);
    rows.set(key, carried === undefined ? liveTotals(agent) : add(carried, liveTotals(agent)));
    return [...rows].filter(
      ([, totals]) => carriesUsage(totals.usage) || totals.cost.unpricedTurns > 0,
    );
  }
}

interface ModelTotals {
  usage: Usage;
  cost: CostRollup;
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

function ledgerKey(agent: Agent): string {
  return modelReferenceOf(agent.provider) ?? agent.provider.name;
}

function tokenLine(usage: Usage): string {
  const parts = [`tokens ${usage.inputTokens}▸${usage.outputTokens}`];
  const read = usage.cacheReadInputTokens ?? 0;
  const written = usage.cacheCreationInputTokens ?? 0;
  if (read > 0) parts.push(`cache read ${read}`);
  if (written > 0) parts.push(`cache write ${written}`);
  return parts.join(" · ");
}

function costLine(cost: CostRollup, modelId: string | undefined): string {
  const known = knownCostNanos(cost);
  if (known !== undefined) return `cost ${formatCostNanos(known)} · ${costBasis(cost, modelId)}`;
  if (cost.pricedTurns > 0) {
    return `cost ${formatCostNanos(cost.nanos)} across ${cost.pricedTurns} priced turns · ${cost.unpricedTurns} more had no pricing`;
  }
  return `cost unknown · no pricing for ${modelId ?? "this model"}`;
}

function costBasis(cost: CostRollup, modelId: string | undefined): string {
  if (cost.meteredTurns === cost.pricedTurns) return "metered by the provider";
  if (cost.meteredTurns > 0) return "partly metered, partly estimated";
  return `estimated from ${modelId ?? "list"} rates`;
}

function modelLine(reference: string, totals: ModelTotals): string {
  const known = knownCostNanos(totals.cost);
  const turns = totals.cost.pricedTurns + totals.cost.unpricedTurns;
  const spend =
    known !== undefined
      ? formatCostNanos(known)
      : totals.cost.pricedTurns > 0
        ? `${formatCostNanos(totals.cost.nanos)} + ${totals.cost.unpricedTurns} unpriced`
        : "no pricing";
  return `  ${reference} · ${turns} ${turns === 1 ? "turn" : "turns"} · ${totals.usage.inputTokens}▸${totals.usage.outputTokens} · ${spend}`;
}
