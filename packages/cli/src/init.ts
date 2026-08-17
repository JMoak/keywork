import { openWorkspace, resolveAnchor, type TrustStore, type Workspace } from "@keywork/shared";
import { type AnchorMemory, fileAnchorMemory } from "./anchor.ts";
import { materializeWorkspace } from "./materialize.ts";

export interface WorkspaceCommandIo {
  print?: (line: string) => void;
  printError?: (line: string) => void;
}

export type Confirm = (question: string) => Promise<boolean>;

export async function initCommand(
  cwd: string,
  trustStore: TrustStore,
  io: WorkspaceCommandIo = {},
  confirm?: Confirm,
  anchorMemory: AnchorMemory = fileAnchorMemory(),
): Promise<number> {
  const print = io.print ?? console.log;
  const printError = io.printError ?? console.error;
  const existing = openWorkspace(cwd);
  if (existing !== undefined) {
    print(`this workspace is already set up at ${existing.root}`);
    return 0;
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
  print(`workspace ready at ${workspace.root}`);
  print(`memory lives in ${workspace.vaultPath}`);
  return 0;
}

export interface EnsureWorkspaceOptions {
  cwd: string;
  trustStore: TrustStore;
  print: (line: string) => void;
  printError: (line: string) => void;
  confirm?: Confirm | undefined;
  anchorMemory: AnchorMemory;
}

export async function ensureWorkspace(
  options: EnsureWorkspaceOptions,
): Promise<Workspace | undefined> {
  const root = await chooseRoot(options);
  if (root === undefined) return undefined;
  if (!(await ensureTrusted(root, options))) return undefined;
  return openWorkspace(root) ?? materializeWorkspace(root);
}

async function chooseRoot(options: EnsureWorkspaceOptions): Promise<string | undefined> {
  const anchor = resolveAnchor(options.cwd);
  if (anchor.source !== "launch") return anchor.root;
  const remembered = options.anchorMemory.recall(options.cwd);
  if (remembered !== undefined) return remembered;
  if (options.confirm === undefined) {
    options.printError(
      "no git repo here to anchor to. run this from a terminal so keywork can ask where the workspace lives",
    );
    return undefined;
  }
  if (await options.confirm(`no git repo here. anchor the workspace at ${anchor.root}? [y/N] `)) {
    options.anchorMemory.remember(options.cwd, anchor.root);
    return anchor.root;
  }
  options.print("okay, nothing set up");
  return undefined;
}

async function ensureTrusted(root: string, options: EnsureWorkspaceOptions): Promise<boolean> {
  switch (options.trustStore.resolve(root)) {
    case "trusted":
      return true;
    case "untrusted":
      options.printError(
        `${root} is marked untrusted, so keywork won't write a workspace there. run keywork trust if you've changed your mind`,
      );
      return false;
    case "undecided":
      return grantTrust(root, options);
  }
}

async function grantTrust(root: string, options: EnsureWorkspaceOptions): Promise<boolean> {
  if (options.confirm === undefined) {
    options.printError(`trust ${root} first: run keywork trust, then try again`);
    return false;
  }
  const granted = await options.confirm(
    `trust ${root}? keywork will keep workspace files and memory in .keywork [y/N] `,
  );
  if (!granted) {
    options.print("workspace setup needs trust. nothing written");
    return false;
  }
  try {
    options.trustStore.trust(root);
  } catch (cause) {
    options.printError((cause as Error).message);
    return false;
  }
  return true;
}
