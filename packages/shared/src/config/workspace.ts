import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "./load.ts";

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
        "Additional directories, relative to the primary root or absolute, that join the workspace's working set: the tool jail and the memory taint boundary cover them once the workspace is trusted (PD11.4); exists because J-D1 defines a workspace as a declared working set in the VS Code sense — a primary root plus extra directories. Entries that do not exist are skipped with a warning, never a failure, and an untrusted clone's entries stay inert.",
      )
      .optional(),
  })
  .strict()
  .describe(
    "Workspace declaration at `.keywork/workspace.json`; its parent of `.keywork/` is the primary root. Discovered by walking from the launch directory up to the filesystem root, nearest declaration wins (git-style), so keywork opens the workspace from any subdirectory. A declaration nested inside another declared workspace is rejected (PD11.3). Workspace identity keys off the resolved primary root; the workspace-scope memory vault lives at `.keywork/memory/` beside this file, in-repo and git-able.",
  );

export type WorkspaceDeclaration = z.infer<typeof workspaceDeclarationSchema>;

export interface Workspace {
  root: string;
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

export function openWorkspace(cwd: string): Workspace | undefined {
  const file = findDeclarationAbove(resolve(cwd));
  if (file === undefined) return undefined;
  const root = rootOfDeclaration(file);
  rejectNestedAnchor(root, file);
  const declaration = readDeclaration(file);
  const { existing, missing } = partitionContextDirs(root, declaration.contextDirs ?? []);
  return {
    root,
    declarationFile: file,
    name: declaration.name,
    contextDirs: existing,
    missingContextDirs: missing,
    vaultPath: join(root, ".keywork", "memory"),
  };
}

export function resolveVaultPath(cwd: string): string | undefined {
  return openWorkspace(cwd)?.vaultPath;
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
  const enclosing = findDeclarationAbove(dirname(base));
  if (enclosing !== undefined) {
    throw new ConfigError(
      file,
      `the workspace at ${rootOfDeclaration(enclosing)} already covers this folder; nested workspace anchors aren't supported`,
    );
  }
  const parsed = workspaceDeclarationSchema.safeParse(declaration);
  if (!parsed.success) throw new ConfigError(file, z.prettifyError(parsed.error));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  return file;
}

export function updateWorkspaceDeclaration(
  root: string,
  revise: (declaration: WorkspaceDeclaration) => WorkspaceDeclaration,
): WorkspaceDeclaration {
  const file = declarationFileFor(resolve(root));
  const revised = revise(readDeclaration(file));
  writeWorkspaceDeclaration(root, revised);
  return revised;
}

function declarationFileFor(root: string): string {
  return join(root, ".keywork", "workspace.json");
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

function findDeclarationAbove(dir: string): string | undefined {
  const candidate = declarationFileFor(dir);
  if (existsSync(candidate)) return candidate;
  const parent = dirname(dir);
  return parent === dir ? undefined : findDeclarationAbove(parent);
}

function findGitRootAbove(dir: string): string | undefined {
  if (existsSync(join(dir, ".git"))) return dir;
  const parent = dirname(dir);
  return parent === dir ? undefined : findGitRootAbove(parent);
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
