import {
  type Frontmatter,
  MalformedFrontmatterError,
  parseDocument,
  serializeDocument,
} from "./frontmatter.ts";
import type { LeaseRecord, SweepLease } from "./lease.ts";
import { splitConflictMarkers } from "./merge.ts";
import { noteName, type Provenance, provenances } from "./notes.ts";
import type { IndexReconciliation, MemorySearch } from "./search.ts";
import type { ReviewProposal } from "./staging.ts";
import type { MemoryStore, NoteFileChange } from "./store.ts";

export interface ConflictIntake {
  original: string;
  sibling: string;
  source: ConflictSource;
  provenance: { original: Provenance; sibling: Provenance };
}

export type ConflictSource = "markers" | "artifact";

export interface VaultReconciliation {
  host: string | undefined;
  hosts: string[];
  intake: ConflictIntake[];
  restored: string[];
  cards: string[];
  lease: LeaseRecord | undefined;
  index: IndexReconciliation | undefined;
}

export interface ReconcileOptions {
  store: MemoryStore;
  search?: MemorySearch;
  lease?: SweepLease;
}

export const conflictOfField = "conflict-of";

export async function reconcileVault(options: ReconcileOptions): Promise<VaultReconciliation> {
  const { store } = options;
  const report: VaultReconciliation = {
    host: store.host,
    hosts: [],
    intake: [],
    restored: [],
    cards: [],
    lease: undefined,
    index: undefined,
  };
  if (!store.trusted) return report;
  for (const path of await store.notePaths()) await takeIn(store, path, report);
  report.cards = (await store.propose(report.intake.map(contradictionCard))).map(
    (review) => review.key,
  );
  report.hosts = await store.segmentHosts();
  report.lease = await options.lease?.inspect();
  report.index = await options.search?.reconcile();
  return report;
}

export function conflictArtifactOriginal(path: string): string | undefined {
  const name = noteName(path);
  for (const pattern of artifactPatterns) {
    const stripped = name.replace(pattern, "");
    if (stripped !== name && stripped !== "") return `${stripped}.md`;
  }
  return undefined;
}

export function conflictSiblingName(original: string, taken: ReadonlySet<string>): string {
  const first = `${original} (conflict copy)`;
  if (!taken.has(first)) return first;
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${original} (conflict copy ${ordinal})`;
    if (!taken.has(candidate)) return candidate;
  }
}

const artifactPatterns = [
  / \([^()]*conflicted copy[^()]*\)$/i,
  /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+$/,
];

async function takeIn(store: MemoryStore, path: string, report: VaultReconciliation) {
  const raw = await store.readNoteSource(path);
  if (raw === null) return;
  const split = splitConflictMarkers(raw);
  if (split !== undefined) {
    report.intake.push(await quarantineCopy(store, path, split.ours, split.theirs, "markers"));
    return;
  }
  const original = conflictArtifactOriginal(path);
  if (original === undefined) return;
  const kept = await store.readNoteSource(original);
  if (kept === null) {
    await store.reconcileNoteFiles([
      { path, content: null },
      { path: original, content: raw },
    ]);
    report.restored.push(noteName(original));
    return;
  }
  const copy = await quarantineCopy(store, original, kept, raw, "artifact", path);
  report.intake.push(copy);
}

async function quarantineCopy(
  store: MemoryStore,
  originalPath: string,
  kept: string,
  copy: string,
  source: ConflictSource,
  artifactPath?: string,
): Promise<ConflictIntake> {
  const original = noteName(originalPath);
  const taken = new Set((await store.notePaths()).map(noteName));
  const sibling = conflictSiblingName(original, taken);
  const siblingPath = `${sibling}.md`;
  const copyDocument = parseLeniently(copy, siblingPath);
  const stamped = { ...copyDocument.frontmatter, [conflictOfField]: `[[${original}]]` };
  const changes: NoteFileChange[] = [
    { path: originalPath, content: kept },
    { path: siblingPath, content: serializeDocument(stamped, copyDocument.body) },
    ...(artifactPath === undefined ? [] : [{ path: artifactPath, content: null }]),
  ];
  await store.reconcileNoteFiles(changes);
  return {
    original,
    sibling,
    source,
    provenance: {
      original: provenanceOf(parseLeniently(kept, originalPath).frontmatter),
      sibling: provenanceOf(copyDocument.frontmatter),
    },
  };
}

function parseLeniently(raw: string, file: string) {
  try {
    return parseDocument(raw, file);
  } catch (error) {
    if (error instanceof MalformedFrontmatterError) return { frontmatter: {}, body: raw };
    throw error;
  }
}

function contradictionCard(intake: ConflictIntake): ReviewProposal {
  return {
    kind: "contradiction",
    a: intake.original,
    b: intake.sibling,
    aProvenance: intake.provenance.original,
    bProvenance: intake.provenance.sibling,
    confidence: 1,
  };
}

function provenanceOf(frontmatter: Frontmatter): Provenance {
  const value = frontmatter.provenance;
  return isProvenance(value) ? value : "user";
}

function isProvenance(value: unknown): value is Provenance {
  return provenances.some((candidate) => candidate === value);
}
