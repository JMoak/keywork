import { readFile, writeFile } from "node:fs/promises";
import { countOccurrences, toUnixEol } from "@keywork/shared";
import { z } from "zod";
import { annotatedResult } from "./after-save.ts";
import type { ToolScope } from "./confine.ts";
import { defineTool } from "./define.ts";
import { type FileToolOptions, proposeVaultNote, writeTarget } from "./protected-writes.ts";

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory."),
  oldText: z.string().min(1).describe("Exact text to replace, including whitespace."),
  newText: z.string().describe("Replacement text."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence instead of exactly one."),
});

type EditRequest = z.infer<typeof schema>;

interface Replacement {
  content: string;
  occurrences: number;
}

export function editTool(scope: ToolScope, options: FileToolOptions = {}) {
  return defineTool({
    name: "edit",
    description: "Replace exact text in a file. oldText must match exactly once unless replaceAll.",
    schema,
    mutates: true,
    run: async (request, signal) => {
      const target = writeTarget(scope, request.path, options.vault);
      const raw = await readFile(target.path, "utf8");
      const { content, occurrences } = replaced(raw, request);
      if (target.kind === "vault-note")
        return proposeVaultNote(target, content, request.path, options.origin, options.session);
      await writeFile(target.path, content, "utf8");
      const label = occurrences === 1 ? "1 occurrence" : `${occurrences} occurrences`;
      return annotatedResult(
        `Replaced ${label} in ${request.path}`,
        options.afterSave,
        target.path,
        signal,
      );
    },
  });
}

function replaced(
  raw: string,
  { path, oldText, newText, replaceAll = false }: EditRequest,
): Replacement {
  const crlf = raw.includes("\r\n");
  const content = toUnixEol(raw);
  const search = toUnixEol(oldText);
  const occurrences = countOccurrences(content, search);
  if (occurrences === 0) {
    throw new Error(`oldText not found in ${path}; read the file and match it exactly`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `oldText matches ${occurrences} places in ${path}; add surrounding context to make it unique, or set replaceAll`,
    );
  }
  const edited = content.replaceAll(search, toUnixEol(newText));
  return { content: crlf ? edited.replaceAll("\n", "\r\n") : edited, occurrences };
}
