import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type McpConnection, McpProtocolError, McpRequestTimeoutError } from "./client.ts";
import { connectHttpServer } from "./http.ts";
import { McpRegistry } from "./registry.ts";

interface RecordedRequest {
  method: string;
  rpcMethod: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

interface FixtureOptions {
  streamToolCalls?: boolean;
  silentToolCalls?: boolean;
  failToolLists?: boolean;
}

class HttpFixture {
  readonly requests: RecordedRequest[] = [];
  initializations = 0;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly options: FixtureOptions;

  constructor(options: FixtureOptions = {}) {
    this.options = options;
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/mcp`;
  }

  pushToolsChanged(): void {
    for (const stream of this.eventStreams) {
      stream.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
      );
    }
  }

  dropEventStreams(): void {
    for (const stream of this.eventStreams) stream.destroy();
    this.eventStreams.clear();
  }

  openEventStreams(): number {
    return this.eventStreams.size;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const rpc = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
    this.requests.push({
      method: request.method ?? "",
      rpcMethod: typeof rpc.method === "string" ? rpc.method : undefined,
      headers: { ...request.headers },
    });
    if (request.method === "GET") return this.serveEventStream(response);
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    this.serveRpc(rpc, response);
  }

  private serveEventStream(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": open\n\n");
    this.eventStreams.add(response);
    response.on("close", () => this.eventStreams.delete(response));
  }

  private serveRpc(rpc: Record<string, unknown>, response: ServerResponse): void {
    const method = rpc.method;
    if (method === "initialize") {
      this.initializations += 1;
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-77",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "fixture-http" } },
        }),
      );
      return;
    }
    if (typeof method === "string" && method.startsWith("notifications/")) {
      response.writeHead(202).end();
      return;
    }
    if (method === "tools/list") {
      this.serveToolPage(rpc, response);
      return;
    }
    if (method === "tools/call") {
      this.serveToolCall(rpc, response);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { message: "no such method" } }),
    );
  }

  private serveToolPage(rpc: Record<string, unknown>, response: ServerResponse): void {
    if (this.options.failToolLists === true) {
      response.writeHead(500).end();
      return;
    }
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const first = params.cursor === undefined;
    const result = first
      ? { tools: [tool("echo", "Echoes text back.")], nextCursor: "page-2" }
      : { tools: [tool("add", "Adds numbers.")] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  }

  private serveToolCall(rpc: Record<string, unknown>, response: ServerResponse): void {
    if (this.options.silentToolCalls === true) return;
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const reply = {
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: String(args.text ?? "") }] },
    };
    if (this.options.streamToolCalls === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`,
      );
      response.write(`data: ${JSON.stringify(reply)}\n\n`);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  }
}

function tool(name: string, description: string): Record<string, unknown> {
  return { name, description, inputSchema: { type: "object" } };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => resolve(body));
  });
}

const fixtures: HttpFixture[] = [];
const connections: McpConnection[] = [];
const registries: McpRegistry[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(registries.splice(0).map((registry) => registry.stop()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function openFixture(options: FixtureOptions = {}): Promise<{
  fixture: HttpFixture;
  url: string;
}> {
  const fixture = new HttpFixture(options);
  fixtures.push(fixture);
  return { fixture, url: await fixture.listen() };
}

async function connectFixture(
  url: string,
  headers?: Record<string, string>,
  requestTimeoutMs = 5_000,
): Promise<McpConnection> {
  const connection = await connectHttpServer(
    { url, ...(headers !== undefined && { headers }) },
    { requestTimeoutMs },
  );
  connections.push(connection);
  return connection;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("http MCP client", () => {
  it("handshakes, adopts the session id, and pages through tools", async () => {
    const { fixture, url } = await openFixture();
    const connection = await connectFixture(url);
    expect(connection.serverName).toBe("fixture-http");
    const tools = await connection.listTools();
    expect(tools.map((entry) => entry.name)).toEqual(["echo", "add"]);
    const listRequests = fixture.requests.filter((entry) => entry.rpcMethod === "tools/list");
    expect(listRequests).toHaveLength(2);
    for (const request of listRequests) {
      expect(request.headers["mcp-session-id"]).toBe("session-77");
      expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
    }
  });

  it("passes configured auth headers through verbatim on every request", async () => {
    const { fixture, url } = await openFixture();
    await connectFixture(url, { authorization: "Bearer sesame", "x-team": "keywork" });
    await waitFor(() => fixture.requests.some((entry) => entry.method === "GET"));
    for (const request of fixture.requests) {
      expect(request.headers.authorization).toBe("Bearer sesame");
      expect(request.headers["x-team"]).toBe("keywork");
    }
  });

  it("round-trips a tool call answered as plain JSON", async () => {
    const { url } = await openFixture();
    const connection = await connectFixture(url);
    const result = await connection.callTool("echo", { text: "over http" });
    expect(result).toEqual({ text: "over http", isError: false });
  });

  it("round-trips a tool call answered as an SSE stream", async () => {
    const { url } = await openFixture({ streamToolCalls: true });
    const connection = await connectFixture(url);
    const result = await connection.callTool("echo", { text: "streamed" });
    expect(result).toEqual({ text: "streamed", isError: false });
  });

  it("times out a request the server never answers", async () => {
    const { url } = await openFixture({ silentToolCalls: true });
    const connection = await connectFixture(url, undefined, 300);
    await expect(connection.callTool("echo", { text: "x" })).rejects.toBeInstanceOf(
      McpRequestTimeoutError,
    );
  });

  it("reports an http error status as a protocol error", async () => {
    const { url } = await openFixture({ failToolLists: true });
    const connection = await connectFixture(url);
    await expect(connection.listTools()).rejects.toBeInstanceOf(McpProtocolError);
  });

  it("relays tools/list_changed notifications from the event stream", async () => {
    const { fixture, url } = await openFixture();
    const connection = await connectFixture(url);
    let changes = 0;
    connection.onToolsChanged(() => {
      changes += 1;
    });
    await waitFor(() => fixture.openEventStreams() === 1);
    fixture.pushToolsChanged();
    await waitFor(() => changes === 1);
  });

  it("treats a dropped event stream as a lost connection", async () => {
    const { fixture, url } = await openFixture();
    const connection = await connectFixture(url);
    const losses: (Error | undefined)[] = [];
    connection.onClose((error) => losses.push(error));
    await waitFor(() => fixture.openEventStreams() === 1);
    fixture.dropEventStreams();
    await waitFor(() => losses.length === 1);
    expect(losses[0]?.message).toContain("event stream");
  });

  it("ends the session with a DELETE on close", async () => {
    const { fixture, url } = await openFixture();
    const connection = await connectHttpServer({ url }, { requestTimeoutMs: 5_000 });
    await connection.close();
    const farewell = fixture.requests.find((entry) => entry.method === "DELETE");
    expect(farewell?.headers["mcp-session-id"]).toBe("session-77");
  });
});

describe("http MCP transport through the reconciler", () => {
  it("reconnects after the event stream drops", async () => {
    const { fixture, url } = await openFixture();
    const registry = new McpRegistry({
      servers: { remote: { transport: "http", url } },
      restartDelaysMs: [10, 10, 10],
    });
    registries.push(registry);
    registry.start();
    await waitFor(() => registry.status()[0]?.state === "connected");
    expect(registry.status()[0]?.transport).toBe("http");
    expect(fixture.initializations).toBe(1);
    await waitFor(() => fixture.openEventStreams() === 1);
    fixture.dropEventStreams();
    await waitFor(() => fixture.initializations >= 2);
    await waitFor(() => registry.status()[0]?.state === "connected");
    expect(registry.listTools("remote").map((entry) => entry.name)).toEqual(["echo", "add"]);
  });
});
