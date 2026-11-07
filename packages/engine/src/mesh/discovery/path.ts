import type { PingResult } from "../transport/ping.ts";
import type { TailnetNode } from "../transport/status.ts";
import type { Tailnet } from "../transport/tailnet.ts";
import type { PingOptions } from "../transport/transport.ts";

export type MeshPath =
  | { kind: "direct"; endpoint: string }
  | { kind: "peer-relay"; relay: string }
  | { kind: "derp"; region: string }
  | { kind: "offline" }
  | { kind: "unknown" };

export type PathKind = MeshPath["kind"];

export type PathProbe =
  | { reached: true; path: MeshPath; latencyMs: number }
  | { reached: false; error: string };

export function classifyPath(
  node: Pick<TailnetNode, "online" | "curAddr" | "relay" | "peerRelay">,
): MeshPath {
  if (!node.online) return { kind: "offline" };
  return routeOf(node.curAddr, node.peerRelay, node.relay);
}

export function classifyPing(result: PingResult): PathProbe {
  if (!result.ok) return { reached: false, error: result.error };
  return {
    reached: true,
    path: routeOf(result.endpoint, result.peerRelay, result.derpRegion),
    latencyMs: result.latencyMs,
  };
}

export async function probePath(
  tailnet: Pick<Tailnet, "ping">,
  address: string,
  options?: PingOptions,
): Promise<PathProbe> {
  try {
    return classifyPing(await tailnet.ping(address, options));
  } catch (cause) {
    return { reached: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function isRelayed(path: MeshPath): boolean {
  return path.kind === "derp" || path.kind === "peer-relay";
}

function routeOf(endpoint: string, peerRelay: string, derpRegion: string): MeshPath {
  if (endpoint !== "") return { kind: "direct", endpoint };
  if (peerRelay !== "") return { kind: "peer-relay", relay: peerRelay };
  if (derpRegion !== "") return { kind: "derp", region: derpRegion };
  return { kind: "unknown" };
}
