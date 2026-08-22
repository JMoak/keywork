import {
  openWorkspace,
  resolveAnchor,
  type TrustStore,
  toError,
  type Workspace,
} from "@keywork/shared";
import { type AnchorMemory, fileAnchorMemory } from "./anchor.ts";
import {
  type CommandIo,
  type Confirm,
  type ResolvedCommandIo,
  resolveCommandIo,
} from "./command-io.ts";
import { materializeWorkspace } from "./materialize.ts";

export async function initCommand(
  cwd: string,
  trustStore: TrustStore,
  io: CommandIo = {},
  confirm?: Confirm,
  anchorMemory: AnchorMemory = fileAnchorMemory(),
): Promise<number> {
  const resolved = resolveCommandIo(io);
  const existing = openWorkspace(cwd);
  if (existing !== undefined) {
    resolved.print(`this workspace is already set up at ${existing.root}`);
    return 0;
  }
  const workspace = await ensureWorkspace({ cwd, trustStore, io: resolved, confirm, anchorMemory });
  if (workspace === undefined) return 1;
  resolved.print(`workspace ready at ${workspace.root}`);
  resolved.print(`memory lives in ${workspace.vaultPath}`);
  return 0;
}

export interface EnsureWorkspaceOptions {
  cwd: string;
  trustStore: TrustStore;
  io: ResolvedCommandIo;
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
    options.io.printError(
      "no git repo here to anchor to. run this from a terminal so keywork can ask where the workspace lives",
    );
    return undefined;
  }
  if (await options.confirm(`no git repo here. anchor the workspace at ${anchor.root}? [y/N] `)) {
    options.anchorMemory.remember(options.cwd, anchor.root);
    return anchor.root;
  }
  options.io.print("okay, nothing set up");
  return undefined;
}

async function ensureTrusted(root: string, options: EnsureWorkspaceOptions): Promise<boolean> {
  switch (options.trustStore.resolve(root)) {
    case "trusted":
      return true;
    case "untrusted":
      options.io.printError(
        `${root} is marked untrusted, so keywork won't write a workspace there. run keywork trust if you've changed your mind`,
      );
      return false;
    case "undecided":
      return grantTrust(root, options);
  }
}

async function grantTrust(root: string, options: EnsureWorkspaceOptions): Promise<boolean> {
  if (options.confirm === undefined) {
    options.io.printError(`trust ${root} first: run keywork trust, then try again`);
    return false;
  }
  const granted = await options.confirm(
    `trust ${root}? keywork will keep workspace files and memory in .keywork [y/N] `,
  );
  if (!granted) {
    options.io.print("workspace setup needs trust. nothing written");
    return false;
  }
  try {
    options.trustStore.trust(root);
  } catch (cause) {
    options.io.printError(toError(cause).message);
    return false;
  }
  return true;
}
