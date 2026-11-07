import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { LabelledDecision } from "./run.ts";

export const defaultLabelledPath = fileURLToPath(
  new URL("./fixtures/decisions.json", import.meta.url),
);

export async function readLabelledDecisions(
  path = defaultLabelledPath,
): Promise<LabelledDecision[]> {
  return labelledFrom(JSON.parse(await readFile(path, "utf8")));
}

export function labelledFrom(json: unknown): LabelledDecision[] {
  const parsed = labelledSchema.parse(json);
  return parsed.rows.map((row) => ({
    id: row.id,
    state: row.state,
    question: {
      type: "noul",
      instructions: parsed.question.instructions,
      criteria: parsed.question.criteria,
    },
    label: row.label,
  }));
}

const labelledSchema = z.object({
  question: z.object({
    instructions: z.string().min(1),
    criteria: z.object({ true: z.string(), false: z.string() }),
  }),
  rows: z
    .array(
      z.object({
        id: z.string().min(1),
        state: z.union([z.string(), z.record(z.string(), z.json())]),
        label: z.boolean(),
      }),
    )
    .min(1),
});
