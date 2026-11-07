import { describe, expect, it } from "vitest";
import type { FetchLike } from "../providers/transport.ts";
import { McpRpcError } from "./errors.ts";
import { connectHttpServer } from "./http.ts";
import {
  answerMcpHttp,
  rpcErrorCodes,
  type ServedTool,
  servedMcp,
  servedProtocolVersions,
  servedToolsTtlMs,
} from "./server.ts";

interface Caller {
  who: string;
}

const echo: ServedTool<Caller> = {
  name: "echo",
  description: "Says the words back with the caller's name.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  call: async (args, caller) =>
    typeof args.text === "string"
      ? { text: `${caller.who}: ${args.text}`, structured: { echoed: args.text } }
      : { invalid: "text is a string" },
};

const failing: ServedTool<Caller> = {
  name: "failing",
  description: "Always reports a failure in words.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  call: async () => ({ text: "it went wrong", isError: true }),
};

const server = servedMcp<Caller>({
  name: "fixture",
  version: "1.0.0",
  instructions: "A fixture server.",
  tools: [echo, failing],
});

const url = "http://127.0.0.1:9/mcp";

function fetchOver(caller: Caller, versions: (string | null)[] = []): FetchLike {
  return (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    versions.push(request.headers.get("mcp-protocol-version"));
    if (request.method !== "POST") return new Response(null, { status: 405 });
    return answerMcpHttp(server, request, caller);
  }) satisfies FetchLike;
}

async function rpcBody(response: Response): Promise<unknown> {
  return response.json();
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return answerMcpHttp(server, request, { who: "probe" });
}

describe("servedMcp through keywork's own client", () => {
  it("negotiates the modern era, lists tools and calls one with the transport's caller", async () => {
    const versions: (string | null)[] = [];
    const connection = await connectHttpServer(
      { url },
      { fetchImpl: fetchOver({ who: "ada" }, versions) },
    );
    expect(connection.era).toBe("modern");
    expect(connection.serverName).toBe("fixture");
    expect((await connection.listTools()).map(({ name }) => name)).toEqual(["echo", "failing"]);
    expect(await connection.callTool("echo", { text: "hello" })).toEqual({
      text: "ada: hello",
      isError: false,
    });
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => version === "2026-07-28")).toBe(true);
    await connection.close();
  });

  it("speaks the legacy era to a client that initializes", async () => {
    const connection = await connectHttpServer(
      { url },
      { fetchImpl: fetchOver({ who: "pip" }), rememberedEra: "legacy" },
    );
    expect(connection.era).toBe("legacy");
    expect(connection.serverName).toBe("fixture");
    expect(await connection.callTool("echo", { text: "hi" })).toEqual({
      text: "pip: hi",
      isError: false,
    });
    expect(await connection.callTool("failing", {})).toEqual({
      text: "it went wrong",
      isError: true,
    });
    await connection.close();
  });

  it("refuses an unknown tool and bad arguments as invalid params", async () => {
    const connection = await connectHttpServer({ url }, { fetchImpl: fetchOver({ who: "ada" }) });
    await expect(connection.callTool("nope", {})).rejects.toBeInstanceOf(McpRpcError);
    await expect(connection.callTool("echo", { text: 3 })).rejects.toMatchObject({
      code: rpcErrorCodes.invalidParams,
    });
    await connection.close();
  });
});

describe("servedMcp on the wire", () => {
  it("answers server/discover with every version it serves and stamps modern results", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: meta },
    });
    expect(response.status).toBe(200);
    expect(await rpcBody(response)).toMatchObject({
      result: {
        supportedVersions: [...servedProtocolVersions],
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1.0.0" } },
      },
    });
  });

  it("lists tools with the cache hints 2026-07-28 asks of every list", async () => {
    const response = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(await rpcBody(response)).toMatchObject({
      result: { ttlMs: servedToolsTtlMs, cacheScope: "private" },
    });
  });

  it("answers a notification and a stray response with 202 and no body", async () => {
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const stray = await post({ jsonrpc: "2.0", id: 4, result: {} });
    expect(stray.status).toBe(202);
  });

  it("refuses an unserved protocol version in the header or the request meta with -32022", async () => {
    const header = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-protocol-version": "1999-01-01" },
    );
    expect(header.status).toBe(400);
    expect(await rpcBody(header)).toMatchObject({
      error: { code: rpcErrorCodes.unsupportedProtocolVersion },
    });
    const meta = { "io.modelcontextprotocol/protocolVersion": "2030-01-01" };
    const inBody = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { _meta: meta },
    });
    expect(await rpcBody(inBody)).toMatchObject({
      error: { data: { supported: expect.arrayContaining(["2026-07-28"]) } },
    });
  });

  it("refuses a method header that disagrees with the body", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo" } },
      { "mcp-method": "tools/list" },
    );
    expect(response.status).toBe(400);
    expect(await rpcBody(response)).toMatchObject({
      error: { code: rpcErrorCodes.invalidRequest },
    });
  });

  it("refuses unparseable bodies, batches and unknown methods in JSON-RPC words", async () => {
    expect(await rpcBody(await post("{not json"))).toMatchObject({
      error: { code: rpcErrorCodes.parse },
    });
    const batch = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(await rpcBody(batch)).toMatchObject({ error: { code: rpcErrorCodes.invalidRequest } });
    const unknown = await post({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(await rpcBody(unknown)).toMatchObject({ error: { code: rpcErrorCodes.methodNotFound } });
  });

  it("returns structured content beside the text", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "x" } },
    });
    expect(await rpcBody(response)).toMatchObject({
      result: {
        content: [{ type: "text", text: "probe: x" }],
        structuredContent: { echoed: "x" },
        isError: false,
      },
    });
  });

  it("leaves a legacy initialize at the version the client asked for when it is served", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 8,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x" } },
    });
    expect(await rpcBody(response)).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "fixture" },
        instructions: "A fixture server.",
      },
    });
  });

  it("serves an empty tool list to a client that connects", async () => {
    const bare = servedMcp<Caller>({ name: "bare", version: "0", tools: [] });
    const fetchImpl = (async (input: string, init?: RequestInit) =>
      answerMcpHttp(bare, new Request(input, init), { who: "x" })) satisfies FetchLike;
    const connection = await connectHttpServer({ url }, { fetchImpl });
    expect(await connection.listTools()).toEqual([]);
    await connection.close();
  });
});
