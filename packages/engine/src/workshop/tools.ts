import { countOccurrences } from "@keywork/shared";
import { z } from "zod";
import { defineTool } from "../tools/define.ts";
import type { Tool } from "../tools.ts";
import type { Exit, Workshop, WorkshopSubstrate } from "./substrate.ts";

export type WorkshopReadiness = () => Promise<string | undefined>;

export function workshopTools(
  substrate: WorkshopSubstrate,
  workshop: Workshop,
  ready: WorkshopReadiness = async () => undefined,
): Tool[] {
  const files = substrate.files(workshop);
  return [
    defineTool({
      name: "read",
      description: "Read a text file inside this creature's workshop, returning numbered lines.",
      schema: z.object({
        path: z.string().describe("File path, absolute or relative to the workshop's workdir."),
        offset: z.number().int().min(1).optional().describe("First line to read (1-based)."),
        limit: z.number().int().min(1).optional().describe("Maximum number of lines to return."),
      }),
      run: ({ path, offset = 1, limit = 2_000 }) =>
        whenReady(ready, async () => numberedLines(await files.read(path), offset, limit)),
    }),
    defineTool({
      name: "write",
      description: "Create or overwrite a file inside this creature's workshop.",
      schema: z.object({
        path: z.string().describe("File path, absolute or relative to the workshop's workdir."),
        content: z.string().describe("Full file content to write."),
      }),
      mutates: true,
      run: ({ path, content }) =>
        whenReady(ready, async () => {
          await files.write(path, content);
          return `Wrote ${path}`;
        }),
    }),
    defineTool({
      name: "edit",
      description:
        "Replace exact text in a workshop file. oldText must match once unless replaceAll.",
      schema: z.object({
        path: z.string().describe("File path, absolute or relative to the workshop's workdir."),
        oldText: z.string().min(1).describe("Exact text to replace, including whitespace."),
        newText: z.string().describe("Replacement text."),
        replaceAll: z.boolean().optional().describe("Replace every occurrence instead of one."),
      }),
      mutates: true,
      run: ({ path, oldText, newText, replaceAll = false }) =>
        whenReady(ready, async () => {
          const before = await files.read(path);
          const occurrences = countOccurrences(before, oldText);
          if (occurrences === 0) throw new Error(`oldText not found in ${path}`);
          if (occurrences > 1 && !replaceAll) {
            throw new Error(`oldText matches ${occurrences} places in ${path}; set replaceAll`);
          }
          await files.write(path, before.split(oldText).join(newText));
          return `Replaced ${occurrences === 1 ? "1 occurrence" : `${occurrences} occurrences`} in ${path}`;
        }),
    }),
    defineTool({
      name: "bash",
      description: "Run a shell command inside this creature's workshop, from its workdir.",
      schema: z.object({
        command: z.string().min(1).describe("Shell command to execute."),
        timeoutMs: z.number().int().min(1).optional().describe("Kill the command after this long."),
      }),
      mutates: true,
      run: ({ command, timeoutMs }) =>
        whenReady(ready, async () =>
          renderedExit(
            await substrate.exec(workshop, {
              run: command,
              ...(timeoutMs !== undefined && { timeoutMs }),
            }),
          ),
        ),
    }),
  ];
}

async function whenReady(ready: WorkshopReadiness, act: () => Promise<string>): Promise<string> {
  const notice = await ready();
  const output = await act();
  return notice === undefined
    ? output
    : `${notice}
${output}`;
}

function numberedLines(content: string, offset: number, limit: number): string {
  const lines = content.split(/\r?\n/);
  return lines
    .slice(offset - 1, offset - 1 + limit)
    .map((line, index) => `${String(offset + index).padStart(5)}\t${line}`)
    .join("\n");
}

function renderedExit(exit: Exit): string {
  const output = [exit.stdout, exit.stderr].filter((text) => text !== "").join("");
  if (exit.timedOut) return `${output}\n(timed out)`;
  return exit.code === 0 ? output : `${output}\n(exit ${exit.code})`;
}
