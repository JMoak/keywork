import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { confinedPath, type ToolScope } from "./confine.ts";
import { defineTool } from "./define.ts";

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory."),
  content: z.string().describe("Full file content to write."),
});

export function writeTool(scope: string | ToolScope, onSaved?: (path: string) => void) {
  return defineTool({
    name: "write",
    description: "Create or overwrite a file, creating parent directories as needed.",
    schema,
    mutates: true,
    run: async ({ path, content }) => {
      const target = confinedPath(scope, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      onSaved?.(target);
      return `Wrote ${content.length} characters to ${path}`;
    },
  });
}
