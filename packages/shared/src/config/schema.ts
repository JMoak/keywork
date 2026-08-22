import { z } from "zod";

const keybinding = z.union([z.string(), z.array(z.string()), z.literal("none")]);

const themeColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "theme colors must be #rrggbb");

const themeRamp = z
  .array(themeColor)
  .min(1)
  .max(6)
  .describe(
    "Ordered #rrggbb accent stops (1-6) that gradient chrome sweeps perceptually (98/PD8: spawn-rank pane hues, derived focus lift, arc anchors); exists because chromatic depth must be theme-driven rather than hardcoded, and a single stop reproduces today's flat single-accent look exactly.",
  );

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
        "Environment variables handed to the spawned server, typically credentials; treated as secrets: never logged, never echoed in errors, never readable from the project layer.",
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

const modelInputModality = z.enum(["text", "image"]);

const modelCapabilities = z
  .object({
    input: z
      .array(modelInputModality)
      .min(1)
      .describe(
        'Input modalities the model accepts, e.g. ["text", "image"]; exists because capabilities are declarations, never probed: an undeclared model is text-only, and sending an image to it fails fast naming this field.',
      ),
    toolCalls: z
      .boolean()
      .describe(
        "Whether the model supports tool calls; exists so a model that cannot drive the tool loop refuses at request time instead of failing mid-turn. Undeclared models are assumed tool-capable because keywork cannot operate without tools.",
      ),
    contextWindow: z
      .number()
      .int()
      .positive()
      .describe(
        "Declared context ceiling in tokens; exists so budget and compaction decisions read an honest declared limit instead of a probed or guessed one.",
      ),
  })
  .partial()
  .strict();

export const connectionNamePattern = /^[a-z0-9][a-z0-9._-]*$/;

const connectionName = z
  .string()
  .regex(connectionNamePattern, "connection names are lowercase letters, digits, . _ -");

const connectionCredential = z.union([
  z.literal("none"),
  z.literal("saved"),
  z
    .string()
    .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, 'credential must be "none", "saved", or "env:VAR_NAME"'),
]);

const connection = z
  .object({
    endpoint: z
      .url()
      .describe(
        "Base URL of an OpenAI-compatible server, e.g. http://localhost:11434/v1 for a local model or https://gateway.example/v1 for a broker; exists because every local port or gateway is one registration that differs from the built-ins by data alone (105/IR-15). Plain http is accepted only on loopback unless insecureTransport is set (IR-17).",
      ),
    protocol: z
      .enum(["chat-completions", "responses"])
      .describe(
        "Wire protocol the endpoint truthfully speaks; defaults to chat-completions, the compatibility protocol most local servers and brokers implement. Declared, never probed or downgraded (105/IR-08): a mismatch fails naming this field.",
      )
      .optional(),
    credential: connectionCredential
      .describe(
        'Where the bearer credential comes from: "none" (the default on loopback), "saved" (the default elsewhere; the key /connect stored in ~/.keywork/auth.json under this connection name), or "env:VAR_NAME" to read one environment variable; exists so secrets are referenced by handle and never written into this file (105/IR-17).',
      )
      .optional(),
    models: z
      .array(z.string().min(1))
      .describe(
        "Model ids this endpoint serves, as the /model picker should list them; exists because inventory is declared or reported, never guessed (105/IR-10). Capabilities still come from the top-level `models` declarations. An endpoint with no list still accepts any id written as <connection>/<model>.",
      )
      .optional(),
    insecureTransport: z
      .boolean()
      .describe(
        "Permits plain http to a non-loopback endpoint. Credentials and every prompt then cross the network unencrypted and can be read or altered in transit; exists only so a trusted LAN box can be reached deliberately (105/IR-17). Leave unset for anything reachable from the internet.",
      )
      .optional(),
    enabled: z
      .boolean()
      .describe(
        "Set false to keep a connection configured but out of resolution and the /model picker; exists so a box that is down for a while does not have to be deleted and re-entered (105/IR-15).",
      )
      .optional(),
  })
  .strict();

const pageThresholdColumns = z.number().int().min(1);

const permissionAction = z.enum(["allow", "ask", "deny"]);

const permissions = z
  .object({
    tools: z
      .record(z.string(), permissionAction)
      .describe(
        "Tool name (read, write, edit, bash, or any registered tool) to allow | ask | deny; exists so the safety posture is auditable policy instead of scattered flags. Unlisted tools keep the built-in posture: read-only tools allow, mutating tools ask. deny reaches the model as a refused tool result without ever prompting.",
      ),
    bash: z
      .record(z.string(), permissionAction)
      .describe(
        'Glob patterns (`*` wildcard) over the full bash command string to allow | ask | deny, e.g. "git status*": "allow"; exists because asking on every trivially safe command makes the gate unusable. Any matching deny pattern wins outright; otherwise the most specific matching pattern wins (most literal characters; first declared breaks ties). A matched rule overrides tools.bash. A command containing shell chaining characters (; & | < > ` $ ( ) or a newline) can only match deny rules: "git status; rm -rf /" falls through to tools.bash instead of riding an allow rule.',
      ),
  })
  .partial()
  .strict();

export const configSchema = z
  .object({
    model: z
      .string()
      .describe(
        "Provider/model reference for new sessions; exists so a first prompt works with zero ceremony. Honored from the user config layer only; a checked-in project file cannot steer model routing until an explicit trust gate exists.",
      ),
    models: z
      .record(z.string(), modelCapabilities)
      .describe(
        "Model-id glob patterns (`*` wildcard) to declared capabilities; exists because keywork never probes endpoints for what a model can do: capability is declared config (D9), the most specific matching pattern wins, and anything undeclared stays at the text-only floor.",
      ),
    keybindings: z
      .record(z.string(), keybinding)
      .describe(
        'Action-name to chord overrides: a single chord, an array of alternative chords, or the literal "none" to unbind the action; exists because fully rebindable keys are a core product value.',
      ),
    theme: z
      .object({ ramp: themeRamp.optional() })
      .catchall(themeColor)
      .describe(
        "Theme-token to #rrggbb overrides (plus the ramp stop list) on the keywork-night palette; exists because wholesale theming is a core product value (Omarchy-style: one token set drives every surface).",
      ),
    page: z
      .object({
        broadsheetAt: pageThresholdColumns
          .describe(
            "Pane width in columns where the transcript enters the broadsheet tier (full padding, an ~88-column prose measure, the full tonal ladder); exists because the right boundary depends on font and monitor geometry, and 104/PD18 calls for tuning the tiers against real captures.",
          )
          .optional(),
        columnAt: pageThresholdColumns
          .describe(
            "Pane width in columns where the transcript enters the column tier, the working default below broadsheet; exists so the everyday reading tier can be widened or narrowed to taste per setup (104/PD18).",
          )
          .optional(),
        clippingAt: pageThresholdColumns
          .describe(
            "Pane width in columns where the transcript enters the clipping tier; panes narrower than this render the masthead tier instead of an unreadable text slit; exists because the point where a transcript stops being readable varies with font geometry (104/PD18).",
          )
          .optional(),
      })
      .strict()
      .describe(
        "Width-tier thresholds for the transcript page grammar (104/PD18: broadsheet / column / clipping / masthead); exists because tier boundaries are taste calls tuned per terminal setup and must be adjustable without code changes. Thresholds must rise clippingAt < columnAt < broadsheetAt.",
      ),
    connections: z
      .record(connectionName, connection)
      .describe(
        "Named inference connections beyond the built-ins (openrouter, openai, openai-codex, bedrock): each local port or gateway becomes a provider whose models are addressed as <name>/<model>; exists because provider management is one durable surface over data, not a setup flow per vendor (105/IR-15). Written by /connect, hand-editable, honored from the user config layer only.",
      ),
    bedrockRegion: z
      .string()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, "bedrockRegion must look like us-east-1")
      .describe(
        "AWS region for the Bedrock provider when AWS_REGION/AWS_DEFAULT_REGION are unset; exists because Bedrock endpoints are regional and the endpoint is derived from the region alone, so config can never supply a base URL. Honored from the user config layer only.",
      ),
    apiKeys: z
      .record(z.string(), z.string())
      .describe(
        "Legacy provider-name to API-key map from before credentials moved to ~/.keywork/auth.json; still honored so existing setups keep working, but `keywork setup` now writes auth.json, whose entries outrank this map. Saved credentials outrank ambient environment variables; only KEYWORK_-prefixed variables override them. The project config layer is never a credential source.",
      ),
    mcpServers: z
      .record(z.string(), mcpServer)
      .describe(
        "Named MCP server definitions the user mounts globally; exists to feed D8-D10/D14 tool mounting from one validated map (schema only until D8 wires execution). Honored from the user config layer only; a checked-in project file can never register servers or their credentials.",
      ),
    permissions: permissions.describe(
      "Declarative allow | ask | deny policy for tool execution; exists because graduated trust (workstream E) must live in readable config, not code. Honored from the user config layer only; a checked-in project file can never widen permissions.",
    ),
    prompts: prompts.describe(
      "User-scope system-prompt customization: one global prompt plus per-model-pattern overrides; exists because prompt steering is a user preference, not a project artifact. Honored from the user config layer only; a checked-in project file can never inject prompts.",
    ),
  })
  .partial()
  .strict();

export type KeyworkConfig = z.infer<typeof configSchema>;
export type McpServerConfig = z.infer<typeof mcpServer>;
export type PermissionAction = z.infer<typeof permissionAction>;
export type PermissionsConfig = NonNullable<KeyworkConfig["permissions"]>;
export type PromptsConfig = NonNullable<KeyworkConfig["prompts"]>;
export type PromptOverride = z.infer<typeof promptOverride>;
export type ModelCapabilitiesConfig = NonNullable<KeyworkConfig["models"]>;
export type ConnectionConfig = z.infer<typeof connection>;
export type ConnectionsConfig = NonNullable<KeyworkConfig["connections"]>;
export type ConnectionCredentialSource = z.infer<typeof connectionCredential>;
export type ConnectionProtocol = NonNullable<ConnectionConfig["protocol"]>;

export const defaultConfig: KeyworkConfig = {
  keybindings: {},
};
