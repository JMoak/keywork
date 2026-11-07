import type { TailnetNode, TailnetStatus } from "../transport/status.ts";

export type ControlPlane = "tailscale" | "headscale";

export interface PolicyNode {
  stableId: string;
  name: string;
  login: string | null;
  tags: string[];
  addresses: string[];
  sharee: boolean;
}

export const steadTags = ["tag:stead-host", "tag:stead-workshop"] as const;

export function houseOf(status: TailnetStatus): PolicyNode | null {
  return status.self === null ? null : policyNodeOf(status, status.self);
}

export function parcelsOf(status: TailnetStatus, paired: readonly string[] = []): PolicyNode[] {
  const candidates = status.peers.filter((peer) => peer.inNetworkMap && !peer.sharee);
  const chosen =
    paired.length === 0 ? candidates : candidates.filter((peer) => paired.includes(peer.stableId));
  return chosen
    .map((peer) => policyNodeOf(status, peer))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function controlPlaneOf(status: TailnetStatus): ControlPlane {
  const suffix = status.tailnet?.magicDNSSuffix ?? "";
  return suffix === "ts.net" || suffix.endsWith(".ts.net") ? "tailscale" : "headscale";
}

export function isTagged(node: PolicyNode): boolean {
  return node.tags.length > 0;
}

export function userSelector(login: string, plane: ControlPlane): string {
  return plane === "headscale" && !login.includes("@") ? `${login}@` : login;
}

export function selectorOf(node: PolicyNode, plane: ControlPlane): string {
  const tag =
    node.tags.find((held) => (steadTags as readonly string[]).includes(held)) ?? node.tags[0];
  if (tag !== undefined) return tag;
  if (node.login !== null) return userSelector(node.login, plane);
  return node.addresses[0] ?? node.name;
}

function policyNodeOf(status: TailnetStatus, node: TailnetNode): PolicyNode {
  const tagged = node.tags.length > 0;
  return {
    stableId: node.stableId,
    name: node.hostName || node.dnsName.split(".")[0] || node.stableId,
    login: tagged ? null : status.users[node.userId]?.loginName || null,
    tags: node.tags,
    addresses: node.tailscaleIPs,
    sharee: node.sharee,
  };
}
