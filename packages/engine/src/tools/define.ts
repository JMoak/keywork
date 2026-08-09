import { z } from "zod";
import type { Tool } from "../tools.ts";

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: Schema;
  run(args: z.infer<Schema>, signal?: AbortSignal): Promise<string>;
}): Tool {
  return {
    name: options.name,
    description: options.description,
    parameters: z.toJSONSchema(options.schema),
    execute: (args, signal) => options.run(options.schema.parse(args), signal),
  };
}
