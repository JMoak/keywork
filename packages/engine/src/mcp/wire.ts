import type { McpTool, McpToolResult } from "./client.ts";

export const mcpProtocolVersion = "2025-06-18";

export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export type WireRequest = (method: string, params: unknown) => Promise<unknown>;

export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: mcpProtocolVersion,
    capabilities: {},
    clientInfo: { name: "keywork", version: "0.0.1" },
  };
}

export function readServerName(initializeResult: Record<string, unknown>): string {
  const info = asRecord(initializeResult.serverInfo);
  return typeof info.name === "string" ? info.name : "unknown";
}

export async function collectToolPages(request: WireRequest): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = asRecord(await request("tools/list", cursor === undefined ? {} : { cursor }));
    for (const entry of asArray(page.tools)) tools.push(listedTool(entry));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return tools;
}

export function toolCallResult(result: Record<string, unknown>): McpToolResult {
  return { text: renderContent(result.content), isError: result.isError === true };
}

export function listedTool(entry: unknown): McpTool {
  const record = asRecord(entry);
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new McpProtocolError("server listed a tool without a name");
  }
  return {
    name: record.name,
    description: typeof record.description === "string" ? record.description : "",
    inputSchema: asRecord(record.inputSchema ?? { type: "object" }),
  };
}

export function renderContent(content: unknown): string {
  return asArray(content)
    .map((block) => {
      const record = asRecord(block);
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return JSON.stringify(record);
    })
    .join("\n");
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
