export interface Glob {
  readonly pattern: string;
  readonly specificity: number;
  readonly test: (value: string) => boolean;
}

export interface GlobRule<T> {
  readonly glob: Glob;
  readonly value: T;
}

export interface PathGlobOptions {
  readonly caseInsensitive?: boolean;
}

export function compileGlob(pattern: string): Glob {
  return globOver(pattern, anchored(wildcardSource(pattern)));
}

export function commandGlob(pattern: string): Glob {
  if (!pattern.endsWith(optionalArgumentsSuffix)) return compileGlob(pattern);
  const command = wildcardSource(pattern.slice(0, -optionalArgumentsSuffix.length));
  return globOver(pattern, anchored(`${command}(?: ${anyRun})?`));
}

export function pathGlob(pattern: string, options: PathGlobOptions = {}): Glob {
  const slashed = forwardSlashes(pattern);
  const source = slashed.split(anyDirectoriesSegment).map(wildcardSource).join(anyDirectories);
  return globOver(pattern, anchored(source, options.caseInsensitive === true ? "i" : ""));
}

export function forwardSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

export function globMatches(pattern: string, value: string): boolean {
  return compileGlob(pattern).test(value);
}

export function globRules<T>(patterns: Readonly<Record<string, T>>): GlobRule<T>[] {
  return Object.entries(patterns).map(([pattern, value]) => ({
    glob: compileGlob(pattern),
    value,
  }));
}

export function mostSpecificMatch<T>(
  patterns: Readonly<Record<string, T>> | undefined,
  value: string | undefined,
): T | undefined {
  if (patterns === undefined || value === undefined) return undefined;
  const matching = globRules(patterns).filter((rule) => rule.glob.test(value));
  return mostSpecificRule(matching)?.value;
}

export function mostSpecificRule<T>(rules: readonly GlobRule<T>[]): GlobRule<T> | undefined {
  return rules.reduce<GlobRule<T> | undefined>(
    (winner, rule) =>
      winner === undefined || rule.glob.specificity > winner.glob.specificity ? rule : winner,
    undefined,
  );
}

const anyRun = "[\\s\\S]*";
const anyDirectories = "(?:[\\s\\S]*/)?";
const anyDirectoriesSegment = /\*\*\//;
const optionalArgumentsSuffix = " *";

function globOver(pattern: string, matcher: RegExp): Glob {
  return {
    pattern,
    specificity: literalLength(pattern),
    test: (value) => matcher.test(value),
  };
}

function anchored(source: string, flags = ""): RegExp {
  return new RegExp(`^${source}$`, flags);
}

function wildcardSource(pattern: string): string {
  return pattern.split("*").map(escapeRegExp).join(anyRun);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}
