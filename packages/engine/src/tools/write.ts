import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { annotatedResult } from "./after-save.ts";
import type { ToolScope } from "./confine.ts";
import { defineTool } from "./define.ts";
import { type FileToolOptions, proposeVaultNote, writeTarget } from "./protected-writes.ts";

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory."),
  content: z.string().describe("Full file content to write."),
});

export function writeTool(scope: ToolScope, options: FileToolOptions = {}) {
  return defineTool({
    name: "write",
    description: "Create or overwrite a file, creating parent directories as needed.",
    schema,
    mutates: true,
    run: async ({ path, content }, signal) => {
      const target = writeTarget(scope, path, options.vault);
      if (target.kind === "vault-note")
        return proposeVaultNote(target, content, path, options.origin, options.session);
      await mkdir(dirname(target.path), { recursive: true });
      await writeFile(target.path, content, "utf8");
      return annotatedResult(
        `Wrote ${content.length} characters to ${path}`,
        options.afterSave,
        target.path,
        signal,
      );
    },
  });
}
