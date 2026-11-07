import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalApiEndpoint, localApiHost } from "../localapi.ts";
import { peerHost } from "../tailnet-address.ts";

export interface FakeTailscaledOptions {
  status?: (() => string) | undefined;
  whois?: Readonly<Record<string, string>> | undefined;
  ping?: ((ip: string) => string) | undefined;
  serveConfig?: (() => string) | undefined;
  token?: string | undefined;
  answerEverythingWith?: number | undefined;
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

export interface FakeTailscaled {
  endpoint: LocalApiEndpoint;
  requests: SeenRequest[];
  close(): Promise<void>;
}

export async function startFakeTailscaled(
  listenOn: "socket" | "tcp",
  options: FakeTailscaledOptions,
): Promise<FakeTailscaled> {
  const requests: SeenRequest[] = [];
  const server = createServer((incoming, outgoing) => {
    requests.push({
      method: incoming.method ?? "",
      url: incoming.url ?? "",
      headers: incoming.headers,
    });
    answer(options, incoming, outgoing);
  });
  const endpoint = await listen(server, listenOn, options.token);
  return {
    endpoint,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function fakeSocketPath(): string {
  const name = `keywork-fake-tailscaled-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

function listen(
  server: ReturnType<typeof createServer>,
  listenOn: "socket" | "tcp",
  token: string | undefined,
): Promise<LocalApiEndpoint> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (listenOn === "socket") {
      const path = fakeSocketPath();
      server.listen(path, () => resolve({ kind: "socket", path }));
      return;
    }
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ kind: "tcp", host: "127.0.0.1", port, token: token ?? "" });
    });
  });
}

interface FakeReply {
  status: number;
  body: string;
}

function answer(
  options: FakeTailscaledOptions,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): void {
  const { status, body } = replyFor(options, incoming);
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(body);
}

function replyFor(options: FakeTailscaledOptions, incoming: IncomingMessage): FakeReply {
  const refusal = refusalOf(options, incoming);
  if (refusal !== null) return refusal;
  const url = new URL(incoming.url ?? "/", `http://${localApiHost}`);
  const route = `${incoming.method} ${url.pathname}`;
  if (route === "GET /localapi/v0/status" && options.status !== undefined) {
    return ok(options.status());
  }
  if (route === "GET /localapi/v0/whois") {
    const known = options.whois?.[peerHost(url.searchParams.get("addr") ?? "")];
    return known === undefined ? { status: 404, body: "no match for IP:port\n" } : ok(known);
  }
  if (route === "POST /localapi/v0/ping" && options.ping !== undefined) {
    return ok(options.ping(url.searchParams.get("ip") ?? ""));
  }
  if (route === "GET /localapi/v0/serve-config") return ok(options.serveConfig?.() ?? "{}");
  return { status: 404, body: "not found\n" };
}

function ok(body: string): FakeReply {
  return { status: 200, body };
}

function refusalOf(options: FakeTailscaledOptions, incoming: IncomingMessage): FakeReply | null {
  if (options.answerEverythingWith !== undefined) {
    return { status: options.answerEverythingWith, body: "refused by the fake\n" };
  }
  if (incoming.headers.host !== localApiHost) return { status: 403, body: "invalid host\n" };
  if (incoming.headers.origin !== undefined || incoming.headers.referer !== undefined) {
    return { status: 403, body: "origin or referer present\n" };
  }
  if (options.token === undefined) return null;
  const expected = `Basic ${Buffer.from(`:${options.token}`).toString("base64")}`;
  return incoming.headers.authorization === expected
    ? null
    : { status: 401, body: "unauthorized\n" };
}
