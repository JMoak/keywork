import type { BotDraft } from "../host.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
  slugOrNullOf,
  workspaceSlugParam,
} from "./family.ts";

const slug = { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" } as const;

const enabledBody: JsonSchema = {
  type: "object",
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
  additionalProperties: false,
};

const newArcBody: JsonSchema = {
  type: "object",
  properties: { slug },
  additionalProperties: false,
};

const closeArcBody: JsonSchema = {
  type: "object",
  properties: { direction: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const slugOrNullBody: JsonSchema = {
  type: "object",
  required: ["slug"],
  properties: { slug: { oneOf: [slug, { type: "null" }] } },
  additionalProperties: false,
};

const newBotBody: JsonSchema = {
  type: "object",
  required: ["slug", "scope"],
  properties: {
    slug,
    scope: { type: "string", enum: ["project", "user"] },
    purpose: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const newWorkspaceBody: JsonSchema = {
  type: "object",
  required: ["slug"],
  properties: { slug },
  additionalProperties: false,
};

const dirBody: JsonSchema = {
  type: "object",
  required: ["dir"],
  properties: { dir: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const trustRefused =
  "403 when the workspace is not trusted and declared; the message says what to run.";

export const statusRoutes = [
  {
    method: "GET",
    path: "/mcp",
    operationId: "listMcpServers",
    summary:
      'Every configured MCP server with its live status: `state` (`connected`, `connecting`, `down`), whether it is `enabled`, its `toolCount`, `transport`, and the `lastError` when it is down. A `surface.changed { kind: "mcp" }` event fires on /events whenever any of this changes.',
    authenticated: true,
    responses: { "200": "The servers." },
  },
  {
    method: "POST",
    path: "/mcp/{name}/restart",
    operationId: "restartMcpServer",
    summary: "Drop the server's connection and reconnect from scratch, then answer its new status.",
    authenticated: true,
    responses: {
      "200": "The server's status after the restart settled.",
      "404": "No server has that name.",
    },
  },
  {
    method: "POST",
    path: "/mcp/{name}/enabled",
    operationId: "setMcpServerEnabled",
    summary:
      "Enable or disable a server for this process. A disabled server is disconnected and its tools leave the agent's surface until it is enabled again.",
    authenticated: true,
    requestBody: enabledBody,
    responses: {
      "200": "The server's status after the change settled.",
      "400": "The body is not `{ enabled: boolean }`.",
      "404": "No server has that name.",
    },
  },
  {
    method: "GET",
    path: "/mcp/{name}/tools",
    operationId: "listMcpServerTools",
    summary: "The names of the tools the server currently advertises; empty while it is down.",
    authenticated: true,
    responses: { "200": "The tool names.", "404": "No server has that name." },
  },
  {
    method: "GET",
    path: "/arcs",
    operationId: "listArcs",
    summary:
      "Every arc in the workspace vault with its status (`active`, `archived`), creation time and bound session count, plus `ordinals`: each slug's rank by creation, which is what the terminal colors an arc by. Arcs live in memory, so they need a trusted, declared workspace.",
    authenticated: true,
    responses: { "200": "The arcs.", "403": trustRefused },
  },
  {
    method: "POST",
    path: "/arcs",
    operationId: "createArc",
    summary:
      "Open a new arc. Without `slug` the server picks the next free `arc-<n>`. The new arc is not bound to any session; POST /sessions/{id}/arc does that.",
    authenticated: true,
    requestBody: newArcBody,
    responses: {
      "201": "The new arc.",
      "400": "The slug is not lowercase letters, digits and inner hyphens.",
      "403": trustRefused,
      "409": "An arc with that slug already exists.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/close",
    operationId: "closeArc",
    summary:
      'Close an arc through the airlock: bound live sessions flush their memory, the arc\'s notes are reviewed for delivery to the workspace layer, and the arc archives when nothing needs a decision. `kind: "pending"` means notes or open questions wait for triage in the memory surface; `direction` steers the closing review.',
    authenticated: true,
    requestBody: closeArcBody,
    responses: {
      "200": "The close outcome: `closed` with counts, or `pending` with what waits.",
      "403": trustRefused,
      "404": "No arc has that slug.",
      "409": "The arc is already archived.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/abandon",
    operationId: "abandonArc",
    summary: "Archive an arc without distilling anything; its bound sessions are released.",
    authenticated: true,
    responses: {
      "200": "The arc is archived.",
      "403": trustRefused,
      "404": "No arc has that slug.",
      "409": "The arc is already archived.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/arc",
    operationId: "bindSessionArc",
    summary:
      "Bind the session to an active arc, or release it with `slug: null`. The binding is appended to the session's own record, so it survives a restart.",
    authenticated: true,
    requestBody: slugOrNullBody,
    responses: {
      "200": "The session's arc binding.",
      "400": "The body is not `{ slug: string | null }`.",
      "403": trustRefused,
      "404": "No session has that id, or no arc has that slug.",
      "409": "The arc is archived.",
    },
  },
  {
    method: "GET",
    path: "/bots",
    operationId: "listBots",
    summary:
      "Every bot defined for this user and, once the workspace is trusted, this project: name, sigil, source, description, pinned model, learning level, and how many sessions have run under it with their last use and known spend.",
    authenticated: true,
    responses: { "200": "The bots." },
  },
  {
    method: "POST",
    path: "/bots",
    operationId: "createBot",
    summary:
      "Define a bot at `.keywork/bots/<slug>/bot.md` under the project (needs trust) or the user's home.",
    authenticated: true,
    requestBody: newBotBody,
    responses: {
      "201": "The new bot.",
      "400":
        "The body is not `{ slug, scope, purpose? }` with a slug of lowercase letters, digits and inner hyphens.",
      "403": "A project bot needs a trusted workspace.",
      "409": "A bot with that name already exists.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/bot",
    operationId: "switchSessionBot",
    summary:
      "Run the session as a bot from here on, or as no bot with `slug: null`. The agent is rebuilt over the same history with the bot's prompt, tools and permission overrides; the switch waits for an idle session.",
    authenticated: true,
    requestBody: slugOrNullBody,
    responses: {
      "200": "The session's bot binding.",
      "400": "The body is not `{ slug: string | null }`.",
      "404": "No session has that id, or no bot has that name.",
      "409": "A turn is running.",
    },
  },
  {
    method: "GET",
    path: "/workspaces",
    operationId: "listWorkspaces",
    summary:
      "The default workspace and every named workspace over the same root: slug (`undefined` for the default), name, whether it is declared, whether it is the one being served, memory file count, focus dirs, and session facts.",
    authenticated: true,
    responses: { "200": "The workspaces." },
  },
  {
    method: "POST",
    path: "/workspaces",
    operationId: "createWorkspace",
    summary:
      "Declare a named workspace at `.keywork/workspaces/<slug>/` with its own vault. The served workspace does not change; POST /workspaces/use picks one to open next.",
    authenticated: true,
    requestBody: newWorkspaceBody,
    responses: {
      "201": "The workspace is declared.",
      "400": "The slug is not lowercase letters, digits and inner hyphens.",
      "409": "A workspace with that slug already exists.",
    },
  },
  {
    method: "POST",
    path: "/workspaces/use",
    operationId: "useWorkspace",
    summary:
      "Remember which workspace the next launch from this directory opens (`slug: null` for the default). A workspace is a separate identity and therefore a separate server, so this answers `reopens: true` and the client restarts `keywork serve` with that slug, the way the terminal shuts down and reopens.",
    authenticated: true,
    requestBody: slugOrNullBody,
    responses: {
      "200": "The choice is remembered; restart to open it.",
      "400": "The body is not `{ slug: string | null }`.",
      "404": "No workspace has that slug.",
    },
  },
  {
    method: "POST",
    path: "/workspaces/{slug}/focus",
    operationId: "focusWorkspaceDir",
    summary:
      "Add a focus dir (a subtree of the root, which retrieval and the sessions overview bias to) to the workspace named by `slug` (`default` for the default workspace). Focus dirs never widen the tool jail; linking a context dir stays a terminal affair.",
    authenticated: true,
    requestBody: dirBody,
    responses: {
      "200": "The focus dir as recorded, relative to the root.",
      "400": "`dir` is not a directory inside the root, or is already a focus dir.",
      "404": "No workspace has that slug, or it is not declared yet.",
    },
  },
  {
    method: "POST",
    path: "/workspaces/{slug}/unfocus",
    operationId: "unfocusWorkspaceDir",
    summary:
      "Remove a focus dir from the workspace named by `slug` (`default` for the default workspace).",
    authenticated: true,
    requestBody: dirBody,
    responses: {
      "200": "The focus dir is removed.",
      "400": "`dir` is not a focus dir of that workspace.",
      "404": "No workspace has that slug, or it is not declared yet.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const statusFamily = {
  routes: statusRoutes,
  handlers: ({ host }) => ({
    listMcpServers: async () => json(200, { servers: await host.mcpServers() }),
    restartMcpServer: async (_request, { name }) =>
      json(200, await host.restartMcpServer(name ?? "")),
    setMcpServerEnabled: async (request, { name }) => {
      const enabled = fieldsOf<{ enabled: unknown }>(await bodyOf(request))?.enabled;
      if (typeof enabled !== "boolean") {
        return json(400, { error: "the body must be { enabled: boolean }" });
      }
      return json(200, await host.setMcpServerEnabled(name ?? "", enabled));
    },
    listMcpServerTools: async (_request, { name }) =>
      json(200, { tools: await host.mcpServerTools(name ?? "") }),
    listArcs: async () => json(200, await host.arcs()),
    createArc: async (request) => {
      const requested = fieldsOf<{ slug: unknown }>(await bodyOf(request))?.slug;
      if (requested !== undefined && nonBlank(requested) === undefined) {
        return json(400, { error: "the body must be {} or { slug: string }" });
      }
      return json(201, await host.createArc(nonBlank(requested)));
    },
    closeArc: async (request, { slug }) => {
      const direction = nonBlank(
        fieldsOf<{ direction: unknown }>(await bodyOf(request))?.direction,
      );
      return json(200, await host.closeArc(slug ?? "", direction));
    },
    abandonArc: async (_request, { slug }) => {
      await host.abandonArc(slug ?? "");
      return json(200, { slug, abandoned: true });
    },
    bindSessionArc: async (request, { id }) => {
      const slug = slugOrNullOf(fieldsOf<{ slug: unknown }>(await bodyOf(request))?.slug);
      if (slug === undefined)
        return json(400, { error: "the body must be { slug: string | null }" });
      const outcome = await host.bindArc(id ?? "", slug);
      return outcome === "missing" ? missingSession() : json(200, { sessionId: id, arc: slug });
    },
    listBots: async () => json(200, { bots: await host.bots() }),
    createBot: async (request) => {
      const draft = botDraftOf(await bodyOf(request));
      if (draft === undefined) {
        return json(400, {
          error: 'the body must be { slug, scope: "project" | "user", purpose? }',
        });
      }
      return json(201, await host.createBot(draft));
    },
    switchSessionBot: async (request, { id }) => {
      const slug = slugOrNullOf(fieldsOf<{ slug: unknown }>(await bodyOf(request))?.slug);
      if (slug === undefined)
        return json(400, { error: "the body must be { slug: string | null }" });
      const outcome = await host.switchBot(id ?? "", slug);
      if (outcome === "missing") return missingSession();
      if (outcome === "busy") return json(409, { error: "a turn is running" });
      return json(200, { sessionId: id, bot: slug });
    },
    listWorkspaces: async () => json(200, { workspaces: await host.workspaces() }),
    createWorkspace: async (request) => {
      const slug = nonBlank(fieldsOf<{ slug: unknown }>(await bodyOf(request))?.slug);
      if (slug === undefined) return json(400, { error: "the body must be { slug: string }" });
      await host.createWorkspace(slug);
      return json(201, { slug });
    },
    useWorkspace: async (request) => {
      const slug = slugOrNullOf(fieldsOf<{ slug: unknown }>(await bodyOf(request))?.slug);
      if (slug === undefined)
        return json(400, { error: "the body must be { slug: string | null }" });
      await host.useWorkspace(slug);
      return json(200, { slug, reopens: true });
    },
    focusWorkspaceDir: async (request, { slug }) => {
      const dir = nonBlank(fieldsOf<{ dir: unknown }>(await bodyOf(request))?.dir);
      if (dir === undefined) return json(400, { error: "the body must be { dir: string }" });
      const focused = await host.focusWorkspace(workspaceSlugParam(slug), dir);
      return json(200, { dir: focused });
    },
    unfocusWorkspaceDir: async (request, { slug }) => {
      const dir = nonBlank(fieldsOf<{ dir: unknown }>(await bodyOf(request))?.dir);
      if (dir === undefined) return json(400, { error: "the body must be { dir: string }" });
      await host.unfocusWorkspace(workspaceSlugParam(slug), dir);
      return json(200, { dir });
    },
  }),
} satisfies RouteFamily<typeof statusRoutes>;

function botDraftOf(body: unknown): BotDraft | undefined {
  const fields = fieldsOf<{ slug: unknown; scope: unknown; purpose: unknown }>(body);
  const slug = nonBlank(fields?.slug);
  const scope = fields?.scope;
  if (slug === undefined || (scope !== "project" && scope !== "user")) return undefined;
  if (fields?.purpose !== undefined && nonBlank(fields.purpose) === undefined) return undefined;
  const purpose = nonBlank(fields?.purpose);
  return { slug, scope, ...(purpose !== undefined && { purpose }) };
}
