import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "./audit.ts";
import type { DailyEntry } from "./notes.ts";
import { dailyDir, isAuditSegmentPath, syncDir, writeFileAtomic } from "./vault-files.ts";

export const layoutMarker = `${syncDir}/layout.json`;
export const perHostLayout = { version: 1, layout: "per-host" } as const;

export interface DailySegment {
  path: string;
  entries: DailyEntry[];
}

export interface PlacedDailyEntry {
  entry: DailyEntry;
  path: string;
  index: number;
}

export function hostToken(name: string): string {
  const token = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxHostLength);
  return token === "" ? "host" : token;
}

export function localHost(): string {
  return hostToken(hostname());
}

export function isMultiHostVault(vaultRoot: string): boolean {
  return existsSync(join(vaultRoot, layoutMarker));
}

export function vaultHost(vaultRoot: string): string | undefined {
  return isMultiHostVault(vaultRoot) ? localHost() : undefined;
}

export async function markMultiHostVault(vaultRoot: string): Promise<boolean> {
  if (isMultiHostVault(vaultRoot)) return false;
  await writeFileAtomic(join(vaultRoot, layoutMarker), `${JSON.stringify(perHostLayout)}\n`);
  await writeFileAtomic(join(vaultRoot, syncDir, ".gitignore"), "lease.json\n");
  return true;
}

export function hostDailyPath(date: string, host: string): string {
  return `${dailyDir}/${date}.${host}.md`;
}

export function hostAuditPath(host: string): string {
  return `curation.${host}.md`;
}

export function dailySegmentDate(fileName: string): string | undefined {
  return fileName.match(dailySegmentPattern)?.[1];
}

export function dailySegmentHost(fileName: string): string | undefined {
  return fileName.match(dailySegmentPattern)?.[2];
}

export function auditSegmentHost(fileName: string): string | undefined {
  return isAuditSegmentPath(fileName)
    ? fileName.slice("curation.".length, -".md".length)
    : undefined;
}

export function mergeDailySegments(segments: readonly DailySegment[]): PlacedDailyEntry[] {
  const placed = segments.flatMap((segment) =>
    segment.entries.map((entry, index) => ({ entry, path: segment.path, index })),
  );
  return segments.length > 1 ? placed.sort(byEntryTime) : placed;
}

export function mergeAuditSegments(segments: readonly AuditEntry[][]): AuditEntry[] {
  const entries = segments.flat();
  return segments.length > 1 ? entries.sort(byTimestamp) : entries;
}

export function segmentIndexes(
  placed: readonly PlacedDailyEntry[],
  merged: ReadonlySet<number>,
): Map<string, Set<number>> {
  const bySegment = new Map<string, Set<number>>();
  placed.forEach((item, mergedIndex) => {
    if (!merged.has(mergedIndex)) return;
    const indexes = bySegment.get(item.path) ?? new Set<number>();
    indexes.add(item.index);
    bySegment.set(item.path, indexes);
  });
  return bySegment;
}

const maxHostLength = 32;
const dailySegmentPattern = /^(\d{4}-\d{2}-\d{2})(?:\.([a-z0-9-]+))?\.md$/;

function byEntryTime(a: PlacedDailyEntry, b: PlacedDailyEntry): number {
  return a.entry.time.localeCompare(b.entry.time);
}

function byTimestamp(a: AuditEntry, b: AuditEntry): number {
  return a.timestamp.localeCompare(b.timestamp);
}
