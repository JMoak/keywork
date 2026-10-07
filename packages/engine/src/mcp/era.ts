import type { McpTool, McpToolResult } from "./client.ts";
import {
  McpInputRequiredError,
  McpProtocolError,
  McpRequestTimeoutError,
  McpRpcError,
} from "./errors.ts";
import { asArray, asRecord, collectToolPages, toolCallResult } from "./wire.ts";

export type McpEra = "modern" | "legacy";

export const mcpProtocolVersion = "2026-07-28";
export const mcpLegacyProtocolVersion = "2025-11-25";
export const subscriptionMethod = "subscriptions/listen";
export const discoverProbeTimeoutMs = 2_000;

export interface EraTransport {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string): Promise<void>;
}

export class McpSession {
  era: McpEra = "modern";
  protocolVersion = mcpProtocolVersion;
  serverName = "unknown";
  listensForToolChanges = false;
  private toolsFreshUntil = Number.POSITIVE_INFINITY;
  private staleToolsAnnounced = false;

  constructor(
    private readonly transport: EraTransport,
    private readonly onToolsStale: () => void,
    private readonly probeTimeoutMs?: number,
  ) {}

  async open(remembered?: McpEra): Promise<void> {
    if (remembered === "legacy") return this.openLegacy();
    try {
      this.adoptDiscovery(await this.request("server/discover", {}, this.probeTimeoutMs));
    } catch (cause) {
      if (cause instanceof McpRpcError && isModernErrorCode(cause.code)) throw modernRefusal(cause);
      if (!marksLegacyServer(cause)) throw cause;
      await this.openLegacy();
    }
  }

  async listTools(): Promise<McpTool[]> {
    const listing = await collectToolPages((method, params) => this.request(method, params));
    this.toolsFreshUntil = this.era === "modern" ? listing.freshUntil : Number.POSITIVE_INFINITY;
    this.staleToolsAnnounced = false;
    return listing.tools;
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    this.announceStaleTools();
    return toolCallResult(await this.request("tools/call", { name, arguments: args ?? {} }));
  }

  subscriptionParams(): Record<string, unknown> {
    return this.shape({ notifications: { toolsListChanged: true } });
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const result = asRecord(await this.transport.request(method, this.shape(params), timeoutMs));
    if (result.resultType === "input_required") {
      throw new McpInputRequiredError(this.serverName, method, requestedInputs(result));
    }
    return result;
  }

  private shape(params: Record<string, unknown>): Record<string, unknown> {
    if (this.era === "legacy") return params;
    return { ...params, _meta: requestMeta(this.protocolVersion) };
  }

  private async openLegacy(): Promise<void> {
    this.era = "legacy";
    this.protocolVersion = mcpLegacyProtocolVersion;
    const result = await this.request("initialize", {
      protocolVersion: mcpLegacyProtocolVersion,
      capabilities: {},
      clientInfo,
    });
    if (typeof result.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
    this.serverName = implementationName(result.serverInfo);
    await this.transport.notify("notifications/initialized");
  }

  private adoptDiscovery(result: Record<string, unknown>): void {
    const supported = versionList(result.supportedVersions);
    if (!supported.includes(mcpProtocolVersion)) throw versionMismatch(supported);
    this.serverName = implementationName(asRecord(result._meta)[serverInfoKey]);
    this.listensForToolChanges = asRecord(asRecord(result.capabilities).tools).listChanged === true;
  }

  private announceStaleTools(): void {
    if (this.staleToolsAnnounced || Date.now() < this.toolsFreshUntil) return;
    this.staleToolsAnnounced = true;
    this.onToolsStale();
  }
}

export function signalsToolsChanged(
  message: Record<string, unknown>,
  subscriptionId: number | undefined,
): boolean {
  if (message.method !== "notifications/tools/list_changed") return false;
  return asRecord(asRecord(message.params)._meta)[subscriptionIdKey] === subscriptionId;
}

const clientInfo = { name: "keywork", version: "0.0.1" };
const serverInfoKey = "io.modelcontextprotocol/serverInfo";
const subscriptionIdKey = "io.modelcontextprotocol/subscriptionId";
const unsupportedProtocolVersionCode = -32022;
const modernErrorCodes: ReadonlySet<number> = new Set([-32020, -32021, -32022]);

function requestMeta(protocolVersion: string): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": clientInfo,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function isModernErrorCode(code: number | undefined): boolean {
  return code !== undefined && modernErrorCodes.has(code);
}

function marksLegacyServer(cause: unknown): boolean {
  return cause instanceof McpProtocolError || cause instanceof McpRequestTimeoutError;
}

function modernRefusal(error: McpRpcError): McpProtocolError {
  if (error.code !== unsupportedProtocolVersionCode) return error;
  return versionMismatch(versionList(asRecord(error.data).supported));
}

function versionMismatch(supported: readonly string[]): McpProtocolError {
  const theirs = supported.length > 0 ? supported.join(", ") : "no versions it named";
  return new McpProtocolError(
    `server speaks MCP ${theirs}; keywork speaks ${mcpProtocolVersion} and ${mcpLegacyProtocolVersion}`,
  );
}

function versionList(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

function implementationName(info: unknown): string {
  const name = asRecord(info).name;
  return typeof name === "string" ? name : "unknown";
}

function requestedInputs(result: Record<string, unknown>): string[] {
  return Object.values(asRecord(result.inputRequests))
    .map((entry) => asRecord(entry).method)
    .filter((method): method is string => typeof method === "string");
}
