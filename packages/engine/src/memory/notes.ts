import { type Frontmatter, MalformedFrontmatterError, parseDocument } from "./frontmatter.ts";
import { InvalidTitleError } from "./naming.ts";

export const provenances = ["user", "agent", "untrusted"] as const;
export type Provenance = (typeof provenances)[number];

export interface Note {
  name: string;
  path: string;
  title: string;
  provenance: Provenance;
  pinned: boolean;
  aliases: string[];
  body: string;
  links: string[];
  tokens: number;
  frontmatter: Frontmatter;
  created?: string;
  confidence?: number;
  usefulness?: number;
  supersedes?: string;
  supersededBy?: string;
  delivered?: string;
  distilledFrom?: string;
  learnedBy?: string;
}

export interface DailyEntry {
  time: string;
  provenance: Provenance;
  text: string;
}

export type NoteWriteTarget = { title: string } | { entity: string };

export class InvalidDailyDateError extends Error {
  constructor(readonly date: string) {
    super(`invalid daily log date ${JSON.stringify(date)}: expected YYYY-MM-DD`);
    this.name = "InvalidDailyDateError";
  }
}

export const entitiesDir = "entities";

export function parseNote(path: string, raw: string): Note | undefined {
  const { frontmatter, body } = parseDocument(raw, path);
  if (frontmatter.staged === true) return undefined;
  const created = firstString(frontmatter.created);
  const confidence = frontmatter.confidence;
  const usefulness = frontmatter.usefulness;
  const supersedes = wikilinkTarget(frontmatter.supersedes);
  const supersededBy = wikilinkTarget(frontmatter.superseded_by);
  const delivered = firstString(frontmatter.delivered);
  const distilledFrom = wikilinkTarget(frontmatter.distilled_from);
  const learnedBy = learnedBySlug(frontmatter.learned_by);
  return {
    name: noteName(path),
    path,
    title: noteTitle(path),
    provenance: parseProvenance(frontmatter, path),
    pinned: frontmatter.pinned === true,
    aliases: asStringArray(frontmatter.aliases),
    body,
    links: extractWikilinks(body),
    tokens: Math.ceil(raw.length / 4),
    frontmatter,
    ...(created !== undefined && { created }),
    ...(typeof confidence === "number" && { confidence }),
    ...(typeof usefulness === "number" && { usefulness }),
    ...(supersedes !== undefined && { supersedes }),
    ...(supersededBy !== undefined && { supersededBy }),
    ...(delivered !== undefined && { delivered }),
    ...(distilledFrom !== undefined && { distilledFrom }),
    ...(learnedBy !== undefined && { learnedBy }),
  };
}

export const botMocName = "MOC";

export function botMocLink(slug: string): string {
  return `bots/${slug}/${botMocName}`;
}

export function learnedByLink(slug: string): string {
  return `[[${botMocLink(slug)}]]`;
}

export function learnedBySlug(value: unknown): string | undefined {
  const target = wikilinkTarget(value);
  if (target === undefined) return firstString(value);
  return target.match(learnedByPattern)?.[1];
}

export function isEntityPath(path: string): boolean {
  return path.startsWith(`${entitiesDir}/`);
}

export function noteName(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -".md".length) : path;
}

export function noteTitle(path: string): string {
  return isEntityPath(path) ? noteName(path) : stemName(path);
}

export function stemName(path: string): string {
  const name = noteName(path);
  return name.slice(name.lastIndexOf("/") + 1);
}

export function noteWriteTarget(path: string): NoteWriteTarget {
  return isEntityPath(path)
    ? { entity: noteName(path).slice(`${entitiesDir}/`.length) }
    : { title: stemName(path) };
}

export function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export function firstString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function extractWikilinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(wikilinkPattern)) {
    const target = match[1]?.trim();
    if (target !== undefined && target !== "" && !links.includes(target)) links.push(target);
  }
  return links;
}

export function wikilinkTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const target = value.match(/^\[\[([^[\]|#]+)\]\]$/)?.[1]?.trim();
  return target === "" ? undefined : target;
}

export function mocContent(links: string[]): string {
  const lines = links.map((link) => {
    const trimmed = link.trim();
    if (trimmed === "" || /[[\]\n]/.test(trimmed))
      throw new InvalidTitleError(link, "not a linkable note name");
    return `- [[${trimmed}]]`;
  });
  return `${lines.join("\n")}\n`;
}

export function isDailyDate(value: string): boolean {
  return dailyDatePattern.test(value);
}

export function dailyPath(date: string): string {
  if (!isDailyDate(date)) throw new InvalidDailyDateError(date);
  return `daily/${date}.md`;
}

export function dailyDateOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function dailyTimeOf(now: Date): string {
  return now.toISOString().slice(11, 16);
}

export function dailyEntryLines(text: string, provenance: Provenance, time: string): string {
  const [first = "", ...rest] = text.split("\n");
  const lines = [`- ${time} [prov: ${provenance}] ${first}`, ...rest.map((line) => `  ${line}`)];
  return `${lines.join("\n")}\n`;
}

export function parseDailyEntries(raw: string): DailyEntry[] {
  const entries: DailyEntry[] = [];
  for (const line of raw.split("\n")) {
    const marker = line.match(dailyMarkerPattern);
    if (marker !== null) {
      entries.push({
        time: marker[1] ?? "",
        provenance: (marker[2] ?? "user") as Provenance,
        text: marker[3] ?? "",
      });
      continue;
    }
    const open = entries.at(-1);
    if (open === undefined || line === "") continue;
    open.text += `\n${line.startsWith("  ") ? line.slice(2) : line}`;
  }
  return entries;
}

const wikilinkPattern = /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g;
const dailyMarkerPattern = /^- (\d{2}:\d{2}) \[prov: (user|agent|untrusted)\] (.*)$/;
const dailyDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const learnedByPattern = new RegExp(`^bots/([^/]+)/${botMocName}$`);

function parseProvenance(frontmatter: Frontmatter, path: string): Provenance {
  const value = frontmatter.provenance;
  if (value === undefined) return "user";
  if (value === "user" || value === "agent" || value === "untrusted") return value;
  throw new MalformedFrontmatterError(path, `unknown provenance ${JSON.stringify(value)}`);
}
