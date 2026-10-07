import type { MarkdownSpan } from "./markdown.ts";
import type { ToolRun, TranscriptEntry } from "./transcript-feed.ts";

export type Verbosity = "low" | "medium" | "high";

export const defaultVerbosity: Verbosity = "medium";

export interface ToolGroup {
  readonly kind: "reads" | "tools";
  readonly runs: readonly ToolRun[];
}

export type GroupRole =
  | { readonly role: "head"; readonly group: ToolGroup }
  | { readonly role: "member" };

export type ToolGrouping = ReadonlyMap<number, GroupRole>;

export function nextVerbosity(level: Verbosity): Verbosity {
  return cycle[(cycle.indexOf(level) + 1) % cycle.length] ?? defaultVerbosity;
}

export function toolGroups(
  entries: readonly TranscriptEntry[],
  verbosity: Verbosity,
): ToolGrouping {
  const grouping = new Map<number, GroupRole>();
  if (verbosity === "high") return grouping;
  const joins = verbosity === "low" ? isTool : isRead;
  let at = 0;
  while (at < entries.length) {
    const end = runEnd(entries, at, joins);
    if (end - at >= minimumGroup) {
      const runs = entries.slice(at, end).flatMap(runOf);
      grouping.set(at, {
        role: "head",
        group: { kind: verbosity === "low" ? "tools" : "reads", runs },
      });
      for (let member = at + 1; member < end; member += 1) grouping.set(member, { role: "member" });
    }
    at = Math.max(end, at + 1);
  }
  return grouping;
}

export function groupRowSpans(group: ToolGroup): MarkdownSpan[] {
  return [{ text: groupHead(group), tone: "body" }, ...outcomeSpans(group.runs)];
}

export function groupSignature(role: GroupRole | undefined): string {
  if (role === undefined) return "";
  if (role.role === "member") return "member";
  return `${role.group.kind}:${role.group.runs.map((run) => run.outcome ?? "running").join(",")}`;
}

const cycle: readonly Verbosity[] = ["low", "medium", "high"];
const minimumGroup = 2;

function runEnd(
  entries: readonly TranscriptEntry[],
  from: number,
  joins: (run: ToolRun) => boolean,
): number {
  let end = from;
  while (end < entries.length) {
    const run = runOf(entries[end] as TranscriptEntry)[0];
    if (run === undefined || !joins(run)) break;
    end += 1;
  }
  return end;
}

function runOf(entry: TranscriptEntry): ToolRun[] {
  return entry.kind === "tool" && entry.run !== undefined ? [entry.run] : [];
}

function isTool(run: ToolRun): boolean {
  return run.provenance === undefined || run.provenance === "agent";
}

function isRead(run: ToolRun): boolean {
  return isTool(run) && run.name === "read";
}

function groupHead(group: ToolGroup): string {
  const count = group.runs.length;
  if (group.kind === "reads") {
    return `read ${count} files: ${group.runs.map((run) => run.subject || "?").join(", ")}`;
  }
  return `${count} tools: ${tally(group.runs)}`;
}

function tally(runs: readonly ToolRun[]): string {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} ${count}`).join(", ");
}

function outcomeSpans(runs: readonly ToolRun[]): MarkdownSpan[] {
  if (runs.some((run) => run.outcome === undefined)) return [{ text: " · running", tone: "meta" }];
  const failed = runs.filter((run) => run.outcome === "failed").length;
  return [
    { text: " · ", tone: "meta" },
    failed === 0 ? { text: "done", tone: "ok" } : { text: `${failed} failed`, tone: "bad" },
  ];
}
