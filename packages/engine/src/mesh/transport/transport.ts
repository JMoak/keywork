import type { PingResult } from "./ping.ts";
import type { ServePosture } from "./serve-config.ts";
import type { TailnetStatus } from "./status.ts";
import type { WhoIs } from "./whois.ts";

export interface TailscaleTransport {
  readonly name: string;
  status(): Promise<TailnetStatus>;
  whois(host: string): Promise<WhoIs | null>;
  ping(host: string, options?: PingOptions): Promise<PingResult>;
  serve(): Promise<ServePosture>;
}

export interface PingOptions {
  timeoutMs?: number | undefined;
}

export const defaultPingTimeoutMs = 5_000;
export const defaultRequestTimeoutMs = 5_000;

export class TransportRefusedError extends Error {
  override readonly name = "TransportRefusedError";
}

export class TailscaleError extends Error {
  override readonly name = "TailscaleError";
}

export function withFallback(
  primary: TailscaleTransport,
  fallback: TailscaleTransport,
): TailscaleTransport {
  let active = primary;
  const attempt = async <T>(call: (transport: TailscaleTransport) => Promise<T>): Promise<T> => {
    if (active === fallback) return call(fallback);
    try {
      return await call(primary);
    } catch (cause) {
      if (!(cause instanceof TransportRefusedError)) throw cause;
      active = fallback;
      return call(fallback);
    }
  };
  return {
    get name() {
      return active === primary
        ? `${primary.name} (falls back to ${fallback.name})`
        : fallback.name;
    },
    status: () => attempt((transport) => transport.status()),
    whois: (host) => attempt((transport) => transport.whois(host)),
    ping: (host, options) => attempt((transport) => transport.ping(host, options)),
    serve: () => attempt((transport) => transport.serve()),
  };
}
