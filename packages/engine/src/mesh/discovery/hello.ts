import { z } from "zod";
import { urlHost } from "../transport/tailnet-address.ts";

export const meshHelloPath = "/mesh/hello";
export const meshProduct = "keywork";
export const pairingStates = ["unclaimed", "claimed"] as const;

export type PairingState = (typeof pairingStates)[number];

export const meshHelloSchema = z.object({
  product: z.literal(meshProduct),
  version: z.string().min(1).max(64),
  pairing: z.enum(pairingStates),
});

export type MeshHello = z.infer<typeof meshHelloSchema>;

export type HelloFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface HelloProbeOptions {
  fetch?: HelloFetch | undefined;
  timeoutMs?: number | undefined;
}

export const defaultHelloTimeoutMs = 2_000;

export function meshHello(version: string, pairing: PairingState): MeshHello {
  return { product: meshProduct, version, pairing };
}

export async function probeHello(
  address: string,
  port: number,
  options: HelloProbeOptions = {},
): Promise<MeshHello | null> {
  const get: HelloFetch = options.fetch ?? fetch;
  const url = `http://${urlHost(address)}:${port}${meshHelloPath}`;
  try {
    const response = await get(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultHelloTimeoutMs),
    });
    if (!response.ok) return null;
    const parsed = meshHelloSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
