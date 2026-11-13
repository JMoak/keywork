import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ToolScope {
  cwd: string;
  roots: readonly string[];
  readRoots?: readonly string[] | undefined;
}

export function toolScope(cwd: string, linkedDirs: readonly string[] = []): ToolScope {
  const base = resolve(cwd);
  return { cwd: base, roots: dedupe([base, ...linkedDirs.map((dir) => resolve(dir))]) };
}

export function withReadRoots(scope: ToolScope, readable: readonly string[]): ToolScope {
  if (readable.length === 0) return scope;
  const readRoots = dedupe([...(scope.readRoots ?? []), ...readable.map((path) => resolve(path))]);
  return { ...scope, readRoots };
}

export function confinedPath(scope: ToolScope, path: string): string {
  const target = resolvedIn(scope, path);
  if (scopeHolds(scope.roots, target)) return target;
  throw new Error(escapeMessage(path, scope.roots));
}

export function readablePath(scope: ToolScope, path: string): string {
  if (isReadablePath(scope, path)) return resolvedIn(scope, path);
  throw new Error(escapeMessage(path, scope.roots));
}

export function isReadablePath(scope: ToolScope, path: string): boolean {
  return scopeHolds([...scope.roots, ...(scope.readRoots ?? [])], resolvedIn(scope, path));
}

export function scopeContains(scope: ToolScope, path: string): boolean {
  return scopeHolds(scope.roots, resolvedIn(scope, path));
}

function resolvedIn(scope: ToolScope, path: string): string {
  return resolve(scope.cwd, process.platform === "win32" ? fromMsysDrive(path) : path);
}

function fromMsysDrive(path: string): string {
  const drive = /^\/([a-zA-Z])(?=\/|$)/.exec(path)?.[1];
  return drive === undefined ? path : `${drive.toUpperCase()}:\\${path.slice(3)}`;
}

function scopeHolds(roots: readonly string[], target: string): boolean {
  const realTarget = realLocation(target);
  if (realTarget === undefined) return false;
  return roots.some((root) => contains(realLocation(root) ?? root, realTarget));
}

export function realLocation(path: string): string | undefined {
  const real = existingRealpath(path);
  if (real !== undefined) return real;
  if (isSymbolicLink(path)) return undefined;
  const parent = dirname(path);
  if (parent === path) return path;
  const realParent = realLocation(parent);
  return realParent === undefined ? undefined : join(realParent, basename(path));
}

function existingRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function contains(root: string, target: string): boolean {
  const exit = relative(root, target);
  return exit !== ".." && !exit.startsWith(`..${sep}`) && !isAbsolute(exit);
}

function escapeMessage(path: string, roots: readonly string[]): string {
  if (roots.length === 1) {
    return `${path} escapes the project root; tools may only touch files inside it`;
  }
  return `${path} escapes the workspace scope; tools may only touch the workspace and its linked folders`;
}

function dedupe(dirs: readonly string[]): string[] {
  return [...new Set(dirs)];
}
