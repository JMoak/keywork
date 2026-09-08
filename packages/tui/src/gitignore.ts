export type EntryKind = "file" | "dir";

export interface IgnoreRule {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  matches(relativePath: string): boolean;
}

export class IgnoreRules {
  private files: IgnoreFile[] = [];

  add(directory: string, gitignoreText: string): void {
    const file = { directory: normalizeDirectory(directory), rules: parseGitignore(gitignoreText) };
    this.files = [...this.files.filter((known) => known.directory !== file.directory), file].sort(
      (left, right) => depthOf(left.directory) - depthOf(right.directory),
    );
  }

  clear(): void {
    this.files = [];
  }

  ignores(path: string, kind: EntryKind): boolean {
    let verdict = false;
    for (const { directory, rules } of this.files) {
      const relative = within(directory, path);
      if (relative === undefined) continue;
      for (const rule of rules) {
        if (rule.directoryOnly && kind !== "dir") continue;
        if (rule.matches(relative)) verdict = !rule.negated;
      }
    }
    return verdict;
  }

  ignoresWithin(path: string, kind: EntryKind): boolean {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      if (this.ignores(segments.slice(0, depth).join("/"), "dir")) return true;
    }
    return this.ignores(path, kind);
  }
}

interface IgnoreFile {
  readonly directory: string;
  readonly rules: IgnoreRule[];
}

export function parseGitignore(text: string): IgnoreRule[] {
  return text
    .split(/\r?\n/)
    .map(ruleOf)
    .filter((rule): rule is IgnoreRule => rule !== undefined);
}

function ruleOf(line: string): IgnoreRule | undefined {
  const trimmed = trimUnescapedTrailingSpaces(line);
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const negated = trimmed.startsWith("!");
  const body = negated ? trimmed.slice(1) : trimmed;
  const directoryOnly = body.endsWith("/") && !body.endsWith("\\/");
  const pattern = directoryOnly ? body.slice(0, -1) : body;
  if (pattern === "") return undefined;
  const anchored = pattern.includes("/");
  const source = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const regex = new RegExp(`${anchored ? "^" : "(?:^|.*/)"}${regexBodyOf(source)}$`);
  return { negated, directoryOnly, matches: (relativePath) => regex.test(relativePath) };
}

function regexBodyOf(pattern: string): string {
  let out = "";
  let at = 0;
  while (at < pattern.length) {
    const rest = pattern.slice(at);
    const token = tokens.find(({ literal }) => rest.startsWith(literal));
    if (token !== undefined) {
      out += token.regex;
      at += token.literal.length;
      continue;
    }
    const character = pattern[at] as string;
    if (character === "\\" && at + 1 < pattern.length) {
      out += escapeRegExp(pattern[at + 1] as string);
      at += 2;
    } else if (character === "[") {
      const closing = pattern.indexOf("]", at + 1);
      out += closing === -1 ? "\\[" : characterClass(pattern.slice(at + 1, closing));
      at = closing === -1 ? at + 1 : closing + 1;
    } else {
      out += escapeRegExp(character);
      at += 1;
    }
  }
  return out;
}

const tokens: ReadonlyArray<{ literal: string; regex: string }> = [
  { literal: "/**/", regex: "/(?:.*/)?" },
  { literal: "**/", regex: "(?:.*/)?" },
  { literal: "/**", regex: "/.*" },
  { literal: "**", regex: ".*" },
  { literal: "*", regex: "[^/]*" },
  { literal: "?", regex: "[^/]" },
];

function characterClass(inner: string): string {
  const negated = inner.startsWith("!") || inner.startsWith("^");
  const members = (negated ? inner.slice(1) : inner).replace(/[\\\]]/g, "\\$&");
  return `[${negated ? "^" : ""}${members}]`;
}

function trimUnescapedTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end -= 1;
  return line.slice(0, end);
}

function normalizeDirectory(directory: string): string {
  const slashed = directory.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return slashed === "." ? "" : slashed;
}

function depthOf(directory: string): number {
  return directory === "" ? 0 : directory.split("/").length;
}

function within(directory: string, path: string): string | undefined {
  if (directory === "") return path;
  const prefix = `${directory}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
