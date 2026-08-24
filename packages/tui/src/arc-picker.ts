import { type ArcSummary, activeFirst, isArcSlug } from "./arcs.ts";
import { FilterPicker } from "./filter-picker.ts";
import { rankByFuzzy } from "./picker-keys.ts";
import { pluralize } from "./pluralize.ts";

export type ArcPickerRow = { kind: "release" } | ArcRow | { kind: "create"; slug: string };

export interface ArcRow {
  kind: "arc";
  arc: ArcSummary;
  current: boolean;
}

export type ArcPickerChoice =
  | { kind: "release" }
  | { kind: "bind"; slug: string }
  | { kind: "archived"; slug: string }
  | { kind: "create"; slug: string };

export type ArcPicker = FilterPicker<ArcPickerRow>;

export function arcPickerOver(arcs: readonly ArcSummary[], current: string | undefined): ArcPicker {
  return new FilterPicker(
    (needle) => arcRows(arcs, current, needle),
    (row) => row.kind === "arc" && row.current,
  );
}

export function arcChoiceOf(row: ArcPickerRow): ArcPickerChoice {
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

export function describeArcRow(row: ArcPickerRow): string {
  switch (row.kind) {
    case "release":
      return "no arc · release this session";
    case "create":
      return `new arc ${row.slug}`;
    case "arc": {
      const { slug, facts } = arcRowParts(row);
      return slug + facts;
    }
  }
}

export function arcRowParts(row: ArcRow): { slug: string; facts: string } {
  const facts = [
    row.arc.status === "archived" ? "archived" : sessionsFact(row.arc.sessions),
    ...(row.current ? ["current"] : []),
  ];
  return { slug: row.arc.slug, facts: facts.map((fact) => ` · ${fact}`).join("") };
}

function arcRows(
  arcs: readonly ArcSummary[],
  current: string | undefined,
  needle: string,
): ArcPickerRow[] {
  const matching = rankByFuzzy(activeFirst(arcs), needle, (arc) => arc.slug);
  const rowOf = (arc: ArcSummary): ArcRow => ({ kind: "arc", arc, current: arc.slug === current });
  return [
    ...(current !== undefined && needle === "" ? [{ kind: "release" as const }] : []),
    ...matching.filter((arc) => arc.status === "active").map(rowOf),
    ...createRow(arcs, needle),
    ...matching.filter((arc) => arc.status === "archived").map(rowOf),
  ];
}

function createRow(arcs: readonly ArcSummary[], needle: string): ArcPickerRow[] {
  if (needle === "" || !isArcSlug(needle)) return [];
  if (arcs.some((arc) => arc.slug === needle)) return [];
  return [{ kind: "create", slug: needle }];
}

function sessionsFact(count: number): string {
  return count === 0 ? "no sessions" : pluralize(count, "session");
}
