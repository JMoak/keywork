import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  canonicalPath,
  type JsonFileStore,
  jsonFileStore,
  openWorkspace,
  resolveAnchor,
  type WorkspaceAnchor,
  writeWorkspaceDeclaration,
} from "@keywork/shared";

export const stateLayoutVersion = 2;

export function projectKey(cwd: string, platform?: NodeJS.Platform): string {
  return identityHash(canonicalPath(cwd, platform));
}

export type WorkspaceIdentity = string;

export function workspaceIdentity(
  cwd: string,
  slug?: string,
  platform?: NodeJS.Platform,
): WorkspaceIdentity {
  const anchor = resolveAnchor(cwd);
  if (slug !== undefined) return anchoredIdentity(anchor.root, slug, platform);
  return anchor.source === "launch"
    ? projectKey(cwd, platform)
    : anchoredIdentity(anchor.root, undefined, platform);
}

export interface AnchoredFolder {
  cwd: string;
  slug: string | null;
  anchor: WorkspaceAnchor;
  identity: WorkspaceIdentity;
}

export function anchoredFolder(cwd: string, slug: string | null = null): AnchoredFolder {
  return {
    cwd,
    slug,
    anchor: resolveAnchor(cwd),
    identity: workspaceIdentity(cwd, slug ?? undefined),
  };
}

export function anchoredElsewhere(folder: Pick<AnchoredFolder, "cwd" | "anchor">): boolean {
  return canonicalPath(folder.cwd) !== canonicalPath(folder.anchor.root);
}

export function anchorWords(anchor: WorkspaceAnchor): string {
  return `${anchor.root} (${anchorSourceWords[anchor.source]})`;
}

export function sharedIdentityOf(
  folders: readonly AnchoredFolder[],
): [AnchoredFolder, AnchoredFolder] | undefined {
  const seen = new Map<WorkspaceIdentity, AnchoredFolder>();
  for (const folder of folders) {
    const first = seen.get(folder.identity);
    if (first !== undefined && canonicalPath(first.cwd) !== canonicalPath(folder.cwd)) {
      return [first, folder];
    }
    seen.set(folder.identity, first ?? folder);
  }
  return undefined;
}

export function defaultSessionDir(cwd: string, slug?: string): string {
  return join(keyworkHome(), "sessions", workspaceIdentity(cwd, slug));
}

export function snapshotGitDir(cwd: string, slug?: string): string {
  return join(keyworkHome(), "snapshots", workspaceIdentity(cwd, slug));
}

export function workspaceStateFile(identity: WorkspaceIdentity): string {
  return join(keyworkHome(), "workspaces", `${identity}.json`);
}

export function workspacePermissionsFile(
  identity: WorkspaceIdentity,
  userRoot: string = homedir(),
): string {
  return join(keyworkHome(userRoot), "workspaces", identity, "permissions.json");
}

export function workspaceWriterFile(cwd: string, slug?: string, userRoot?: string): string {
  return join(keyworkHome(userRoot), "workspaces", workspaceIdentity(cwd, slug), "writer.sqlite");
}

export function skillTelemetryFile(
  identity: WorkspaceIdentity,
  userRoot: string = homedir(),
): string {
  return join(keyworkHome(userRoot), "skills", `${identity}.json`);
}

export function botSkillTelemetryFile(
  identity: WorkspaceIdentity,
  slug: string,
  userRoot: string = homedir(),
): string {
  return join(keyworkHome(userRoot), "skills", identity, `bot-${slug}.json`);
}

export interface StateMigration {
  from: number;
  migrate: (stateHome: string) => void;
}

export const stateLayoutMigrations: readonly StateMigration[] = [];

export class StateLayoutError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "StateLayoutError";
  }
}

export function ensureStateLayout(
  stateHome: string = keyworkHome(),
  migrations: readonly StateMigration[] = stateLayoutMigrations,
  version: number = stateLayoutVersion,
): number {
  const marker = stateLayoutMarker(stateHome);
  const recorded = marker.read()?.version;
  if (recorded !== undefined && recorded > version) {
    throw new StateLayoutError(
      `state layout at ${stateHome} is version ${recorded}, newer than this keywork understands (${version}); update keywork before opening it`,
    );
  }
  if (recorded !== undefined && recorded < version) {
    for (const migration of pendingMigrations(migrations, recorded, version)) {
      migration.migrate(stateHome);
    }
  }
  if (recorded !== version) marker.write({ version });
  return version;
}

export function keyworkHome(userRoot: string = homedir()): string {
  return join(userRoot, ".keywork");
}

export function managedHomeFolder(userRoot: string = homedir()): string {
  return resolve(keyworkHome(userRoot), "home");
}

export function prepareManagedHome(userRoot: string = homedir()): string {
  const root = managedHomeFolder(userRoot);
  const existing = existingManagedHome(userRoot);
  if (existing !== undefined) return existing;
  ensureStateLayout(keyworkHome(userRoot));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeWorkspaceDeclaration(root, { name: "Creature home" });
  const prepared = existingManagedHome(userRoot);
  if (prepared === undefined) throw invalidManagedHome();
  return prepared;
}

export function existingManagedHome(userRoot: string = homedir()): string | undefined {
  const root = managedHomeFolder(userRoot);
  for (const path of [dirname(root), root, join(root, ".keywork")]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isDirectory()) throw invalidManagedHome();
  }
  const declaration = join(root, ".keywork", "workspace.json");
  const declarationStat = lstatSync(declaration, { throwIfNoEntry: false });
  if (declarationStat === undefined) return undefined;
  if (!declarationStat.isFile()) throw invalidManagedHome();
  const expected = join(realpathSync(userRoot), ".keywork", "home");
  if (canonicalPath(realpathSync(root)) !== canonicalPath(expected)) throw invalidManagedHome();
  const workspace = openWorkspace(root);
  if (
    workspace?.root !== root ||
    workspace.contextDirs.length !== 0 ||
    workspace.missingContextDirs.length !== 0
  )
    throw invalidManagedHome();
  return root;
}

function invalidManagedHome(): Error {
  return new Error("the managed creature home must have its own local workspace directory");
}

interface StateLayoutMarker {
  version: number;
}

function stateLayoutMarker(stateHome: string): JsonFileStore<StateLayoutMarker> {
  const file = join(stateHome, "state-layout.json");
  return jsonFileStore<StateLayoutMarker>({
    file,
    mode: "strict",
    error: (path, detail) => new StateLayoutError(`state layout marker at ${path} is ${detail}`),
    validate: (data) => {
      const version = (data as { version?: unknown }).version;
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        throw new StateLayoutError(`state layout marker at ${file} has no usable version`);
      }
      return { version };
    },
  });
}

function pendingMigrations(
  migrations: readonly StateMigration[],
  recorded: number,
  version: number,
): StateMigration[] {
  return [...migrations]
    .filter((migration) => migration.from >= recorded && migration.from < version)
    .sort((a, b) => a.from - b.from);
}

const anchorSourceWords: Readonly<Record<WorkspaceAnchor["source"], string>> = {
  declaration: "its declared workspace root",
  git: "its git root",
  launch: "the folder itself",
};

function anchoredIdentity(root: string, slug?: string, platform?: NodeJS.Platform): string {
  const canonicalRoot = canonicalPath(root, platform);
  return identityHash(
    slug === undefined ? `workspace:${canonicalRoot}` : `workspace:${canonicalRoot}:${slug}`,
  );
}

function identityHash(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 12);
}
