import type { SkippedExtensionLayer } from "./discover.ts";
import type { ExtensionRegistrations, ExtensionStatus } from "./host.ts";

export interface ExtensionListing {
  statuses: readonly ExtensionStatus[];
  skipped: readonly SkippedExtensionLayer[];
  registrations(name: string): ExtensionRegistrations;
}

export interface ExtensionsSummary {
  active: number;
  quarantined: number;
  deactivated: number;
}

export const noExtensionsLine =
  "no extensions loaded · add one at .keywork/extensions/<name>.ts in the project or your home";

export function describeExtensions(listing: ExtensionListing): string[] {
  const lines = listing.statuses.length === 0 ? [noExtensionsLine] : tabulate(listing);
  return [...lines, ...listing.skipped.map(skippedLine)];
}

export function summarizeExtensions(statuses: readonly ExtensionStatus[]): ExtensionsSummary {
  const summary: ExtensionsSummary = { active: 0, quarantined: 0, deactivated: 0 };
  for (const status of statuses) summary[status.standing] += 1;
  return summary;
}

export function summaryLine(statuses: readonly ExtensionStatus[]): string {
  const { active, quarantined } = summarizeExtensions(statuses);
  const head = `${count(active, "extension")} active`;
  return quarantined === 0 ? head : `${head} · ${quarantined} quarantined`;
}

export function extensionLoadNotices(report: { statuses: readonly ExtensionStatus[] }): string[] {
  return report.statuses.flatMap((status) =>
    status.failure === undefined
      ? []
      : [
          `extension "${status.name}" quarantined during ${status.failure.phase}: ${status.failure.reason}`,
        ],
  );
}

function tabulate(listing: ExtensionListing): string[] {
  const rows = listing.statuses.map((status) => rowOf(status, listing.registrations(status.name)));
  const widths = columnWidths(rows);
  return [
    summaryLine(listing.statuses),
    ...rows.map(
      (row) =>
        `  ${row
          .map((cell, column) => cell.padEnd(widths[column] ?? 0))
          .join("  ")
          .trimEnd()}`,
    ),
  ];
}

function rowOf(status: ExtensionStatus, registrations: ExtensionRegistrations): string[] {
  return [status.name, status.source, status.standing, detailOf(status, registrations)];
}

function detailOf(status: ExtensionStatus, registrations: ExtensionRegistrations): string {
  if (status.failure !== undefined) return `${status.failure.phase}: ${status.failure.reason}`;
  if (status.standing !== "active") return "";
  const parts = [
    count(registrations.tools.length, "tool"),
    count(registrations.commands.length, "command"),
    ...(registrations.shortcuts.length === 0
      ? []
      : [count(registrations.shortcuts.length, "shortcut")]),
    ...(registrations.flags.length === 0 ? [] : [count(registrations.flags.length, "flag")]),
  ];
  return parts.join(" · ");
}

function skippedLine(layer: SkippedExtensionLayer): string {
  return `  ${layer.source} layer skipped · ${layer.dir} · ${layer.reason}`;
}

function columnWidths(rows: readonly string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return widths;
}

function count(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}
