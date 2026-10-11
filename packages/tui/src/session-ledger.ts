import {
  type Agent,
  type CacheMiss,
  type ContextReading,
  type CostRollup,
  carriesUsage,
  contextBudgetFor,
  costBasis,
  declaredContextWindow,
  type EffortLevel,
  estimateConversationTokens,
  formatCostNanos,
  formatTokenCount,
  knownCostNanos,
  type ModelRow,
  type ModelTotals,
  readContext,
  turnsOf,
  type Usage,
  UsageLedger,
} from "@keywork/engine";
import { contextReadout } from "./context-gauge.ts";

export class SessionLedger {
  sessionId: string | undefined;
  arc: string | undefined;
  bot: string | undefined;
  private readonly ledger = new UsageLedger();
  private context: { agent: Agent; messages: number; reading: ContextReading } | undefined;

  retire(agent: Agent): void {
    this.ledger.retire(agent);
  }

  usageSummary(agent: Agent | undefined): string {
    if (agent === undefined) return "";
    const miss = agent.cacheMiss();
    return [this.spendSummary(agent), ...(miss === undefined ? [] : [cacheMissNote(miss)])]
      .filter((part) => part !== "")
      .join(" · ");
  }

  costReport(agent: Agent | undefined): string {
    if (agent === undefined) return "no provider · nothing to meter";
    const { usage, cost } = this.sessionTotals(agent);
    if (!carriesUsage(usage) && cost.unpricedTurns === 0) {
      return "no usage yet · send a prompt first";
    }
    const rows = this.ledger.rows(agent);
    const perModel = rows.length < 2 ? [] : rows.map(modelLine);
    const miss = agent.cacheMiss();
    return [
      tokenLine(usage),
      costLine(cost, agent.modelId(), agent.effort()),
      ...(miss === undefined ? [] : [cacheMissLine(miss)]),
      ...perModel,
    ].join("\n");
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

  spendSummary(agent: Agent): string {
    const { usage, cost } = this.sessionTotals(agent);
    const known = knownCostNanos(cost);
    if (known !== undefined) return formatCostNanos(known);
    return usage.inputTokens + usage.outputTokens === 0
      ? ""
      : `${usage.inputTokens}▸${usage.outputTokens}`;
  }

  private sessionTotals(agent: Agent): ModelTotals {
    return this.ledger.totals(agent);
  }
}

function tokenLine(usage: Usage): string {
  const parts = [`tokens ${usage.inputTokens}▸${usage.outputTokens}`];
  const read = usage.cacheReadInputTokens ?? 0;
  const written = usage.cacheCreationInputTokens ?? 0;
  if (read > 0) parts.push(`cache read ${read}`);
  if (written > 0) parts.push(`cache write ${written}`);
  return parts.join(" · ");
}

function costLine(
  cost: CostRollup,
  modelId: string | undefined,
  effort: EffortLevel | undefined,
): string {
  const line = spendLine(cost, modelId);
  return effort === undefined ? line : `${line} · effort ${effort}`;
}

function spendLine(cost: CostRollup, modelId: string | undefined): string {
  const known = knownCostNanos(cost);
  if (known !== undefined) return `cost ${formatCostNanos(known)} · ${costBasis(cost, modelId)}`;
  if (cost.pricedTurns > 0) {
    return `cost ${formatCostNanos(cost.nanos)} across ${cost.pricedTurns} priced turns · ${cost.unpricedTurns} more had no pricing`;
  }
  return `cost unknown · no pricing for ${modelId ?? "this model"}`;
}

function modelLine({ reference, ...totals }: ModelRow): string {
  const known = knownCostNanos(totals.cost);
  const turns = turnsOf(totals);
  const spend =
    known !== undefined
      ? formatCostNanos(known)
      : totals.cost.pricedTurns > 0
        ? `${formatCostNanos(totals.cost.nanos)} + ${totals.cost.unpricedTurns} unpriced`
        : "no pricing";
  return `  ${reference} · ${turns} ${turns === 1 ? "turn" : "turns"} · ${totals.usage.inputTokens}▸${totals.usage.outputTokens} · ${spend}`;
}

function cacheMissNote(miss: CacheMiss): string {
  return `cache missed: ${miss.cause}`;
}

function cacheMissLine(miss: CacheMiss): string {
  const tokens = miss.missedTokens;
  return tokens === undefined
    ? cacheMissNote(miss)
    : `${cacheMissNote(miss)} · about ${formatTokenCount(tokens)} tokens past the change`;
}
