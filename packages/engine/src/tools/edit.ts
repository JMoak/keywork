import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "./define.ts";

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory."),
  oldText: z.string().min(1).describe("Exact text to replace, including whitespace."),
  newText: z.string().describe("Replacement text."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence instead of exactly one."),
});

export function editTool(cwd: string) {
  return defineTool({
    name: "edit",
    description: "Replace exact text in a file. oldText must match exactly once unless replaceAll.",
    schema,
    run: async ({ path, oldText, newText, replaceAll = false }) => {
      const target = resolve(cwd, path);
      const content = await readFile(target, "utf8");
      const occurrences = countOccurrences(content, oldText);
      if (occurrences === 0) {
        throw new Error(`oldText not found in ${path}; read the file and match it exactly`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `oldText matches ${occurrences} places in ${path}; add surrounding context to make it unique, or set replaceAll`,
        );
      }
      await writeFile(target, content.replaceAll(oldText, newText), "utf8");
      const label = occurrences === 1 ? "1 occurrence" : `${occurrences} occurrences`;
      return `Replaced ${label} in ${path}`;
    },
  });
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  for (let at = content.indexOf(search); at !== -1; at = content.indexOf(search, at + 1)) {
    count += 1;
  }
  return count;
}
