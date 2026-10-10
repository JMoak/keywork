import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionDefinition, ExtensionFactory, ExtensionSource } from "./hooks.ts";
import type { ExtensionHost, ExtensionStatus } from "./host.ts";
import { validatedName } from "./layers.ts";

export const extensionsConvention = ".keywork/extensions";

export interface ExtensionRoots {
  userRoot?: string | undefined;
  projectRoot?: string | undefined;
  projectTrusted?: boolean | undefined;
}

export interface ExtensionCandidate {
  name: string;
  file: string;
  source: Extract<ExtensionSource, "user" | "project">;
}

export interface SkippedExtensionLayer {
  source: Extract<ExtensionSource, "user" | "project">;
  dir: string;
  reason: string;
}

export interface ExtensionDiscovery {
  candidates: ExtensionCandidate[];
  skipped: SkippedExtensionLayer[];
}

export interface ExtensionLoadReport extends ExtensionDiscovery {
  statuses: ExtensionStatus[];
}

export const untrustedProjectReason =
  "project extensions stay unloaded until the workspace is trusted";

export async function discoverExtensions(roots: ExtensionRoots): Promise<ExtensionDiscovery> {
  const discovery: ExtensionDiscovery = { candidates: [], skipped: [] };
  const seen = new Set<string>();
  for (const layer of layersByPrecedence(roots)) {
    if (layer.reason !== undefined) {
      discovery.skipped.push({ source: layer.source, dir: layer.dir, reason: layer.reason });
      continue;
    }
    for (const candidate of await candidatesIn(layer.dir, layer.source)) {
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      discovery.candidates.push(candidate);
    }
  }
  return discovery;
}

export async function importExtension(candidate: ExtensionCandidate): Promise<ExtensionDefinition> {
  const module = (await import(pathToFileURL(candidate.file).href)) as { default?: unknown };
  const activate = module.default;
  if (typeof activate !== "function") {
    throw new Error("the module must export a default function taking the extension api");
  }
  return {
    name: candidate.name,
    source: candidate.source,
    file: candidate.file,
    activate: activate as ExtensionFactory,
  };
}

export async function loadExtensions(
  roots: ExtensionRoots,
  host: ExtensionHost,
): Promise<ExtensionLoadReport> {
  const discovery = await discoverExtensions(roots);
  const statuses: ExtensionStatus[] = [];
  for (const candidate of discovery.candidates) {
    statuses.push(await admit(candidate, host));
  }
  return { ...discovery, statuses };
}

async function admit(candidate: ExtensionCandidate, host: ExtensionHost): Promise<ExtensionStatus> {
  let definition: ExtensionDefinition;
  try {
    definition = await importExtension(candidate);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return host.quarantineUnloaded(candidate, reason);
  }
  return host.activate(definition);
}

interface Layer {
  source: Extract<ExtensionSource, "user" | "project">;
  dir: string;
  reason?: string;
}

function layersByPrecedence(roots: ExtensionRoots): Layer[] {
  const layers: Layer[] = [];
  if (roots.projectRoot !== undefined) {
    const dir = join(roots.projectRoot, extensionsConvention);
    layers.push(
      roots.projectTrusted === true
        ? { source: "project", dir }
        : { source: "project", dir, reason: untrustedProjectReason },
    );
  }
  if (roots.userRoot !== undefined) {
    layers.push({ source: "user", dir: join(roots.userRoot, extensionsConvention) });
  }
  return layers;
}

const moduleExtensions = new Set([".ts", ".js", ".mts", ".mjs"]);
const entryFileNames = ["index.ts", "index.js", "index.mts", "index.mjs"];

async function candidatesIn(dir: string, source: Layer["source"]): Promise<ExtensionCandidate[]> {
  let names: Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: ExtensionCandidate[] = [];
  for (const entry of [...names].sort(byName)) {
    const file = entry.isDirectory()
      ? await entryFileOf(join(dir, entry.name))
      : moduleFileOf(dir, entry.name);
    if (file === undefined) continue;
    const name = extensionNameOf(entry.name);
    if (name !== undefined) found.push({ name, file, source });
  }
  return found;
}

function moduleFileOf(dir: string, fileName: string): string | undefined {
  if (!moduleExtensions.has(extname(fileName))) return undefined;
  if (fileName.endsWith(".d.ts") || fileName.includes(".test.")) return undefined;
  return join(dir, fileName);
}

async function entryFileOf(dir: string): Promise<string | undefined> {
  let present: string[];
  try {
    present = await readdir(dir);
  } catch {
    return undefined;
  }
  const entry = entryFileNames.find((candidate) => present.includes(candidate));
  return entry === undefined ? undefined : join(dir, entry);
}

function extensionNameOf(fileOrDirName: string): string | undefined {
  const stem = basename(fileOrDirName, extname(fileOrDirName));
  try {
    return validatedName(stem);
  } catch {
    return undefined;
  }
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
