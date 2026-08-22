import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  declarationFileFor,
  defaultVaultPath,
  readDeclaration,
  type Workspace,
  type WorkspaceDeclaration,
  workspaceAt,
  writeDeclaration,
} from "./declaration.ts";
import { ConfigError } from "./load.ts";
import {
  namedDeclarationFileFor,
  openNamedWorkspace,
  writeNamedWorkspaceDeclaration,
} from "./named-workspaces.ts";

export interface WorkspaceAnchor {
  root: string;
  source: "declaration" | "git" | "launch";
}

export function openWorkspace(cwd: string, slug?: string): Workspace | undefined {
  if (slug !== undefined) return openNamedWorkspace(resolveAnchor(cwd).root, slug);
  const file = findDeclarationAbove(resolve(cwd));
  if (file === undefined) return undefined;
  const root = rootOfDeclaration(file);
  rejectNestedAnchor(root, file);
  return workspaceAt(root, file, readDeclaration(file), defaultVaultPath(root));
}

export function resolveVaultPath(cwd: string, slug?: string): string | undefined {
  return openWorkspace(cwd, slug)?.vaultPath;
}

export function resolveAnchor(cwd: string): WorkspaceAnchor {
  const launch = resolve(cwd);
  const declaration = findDeclarationAbove(launch);
  if (declaration !== undefined) {
    const root = rootOfDeclaration(declaration);
    rejectNestedAnchor(root, declaration);
    readDeclaration(declaration);
    return { root, source: "declaration" };
  }
  const gitRoot = findGitRootAbove(launch);
  if (gitRoot !== undefined) return { root: gitRoot, source: "git" };
  return { root: launch, source: "launch" };
}

export function writeWorkspaceDeclaration(root: string, declaration: WorkspaceDeclaration): string {
  const base = resolve(root);
  const file = declarationFileFor(base);
  rejectEnclosingDeclaration(base, file);
  rejectEnclosedDeclaration(base, file);
  writeDeclaration(file, declaration);
  return file;
}

export function updateWorkspaceDeclaration(
  root: string,
  revise: (declaration: WorkspaceDeclaration) => WorkspaceDeclaration,
  slug?: string,
): WorkspaceDeclaration {
  const base = resolve(root);
  const file = slug === undefined ? declarationFileFor(base) : namedDeclarationFileFor(base, slug);
  const revised = revise(readDeclaration(file));
  if (slug === undefined) writeWorkspaceDeclaration(root, revised);
  else writeNamedWorkspaceDeclaration(root, slug, revised);
  return revised;
}

function rootOfDeclaration(file: string): string {
  return dirname(dirname(file));
}

function rejectNestedAnchor(root: string, file: string): void {
  const enclosing = findDeclarationAbove(dirname(root));
  if (enclosing === undefined) return;
  throw new ConfigError(
    file,
    `nested inside the workspace at ${rootOfDeclaration(enclosing)}; nested workspace anchors aren't supported, remove one of the two declarations`,
  );
}

function rejectEnclosingDeclaration(root: string, file: string): void {
  const enclosing = findDeclarationAbove(dirname(root));
  if (enclosing === undefined) return;
  throw new ConfigError(
    file,
    `the workspace at ${rootOfDeclaration(enclosing)} already covers this folder; nested workspace anchors aren't supported`,
  );
}

function rejectEnclosedDeclaration(root: string, file: string): void {
  const enclosed = findDeclarationBelow(root);
  if (enclosed === undefined) return;
  throw new ConfigError(
    file,
    `the workspace at ${rootOfDeclaration(enclosed)} already lives inside this folder; nested workspace anchors aren't supported`,
  );
}

function findDeclarationAbove(dir: string): string | undefined {
  const candidate = declarationFileFor(dir);
  if (existsSync(candidate)) return candidate;
  const parent = dirname(dir);
  return parent === dir ? undefined : findDeclarationAbove(parent);
}

const directoriesNeverScannedForDeclarations = new Set([".git", ".keywork", "node_modules"]);

function findDeclarationBelow(dir: string): string | undefined {
  for (const child of scannableSubdirectoriesOf(dir)) {
    const candidate = declarationFileFor(child);
    if (existsSync(candidate)) return candidate;
    const deeper = findDeclarationBelow(child);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

function scannableSubdirectoriesOf(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && !directoriesNeverScannedForDeclarations.has(entry.name),
      )
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function findGitRootAbove(dir: string): string | undefined {
  if (existsSync(join(dir, ".git"))) return dir;
  const parent = dirname(dir);
  return parent === dir ? undefined : findGitRootAbove(parent);
}
