import { statSync } from "node:fs";
import { resolve } from "node:path";
import { scopeContains } from "@keywork/engine";
import { type TrustStore, updateWorkspaceDeclaration, type Workspace } from "@keywork/shared";
import { type AnchorMemory, fileAnchorMemory } from "./anchor.ts";
import { type Confirm, ensureWorkspace, type WorkspaceCommandIo } from "./init.ts";

export async function linkCommand(
  target: string | undefined,
  cwd: string,
  trustStore: TrustStore,
  io: WorkspaceCommandIo = {},
  confirm?: Confirm,
  anchorMemory: AnchorMemory = fileAnchorMemory(),
): Promise<number> {
  const print = io.print ?? console.log;
  const printError = io.printError ?? console.error;
  if (target === undefined || target.trim() === "") {
    printError("usage: keywork link <dir>");
    return 1;
  }
  const workspace = await ensureWorkspace({
    cwd,
    trustStore,
    print,
    printError,
    confirm,
    anchorMemory,
  });
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

function linkRefusal(
  workspace: Workspace,
  dir: string,
): { line: string; exitCode: number } | undefined {
  if (!isDirectory(dir)) return { line: `${dir} isn't a directory`, exitCode: 1 };
  if (scopeContains(workspace.root, dir)) {
    return { line: `${dir} is already inside the workspace`, exitCode: 0 };
  }
  if (scopeContains(dir, workspace.root)) {
    return { line: "can't link a folder that contains the workspace itself", exitCode: 1 };
  }
  if ([...workspace.contextDirs, ...workspace.missingContextDirs].includes(dir)) {
    return { line: `${dir} is already linked`, exitCode: 0 };
  }
  return undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
