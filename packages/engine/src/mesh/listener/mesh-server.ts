import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { peerHost, urlHost } from "../transport/tailnet-address.ts";
import { type Admission, deny, type MeshCaller } from "./admission.ts";

export type MeshHandler = (request: Request, caller: MeshCaller) => Promise<Response>;

export interface MeshServerOptions {
  identify(remoteAddress: string | undefined): Promise<Admission>;
  handle: MeshHandler;
  onAdmission?: ((admission: Admission) => void) | undefined;
  maxBodyBytes?: number | undefined;
}

export const funnelHeader = "tailscale-funnel-request";
export const defaultMaxBodyBytes = 1024 * 1024;

export function createMeshServer(options: MeshServerOptions): Server {
  const admissions = new WeakMap<Socket, Promise<Admission>>();
  const server = createServer();
  const identify = (socket: Socket) => identifyClosed(options, socket.remoteAddress);
  server.on("connection", (socket: Socket) => {
    const admission = identify(socket);
    admissions.set(socket, admission);
    void admission.then((settled) => options.onAdmission?.(settled));
  });
  server.on("request", (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const admission = admissions.get(incoming.socket) ?? identify(incoming.socket);
    answer(options, admission, incoming, outgoing).catch(() => outgoing.destroy());
  });
  return server;
}

function identifyClosed(
  options: MeshServerOptions,
  remoteAddress: string | undefined,
): Promise<Admission> {
  return options
    .identify(remoteAddress)
    .catch((cause: unknown) => deny(peerHost(remoteAddress ?? ""), "whois-failed", String(cause)));
}

async function answer(
  options: MeshServerOptions,
  pending: Promise<Admission>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const dropped = abortedWhenDroppedEarly(outgoing);
  if (incoming.headers[funnelHeader] !== undefined) {
    const address = peerHost(incoming.socket.remoteAddress ?? "");
    options.onAdmission?.(deny(address, "funnel", "the request came through Tailscale Funnel"));
    return refuse(outgoing, 403, { error: "mesh.funnel-refused" });
  }
  const admission = await pending;
  if (!admission.admitted) {
    return refuse(outgoing, 403, { error: "mesh.denied", reason: admission.reason });
  }
  const limit = options.maxBodyBytes ?? defaultMaxBodyBytes;
  const body = await readBody(incoming, limit);
  if (body === "too-large") return refuse(outgoing, 413, { error: "mesh.body-too-large", limit });
  const response = await options.handle(toRequest(incoming, body, dropped), admission.caller);
  await send(response, outgoing, dropped);
}

function abortedWhenDroppedEarly(outgoing: ServerResponse): AbortSignal {
  const controller = new AbortController();
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) controller.abort();
  });
  return controller.signal;
}

function refuse(outgoing: ServerResponse, status: number, body: Record<string, unknown>): void {
  outgoing.writeHead(status, { "content-type": "application/json", connection: "close" });
  outgoing.end(JSON.stringify(body));
}

function toRequest(incoming: IncomingMessage, body: Buffer | null, signal: AbortSignal): Request {
  const { localAddress = "127.0.0.1", localPort } = incoming.socket;
  const origin = `http://${urlHost(localAddress)}:${localPort}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = incoming.method ?? "GET";
  return new Request(new URL(incoming.url ?? "/", origin).href, {
    method,
    headers,
    signal,
    ...(body !== null && { body: new Uint8Array(body) }),
  });
}

function readBody(incoming: IncomingMessage, limit: number): Promise<Buffer | null | "too-large"> {
  const method = incoming.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    incoming.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        incoming.removeAllListeners("data");
        incoming.resume();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    incoming.once("end", () => resolve(Buffer.concat(chunks)));
    incoming.once("error", reject);
  });
}

async function send(
  response: Response,
  outgoing: ServerResponse,
  dropped: AbortSignal,
): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel(dropped.reason).catch(() => {});
  if (dropped.aborted) cancel();
  else dropped.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
  } finally {
    dropped.removeEventListener("abort", cancel);
  }
  if (!dropped.aborted) outgoing.end();
}
