import type { NodeManifest } from "../../mesh/discovery/manifest.ts";
import { type ProbeHttp, probeHttp, serverRootOf } from "../adapters/http.ts";
import { adapterFor } from "../adapters/registry.ts";
import type { LoadedModel, ServerInventory, ServerProbe } from "../adapters/types.ts";
import type { CapabilityCache } from "../capabilities/cache.ts";
import { eligibilityOrder, eligibleClasses, missingFor } from "../capabilities/eligibility.ts";
import { probeServer, type ServerProbeResult } from "../capabilities/probe.ts";
import type { CapabilityRecord, ServerFingerprint, ServerKind } from "../capabilities/types.ts";
import { BreakerBoard, effectiveHealth } from "../health/breaker.ts";
import { type HealthReading, healthReading } from "../health/types.ts";
import type { CostSource } from "../ledger/types.ts";
import type { ModelClass } from "../policy/index.ts";
import {
  type DiscoveredServer,
  type DiscoverySource,
  mergeDiscovered,
  scanHost,
  serversFromManifest,
} from "./servers.ts";

export interface NodeTarget {
  node: string;
  address: string;
  manifest?: NodeManifest | null | undefined;
  scan?: boolean | undefined;
}

export type LicenseAcknowledgement = "required" | "not-required" | "unknown";

export interface ModelRow {
  id: string;
  installed: boolean;
  loaded: boolean;
  contextAllocated: number | null;
  health: HealthReading;
  classes: ModelClass[];
  ineligible: { class: ModelClass; missing: string[] }[];
  license: string | null;
  licenseAcknowledgement: LicenseAcknowledgement;
  cost: { source: CostSource; usdPerMillionInput: number; usdPerMillionOutput: number };
}

export interface ServerRow {
  kind: ServerKind;
  root: string;
  port: number;
  source: DiscoverySource;
  auth: "none" | "key";
  fingerprint: string | null;
  version: string | null;
  health: HealthReading;
  models: ModelRow[];
}

export interface NodeModels {
  node: string;
  servers: ServerRow[];
}

export interface ModelsReport {
  generatedAt: string;
  nodes: NodeModels[];
}

export interface ModelsFilter {
  node?: string | undefined;
}

export interface ModelProbeRequest {
  endpoint: string;
  model?: string | undefined;
  behaviour?: boolean | undefined;
  refresh?: boolean | undefined;
}

export interface ModelProbeReport {
  root: string;
  status: ServerProbeResult["status"];
  fingerprint: ServerFingerprint | null;
  health: HealthReading | null;
  records: readonly CapabilityRecord[];
  listedOnly: readonly string[];
  detail: string | null;
}

export type ModelsChangeReason = "probe" | "manifest" | "health";

export interface ModelsChange {
  node: string;
  reason: ModelsChangeReason;
}

export interface ModelsAnnouncement {
  node: string;
  changed(change: ModelsChange): void;
}

export interface ModelInventoryOptions {
  nodes: () => Promise<readonly NodeTarget[]>;
  cache: CapabilityCache;
  http?: ProbeHttp | undefined;
  breakers?: BreakerBoard | undefined;
  now?: (() => Date) | undefined;
  announce?: ModelsAnnouncement | undefined;
}

export class ModelInventory {
  private readonly http: ProbeHttp;
  private readonly breakers: BreakerBoard;
  private readonly now: () => Date;
  private readonly seen = new Map<string, NodeSighting>();

  constructor(private readonly options: ModelInventoryOptions) {
    this.http = options.http ?? probeHttp();
    this.breakers = options.breakers ?? new BreakerBoard();
    this.now = options.now ?? (() => new Date());
  }

  async list(filter: ModelsFilter = {}): Promise<ModelsReport> {
    const targets = (await this.options.nodes()).filter(
      (target) => filter.node === undefined || target.node === filter.node,
    );
    const nodes = await Promise.all(targets.map((target) => this.nodeModels(target)));
    for (const node of nodes) this.notice(node);
    return { generatedAt: this.now().toISOString(), nodes };
  }

  async probe(request: ModelProbeRequest): Promise<ModelProbeReport> {
    const root = serverRootOf(request.endpoint);
    const result = await probeServer(root, {
      http: this.http,
      cache: this.options.cache,
      now: this.now,
      models: request.model === undefined ? undefined : [request.model],
      behaviour: request.behaviour,
      refresh: request.refresh,
    });
    const recognized = result.status === "recognized" ? result : undefined;
    const adapter = recognized === undefined ? undefined : adapterFor(recognized.fingerprint.kind);
    const announce = this.options.announce;
    announce?.changed({ node: announce.node, reason: "probe" });
    return {
      root,
      status: result.status,
      fingerprint: recognized?.fingerprint ?? null,
      health:
        adapter === undefined ? null : await adapter.health(this.probeOf(root), request.model),
      records: recognized?.records ?? [],
      listedOnly: result.status === "unrecognized" ? result.listedOnly : [],
      detail: result.status === "unreachable" ? result.detail : null,
    };
  }

  private notice(node: NodeModels): void {
    const sighting = sightingOf(node);
    const previous = this.seen.get(node.node);
    this.seen.set(node.node, sighting);
    const reason = previous === undefined ? undefined : changeBetween(previous, sighting);
    if (reason !== undefined) this.options.announce?.changed({ node: node.node, reason });
  }

  private async nodeModels(target: NodeTarget): Promise<NodeModels> {
    const advertised =
      target.manifest == null
        ? []
        : serversFromManifest(target.node, target.address, target.manifest);
    const probed =
      target.scan === true
        ? await scanHost(target.node, target.address, { http: this.http, now: this.now })
        : [];
    const servers = mergeDiscovered(advertised, probed);
    return {
      node: target.node,
      servers: await Promise.all(servers.map((server) => this.serverRow(server))),
    };
  }

  private async serverRow(server: DiscoveredServer): Promise<ServerRow> {
    const result = await probeServer(server.root, {
      http: this.http,
      cache: this.options.cache,
      now: this.now,
      preferred: [server.kind],
    });
    const row = (
      health: HealthReading,
      fingerprint: ServerFingerprint | null,
      models: ModelRow[],
    ): ServerRow => ({
      kind: fingerprint?.kind ?? server.kind,
      root: server.root,
      port: server.port,
      source: server.source,
      auth: server.auth,
      fingerprint: fingerprint?.id ?? null,
      version: fingerprint?.version ?? null,
      health,
      models,
    });
    const checkedAt = this.now().toISOString();
    if (result.status === "unreachable") {
      const health = healthReading("down", result.detail, checkedAt);
      return row(health, null, this.advertisedRows(server, health));
    }
    if (result.status === "unrecognized") {
      const health = healthReading(
        "up",
        "answers /v1/models but no native route; capabilities unknown",
        checkedAt,
      );
      const listed = { installed: result.listedOnly, loaded: [] };
      return row(health, null, this.advertisedRows({ ...server, advertised: listed }, health));
    }
    const adapter = adapterFor(result.fingerprint.kind);
    if (adapter === undefined || result.inventory === null) {
      const health = healthReading(
        "up",
        `recognized by ${result.fingerprint.routes.join(", ")}; no adapter yet`,
        checkedAt,
      );
      return row(health, result.fingerprint, this.advertisedRows(server, health));
    }
    const health = await adapter.health(this.probeOf(server.root));
    return row(
      health,
      result.fingerprint,
      this.modelRows(server.node, result.inventory, result.records, health),
    );
  }

  private modelRows(
    node: string,
    inventory: ServerInventory,
    records: readonly CapabilityRecord[],
    serverHealth: HealthReading,
  ): ModelRow[] {
    const ids = [
      ...new Set([
        ...inventory.installed.map((model) => model.id),
        ...inventory.loaded.map((model) => model.id),
      ]),
    ];
    return ids.map((id) => {
      const record = records.find((candidate) => candidate.model === id);
      const loaded = inventory.loaded.find((model) => model.id === id);
      const health = effectiveHealth(
        modelHealth(serverHealth, loaded),
        this.breakers.for(node, id),
      );
      return modelRow(id, {
        installed: inventory.installed.some((model) => model.id === id),
        loaded,
        record,
        health,
      });
    });
  }

  private advertisedRows(server: DiscoveredServer, health: HealthReading): ModelRow[] {
    const advertised = server.advertised;
    if (advertised === null) return [];
    const ids = [...new Set([...advertised.installed, ...advertised.loaded])];
    return ids.map((id) =>
      modelRow(id, {
        installed: advertised.installed.includes(id),
        loaded: advertised.loaded.includes(id)
          ? { id, state: "loaded", contextAllocated: null, memoryBytes: null, expiresAt: null }
          : undefined,
        record: undefined,
        health,
      }),
    );
  }

  private probeOf(root: string): ServerProbe {
    return { http: this.http, root, now: this.now };
  }
}

export function licenseAcknowledgementFor(license: string | null): LicenseAcknowledgement {
  if (license === null) return "unknown";
  const normalized = license.trim().toLowerCase();
  return permissiveLicenses.some((permissive) => normalized.startsWith(permissive))
    ? "not-required"
    : "required";
}

const permissiveLicenses = [
  "apache-2.0",
  "apache license",
  "mit",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "unlicense",
  "cc0-1.0",
];

interface NodeSighting {
  advertised: string;
  probed: string;
  health: string;
}

function sightingOf(node: NodeModels): NodeSighting {
  const rootsFrom = (source: DiscoverySource) =>
    sortedLines(node.servers.filter((server) => server.source === source).map(({ root }) => root));
  const states = node.servers.flatMap((server) => [
    `${server.root} ${server.health.state}`,
    ...server.models.map((model) => `${server.root} ${model.id} ${model.health.state}`),
  ]);
  return {
    advertised: rootsFrom("advertised"),
    probed: rootsFrom("probed"),
    health: sortedLines(states),
  };
}

function changeBetween(
  previous: NodeSighting,
  current: NodeSighting,
): ModelsChangeReason | undefined {
  if (previous.advertised !== current.advertised) return "manifest";
  if (previous.probed !== current.probed) return "probe";
  return previous.health === current.health ? undefined : "health";
}

function sortedLines(lines: readonly string[]): string {
  return [...lines].sort().join("\n");
}

interface RowFacts {
  installed: boolean;
  loaded: LoadedModel | undefined;
  record: CapabilityRecord | undefined;
  health: HealthReading;
}

function modelRow(id: string, facts: RowFacts): ModelRow {
  const { record } = facts;
  const classes = record === undefined ? [] : eligibleClasses(record);
  const license = record?.license.known === true ? record.license.value : null;
  return {
    id,
    installed: facts.installed,
    loaded: facts.loaded !== undefined && facts.loaded.state === "loaded",
    contextAllocated: facts.loaded?.contextAllocated ?? allocatedFrom(record),
    health: facts.health,
    classes,
    ineligible: eligibilityOrder
      .filter((modelClass) => !classes.includes(modelClass))
      .map((modelClass) => ({
        class: modelClass,
        missing:
          record === undefined
            ? ["capability record"]
            : missingFor(record, modelClass).map((missing) => missing.capability),
      })),
    license,
    licenseAcknowledgement: licenseAcknowledgementFor(license),
    cost: { source: "local_estimate", usdPerMillionInput: 0, usdPerMillionOutput: 0 },
  };
}

function allocatedFrom(record: CapabilityRecord | undefined): number | null {
  return record?.contextAllocated.known === true ? record.contextAllocated.value : null;
}

function modelHealth(server: HealthReading, loaded: LoadedModel | undefined): HealthReading {
  if (server.state === "down") return server;
  if (loaded?.state === "loading") {
    return healthReading("loading", `${loaded.id} is loading`, server.checkedAt, false);
  }
  return { ...server, resident: loaded?.state === "loaded" };
}
