import type { MemoryFlush } from "../memory/flush.ts";
import type { Message } from "../messages.ts";
import type { Provider } from "../provider.ts";
import {
  compactionSettingsFor,
  compactSession,
  estimateContextTokens,
  shouldCompact,
} from "./compaction.ts";
import {
  type ContextBudget,
  type ContextReading,
  formatTokenCount,
  readContext,
} from "./context-budget.ts";
import type { CompactionEntry } from "./entries.ts";
import type { SessionStore } from "./store.ts";

export interface SettleOptions {
  store: SessionStore;
  provider: Provider;
  history: readonly Message[];
  budget: ContextBudget;
  flush?: MemoryFlush | undefined;
}

export interface CompactNowOptions {
  store: SessionStore;
  provider: Provider;
  budget: ContextBudget;
  instructions?: string | undefined;
  flush?: MemoryFlush | undefined;
}

export interface TurnSettlement {
  readonly history: readonly Message[] | undefined;
  readonly notices: readonly string[];
  readonly flushed: readonly Message[];
  readonly compacted: CompactionEntry | undefined;
}

export async function settleTurn(options: SettleOptions): Promise<TurnSettlement> {
  const { store, provider, budget } = options;
  const flush = await flushIfDue(options, readStore(store, budget));
  const reading = readStore(store, budget);
  if (!shouldCompact(reading)) return settled(flush, options.history, undefined, []);
  return compact({ store, provider, budget, flush: options.flush }, flush, options.history);
}

export async function compactNow(options: CompactNowOptions): Promise<TurnSettlement> {
  return compact(options, noFlush, undefined);
}

export function readStore(store: SessionStore, budget: ContextBudget): ContextReading {
  return readContext(estimateContextTokens(store), budget);
}

interface FlushStep {
  readonly messages: readonly Message[];
  readonly notices: readonly string[];
}

const noFlush: FlushStep = { messages: [], notices: [] };

async function flushIfDue(options: SettleOptions, reading: ContextReading): Promise<FlushStep> {
  if (options.flush === undefined) return noFlush;
  try {
    const outcome = await options.flush.maybeFlush(options.history, reading);
    for (const message of outcome.messages) await options.store.append(message);
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
      settings: compactionSettingsFor(budget),
      ...(options.instructions !== undefined &&
        options.instructions !== "" && { instructions: options.instructions }),
    });
    if (entry === undefined) {
      return settled(flush, history, undefined, history === undefined ? [nothingToCompact] : []);
    }
    options.flush?.compactionCompleted();
    const after = readStore(store, budget);
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

function compactedNotice(entry: CompactionEntry, after: ContextReading): string {
  return `compacted ${formatTokenCount(entry.tokensBefore)} tokens into a summary · context now ${formatTokenCount(after.used)} of ${formatTokenCount(after.window)}`;
}
