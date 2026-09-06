export interface IgnorePattern {
  readonly source: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly matches: (relativePath: string) => boolean;
}

export interface IgnoreProblem {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

export interface IgnoreFile {
  readonly patterns: readonly IgnorePattern[];
  readonly problems: readonly IgnoreProblem[];
}

export interface IgnoreLayer {
  readonly base: string;
  readonly patterns: readonly IgnorePattern[];
}

export function parseIgnoreFile(text: string): IgnoreFile {
  const patterns: IgnorePattern[] = [];
  const problems: IgnoreProblem[] = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = trimIgnoreLine(rawLine);
    if (line === "" || line.startsWith("#")) return;
    const parsed = compileIgnorePattern(line);
    if ("reason" in parsed) problems.push({ line: index + 1, text: line, reason: parsed.reason });
    else patterns.push(parsed);
  });
  return { patterns, problems };
}

export function ignoreVerdict(
  layers: readonly IgnoreLayer[],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;
  for (const layer of layers) {
    const scoped = pathWithinBase(layer.base, relativePath);
    if (scoped === undefined) continue;
    for (const pattern of layer.patterns) {
      if (pattern.directoryOnly && !isDirectory) continue;
      if (pattern.matches(scoped)) ignored = !pattern.negated;
    }
  }
  return ignored;
}

export function ignoresPath(
  layers: readonly IgnoreLayer[],
  relativePath: string,
  isDirectory = false,
): boolean {
  const segments = relativePath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (ignoreVerdict(layers, segments.slice(0, depth).join("/"), true)) return true;
  }
  return ignoreVerdict(layers, relativePath, isDirectory);
}

function trimIgnoreLine(rawLine: string): string {
  return rawLine.replace(/\r$/, "").replace(/(?<!\\) +$/, "");
}

function pathWithinBase(base: string, path: string): string | undefined {
  if (base === "") return path;
  if (path === base) return undefined;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined;
}

function compileIgnorePattern(line: string): IgnorePattern | { reason: string } {
  const negated = line.startsWith("!");
  let body = negated ? line.slice(1) : line;
  const directoryOnly = body.endsWith("/") && !body.endsWith("\\/");
  if (directoryOnly) body = body.slice(0, -1);
  if (body === "") return { reason: "pattern is empty" };
  const anchored = body.startsWith("/") || body.slice(0, -1).includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  const translated = translateToRegExp(body);
  if ("reason" in translated) return translated;
  const matcher = new RegExp(`^${anchored ? "" : anyDepthPrefix}${translated.source}$`);
  return { source: line, negated, directoryOnly, matches: (path) => matcher.test(path) };
}

const anyDepthPrefix = "(?:[^/]+/)*";

function translateToRegExp(body: string): { source: string } | { reason: string } {
  let source = "";
  let at = 0;
  while (at < body.length) {
    const step = translateNext(body, at);
    if ("reason" in step) return step;
    source += step.source;
    at = step.next;
  }
  return { source };
}

type TranslateStep = { source: string; next: number } | { reason: string };

function translateNext(body: string, at: number): TranslateStep {
  const char = body[at] as string;
  if (char === "\\") return translateEscape(body, at);
  if (char === "[") return translateClass(body, at);
  if (char === "*") return translateStars(body, at);
  if (char === "?") return { source: "[^/]", next: at + 1 };
  return { source: escapeRegExpChar(char), next: at + 1 };
}

function translateEscape(body: string, at: number): TranslateStep {
  const escaped = body[at + 1];
  if (escaped === undefined) return { reason: "trailing backslash escapes nothing" };
  return { source: escapeRegExpChar(escaped), next: at + 2 };
}

function translateClass(body: string, at: number): TranslateStep {
  let inner = "";
  let scan = at + 1;
  if (body[scan] === "!" || body[scan] === "^") {
    inner = "^";
    scan += 1;
  }
  if (body[scan] === "]") {
    inner += "\\]";
    scan += 1;
  }
  while (scan < body.length && body[scan] !== "]") {
    const char = body[scan] as string;
    inner += char === "\\" || char === "^" ? `\\${char}` : char;
    scan += 1;
  }
  if (scan >= body.length) return { reason: "character class is never closed" };
  return { source: `[${inner}]`, next: scan + 1 };
}

function translateStars(body: string, at: number): TranslateStep {
  let run = at;
  while (body[run] === "*") run += 1;
  const stars = run - at;
  if (stars < 2) return { source: "[^/]*", next: run };
  const leadsSegment = at === 0 || body[at - 1] === "/";
  if (leadsSegment && body[run] === "/") return { source: anyDepthPrefix, next: run + 1 };
  if (leadsSegment && run === body.length) {
    return { source: at === 0 ? ".+" : ".*", next: run };
  }
  return { source: "[^/]*", next: run };
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}
