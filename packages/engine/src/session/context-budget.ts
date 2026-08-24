export const assumedContextWindow = 200_000;

export const reserveCaps = {
  flush: 24_576,
  compaction: 16_384,
  keepRecent: 20_000,
} as const;

const reserveShares = {
  flush: 1 / 8,
  compaction: 1 / 12,
  keepRecent: 1 / 10,
} as const;

export interface ContextBudget {
  readonly window: number;
  readonly declared: boolean;
  readonly flushReserve: number;
  readonly compactionReserve: number;
  readonly keepRecent: number;
}

export interface ContextReading {
  readonly used: number;
  readonly window: number;
  readonly flushAt: number;
  readonly compactAt: number;
  readonly declared: boolean;
}

export function contextBudgetFor(declaredWindow: number | undefined): ContextBudget {
  const declared = declaredWindow !== undefined && declaredWindow > 0;
  const window = declared ? Math.floor(declaredWindow) : assumedContextWindow;
  return {
    window,
    declared,
    flushReserve: share(window, reserveShares.flush, reserveCaps.flush),
    compactionReserve: share(window, reserveShares.compaction, reserveCaps.compaction),
    keepRecent: share(window, reserveShares.keepRecent, reserveCaps.keepRecent),
  };
}

export function readContext(used: number, budget: ContextBudget): ContextReading {
  return {
    used: Math.max(0, Math.round(used)),
    window: budget.window,
    flushAt: budget.window - budget.flushReserve,
    compactAt: budget.window - budget.compactionReserve,
    declared: budget.declared,
  };
}

export function flushDue(reading: ContextReading): boolean {
  return reading.used > reading.flushAt;
}

export function compactionDue(reading: ContextReading): boolean {
  return reading.used > reading.compactAt;
}

export function contextFullness(reading: ContextReading): number {
  if (reading.compactAt <= 0) return 1;
  return Math.min(1, reading.used / reading.compactAt);
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${trimmed(tokens / 1000)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${trimmed(tokens / 1_000_000)}M`;
}

function share(window: number, fraction: number, cap: number): number {
  return Math.min(cap, Math.max(1, Math.floor(window * fraction)));
}

function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
