import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAnchor } from "@keywork/shared";

export const stateLayoutVersion = 2;

export function projectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

export type WorkspaceIdentity = string;

export function workspaceIdentity(cwd: string): WorkspaceIdentity {
  const anchor = resolveAnchor(cwd);
  return anchor.source === "launch" ? projectKey(cwd) : anchoredIdentity(anchor.root);
}

export function defaultSessionDir(cwd: string): string {
  return join(keyworkHome(), "sessions", workspaceIdentity(cwd));
}

export function snapshotGitDir(cwd: string): string {
  return join(keyworkHome(), "snapshots", workspaceIdentity(cwd));
}

export function workspaceStateFile(identity: WorkspaceIdentity): string {
  return join(keyworkHome(), "workspaces", `${identity}.json`);
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
  const recorded = readLayoutVersion(stateHome);
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
  if (recorded !== version) writeLayoutVersion(stateHome, version);
  return version;
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

function keyworkHome(): string {
  return join(homedir(), ".keywork");
}

function anchoredIdentity(root: string): string {
  return createHash("sha256").update(`workspace:${root}`).digest("hex").slice(0, 12);
}

function layoutFile(stateHome: string): string {
  return join(stateHome, "state-layout.json");
}

function readLayoutVersion(stateHome: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(layoutFile(stateHome), "utf8");
  } catch {
    return undefined;
  }
  const version = (parseLayout(stateHome, raw) as { version?: unknown }).version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new StateLayoutError(
      `state layout marker at ${layoutFile(stateHome)} has no usable version`,
    );
  }
  return version;
}

function writeLayoutVersion(stateHome: string, version: number): void {
  mkdirSync(stateHome, { recursive: true });
  writeFileSync(layoutFile(stateHome), `${JSON.stringify({ version }, null, 2)}\n`, "utf8");
}

function parseLayout(stateHome: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new StateLayoutError(
      `state layout marker at ${layoutFile(stateHome)} is not valid JSON: ${(cause as Error).message}`,
    );
  }
}
