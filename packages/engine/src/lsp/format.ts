import { relative } from "node:path";
import type { Diagnostic } from "./port.ts";

export function diagnosticsBlock(
  language: string,
  diagnostics: readonly Diagnostic[],
  cwd: string,
): string | undefined {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return undefined;
  const warnings = diagnostics.length - errors.length;
  const header = [
    `diagnostics (${language})`,
    plural(errors.length, "error"),
    ...(warnings === 0 ? [] : [plural(warnings, "warning")]),
  ].join(" · ");
  const rows = errors.map(
    (error) =>
      `${displayPath(error.path, cwd)}:${error.line}:${error.column} · ${firstLine(error.message)}`,
  );
  return [header, ...rows].join("\n");
}

function displayPath(path: string, cwd: string): string {
  const related = relative(cwd, path);
  const chosen = related === "" || related.startsWith("..") ? path : related;
  return chosen.replaceAll("\\", "/");
}

function firstLine(message: string): string {
  return message.split("\n")[0]?.trim() ?? "";
}

function plural(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}
