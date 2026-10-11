import { open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { confinedPath, scopeContains, type ToolScope, toolScope } from "@keywork/engine";
import {
  type EventLog,
  type FileRange,
  type FileSlice,
  HostRefusal,
  maxFileBytes,
  sliceBounds,
  type TreeListing,
  type TrustGrant,
  type WorkspaceHost,
  type WorkspaceView,
} from "@keywork/server";
import {
  BlanketTrustError,
  completeTheme,
  openWorkspace,
  resolveAnchor,
  type TrustStore,
  wardrobe,
} from "@keywork/shared";
import {
  gitignoreFileName,
  IgnoreRules,
  keyworkNightTheme,
  readDirectoryFromDisk,
  relativeTo,
  sortEntries,
  systemThemeName,
} from "@keywork/tui";
import type { AnchorMemory } from "./anchor.ts";
import { workspaceToolScope } from "./compose.ts";
import { workspaceIdentity } from "./paths.ts";
import { setupRoot, workspaceReadiness } from "./workspace-setup.ts";

export interface WorkspaceHostOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug: string | undefined;
  trustStore: TrustStore;
  anchorMemory: AnchorMemory;
  theme: string | undefined;
  log: EventLog;
}

export function workspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
  const { cwd, workspaceSlug, trustStore, anchorMemory } = options;
  const jail = (): Jail =>
    new Jail(
      workspaceToolScope(cwd, options.projectTrusted, workspaceSlug),
      resolveAnchor(cwd).root,
    );
  return {
    workspace: async () => workspaceView(options),
    tree: (path) => jail().list(path),
    readFile: (path, range) => jail().slice(path, range),
    trustWorkspace: async () => {
      const root = setupRoot(cwd, anchorMemory);
      switch (trustStore.resolve(cwd)) {
        case "trusted":
          return { trusted: true, root, reopens: false };
        case "untrusted":
          throw new HostRefusal(
            409,
            `${root} is marked untrusted, so keywork won't write a workspace there · keywork trust reverses that`,
          );
        case "undecided":
          return recordTrust(root, options);
      }
    },
    themes: async () => ({
      themes: wardrobe().map(completeTheme),
      active: options.theme ?? keyworkNightTheme.name,
      placeholders: [systemThemeName],
    }),
  };
}

function workspaceView(options: WorkspaceHostOptions): WorkspaceView {
  const { cwd, workspaceSlug, trustStore, anchorMemory } = options;
  const anchor = resolveAnchor(cwd);
  const workspace = openWorkspace(cwd, workspaceSlug);
  return {
    anchor: { root: anchor.root, source: anchor.source },
    identity: workspaceIdentity(cwd, workspaceSlug),
    ...(workspaceSlug !== undefined && { slug: workspaceSlug }),
    ...(workspace !== undefined && {
      name: workspace.name,
      declarationFile: workspace.declarationFile,
      vault: workspace.vaultPath,
    }),
    declared: workspace !== undefined,
    contextDirs: workspace?.contextDirs ?? [],
    missingContextDirs: workspace?.missingContextDirs ?? [],
    focusDirs: workspace?.focusDirs ?? [],
    trust: trustStore.resolve(cwd),
    readiness: workspaceReadiness({ cwd, trustStore, workspaceSlug }, anchorMemory).kind,
  };
}

function recordTrust(root: string, options: WorkspaceHostOptions): TrustGrant {
  try {
    options.trustStore.trust(root);
  } catch (cause) {
    if (cause instanceof BlanketTrustError) throw new HostRefusal(400, cause.message);
    throw cause;
  }
  options.log.announce("surface.changed", { kind: "workspace" });
  return { trusted: true, root, reopens: true };
}

class Jail {
  constructor(
    private readonly scope: ToolScope,
    private readonly anchorRoot: string,
  ) {}

  async list(path: string): Promise<TreeListing> {
    const target = this.confine(path);
    const base = this.rootHolding(target);
    const entries = await readDirectoryFromDisk(target).catch(() => {
      throw new HostRefusal(404, `no directory at ${path}`);
    });
    const rules = await ignoreRulesAlong(base, target);
    const directory = relativeTo(base, target);
    return {
      path: directory,
      entries: sortEntries(entries).map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        ignored: rules.ignoresWithin(
          directory === "" ? entry.name : `${directory}/${entry.name}`,
          entry.kind,
        ),
        hidden: entry.name.startsWith("."),
      })),
    };
  }

  async slice(path: string, range: FileRange): Promise<FileSlice> {
    const target = this.confine(path);
    const info = await stat(target).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new HostRefusal(404, `no file at ${path}`);
    if (info.size > maxFileBytes) {
      throw new HostRefusal(413, `file too large (${megabytes(info.size)} MB)`);
    }
    const bounds = sliceBounds(info.size, range);
    const bytes = await readBytes(target, bounds.from, bounds.to);
    if (bytes.includes(0)) throw new HostRefusal(415, "binary file");
    return {
      path: relativeTo(this.rootHolding(target), target),
      ...bounds,
      text: bytes.toString("utf8"),
      encoding: "utf-8",
    };
  }

  private confine(path: string): string {
    try {
      return confinedPath(this.scope, resolve(this.anchorRoot, path));
    } catch (cause) {
      throw new HostRefusal(403, cause instanceof Error ? cause.message : String(cause));
    }
  }

  private rootHolding(target: string): string {
    return (
      this.scope.roots.find((root) => scopeContains(toolScope(root), target)) ?? this.anchorRoot
    );
  }
}

async function ignoreRulesAlong(base: string, target: string): Promise<IgnoreRules> {
  const rules = new IgnoreRules();
  for (const directory of directoriesFrom(base, target)) {
    const text = await readFile(join(directory, gitignoreFileName), "utf8").catch(() => undefined);
    if (text !== undefined) rules.add(relativeTo(base, directory), text);
  }
  return rules;
}

function directoriesFrom(base: string, target: string): string[] {
  const chain: string[] = [];
  for (let current = target; ; current = dirname(current)) {
    chain.unshift(current);
    if (relativeTo(base, current) === "" || dirname(current) === current) return chain;
  }
}

async function readBytes(path: string, from: number, to: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        from + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
