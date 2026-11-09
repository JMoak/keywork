import { appendFile, mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type BenchOpener,
  benchBook,
  CapabilityCache,
  type CostSource,
  carriesUsage,
  costNanosOf,
  type Decider,
  fileLicenseBook,
  type InferenceBinding,
  localBenchOpener,
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
  stewardedInventory,
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

export interface ServedNodeOptions {
  cwd: string;
  workspaceSlug?: string | undefined;
  userRoot: string;
  log: EventLog;
  notice(text: string): void;
  modelProbe?: ProbeHttp | undefined;
  inventory?: NodeInventorySeams | undefined;
  now?: (() => Date) | undefined;
}

export interface NodeInventorySeams {
  capabilities: CapabilityCache;
  registrations(): readonly ProviderRegistration[];
  provider(binding: InferenceBinding): Provider;
  decider(binding: InferenceBinding): Decider;
  inherit?: (() => ModelReference | undefined) | undefined;
  answers?: ProviderAnswers | undefined;
}

export type NodePolicy = Required<Pick<PolicyEnvironment, "capabilityOf" | "refusalOf">>;

export interface ServedNode {
  state: string;
  routines: RoutinesState;
  workshops: Workshops;
  models: ModelsPort;
  policy: NodePolicy;
  usage: TurnUsage;
  mesh: HouseMeshConsole | undefined;
}

export interface TurnUsage {
  record(turn: MeteredTurn): void;
  spentOn(creature: string, date: string): number | null;
  flush(): Promise<void>;
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
  const licenses = fileLicenseBook(modelAcknowledgementsFile(state));
  const slate = await readSlate().catch(() => undefined);
  const inventory = new ModelInventory({
    nodes: async () => [{ node: machine, address: localAddress, scan: true }],
    cache: capabilities,
    ...(options.modelProbe !== undefined && { http: options.modelProbe }),
    announce: { node: machine, changed: (change) => log.record("", "models.changed", change) },
  });
  const policy: NodePolicy = {
    capabilityOf: probedCapabilities(capabilities),
    refusalOf: unacknowledgedLicense(licenses, slate),
  };
  return {
    state,
    routines: routinesStateOf(workspaceState),
    workshops: nodeWorkshops(state, (change) => log.record("", "workshop.changed", change)),
    models: stewardedInventory(inventory, {
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
    policy,
    usage: await usageLedgerAt(join(workspaceState, "usage"), machine, options),
    mesh: await meshConsoleFor(state, options),
  };
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
    spentOn: (creature, date) =>
      spentNanos(ledger.entries({ creature }).filter((entry) => dayOf(entry.at) === date)),
    flush: () => written,
  };
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
  options: Pick<ServedNodeOptions, "userRoot" | "log" | "notice">,
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
      onPairing: sinks.pairing,
      onGrant: sinks.grants,
      onLanes: sinks.lanes,
    });
  } catch (cause) {
    options.notice(`the mesh is not served: ${toError(cause).message}`);
    return undefined;
  }
}
