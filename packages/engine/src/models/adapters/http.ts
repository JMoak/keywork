import { isLoopbackEndpoint } from "../../inference/references.ts";
import type { FetchLike } from "../../providers/transport.ts";

export interface HttpReply {
  status: number;
  ok: boolean;
  body: unknown;
  text: string;
}

export interface ProbeHttp {
  get(url: string): Promise<HttpReply>;
  post(url: string, body: unknown): Promise<HttpReply>;
}

export interface ProbeHttpOptions {
  fetchFn?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
}

export const defaultProbeTimeoutMs = 5_000;

export class EndpointUnreachableError extends Error {
  readonly transient = true;

  constructor(
    readonly url: string,
    detail: string,
  ) {
    super(`${url} is unreachable: ${detail}`);
    this.name = "EndpointUnreachableError";
  }
}

export function probeHttp(options: ProbeHttpOptions = {}): ProbeHttp {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? defaultProbeTimeoutMs;
  const headers = options.headers ?? {};
  const send = (url: string, init: RequestInit) =>
    exchange(fetchFn, url, {
      ...init,
      ...(isLoopbackEndpoint(url) && { redirect: "error" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  return {
    get: (url) => send(url, { method: "GET", headers: { ...headers } }),
    post: (url, body) =>
      send(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
  };
}

export function serverRootOf(endpoint: string): string {
  return endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function joinUrl(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}${path}`;
}

async function exchange(fetchFn: FetchLike, url: string, init: RequestInit): Promise<HttpReply> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (cause) {
    throw new EndpointUnreachableError(url, cause instanceof Error ? cause.message : String(cause));
  }
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: parsedJson(text), text };
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
