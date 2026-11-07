import type { Tailnet } from "../transport/tailnet.ts";
import { peerHost } from "../transport/tailnet-address.ts";
import { isSharedIn, isTaggedNode, type WhoIs } from "../transport/whois.ts";

export interface MeshCaller {
  address: string;
  node: CallerNode;
  human: CallerHuman | null;
  capMap: Readonly<Record<string, readonly unknown[]>>;
}

export interface CallerNode {
  stableId: string;
  name: string;
  os: string;
  tags: string[];
}

export interface CallerHuman {
  userId: string;
  loginName: string;
  displayName: string;
}

export type DenyReason = "not-a-peer" | "whois-failed" | "expired" | "shared-in" | "funnel";

export type Admission = Admitted | Denied;

export interface Admitted {
  admitted: true;
  caller: MeshCaller;
}

export interface Denied {
  admitted: false;
  address: string;
  reason: DenyReason;
  detail: string;
}

export async function identifyCaller(
  tailnet: Pick<Tailnet, "whois">,
  remoteAddress: string | undefined,
): Promise<Admission> {
  if (remoteAddress === undefined) return deny("", "not-a-peer", "the connection has no address");
  const address = peerHost(remoteAddress);
  try {
    return admit(address, await tailnet.whois(address));
  } catch (cause) {
    return deny(address, "whois-failed", cause instanceof Error ? cause.message : String(cause));
  }
}

export function admit(address: string, whois: WhoIs | null): Admission {
  if (whois === null) return deny(address, "not-a-peer", "no tailnet node holds this address");
  const node = whois.node.stableId;
  if (whois.node.expired) return deny(address, "expired", `node ${node} has an expired key`);
  if (isSharedIn(whois)) return deny(address, "shared-in", `node ${node} is shared in`);
  return { admitted: true, caller: callerOf(address, whois) };
}

export function deny(address: string, reason: DenyReason, detail: string): Denied {
  return { admitted: false, address, reason, detail };
}

function callerOf(address: string, whois: WhoIs): MeshCaller {
  return {
    address,
    node: {
      stableId: whois.node.stableId,
      name: whois.node.computedName || whois.node.name,
      os: whois.node.os,
      tags: whois.node.tags,
    },
    human: isTaggedNode(whois)
      ? null
      : {
          userId: whois.user.id,
          loginName: whois.user.loginName,
          displayName: whois.user.displayName,
        },
    capMap: whois.capMap,
  };
}
