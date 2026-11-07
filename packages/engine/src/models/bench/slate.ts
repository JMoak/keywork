import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const previewDays = 30;

export const defaultSlatePath = fileURLToPath(
  new URL("../../../../../models/slate.json", import.meta.url),
);

const modelClass = z.enum(["strong", "loop", "decide", "vision"]);

const slateModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  roles: z
    .array(z.object({ class: modelClass, role: z.string().min(1), pick: z.boolean() }))
    .min(1),
  license: z.object({
    id: z.string().min(1),
    acknowledgement: z.enum(["none", "required"]),
  }),
  released: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/)
    .nullable(),
  preview: z.boolean(),
  parameters: z.object({ total: z.string().nullable(), active: z.string().nullable() }),
  memoryQ4: z.string().nullable(),
  contextTokens: z.number().int().positive().nullable(),
  bestMeasuredDecode: z.string().nullable(),
  evidence: z.string(),
  notes: z.array(z.string()).optional(),
});

export const slateSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().min(1),
  models: z.array(slateModelSchema).min(1),
});

export type Slate = z.infer<typeof slateSchema>;

export type SlateModel = z.infer<typeof slateModelSchema>;

export async function readSlate(path = defaultSlatePath): Promise<Slate> {
  return slateSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function releasedWithinPreview(model: SlateModel, asOf: string): boolean {
  if (model.released === null || model.released.length < 10) return false;
  const ageDays = (Date.parse(asOf) - Date.parse(model.released)) / 86_400_000;
  return ageDays >= 0 && ageDays < previewDays;
}

export function picksFor(slate: Slate, modelClass: SlateModel["roles"][number]["class"]) {
  return slate.models.filter((model) =>
    model.roles.some((role) => role.class === modelClass && role.pick),
  );
}
