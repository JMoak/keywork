import {
  type Agent,
  compactionDue,
  contextBudgetFor,
  contextFullness,
  costBasis,
  declaredContextWindow,
  estimateConversationTokens,
  flushDue,
  readContext,
  turnsOf,
  type UsageLedger,
} from "@keywork/engine";
import type { ContextReport, CostReport } from "./host.ts";

export function contextReportOf(agent: Agent): ContextReport {
  const reading = readContext(
    estimateConversationTokens(agent.history()),
    contextBudgetFor(declaredContextWindow(agent.provider)),
  );
  return {
    ...reading,
    fullness: contextFullness(reading),
    flushDue: flushDue(reading),
    compactionDue: compactionDue(reading),
    basis: "estimated",
  };
}

export function costReportOf(agent: Agent, ledger: UsageLedger): CostReport {
  const { usage, cost } = ledger.totals(agent);
  const cacheMiss = agent.cacheMiss();
  return {
    rollup: cost,
    usage,
    basis: costBasis(cost, agent.modelId()),
    ...(cacheMiss !== undefined && { cacheMiss }),
    models: ledger.rows(agent).map((row) => ({
      reference: row.reference,
      turns: turnsOf(row),
      usage: row.usage,
      rollup: row.cost,
    })),
  };
}
