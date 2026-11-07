import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureReply {
  match?: Readonly<Record<string, unknown>>;
  once?: boolean;
  status?: number;
  body?: unknown;
  sse?: readonly unknown[];
  text?: string;
}

export interface ServerFixture {
  server: { kind: string; version: string };
  source: string;
  routes: Readonly<Record<string, readonly FixtureReply[]>>;
}

export interface SeenRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export function loadFixture(name: string): ServerFixture {
  const url = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as ServerFixture;
}

export class FixtureServer {
  readonly seen: SeenRequest[] = [];
  private readonly server: Server;
  private readonly routes = new Map<string, FixtureReply[]>();

  constructor(fixture?: ServerFixture) {
    for (const [route, replies] of Object.entries(fixture?.routes ?? {})) {
      this.routes.set(route, [...replies]);
    }
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  route(route: string, ...replies: readonly FixtureReply[]): this {
    this.routes.set(route, [...replies, ...(this.routes.get(route) ?? [])]);
    return this;
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  requestsTo(route: string): SeenRequest[] {
    return this.seen.filter((request) => `${request.method} ${request.path}` === route);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fixture");
    const body = parsedBody(await readBody(request));
    const method = request.method ?? "GET";
    this.seen.push({ method, path: url.pathname, search: url.search, body });
    const reply =
      this.take(`${method} ${url.pathname}${url.search}`, body) ??
      this.take(`${method} ${url.pathname}`, body);
    if (reply === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `no fixture for ${method} ${url.pathname}` }));
      return;
    }
    send(response, reply);
  }

  private take(route: string, body: unknown): FixtureReply | undefined {
    const replies = this.routes.get(route);
    const index = replies?.findIndex((reply) => matches(reply.match, body)) ?? -1;
    const reply = index === -1 ? undefined : replies?.[index];
    if (reply?.once === true) replies?.splice(index, 1);
    return reply;
  }
}

function send(response: ServerResponse, reply: FixtureReply): void {
  const status = reply.status ?? 200;
  if (reply.sse !== undefined) {
    response.writeHead(status, { "content-type": "text/event-stream" });
    for (const event of reply.sse) {
      response.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
    }
    response.end();
    return;
  }
  if (reply.text !== undefined) {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(reply.text);
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(reply.body ?? {}));
}

function matches(match: Readonly<Record<string, unknown>> | undefined, body: unknown): boolean {
  if (match === undefined) return true;
  if (typeof body !== "object" || body === null) return false;
  const fields = body as Record<string, unknown>;
  return Object.entries(match).every(([key, value]) => fields[key] === value);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parsedBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
