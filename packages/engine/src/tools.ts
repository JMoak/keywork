import type { ToolDefinition } from "./provider.ts";

export interface Tool extends ToolDefinition {
  mutates?: boolean;
  execute(args: unknown, signal?: AbortSignal): Promise<string>;
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = "ToolNotFoundError";
  }
}

export function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new ToolNotFoundError(name);
  return tool;
}
