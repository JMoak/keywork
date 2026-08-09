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
    theme: z
      .record(z.string(), z.string())
      .describe(
        "Theme-token to #rrggbb overrides on the keywork-night palette; exists because wholesale theming is a core product value (Omarchy-style: one token set drives every surface).",
      ),
    apiKeys: z
      .record(z.string(), z.string())
      .describe(
        "Provider-name to API-key map written by `keywork setup`; exists so onboarding is one command with no shell-profile editing. Environment variables take precedence.",
      ),
  })
  .partial()
  .strict();

export type KeyworkConfig = z.infer<typeof configSchema>;

export const defaultConfig: KeyworkConfig = {
  keybindings: {},
};
