import { mcpLegacyProtocolVersion, mcpProtocolVersion } from "./era.ts";
import { asRecord } from "./wire.ts";

export interface ServedTool<Caller> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, caller: Caller): Promise<ServedToolOutcome>;
}

export type ServedToolOutcome = ServedToolResult | ServedToolRefusal;

export interface ServedToolResult {
  text: string;
  isError?: boolean | undefined;
  structured?: Record<string, unknown> | undefined;
}

export interface ServedToolRefusal {
  invalid: string;
}

export interface McpServerOptions<Caller> {
  name: string;
  version: string;
  instructions?: string | undefined;
  tools: readonly ServedTool<Caller>[];
}

export interface McpExchange {
  status: 200 | 202 | 400;
  body: Record<string, unknown> | undefined;
}

export interface ServedMcp<Caller> {
  answer(message: unknown, caller: Caller): Promise<McpExchange>;
}

export const servedProtocolVersions: readonly string[] = [
  mcpProtocolVersion,
  mcpLegacyProtocolVersion,
  "2025-06-18",
  "2025-03-26",
];

export const servedToolsTtlMs = 60 * 60_000;

export const rpcErrorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  unsupportedProtocolVersion: -32022,
} as const;

export function servedMcp<Caller>(options: McpServerOptions<Caller>): ServedMcp<Caller> {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const methods: Record<string, MethodHandler<Caller>> = {
    initialize: async (params) => initialized(options, params),
    "server/discover": async () => discovered(options),
    ping: async () => ({}),
    "tools/list": async () => ({
      tools: options.tools.map(listingOf),
      ttlMs: servedToolsTtlMs,
      cacheScope: "private",
    }),
    "tools/call": (params, caller) => called(tools, params, caller),
  };
  return {
    answer: async (message, caller) => {
      const request = rpcRequestOf(message);
      if ("refusal" in request) return request.refusal;
      if (request.id === undefined) return { status: 202, body: undefined };
      const modern = modernVersionOf(request.params);
      if (modern !== undefined && !servedProtocolVersions.includes(modern))
        return rejected(request.id, unsupportedVersion(modern));
      const handle = methods[request.method];
      if (handle === undefined)
        return answered(request.id, rpcError(rpcErrorCodes.methodNotFound, unknownMethod(request)));
      const outcome = await handle(request.params, caller);
      if (isRpcError(outcome)) return answered(request.id, outcome);
      return answered(request.id, modern === undefined ? outcome : stamped(outcome, options));
    },
  };
}

export function protocolHeaderRefusal(headers: Headers, message: unknown): McpExchange | undefined {
  const version = headers.get("mcp-protocol-version");
  const id = idOf(message);
  if (version !== null && !servedProtocolVersions.includes(version))
    return rejected(id, unsupportedVersion(version));
  const method = headers.get("mcp-method");
  const named = asRecord(message).method;
  if (method !== null && method !== named)
    return rejected(
      id,
      rpcError(
        rpcErrorCodes.invalidRequest,
        `the mcp-method header says ${method} but the body calls ${String(named)}`,
      ),
    );
  return undefined;
}

export function exchangeResponse(exchange: McpExchange): Response {
  if (exchange.body === undefined) return new Response(null, { status: exchange.status });
  return new Response(JSON.stringify(exchange.body), {
    status: exchange.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function answerMcpHttp<Caller>(
  server: ServedMcp<Caller>,
  request: Request,
  caller: Caller,
): Promise<Response> {
  const message = await jsonBodyOf(request);
  if (message === unparseable)
    return exchangeResponse(rejected(null, rpcError(rpcErrorCodes.parse, "the body is not JSON")));
  const refusal = protocolHeaderRefusal(request.headers, message);
  if (refusal !== undefined) return exchangeResponse(refusal);
  return exchangeResponse(await server.answer(message, caller));
}

type MethodHandler<Caller> = (
  params: Record<string, unknown>,
  caller: Caller,
) => Promise<Record<string, unknown> | RpcError>;

interface RpcRequest {
  id: string | number | undefined;
  method: string;
  params: Record<string, unknown>;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

const unparseable = Symbol("unparseable");
const serverInfoKey = "io.modelcontextprotocol/serverInfo";
const protocolVersionKey = "io.modelcontextprotocol/protocolVersion";

function rpcRequestOf(message: unknown): RpcRequest | { refusal: McpExchange } {
  if (Array.isArray(message))
    return refusedWith(null, "a batch is not served: send one JSON-RPC message per request");
  const record = asRecord(message);
  const id = idOf(message);
  if (record.jsonrpc !== "2.0") return refusedWith(id, "the message is not JSON-RPC 2.0");
  if (typeof record.method !== "string") {
    const isResponse = "result" in record || "error" in record;
    return isResponse
      ? { refusal: { status: 202, body: undefined } }
      : refusedWith(id, "the message names no method");
  }
  const malformedId =
    record.id !== undefined && typeof record.id !== "string" && typeof record.id !== "number";
  if (malformedId) return refusedWith(null, "a request id is a string or a number");
  if (record.params !== undefined && asRecord(record.params) !== record.params)
    return refusedWith(id, "params is an object");
  return { id: id ?? undefined, method: record.method, params: asRecord(record.params) };
}

function refusedWith(id: string | number | null, message: string): { refusal: McpExchange } {
  return { refusal: rejected(id, rpcError(rpcErrorCodes.invalidRequest, message)) };
}

function initialized<Caller>(
  options: McpServerOptions<Caller>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const asked = params.protocolVersion;
  const legacy = servedProtocolVersions.filter((version) => version !== mcpProtocolVersion);
  const protocolVersion =
    typeof asked === "string" && legacy.includes(asked) ? asked : mcpLegacyProtocolVersion;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: serverInfoOf(options),
    ...(options.instructions !== undefined && { instructions: options.instructions }),
  };
}

function discovered<Caller>(options: McpServerOptions<Caller>): Record<string, unknown> {
  return {
    supportedVersions: [...servedProtocolVersions],
    capabilities: { tools: { listChanged: false } },
    ...(options.instructions !== undefined && { instructions: options.instructions }),
  };
}

async function called<Caller>(
  tools: ReadonlyMap<string, ServedTool<Caller>>,
  params: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown> | RpcError> {
  const tool = typeof params.name === "string" ? tools.get(params.name) : undefined;
  if (tool === undefined)
    return rpcError(rpcErrorCodes.invalidParams, `no tool is called ${String(params.name)}`);
  if (params.arguments !== undefined && asRecord(params.arguments) !== params.arguments)
    return rpcError(rpcErrorCodes.invalidParams, "arguments is an object");
  const outcome = await tool.call(asRecord(params.arguments), caller);
  if ("invalid" in outcome) return rpcError(rpcErrorCodes.invalidParams, outcome.invalid);
  return {
    content: [{ type: "text", text: outcome.text }],
    ...(outcome.structured !== undefined && { structuredContent: outcome.structured }),
    isError: outcome.isError === true,
  };
}

function listingOf<Caller>(tool: ServedTool<Caller>): Record<string, unknown> {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function stamped<Caller>(
  result: Record<string, unknown>,
  options: McpServerOptions<Caller>,
): Record<string, unknown> {
  return {
    ...result,
    resultType: "complete",
    _meta: { ...asRecord(result._meta), [serverInfoKey]: serverInfoOf(options) },
  };
}

function serverInfoOf<Caller>(options: McpServerOptions<Caller>): Record<string, unknown> {
  return { name: options.name, version: options.version };
}

function modernVersionOf(params: Record<string, unknown>): string | undefined {
  const version = asRecord(params._meta)[protocolVersionKey];
  return typeof version === "string" ? version : undefined;
}

function unsupportedVersion(version: string): RpcError {
  return rpcError(
    rpcErrorCodes.unsupportedProtocolVersion,
    `MCP ${version} is not served here; this server speaks ${servedProtocolVersions.join(", ")}`,
    { supported: [...servedProtocolVersions], requested: version },
  );
}

function unknownMethod(request: RpcRequest): string {
  return `${request.method} is not served: this server offers tools only`;
}

function answered(id: string | number, outcome: Record<string, unknown> | RpcError): McpExchange {
  if (isRpcError(outcome)) return { status: 200, body: { jsonrpc: "2.0", id, error: outcome } };
  return { status: 200, body: { jsonrpc: "2.0", id, result: outcome } };
}

function rejected(id: string | number | null, error: RpcError): McpExchange {
  return { status: 400, body: { jsonrpc: "2.0", id, error } };
}

function rpcError(code: number, message: string, data?: unknown): RpcError {
  return { code, message, ...(data !== undefined && { data }) };
}

function isRpcError(value: Record<string, unknown> | RpcError): value is RpcError {
  return typeof value.code === "number" && typeof value.message === "string";
}

function idOf(message: unknown): string | number | null {
  const id = asRecord(message).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

async function jsonBodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return unparseable;
  }
}
