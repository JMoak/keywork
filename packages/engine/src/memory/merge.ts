import { basename, dirname } from "node:path";
import {
  type Frontmatter,
  type FrontmatterValue,
  isFrontmatterMap,
  MalformedFrontmatterError,
  type ParsedDocument,
  parseDocument,
  serializeDocument,
} from "./frontmatter.ts";
import { titleKey } from "./naming.ts";
import { extractWikilinks, mocContent } from "./notes.ts";
import { auditFile, dailyDir, isAuditSegmentPath, mocFile } from "./vault-files.ts";

export interface MergeSides {
  base: string;
  ours: string;
  theirs: string;
}

export type MergeOutcome = { merged: true; content: string } | { merged: false; content: string };

export interface ConflictSides {
  ours: string;
  theirs: string;
}

export const derivedFields = {
  highest: ["usefulness", "confidence"],
  union: ["aliases", "revised_by"],
  latest: ["drift"],
  either: ["pinned"],
  ours: ["supersedes", "superseded_by", "distilled_from"],
} as const;

export function mergeVaultFile(path: string, sides: MergeSides): MergeOutcome {
  const name = basename(path);
  if (name === mocFile) return merged(mergeLinkList(sides));
  if (isAppendOnlyPath(path)) return merged(mergeAppendOnly(sides));
  return mergeNote(path, sides);
}

export function isAppendOnlyPath(path: string): boolean {
  const name = basename(path);
  return basename(dirname(path)) === dailyDir || name === auditFile || isAuditSegmentPath(name);
}

export function conflictMarkers(sides: ConflictSides): string {
  return `<<<<<<< ours\n${withNewline(sides.ours)}=======\n${withNewline(sides.theirs)}>>>>>>> theirs\n`;
}

export function splitConflictMarkers(raw: string): ConflictSides | undefined {
  if (!conflictStartPattern.test(raw)) return undefined;
  const ours: string[] = [];
  const theirs: string[] = [];
  let region: "both" | "ours" | "base" | "theirs" = "both";
  for (const line of lines(raw)) {
    if (region === "both" && line.startsWith("<<<<<<< ")) region = "ours";
    else if (region === "ours" && line.startsWith("||||||| ")) region = "base";
    else if ((region === "ours" || region === "base") && line === "=======") region = "theirs";
    else if (region === "theirs" && line.startsWith(">>>>>>> ")) region = "both";
    else if (region === "both") {
      ours.push(line);
      theirs.push(line);
    } else if (region === "ours") ours.push(line);
    else if (region === "theirs") theirs.push(line);
  }
  const close = raw.endsWith("\n") ? "\n" : "";
  return { ours: ours.join("\n") + close, theirs: theirs.join("\n") + close };
}

export function mergeText(sides: MergeSides): string | undefined {
  return threeWay(sides.base, sides.ours, sides.theirs) ?? appendUnion(sides);
}

export function mergeFrontmatter(
  base: Frontmatter,
  ours: Frontmatter,
  theirs: Frontmatter,
): Frontmatter | undefined {
  const result: Frontmatter = {};
  for (const key of unique([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = mergeField(key, base[key], ours[key], theirs[key]);
    if (value === conflictField) return undefined;
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const conflictStartPattern = /^<<<<<<< /m;
const conflictField = Symbol("conflict");

function mergeNote(path: string, sides: MergeSides): MergeOutcome {
  const docs = parseSides(path, sides);
  if (docs === undefined) return conflict(sides);
  const frontmatter = mergeFrontmatter(
    docs.base.frontmatter,
    docs.ours.frontmatter,
    docs.theirs.frontmatter,
  );
  const body = mergeText({
    base: docs.base.body,
    ours: docs.ours.body,
    theirs: docs.theirs.body,
  });
  if (frontmatter === undefined || body === undefined) return conflict(sides);
  return merged(serializeDocument(frontmatter, body));
}

function parseSides(
  path: string,
  sides: MergeSides,
): Record<keyof MergeSides, ParsedDocument> | undefined {
  try {
    return {
      base: parseDocument(sides.base, path),
      ours: parseDocument(sides.ours, path),
      theirs: parseDocument(sides.theirs, path),
    };
  } catch (error) {
    if (error instanceof MalformedFrontmatterError) return undefined;
    throw error;
  }
}

function mergeField(
  key: string,
  base: FrontmatterValue | undefined,
  ours: FrontmatterValue | undefined,
  theirs: FrontmatterValue | undefined,
): FrontmatterValue | undefined | typeof conflictField {
  if (same(ours, theirs)) return ours;
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  return resolveDerived(key, ours, theirs) ?? conflictField;
}

function resolveDerived(
  key: string,
  ours: FrontmatterValue | undefined,
  theirs: FrontmatterValue | undefined,
): FrontmatterValue | undefined {
  if (ours === undefined || theirs === undefined) return ours ?? theirs;
  if (isListed(derivedFields.highest, key)) return highest(ours, theirs);
  if (isListed(derivedFields.union, key)) return unionOfLists(ours, theirs);
  if (isListed(derivedFields.latest, key)) return latestByAt(ours, theirs);
  if (isListed(derivedFields.either, key)) return ours === true || theirs === true;
  if (isListed(derivedFields.ours, key)) return ours;
  return undefined;
}

function highest(ours: FrontmatterValue, theirs: FrontmatterValue): FrontmatterValue | undefined {
  if (typeof ours !== "number" || typeof theirs !== "number") return undefined;
  return Math.max(ours, theirs);
}

function unionOfLists(
  ours: FrontmatterValue,
  theirs: FrontmatterValue,
): FrontmatterValue | undefined {
  if (!Array.isArray(ours) || !Array.isArray(theirs)) return undefined;
  return unique([...ours, ...theirs]);
}

function latestByAt(
  ours: FrontmatterValue,
  theirs: FrontmatterValue,
): FrontmatterValue | undefined {
  if (!isFrontmatterMap(ours) || !isFrontmatterMap(theirs)) return undefined;
  return (theirs.at ?? "") > (ours.at ?? "") ? theirs : ours;
}

function mergeLinkList(sides: MergeSides): string {
  const base = extractWikilinks(sides.base);
  const ours = extractWikilinks(sides.ours);
  const theirs = extractWikilinks(sides.theirs);
  const removed = new Set(
    base.filter((link) => !includesLink(ours, link) || !includesLink(theirs, link)).map(titleKey),
  );
  const links: string[] = [];
  for (const link of [...ours, ...theirs]) {
    if (removed.has(titleKey(link)) || includesLink(links, link)) continue;
    links.push(link);
  }
  return mocContent(links);
}

function mergeAppendOnly(sides: MergeSides): string {
  return mergeText(sides) ?? lineUnion(sides);
}

function lineUnion(sides: MergeSides): string {
  const known = new Set<string>();
  const kept: string[] = [];
  for (const line of [...lines(sides.base), ...lines(sides.ours), ...lines(sides.theirs)]) {
    if (line === "" || known.has(line)) continue;
    known.add(line);
    kept.push(line);
  }
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

function threeWay(base: string, ours: string, theirs: string): string | undefined {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  return undefined;
}

function appendUnion(sides: MergeSides): string | undefined {
  const { base, ours, theirs } = sides;
  if (!ours.startsWith(base) || !theirs.startsWith(base)) return undefined;
  return base + ours.slice(base.length) + theirs.slice(base.length);
}

function merged(content: string): MergeOutcome {
  return { merged: true, content };
}

function conflict(sides: ConflictSides): MergeOutcome {
  return { merged: false, content: conflictMarkers(sides) };
}

function same(a: FrontmatterValue | undefined, b: FrontmatterValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isListed(listed: readonly string[], key: string): boolean {
  return listed.includes(key);
}

function includesLink(links: readonly string[], link: string): boolean {
  return links.some((candidate) => titleKey(candidate) === titleKey(link));
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function lines(text: string): string[] {
  const split = text.split("\n");
  return split.at(-1) === "" ? split.slice(0, -1) : split;
}

function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}
