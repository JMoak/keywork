import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { confinedPath } from "./confine.ts";
import { defineTool } from "./define.ts";

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory."),
  content: z.string().describe("Full file content to write."),
});

export function writeTool(cwd: string) {
  return defineTool({
    name: "write",
    description: "Create or overwrite a file, creating parent directories as needed.",
    schema,
    mutates: true,
    run: async ({ path, content }) => {
      const target = confinedPath(cwd, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return `Wrote ${content.length} characters to ${path}`;
    },
  });
}
