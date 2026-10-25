import type { FlushOutcome, MemoryFlush } from "../memory/flush.ts";
import type { Message } from "../messages.ts";
import type { Provider } from "../provider.ts";
import { compactSession, estimateContextTokens } from "./compaction.ts";
import {
  type ContextBudget,
  type ContextReading,
  compactionDue,
  formatTokenCount,
  readContext,
} from "./context-budget.ts";
import { type ContextMeasure, readMeasured } from "./context-map.ts";
import type { CompactionEntry } from "./entries.ts";
import type { SessionStore } from "./store.ts";

export type SettlePhase = "after-turn" | "between-tool-batches";

export interface SettleOptions {
  store: SessionStore;
  provider: Provider;
  history: readonly Message[];
  budget: ContextBudget;
  flush?: MemoryFlush | undefined;
  phase?: SettlePhase | undefined;
  measure?: ContextMeasure | undefined;
}

export interface CompactNowOptions {
  store: SessionStore;
  provider: Provider;
  budget: ContextBudget;
  instructions?: string | undefined;
  flush?: MemoryFlush | undefined;
  measure?: ContextMeasure | undefined;
}

export interface FlushNowOptions {
  store: SessionStore;
  history: readonly Message[];
  flush?: MemoryFlush | undefined;
}

export interface TurnSettlement {
  readonly history: readonly Message[] | undefined;
  readonly notices: readonly string[];
  readonly flushed: readonly Message[];
  readonly compacted: CompactionEntry | undefined;
}

export async function settleTurn(options: SettleOptions): Promise<TurnSettlement> {
  const { store, provider, budget, measure } = options;
  const flush = flushesIn(options.phase) ? await flushIfDue(options, measured(options)) : noFlush;
  if (!compactionDue(measured(options))) return settled(flush, options.history, undefined, []);
  return compact(
    { store, provider, budget, measure, flush: options.flush },
    flush,
    options.history,
  );
}

export async function compactNow(options: CompactNowOptions): Promise<TurnSettlement> {
  return compact(options, noFlush, undefined);
}

export async function flushMemoryNow(options: FlushNowOptions): Promise<TurnSettlement> {
  const { store, history, flush } = options;
  if (flush === undefined) return settled(noFlush, history, undefined, [memoryInertNotice]);
  try {
    const outcome = await flush.flushNow(history);
    await store.appendMemoryFlush(outcome.messages);
    const step: FlushStep = { messages: outcome.messages, notices: [] };
    return settled(step, history, undefined, [requestedFlushNotice(outcome)]);
  } catch (cause) {
    return settled(noFlush, history, undefined, [`flush failed: ${reasonOf(cause)}`]);
  }
}

export function readStore(
  store: SessionStore,
  budget: ContextBudget,
  overhead = 0,
): ContextReading {
  return readContext(estimateContextTokens(store), budget, overhead);
}

function measured({ store, budget, measure }: SettleOptions): ContextReading {
  return measure === undefined
    ? readStore(store, budget)
    : readMeasured(measure, store.messages(), budget);
}

interface FlushStep {
  readonly messages: readonly Message[];
  readonly notices: readonly string[];
}

const noFlush: FlushStep = { messages: [], notices: [] };

function flushesIn(phase: SettlePhase | undefined): boolean {
  return phase !== "between-tool-batches";
}

async function flushIfDue(options: SettleOptions, reading: ContextReading): Promise<FlushStep> {
  if (options.flush === undefined) return noFlush;
  try {
    const outcome = await options.flush.maybeFlush(options.history, reading);
    await options.store.appendMemoryFlush(outcome.messages);
    return { messages: outcome.messages, notices: [] };
  } catch (cause) {
    return { messages: [], notices: [`flush failed: ${reasonOf(cause)}`] };
  }
}

async function compact(
  options: CompactNowOptions,
  flush: FlushStep,
  history: readonly Message[] | undefined,
): Promise<TurnSettlement> {
  const { store, provider, budget } = options;
  try {
    const entry = await compactSession(store, provider, {
      budget,
      ...(options.instructions !== undefined &&
        options.instructions !== "" && { instructions: options.instructions }),
    });
    if (entry === undefined) {
      return settled(flush, history, undefined, history === undefined ? [nothingToCompact] : []);
    }
    options.flush?.compactionCompleted();
    const after = readStore(store, budget, options.measure?.overhead);
    return {
      history: store.messages(),
      notices: [...flush.notices, compactedNotice(entry, after)],
      flushed: flush.messages,
      compacted: entry,
    };
  } catch (cause) {
    return settled(flush, history, undefined, [`compaction failed: ${reasonOf(cause)}`]);
  }
}

function settled(
  flush: FlushStep,
  history: readonly Message[] | undefined,
  compacted: CompactionEntry | undefined,
  notices: readonly string[],
): TurnSettlement {
  const flushed = flush.messages;
  return {
    history: flushed.length === 0 || history === undefined ? undefined : [...history, ...flushed],
    notices: [...flush.notices, ...notices],
    flushed,
    compacted,
  };
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const nothingToCompact = "nothing to compact yet · the recent turns are all that's here";

const memoryInertNotice = "nothing flushed · memory is inert in this workspace";

function requestedFlushNotice(outcome: FlushOutcome): string {
  if (!outcome.flushed) return "nothing to flush yet · the conversation is empty";
  return outcome.persisted
    ? "memory flushed · what was worth keeping went to the daily log"
    : "memory flushed · nothing here was worth keeping";
}

function compactedNotice(entry: CompactionEntry, after: ContextReading): string {
  return `compacted ${formatTokenCount(entry.tokensBefore)} tokens into a summary · context now ${formatTokenCount(after.used)} of ${formatTokenCount(after.window)}`;
}
