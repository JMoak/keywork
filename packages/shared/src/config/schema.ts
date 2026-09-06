import { z } from "zod";
import { flavorTokenOverridesSchema } from "./flavor.ts";

const keybinding = z.union([z.string(), z.array(z.string()), z.literal("none")]);

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
    headers: z
      .record(z.string(), z.string())
      .describe(
        "Static HTTP headers sent verbatim on every request to the server, typically Authorization; treated as secrets: never logged, never echoed in errors, never readable from the project layer. Static values only; keywork runs no OAuth flow of any kind.",
      )
      .optional(),
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

export const connectionProtocols = ["chat-completions", "responses", "anthropic-messages"] as const;

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
      .enum(connectionProtocols)
      .describe(
        "Wire protocol the endpoint truthfully speaks; defaults to chat-completions, the compatibility protocol most local servers and brokers implement, with responses for OpenAI's newer surface and anthropic-messages for the Claude Messages API or a proxy of it. Declared, never probed or downgraded (105/IR-08): a mismatch fails naming this field.",
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
        'Glob patterns (`*` wildcard) over the full bash command string to allow | ask | deny, e.g. "git status*": "allow"; exists because asking on every trivially safe command makes the gate unusable. `*` spans newlines too, so a line break inside a command cannot dodge a pattern. Any matching deny pattern wins outright; otherwise the most specific matching pattern wins (most literal characters; first declared breaks ties). A matched rule overrides tools.bash. A command containing shell chaining characters (; & | < > ` $ ( ) or a newline) can only match deny rules: "git status; rm -rf /" falls through to tools.bash instead of riding an allow rule.',
      ),
  })
  .partial()
  .strict();

const languageServerSpec = z
  .object({
    command: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Server command and arguments, resolved on PATH only; exists because the user, not keywork, installs language servers and keywork never downloads or resolves one through a package manager.",
      ),
    extensions: z
      .array(z.string().regex(/^.[A-Za-z0-9]+$/, "extensions look like .ts"))
      .min(1)
      .describe(
        "File extensions this server owns; exists because detection is per language and the table is the only map from a touched file to a server.",
      ),
    initialization: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "initializationOptions handed to the server in initialize; exists because some servers take their settings only there. Never a place for credentials: values travel to a local process, not to keywork.",
      ),
  })
  .strict();

export const configSchema = z
  .object({
    model: z
      .string()
      .describe(
        "Provider/model reference for new sessions; exists so a first prompt works with zero ceremony. Honored from the user config layer only; a checked-in project file cannot steer model routing until an explicit trust gate exists.",
      ),
    roles: z
      .record(z.string(), z.string().min(1))
      .describe(
        'Named auxiliary roles (105/IR-14) to provider/model references, e.g. {"closing": "openrouter/gpt-5-mini"}: background inference such as the arc-closing distiller resolves its model here first and falls back to the session\'s provider when the role is unset; exists so cheap auxiliary work can run on a cheaper model without touching session routing. Honored from the user config layer only.',
      ),
    models: z
      .record(z.string(), modelCapabilities)
      .describe(
        "Model-id glob patterns (`*` wildcard) to declared capabilities; exists because keywork never probes endpoints for what a model can do: capability is declared config (D9), the most specific matching pattern wins, and anything undeclared stays at the text-only floor.",
      ),
    repoMap: z
      .enum(["auto", "off"])
      .describe(
        "Repo map injection switch (F2/F3): auto builds a ranked file-and-symbol map of the trusted workspace at session start and injects it into the system prompt within a small budget carved from the declared context window, refreshing after tool writes; off skips the scan and the injection entirely; exists because the map spends prompt tokens on every turn and some workspaces or tastes want none of that.",
      ),
    lsp: z
      .union([z.enum(["off", "auto"]), z.record(z.string(), languageServerSpec)])
      .describe(
        "Language-server switch (114/F4): off spawns nothing; auto spawns the built-in server for a language the first time a tool edits one of its files, if the server's command is on PATH, and appends that file's diagnostics to the edit result; a table replaces or extends the built-ins per language ({ command, extensions, initialization }). Exists because a language server is a user-installed process with real memory and startup cost, so the decision to run one belongs to the user, and because the built-in table cannot know every project's server. Honored from the user config layer only; a checked-in project file can never pick the server.",
      ),
    pointer: z
      .enum(["on", "off"])
      .describe(
        "Mouse capture switch; off skips SGR mouse reporting entirely so the terminal's native text selection and scrollback keep working; exists because some terminals and tmux setups report mouse events badly, and turning capture off must cost zero (94/H6).",
      ),
    masthead: z
      .enum(["on", "off"])
      .describe(
        "Block-glyph masthead switch for narrow unfocused idle panes; off renders the plain transcript with its title row instead; exists because the ceremony cannot earn its rows in every terminal or for every taste (104/C63, 113/C74).",
      ),
    motion: z
      .enum(["full", "reduced"])
      .describe(
        "Motion floor; reduced renders every animation's final frame immediately with no intermediate steps; exists because reduced motion is the grammar's floor and must be reachable as declared config, never sniffed (100/PD16).",
      ),
    thinking: z
      .enum(["on", "off"])
      .describe(
        "Visible reasoning switch (70/G4): on asks the model for its reasoning text where the protocol offers it (Anthropic thinking, Responses reasoning summaries) and shows it as a folded thinking part in the conversation; off, the default, leaves requests exactly as they are today; exists because reasoning text costs tokens and screen space and is valued by some and noise to others. /thinking toggles it per session.",
      ),
    tips: z
      .enum(["on", "off"])
      .describe(
        "Rotating one-line tips in the status bar keyed to features the workspace has not used yet; off removes them entirely; exists as the kill switch FR5.15 requires so guidance can never become noise.",
      ),
    scrim: z
      .enum(["on", "off"])
      .describe(
        "Translucent scrim behind overlays such as the palette, pushing the workspace back while the overlay is up; exists because depth cues are taste and 100/C51 makes them opt-in; unset keeps today's render untouched.",
      ),
    dim: z
      .enum(["on", "off"])
      .describe(
        "Unfocused-pane dimming: on steps every unfocused pane's content ink one subtle luminance step toward the ground so the focused page reads first; exists because depth cues are taste and 100/C51 makes them opt-in; unset keeps today's render untouched, and monochrome terminals see no change because focus never rides color alone.",
      ),
    keybindings: z
      .record(z.string(), keybinding)
      .describe(
        'Action-name to chord overrides: a single chord, an array of alternative chords, or the literal "none" to unbind the action; exists because fully rebindable keys are a core product value.',
      ),
    theme: flavorTokenOverridesSchema.describe(
      "Token-by-token #rrggbb overrides (plus the 1-6 stop ramp) laid over the keywork-night palette and checked against the flavor token schema, so a misspelled token or malformed color fails at config load; exists because wholesale theming is a core product value (Omarchy-style: one token set drives every surface).",
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
export type LanguageServerConfig = z.infer<typeof languageServerSpec>;
export type LspConfig = NonNullable<KeyworkConfig["lsp"]>;
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
