import { type ArcSummary, activeFirst, isArcSlug } from "./arcs.ts";
import { fuzzyScore } from "./commands.ts";
import type { Chord } from "./keys.ts";
import { type PickerKeyOutcome, pickerIntentOf } from "./picker-keys.ts";

type ArcPickerSeed =
  | { kind: "release" }
  | { kind: "arc"; arc: ArcSummary; sessions: number; current: boolean }
  | { kind: "create"; slug: string };

export type ArcPickerRow = ArcPickerSeed & { selected: boolean };

export type ArcPickerChoice =
  | { kind: "release" }
  | { kind: "bind"; slug: string }
  | { kind: "archived"; slug: string }
  | { kind: "create"; slug: string };

export class ArcPicker {
  query = "";
  private index: number;

  constructor(
    private readonly arcs: readonly ArcSummary[],
    readonly current: string | undefined,
  ) {
    const at = this.unselectedRows().findIndex((row) => row.kind === "arc" && row.current);
    this.index = Math.max(0, at);
  }

  rows(): ArcPickerRow[] {
    const rows = this.unselectedRows();
    const selectedAt = Math.min(this.index, Math.max(0, rows.length - 1));
    return rows.map((row, at) => ({ ...row, selected: at === selectedAt }));
  }

  selected(): ArcPickerChoice | undefined {
    const row = this.rows().find((candidate) => candidate.selected);
    if (row === undefined) return undefined;
    switch (row.kind) {
      case "release":
        return { kind: "release" };
      case "create":
        return { kind: "create", slug: row.slug };
      case "arc":
        return row.arc.status === "active"
          ? { kind: "bind", slug: row.arc.slug }
          : { kind: "archived", slug: row.arc.slug };
    }
  }

  select(at: number): void {
    this.index = Math.max(0, Math.min(at, this.unselectedRows().length - 1));
  }

  paste(text: string): void {
    this.retype(this.query + text);
  }

  handleKey(chord: Chord, sequence: string | undefined): PickerKeyOutcome {
    const intent = pickerIntentOf(chord, sequence);
    switch (intent.kind) {
      case "close":
        return "close";
      case "choose":
        return "choose";
      case "move":
        this.move(intent.step);
        return "stay";
      case "erase":
        this.retype(this.query.slice(0, -1));
        return "stay";
      case "type":
        this.retype(this.query + intent.text);
        return "stay";
      case "ignore":
        return "stay";
    }
  }

  private unselectedRows(): ArcPickerSeed[] {
    const needle = this.query.trim().toLowerCase();
    const matching = activeFirst(this.arcs)
      .map((arc) => ({ arc, score: needle === "" ? 0 : fuzzyScore(needle, arc.slug) }))
      .filter((entry): entry is { arc: ArcSummary; score: number } => entry.score !== undefined);
    const active = matching.filter(({ arc }) => arc.status === "active");
    const archived = matching.filter(({ arc }) => arc.status === "archived");
    const sorted = (entries: { arc: ArcSummary; score: number }[]) =>
      needle === "" ? entries : [...entries].sort((left, right) => right.score - left.score);
    return [
      ...(this.current !== undefined && needle === "" ? [{ kind: "release" as const }] : []),
      ...sorted(active).map(({ arc }) => this.arcRow(arc)),
      ...this.createRow(needle),
      ...sorted(archived).map(({ arc }) => this.arcRow(arc)),
    ];
  }

  private arcRow(arc: ArcSummary): ArcPickerSeed {
    return { kind: "arc", arc, sessions: arc.sessions, current: arc.slug === this.current };
  }

  private createRow(needle: string): ArcPickerSeed[] {
    if (needle === "" || !isArcSlug(needle)) return [];
    if (this.arcs.some((arc) => arc.slug === needle)) return [];
    return [{ kind: "create", slug: needle }];
  }

  private move(step: number): void {
    const count = Math.max(1, this.unselectedRows().length);
    this.index = (this.index + step + count) % count;
  }

  private retype(query: string): void {
    this.query = query;
    this.index = 0;
  }
}

export function describeArcRow(row: ArcPickerRow): string {
  switch (row.kind) {
    case "release":
      return "no arc · release this session";
    case "create":
      return `new arc ${row.slug}`;
    case "arc": {
      const facts = [
        row.arc.slug,
        row.arc.status === "archived" ? "archived" : sessionsFact(row.sessions),
        ...(row.current ? ["current"] : []),
      ];
      return facts.join(" · ");
    }
  }
}

function sessionsFact(count: number): string {
  if (count === 0) return "no sessions";
  return count === 1 ? "1 session" : `${count} sessions`;
}
