import type { EngineEvents, EventBus } from "../bus.ts";
import { contextMessages, type SessionEntry } from "./entries.ts";
import type { SessionStore } from "./store.ts";

export const hunkVerdicts = ["keep", "drop", "ask"] as const;

export type HunkVerdict = (typeof hunkVerdicts)[number];

export interface HunkReference {
  path: string;
  header: string;
  digest: string;
}

export interface ReviewVerdict extends HunkReference {
  verdict: HunkVerdict;
}

export interface VerdictMark extends ReviewVerdict {
  index: number;
  entryId: string;
  at: string;
}

export const reviewVerdictType = "keywork.review.verdict";

export const reviewExtension = "review";

export const hunkHeaderPattern = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@$/;

export const hunkDigestPattern = /^[0-9a-f]{8}$/;

export function isHunkVerdict(value: unknown): value is HunkVerdict {
  return typeof value === "string" && (hunkVerdicts as readonly string[]).includes(value);
}

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.path === "string" &&
    fields.path !== "" &&
    typeof fields.header === "string" &&
    hunkHeaderPattern.test(fields.header) &&
    typeof fields.digest === "string" &&
    hunkDigestPattern.test(fields.digest) &&
    isHunkVerdict(fields.verdict)
  );
}

export function verdictMarksOf(contextEntries: readonly SessionEntry[]): VerdictMark[] {
  const marks: VerdictMark[] = [];
  let index = 0;
  for (const entry of contextEntries) {
    const verdict = verdictOfEntry(entry);
    if (verdict !== undefined) {
      marks.push({ index, entryId: entry.id, at: entry.timestamp, ...verdict });
    }
    index += contextMessages([entry]).length;
  }
  return marks;
}

export function hunkKey(hunk: HunkReference): string {
  return `${hunk.path}#${hunk.digest}`;
}

export function latestVerdicts(marks: readonly VerdictMark[]): VerdictMark[] {
  const latest = new Map<string, VerdictMark>();
  for (const mark of marks) latest.set(hunkKey(mark), mark);
  return [...latest.values()];
}

export function openAsks(marks: readonly VerdictMark[]): VerdictMark[] {
  return latestVerdicts(marks).filter((mark) => mark.verdict === "ask");
}

export function verdictLine(verdict: ReviewVerdict): string {
  return `${verdict.verdict} · ${verdict.path} ${verdict.header} · hunk ${verdict.digest}`;
}

export async function recordHunkVerdict(
  store: SessionStore,
  bus: Pick<EventBus<EngineEvents>, "emit">,
  verdict: ReviewVerdict,
): Promise<VerdictMark> {
  const entry = await store.appendHunkVerdict(verdict);
  const mark = verdictMarksOf(store.contextEntries()).find((seen) => seen.entryId === entry.id) ?? {
    index: store.messages().length,
    entryId: entry.id,
    at: entry.timestamp,
    ...verdict,
  };
  bus.emit("extension.notice", {
    extension: reviewExtension,
    level: "info",
    message: verdictLine(mark),
    detail: { verdict: mark, entryId: entry.id },
  });
  return mark;
}

function verdictOfEntry(entry: SessionEntry): ReviewVerdict | undefined {
  if (entry.type !== "custom" || entry.customType !== reviewVerdictType) return undefined;
  if (!isReviewVerdict(entry.data)) return undefined;
  const { path, header, digest, verdict } = entry.data;
  return { path, header, digest, verdict };
}
