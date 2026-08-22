import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot, reportViolations, walkRepo } from "./lib/repo-files.ts";

export const emDash = String.fromCodePoint(0x2014);

export function findEmDashes(content: string): string[] {
  return content
    .split("\n")
    .flatMap((line, index) => columnsOf(emDash, line).map((column) => `${index + 1}:${column}`));
}

export async function scanProse(root = repoRoot): Promise<string[]> {
  const violations: string[] = [];
  for (const path of await walkRepo(() => true, root)) {
    const content = await readFile(join(root, path), "utf8");
    for (const position of findEmDashes(content)) violations.push(`${path}:${position}`);
  }
  return violations;
}

function columnsOf(needle: string, line: string): number[] {
  const columns: number[] = [];
  for (let at = line.indexOf(needle); at !== -1; at = line.indexOf(needle, at + 1)) {
    columns.push(at + 1);
  }
  return columns;
}

if (import.meta.main) {
  process.exitCode = reportViolations(
    {
      check: "check:prose",
      heading: "Em dashes (U+2014) are not allowed anywhere in the tree; rewrite the sentence:",
    },
    await scanProse(),
  );
}
