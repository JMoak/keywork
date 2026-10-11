import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scopeContains, type ToolScope } from "@keywork/engine";
import { type IgnoreLayer, ignoresPath, parseIgnoreFile } from "@keywork/shared";

export interface TreeEntry {
  name: string;
  kind: "file" | "dir";
  ignored: boolean;
  hidden: boolean;
}

export interface TreeListing {
  path: string;
  entries: TreeEntry[];
}

export interface ByteRange {
  from?: number | undefined;
  to?: number | undefined;
}

export interface FileSlice {
  path: string;
  bytes: number;
  from: number;
  to: number;
  text: string;
  truncated: boolean;
  encoding: "utf-8";
}

export interface WorkspaceFiles {
  tree(path: string, hidden: boolean): Promise<TreeListing>;
  file(path: string, range: ByteRange): Promise<FileSlice>;
}

export const fileSliceCapBytes = 1024 * 1024;

export const maxFileBytes = 20 * 1024 * 1024;

export class WorkspaceScopeError extends Error {
  constructor(path: string) {
    super(`${path} escapes the workspace scope`);
    this.name = "WorkspaceScopeError";
  }
}

export class MissingPathError extends Error {
  constructor(path: string, what: "directory" | "file") {
    super(`no ${what} at ${path}`);
    this.name = "MissingPathError";
  }
}

export class BinaryFileError extends Error {
  constructor(path: string) {
    super(`${path} is a binary file`);
    this.name = "BinaryFileError";
  }
}

export class FileTooLargeError extends Error {
  constructor(path: string, bytes: number) {
    super(`${path} is ${bytes} bytes, over the ${maxFileBytes} byte cap`);
    this.name = "FileTooLargeError";
  }
}

export function workspaceFiles(root: string, scope: ToolScope): WorkspaceFiles {
  const base = resolve(root);
  const confine = (path: string): string => {
    const target = resolve(base, path);
    if (!scopeContains(scope, target)) throw new WorkspaceScopeError(path);
    return target;
  };
  return {
    tree: async (path, hidden) => {
      const dir = confine(path);
      const shown = shownPath(base, dir);
      const ignoreRoot = isInside(base, dir) ? base : dir;
      const layers = await ignoreLayersBetween(ignoreRoot, dir);
      const prefix = shownPath(ignoreRoot, dir);
      const entries = sortEntries(await directoryEntries(dir, shown))
        .filter((entry) => hidden || !isHidden(entry.name))
        .map((entry) => ({
          ...entry,
          ignored: ignoresPath(layers, joinShown(prefix, entry.name), entry.kind === "dir"),
          hidden: isHidden(entry.name),
        }));
      return { path: shown, entries };
    },
    file: async (path, range) => {
      const target = confine(path);
      return readSlice(target, shownPath(base, target), range);
    },
  };
}

async function readSlice(target: string, shown: string, range: ByteRange): Promise<FileSlice> {
  const info = await stat(target).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw new MissingPathError(shown, "file");
  if (info.size > maxFileBytes) throw new FileTooLargeError(shown, info.size);
  const from = clamp(range.from ?? 0, 0, info.size);
  const wanted = clamp(range.to ?? info.size, from, info.size);
  const to = Math.min(wanted, from + fileSliceCapBytes);
  const bytes = await readBytes(target, from, to);
  if (bytes.includes(0)) throw new BinaryFileError(shown);
  return {
    path: shown,
    bytes: info.size,
    from,
    to,
    text: bytes.toString("utf8"),
    truncated: to < wanted,
    encoding: "utf-8",
  };
}

async function readBytes(target: string, from: number, to: number): Promise<Buffer> {
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function directoryEntries(
  dir: string,
  shown: string,
): Promise<Array<Pick<TreeEntry, "name" | "kind">>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "dir" : "file",
    }));
  } catch {
    throw new MissingPathError(shown, "directory");
  }
}

async function ignoreLayersBetween(root: string, dir: string): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = [];
  for (const ancestor of ancestorsFrom(root, dir)) {
    const text = await readFile(join(ancestor, ".gitignore"), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    layers.push({ base: shownPath(root, ancestor), patterns: parseIgnoreFile(text).patterns });
  }
  return layers;
}

function ancestorsFrom(root: string, dir: string): string[] {
  const chain: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    chain.unshift(current);
    if (current === root || dirname(current) === current) return chain;
  }
}

function sortEntries<Entry extends Pick<TreeEntry, "name" | "kind">>(entries: Entry[]): Entry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return (
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.name.localeCompare(right.name)
    );
  });
}

function isInside(root: string, target: string): boolean {
  const exit = relative(root, target);
  return exit !== ".." && !exit.startsWith(`..${sep}`) && !isAbsolute(exit);
}

function shownPath(root: string, target: string): string {
  if (!isInside(root, target)) return target;
  return relative(root, target).split(sep).join("/");
}

function joinShown(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
