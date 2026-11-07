import type { ManifestModelServer, NodeManifest } from "../../mesh/discovery/manifest.ts";
import { urlHost } from "../../mesh/transport/tailnet-address.ts";
import { EndpointUnreachableError, joinUrl, type ProbeHttp } from "../adapters/http.ts";
import { serverAdapters } from "../adapters/registry.ts";
import type { ServerProbe } from "../adapters/types.ts";
import { identifyServer } from "../capabilities/fingerprint.ts";
import { isServerKind } from "../capabilities/record.ts";
import type { ServerKind } from "../capabilities/types.ts";

export interface KnownPort {
  port: number;
  kinds: readonly ServerKind[];
}

export const knownServerPorts: readonly KnownPort[] = [
  { port: 11434, kinds: ["ollama"] },
  { port: 9931, kinds: ["llama-server"] },
  { port: 8080, kinds: ["llama-swap", "mlx-lm", "llama-server"] },
  { port: 1234, kinds: ["lm-studio"] },
  { port: 8000, kinds: ["vllm"] },
  { port: 30000, kinds: ["sglang"] },
];

export type DiscoverySource = "advertised" | "probed";

export interface DiscoveredServer {
  node: string;
  root: string;
  port: number;
  kind: ServerKind;
  source: DiscoverySource;
  auth: "none" | "key";
  advertised: { installed: readonly string[]; loaded: readonly string[] } | null;
}

export interface ScanOptions {
  http: ProbeHttp;
  ports?: readonly KnownPort[] | undefined;
  now?: (() => Date) | undefined;
}

export function serversFromManifest(
  node: string,
  address: string,
  manifest: NodeManifest,
): DiscoveredServer[] {
  return manifest.modelServers.map((server) => ({
    node,
    root: rootOf(address, server.port),
    port: server.port,
    kind: isServerKind(server.kind) ? server.kind : "openai-compatible",
    source: "advertised",
    auth: server.auth,
    advertised: { installed: server.installed, loaded: server.loaded },
  }));
}

export async function scanHost(
  node: string,
  address: string,
  options: ScanOptions,
): Promise<DiscoveredServer[]> {
  const found = await Promise.all(
    (options.ports ?? knownServerPorts).map((known) => scanPort(node, address, known, options)),
  );
  return found.flatMap((server) => (server === undefined ? [] : [server]));
}

export function mergeDiscovered(
  advertised: readonly DiscoveredServer[],
  probed: readonly DiscoveredServer[],
): DiscoveredServer[] {
  const roots = new Set(advertised.map((server) => server.root));
  return [...advertised, ...probed.filter((server) => !roots.has(server.root))];
}

export async function advertiseLocalServers(options: ScanOptions): Promise<ManifestModelServer[]> {
  const servers = await scanHost("self", "127.0.0.1", options);
  const now = options.now ?? (() => new Date());
  const adverts = await Promise.all(
    servers.map(async (server) => {
      const adapter = serverAdapters.find((candidate) => candidate.deltas.kind === server.kind);
      const probe: ServerProbe = { http: options.http, root: server.root, now };
      const inventory = adapter === undefined ? undefined : await adapter.inventory(probe);
      return {
        kind: server.kind,
        port: server.port,
        auth: server.auth,
        installed: inventory?.installed.map((model) => model.id) ?? [],
        loaded: inventory?.loaded.map((model) => model.id) ?? [],
      };
    }),
  );
  return adverts;
}

export function rootOf(address: string, port: number): string {
  return `http://${urlHost(address)}:${port}`;
}

async function scanPort(
  node: string,
  address: string,
  known: KnownPort,
  options: ScanOptions,
): Promise<DiscoveredServer | undefined> {
  const root = rootOf(address, known.port);
  const probe: ServerProbe = { http: options.http, root, now: options.now ?? (() => new Date()) };
  try {
    const identified = await identifyServer(probe, { preferred: known.kinds });
    const found = (kind: ServerKind, auth: "none" | "key"): DiscoveredServer => ({
      node,
      root,
      port: known.port,
      kind,
      source: "probed",
      auth,
      advertised: null,
    });
    if (identified !== undefined) return found(identified.fingerprint.kind, "none");
    const listing = await options.http.get(joinUrl(root, "/v1/models"));
    if (listing.status === 401 || listing.status === 403) return found("openai-compatible", "key");
    return listing.ok ? found("openai-compatible", "none") : undefined;
  } catch (cause) {
    if (cause instanceof EndpointUnreachableError) return undefined;
    throw cause;
  }
}
