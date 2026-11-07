import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { brokerHosts } from "./brokers.ts";
import type { EgressRule } from "./egress.ts";
import type { WorkshopSpec } from "./spec.ts";
import type { MeasuredResources, SubstrateKind, Workshop } from "./substrate.ts";
import type { TerminalAccess, TerminalEntry } from "./terminal.ts";
import type { RefusalKind, WorkshopView } from "./workshops.ts";

export type WorkshopOperation =
  | "start"
  | "stop"
  | "health"
  | "remove"
  | "display"
  | "tools"
  | "detail"
  | "exec";

export interface WorkshopDetail extends WorkshopView {
  readonly workspace: WorkspaceReach;
  readonly egress: EgressReport;
  readonly resources: ResourceReport;
  readonly refusals: RefusalReport;
  readonly terminal: TerminalReport;
}

export interface WorkspaceReach {
  readonly access: "direct" | "working-copy" | "none";
  readonly path: string | null;
  readonly returns: string;
}

export interface EgressReport {
  readonly policy: "deny-all" | "none";
  readonly enforced: boolean;
  readonly rules: readonly EgressRule[];
  readonly brokerHosts: readonly string[];
}

export interface ResourceReport {
  readonly cpus: number;
  readonly memory: string;
  readonly disks: { readonly rootGb: number; readonly dockerGb: number } | null;
  readonly measured: MeasuredResources;
}

export interface RefusalEntry {
  readonly at: string;
  readonly operation: WorkshopOperation;
  readonly refused: RefusalKind;
  readonly error: string;
}

export interface RefusalReport {
  readonly entries: readonly RefusalEntry[];
  readonly unreported: string;
}

export interface TerminalReport extends TerminalAccess {
  readonly log: readonly TerminalEntry[];
}

export interface DetailFacts {
  readonly view: WorkshopView;
  readonly workshop: Pick<Workshop, "workspace">;
  readonly spec: WorkshopSpec;
  readonly measured: MeasuredResources;
  readonly refusals: readonly RefusalEntry[];
  readonly access: TerminalAccess;
  readonly terminal: readonly TerminalEntry[];
}

export const logTail = 50;

export const refusalLogFile = "refusals.jsonl";

export const terminalLogFile = "terminal.jsonl";

export const unreportedConnections: Readonly<Record<SubstrateKind, string>> = {
  sbx: "connections outside the egress rules are refused inside the microVM but not listed here: the pinned sbx documents no command that reads its network log, so reading one waits on the live sbx qualification",
  compose: "the Compose box is not qualified on this node, so it refuses and lists nothing",
  host: "a bare host has no egress policy, so no connection is refused and none can be listed",
};

export function workshopDetailOf(facts: DetailFacts): WorkshopDetail {
  const { view, spec } = facts;
  const sealed = view.substrate !== "host";
  return {
    ...view,
    workspace: reachOf(view.substrate, facts.workshop.workspace),
    egress: {
      policy: sealed ? "deny-all" : "none",
      enforced: sealed,
      rules: spec.egress,
      brokerHosts: brokerHosts(view.brokers),
    },
    resources: {
      cpus: spec.cpus,
      memory: spec.memory,
      disks: sealed ? spec.disks : null,
      measured: facts.measured,
    },
    refusals: { entries: facts.refusals, unreported: unreportedConnections[view.substrate] },
    terminal: { ...facts.access, log: facts.terminal },
  };
}

export const directReturns =
  "in place: a bare host workshop works in the workspace itself, its jail is the workspace path, and its home keeps only the workshop's own state";

export const sealedReturns =
  "through the airlock or a pushed branch: a sealed workshop never mounts the workspace and works on a copy in its own home";

export const homelessReturns =
  "nothing: this bare host workshop was raised outside a workspace and works only in its own home; remove it and raise it again from the workspace";

export async function appendEntry(dir: string, file: string, entry: object): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, file), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function tailEntries<Entry>(dir: string, file: string): Promise<Entry[]> {
  const text = await readFile(join(dir, file), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-logTail)
    .flatMap((line) => parsedLine<Entry>(line));
}

function reachOf(substrate: SubstrateKind, workspace: string | undefined): WorkspaceReach {
  if (substrate !== "host") {
    return { access: "working-copy", path: workspace ?? null, returns: sealedReturns };
  }
  return workspace === undefined
    ? { access: "none", path: null, returns: homelessReturns }
    : { access: "direct", path: workspace, returns: directReturns };
}

function parsedLine<Entry>(line: string): Entry[] {
  try {
    return [JSON.parse(line) as Entry];
  } catch {
    return [];
  }
}
