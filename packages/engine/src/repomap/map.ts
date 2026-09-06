import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contextBudgetFor } from "../session/context-budget.ts";
import { extractSymbols, mappableFile, referencedIdentifiers } from "./extract.ts";
import { type IgnoreFileProblem, scanWorkspace } from "./scan.ts";

export interface RepoMapOptions {
  root: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface RepoMapFacts {
  files: number;
  symbols: number;
  ignoredPaths: number;
  truncated: boolean;
  stale: boolean;
  ignoreProblems: readonly IgnoreFileProblem[];
}

export const repoMapTokenCap = 2048;

export function repoMapTokenBudget(declaredWindow: number | undefined): number {
  const window = contextBudgetFor(declaredWindow).window;
  return Math.min(repoMapTokenCap, Math.floor(window / 32));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class RepoMap {
  private readonly root: string;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly cache = new Map<string, CachedFile>();
  private ranked: RankedFile[] = [];
  private ignoredPaths = 0;
  private truncated = false;
  private ignoreProblems: readonly IgnoreFileProblem[] = [];
  private built = false;
  private stale = false;
  private building: Promise<void> | undefined;

  constructor(options: RepoMapOptions) {
    this.root = options.root;
    this.maxFiles = options.maxFiles ?? 10_000;
    this.maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  }

  build(): Promise<void> {
    this.building ??= this.rebuild().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  markStale(): void {
    this.stale = true;
  }

  refreshIfStale(): Promise<void> {
    if (this.built && !this.stale) return Promise.resolve();
    return this.build();
  }

  serialize(tokenBudget: number): string {
    const lines = this.ranked.map(fileLine);
    for (let kept = lines.length; kept > 0; kept -= 1) {
      if (renderedChars(lines, kept) <= tokenBudget * 4) return render(lines, kept);
    }
    return "";
  }

  facts(): RepoMapFacts {
    return {
      files: this.ranked.length,
      symbols: this.ranked.reduce((total, file) => total + file.symbols.length, 0),
      ignoredPaths: this.ignoredPaths,
      truncated: this.truncated,
      stale: this.stale || !this.built,
      ignoreProblems: this.ignoreProblems,
    };
  }

  extractionCount(): number {
    let total = 0;
    for (const cached of this.cache.values()) total += cached.extractions;
    return total;
  }

  private async rebuild(): Promise<void> {
    this.stale = false;
    const scan = await scanWorkspace(this.root, { maxFiles: this.maxFiles, keep: mappableFile });
    const seen = new Set<string>();
    for (const file of scan.files) {
      seen.add(file.path);
      await this.refreshEntry(file.path, file.size, file.mtimeMs);
    }
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    this.ranked = rankFiles(this.cache);
    this.ignoredPaths = scan.ignoredPaths;
    this.truncated = scan.truncated;
    this.ignoreProblems = scan.ignoreProblems;
    this.built = true;
  }

  private async refreshEntry(path: string, size: number, mtimeMs: number): Promise<void> {
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) return;
    const entry = await this.extractEntry(path, size, mtimeMs, cached?.extractions ?? 0);
    if (entry === undefined) this.cache.delete(path);
    else this.cache.set(path, entry);
  }

  private async extractEntry(
    path: string,
    size: number,
    mtimeMs: number,
    priorExtractions: number,
  ): Promise<CachedFile | undefined> {
    if (size > this.maxFileBytes) {
      return { size, mtimeMs, symbols: [], references: new Set(), extractions: priorExtractions };
    }
    const content = await readFile(join(this.root, path), "utf8").catch(() => undefined);
    if (content === undefined || content.includes("\u0000")) return undefined;
    return {
      size,
      mtimeMs,
      symbols: extractSymbols(path, content),
      references: referencedIdentifiers(content),
      extractions: priorExtractions + 1,
    };
  }
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  symbols: string[];
  references: Set<string>;
  extractions: number;
}

interface RankedFile {
  path: string;
  symbols: string[];
  weight: number;
}

const symbolsPerLine = 12;

function rankFiles(cache: ReadonlyMap<string, CachedFile>): RankedFile[] {
  const referenceCounts = countReferences(cache);
  const ranked: RankedFile[] = [];
  for (const [path, entry] of cache) {
    if (entry.symbols.length === 0) continue;
    const weighted = entry.symbols
      .map((symbol) => ({ symbol, weight: referenceCounts.get(symbol) ?? 0 }))
      .sort((left, right) => right.weight - left.weight);
    ranked.push({
      path,
      symbols: weighted.map(({ symbol }) => symbol),
      weight: weighted.reduce((total, { weight }) => total + weight, 0),
    });
  }
  return ranked.sort(
    (left, right) => right.weight - left.weight || left.path.localeCompare(right.path),
  );
}

function countReferences(cache: ReadonlyMap<string, CachedFile>): Map<string, number> {
  const defined = new Map<string, Set<string>>();
  for (const [path, entry] of cache) {
    for (const symbol of entry.symbols) {
      const definers = defined.get(symbol) ?? new Set();
      definers.add(path);
      defined.set(symbol, definers);
    }
  }
  const counts = new Map<string, number>();
  for (const [symbol, definers] of defined) {
    let referencing = 0;
    for (const [path, entry] of cache) {
      if (!definers.has(path) && entry.references.has(symbol)) referencing += 1;
    }
    counts.set(symbol, referencing);
  }
  return counts;
}

function fileLine({ path, symbols }: RankedFile): string {
  const shown = symbols.slice(0, symbolsPerLine);
  const hidden = symbols.length - shown.length;
  const tail = hidden > 0 ? ` +${hidden}` : "";
  return `${path}: ${shown.join(", ")}${tail}`;
}

function render(lines: readonly string[], kept: number): string {
  const omitted = lines.length - kept;
  const body = lines.slice(0, kept);
  return omitted > 0 ? [...body, omissionTail(omitted)].join("\n") : body.join("\n");
}

function renderedChars(lines: readonly string[], kept: number): number {
  const omitted = lines.length - kept;
  let chars = kept - 1 + (omitted > 0 ? omissionTail(omitted).length + 1 : 0);
  for (let index = 0; index < kept; index += 1) chars += (lines[index] as string).length;
  return chars;
}

function omissionTail(omitted: number): string {
  return `… ${omitted} more files`;
}
