import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type Provider, scopeContains } from "@keywork/engine";
import {
  openWorkspace,
  resolveAnchor,
  type Workspace,
  writeWorkspaceDeclaration,
} from "@keywork/shared";
import { type AnchorMemory, fileAnchorMemory } from "./anchor.ts";

export function materializeWorkspace(root: string, name: string = basename(root)): Workspace {
  writeWorkspaceDeclaration(root, { name });
  mkdirSync(join(root, ".keywork", "memory"), { recursive: true });
  const workspace = openWorkspace(root);
  if (workspace === undefined) throw new Error(`workspace at ${root} is missing right after setup`);
  return workspace;
}

export interface DeferredMaterializationOptions {
  cwd: string;
  trusted: boolean;
  headless?: boolean;
  anchorMemory?: AnchorMemory;
  report?: (line: string) => void;
}

export interface DeferredMaterialization {
  wrapProvider(provider: Provider): Provider;
  fileSaved(path: string): void;
  materialized(): boolean;
}

export function deferredMaterialization(
  options: DeferredMaterializationOptions,
): DeferredMaterialization {
  let attempted = false;
  let created = false;
  const attemptOnce = (): void => {
    if (attempted) return;
    attempted = true;
    try {
      created = materializeIfDue(options);
    } catch (cause) {
      options.report?.(`keywork: workspace setup failed: ${(cause as Error).message}`);
    }
  };
  return {
    wrapProvider: (provider) => ({
      name: provider.name,
      modelId: provider.modelId,
      stream: (request) => {
        attemptOnce();
        return provider.stream(request);
      },
    }),
    fileSaved: (path) => {
      if (scopeContains(anchorRootFor(options), path)) attemptOnce();
    },
    materialized: () => created,
  };
}

function materializeIfDue(options: DeferredMaterializationOptions): boolean {
  if (options.headless === true || !options.trusted) return false;
  const anchor = resolveAnchor(options.cwd);
  if (anchor.source === "declaration") return false;
  const root =
    anchor.source === "git"
      ? anchor.root
      : (options.anchorMemory ?? fileAnchorMemory()).recall(options.cwd);
  if (root === undefined) return false;
  materializeWorkspace(root);
  options.report?.(`keywork: workspace created at ${root}, memory lives in .keywork`);
  return true;
}

function anchorRootFor(options: DeferredMaterializationOptions): string {
  return resolveAnchor(options.cwd).root;
}
