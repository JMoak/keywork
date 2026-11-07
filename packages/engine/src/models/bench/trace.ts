import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type Message, textMessage } from "../../messages.ts";
import type { ToolDefinition } from "../../provider.ts";

export interface BenchTrace {
  name: string;
  tools: readonly ToolDefinition[];
  turns: readonly BenchTurn[];
}

export interface BenchTurn {
  id: string;
  systemPrompt: string;
  messages: readonly Message[];
  expected: readonly ExpectedCall[];
}

export interface ExpectedCall {
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}

export const defaultTracePath = fileURLToPath(new URL("./fixtures/trace.json", import.meta.url));

export async function readBenchTrace(path = defaultTracePath): Promise<BenchTrace> {
  return traceFrom(JSON.parse(await readFile(path, "utf8")));
}

export function traceFrom(json: unknown): BenchTrace {
  const parsed = traceSchema.parse(json);
  return {
    name: parsed.name,
    tools: parsed.tools,
    turns: parsed.turns.map((turn) => ({
      id: turn.id,
      systemPrompt: turn.systemPrompt ?? parsed.systemPrompt,
      messages: turn.messages.map(({ role, text }) => textMessage(role, text)),
      expected: turn.expected,
    })),
  };
}

const traceSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string(),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      parameters: z.record(z.string(), z.unknown()),
    }),
  ),
  turns: z
    .array(
      z.object({
        id: z.string().min(1),
        systemPrompt: z.string().optional(),
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }))
          .min(1),
        expected: z.array(
          z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }),
        ),
      }),
    )
    .min(1),
});
