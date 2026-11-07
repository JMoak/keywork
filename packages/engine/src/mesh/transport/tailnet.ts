import type { PingResult } from "./ping.ts";
import type { ServePosture } from "./serve-config.ts";
import { statusFingerprint, type TailnetStatus } from "./status.ts";
import { isIPAddress, peerHost } from "./tailnet-address.ts";
import { type PingOptions, TailscaleError, type TailscaleTransport } from "./transport.ts";
import type { WhoIs } from "./whois.ts";

export interface Tailnet {
  readonly transport: string;
  status(): Promise<TailnetStatus>;
  whois(address: string): Promise<WhoIs | null>;
  ping(address: string, options?: PingOptions): Promise<PingResult>;
  serve(): Promise<ServePosture>;
  forgetIdentities(): void;
}

export interface TailnetOptions {
  whoisMaxAgeMs?: number | undefined;
  now?: (() => number) | undefined;
}

export const defaultWhoisMaxAgeMs = 60_000;

export function createTailnet(
  transport: TailscaleTransport,
  options: TailnetOptions = {},
): Tailnet {
  const identities = whoisCache(transport, options);
  let fingerprint: string | null = null;
  return {
    get transport() {
      return transport.name;
    },
    status: async () => {
      const status = await transport.status();
      const next = statusFingerprint(status);
      if (fingerprint !== null && next !== fingerprint) identities.clear();
      fingerprint = next;
      return status;
    },
    whois: async (address) => identities.lookup(hostOf(address)),
    ping: async (address, pingOptions) => transport.ping(hostOf(address), pingOptions),
    serve: () => transport.serve(),
    forgetIdentities: () => identities.clear(),
  };
}

interface CachedIdentity {
  at: number;
  identity: Promise<WhoIs | null>;
}

function whoisCache(transport: TailscaleTransport, options: TailnetOptions) {
  const maxAgeMs = options.whoisMaxAgeMs ?? defaultWhoisMaxAgeMs;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CachedIdentity>();
  const fetch = (host: string): Promise<WhoIs | null> => {
    const entry: CachedIdentity = { at: now(), identity: transport.whois(host) };
    entries.set(host, entry);
    entry.identity.catch(() => {
      if (entries.get(host) === entry) entries.delete(host);
    });
    return entry.identity;
  };
  return {
    lookup(host: string): Promise<WhoIs | null> {
      const cached = entries.get(host);
      return cached !== undefined && now() - cached.at < maxAgeMs ? cached.identity : fetch(host);
    },
    clear: () => entries.clear(),
  };
}

function hostOf(address: string): string {
  const host = peerHost(address);
  if (!isIPAddress(host)) throw new TailscaleError(`not an IP address: ${JSON.stringify(address)}`);
  return host;
}
