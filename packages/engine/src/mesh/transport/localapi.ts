import { type IncomingMessage, request } from "node:http";
import { type PingResult, parsePingJson } from "./ping.ts";
import { parseServeConfig, type ServePosture } from "./serve-config.ts";
import { parseStatus, type TailnetStatus } from "./status.ts";
import {
  defaultPingTimeoutMs,
  defaultRequestTimeoutMs,
  type PingOptions,
  TailscaleError,
  type TailscaleTransport,
  TransportRefusedError,
} from "./transport.ts";
import { parseWhoIs, type WhoIs } from "./whois.ts";

export type LocalApiEndpoint =
  | { kind: "socket"; path: string }
  | { kind: "tcp"; host?: string | undefined; port: number; token: string };

export type EndpointSource = LocalApiEndpoint | (() => Promise<LocalApiEndpoint>);

export interface LocalApiOptions {
  endpoint: EndpointSource;
  timeoutMs?: number | undefined;
}

export const localApiHost = "local-tailscaled.sock";

export function localApiTransport(options: LocalApiOptions): TailscaleTransport {
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs;
  const call = async (method: "GET" | "POST", path: string, ms = timeoutMs) =>
    exchange(await resolveEndpoint(options.endpoint), method, path, ms);
  return {
    name: "localapi",
    status: async (): Promise<TailnetStatus> =>
      parseStatus(bodyOf(await call("GET", "/localapi/v0/status"))),
    whois: async (host): Promise<WhoIs | null> => {
      const reply = await call("GET", `/localapi/v0/whois?addr=${encodeURIComponent(host)}`);
      return reply.status === 404 ? null : parseWhoIs(bodyOf(reply));
    },
    ping: async (host, pingOptions?: PingOptions): Promise<PingResult> => {
      const ms = pingOptions?.timeoutMs ?? defaultPingTimeoutMs;
      const path = `/localapi/v0/ping?ip=${encodeURIComponent(host)}&type=disco`;
      return parsePingJson(bodyOf(await call("POST", path, ms + timeoutMs)));
    },
    serve: async (): Promise<ServePosture> =>
      parseServeConfig(bodyOf(await call("GET", "/localapi/v0/serve-config"))),
  };
}

interface Reply {
  status: number;
  body: string;
}

const refusedConnectionCodes = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "EACCES",
  "EPERM",
  "ECONNRESET",
  "FailedToOpenSocket",
]);

async function resolveEndpoint(source: EndpointSource): Promise<LocalApiEndpoint> {
  return typeof source === "function" ? source() : source;
}

function bodyOf(reply: Reply): string {
  if (reply.status === 200) return reply.body;
  const detail = `${reply.status} ${reply.body.trim()}`;
  if (reply.status === 401 || reply.status === 403) {
    throw new TransportRefusedError(`tailscaled refused the LocalAPI request: ${detail}`);
  }
  throw new TailscaleError(`tailscaled answered ${detail}`);
}

function exchange(
  endpoint: LocalApiEndpoint,
  method: "GET" | "POST",
  path: string,
  timeoutMs: number,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      method,
      path,
      headers: headersFor(endpoint),
      ...targetOf(endpoint),
    });
    outgoing.setTimeout(timeoutMs, () =>
      outgoing.destroy(new TailscaleError(`LocalAPI ${path} timed out after ${timeoutMs} ms`)),
    );
    outgoing.on("response", (incoming) => readReply(incoming).then(resolve, reject));
    outgoing.on("error", (cause) => reject(asTransportError(cause)));
    outgoing.end();
  });
}

function headersFor(endpoint: LocalApiEndpoint): Record<string, string> {
  if (endpoint.kind === "socket") return { Host: localApiHost };
  const basic = Buffer.from(`:${endpoint.token}`).toString("base64");
  return { Host: localApiHost, Authorization: `Basic ${basic}` };
}

function targetOf(
  endpoint: LocalApiEndpoint,
): { socketPath: string } | { host: string; port: number } {
  if (endpoint.kind === "socket") return { socketPath: endpoint.path };
  return { host: endpoint.host ?? "127.0.0.1", port: endpoint.port };
}

function readReply(incoming: IncomingMessage): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
    incoming.once("error", reject);
  });
}

function asTransportError(cause: Error): Error {
  if (cause instanceof TailscaleError) return cause;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
  if (refusedConnectionCodes.has(code)) {
    return new TransportRefusedError(`cannot reach tailscaled's LocalAPI (${code})`, { cause });
  }
  return new TailscaleError(`LocalAPI request failed: ${cause.message}`, { cause });
}
