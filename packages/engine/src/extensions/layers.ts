import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Frontmatter, parseDocument } from "../memory/frontmatter.ts";

export type LayerSource = "project" | "user" | "bundled";

export interface LayerRoots {
  projectRoot?: string | undefined;
  userRoot?: string | undefined;
  bundledRoot?: string | undefined;
}

export const bundledConvention = "bundled";

export interface ExtensionConventions {
  readonly dirs: readonly string[];
  readonly discover: (dir: string) => Promise<DiscoveredFile[]>;
}

export interface DiscoveredFile {
  readonly file: string;
  readonly name: string;
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
  convention: string;
}

export interface LayeredLoad<T> {
  items: T[];
  failures: ExtensionLoadFailure[];
}

export async function loadLayered<T extends { name: string }>(
  roots: LayerRoots,
  conventions: ExtensionConventions,
  build: (definition: MarkdownDefinition) => T,
): Promise<LayeredLoad<T>> {
  const byName = new Map<string, T>();
  const failures: ExtensionLoadFailure[] = [];
  for (const layer of layersByPrecedence(roots, conventions)) {
    for (const found of await conventions.discover(layer.dir)) {
      try {
        const item = build(await readDefinition(found, layer));
        if (!byName.has(item.name)) byName.set(item.name, item);
      } catch (cause) {
        failures.push({ file: found.file, reason: reasonFor(cause) });
      }
    }
  }
  return { items: [...byName.values()], failures };
}

export async function markdownFilesIn(dir: string): Promise<DiscoveredFile[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({ file: join(dir, name), name: basename(name, ".md") }));
  } catch {
    return [];
  }
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

interface Layer {
  readonly source: LayerSource;
  readonly convention: string;
  readonly dir: string;
}

const validName = /^[A-Za-z0-9][\w-]*$/;

function layersByPrecedence(roots: LayerRoots, conventions: ExtensionConventions): Layer[] {
  return [
    ...layersUnder("project", roots.projectRoot, conventions.dirs),
    ...layersUnder("user", roots.userRoot, conventions.dirs),
    ...bundledLayer(roots.bundledRoot),
  ];
}

function bundledLayer(root: string | undefined): Layer[] {
  if (root === undefined) return [];
  return [{ source: "bundled", convention: bundledConvention, dir: root }];
}

function layersUnder(
  source: LayerSource,
  root: string | undefined,
  dirs: readonly string[],
): Layer[] {
  if (root === undefined) return [];
  return dirs.map((convention) => ({ source, convention, dir: join(root, convention) }));
}

async function readDefinition(found: DiscoveredFile, layer: Layer): Promise<MarkdownDefinition> {
  const { frontmatter, body } = parseDocument(await readFile(found.file, "utf8"), found.file);
  return {
    name: validatedName(definitionString(frontmatter, "name") ?? found.name),
    frontmatter,
    body,
    file: found.file,
    source: layer.source,
    convention: layer.convention,
  };
}

export function validatedName(name: string): string {
  if (validName.test(name)) return name;
  throw new Error(`invalid name "${name}"; use letters, digits, - or _`);
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
