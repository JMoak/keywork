import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type JsonFileStore, jsonFileStore } from "../json-file-store.ts";
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
        "Additional directories, relative to the primary root or absolute, that join the workspace's working set: the tool jail and the memory taint boundary cover them once the workspace is trusted (PD11.4); exists because J-D1 defines a workspace as a declared working set in the VS Code sense: a primary root plus extra directories. Entries that do not exist are skipped with a warning, never a failure, and an untrusted clone's entries stay inert.",
      )
      .optional(),
    focusDirs: z
      .array(z.string().min(1).max(1024))
      .max(64)
      .describe(
        "Subtrees of the primary root, relative to it, that this workspace is about (PD11.3): retrieval, bootstrap, and the sessions overview bias to them while the tool jail stays repo-wide; exists because a monorepo workspace needs to say which packages it lives in without narrowing what tools may touch. Order is the order they were linked; entries outside the root are refused at write time.",
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
  focusDirs: string[];
  vaultPath: string;
}

export function declarationFileFor(root: string): string {
  return join(root, ".keywork", "workspace.json");
}

export function defaultVaultPath(root: string): string {
  return join(root, ".keywork", "memory");
}

export function readDeclaration(file: string): WorkspaceDeclaration {
  const declaration = declarationStore(file).read();
  if (declaration === undefined) throw new ConfigError(file, "unreadable (ENOENT)");
  return declaration;
}

export function writeDeclaration(file: string, declaration: WorkspaceDeclaration): void {
  const parsed = workspaceDeclarationSchema.safeParse(declaration);
  if (!parsed.success) throw new ConfigError(file, z.prettifyError(parsed.error));
  declarationStore(file).write(parsed.data);
}

export function workspaceAt(
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
    focusDirs: [...(declaration.focusDirs ?? [])],
    vaultPath,
  };
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function declarationStore(file: string): JsonFileStore<WorkspaceDeclaration> {
  return jsonFileStore<WorkspaceDeclaration>({
    file,
    mode: "strict",
    error: (path, detail) => new ConfigError(path, detail),
    validate: (data) => {
      const parsed = workspaceDeclarationSchema.safeParse(data);
      if (!parsed.success) throw new ConfigError(file, z.prettifyError(parsed.error));
      return parsed.data;
    },
  });
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
