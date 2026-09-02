import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type IgnoreLayer, ignoreVerdict, parseIgnoreFile } from "@keywork/shared";

export interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface IgnoreFileProblem {
  file: string;
  line: number;
  text: string;
  reason: string;
}

export interface WorkspaceScan {
  files: ScannedFile[];
  ignoredPaths: number;
  ignoreProblems: IgnoreFileProblem[];
  truncated: boolean;
}

export interface ScanOptions {
  maxFiles?: number;
  keep?: (path: string) => boolean;
}

export const ignoreFileNames = [".gitignore", ".keyworkignore"] as const;

export async function scanWorkspace(
  root: string,
  options: ScanOptions = {},
): Promise<WorkspaceScan> {
  const scan: WorkspaceScan = { files: [], ignoredPaths: 0, ignoreProblems: [], truncated: false };
  const walk = {
    root,
    maxFiles: options.maxFiles ?? 10_000,
    keep: options.keep ?? (() => true),
    scan,
  };
  await walkDirectory(walk, "", [{ base: "", patterns: alwaysHiddenPatterns }]);
  scan.files.sort((left, right) => left.path.localeCompare(right.path));
  return scan;
}

const alwaysHiddenPatterns = parseIgnoreFile(".git/\nnode_modules/").patterns;

interface Walk {
  root: string;
  maxFiles: number;
  keep: (path: string) => boolean;
  scan: WorkspaceScan;
}

async function walkDirectory(walk: Walk, dir: string, layers: IgnoreLayer[]): Promise<void> {
  const entries = await readDirectory(join(walk.root, dir));
  const scoped = [...layers, ...(await ignoreLayersIn(walk, dir, entries))];
  for (const entry of entries.sort()) {
    if (walk.scan.truncated) return;
    await visit(walk, dir === "" ? entry : `${dir}/${entry}`, scoped);
  }
}

async function visit(walk: Walk, path: string, layers: IgnoreLayer[]): Promise<void> {
  const info = await statPath(join(walk.root, path));
  if (info === undefined || info.symlink) return;
  if (ignoreVerdict(layers, path, info.directory)) {
    walk.scan.ignoredPaths += 1;
    return;
  }
  if (info.directory) return walkDirectory(walk, path, layers);
  if (!walk.keep(path)) return;
  if (walk.scan.files.length >= walk.maxFiles) {
    walk.scan.truncated = true;
    return;
  }
  walk.scan.files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
}

async function ignoreLayersIn(walk: Walk, dir: string, entries: string[]): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = [];
  for (const name of ignoreFileNames) {
    if (!entries.includes(name)) continue;
    const file = dir === "" ? name : `${dir}/${name}`;
    const text = await readFile(join(walk.root, file), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const parsed = parseIgnoreFile(text);
    layers.push({ base: dir, patterns: parsed.patterns });
    for (const problem of parsed.problems) walk.scan.ignoreProblems.push({ file, ...problem });
  }
  return layers;
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

interface PathInfo {
  directory: boolean;
  symlink: boolean;
  size: number;
  mtimeMs: number;
}

async function statPath(path: string): Promise<PathInfo | undefined> {
  try {
    const info = await lstat(path);
    return {
      directory: info.isDirectory(),
      symlink: info.isSymbolicLink(),
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return undefined;
  }
}
