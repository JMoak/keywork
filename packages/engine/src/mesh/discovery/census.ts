import type { TailnetStatus } from "../transport/status.ts";
import type { Tailnet } from "../transport/tailnet.ts";
import { urlHost } from "../transport/tailnet-address.ts";
import {
  defaultHelloTimeoutMs,
  type HelloFetch,
  type HelloProbeOptions,
  type MeshHello,
  probeHello,
} from "./hello.ts";
import { meshManifestPath, type NodeManifest, type NodeRole, parseManifest } from "./manifest.ts";
import { type DiscoveredPeer, type MeshPeer, selfPeer, tailnetPeers } from "./peers.ts";

export interface CensusManifest {
  roles: NodeRole[];
}

export interface CensusPeer extends DiscoveredPeer {
  manifest: CensusManifest | null;
  endpoint?: string;
}

export interface MeshCensus {
  self: CensusPeer | null;
  peers: CensusPeer[];
}

export interface CensusPair {
  peerStableId: string;
  endpoint: string | null;
}

export interface CensusOptions extends HelloProbeOptions {
  tailnet: Pick<Tailnet, "status">;
  port: number;
  pairs(): readonly CensusPair[];
  selfManifest?: (() => Promise<NodeManifest | null>) | undefined;
}

export async function takeCensus(options: CensusOptions): Promise<MeshCensus> {
  const status = await options.tailnet.status();
  const pairs = options.pairs();
  const [self, peers] = await Promise.all([
    selfEntry(status, options),
    Promise.all(tailnetPeers(status).map((peer) => peerEntry(peer, pairs, options))),
  ]);
  return { self, peers };
}

export async function readPeerManifest(
  endpoint: string,
  options: HelloProbeOptions = {},
): Promise<NodeManifest | null> {
  const get: HelloFetch = options.fetch ?? fetch;
  try {
    const response = await get(new URL(meshManifestPath, endpoint).href, {
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultHelloTimeoutMs),
    });
    return response.ok ? parseManifest(await response.json()) : null;
  } catch {
    return null;
  }
}

interface AnsweringNode {
  hello: MeshHello;
  endpoint: string;
}

async function peerEntry(
  peer: MeshPeer,
  pairs: readonly CensusPair[],
  options: CensusOptions,
): Promise<CensusPeer> {
  const pair = pairs.find(({ peerStableId }) => peerStableId === peer.stableId);
  const answered = peer.candidate ? await answeringNode(peer.addresses, options) : undefined;
  const endpoint = pair?.endpoint ?? answered?.endpoint;
  const manifest =
    pair === undefined || answered === undefined || endpoint === undefined
      ? null
      : await readPeerManifest(endpoint, options);
  return censusPeer(peer, answered, manifest, endpoint);
}

async function selfEntry(
  status: TailnetStatus,
  options: CensusOptions,
): Promise<CensusPeer | null> {
  const self = selfPeer(status);
  if (self === null) return null;
  const [answered, manifest] = await Promise.all([
    answeringNode(self.addresses, options),
    options.selfManifest?.() ?? null,
  ]);
  return censusPeer(self, answered, manifest, answered?.endpoint);
}

async function answeringNode(
  addresses: readonly string[],
  options: CensusOptions,
): Promise<AnsweringNode | undefined> {
  for (const address of addresses) {
    const hello = await probeHello(address, options.port, options);
    if (hello !== null) return { hello, endpoint: `http://${urlHost(address)}:${options.port}` };
  }
  return undefined;
}

function censusPeer(
  peer: MeshPeer,
  answered: AnsweringNode | undefined,
  manifest: NodeManifest | null,
  endpoint: string | undefined,
): CensusPeer {
  return {
    ...peer,
    node: answered?.hello ?? null,
    manifest: manifest === null ? null : { roles: manifest.roles },
    ...(endpoint !== undefined && { endpoint }),
  };
}
