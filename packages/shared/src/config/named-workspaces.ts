import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  declarationFileFor,
  defaultVaultPath,
  isDirectory,
  readDeclaration,
  type Workspace,
  type WorkspaceDeclaration,
  workspaceAt,
  writeDeclaration,
} from "./declaration.ts";
import { ConfigError } from "./load.ts";
import { slugProblem } from "./slug.ts";

export interface WorkspaceSlot {
  slug: string | undefined;
  name: string | undefined;
  declared: boolean;
  declarationFile: string;
  vaultPath: string;
  problem?: string;
}

export function listWorkspaces(root: string): WorkspaceSlot[] {
  const base = resolve(root);
  return [
    slotFor(undefined, declarationFileFor(base), defaultVaultPath(base)),
    ...namedWorkspaceSlugs(base).map((slug) =>
      slotFor(slug, namedDeclarationFileFor(base, slug), namedVaultPath(base, slug)),
    ),
  ];
}

export function namedWorkspaceDir(root: string, slug: string): string {
  return join(resolve(root), ".keywork", "workspaces", slug);
}

export function writeNamedWorkspaceDeclaration(
  root: string,
  slug: string,
  declaration: WorkspaceDeclaration,
): string {
  const base = resolve(root);
  const file = namedDeclarationFileFor(base, slug);
  writeDeclaration(file, declaration);
  mkdirSync(namedVaultPath(base, slug), { recursive: true });
  return file;
}

export function openNamedWorkspace(root: string, slug: string): Workspace | undefined {
  if (slugProblem(slug) !== undefined) return undefined;
  const file = namedDeclarationFileFor(root, slug);
  if (!existsSync(file)) return undefined;
  return { ...workspaceAt(root, file, readDeclaration(file), namedVaultPath(root, slug)), slug };
}

export function namedDeclarationFileFor(root: string, slug: string): string {
  const file = join(namedWorkspaceDir(root, slug), "workspace.json");
  const problem = slugProblem(slug);
  if (problem !== undefined) {
    throw new ConfigError(file, `invalid workspace slug "${slug}": ${problem}`);
  }
  return file;
}

function namedVaultPath(root: string, slug: string): string {
  return join(namedWorkspaceDir(root, slug), "memory");
}

function namedWorkspaceSlugs(root: string): string[] {
  const dir = join(root, ".keywork", "workspaces");
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && slugProblem(entry.name) === undefined)
    .map((entry) => entry.name)
    .filter((slug) => existsSync(namedDeclarationFileFor(root, slug)))
    .sort();
}

function slotFor(
  slug: string | undefined,
  declarationFile: string,
  vaultPath: string,
): WorkspaceSlot {
  const slot = {
    slug,
    name: undefined,
    declared: existsSync(declarationFile),
    declarationFile,
    vaultPath,
  };
  if (!slot.declared) return slot;
  try {
    return { ...slot, name: readDeclaration(declarationFile).name };
  } catch (cause) {
    return { ...slot, problem: cause instanceof Error ? cause.message : String(cause) };
  }
}
