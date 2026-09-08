import { readFile } from "node:fs/promises";
import { join } from "node:path";
import patternTable from "./guardrail-patterns.json" with { type: "json" };
import { type PathPredicate, repoRoot, reportViolations, walkRepo } from "./lib/repo-files.ts";

// ToS guardrail (docs/vision.md): Anthropic access is API-key / Agent-SDK only.

export type ScanKind = "code" | "prose";

export const patternFile = "scripts/guardrail-patterns.json";

export { patternTable };

export function findGuardrailViolations(content: string, kind: ScanKind = "code"): string[] {
  if (!screenFor(kind).test(content)) return [];
  return patternsFor(kind)
    .filter(({ pattern }) => pattern.test(content))
    .map(({ name }) => name);
}

export const scannedPath: PathPredicate = (path) =>
  scannedExtensions.test(path) && path !== patternFile;

export function scanKind(path: string): ScanKind {
  return path.endsWith(".md") ? "prose" : "code";
}

export async function scanGuardrails(root = repoRoot): Promise<string[]> {
  const violations: string[] = [];
  for (const path of await walkRepo(scannedPath, root)) {
    const content = await readFile(join(root, path), "utf8");
    for (const name of findGuardrailViolations(content, scanKind(path))) {
      violations.push(`${path}: ${name}`);
    }
  }
  return violations;
}

interface CompiledPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

const scannedExtensions = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|ya?ml|sh|ps1|md)$/;

const everywherePatterns = compile(patternTable.everywhere);
const codePatterns = [...everywherePatterns, ...compile(patternTable.codeOnly)];
// Bun 1.3.9 segfaults in JavaScriptCore's regex JIT once a dozen compiled patterns run per
// file; one case-insensitive alternation per kind screens first, and only screened-in
// content meets the individual patterns that name the violation.
const everywhereScreen = union(patternTable.everywhere);
const codeScreen = union([...patternTable.everywhere, ...patternTable.codeOnly]);

function union(entries: ReadonlyArray<{ pattern: string }>): RegExp {
  return new RegExp(entries.map(({ pattern }) => `(?:${pattern})`).join("|"), "i");
}

function screenFor(kind: ScanKind): RegExp {
  return kind === "prose" ? everywhereScreen : codeScreen;
}

function compile(
  entries: ReadonlyArray<{ name: string; pattern: string; flags: string }>,
): CompiledPattern[] {
  return entries.map(({ name, pattern, flags }) => ({ name, pattern: new RegExp(pattern, flags) }));
}

function patternsFor(kind: ScanKind): readonly CompiledPattern[] {
  return kind === "prose" ? everywherePatterns : codePatterns;
}

if (import.meta.main) {
  process.exitCode = reportViolations(
    {
      check: "check:guardrails",
      heading: "Guardrail violation: Anthropic is API-key / Agent-SDK only (see docs/vision.md):",
    },
    await scanGuardrails(),
  );
}
