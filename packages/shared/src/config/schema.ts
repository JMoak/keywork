import { z } from "zod";

// Option policy (vision D9): every new option is a design failure until justified.
// The justification lives in that option's .describe() — no description, no option.

const keybinding = z.union([z.string(), z.array(z.string()), z.literal("none")]);

export const configSchema = z
  .object({
    model: z
      .string()
      .describe(
        "Provider/model reference for new sessions; exists so a first prompt works with zero ceremony.",
      ),
    keybindings: z
      .record(z.string(), keybinding)
      .describe(
        "Action-name to chord overrides; exists because fully rebindable keys are a core product value.",
      ),
  })
  .partial()
  .strict();

export type KeyworkConfig = z.infer<typeof configSchema>;

export const defaultConfig: KeyworkConfig = {
  keybindings: {},
};
