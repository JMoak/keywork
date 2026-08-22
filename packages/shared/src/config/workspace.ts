import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "./load.ts";
import { slugProblem } from "./slug.ts";

export const workspaceDeclarationSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "Human-readable handle shown wherever the workspace is referenced; exists because a declared working set (J-D1) deserves a name beyond its directory path.",
      ),
    contextDirs: z
      .array(z.string().min(1).max(1024))
      .max(64)
      .describe(
        "Additional directories, relative to the primary root or absolute, that join the workspace's working set: the tool jail and the memory taint boundary cover them once the workspace is trusted (PD11.4); exists because J-D1 defines a workspace as a declared working set in the VS Code sense: a primary root plus extra directories. Entries that do not exist are skipped with a warning, never a failure, and an untrusted clone's entries stay inert.",
      )
      .optional(),
  })
  .strict()
  .describe(
    "Workspace declaration at `.keywork/workspace.json`; its parent of `.keywork/` is the primary root. Discovered by walking from the launch directory up to the filesystem root, nearest declaration wins (git-style), so keywork opens the workspace from any subdirectory. A declaration nested inside another declared workspace is rejected (PD11.3). Workspace identity keys off the resolved primary root; the workspace-scope memory vault lives at `.keywork/memory/` beside this file, in-repo and git-able. Named workspaces over the same root (PD10) carry the same declaration at `.keywork/workspaces/<slug>/workspace.json` with their own `memory/` beside it.",
  );

export type WorkspaceDeclaration = z.infer<typeof workspaceDeclarationSchema>;

export interface Workspace {
  root: string;
  slug?: string;
  declarationFile: string;
  name: string;
  contextDirs: string[];
  missingContextDirs: string[];
  vaultPath: string;
}

export interface WorkspaceAnchor {
  root: string;
  source: "declaration" | "git" | "launch";
}

export interface WorkspaceSlot {
  slug: string | undefined;
  name: string | undefined;
  declared: boolean;
  declarationFile: string;
  vaultPath: string;
  problem?: string;
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

export function writeWorkspaceDeclaration(root: string, declaration: WorkspaceDeclaration): string {
  const base = resolve(root);
  const file = declarationFileFor(base);
  rejectEnclosingDeclaration(base, file);
  rejectEnclosedDeclaration(base, file);
  writeDeclaration(file, declaration);
  return file;
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

function openNamedWorkspace(root: string, slug: string): Workspace | undefined {
  if (slugProblem(slug) !== undefined) return undefined;
  const file = namedDeclarationFileFor(root, slug);
  if (!existsSync(file)) return undefined;
  return { ...workspaceAt(root, file, readDeclaration(file), namedVaultPath(root, slug)), slug };
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

function workspaceAt(
  root: string,
  declarationFile: string,
  declaration: WorkspaceDeclaration,
  vaultPath: string,
): Workspace {
  const { existing, missing } = partitionContextDirs(root, declaration.contextDirs ?? []);
  return {
    root,
    declarationFile,
    name: declaration.name,
    contextDirs: existing,
    missingContextDirs: missing,
    vaultPath,
  };
}

function declarationFileFor(root: string): string {
  return join(root, ".keywork", "workspace.json");
}

function namedDeclarationFileFor(root: string, slug: string): string {
  const file = join(namedWorkspaceDir(root, slug), "workspace.json");
  const problem = slugProblem(slug);
  if (problem !== undefined) {
    throw new ConfigError(file, `invalid workspace slug "${slug}": ${problem}`);
  }
  return file;
}

function defaultVaultPath(root: string): string {
  return join(root, ".keywork", "memory");
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

function writeDeclaration(file: string, declaration: WorkspaceDeclaration): void {
  const parsed = workspaceDeclarationSchema.safeParse(declaration);
  if (!parsed.success) throw new ConfigError(file, z.prettifyError(parsed.error));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
}

function readDeclaration(file: string): WorkspaceDeclaration {
  const parsed = workspaceDeclarationSchema.safeParse(parseJson(file, readRaw(file)));
  if (!parsed.success) throw new ConfigError(file, z.prettifyError(parsed.error));
  return parsed.data;
}

function readRaw(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? "unknown";
    throw new ConfigError(file, `unreadable (${code}): ${(cause as Error).message}`);
  }
}

function parseJson(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(file, `not valid JSON: ${(cause as Error).message}`);
  }
}

function partitionContextDirs(
  root: string,
  declared: string[],
): { existing: string[]; missing: string[] } {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const dir of uniqueResolvedDirs(root, declared)) {
    (isDirectory(dir) ? existing : missing).push(dir);
  }
  return { existing, missing };
}

function uniqueResolvedDirs(root: string, declared: string[]): string[] {
  const seen = new Set([root]);
  const dirs: string[] = [];
  for (const entry of declared) {
    const dir = resolve(root, entry);
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }
  return dirs;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
