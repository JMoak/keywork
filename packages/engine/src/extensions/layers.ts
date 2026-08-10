import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Frontmatter,
  MalformedFrontmatterError,
  parseDocument,
} from "../memory/frontmatter.ts";

export type LayerSource = "project" | "user";

export interface LayeredDirs {
  projectDir?: string;
  userDir?: string;
}

export interface ExtensionLoadFailure {
  file: string;
  reason: string;
}

export interface MarkdownDefinition {
  name: string;
  frontmatter: Frontmatter;
  body: string;
  file: string;
  source: LayerSource;
}

export async function loadLayeredMarkdown<T extends { name: string }>(
  dirs: LayeredDirs,
  build: (definition: MarkdownDefinition) => T,
): Promise<{ items: T[]; failures: ExtensionLoadFailure[] }> {
  const byName = new Map<string, T>();
  const failures: ExtensionLoadFailure[] = [];
  for (const layer of layersInPrecedence(dirs)) {
    for (const file of await markdownFilesIn(layer.dir)) {
      const item = await buildFromFile(file, layer.source, build, failures);
      if (item !== undefined) byName.set(item.name, item);
    }
  }
  return { items: [...byName.values()], failures };
}

export function definitionString(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function definitionList(frontmatter: Frontmatter, key: string): string[] | undefined {
  const value = frontmatter[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : undefined;
}

const validName = /^[A-Za-z0-9][\w-]*$/;

function layersInPrecedence(dirs: LayeredDirs): { dir: string; source: LayerSource }[] {
  return [
    ...(dirs.userDir !== undefined ? [{ dir: dirs.userDir, source: "user" as const }] : []),
    ...(dirs.projectDir !== undefined
      ? [{ dir: dirs.projectDir, source: "project" as const }]
      : []),
  ];
}

async function markdownFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function buildFromFile<T>(
  file: string,
  source: LayerSource,
  build: (definition: MarkdownDefinition) => T,
  failures: ExtensionLoadFailure[],
): Promise<T | undefined> {
  const name = fileStem(file);
  if (!validName.test(name)) {
    failures.push({ file, reason: `invalid name "${name}"; use letters, digits, - or _` });
    return undefined;
  }
  try {
    const { frontmatter, body } = parseDocument(await readFile(file, "utf8"), file);
    return build({ name, frontmatter, body, file, source });
  } catch (cause) {
    failures.push({ file, reason: reasonFor(cause) });
    return undefined;
  }
}

function fileStem(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  return base.slice(0, -".md".length);
}

function reasonFor(cause: unknown): string {
  if (cause instanceof MalformedFrontmatterError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
