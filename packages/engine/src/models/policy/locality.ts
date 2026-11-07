import { isLoopbackEndpoint } from "../../inference/references.ts";

export type Locality = "local" | "cloud";

export function localityOf(endpoint: string): Locality {
  const host = hostnameOf(endpoint);
  if (host === undefined) return "cloud";
  return isLoopbackEndpoint(endpoint) || privateHost(host) ? "local" : "cloud";
}

function hostnameOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function privateHost(host: string): boolean {
  if (host.includes(":")) return privateIpv6(host);
  const octets = ipv4Octets(host);
  if (octets !== undefined) return privateIpv4(octets);
  return !host.includes(".") || privateSuffixes.some((suffix) => host.endsWith(suffix));
}

const privateSuffixes = [".local", ".lan", ".home.arpa", ".internal", ".ts.net"];

function ipv4Octets(host: string): readonly number[] | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined;
  return host.split(".").map(Number);
}

function privateIpv4([a = 0, b = 0]: readonly number[]): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function privateIpv6(host: string): boolean {
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}
