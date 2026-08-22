import { z } from "zod";
import type { Tool } from "../tools.ts";
import type { McpTool } from "./client.ts";

export const mcpSearchToolName = "mcp_tool_search";

export interface CatalogEntry {
  qualified: string;
  tool: McpTool;
}

export interface ToolSearchOptions {
  catalog: () => readonly CatalogEntry[];
  activate: (qualifiedNames: readonly string[]) => void;
}

export function mcpToolSearch({ catalog, activate }: ToolSearchOptions): Tool {
  return {
    name: mcpSearchToolName,
    get description() {
      return searchDescription(catalog());
    },
    parameters: z.toJSONSchema(searchArguments),
    execute: async (args) => {
      const matched = selectEntries(catalog(), searchArguments.parse(args));
      activate(matched.map((entry) => entry.qualified));
      return renderSchemas(matched);
    },
  };
}

const searchArguments = z.object({
  tools: z.array(z.string()).optional(),
  query: z.string().optional(),
});

type SearchArguments = z.infer<typeof searchArguments>;

function searchDescription(entries: readonly CatalogEntry[]): string {
  const lines = entries.map((entry) => `${entry.qualified}: ${oneLiner(entry.tool.description)}`);
  const roster = lines.length > 0 ? lines.join("\n") : "(no connected servers)";
  return `Fetches full schemas for MCP tools so they become directly callable. Pass exact tool names or a search query.\nAvailable:\n${roster}`;
}

function selectEntries(entries: readonly CatalogEntry[], args: SearchArguments): CatalogEntry[] {
  const matched = new Map<string, CatalogEntry>();
  const missing: string[] = [];
  for (const name of args.tools ?? []) {
    const entry = entries.find((candidate) => candidate.qualified === name);
    if (entry === undefined) missing.push(name);
    else matched.set(entry.qualified, entry);
  }
  if (missing.length > 0) {
    throw new Error(`unknown MCP tools: ${missing.join(", ")}. ${availableSummary(entries)}`);
  }
  if (args.query !== undefined) {
    for (const entry of entries) {
      if (matchesQuery(entry, args.query)) matched.set(entry.qualified, entry);
    }
  }
  if (matched.size === 0) throw new Error(`no MCP tools matched. ${availableSummary(entries)}`);
  return [...matched.values()];
}

function renderSchemas(entries: readonly CatalogEntry[]): string {
  const schemas = entries.map((entry) => ({
    name: entry.qualified,
    description: entry.tool.description,
    parameters: entry.tool.inputSchema,
  }));
  return `${JSON.stringify(schemas, null, 2)}\nThese tools are now directly callable.`;
}

function oneLiner(description: string): string {
  const firstLine = description.split("\n", 1)[0] ?? "";
  const sentenceEnd = firstLine.indexOf(". ");
  const sentence = sentenceEnd === -1 ? firstLine : firstLine.slice(0, sentenceEnd + 1);
  return sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence;
}

function matchesQuery(entry: CatalogEntry, query: string): boolean {
  const haystack = `${entry.qualified} ${entry.tool.description}`.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function availableSummary(entries: readonly CatalogEntry[]): string {
  if (entries.length === 0) return "No MCP tools are available.";
  return `Available: ${entries.map((entry) => entry.qualified).join(", ")}`;
}
