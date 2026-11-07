import { hostname } from "node:os";
import { join } from "node:path";
import {
  type Arrival,
  advertiseLocalServers,
  arrivalOf,
  auditDeniedCallers,
  bashTool,
  type Clock,
  claimCodeName,
  createTailnet,
  creatureMcpMeshRoutes,
  creatureTickets,
  type DeliveredMessage,
  defaultTransport,
  editTool,
  fileAuditLog,
  fileGrantStore,
  filePairStore,
  type GrantEvent,
  grantService,
  hostSubstrate,
  issueClaimCode,
  type KeyStore,
  keepAwake,
  ledgerGate,
  liveClaimCode,
  loadDeviceKey,
  type MeshGate,
  type MessageOutcome,
  type MessageRefusalKind,
  meshAuditFile,
  meshClient,
  meshGrantsFile,
  meshKeysFile,
  meshPairingFile,
  messageRefusalStatus,
  type PairingEvent,
  type PairStore,
  pairingService,
  pairSecretOf,
  probeHttp,
  randomToken,
  readTool,
  retryRevocations,
  type SelfIdentity,
  sbxSubstrate,
  selfIdentityOf,
  spawnRunner,
  type Tailnet,
  type TailnetListener,
  tailnetPeers,
  takeCensus,
  toolScope,
  UnprotectedFileKeyStore,
  type WorkshopChange,
  Workshops,
  writeTool,
} from "@keywork/engine";
import {
  keyworkClient,
  type MeshConsole,
  type MeshPeersChange,
  meshTrustRoutes,
  pairedManifestReader,
  readServerTicket,
  registerMeshListener,
  type ServerTicket,
  watchLanes,
} from "@keywork/server";
import { jsonFileStore } from "@keywork/shared";
import { forwardCreatureMcp } from "../serve-mcp.ts";
import { AwakeWhileLive, workspaceActivity } from "./activity.ts";
import type { NodeConfig } from "./config.ts";
import type { CoreServices, MeshHandle } from "./core.ts";
import type { ClaimDesk, HeldClaimCode, StartingRoutines } from "./reconcile.ts";
import type { WorkspaceUnit } from "./units.ts";

export interface CoreComposition {
  stateDir: string;
  userRoot: string;
  config: NodeConfig;
  workspaces: readonly WorkspaceUnit[];
  served?: (() => readonly WorkspaceUnit[]) | undefined;
  version: string;
  clock: Clock;
  say: (line: string) => void;
  routines?: (() => Promise<StartingRoutines | undefined>) | undefined;
}

export const revocationRetryMs = 60_000;
export const manifestProbeTimeoutMs = 2_000;

export interface ScreenHouseFile {
  token: string;
  listeners: string[];
}

export function screenHouseFile(stateDir: string): string {
  return join(stateDir, "mesh", "screen-house.json");
}

export async function composeCoreServices(composition: CoreComposition): Promise<CoreServices> {
  const { stateDir, config } = composition;
  const stores = meshStores(stateDir);
  const claim = claimDeskOver(stores);
  const trust = config.mesh.enabled ? await nodeMeshTrust(composition, stores) : undefined;
  return {
    reconcile: {
      workshops: nodeWorkshops(stateDir),
      routines: await composition.routines?.(),
      claim,
      headless: config.headless,
    },
    mesh: trust === undefined ? undefined : () => openMeshListener(composition, trust),
    activity: new AwakeWhileLive({
      awake: keepAwake(),
      clock: composition.clock,
      sources: () =>
        servedNow(composition).map((unit) =>
          workspaceActivity(unit.spec.name, () => readServerTicket(unit.ticket), keyworkClient),
        ),
      onChange: (live, busy) =>
        composition.say(
          live
            ? `keep-awake: holding while ${busy.join(", ")} has a live run`
            : "keep-awake: released, no run is live",
        ),
    }),
    close: async () => trust?.close(),
  };
}

export function fileClaimDesk(
  stateDir: string,
): ClaimDesk & { claimStateNow(): "unclaimed" | "claimed" } {
  return claimDeskOver(meshStores(stateDir));
}

export function nodeWorkshops(
  stateDir: string,
  announce?: (change: WorkshopChange) => void,
): Workshops {
  return new Workshops({
    stateDir,
    substrates: {
      host: hostSubstrate({ stateDir }),
      sbx: sbxSubstrate({ run: spawnRunner("sbx"), stateDir }),
    },
    ...(announce !== undefined && { announce }),
  });
}

export interface MeshConsoleOptions {
  stateDir: string;
  userRoot: string;
  headless: boolean;
  port: number;
  onPairing: (event: PairingEvent) => void;
  onGrant: (event: GrantEvent) => void;
  onLanes?: ((change: MeshPeersChange) => void) | undefined;
}

export interface HouseMeshConsole extends ConsoleTrust {
  self(): Promise<SelfIdentity>;
  machine(): string;
}

interface ConsoleTrust extends MeshConsole {
  warning: string | null;
}

export async function houseMeshConsole(options: MeshConsoleOptions): Promise<HouseMeshConsole> {
  const tailnet = createTailnet(defaultTransport());
  const self = selfOn(tailnet);
  const trust = await meshConsoleOver(meshStores(options.stateDir), self, options);
  if (options.onLanes !== undefined) {
    watchLanes({
      read: async () =>
        tailnetPeers(await tailnet.status()).map(({ stableId, path, active }) => ({
          stableId,
          path,
          active,
        })),
      changed: options.onLanes,
    });
  }
  return {
    ...trust,
    self,
    machine: hostname,
    census: () => takeCensus({ tailnet, port: options.port, pairs: () => trust.pairing.pairs() }),
  };
}

interface MeshStores {
  keys: KeyStore;
  pairs: PairStore;
}

interface NodeMeshTrust extends MeshConsole {
  tailnet: Tailnet;
  keys: KeyStore;
  close(): void;
}

function meshStores(stateDir: string): MeshStores {
  return {
    keys: new UnprotectedFileKeyStore(meshKeysFile(stateDir)),
    pairs: filePairStore(meshPairingFile(stateDir)),
  };
}

function claimDeskOver({
  keys,
  pairs,
}: MeshStores): ClaimDesk & { claimStateNow(): "unclaimed" | "claimed" } {
  const claimStateNow = () => (pairs.read().owner === null ? "unclaimed" : "claimed");
  return {
    claimStateNow,
    claimState: async () => claimStateNow(),
    live: () => liveHeldCode(keys),
    issue: async () => {
      const issued = await issueClaimCode(keys);
      return { code: issued.code, expiresAt: issued.expiresAt };
    },
  };
}

async function nodeMeshTrust(
  composition: CoreComposition,
  stores: MeshStores,
): Promise<NodeMeshTrust> {
  const { stateDir, userRoot, config, say } = composition;
  const tailnet = createTailnet(defaultTransport());
  const onEvent = (event: { type: string }) => say(`mesh: ${JSON.stringify(event)}`);
  const trust = await meshConsoleOver(stores, selfOn(tailnet), {
    stateDir,
    userRoot,
    headless: config.headless,
    port: config.mesh.port,
    onPairing: onEvent,
    onGrant: onEvent,
  });
  if (trust.warning !== null) say(`mesh: ${trust.warning}`);
  return {
    ...trust,
    tailnet,
    keys: stores.keys,
    close: retryRevocations(trust.grants, revocationRetryMs),
  };
}

async function meshConsoleOver(
  stores: MeshStores,
  self: () => Promise<SelfIdentity>,
  options: MeshConsoleOptions,
): Promise<ConsoleTrust> {
  const { stateDir } = options;
  const deviceKey = await loadDeviceKey(stores.keys);
  const audit = fileAuditLog(meshAuditFile(stateDir));
  const pairing = pairingService({
    deviceKey,
    keys: stores.keys,
    store: stores.pairs,
    audit,
    self,
    headless: options.headless,
    onEvent: options.onPairing,
  });
  const client = meshClient({ deviceKey, keys: stores.keys, store: stores.pairs, self });
  const grants = grantService({
    deviceKey,
    pairing,
    client,
    store: fileGrantStore(meshGrantsFile(stateDir)),
    audit,
    self,
    gate: parcelGate(options.userRoot),
    onEvent: options.onGrant,
  });
  return { pairing, grants, audit, client, warning: stores.keys.warning };
}

function selfOn(tailnet: Tailnet): () => Promise<SelfIdentity> {
  return async () => selfIdentityOf(await tailnet.status());
}

function parcelGate(root: string): MeshGate {
  const scope = toolScope(root);
  return ledgerGate({
    root,
    tools: () => [bashTool(root), readTool(scope), writeTool(scope), editTool(scope)],
  });
}

async function openMeshListener(
  composition: CoreComposition,
  trust: NodeMeshTrust,
): Promise<MeshHandle> {
  const { say } = composition;
  const self = rememberedStableId(trust.tailnet);
  await self.refresh();
  const auditDenied = auditDeniedCallers(trust.audit, self.current, (error) =>
    say(`mesh: the audit log refused a row: ${messageOf(error)}`),
  );
  const house = screenHousePublisher(screenHouseFile(composition.stateDir), randomToken(32));
  const listener = await registerMeshListener({
    version: composition.version,
    port: composition.config.mesh.port,
    tailnet: trust.tailnet,
    pairing: () => trust.pairing.claimState(),
    mayReadManifest: pairedManifestReader(trust.pairing),
    routes: [
      ...meshTrustRoutes({
        ...trust,
        screen: {
          house: house.token,
          self: self.current,
          machine: hostname,
          pairSecret: (pairId) => pairSecretOf(trust.keys, pairId),
        },
        messages: {
          receive: (request) => forwardArrival(servedNow(composition), arrivalOf(request)),
        },
      }),
      ...creatureMcpMeshRoutes({
        tickets: creatureTickets({
          house: house.token,
          self: self.current,
          pairs: () => trust.pairing.pairs(),
          pairSecret: (pairId) => pairSecretOf(trust.keys, pairId),
        }),
        forward: (slug, arrival) => forwardCreatureMcp(servedNow(composition), slug, arrival),
        audit: trust.audit,
        self: self.current,
      }),
    ],
    inventory: {
      modelServers: () =>
        advertiseLocalServers({ http: probeHttp({ timeoutMs: manifestProbeTimeoutMs }) }),
    },
    onEvent: (event) => {
      say(`mesh: ${JSON.stringify(event)}`);
      if (event.type === "mesh.listener.bound") void self.refresh();
      if (event.type === "mesh.listener.bound" || event.type === "mesh.listener.unbound")
        house.publish();
      auditDenied(event);
    },
  });
  house.listening(listener);
  return listener;
}

export async function forwardArrival(
  workspaces: readonly Pick<WorkspaceUnit, "ticket">[],
  arrival: Arrival,
  post: typeof fetch = fetch,
): Promise<MessageOutcome> {
  let outcome: MessageOutcome = {
    refused: "missing",
    error: "no workspace of this node keeps the creature the message names",
  };
  for (const unit of workspaces) {
    const ticket = readServerTicket(unit.ticket);
    if (ticket === undefined) continue;
    outcome = await takenBy(ticket, arrival, post);
    if (!("refused" in outcome) || outcome.refused !== "missing") return outcome;
  }
  return outcome;
}

async function takenBy(
  ticket: ServerTicket,
  arrival: Arrival,
  post: typeof fetch,
): Promise<MessageOutcome> {
  try {
    const response = await post(`${ticket.url.replace(/\/+$/, "")}/mesh/messages/arrivals`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(arrival),
    });
    const body = (await response.json().catch(() => ({}))) as {
      delivered?: DeliveredMessage;
      error?: string;
    };
    if (response.status === 201 && body.delivered !== undefined) {
      return { delivered: body.delivered };
    }
    return {
      refused: refusalKindOf(response.status),
      error: body.error ?? `the workspace answered ${response.status}`,
    };
  } catch (error) {
    return { refused: "unreachable", error: `the workspace did not answer: ${messageOf(error)}` };
  }
}

function refusalKindOf(status: number): MessageRefusalKind {
  const known = (Object.keys(messageRefusalStatus) as MessageRefusalKind[]).find(
    (kind) => messageRefusalStatus[kind] === status,
  );
  return known ?? "unreachable";
}

interface ScreenHousePublisher {
  readonly token: string;
  listening(listener: TailnetListener): void;
  publish(): void;
}

function screenHousePublisher(file: string, token: string): ScreenHousePublisher {
  const store = jsonFileStore<ScreenHouseFile>({
    file,
    mode: "lenient",
    private: true,
    validate: (data) => data as ScreenHouseFile,
  });
  let listener: TailnetListener | undefined;
  const publish = (): void =>
    store.write({ token, listeners: (listener?.bound() ?? []).map(listenerUrl) });
  return {
    token,
    listening: (bound) => {
      listener = bound;
      publish();
    },
    publish,
  };
}

function listenerUrl({ address, port }: { address: string; port: number }): string {
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

function rememberedStableId(tailnet: Tailnet): { current(): string; refresh(): Promise<void> } {
  let stableId = "unknown";
  return {
    current: () => stableId,
    refresh: async () => {
      try {
        stableId = selfIdentityOf(await tailnet.status()).stableId;
      } catch {}
    },
  };
}

function servedNow(composition: CoreComposition): readonly WorkspaceUnit[] {
  return composition.served?.() ?? composition.workspaces;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function liveHeldCode(keys: KeyStore): Promise<HeldClaimCode | null> {
  const code = await liveClaimCode(keys);
  if (code === null) return null;
  const saved = JSON.parse((await keys.read(claimCodeName)) ?? "{}") as { expiresAt?: string };
  return { code, expiresAt: saved.expiresAt ?? "unknown" };
}
