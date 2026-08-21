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
  const flushed = await flushIfDue(options, readStore(store, budget));
  const reading = readStore(store, budget);
  if (!shouldCompact(reading)) return settled(flushed, options.history, undefined, []);
  return compact({ store, provider, budget, flush: options.flush }, flushed, options.history);
}

export async function compactNow(options: CompactNowOptions): Promise<TurnSettlement> {
  return compact(options, [], undefined);
}

export function readStore(store: SessionStore, budget: ContextBudget): ContextReading {
  return readContext(estimateContextTokens(store), budget);
}

async function flushIfDue(options: SettleOptions, reading: ContextReading): Promise<Message[]> {
  if (options.flush === undefined) return [];
  try {
    const outcome = await options.flush.maybeFlush(options.history, reading);
    for (const message of outcome.messages) await options.store.append(message);
    return outcome.messages;
  } catch {
    return [];
  }
}

async function compact(
  options: CompactNowOptions,
  flushed: readonly Message[],
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
      return settled(flushed, history, undefined, history === undefined ? [nothingToCompact] : []);
    }
    options.flush?.compactionCompleted();
    const after = readStore(store, budget);
    return {
      history: store.messages(),
      notices: [compactedNotice(entry, after)],
      flushed,
      compacted: entry,
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return settled(flushed, history, undefined, [`compaction failed: ${reason}`]);
  }
}

function settled(
  flushed: readonly Message[],
  history: readonly Message[] | undefined,
  compacted: CompactionEntry | undefined,
  notices: readonly string[],
): TurnSettlement {
  return {
    history: flushed.length === 0 || history === undefined ? undefined : [...history, ...flushed],
    notices,
    flushed,
    compacted,
  };
}

const nothingToCompact = "nothing to compact yet · the recent turns are all that's here";

function compactedNotice(entry: CompactionEntry, after: ContextReading): string {
  return `compacted ${formatTokenCount(entry.tokensBefore)} tokens into a summary · context now ${formatTokenCount(after.used)} of ${formatTokenCount(after.window)}`;
}
