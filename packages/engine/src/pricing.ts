import type { Usage } from "./messages.ts";
import type { SessionEntry } from "./session/entries.ts";

export interface ModelRates {
  inputNanosPerToken: number;
  outputNanosPerToken: number;
  cacheReadNanosPerToken: number;
  cacheWriteNanosPerToken: number;
}

export interface CostRollup {
  nanos: number;
  pricedTurns: number;
  meteredTurns: number;
  unpricedTurns: number;
}

export function emptyCostRollup(): CostRollup {
  return { nanos: 0, pricedTurns: 0, meteredTurns: 0, unpricedTurns: 0 };
}

export function ratesFor(modelId: string): ModelRates | undefined {
  return rateTable.get(canonicalModelId(modelId));
}

export function costNanosOf(usage: Usage, modelId: string | undefined): number | undefined {
  if (usage.costUsd !== undefined) return Math.round(usage.costUsd * nanosPerDollar);
  const rates = modelId === undefined ? undefined : ratesFor(modelId);
  if (rates === undefined) return undefined;
  return (
    usage.inputTokens * rates.inputNanosPerToken +
    usage.outputTokens * rates.outputNanosPerToken +
    (usage.cacheReadInputTokens ?? 0) * rates.cacheReadNanosPerToken +
    (usage.cacheCreationInputTokens ?? 0) * rates.cacheWriteNanosPerToken
  );
}

export function carriesUsage(usage: Usage): boolean {
  return (
    usage.costUsd !== undefined ||
    usage.inputTokens +
      usage.outputTokens +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0) >
      0
  );
}

export function withTurnCost(
  rollup: CostRollup,
  usage: Usage,
  modelId: string | undefined,
): CostRollup {
  if (!carriesUsage(usage)) return rollup;
  const nanos = costNanosOf(usage, modelId);
  if (nanos === undefined) return { ...rollup, unpricedTurns: rollup.unpricedTurns + 1 };
  return {
    nanos: rollup.nanos + nanos,
    pricedTurns: rollup.pricedTurns + 1,
    meteredTurns: rollup.meteredTurns + (usage.costUsd === undefined ? 0 : 1),
    unpricedTurns: rollup.unpricedTurns,
  };
}

export function mergeCostRollups(left: CostRollup, right: CostRollup): CostRollup {
  return {
    nanos: left.nanos + right.nanos,
    pricedTurns: left.pricedTurns + right.pricedTurns,
    meteredTurns: left.meteredTurns + right.meteredTurns,
    unpricedTurns: left.unpricedTurns + right.unpricedTurns,
  };
}

export function knownCostNanos(rollup: CostRollup): number | undefined {
  return rollup.pricedTurns > 0 && rollup.unpricedTurns === 0 ? rollup.nanos : undefined;
}

export function sessionCost(
  entries: readonly SessionEntry[],
  fallbackModelId?: string,
): CostRollup {
  let modelId = fallbackModelId;
  let rollup = emptyCostRollup();
  for (const entry of entries) {
    if (entry.type === "model_change") {
      modelId = entry.modelId;
      continue;
    }
    const usage = usageOf(entry);
    if (usage !== undefined) rollup = withTurnCost(rollup, usage, modelId);
  }
  return rollup;
}

export interface SessionCostSource {
  sessionId: string;
  entries: readonly SessionEntry[];
  modelId?: string;
}

export function groupCosts<K>(
  sessions: readonly SessionCostSource[],
  keyOf: (sessionId: string) => K,
): Map<K, CostRollup> {
  const groups = new Map<K, CostRollup>();
  for (const session of sessions) {
    const key = keyOf(session.sessionId);
    const cost = sessionCost(session.entries, session.modelId);
    const existing = groups.get(key);
    groups.set(key, existing === undefined ? cost : mergeCostRollups(existing, cost));
  }
  return groups;
}

export function formatCostNanos(nanos: number): string {
  const dollars = nanos / nanosPerDollar;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${trimToTwoDecimalsMinimum(dollars.toFixed(4))}`;
}

const nanosPerDollar = 1_000_000_000;

const rateTable = new Map<string, ModelRates>(
  Object.entries({
    "gpt-5": listed({ input: 1.25, output: 10, cacheRead: 0.125 }),
    "gpt-5-mini": listed({ input: 0.25, output: 2, cacheRead: 0.025 }),
    "gpt-5-nano": listed({ input: 0.05, output: 0.4, cacheRead: 0.005 }),
    "gpt-5.4": listed({ input: 2.5, output: 15, cacheRead: 0.25 }),
    "gpt-5.4-mini": listed({ input: 0.75, output: 4.5, cacheRead: 0.075 }),
    "gpt-5.4-nano": listed({ input: 0.2, output: 1.25, cacheRead: 0.02 }),
    "amazon.nova-micro-v1:0": listed({ input: 0.035, output: 0.14, cacheRead: 0.009 }),
    "amazon.nova-lite-v1:0": listed({ input: 0.06, output: 0.24, cacheRead: 0.015 }),
    "amazon.nova-pro-v1:0": listed({ input: 0.8, output: 3.2, cacheRead: 0.2 }),
  }),
);

interface ListedDollarsPerMillionTokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function listed(dollars: ListedDollarsPerMillionTokens): ModelRates {
  return {
    inputNanosPerToken: nanosPerToken(dollars.input),
    outputNanosPerToken: nanosPerToken(dollars.output),
    cacheReadNanosPerToken: nanosPerToken(dollars.cacheRead ?? dollars.input),
    cacheWriteNanosPerToken: nanosPerToken(dollars.cacheWrite ?? dollars.input),
  };
}

function nanosPerToken(dollarsPerMillionTokens: number): number {
  return Math.round(dollarsPerMillionTokens * 1000);
}

function canonicalModelId(modelId: string): string {
  return modelId
    .slice(modelId.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/^(us|eu|apac|jp|au)\./, "")
    .replace(/-20\d{2}-\d{2}-\d{2}$/, "");
}

function usageOf(entry: SessionEntry): Usage | undefined {
  switch (entry.type) {
    case "message":
    case "compaction":
    case "branch_summary":
      return entry.usage;
    default:
      return undefined;
  }
}

function trimToTwoDecimalsMinimum(fixed: string): string {
  const shortest = fixed.indexOf(".") + 3;
  let end = fixed.length;
  while (end > shortest && fixed[end - 1] === "0") end -= 1;
  return fixed.slice(0, end);
}
