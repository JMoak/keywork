import type { BootstrapInjection } from "./bootstrap.ts";
import { titleKey } from "./naming.ts";
import { extractWikilinks, type MemoryStore, type Provenance } from "./store.ts";

export type RecallSurface = "bootstrap" | "search" | "get";

export interface RecallEvent {
  kind: "recall";
  note: string;
  surface: RecallSurface;
  timestamp: string;
}

export interface CitationEvent {
  kind: "citation";
  note: string;
  timestamp: string;
}

export interface LatencyEvent {
  kind: "latency";
  surface: RecallSurface;
  milliseconds: number;
  timestamp: string;
}

export type CitationLedgerEvent = RecallEvent | CitationEvent | LatencyEvent;

export interface CitationOutcome {
  cited: string[];
  rejected: string[];
}

export interface CitationLedgerOptions {
  now?: () => Date;
  onCitation?: (event: CitationEvent) => void;
}

export class CitationLedger {
  private readonly log: CitationLedgerEvent[] = [];
  private readonly recalledByKey = new Map<string, string>();
  private readonly citedKeys = new Set<string>();
  private readonly now: () => Date;
  private readonly onCitation: ((event: CitationEvent) => void) | undefined;

  constructor(options: CitationLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onCitation = options.onCitation;
  }

  recordRecall(note: string, surface: RecallSurface): void {
    this.recalledByKey.set(titleKey(note), note);
    this.log.push({ kind: "recall", note, surface, timestamp: this.timestamp() });
  }

  recordBootstrap(injection: BootstrapInjection): void {
    for (const layer of injection.layers) {
      for (const note of layer.selection.notes) this.recordRecall(note.name, "bootstrap");
    }
  }

  recordReply(replyText: string): CitationOutcome {
    const cited: string[] = [];
    const rejected: string[] = [];
    for (const link of extractWikilinks(replyText)) {
      const recalled = this.recalledByKey.get(titleKey(link));
      if (recalled === undefined) {
        rejected.push(link);
        continue;
      }
      if (cited.includes(recalled)) continue;
      cited.push(recalled);
      this.citedKeys.add(titleKey(recalled));
      const event: CitationEvent = {
        kind: "citation",
        note: recalled,
        timestamp: this.timestamp(),
      };
      this.log.push(event);
      this.onCitation?.(event);
    }
    return { cited, rejected };
  }

  recordLatency(surface: RecallSurface, milliseconds: number): void {
    this.log.push({ kind: "latency", surface, milliseconds, timestamp: this.timestamp() });
  }

  medianLatencyMs(surface: RecallSurface): number | undefined {
    const window = this.log
      .filter(
        (event): event is LatencyEvent => event.kind === "latency" && event.surface === surface,
      )
      .slice(-latencyWindow)
      .map((event) => event.milliseconds)
      .sort((a, b) => a - b);
    if (window.length === 0) return undefined;
    const middle = Math.floor(window.length / 2);
    const upper = window[middle] ?? 0;
    return window.length % 2 === 1 ? upper : ((window[middle - 1] ?? 0) + upper) / 2;
  }

  events(): readonly CitationLedgerEvent[] {
    return this.log;
  }

  citedRecalls(): string[] {
    return this.recalledNotes().filter((note) => this.citedKeys.has(titleKey(note)));
  }

  uncitedRecalls(): string[] {
    return this.recalledNotes().filter((note) => !this.citedKeys.has(titleKey(note)));
  }

  private recalledNotes(): string[] {
    return [...this.recalledByKey.values()];
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export interface UsefulnessSink {
  recordRecall(noteName: string, sessionId: string): void;
}

export function citationUsefulnessFeed(
  sink: UsefulnessSink,
  sessionId: string | (() => string | undefined),
): (event: CitationEvent) => void {
  const resolveSession = typeof sessionId === "function" ? sessionId : () => sessionId;
  return (event) => {
    const id = resolveSession();
    if (id !== undefined) sink.recordRecall(event.note, id);
  };
}

export interface CitationChainHop {
  note: string;
  provenance: Provenance;
  created?: string;
}

export interface CitationChain {
  note: string;
  provenance: Provenance;
  created?: string;
  supersession: CitationChainHop[];
}

export async function citationChain(
  store: MemoryStore,
  name: string,
): Promise<CitationChain | undefined> {
  const origin = await store.readNote(name);
  if (origin === undefined) return undefined;
  const seen = new Set([titleKey(origin.name)]);
  const supersession: CitationChainHop[] = [];
  let successorName = origin.supersededBy;
  while (successorName !== undefined) {
    const successor = await store.readNote(successorName);
    if (successor === undefined || seen.has(titleKey(successor.name))) break;
    seen.add(titleKey(successor.name));
    supersession.push({
      note: successor.name,
      provenance: successor.provenance,
      ...(successor.created !== undefined && { created: successor.created }),
    });
    successorName = successor.supersededBy;
  }
  return {
    note: origin.name,
    provenance: origin.provenance,
    ...(origin.created !== undefined && { created: origin.created }),
    supersession,
  };
}

const latencyWindow = 64;
