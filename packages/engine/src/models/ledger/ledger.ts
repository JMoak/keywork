import { totalCacheWrite } from "./normalize.ts";
import type { CostSource, NormalizedUsage } from "./types.ts";

export type UsageLedgerFlag = "usage-missing" | "unpriced";

export interface UsageLedgerEntry {
  at: string;
  node: string | null;
  provider: string;
  model: string;
  servedModel: string | null;
  creature: string | null;
  session: string | null;
  usage: NormalizedUsage | null;
  flags: readonly UsageLedgerFlag[];
}

export type UsageLedgerInput = Omit<UsageLedgerEntry, "flags" | "at"> & { at?: string };

export interface UsageLedgerFilter {
  creature?: string | undefined;
  session?: string | undefined;
  node?: string | undefined;
}

export interface UsageLedgerTotals {
  turns: number;
  turnsWithoutUsage: number;
  unpricedTurns: number;
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  costBySource: Readonly<Record<CostSource, number>>;
}

export type UsageLedgerSink = (entry: UsageLedgerEntry) => void;

export class UsageLedger {
  private readonly recorded: UsageLedgerEntry[] = [];

  constructor(
    private readonly sink: UsageLedgerSink = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: UsageLedgerInput): UsageLedgerEntry {
    const entry: UsageLedgerEntry = {
      ...input,
      at: input.at ?? this.now().toISOString(),
      flags: flagsOf(input.usage),
    };
    this.recorded.push(entry);
    this.sink(entry);
    return entry;
  }

  entries(filter: UsageLedgerFilter = {}): readonly UsageLedgerEntry[] {
    return this.recorded.filter(matching(filter));
  }

  totals(filter: UsageLedgerFilter = {}): UsageLedgerTotals {
    return this.entries(filter).reduce(addEntry, emptyUsageTotals());
  }
}

export function emptyUsageTotals(): UsageLedgerTotals {
  return {
    turns: 0,
    turnsWithoutUsage: 0,
    unpricedTurns: 0,
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    costBySource: { provider: 0, price_table: 0, local_estimate: 0 },
  };
}

function flagsOf(usage: NormalizedUsage | null): UsageLedgerFlag[] {
  if (usage === null) return ["usage-missing"];
  return usage.costSource === null ? ["unpriced"] : [];
}

function matching(filter: UsageLedgerFilter): (entry: UsageLedgerEntry) => boolean {
  return (entry) =>
    (filter.creature === undefined || entry.creature === filter.creature) &&
    (filter.session === undefined || entry.session === filter.session) &&
    (filter.node === undefined || entry.node === filter.node);
}

function addEntry(totals: UsageLedgerTotals, entry: UsageLedgerEntry): UsageLedgerTotals {
  const turns = totals.turns + 1;
  const usage = entry.usage;
  if (usage === null) return { ...totals, turns, turnsWithoutUsage: totals.turnsWithoutUsage + 1 };
  const counted = {
    ...totals,
    turns,
    inputUncached: totals.inputUncached + usage.inputUncached,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + totalCacheWrite(usage),
    output: totals.output + usage.output,
    reasoning: totals.reasoning + (usage.reasoning ?? 0),
  };
  if (usage.cost === null || usage.costSource === null) {
    return { ...counted, unpricedTurns: totals.unpricedTurns + 1 };
  }
  return {
    ...counted,
    costUsd: totals.costUsd + usage.cost,
    costBySource: {
      ...totals.costBySource,
      [usage.costSource]: totals.costBySource[usage.costSource] + usage.cost,
    },
  };
}
