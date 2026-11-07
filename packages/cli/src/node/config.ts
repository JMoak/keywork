import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultMeshPort, isPort, type PortRange, screenUdpPorts } from "@keywork/engine";
import { canonicalPath } from "@keywork/shared";
import { type AnchoredFolder, anchoredFolder, anchorWords, sharedIdentityOf } from "../paths.ts";

export interface NodeWorkspace {
  cwd: string;
  slug: string | null;
  home?: true;
}

export type { PortRange };

export interface NodeConfig {
  workspaces: NodeWorkspace[];
  mesh: { enabled: boolean; port: number; screenUdp: PortRange };
  headless: boolean;
}

export const nodeConfigDescriptions = {
  "workspaces.home":
    "Marks the dedicated private personal home, so the node serves its creature identity without granting a project or user-profile root.",
  workspaces:
    "The workspaces this node serves, one keywork serve each on a loopback ephemeral port; keywork node install adds the folder it runs in (none with --no-workspace) and keywork node workspace add the folders the console opens, so creatures keep working when the console closes.",
  "mesh.enabled":
    "Whether the node opens its tailnet listener; off keeps a machine out of the stead while it still serves its own console.",
  "mesh.port":
    "The TCP port of the tailnet listener (47800 by default) so peers and the firewall rule agree on one number.",
  "mesh.screenUdp":
    "The UDP range screen sessions may use (47810 to 47829 by default), the only UDP the firewall rule admits from tailnet ranges.",
  headless:
    "A host without a console of its own: on start, an unclaimed headless node prints a claim code so the keeper can pair it from another machine.",
} as const;

export class NodeConfigError extends Error {
  constructor(file: string, detail: string) {
    super(`node config at ${file} ${detail}`);
    this.name = "NodeConfigError";
  }
}

export function defaultNodeConfig(): NodeConfig {
  return {
    workspaces: [],
    mesh: { enabled: true, port: defaultMeshPort, screenUdp: { ...screenUdpPorts } },
    headless: false,
  };
}

export function readNodeConfig(file: string): NodeConfig {
  if (!existsSync(file)) return defaultNodeConfig();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new NodeConfigError(file, `is not valid JSON: ${(cause as Error).message}`);
  }
  const problem = (detail: string) => new NodeConfigError(file, detail);
  return parseNodeConfig(data, problem);
}

export function writeNodeConfig(file: string, config: NodeConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function withWorkspace(config: NodeConfig, workspace: NodeWorkspace): NodeConfig {
  const known = config.workspaces.find((entry) => sameWorkspace(entry, workspace));
  if (known !== undefined) {
    return workspace.home === true && known.home !== true
      ? {
          ...config,
          workspaces: config.workspaces.map((entry) =>
            entry === known ? { ...entry, home: true } : entry,
          ),
        }
      : config;
  }
  const workspaces = [...config.workspaces, workspace];
  const clash = identityClashOf(workspaces);
  if (clash !== undefined) throw new Error(`${workspace.cwd} cannot join the node: ${clash}`);
  return { ...config, workspaces };
}

export function withoutWorkspace(config: NodeConfig, workspace: NodeWorkspace): NodeConfig {
  const kept = config.workspaces.filter((entry) => !sameWorkspace(entry, workspace));
  return kept.length === config.workspaces.length ? config : { ...config, workspaces: kept };
}

export function identityClashOf(
  workspaces: readonly NodeWorkspace[],
  anchored: (workspace: NodeWorkspace) => AnchoredFolder = ({ cwd, slug }) =>
    anchoredFolder(cwd, slug),
): string | undefined {
  const pair = sharedIdentityOf(workspaces.map(anchored));
  if (pair === undefined) return undefined;
  const [first, second] = pair;
  return `${first.cwd} and ${second.cwd} both open the workspace at ${anchorWords(second.anchor)}, identity ${second.identity}, so the node would serve it twice on one ticket; keep one of them, or move the other out of that repository`;
}

export function sameWorkspace(left: NodeWorkspace, right: NodeWorkspace): boolean {
  return canonicalPath(left.cwd) === canonicalPath(right.cwd) && left.slug === right.slug;
}

type Problem = (detail: string) => Error;

function parseNodeConfig(data: unknown, problem: Problem): NodeConfig {
  const defaults = defaultNodeConfig();
  const root = record(data, "is not an object", problem);
  const mesh =
    root.mesh === undefined ? {} : record(root.mesh, "has a mesh that is not an object", problem);
  const workspaces = workspacesOf(root.workspaces, problem);
  const clash = identityClashOf(workspaces);
  if (clash !== undefined) throw problem(`is refused: ${clash}`);
  return {
    workspaces,
    mesh: {
      enabled: booleanOr(mesh.enabled, defaults.mesh.enabled, "mesh.enabled", problem),
      port: portOr(mesh.port, defaults.mesh.port, "mesh.port", problem),
      screenUdp: rangeOr(mesh.screenUdp, defaults.mesh.screenUdp, problem),
    },
    headless: booleanOr(root.headless, defaults.headless, "headless", problem),
  };
}

function workspacesOf(value: unknown, problem: Problem): NodeWorkspace[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw problem("has workspaces that are not a list");
  return value.map((entry, index) => {
    const workspace = record(entry, `has workspace ${index} that is not an object`, problem);
    if (typeof workspace.cwd !== "string" || workspace.cwd === "") {
      throw problem(`has workspace ${index} without a cwd`);
    }
    const slug = workspace.slug ?? null;
    if (slug !== null && typeof slug !== "string") {
      throw problem(`has workspace ${index} whose slug is not a string`);
    }
    if (workspace.home !== undefined && typeof workspace.home !== "boolean") {
      throw problem(`has workspace ${index} whose home marker is not a boolean`);
    }
    if (workspace.home === true && slug !== null) {
      throw problem(`has a personal home with a project workspace slug`);
    }
    return { cwd: workspace.cwd, slug, ...(workspace.home === true && { home: true as const }) };
  });
}

function record(value: unknown, detail: string, problem: Problem): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw problem(detail);
  return value as Record<string, unknown>;
}

function booleanOr(value: unknown, fallback: boolean, field: string, problem: Problem): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw problem(`has ${field} that is not true or false`);
  return value;
}

function portOr(value: unknown, fallback: number, field: string, problem: Problem): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !isPort(value)) {
    throw problem(`has ${field} that is not a port from 1 to 65535`);
  }
  return value;
}

function rangeOr(value: unknown, fallback: PortRange, problem: Problem): PortRange {
  if (value === undefined) return { ...fallback };
  const range = record(value, "has mesh.screenUdp that is not { first, last }", problem);
  const first = portOr(range.first, Number.NaN, "mesh.screenUdp.first", problem);
  const last = portOr(range.last, Number.NaN, "mesh.screenUdp.last", problem);
  if (!(first <= last)) throw problem("has mesh.screenUdp that runs backwards or is incomplete");
  return { first, last };
}
