import { z } from "zod";
import type { Tool, ToolPreview } from "../tools.ts";

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: Schema;
  mutates?: boolean;
  run(args: z.infer<Schema>, signal?: AbortSignal): Promise<string>;
  preview?(args: z.infer<Schema>): Promise<ToolPreview | undefined>;
}): Tool {
  const { preview } = options;
  return {
    name: options.name,
    description: options.description,
    parameters: z.toJSONSchema(options.schema),
    ...(options.mutates !== undefined && { mutates: options.mutates }),
    execute: async (args, signal) => options.run(options.schema.parse(args), signal),
    ...(preview !== undefined && {
      preview: async (args) => {
        const parsed = options.schema.safeParse(args);
        return parsed.success ? preview(parsed.data) : undefined;
      },
    }),
  };
}
