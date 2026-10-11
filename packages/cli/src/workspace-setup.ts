import { openWorkspace, resolveAnchor, type TrustStore } from "@keywork/shared";
import type { WorkspaceReadiness, WorkspaceSetupPort } from "@keywork/tui";
import { type AnchorMemory, fileAnchorMemory } from "./anchor.ts";
import { materializeWorkspace } from "./materialize.ts";

export interface WorkspaceSetupOptions {
  cwd: string;
  trustStore: TrustStore;
  workspaceSlug?: string | undefined;
  anchorMemory?: AnchorMemory | undefined;
  requestReopen?: (() => void) | undefined;
}

export function workspaceSetupPort(options: WorkspaceSetupOptions): WorkspaceSetupPort {
  const anchors = options.anchorMemory ?? fileAnchorMemory();
  return {
    readiness: () => workspaceReadiness(options, anchors),
    setUp: async () => {
      const root = setupRoot(options.cwd, anchors);
      if (resolveAnchor(options.cwd).source === "launch") anchors.remember(options.cwd, root);
      grantTrust(root, options);
      const workspace =
        openWorkspace(options.cwd, options.workspaceSlug) ?? materializeWorkspace(root);
      options.requestReopen?.();
      return { root, vault: workspace.vaultPath, reopens: options.requestReopen !== undefined };
    },
  };
}

export function workspaceReadiness(
  options: Pick<WorkspaceSetupOptions, "cwd" | "trustStore" | "workspaceSlug">,
  anchors: AnchorMemory = fileAnchorMemory(),
): WorkspaceReadiness {
  const root = setupRoot(options.cwd, anchors);
  switch (options.trustStore.resolve(options.cwd)) {
    case "untrusted":
      return { kind: "refused", root };
    case "undecided":
      return { kind: "undecided", root };
    case "trusted": {
      const workspace = openWorkspace(options.cwd, options.workspaceSlug);
      return workspace === undefined
        ? { kind: "undeclared", root }
        : { kind: "ready", root: workspace.root, vault: workspace.vaultPath };
    }
  }
}

function setupRoot(cwd: string, anchors: AnchorMemory): string {
  const anchor = resolveAnchor(cwd);
  if (anchor.source !== "launch") return anchor.root;
  return anchors.recall(cwd) ?? anchor.root;
}

function grantTrust(root: string, options: WorkspaceSetupOptions): void {
  switch (options.trustStore.resolve(options.cwd)) {
    case "trusted":
      return;
    case "undecided":
      options.trustStore.trust(root);
      return;
    case "untrusted":
      throw new Error(
        `${root} is marked untrusted, so keywork won't write a workspace there · keywork trust reverses that`,
      );
  }
}
