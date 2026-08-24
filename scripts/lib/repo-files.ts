import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const excludedDirectories: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  "artifacts",
]);

export type PathPredicate = (relativePath: string) => boolean;

export interface CheckLabel {
  readonly check: string;
  readonly heading: string;
  readonly scanned?: string;
}

export async function walkRepo(keep: PathPredicate, root = repoRoot): Promise<string[]> {
  const found = await walk(root, root, keep);
  return found.sort();
}

export function reportViolations(label: CheckLabel, violations: readonly string[]): number {
  if (violations.length === 0) {
    console.log(
      label.scanned === undefined ? `${label.check} ok` : `${label.check} ok (${label.scanned})`,
    );
    return 0;
  }
  console.error(label.heading);
  for (const violation of violations) console.error(`  ${violation}`);
  return 1;
}

async function walk(root: string, dir: string, keep: PathPredicate): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return excludedDirectories.has(entry.name) ? [] : walk(root, path, keep);
      }
      const relativePath = relative(root, path).split(sep).join("/");
      return entry.isFile() && keep(relativePath) ? [relativePath] : [];
    }),
  );
  return nested.flat();
}
