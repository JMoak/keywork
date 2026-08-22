import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kebabCase } from "./artifacts.ts";
import { applyMasks, defaultMasks, diffFrames } from "./mask.ts";

export const committedGoldenRoot = fileURLToPath(new URL("goldens", import.meta.url));

export function goldenPath(goldenRoot: string, scenarioName: string, stepName: string): string {
  return join(goldenRoot, scenarioName, `${kebabCase(stepName)}.txt`);
}

export function writeGolden(path: string, frame: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, maskedFrame(frame));
}

export function verifyGolden(path: string, frame: string): void {
  if (!existsSync(path)) {
    throw new Error(`golden missing: ${path}; rerun with --update-goldens to record it`);
  }
  const expected = maskedFrame(readFileSync(path, "utf8"));
  const mismatch = diffFrames(expected, maskedFrame(frame));
  if (mismatch !== undefined) throw new Error(`golden mismatch: ${path}\n${mismatch}`);
}

export function pruneGoldens(
  goldenRoot: string,
  scenarioName: string,
  keptSteps: readonly string[],
): string[] {
  const kept = new Set(keptSteps.map(kebabCase));
  const orphans = goldenSteps(join(goldenRoot, scenarioName)).filter((step) => !kept.has(step));
  for (const step of orphans) rmSync(goldenPath(goldenRoot, scenarioName, step));
  return orphans;
}

export function goldenTree(goldenRoot: string): Record<string, string[]> {
  if (!existsSync(goldenRoot)) return {};
  return Object.fromEntries(
    readdirSync(goldenRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry): [string, string[]] => [entry.name, goldenSteps(join(goldenRoot, entry.name))])
      .filter(([, steps]) => steps.length > 0),
  );
}

function goldenSteps(scenarioDir: string): string[] {
  if (!existsSync(scenarioDir)) return [];
  return readdirSync(scenarioDir)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => basename(name, ".txt"))
    .sort();
}

function maskedFrame(text: string): string {
  return applyMasks(text.replaceAll("\r\n", "\n"), defaultMasks);
}
