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
import {
  type ManifestKeyProtection,
  meshManifestPath,
  type NodeManifest,
  type NodeRole,
  parseManifest,
} from "./manifest.ts";
import { type DiscoveredPeer, type MeshPeer, selfPeer, tailnetPeers } from "./peers.ts";

export interface CensusManifest {
  roles: NodeRole[];
  keys?: ManifestKeyProtection;
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
  book?: ProbeBook | undefined;
}

export interface ProbeBook {
  ask<Answer>(key: string, probe: () => Promise<Answer | null>): Promise<Answer | null>;
}

export const answeredKeptMs = 60_000;

export const refusedWaitMs = 5 * 60_000;

export const refusedWaitAtMostMs = 60 * 60_000;

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

export function probeBook(now: () => number = () => Date.now()): ProbeBook {
  const kept = new Map<string, KeptProbe>();
  return {
    ask: <Answer>(key: string, probe: () => Promise<Answer | null>) => {
      const known = kept.get(key);
      if (known?.asking !== undefined) return known.asking as Promise<Answer | null>;
      if (known !== undefined && now() < known.askAgainAt) {
        return Promise.resolve(known.answer as Answer | null);
      }
      const asking = probe()
        .catch(() => null)
        .then((answer) => {
          const refusals = answer === null ? (known?.refusals ?? 0) + 1 : 0;
          kept.set(key, { answer, refusals, askAgainAt: now() + waitAfter(refusals) });
          return answer;
        });
      kept.set(key, { ...(known ?? neverAsked), asking });
      return asking;
    },
  };
}

interface KeptProbe {
  answer: unknown;
  refusals: number;
  askAgainAt: number;
  asking?: Promise<unknown>;
}

const neverAsked: KeptProbe = { answer: null, refusals: 0, askAgainAt: 0 };

function waitAfter(refusals: number): number {
  if (refusals === 0) return answeredKeptMs;
  return Math.min(refusedWaitMs * 2 ** (refusals - 1), refusedWaitAtMostMs);
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
      : await asked(options, `manifest ${endpoint}`, () => readPeerManifest(endpoint, options));
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
    const hello = await asked(options, `hello ${address}`, () =>
      probeHello(address, options.port, options),
    );
    if (hello !== null) return { hello, endpoint: `http://${urlHost(address)}:${options.port}` };
  }
  return undefined;
}

function asked<Answer>(
  options: CensusOptions,
  key: string,
  probe: () => Promise<Answer | null>,
): Promise<Answer | null> {
  return options.book === undefined ? probe() : options.book.ask(key, probe);
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
    manifest: manifest === null ? null : censusManifestOf(manifest),
    ...(endpoint !== undefined && { endpoint }),
  };
}

function censusManifestOf({ roles, keys }: NodeManifest): CensusManifest {
  return { roles, ...(keys !== undefined && { keys }) };
}
