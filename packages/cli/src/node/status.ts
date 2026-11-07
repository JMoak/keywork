import { type AnchoredFolder, anchoredElsewhere, anchoredFolder, anchorWords } from "../paths.ts";
import { type NodeStoppedItem, readStoppedItem, resetCommand } from "./desk.ts";
import {
  type Answers,
  boundAddresses,
  coreStart,
  type Endpoint,
  meshEndpoints,
  type UnitCheck,
  unitChecker,
} from "./liveness.ts";
import type { ManagerKind, ManagerStatus, ServiceManager } from "./manager.ts";
import { type NodeFile, nodeFileStore, type UnitView, type WorkspaceView } from "./node-file.ts";
import type { NodePaths } from "./paths.ts";
import { type ClaimDesk, groupedClaimCode, type HeldClaimCode } from "./reconcile.ts";

export type NodeLiveness = "running" | "stopped" | "stale" | "absent";

export interface NodeStatusReport {
  registration:
    | (ManagerStatus & { manager: ManagerKind; name: string; program: string | null })
    | null;
  liveness: NodeLiveness;
  node: NodeFile | null;
  held: NodeStoppedItem | null;
  pairing: { state: "claimed" | "unclaimed" | "unknown"; claim: HeldClaimCode | null };
  units: { core: UnitCheck | null; workspaces: UnitCheck[] };
  anchors: (AnchoredFolder | null)[];
  mesh: { addresses: string[] };
  files: { nodeFile: string; config: string; nodeLog: string; lifecycleLog: string };
}

export interface NodeStatusOptions {
  paths: NodePaths;
  manager: ServiceManager | undefined;
  isAlive: (pid: number) => boolean;
  claimDesk: ClaimDesk;
  answers?: Answers;
  anchorOf?: (cwd: string, slug: string | null) => AnchoredFolder;
}

export async function nodeStatus(options: NodeStatusOptions): Promise<NodeStatusReport> {
  const { paths, manager } = options;
  const node = nodeFileStore(paths.nodeFile).read() ?? null;
  const addresses = node === null ? [] : boundAddresses(paths.nodeLog, coreStart(node));
  const check = unitChecker({ isAlive: options.isAlive, answers: options.answers });
  return {
    registration:
      manager === undefined
        ? null
        : {
            manager: manager.kind,
            name: manager.defaultName,
            ...(await manager.status(manager.defaultName)),
            program: (await manager.program(manager.defaultName)) ?? null,
          },
    liveness: livenessOf(node, options.isAlive),
    node,
    held: readStoppedItem(paths.stoppedItem) ?? null,
    pairing: await pairingOf(options.claimDesk),
    units: {
      core: node === null ? null : await check(node.core, meshEndpoints(node, addresses)),
      workspaces: await Promise.all(
        (node?.workspaces ?? []).map((workspace) => check(workspace, urlEndpoints(workspace))),
      ),
    },
    anchors: (node?.workspaces ?? []).map(({ cwd, slug }) => {
      try {
        return (options.anchorOf ?? anchoredFolder)(cwd, slug);
      } catch {
        return null;
      }
    }),
    mesh: { addresses },
    files: {
      nodeFile: paths.nodeFile,
      config: paths.config,
      nodeLog: paths.nodeLog,
      lifecycleLog: paths.lifecycleLog,
    },
  };
}

export function statusLines(report: NodeStatusReport): string[] {
  return [
    registrationLine(report),
    livenessLine(report),
    ...heldLines(report.held),
    ...workspaceLines(report.node?.workspaces ?? [], report.units.workspaces, report.anchors),
    ...coreLines(report.node, report.units.core, report.mesh.addresses),
    pairingLine(report.pairing),
    `files: ${report.files.nodeFile} · ${report.files.config}`,
    `logs: ${report.files.nodeLog} · ${report.files.lifecycleLog}`,
  ];
}

function livenessOf(node: NodeFile | null, isAlive: (pid: number) => boolean): NodeLiveness {
  if (node === null) return "absent";
  if (node.state === "stopped") return "stopped";
  return node.pid !== null && isAlive(node.pid) ? "running" : "stale";
}

async function pairingOf(desk: ClaimDesk): Promise<NodeStatusReport["pairing"]> {
  try {
    const state = await desk.claimState();
    return { state, claim: state === "unclaimed" ? await desk.live() : null };
  } catch {
    return { state: "unknown", claim: null };
  }
}

function registrationLine(report: NodeStatusReport): string {
  const registration = report.registration;
  if (registration === null) return "registration: no service manager is known on this platform";
  if (!registration.installed) {
    return `registration: not installed (${registration.manager} ${registration.name}); keywork node install sets it up`;
  }
  const notes = registration.notes.length === 0 ? "" : ` · ${registration.notes.join(" · ")}`;
  return `registration: ${registration.manager} "${registration.name}" is ${registration.state}${notes}`;
}

function livenessLine(report: NodeStatusReport): string {
  const node = report.node;
  switch (report.liveness) {
    case "absent":
      return "node: no node.json yet; the node has not run on this machine";
    case "stale":
      return `node: node.json says running as pid ${node?.pid ?? "unknown"}, but that process is gone`;
    case "stopped":
      return `node: stopped at ${node?.stopped?.at ?? node?.updatedAt ?? "an unknown time"} (${node?.stopped?.reason ?? "no reason recorded"})`;
    case "running":
      return `node: running as pid ${node?.pid} since ${node?.startedAt} · keywork ${node?.version} · machine ${node?.machine.name} (${node?.machine.id})`;
  }
}

function heldLines(held: NodeStoppedItem | null): string[] {
  if (held === null) return [];
  return [
    `held: ${held.title} at ${held.at} after ${held.reason}; ${resetCommand} starts it again`,
    ...held.logTail.slice(-5).map((line) => `  ${line}`),
  ];
}

function workspaceLines(
  workspaces: readonly WorkspaceView[],
  checks: readonly UnitCheck[],
  anchors: readonly (AnchoredFolder | null)[] = [],
): string[] {
  return workspaces.map((workspace, index) => {
    const check = checks[index];
    const where =
      check?.verdict === "stale" || workspace.url === null ? "" : ` at ${workspace.url}`;
    return `workspace: ${workspace.cwd}${workspace.slug === null ? "" : ` (${workspace.slug})`} ${unitText(workspace, check)}${where}${anchorText(anchors[index])} · ticket ${workspace.ticket}`;
  });
}

function anchorText(folder: AnchoredFolder | null | undefined): string {
  if (folder === null || folder === undefined || !anchoredElsewhere(folder)) return "";
  return ` · opens the workspace at ${anchorWords(folder.anchor)}, identity ${folder.identity}`;
}

function coreLines(
  node: NodeFile | null,
  check: UnitCheck | null,
  addresses: readonly string[],
): string[] {
  if (node === null) return [];
  return [
    `core: ${unitText(node.core, check ?? undefined)} · ${portsText(node, check, addresses)}`,
  ];
}

function portsText(node: NodeFile, check: UnitCheck | null, addresses: readonly string[]): string {
  const mesh = node.ports.mesh;
  if (mesh === null) return "mesh off";
  const screen =
    node.ports.screenUdp === null
      ? ""
      : `, screen ${node.ports.screenUdp.first}-${node.ports.screenUdp.last}/udp`;
  const bound =
    check?.verdict === "stale" || addresses.length === 0
      ? ""
      : ` on ${addresses.map((address) => hostPort(address, mesh)).join(", ")}`;
  return `mesh ${mesh}/tcp${bound}${screen}`;
}

function unitText(unit: UnitView, check?: UnitCheck): string {
  if (check?.verdict === "stale") return staleText;
  const pid = unit.pid === null ? "" : ` as pid ${unit.pid}`;
  const restarts = unit.restarts === 0 ? "" : `, ${unit.restarts} restart(s)`;
  return `${unit.state}${pid}${restarts}`;
}

function pairingLine(pairing: NodeStatusReport["pairing"]): string {
  if (pairing.state !== "unclaimed") return `pairing: ${pairing.state}`;
  return pairing.claim === null
    ? "pairing: unclaimed; no claim code is live (a headless node prints one when it starts)"
    : `pairing: unclaimed; claim code ${groupedClaimCode(pairing.claim.code)} valid until ${pairing.claim.expiresAt}`;
}

const staleText = "stopped (stale node.json)";

function urlEndpoints(workspace: WorkspaceView): Endpoint[] {
  if (workspace.url === null) return [];
  try {
    const url = new URL(workspace.url);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return [{ host: url.hostname.replace(/^\[|\]$/g, ""), port }];
  } catch {
    return [];
  }
}

function hostPort(address: string, port: number): string {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}
