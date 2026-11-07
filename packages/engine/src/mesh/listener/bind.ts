import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { isRunning, type TailnetStatus } from "../transport/status.ts";
import {
  isIPAddress,
  isLoopbackAddress,
  isTailnetAddress,
  isWildcardAddress,
  peerHost,
} from "../transport/tailnet-address.ts";

export type IdleReason = "not-running" | "userspace-networking" | "no-local-tailnet-address";

export interface BindPlan {
  addresses: string[];
  idle: IdleReason | null;
}

export class MeshBindRefusedError extends Error {
  override readonly name = "MeshBindRefusedError";
}

export function planBinds(status: TailnetStatus, localAddresses: readonly string[]): BindPlan {
  if (!isRunning(status)) return { addresses: [], idle: "not-running" };
  if (!status.tun) return { addresses: [], idle: "userspace-networking" };
  const local = new Set(localAddresses.map(peerHost));
  const addresses = status.tailscaleIPs.filter(
    (address) => local.has(address) && refusalOf(address) === null,
  );
  return addresses.length === 0
    ? { addresses, idle: "no-local-tailnet-address" }
    : { addresses, idle: null };
}

export function assertTailnetBindable(address: string): void {
  const refusal = refusalOf(address);
  if (refusal !== null) throw new MeshBindRefusedError(`refusing to bind ${address}: ${refusal}`);
}

export async function listenOnTailnet(
  server: Server,
  address: string,
  port: number,
): Promise<number> {
  assertTailnetBindable(address);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: address, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export function localInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address);
}

function refusalOf(address: string): string | null {
  if (!isIPAddress(address)) return "not an IP address";
  if (isWildcardAddress(address)) return "a wildcard address listens on every interface";
  if (isLoopbackAddress(address)) return "loopback belongs to the console listener";
  if (!isTailnetAddress(address)) return "not a tailnet address";
  return null;
}
