export type FrontmatterValue = string | number | boolean | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
}

export class MalformedFrontmatterError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`malformed frontmatter in ${file}: ${detail}`);
    this.name = "MalformedFrontmatterError";
  }
}

export function parseDocument(raw: string, file: string): ParsedDocument {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return { frontmatter: {}, body: raw };
  const lines = raw.split(/\r?\n/);
  const closing = lines.indexOf("---", 1);
  if (closing === -1) throw new MalformedFrontmatterError(file, "unterminated frontmatter block");
  return {
    frontmatter: parseBlock(lines.slice(1, closing), file),
    body: lines.slice(closing + 1).join("\n"),
  };
}

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return body;
  const lines = entries.map(([key, value]) => `${key}: ${serializeValue(value)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function serializeValue(value: FrontmatterValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  return String(value);
}

function parseBlock(lines: string[], file: string): Frontmatter {
  const frontmatter: Frontmatter = {};
  let openList: string[] | undefined;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item !== null) {
      if (openList === undefined)
        throw new MalformedFrontmatterError(file, `list item without a key: ${line.trim()}`);
      openList.push(parseScalarString(item[1] ?? "", file));
      continue;
    }
    const entry = line.match(/^([A-Za-z0-9_][\w-]*):(?:\s+(.*))?$/);
    if (entry === null || entry[1] === undefined)
      throw new MalformedFrontmatterError(file, `unparseable line: ${line.trim()}`);
    const key = entry[1];
    if (key in frontmatter) throw new MalformedFrontmatterError(file, `duplicate key ${key}`);
    const rest = entry[2]?.trim() ?? "";
    if (rest === "") {
      const list: string[] = [];
      frontmatter[key] = list;
      openList = list;
      continue;
    }
    frontmatter[key] = parseValue(rest, file);
    openList = undefined;
  }
  return frontmatter;
}

function parseValue(raw: string, file: string): FrontmatterValue {
  if (raw.startsWith("[")) return parseInlineList(raw, file);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return parseScalarString(raw, file);
}

function parseInlineList(raw: string, file: string): string[] {
  if (!raw.endsWith("]")) throw new MalformedFrontmatterError(file, `unterminated list: ${raw}`);
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  return splitListItems(inner, file).map((item) => parseScalarString(item, file));
}

function splitListItems(inner: string, file: string): string[] {
  const items: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] as string;
    if (quoted && char === "\\") {
      current += char + (inner[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quoted) throw new MalformedFrontmatterError(file, `unterminated quote in list: ${inner}`);
  items.push(current.trim());
  return items;
}

function parseScalarString(raw: string, file: string): string {
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") throw new Error("not a string");
    return parsed;
  } catch {
    throw new MalformedFrontmatterError(file, `bad quoted string: ${raw}`);
  }
}
