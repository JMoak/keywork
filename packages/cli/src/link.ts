import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { scopeContains, toolScope } from "@keywork/engine";
import {
  canonicalPath,
  openWorkspace,
  resolveAnchor,
  type TrustStore,
  updateWorkspaceDeclaration,
  type Workspace,
} from "@keywork/shared";
import { type AnchorMemory, fileAnchorMemory } from "./anchor.ts";
import { type CommandIo, type Confirm, resolveCommandIo } from "./command-io.ts";
import { ensureWorkspace } from "./init.ts";

export async function linkCommand(
  target: string | undefined,
  cwd: string,
  trustStore: TrustStore,
  io: CommandIo = {},
  confirm?: Confirm,
  anchorMemory: AnchorMemory = fileAnchorMemory(),
): Promise<number> {
  const resolved = resolveCommandIo(io);
  const { print, printError } = resolved;
  if (target === undefined || target.trim() === "") {
    printError("usage: keywork link <dir>");
    return 1;
  }
  const workspace = await ensureWorkspace({ cwd, trustStore, io: resolved, confirm, anchorMemory });
  if (workspace === undefined) return 1;
  const dir = resolve(cwd, target);
  const refusal = linkRefusal(workspace, dir);
  if (refusal !== undefined) {
    if (refusal.exitCode === 0) print(refusal.line);
    else printError(refusal.line);
    return refusal.exitCode;
  }
  if (confirm === undefined) {
    printError("keywork link asks before widening the workspace. run it from a terminal");
    return 1;
  }
  if (!(await confirm(`link ${dir} into workspace "${workspace.name}"? [y/N] `))) {
    print("okay, not linked");
    return 1;
  }
  updateWorkspaceDeclaration(workspace.root, (declaration) => ({
    ...declaration,
    contextDirs: [...(declaration.contextDirs ?? []), dir],
  }));
  print(`linked ${dir}. tools and memory now cover it`);
  return 0;
}

export function linkFocusDir(cwd: string, slug: string | undefined, target: string): string {
  const root = resolveAnchor(cwd).root;
  const workspace = declaredWorkspace(cwd, slug);
  const focus = focusDirWithin(root, target);
  if (workspace.focusDirs.includes(focus)) throw new Error(`${focus} is already a focus dir`);
  updateWorkspaceDeclaration(
    root,
    (declaration) => ({ ...declaration, focusDirs: [...(declaration.focusDirs ?? []), focus] }),
    slug,
  );
  return focus;
}

export function unlinkFocusDir(cwd: string, slug: string | undefined, focus: string): void {
  const root = resolveAnchor(cwd).root;
  const workspace = declaredWorkspace(cwd, slug);
  if (!workspace.focusDirs.includes(focus)) throw new Error(`${focus} isn't a focus dir here`);
  updateWorkspaceDeclaration(
    root,
    (declaration) => ({
      ...declaration,
      focusDirs: (declaration.focusDirs ?? []).filter((dir) => dir !== focus),
    }),
    slug,
  );
}

function declaredWorkspace(cwd: string, slug: string | undefined): Workspace {
  const workspace = openWorkspace(cwd, slug);
  if (workspace !== undefined) return workspace;
  throw new Error(
    slug === undefined
      ? "this workspace isn't set up yet · /init declares it"
      : `no workspace named ${slug} here`,
  );
}

function focusDirWithin(root: string, target: string): string {
  const dir = resolve(root, target);
  if (!isDirectory(dir)) throw new Error(`${target} isn't a directory`);
  const inside = relative(root, dir);
  if (inside === "") throw new Error("the whole root is already the workspace · pick a subtree");
  if (inside.startsWith("..") || resolve(root, inside) !== dir) {
    throw new Error(
      `${target} is outside the workspace root · keywork link widens the jail instead`,
    );
  }
  return inside.split(sep).join("/");
}

function linkRefusal(
  workspace: Workspace,
  dir: string,
): { line: string; exitCode: number } | undefined {
  if (!isDirectory(dir)) return { line: `${dir} isn't a directory`, exitCode: 1 };
  if (scopeContains(toolScope(workspace.root), dir)) {
    return { line: `${dir} is already inside the workspace`, exitCode: 0 };
  }
  if (scopeContains(toolScope(dir), workspace.root)) {
    return { line: "can't link a folder that contains the workspace itself", exitCode: 1 };
  }
  if (alreadyLinked(workspace, dir)) return { line: `${dir} is already linked`, exitCode: 0 };
  return undefined;
}

function alreadyLinked(workspace: Workspace, dir: string): boolean {
  const target = canonicalPath(dir);
  return [...workspace.contextDirs, ...workspace.missingContextDirs].some(
    (linked) => canonicalPath(linked) === target,
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
