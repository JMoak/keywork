import { type TailnetNode, type TailnetStatus, userOf } from "../transport/status.ts";
import type { Tailnet } from "../transport/tailnet.ts";
import { isTailnetAddress } from "../transport/tailnet-address.ts";
import { type HelloProbeOptions, type MeshHello, probeHello } from "./hello.ts";
import { classifyPath, type MeshPath } from "./path.ts";

export interface MeshPeer {
  stableId: string;
  machine: string;
  dnsName: string;
  os: string;
  addresses: string[];
  tags: string[];
  user: PeerUser | null;
  online: boolean;
  active: boolean;
  candidate: boolean;
  path: MeshPath;
}

export interface PeerUser {
  id: string;
  loginName: string;
  displayName: string;
}

export interface DiscoveredPeer extends MeshPeer {
  node: MeshHello | null;
}

export interface DiscoveryOptions extends HelloProbeOptions {
  tailnet: Pick<Tailnet, "status">;
  port: number;
}

export function tailnetPeers(status: TailnetStatus): MeshPeer[] {
  return status.peers.map((node) => peerOf(status, node));
}

export function selfPeer(status: TailnetStatus): MeshPeer | null {
  return status.self === null ? null : peerOf(status, status.self);
}

export async function discoverPeers(options: DiscoveryOptions): Promise<DiscoveredPeer[]> {
  const peers = tailnetPeers(await options.tailnet.status());
  return Promise.all(
    peers.map(async (peer) => ({
      ...peer,
      node: peer.candidate ? await helloFrom(peer, options) : null,
    })),
  );
}

function peerOf(status: TailnetStatus, node: TailnetNode): MeshPeer {
  const user = node.tags.length > 0 ? null : userOf(status, node);
  return {
    stableId: node.stableId,
    machine: node.hostName,
    dnsName: node.dnsName,
    os: node.os,
    addresses: node.tailscaleIPs.filter(isTailnetAddress),
    tags: node.tags,
    user,
    online: node.online,
    active: node.active,
    candidate: node.online && node.inNetworkMap && !node.sharee && !node.expired,
    path: classifyPath(node),
  };
}

async function helloFrom(peer: MeshPeer, options: DiscoveryOptions): Promise<MeshHello | null> {
  for (const address of peer.addresses) {
    const hello = await probeHello(address, options.port, options);
    if (hello !== null) return hello;
  }
  return null;
}
