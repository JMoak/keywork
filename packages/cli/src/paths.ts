import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath, type JsonFileStore, jsonFileStore, resolveAnchor } from "@keywork/shared";

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

export function defaultSessionDir(cwd: string, slug?: string): string {
  return join(keyworkHome(), "sessions", workspaceIdentity(cwd, slug));
}

export function snapshotGitDir(cwd: string, slug?: string): string {
  return join(keyworkHome(), "snapshots", workspaceIdentity(cwd, slug));
}

export function workspaceStateFile(identity: WorkspaceIdentity): string {
  return join(keyworkHome(), "workspaces", `${identity}.json`);
}

export function skillTelemetryFile(identity: WorkspaceIdentity): string {
  return join(keyworkHome(), "skills", `${identity}.json`);
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

export function keyworkHome(): string {
  return join(homedir(), ".keywork");
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

function anchoredIdentity(root: string, slug?: string, platform?: NodeJS.Platform): string {
  const canonicalRoot = canonicalPath(root, platform);
  return identityHash(
    slug === undefined ? `workspace:${canonicalRoot}` : `workspace:${canonicalRoot}:${slug}`,
  );
}

function identityHash(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 12);
}
