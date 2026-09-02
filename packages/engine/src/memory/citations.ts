import type { AuditEntry } from "./audit.ts";
import type { BootstrapInjection } from "./bootstrap.ts";
import { titleKey } from "./naming.ts";
import { extractWikilinks, type Provenance } from "./notes.ts";
import type { MemoryStore } from "./store.ts";

export type RecallSurface = "bootstrap" | "search" | "get" | "action";

export interface RecallEvent {
  kind: "recall";
  note: string;
  surface: RecallSurface;
  timestamp: string;
  layer?: string;
  session?: string;
}

export interface CitationEvent {
  kind: "citation";
  note: string;
  timestamp: string;
  layer?: string;
  session?: string;
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

export interface RecallTap {
  recordRecall(note: string, surface: RecallSurface, layer?: string): void;
  recordLatency(surface: RecallSurface, milliseconds: number): void;
}

export interface CitationLedgerOptions {
  now?: () => Date;
  session?: string;
  onCitation?: (event: CitationEvent) => void;
  onEvent?: (event: RecallEvent | CitationEvent) => void;
}

export class CitationLedger implements RecallTap {
  private readonly log: CitationLedgerEvent[] = [];
  private readonly recalledByKey = new Map<string, { note: string; layer?: string }>();
  private readonly surfacesByKey = new Map<string, Set<RecallSurface>>();
  private readonly citedKeys = new Set<string>();
  private readonly reReadKeys = new Set<string>();
  private readonly now: () => Date;
  private readonly session: string | undefined;
  private readonly onCitation: ((event: CitationEvent) => void) | undefined;
  private readonly onEvent: ((event: RecallEvent | CitationEvent) => void) | undefined;

  constructor(options: CitationLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.session = options.session;
    this.onCitation = options.onCitation;
    this.onEvent = options.onEvent;
  }

  recordRecall(note: string, surface: RecallSurface, layer?: string): void {
    const key = titleKey(note);
    const knownLayer = layer ?? this.recalledByKey.get(key)?.layer;
    this.recalledByKey.set(key, { note, ...(knownLayer !== undefined && { layer: knownLayer }) });
    const event: RecallEvent = {
      kind: "recall",
      note,
      surface,
      timestamp: this.timestamp(),
      ...(layer !== undefined && { layer }),
      ...(this.session !== undefined && { session: this.session }),
    };
    this.log.push(event);
    this.onEvent?.(event);
    if (surface === "get") this.creditReRead(key);
    this.surfacesOf(key).add(surface);
  }

  recordBootstrap(injection: BootstrapInjection): void {
    for (const layer of injection.layers) {
      for (const note of layer.selection.notes) {
        this.recordRecall(note.name, "bootstrap", layer.name);
      }
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
      if (cited.includes(recalled.note)) continue;
      cited.push(recalled.note);
      this.cite(recalled.note, recalled.layer);
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

  citations(): CitationEvent[] {
    return this.log.filter((event): event is CitationEvent => event.kind === "citation");
  }

  citedRecalls(): string[] {
    return this.recalledNotes().filter((note) => this.citedKeys.has(titleKey(note)));
  }

  uncitedRecalls(): string[] {
    return this.recalledNotes().filter((note) => !this.citedKeys.has(titleKey(note)));
  }

  private cite(note: string, layer: string | undefined): void {
    this.citedKeys.add(titleKey(note));
    const event: CitationEvent = {
      kind: "citation",
      note,
      timestamp: this.timestamp(),
      ...(layer !== undefined && { layer }),
      ...(this.session !== undefined && { session: this.session }),
    };
    this.log.push(event);
    this.onEvent?.(event);
    this.onCitation?.(event);
  }

  private creditReRead(key: string): void {
    const surfaces = this.surfacesOf(key);
    const surfacedElsewhere = [...surfaces].some((surface) => surface !== "get");
    if (!surfacedElsewhere || this.reReadKeys.has(key)) return;
    this.reReadKeys.add(key);
    const recalled = this.recalledByKey.get(key);
    if (recalled !== undefined) this.cite(recalled.note, recalled.layer);
  }

  private surfacesOf(key: string): Set<RecallSurface> {
    const existing = this.surfacesByKey.get(key);
    if (existing !== undefined) return existing;
    const created = new Set<RecallSurface>();
    this.surfacesByKey.set(key, created);
    return created;
  }

  private recalledNotes(): string[] {
    return [...this.recalledByKey.values()].map((recalled) => recalled.note);
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

export function citationAuditEvent(event: RecallEvent | CitationEvent): string {
  const trail = [
    ...(event.layer !== undefined ? [`in ${event.layer}`] : []),
    ...(event.session !== undefined ? [`by session ${event.session}`] : []),
  ];
  const head =
    event.kind === "recall"
      ? `recall [[${event.note}]] via ${event.surface}`
      : `citation [[${event.note}]]`;
  return [head, ...trail].join(" ");
}

export function parseCitationEvents(
  entries: readonly AuditEntry[],
): (RecallEvent | CitationEvent)[] {
  const events: (RecallEvent | CitationEvent)[] = [];
  for (const entry of entries) {
    const parsed = parseCitationAuditLine(entry.event, entry.timestamp);
    if (parsed !== undefined) events.push(parsed);
  }
  return events;
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

const citationLinePattern =
  /^(recall|citation) \[\[([^\]]+)\]\](?: via (bootstrap|search|get|action))?(?: in (\S+))?(?: by session (\S+))?$/;

function parseCitationAuditLine(
  line: string,
  timestamp: string,
): RecallEvent | CitationEvent | undefined {
  const match = citationLinePattern.exec(line);
  const note = match?.[2];
  if (match === null || note === undefined) return undefined;
  const [, kind, , rawSurface, layer, session] = match;
  const trail = {
    ...(layer !== undefined && { layer }),
    ...(session !== undefined && { session }),
  };
  if (kind === "citation") return { kind: "citation", note, timestamp, ...trail };
  const surface = asRecallSurface(rawSurface);
  if (surface === undefined) return undefined;
  return { kind: "recall", note, surface, timestamp, ...trail };
}

function asRecallSurface(value: string | undefined): RecallSurface | undefined {
  switch (value) {
    case "bootstrap":
    case "search":
    case "get":
    case "action":
      return value;
    default:
      return undefined;
  }
}
