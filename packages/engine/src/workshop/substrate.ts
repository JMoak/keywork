import { randomBytes } from "node:crypto";
import type { DisplayPort } from "./display.ts";
import type { WorkshopSpec } from "./spec.ts";

export const substrateKinds = ["sbx", "compose", "host"] as const;

export type SubstrateKind = (typeof substrateKinds)[number];

export type WorkshopHealth = "up" | "starting" | "unresponsive" | "down";

export interface WorkshopSubstrate {
  kind: SubstrateKind;
  availability(): Promise<SubstrateAvailability>;
  create(spec: WorkshopSpec, place?: WorkshopPlace): Promise<Workshop>;
  start(workshop: Workshop): Promise<void>;
  stop(workshop: Workshop): Promise<void>;
  snapshot(workshop: Workshop, label: string): Promise<Snapshot>;
  fork(snapshot: Snapshot): Promise<Workshop>;
  exec(workshop: Workshop, cmd: Command): Promise<Exit>;
  files(workshop: Workshop): FileSystemPort;
  display(workshop: Workshop): DisplayPort | undefined;
  health(workshop: Workshop): Promise<WorkshopHealth>;
  remove(workshop: Workshop, keepDisk: boolean): Promise<void>;
  resources(workshop: Workshop): Promise<MeasuredResources>;
}

export type SubstrateAvailability =
  | { readonly supported: true; readonly version: string | null }
  | { readonly supported: false; readonly reason: string };

export interface MeasuredResources {
  readonly disk: { readonly usedBytes: number | null; readonly sizeBytes: number | null };
  readonly memory: { readonly usedBytes: number | null; readonly totalBytes: number | null };
  readonly unmeasured: readonly string[];
}

export interface Workshop {
  readonly id: string;
  readonly creature: string;
  readonly substrate: SubstrateKind;
  readonly handle: string;
  readonly workdir: string;
  readonly workspace?: string | undefined;
  readonly brokers: readonly string[];
  readonly limitations: readonly string[];
}

export interface WorkshopPlace {
  readonly workspace: string;
}

export interface Snapshot {
  readonly workshop: string;
  readonly label: string;
  readonly takenAt: string;
}

export interface Command {
  readonly run: string | readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface Exit {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface FileSystemPort {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export class WorkshopRefusal extends Error {
  constructor(
    readonly reason: "deferred" | "not-running" | "unhealthy" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "WorkshopRefusal";
  }
}

export const defaultExecTimeoutMs = 120_000;

export function deferredSnapshots(kind: SubstrateKind): WorkshopRefusal {
  return new WorkshopRefusal(
    "deferred",
    `snapshots and forks of ${kind} workshops are deferred past milestone one`,
  );
}

export function workshopId(creature: string): string {
  return `${creature}-${randomBytes(3).toString("hex")}`;
}

export function notRunning(workshop: Workshop): WorkshopRefusal {
  return new WorkshopRefusal("not-running", `workshop ${workshop.id} is not running`);
}
