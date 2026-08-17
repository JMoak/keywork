import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ToolScope {
  cwd: string;
  roots: readonly string[];
}

export function toolScope(cwd: string, linkedDirs: readonly string[] = []): ToolScope {
  const base = resolve(cwd);
  return { cwd: base, roots: dedupe([base, ...linkedDirs.map((dir) => resolve(dir))]) };
}

export function confinedPath(scope: string | ToolScope, path: string): string {
  const { cwd, roots } = normalizeScope(scope);
  const target = resolve(cwd, path);
  if (roots.some((root) => contains(root, target))) return target;
  throw new Error(escapeMessage(path, roots));
}

export function scopeContains(scope: string | ToolScope, path: string): boolean {
  const { cwd, roots } = normalizeScope(scope);
  return roots.some((root) => contains(root, resolve(cwd, path)));
}

export function scopeCwd(scope: string | ToolScope): string {
  return normalizeScope(scope).cwd;
}

function normalizeScope(scope: string | ToolScope): ToolScope {
  return typeof scope === "string" ? toolScope(scope) : toolScope(scope.cwd, scope.roots);
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
