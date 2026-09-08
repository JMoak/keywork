import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createKeyworkServer, defaultPort, type ServerOptions } from "./server.ts";

export const loopback = "127.0.0.1";

export interface ListenOptions extends Omit<ServerOptions, "url"> {
  port?: number | undefined;
}

export interface ListeningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function listen(options: ListenOptions): Promise<ListeningServer> {
  const requested = options.port ?? defaultPort;
  const bound = createServer();
  const port = await bind(bound, requested);
  const url = `http://${loopback}:${port}`;
  const server = createKeyworkServer({ ...options, url });
  bound.on("request", (incoming, outgoing) => {
    answer(server.fetch, url, incoming, outgoing).catch(() => outgoing.destroy());
  });
  return {
    url,
    port,
    close: async () => {
      await server.close();
      bound.closeAllConnections();
      await new Promise<void>((resolve) => bound.close(() => resolve()));
    },
  };
}

function bind(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, loopback, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function answer(
  handle: (request: Request) => Promise<Response>,
  origin: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const disconnects = new AbortController();
  outgoing.once("close", () => disconnects.abort());
  const response = await handle(await toFetchRequest(incoming, origin, disconnects.signal));
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null) {
    outgoing.end();
    return;
  }
  await pump(response.body, outgoing, disconnects.signal);
}

async function toFetchRequest(
  incoming: IncomingMessage,
  origin: string,
  signal: AbortSignal,
): Promise<Request> {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const bodiless = method === "GET" || method === "HEAD";
  return new Request(`${origin}${incoming.url ?? "/"}`, {
    method,
    headers,
    signal,
    ...(!bodiless && { body: await readAll(incoming) }),
  });
}

function readAll(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.once("end", () => resolve(Buffer.concat(chunks)));
    incoming.once("error", reject);
  });
}

async function pump(
  body: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
  disconnected: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  disconnected.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
  } finally {
    disconnected.removeEventListener("abort", cancel);
    outgoing.end();
  }
}
