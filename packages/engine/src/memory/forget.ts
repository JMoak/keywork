import { type CheckpointAnchor, readAnchor } from "./anchors.ts";
import { type CitationEvent, parseCitationEvents, type RecallEvent } from "./citations.ts";
import { type GraphEdge, MemoryGraph } from "./graph.ts";
import { contentHash } from "./ledger.ts";
import { titleKey } from "./naming.ts";
import type { Note } from "./notes.ts";
import {
  InvalidMemorySourceError,
  type MemorySource,
  noteFromSource,
  parseMemorySource,
  sourceText,
} from "./sources.ts";
import {
  addresseeOf,
  isStagedWrite,
  type StagedAddressee,
  type StagedReview,
  type StagedWrite,
  type StagedWriteKind,
  stagedBody,
} from "./staging.ts";
import type { MemoryStore } from "./store.ts";

export interface ForgetEntry {
  id: string;
  date: string;
  time: string;
  text: string;
}

export interface ForgetRefusal {
  note: string;
  reason: string;
}

export interface ForgetPlan {
  session: string;
  notes: string[];
  entries: ForgetEntry[];
  refused: ForgetRefusal[];
}

export interface ForgetNoteLine {
  name: string;
  path: string;
  firstLine: string;
}

export interface ForgetAnchorLine extends CheckpointAnchor {
  note: string;
}

export interface ForgetCitationLine {
  note: string;
  kind: "recall" | "citation";
  timestamp: string;
  session?: string;
}

export interface ForgetStagedLine {
  id: string;
  kind: StagedWriteKind;
  target: string;
  for: StagedAddressee;
  firstLine: string;
}

export interface SourceForgetCounts {
  notes: number;
  anchors: number;
  edges: number;
  citations: number;
  entries: number;
  staged: number;
}

export interface SourceForgetPlan {
  source: string;
  digest: string;
  counts: SourceForgetCounts;
  notes: ForgetNoteLine[];
  anchors: ForgetAnchorLine[];
  edges: GraphEdge[];
  citations: ForgetCitationLine[];
  entries: ForgetEntry[];
  staged: ForgetStagedLine[];
  kept: ForgetRefusal[];
}

export interface SourceForgetReport {
  source: string;
  counts: SourceForgetCounts;
  ledgerId?: string;
}

export interface SourceForgetRefusal {
  refused: "invalid-source" | "stale";
  error: string;
}

export interface SourceForgetting {
  preview(source: string): Promise<SourceForgetPlan | SourceForgetRefusal>;
  apply(source: string, digest: string): Promise<SourceForgetReport | SourceForgetRefusal>;
}

export class StaleForgetPlanError extends Error {
  constructor(readonly source: string) {
    super(`the vault changed since the dry run of ${source}; run the dry run again`);
    this.name = "StaleForgetPlanError";
  }
}

export async function planForget(store: MemoryStore, session: string): Promise<ForgetPlan> {
  const plan: ForgetPlan = { session, notes: [], entries: [], refused: [] };
  for (const note of await store.listNotes()) {
    const refusal = refusalFor(note, session);
    if (refusal !== undefined) plan.refused.push({ note: note.name, reason: refusal });
    else if (note.originSession === session) plan.notes.push(note.name);
  }
  plan.entries = await sessionEntries(store, session);
  return plan;
}

export function isEmptyPlan(plan: ForgetPlan): boolean {
  return plan.notes.length === 0 && plan.entries.length === 0;
}

export async function stageForget(
  store: Pick<MemoryStore, "propose">,
  plan: ForgetPlan,
): Promise<StagedReview | undefined> {
  if (isEmptyPlan(plan)) return undefined;
  const [review] = await store.propose([
    {
      kind: "forget-proposal",
      session: plan.session,
      notes: plan.notes,
      entries: plan.entries.map((entry) => entry.id),
    },
  ]);
  return review;
}

export async function planSourceForget(
  store: MemoryStore,
  source: MemorySource,
): Promise<SourceForgetPlan> {
  const all = await store.listNotes();
  const { gone, kept } = sortBySource(all, source);
  const goneKeys = new Set(gone.map((note) => titleKey(note.name)));
  const touchesGone = (name: string): boolean => goneKeys.has(titleKey(name));
  const notes = gone.map(noteLine);
  const anchors = gone.flatMap(anchorLines);
  const edges = MemoryGraph.fromNotes(all).edges.filter(
    (edge) => touchesGone(edge.subject) || touchesGone(edge.object),
  );
  const citations = parseCitationEvents(await store.readAudit())
    .filter((event) => touchesGone(event.note))
    .map(citationLine);
  const entries = source.kind === "session" ? await sessionEntries(store, source.id) : [];
  const stagedItems = await stagedFrom(store, source);
  const staged = stagedItems.map(stagedLine);
  const listed = { notes, anchors, edges, citations, entries, staged, kept };
  const stagedContents = stagedItems.map((item) => item.content);
  return {
    source: sourceText(source),
    digest: await planDigest(store, source, listed, stagedContents),
    counts: countsOf(listed),
    ...listed,
  };
}

export function isEmptySourcePlan(
  plan: Pick<SourceForgetPlan, "notes" | "entries"> & Partial<Pick<SourceForgetPlan, "staged">>,
): boolean {
  return plan.notes.length === 0 && plan.entries.length === 0 && (plan.staged ?? []).length === 0;
}

export async function applySourceForget(
  store: MemoryStore,
  source: MemorySource,
  digest: string,
): Promise<SourceForgetReport> {
  const plan = await planSourceForget(store, source);
  if (plan.digest !== digest) throw new StaleForgetPlanError(plan.source);
  if (isEmptySourcePlan(plan)) return { source: plan.source, counts: plan.counts };
  const result = await store.forgetSourced({
    notes: plan.notes.map((note) => note.path),
    entries: plan.entries.map((entry) => entry.id),
    cited: plan.notes.map((note) => note.name),
    staged: plan.staged.map((item) => item.id),
    echo: forgetEcho(plan),
  });
  return { source: plan.source, counts: plan.counts, ledgerId: result.ledgerId };
}

export function forgetEcho(plan: Pick<SourceForgetPlan, "source" | "counts">): string {
  const { notes, anchors, edges, citations, entries, staged } = plan.counts;
  const tally = [
    counted(notes, "note"),
    counted(anchors, "anchor"),
    counted(edges, "edge"),
    counted(citations, "citation"),
    counted(entries, "entry", "entries"),
    ...(staged > 0 ? [counted(staged, "staged item")] : []),
  ];
  return `forgot ${plan.source} · ${tally.join(", ")}`;
}

export function sourceForgetting(storeOf: (source: MemorySource) => MemoryStore): SourceForgetting {
  return {
    preview: (text) =>
      refusing(async () => {
        const source = parseMemorySource(text);
        return planSourceForget(storeOf(source), source);
      }),
    apply: (text, digest) =>
      refusing(async () => {
        const source = parseMemorySource(text);
        return applySourceForget(storeOf(source), source, digest);
      }),
  };
}

export function workspaceOrCraftStore(
  workspace: MemoryStore,
  botStore?: (slug: string) => MemoryStore,
): (source: MemorySource) => MemoryStore {
  return (source) =>
    source.kind === "craft" && botStore !== undefined ? botStore(source.id) : workspace;
}

interface ListedForget {
  notes: ForgetNoteLine[];
  anchors: ForgetAnchorLine[];
  edges: GraphEdge[];
  citations: ForgetCitationLine[];
  entries: ForgetEntry[];
  staged: ForgetStagedLine[];
  kept: ForgetRefusal[];
}

function sortBySource(
  notes: readonly Note[],
  source: MemorySource,
): { gone: Note[]; kept: ForgetRefusal[] } {
  const gone: Note[] = [];
  const kept: ForgetRefusal[] = [];
  for (const note of notes) {
    const refusal = source.kind === "session" ? refusalFor(note, source.id) : undefined;
    if (refusal !== undefined) kept.push({ note: note.name, reason: refusal });
    else if (noteFromSource(note, source)) gone.push(note);
  }
  return { gone, kept };
}

async function sessionEntries(
  store: Pick<MemoryStore, "listDailyDates" | "readDaily">,
  session: string,
): Promise<ForgetEntry[]> {
  const entries: ForgetEntry[] = [];
  for (const date of await store.listDailyDates()) {
    (await store.readDaily(date)).forEach((entry, index) => {
      if (entry.session === session)
        entries.push({ id: `${date}#${index}`, date, time: entry.time, text: entry.text });
    });
  }
  return entries;
}

async function stagedFrom(
  store: Pick<MemoryStore, "listStaged" | "redact">,
  source: MemorySource,
): Promise<StagedWrite[]> {
  const text = sourceText(source);
  const spellings = new Set([text, store.redact(text)]);
  return (await store.listStaged()).filter(
    (item): item is StagedWrite =>
      isStagedWrite(item) && item.source !== undefined && spellings.has(item.source),
  );
}

function stagedLine(item: StagedWrite): ForgetStagedLine {
  return {
    id: item.id,
    kind: item.kind,
    target: item.target,
    for: addresseeOf(item),
    firstLine: firstLineOf(stagedBody(item)),
  };
}

function noteLine(note: Note): ForgetNoteLine {
  return { name: note.name, path: note.path, firstLine: firstLineOf(note.body) };
}

function anchorLines(note: Note): ForgetAnchorLine[] {
  const anchor = readAnchor(note.frontmatter);
  return anchor === undefined ? [] : [{ note: note.name, ...anchor }];
}

function citationLine(event: RecallEvent | CitationEvent): ForgetCitationLine {
  return {
    note: event.note,
    kind: event.kind,
    timestamp: event.timestamp,
    ...(event.session !== undefined && { session: event.session }),
  };
}

function countsOf(listed: ListedForget): SourceForgetCounts {
  return {
    notes: listed.notes.length,
    anchors: listed.anchors.length,
    edges: listed.edges.length,
    citations: listed.citations.length,
    entries: listed.entries.length,
    staged: listed.staged.length,
  };
}

async function planDigest(
  store: Pick<MemoryStore, "readNoteSource">,
  source: MemorySource,
  listed: ListedForget,
  stagedContents: readonly string[],
): Promise<string> {
  const contents: (string | null)[] = [];
  for (const note of listed.notes) contents.push(await store.readNoteSource(note.path));
  contents.push(...stagedContents);
  return contentHash(JSON.stringify({ source: sourceText(source), listed, contents }));
}

async function refusing<T>(work: () => Promise<T>): Promise<T | SourceForgetRefusal> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidMemorySourceError)
      return { refused: "invalid-source", error: error.message };
    if (error instanceof StaleForgetPlanError) return { refused: "stale", error: error.message };
    throw error;
  }
}

function firstLineOf(body: string): string {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function refusalFor(note: Note, session: string): string | undefined {
  const revisedBy = note.revisedBy ?? [];
  if (note.originSession === session && revisedBy.length > 0)
    return `also revised by ${describeSessions(revisedBy)}; mixed provenance, kept`;
  if (note.originSession !== session && revisedBy.includes(session))
    return `originated in ${note.originSession ?? "an unknown session"}; this session only revised it, kept`;
  return undefined;
}

function describeSessions(sessions: readonly string[]): string {
  return sessions.length === 1 ? `session ${sessions[0]}` : `sessions ${sessions.join(", ")}`;
}
