import type { McpTool, McpToolResult } from "./client.ts";
import { McpProtocolError } from "./errors.ts";

export type WireRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ToolListing {
  tools: McpTool[];
  freshUntil: number;
}

export async function collectToolPages(request: WireRequest): Promise<ToolListing> {
  const tools: McpTool[] = [];
  let freshUntil = Number.POSITIVE_INFINITY;
  let cursor: string | undefined;
  do {
    const page = await request("tools/list", cursor === undefined ? {} : { cursor });
    freshUntil = Math.min(freshUntil, Date.now() + freshnessMs(page.ttlMs));
    for (const entry of asArray(page.tools)) tools.push(listedTool(entry));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return { tools, freshUntil };
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

function freshnessMs(ttlMs: unknown): number {
  return typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : 0;
}
