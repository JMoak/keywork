import { hostname } from "node:os";
import { z } from "zod";
import type { TailnetStatus } from "../transport/status.ts";
import { type Gpu, gpuSchema, nvidiaGpus } from "./gpu.ts";
import { meshProduct } from "./hello.ts";

export const manifestVersion = 1;
export const meshManifestPath = "/mesh/manifest";
export const nodeRoles = ["console", "host", "reachable"] as const;
export const nodeCapabilities = ["screen:view", "screen:control", "files", "exec"] as const;
export const workshopSubstrateKinds = ["sbx", "compose", "host"] as const;

export type NodeRole = (typeof nodeRoles)[number];
export type NodeCapability = (typeof nodeCapabilities)[number];
export type WorkshopSubstrateKind = (typeof workshopSubstrateKinds)[number];

export const manifestModelServerSchema = z.object({
  kind: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  auth: z.enum(["none", "key"]),
  installed: z.array(z.string()),
  loaded: z.array(z.string()),
});

export type ManifestModelServer = z.infer<typeof manifestModelServerSchema>;

export const nodeManifestSchema = z.object({
  manifest: z.literal(manifestVersion),
  product: z.object({ name: z.literal(meshProduct), version: z.string().min(1) }),
  machine: z.object({
    name: z.string(),
    os: z.string(),
    arch: z.string(),
    stableId: z.string().nullable(),
    addresses: z.array(z.string()),
  }),
  roles: z.array(z.enum(nodeRoles)),
  workshop: z.object({ substrates: z.array(z.enum(workshopSubstrateKinds)) }),
  gpus: z.array(gpuSchema),
  modelServers: z.array(manifestModelServerSchema),
  capabilities: z.array(z.enum(nodeCapabilities)),
  generatedAt: z.iso.datetime({ offset: true }),
});

export type NodeManifest = z.infer<typeof nodeManifestSchema>;

export interface ManifestSources {
  version: string;
  roles: readonly NodeRole[];
  capabilities: readonly NodeCapability[];
  status?: TailnetStatus | null | undefined;
  substrates?: (() => Promise<readonly WorkshopSubstrateKind[]>) | undefined;
  gpus?: (() => Promise<readonly Gpu[]>) | undefined;
  modelServers?: (() => Promise<readonly ManifestModelServer[]>) | undefined;
  machine?: (() => MachineFacts) | undefined;
  now?: (() => Date) | undefined;
}

export interface MachineFacts {
  name: string;
  os: string;
  arch: string;
}

export async function buildManifest(sources: ManifestSources): Promise<NodeManifest> {
  const facts = (sources.machine ?? localMachine)();
  const self = sources.status?.self ?? null;
  const [substrates, gpus, modelServers] = await Promise.all([
    (sources.substrates ?? nothingYet)(),
    (sources.gpus ?? nvidiaGpus)(),
    (sources.modelServers ?? nothingYet)(),
  ]);
  return nodeManifestSchema.parse({
    manifest: manifestVersion,
    product: { name: meshProduct, version: sources.version },
    machine: {
      name: self?.hostName || facts.name,
      os: facts.os,
      arch: facts.arch,
      stableId: self?.stableId ?? null,
      addresses: sources.status?.tailscaleIPs ?? [],
    },
    roles: unique(sources.roles),
    workshop: { substrates: unique(substrates) },
    gpus,
    modelServers,
    capabilities: unique(sources.capabilities),
    generatedAt: (sources.now ?? (() => new Date()))().toISOString(),
  });
}

export function parseManifest(value: unknown): NodeManifest | null {
  const parsed = nodeManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function localMachine(): MachineFacts {
  return { name: hostname(), os: process.platform, arch: process.arch };
}

function nothingYet<T>(): Promise<readonly T[]> {
  return Promise.resolve([]);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
