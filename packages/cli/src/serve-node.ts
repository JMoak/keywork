import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  type BenchOpener,
  benchBook,
  bindForClass,
  bindingCapabilities,
  CapabilityCache,
  type ConnectedServer,
  type CostSource,
  capabilityLearningFileIn,
  carriesUsage,
  costNanosOf,
  createTailnet,
  type Decider,
  defaultTransport,
  fileLicenseBook,
  type InferenceBinding,
  isLoopbackEndpoint,
  isTailnetEndpoint,
  type KeptCapabilities,
  keepCapabilities,
  localBenchOpener,
  localityOf,
  ModelInventory,
  type ModelReference,
  modelAcknowledgementsFile,
  modelBenchDir,
  type NormalizedUsage,
  type PolicyEnvironment,
  type ProbeHttp,
  type Provider,
  type ProviderAnswers,
  type ProviderRegistration,
  probedCapabilities,
  type RoutinesState,
  readSlate,
  registryBenchOpener,
  routinesStateOf,
  serverRootOf,
  stewardedInventory,
  type Tailnet,
  type TailnetNode,
  type Usage,
  UsageLedger,
  type UsageLedgerEntry,
  unacknowledgedLicense,
  type Workshops,
} from "@keywork/engine";
import { type EventLog, type ModelsPort, meshEventsInto } from "@keywork/server";
import { toError } from "@keywork/shared";
import { type HouseMeshConsole, houseMeshConsole, nodeWorkshops } from "./node/compose.ts";
import { readNodeConfig } from "./node/config.ts";
import { nodePaths, workspaceStateDir } from "./node/paths.ts";
import { type AskingTheServer, conversationModel } from "./serve-conversation-model.ts";
import { configuredModels } from "./serve-models.ts";

export interface ServedNodeOptions {
  cwd: string;
  workspaceSlug?: string | undefined;
  userRoot: string;
  log: EventLog;
  notice(text: string): void;
  modelProbe?: ProbeHttp | undefined;
  inventory?: NodeInventorySeams | undefined;
  now?: (() => Date) | undefined;
  // The tailnet the mesh reads this machine's identity from; its own tailscaled when left out.
  tailnet?: Tailnet | undefined;
}

export interface NodeInventorySeams {
  capabilities: CapabilityCache;
  registrations(): readonly ProviderRegistration[];
  provider(binding: InferenceBinding): Provider;
  decider(binding: InferenceBinding): Decider;
  inherit?: (() => ModelReference | undefined) | undefined;
  answers?: ProviderAnswers | undefined;
  headersFor?:
    | ((registration: ProviderRegistration) => Record<string, string> | undefined)
    | undefined;
}

export type NodePolicy = Required<Pick<PolicyEnvironment, "capabilityOf" | "refusalOf">>;

export interface ServedNode {
  state: string;
  routines: RoutinesState;
  workshops: Workshops;
  models: ModelsPort;
  ask: AskingTheServer;
  reach: AskingTheServer;
  policy: NodePolicy;
  usage: TurnUsage;
  mesh: HouseMeshConsole | undefined;
  learning: KeptCapabilities;
}

export interface TurnUsage {
  record(turn: MeteredTurn): void;
  workedOn(creature: string, date: string): Promise<CreatureDay>;
  flush(): Promise<void>;
}

export interface CreatureDay {
  sessions: readonly string[];
  costNanos: number | null;
}

export interface MeteredTurn {
  usage: Usage;
  provider: string;
  model: string | undefined;
  creature: string | null;
  session: string;
}

export async function servedNode(options: ServedNodeOptions): Promise<ServedNode> {
  const { log } = options;
  const machine = hostname();
  const state = nodePaths(options.userRoot).state;
  const workspaceState = workspaceStateDir(options.userRoot, options.cwd, options.workspaceSlug);
  const capabilities = options.inventory?.capabilities ?? new CapabilityCache();
  const learning = keepCapabilities(
    capabilities,
    capabilityLearningFileIn(workspaceState),
    options.notice,
  );
  const licenses = fileLicenseBook(modelAcknowledgementsFile(state));
  const slate = await readSlate().catch(() => undefined);
  const machineOf = machineNamer(machine, options.tailnet);
  const inventory = new ModelInventory({
    nodes: async () => [{ node: machine, address: localAddress, scan: true }],
    connections: () =>
      connectedServers(options.inventory?.registrations() ?? [], machineOf, options.inventory),
    cache: capabilities,
    ...(options.modelProbe !== undefined && { http: options.modelProbe }),
    announce: { node: machine, changed: (change) => log.record("", "models.changed", change) },
  });
  const policy: NodePolicy = {
    capabilityOf: probedCapabilities(capabilities),
    refusalOf: unacknowledgedLicense(licenses, slate),
  };
  const configured = configuredModels(
    stewardedInventory(inventory, {
      licenses,
      benches: benchBook({
        dir: modelBenchDir(state),
        openers: benchOpenersOver(capabilities, options),
      }),
      slate,
      registrations: options.inventory?.registrations,
      answers: options.inventory?.answers,
      inherit: options.inventory?.inherit,
      policy,
    }),
    {
      registrations: options.inventory?.registrations,
      capabilities,
      headersFor: options.inventory?.headersFor,
      toolsKnown: (registration, model) => {
        const bound = bindForClass({ provider: registration.name, model }, "strong", [
          registration,
        ]);
        return bound.ok && bindingCapabilities(bound.binding, policy).tools.known;
      },
      answers: (endpoint, headers) => inventory.answers(endpoint, headers),
      conversation:
        options.inventory === undefined
          ? undefined
          : () =>
              conversationModel(options.inventory?.inherit?.(), {
                registrations: options.inventory?.registrations() ?? [],
                ...policy,
              }),
    },
  );
  return {
    state,
    routines: routinesStateOf(workspaceState),
    workshops: nodeWorkshops(state, (change) => log.record("", "workshop.changed", change)),
    models: configured.models,
    ask: configured.ask,
    reach: configured.reach,
    policy,
    usage: await usageLedgerAt(join(workspaceState, "usage"), machine, options),
    mesh: await meshConsoleFor(state, options),
    learning,
  };
}

export type MachineOf = (endpoint: string) => Promise<string>;

export async function connectedServers(
  registrations: readonly ProviderRegistration[],
  machineOf: MachineOf,
  seams?: Pick<NodeInventorySeams, "headersFor"> | undefined,
): Promise<ConnectedServer[]> {
  const local = registrations.filter(
    (registration) => registration.enabled && localityOf(registration.endpoint) === "local",
  );
  return Promise.all(
    local.map(async (registration) => {
      const headers = seams?.headersFor?.(registration);
      return {
        name: registration.name,
        node: await machineOf(registration.endpoint),
        root: serverRootOf(registration.endpoint),
        auth: registration.credential.kind === "none" ? ("none" as const) : ("key" as const),
        ...(headers !== undefined && { headers }),
      };
    }),
  );
}

export function machineNamer(machine: string, tailnet: Tailnet | undefined): MachineOf {
  let peers: { at: number; nodes: Promise<readonly TailnetNode[]> } | undefined;
  const tailnetNodes = (): Promise<readonly TailnetNode[]> => {
    if (peers === undefined || Date.now() - peers.at > peersMaxAgeMs) {
      const reader = tailnet ?? createTailnet(defaultTransport());
      const nodes = reader
        .status()
        .then((status) => [...(status.self === null ? [] : [status.self]), ...status.peers])
        .catch(() => []);
      peers = { at: Date.now(), nodes };
    }
    return peers.nodes;
  };
  return async (endpoint) => {
    if (isLoopbackEndpoint(endpoint)) return machine;
    const host = hostOf(endpoint);
    if (host === undefined) return endpoint;
    if (!isTailnetEndpoint(endpoint) && host.includes(".")) return host;
    const nodes = await tailnetNodes();
    const found = nodes.find((node) => namesNode(node, host));
    return found === undefined ? host : found.hostName;
  };
}

const peersMaxAgeMs = 30_000;

function namesNode(node: TailnetNode, host: string): boolean {
  const dnsName = node.dnsName.replace(/\.$/, "").toLowerCase();
  return (
    node.tailscaleIPs.includes(host) ||
    dnsName === host ||
    dnsName.split(".")[0] === host ||
    node.hostName.toLowerCase() === host
  );
}

function hostOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

export function normalizedUsageOf(usage: Usage, model: string | undefined): NormalizedUsage | null {
  if (!carriesUsage(usage)) return null;
  const nanos = costNanosOf(usage, model);
  const written = usage.cacheCreationInputTokens ?? 0;
  return {
    inputUncached: usage.inputTokens,
    cacheRead: usage.cacheReadInputTokens ?? 0,
    cacheWrite: written > 0 ? [{ ttl: "unknown", tokens: written }] : [],
    output: usage.outputTokens,
    reasoning: null,
    images: null,
    decisionQuestions: null,
    msTtft: null,
    msTotal: null,
    tokS: null,
    cost: nanos === undefined ? null : nanos / nanosPerDollar,
    costSource: nanos === undefined ? null : costSourceOf(usage),
  };
}

export function spentNanos(entries: readonly UsageLedgerEntry[]): number | null {
  let nanos = 0;
  for (const { usage } of entries) {
    if (usage === null || usage.cost === null) return null;
    nanos += Math.round(usage.cost * nanosPerDollar);
  }
  return nanos;
}

const localAddress = "127.0.0.1";

function benchOpenersOver(
  capabilities: CapabilityCache,
  options: Pick<ServedNodeOptions, "inventory" | "modelProbe">,
): BenchOpener[] {
  const local = localBenchOpener({ cache: capabilities, http: options.modelProbe });
  return options.inventory === undefined
    ? [local]
    : [local, registryBenchOpener(options.inventory)];
}

function costSourceOf(usage: Usage): CostSource {
  return usage.costUsd === undefined ? "price_table" : "provider";
}
const nanosPerDollar = 1_000_000_000;

async function usageLedgerAt(
  dir: string,
  node: string,
  options: Pick<ServedNodeOptions, "notice" | "now">,
): Promise<TurnUsage> {
  const now = options.now ?? (() => new Date());
  const fileOf = (date: string) => join(dir, `${date}.jsonl`);
  let replaying = true;
  let written: Promise<void> = Promise.resolve();
  const ledger = new UsageLedger((entry) => {
    if (replaying) return;
    written = written
      .then(() => persist(dir, fileOf(entry.at.slice(0, 10)), entry))
      .catch((cause: unknown) => options.notice(`usage not saved · ${toError(cause).message}`));
  }, now);
  for (const entry of await savedEntries(fileOf(dayOf(now())))) ledger.record(entry);
  replaying = false;
  return {
    record: (turn) =>
      void ledger.record({
        node,
        provider: turn.provider,
        model: turn.model ?? turn.provider,
        servedModel: null,
        creature: turn.creature,
        session: turn.session,
        usage: normalizedUsageOf(turn.usage, turn.model),
      }),
    workedOn: async (creature, date) => {
      await written;
      const workspaces = dirname(dirname(dir));
      const entries = (await everyWorkspaceDay(workspaces, date)).filter(
        (entry) => entry.creature === creature && dayOf(entry.at) === date,
      );
      return {
        sessions: [...new Set(entries.flatMap((entry) => entry.session ?? []))],
        costNanos: spentNanos(entries),
      };
    },
    flush: () => written,
  };
}

async function everyWorkspaceDay(workspaces: string, date: string): Promise<UsageLedgerEntry[]> {
  const names = await readdir(workspaces).catch(() => [] as string[]);
  const days = await Promise.all(
    names.map((name) => savedEntries(join(workspaces, name, "usage", `${date}.jsonl`))),
  );
  return days.flat();
}

async function persist(dir: string, file: string, entry: UsageLedgerEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  const { flags: _flags, ...saved } = entry;
  await appendFile(file, `${JSON.stringify(saved)}\n`, "utf8");
}

async function savedEntries(file: string): Promise<UsageLedgerEntry[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as UsageLedgerEntry];
      } catch {
        return [];
      }
    });
}

function dayOf(at: Date | string): string {
  return (typeof at === "string" ? at : at.toISOString()).slice(0, 10);
}

async function meshConsoleFor(
  state: string,
  options: Pick<ServedNodeOptions, "userRoot" | "log" | "notice" | "tailnet">,
): Promise<HouseMeshConsole | undefined> {
  try {
    const config = readNodeConfig(nodePaths(options.userRoot).config);
    if (!config.mesh.enabled) return undefined;
    const sinks = meshEventsInto(options.log);
    return await houseMeshConsole({
      stateDir: state,
      userRoot: options.userRoot,
      headless: config.headless,
      port: config.mesh.port,
      tailnet: options.tailnet,
      onPairing: sinks.pairing,
      onGrant: sinks.grants,
      onLanes: sinks.lanes,
    });
  } catch (cause) {
    options.notice(`the mesh is not served: ${toError(cause).message}`);
    return undefined;
  }
}
