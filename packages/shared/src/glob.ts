export interface Glob {
  readonly pattern: string;
  readonly specificity: number;
  readonly test: (value: string) => boolean;
}

export interface GlobRule<T> {
  readonly glob: Glob;
  readonly value: T;
}

export function compileGlob(pattern: string): Glob {
  const matcher = globRegExp(pattern);
  return {
    pattern,
    specificity: literalLength(pattern),
    test: (value) => matcher.test(value),
  };
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

const wildcardSpanningNewlines = "[\\s\\S]*";

function globRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join(wildcardSpanningNewlines);
  return new RegExp(`^${source}$`);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}
