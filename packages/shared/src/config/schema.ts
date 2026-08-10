import { z } from "zod";

// Option policy (vision D9): every new option is a design failure until justified.
// The justification lives in that option's .describe() — no description, no option.

const keybinding = z.union([z.string(), z.array(z.string()), z.literal("none")]);

const themeColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "theme colors must be #rrggbb");

const mcpTrusted = z
  .boolean()
  .describe(
    "Marks results from this server as workspace-trusted so they do not taint the turn (95/P2 taint boundary); exists so secops can whitelist known-good servers in one readable line. Inert until workstream J lands taint tracking.",
  );

const mcpStdioServer = z
  .object({
    transport: z
      .literal("stdio")
      .describe(
        "Runs the server as a local child process speaking MCP over stdio; exists because most MCP servers ship as CLI programs.",
      ),
    command: z
      .string()
      .min(1)
      .describe(
        "Executable that starts the server; exists because a stdio transport has nothing to talk to without one.",
      ),
    args: z
      .array(z.string())
      .describe(
        "Arguments passed to the command; exists because servers take their setup positionally.",
      )
      .optional(),
    env: z
      .record(z.string(), z.string())
      .describe(
        "Environment variables handed to the spawned server, typically credentials; treated as secrets — never logged, never echoed in errors, never readable from the project layer.",
      )
      .optional(),
    trusted: mcpTrusted.optional(),
  })
  .strict();

const mcpHttpServer = z
  .object({
    transport: z
      .literal("http")
      .describe(
        "Connects to a server already running at a URL; exists because shared team servers are reached over HTTP rather than spawned locally.",
      ),
    url: z
      .url()
      .describe("Endpoint the server listens on; exists because HTTP transport needs an address."),
    trusted: mcpTrusted.optional(),
  })
  .strict();

const mcpServer = z.discriminatedUnion("transport", [mcpStdioServer, mcpHttpServer]);

const promptOverride = z
  .object({
    prompt: z
      .string()
      .describe(
        "Text applied when this entry's pattern matches the session's model id; exists because model families respond to different steering.",
      ),
    mode: z
      .enum(["append", "replace"])
      .describe(
        "How the override combines with prompts.system: append places it after the global prompt, replace substitutes for the global prompt. The base keywork prompt and project instructions are never displaced.",
      ),
  })
  .strict();

const prompts = z
  .object({
    system: z
      .string()
      .describe(
        "Global system prompt added after the base keywork prompt and any project instructions, for every model; exists so standing preferences apply everywhere without per-project duplication.",
      ),
    models: z
      .record(z.string(), promptOverride)
      .describe(
        'Model-id glob patterns (`*` wildcard, e.g. "gpt-5*") to overrides. Exactly one entry applies per session: the most specific match wins (most literal characters; first declared breaks ties). Final assembly order: base keywork prompt → project instructions → prompts.system → the winning override, where replace mode swaps out prompts.system only.',
      ),
  })
  .partial()
  .strict();

export const configSchema = z
  .object({
    model: z
      .string()
      .describe(
        "Provider/model reference for new sessions; exists so a first prompt works with zero ceremony. Honored from the user config layer only — a checked-in project file cannot steer model routing until an explicit trust gate exists.",
      ),
    keybindings: z
      .record(z.string(), keybinding)
      .describe(
        "Action-name to chord overrides; exists because fully rebindable keys are a core product value.",
      ),
    theme: z
      .record(z.string(), themeColor)
      .describe(
        "Theme-token to #rrggbb overrides on the keywork-night palette; exists because wholesale theming is a core product value (Omarchy-style: one token set drives every surface).",
      ),
    apiKeys: z
      .record(z.string(), z.string())
      .describe(
        "Provider-name to API-key map written by `keywork setup`; exists so onboarding is one command with no shell-profile editing. Environment variables take precedence, and the project config layer is never a credential source.",
      ),
    mcpServers: z
      .record(z.string(), mcpServer)
      .describe(
        "Named MCP server definitions the user mounts globally; exists to feed D8–D10/D14 tool mounting from one validated map (schema only until D8 wires execution). Honored from the user config layer only — a checked-in project file can never register servers or their credentials.",
      ),
    prompts: prompts.describe(
      "User-scope system-prompt customization: one global prompt plus per-model-pattern overrides; exists because prompt steering is a user preference, not a project artifact. Honored from the user config layer only — a checked-in project file can never inject prompts.",
    ),
  })
  .partial()
  .strict();

export type KeyworkConfig = z.infer<typeof configSchema>;
export type McpServerConfig = z.infer<typeof mcpServer>;
export type PromptsConfig = NonNullable<KeyworkConfig["prompts"]>;
export type PromptOverride = z.infer<typeof promptOverride>;

export const defaultConfig: KeyworkConfig = {
  keybindings: {},
};
