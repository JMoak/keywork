import { readdirSync } from "node:fs";
import { join, parse } from "node:path";

export const globEntryLimit = 2_000;

export function hasGlob(path: string): boolean {
  return globCharacters.test(path);
}

export function globReach(pattern: string, limit = globEntryLimit): string[] | undefined {
  const { root } = parse(pattern);
  let reached = [root];
  let listed = 0;
  for (const segment of segmentsOf(pattern.slice(root.length))) {
    if (!hasGlob(segment)) {
      reached = reached.map((dir) => join(dir, segment));
      continue;
    }
    const matches = reachableBy(segment);
    const entries = reached.flatMap((dir) => entriesOf(dir).map((name) => ({ dir, name })));
    listed += entries.length;
    if (listed > limit) return undefined;
    reached = entries.filter(({ name }) => matches(name)).map(({ dir, name }) => join(dir, name));
  }
  return reached;
}

const globCharacters = /[*?[]/;

function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/).filter((segment) => segment !== "");
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function reachableBy(segment: string): (name: string) => boolean {
  if (segment.includes("[")) return everyEntry;
  const source = [...segment].map(wildcardSource).join("");
  const pattern = new RegExp(`^${source}$`, "is");
  return (name) => pattern.test(name);
}

function everyEntry(): boolean {
  return true;
}

function wildcardSource(character: string): string {
  if (character === "*") return ".*";
  if (character === "?") return ".";
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
