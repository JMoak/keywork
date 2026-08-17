import { readFile } from "node:fs/promises";
import { z } from "zod";
import { confinedPath, type ToolScope } from "./confine.ts";
import { defineTool } from "./define.ts";

const defaultLineLimit = 2000;

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory."),
  offset: z.number().int().min(1).optional().describe("First line to read (1-based)."),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to return."),
});

export function readTool(scope: string | ToolScope) {
  return defineTool({
    name: "read",
    description: "Read a text file, returning numbered lines.",
    schema,
    run: async ({ path, offset = 1, limit = defaultLineLimit }) => {
      const content = await readFile(confinedPath(scope, path), "utf8");
      if (content.includes("\u0000")) return `${path} is a binary file`;
      return numberedSlice(content, offset, limit);
    },
  });
}

function numberedSlice(content: string, offset: number, limit: number): string {
  const lines = content.split(/\r?\n/);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((line, index) => `${String(offset + index).padStart(5)}\t${line}`)
    .join("\n");
  const remaining = lines.length - (offset - 1 + slice.length);
  return remaining > 0 ? `${numbered}\n... (${remaining} more lines)` : numbered;
}
