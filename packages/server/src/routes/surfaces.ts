import type { McpServerStatus } from "@keywork/engine";
import { slugProblem } from "@keywork/shared";
import type {
  ArcSummary,
  ArcsPort,
  BotDraft,
  BotScope,
  BotsPort,
  McpPort,
  WorkspacesPort,
} from "../host.ts";
import { servedBy, surfaceChanged } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const enabledBody: JsonSchema = {
  type: "object",
  required: ["on"],
  properties: { on: { type: "boolean" } },
  additionalProperties: false,
};

const slugBody: JsonSchema = {
  type: "object",
  required: ["slug"],
  properties: { slug: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const closeBody: JsonSchema = {
  type: "object",
  properties: { direction: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const arcBindingBody: JsonSchema = {
  type: "object",
  required: ["slug"],
  properties: { slug: { type: ["string", "null"] } },
  additionalProperties: false,
};

const botBindingBody: JsonSchema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: ["string", "null"] } },
  additionalProperties: false,
};

const botScopes = ["project", "user"] as const satisfies readonly BotScope[];

const botBody: JsonSchema = {
  type: "object",
  required: ["slug", "scope"],
  properties: {
    slug: { type: "string", minLength: 1 },
    scope: { type: "string", enum: [...botScopes] },
    purpose: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const useBody: JsonSchema = {
  type: "object",
  required: ["slug"],
  properties: { slug: { type: ["string", "null"] } },
  additionalProperties: false,
};

const dirBody: JsonSchema = {
  type: "object",
  required: ["dir"],
  properties: { dir: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const defaultWorkspaceWord = "default";

export const surfaceRoutes = [
  {
    method: "GET",
    path: "/mcp",
    operationId: "listMcpServers",
    summary:
      'Every configured MCP server (a tool provider the agent can call) with its live status: `state` is `connected`, `connecting` or `down`, `enabled` is the user\'s switch, `toolCount` is how many tools it currently offers, `transport` is `stdio` or `http`, and `lastError` says why it is down when it is. `surface.changed` with `kind: "mcp"` fires whenever any of this changes. An empty list means no servers are configured.',
    authenticated: true,
    responses: { "200": "The servers.", "503": "This host serves no MCP registry." },
  },
  {
    method: "POST",
    path: "/mcp/{name}/restart",
    operationId: "restartMcpServer",
    summary:
      "Drop the server's connection and open a fresh one, re-enabling it if it was off. Answers once the server has settled, with its new status.",
    authenticated: true,
    responses: {
      "200": "The server's status after the restart.",
      "404": "No MCP server has that name.",
      "503": "The registry is stopping, or this host serves none.",
    },
  },
  {
    method: "POST",
    path: "/mcp/{name}/enabled",
    operationId: "setMcpServerEnabled",
    summary:
      "Switch a server on or off. Off disconnects it and withdraws its tools until it is switched on again; on reconnects it. Answers once the server has settled.",
    authenticated: true,
    requestBody: enabledBody,
    responses: {
      "200": "The server's status after the switch.",
      "400": "The body is not `{ on: boolean }`.",
      "404": "No MCP server has that name.",
      "503": "The registry is stopping, or this host serves none.",
    },
  },
  {
    method: "GET",
    path: "/mcp/{name}/tools",
    operationId: "listMcpServerTools",
    summary: "The names of the tools a server currently offers; empty while it is down.",
    authenticated: true,
    responses: {
      "200": "The tool names.",
      "404": "No MCP server has that name.",
      "503": "This host serves no MCP registry.",
    },
  },
  {
    method: "GET",
    path: "/arcs",
    operationId: "listArcs",
    summary:
      "Every arc in the workspace: a named stretch of work that sessions bind to and that keeps its own memory layer until it closes. Each arc carries its `slug`, `status` (`active` or `archived`), `created` time and how many `sessions` are bound to it. `ordinals` numbers the arcs by creation order so a client can give each a stable colour. Arcs need a trusted workspace with memory.",
    authenticated: true,
    responses: {
      "200": "The arcs and their ordinals.",
      "403": "The workspace is untrusted, so there are no arcs.",
      "503": "This host serves no arcs.",
    },
  },
  {
    method: "POST",
    path: "/arcs",
    operationId: "createArc",
    summary:
      'Open a new active arc named by `slug` (lowercase letters, digits and single hyphens). Fires `surface.changed` with `kind: "arcs"`.',
    authenticated: true,
    requestBody: slugBody,
    responses: {
      "201": "The new arc.",
      "400": "The body is not `{ slug }` or the slug is not valid.",
      "403": "The workspace is untrusted.",
      "409": "An arc with that slug already exists.",
      "503": "This host serves no arcs.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/close",
    operationId: "closeArc",
    summary:
      'Close an arc: its live sessions are swept for memory, and its notes and open questions are distilled for review. `kind: "closed"` means it closed at once, delivering `delivered` notes and releasing `released` sessions; `kind: "pending"` means `candidates` notes and `questions` are waiting at the airlock (see `GET /arcs/{slug}/airlock`) and the arc stays open until they are decided. `direction` is an optional sentence steering what the close should keep.',
    authenticated: true,
    requestBody: closeBody,
    responses: {
      "200": "The close outcome.",
      "403": "The workspace is untrusted.",
      "404": "No arc has that slug.",
      "409": "The arc is not active.",
      "503": "This host serves no arcs.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/abandon",
    operationId: "abandonArc",
    summary:
      'Archive an arc without distilling anything: its sessions are released and its layer is kept only as an archive. Fires `surface.changed` with `kind: "arcs"`.',
    authenticated: true,
    responses: {
      "200": "The arc was abandoned.",
      "403": "The workspace is untrusted.",
      "404": "No arc has that slug.",
      "503": "This host serves no arcs.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/arc",
    operationId: "bindSessionArc",
    summary:
      "Bind a session to an arc, or release it with `slug: null`. The binding is recorded in the session's log and answers as the session's whole binding (`arc`, `bot`). From then on the session's memory writes go to the arc's layer and its recall searches that layer first.",
    authenticated: true,
    requestBody: arcBindingBody,
    responses: {
      "200": "The session's binding after the change.",
      "400": "The body is not `{ slug: string | null }` or the slug is not valid.",
      "404": "No session has that id.",
      "503": "This host serves no arcs.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/bot",
    operationId: "bindSessionBot",
    summary:
      "Have a session run as a bot (a named role with its own prompt, tool allowance and memory layer), or as no bot with `name: null`. Refused while a turn is running, because the running agent cannot be swapped mid-turn. Answers as the session's whole binding (`arc`, `bot`).",
    authenticated: true,
    requestBody: botBindingBody,
    responses: {
      "200": "The session's binding after the change.",
      "400": "The body is not `{ name: string | null }` or the name is not valid.",
      "404": "No session has that id.",
      "409": "A turn is running.",
      "503": "This host serves no bots.",
    },
  },
  {
    method: "GET",
    path: "/bots",
    operationId: "listBots",
    summary:
      "Every bot defined for this workspace and this user: its `name`, display `sigil`, where it was defined (`source` is `project` or `user`), its `description`, the `model` it prefers and its `learning` policy, plus how many `sessions` have run as it, when it was `lastUsed` and what those sessions cost when known.",
    authenticated: true,
    responses: { "200": "The bots.", "503": "This host serves no bots." },
  },
  {
    method: "POST",
    path: "/bots",
    operationId: "createBot",
    summary:
      'Define a new bot: writes `.keywork/bots/<slug>/bot.md` in the workspace (`scope: "project"`, needs a trusted workspace) or under the user\'s home (`scope: "user"`), with `purpose` as its description. Fires `surface.changed` with `kind: "bots"`.',
    authenticated: true,
    requestBody: botBody,
    responses: {
      "201": "The new bot's definition.",
      "400": "The body is not `{ slug, scope, purpose? }` or the slug is not valid.",
      "403": "A project bot was asked for in an untrusted workspace.",
      "409": "A bot with that name already exists.",
      "503": "This host serves no bots.",
    },
  },
  {
    method: "GET",
    path: "/workspaces",
    operationId: "listWorkspaces",
    summary:
      "The workspaces that share this root: the default one (no `slug`) and every named one under `.keywork/workspaces/<slug>/`. Each says whether it is `declared` (set up on disk), whether it is the `current` one this server runs, how many memory `notes` it holds, its `focusDirs`, how many `sessions` it has and when it was `lastUsed` (epoch milliseconds).",
    authenticated: true,
    responses: { "200": "The workspaces.", "503": "This host serves no workspaces." },
  },
  {
    method: "POST",
    path: "/workspaces",
    operationId: "createWorkspace",
    summary:
      'Create a named workspace over this root: a separate declaration and memory vault under `.keywork/workspaces/<slug>/`. The new workspace is not opened; `POST /workspaces/use` does that. Fires `surface.changed` with `kind: "workspaces"`.',
    authenticated: true,
    requestBody: slugBody,
    responses: {
      "201": "The workspace was created.",
      "400":
        "The body is not `{ slug }`, the slug is not valid, or it is the reserved word `default`.",
      "409": "A workspace with that slug already exists.",
      "503": "This host serves no workspaces.",
    },
  },
  {
    method: "POST",
    path: "/workspaces/use",
    operationId: "useWorkspace",
    summary:
      "Choose the workspace the next launch from this directory opens: a named one by `slug`, or the default with `slug: null`. A workspace is a separate identity with its own sessions and memory, so the running server cannot switch in place: `reopens: true` says a client that owns the server process must restart it, which then opens the chosen workspace.",
    authenticated: true,
    requestBody: useBody,
    responses: {
      "200": "The choice was remembered.",
      "400": "The body is not `{ slug: string | null }`.",
      "409": "No workspace has that slug.",
      "503": "This host serves no workspaces.",
    },
  },
  {
    method: "POST",
    path: "/workspaces/{slug}/focus",
    operationId: "focusWorkspaceDir",
    summary:
      'Add a focus dir to a workspace (`default` names the default workspace): a subtree of the root the workspace is about, which memory recall and the sessions overview lean toward. `dir` is relative to the root or absolute and must be inside it; nothing here widens what the agent\'s tools may touch. Answers the dir as recorded. Fires `surface.changed` with `kind: "workspaces"`.',
    authenticated: true,
    requestBody: dirBody,
    responses: {
      "200": "The focus dir as recorded.",
      "400": "The body is not `{ dir }`.",
      "409":
        "The dir is not a directory, lies outside the root, is the root itself, or is already a focus dir; or the workspace is not declared.",
      "503": "This host serves no workspaces.",
    },
  },
  {
    method: "POST",
    path: "/workspaces/{slug}/unfocus",
    operationId: "unfocusWorkspaceDir",
    summary:
      'Remove a focus dir from a workspace (`default` names the default workspace); `dir` is the value `GET /workspaces` lists. Fires `surface.changed` with `kind: "workspaces"`.',
    authenticated: true,
    requestBody: dirBody,
    responses: {
      "200": "The focus dir was removed.",
      "400": "The body is not `{ dir }`.",
      "409": "That dir is not a focus dir of the workspace, or the workspace is not declared.",
      "503": "This host serves no workspaces.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const surfaceFamily = {
  routes: surfaceRoutes,
  handlers: ({ host, log, streams }) => {
    const mcp = servedBy((): McpPort | undefined => host.mcp, "the MCP registry");
    const arcs = servedBy((): ArcsPort | undefined => host.arcs, "arcs");
    const bots = servedBy((): BotsPort | undefined => host.bots, "bots");
    const workspaces = servedBy((): WorkspacesPort | undefined => host.workspaces, "workspaces");
    followFeeds({ mcp: host.mcp, arcs: host.arcs }, streams, (kind) => surfaceChanged(log, kind));
    return {
      listMcpServers: mcp(async (port) => json(200, { servers: await port.status() })),
      restartMcpServer: mcp(async (port, _request, { name }) => {
        await port.restart(name ?? "");
        return json(200, await statusOf(port, name ?? ""));
      }),
      setMcpServerEnabled: mcp(async (port, request, { name }) => {
        const on = fieldsOf<{ on: unknown }>(await bodyOf(request))?.on;
        if (typeof on !== "boolean")
          return json(400, { error: "the body must be { on: boolean }" });
        await port.setEnabled(name ?? "", on);
        return json(200, await statusOf(port, name ?? ""));
      }),
      listMcpServerTools: mcp(async (port, _request, { name }) =>
        json(200, { tools: await port.listTools(name ?? "") }),
      ),
      listArcs: arcs(async (port) => {
        const listed = await port.list();
        return json(200, { arcs: listed, ordinals: arcOrdinals(listed) });
      }),
      createArc: arcs(async (port, request) => {
        const slug = slugOf(await bodyOf(request));
        if (slug === undefined) return badSlug();
        return json(201, await port.create(slug));
      }),
      closeArc: arcs(async (port, request, { slug }) => {
        const direction = nonBlank(
          fieldsOf<{ direction: unknown }>(await bodyOf(request))?.direction,
        );
        return json(200, await port.close(slug ?? "", direction));
      }),
      abandonArc: arcs(async (port, _request, { slug }) => {
        await port.abandon(slug ?? "");
        return json(200, { slug, abandoned: true });
      }),
      bindSessionArc: arcs(async (port, request, { id }) => {
        const slug = optionalSlugOf(fieldsOf<{ slug: unknown }>(await bodyOf(request))?.slug);
        if (slug === undefined)
          return json(400, { error: "the body must be { slug: string | null }" });
        const binding = await port.bindSession(id ?? "", slug);
        return binding === undefined ? missingSession() : json(200, binding);
      }),
      bindSessionBot: bots(async (port, request, { id }) => {
        const name = optionalSlugOf(fieldsOf<{ name: unknown }>(await bodyOf(request))?.name);
        if (name === undefined)
          return json(400, { error: "the body must be { name: string | null }" });
        const binding = await port.bindSession(id ?? "", name);
        if (binding === undefined) return missingSession();
        surfaceChanged(log, "bots");
        return json(200, binding);
      }),
      listBots: bots(async (port) => json(200, { bots: await port.list() })),
      createBot: bots(async (port, request) => {
        const draft = botDraftOf(await bodyOf(request));
        if (draft === undefined) {
          return json(400, {
            error: 'the body must be { slug, scope: "project" | "user", purpose? }',
          });
        }
        const created = await port.create(draft);
        surfaceChanged(log, "bots");
        return json(201, created);
      }),
      listWorkspaces: workspaces(async (port) => json(200, { workspaces: await port.list() })),
      createWorkspace: workspaces(async (port, request) => {
        const slug = slugOf(await bodyOf(request));
        if (slug === undefined || slug === defaultWorkspaceWord) return badSlug();
        await port.create(slug);
        surfaceChanged(log, "workspaces");
        return json(201, { slug });
      }),
      useWorkspace: workspaces(async (port, request) => {
        const slug = optionalSlugOf(fieldsOf<{ slug: unknown }>(await bodyOf(request))?.slug);
        if (slug === undefined)
          return json(400, { error: "the body must be { slug: string | null }" });
        await port.use(slug ?? undefined);
        surfaceChanged(log, "workspaces");
        return json(200, { slug, reopens: true });
      }),
      focusWorkspaceDir: workspaces(async (port, request, { slug }) => {
        const dir = dirOf(await bodyOf(request));
        if (dir === undefined) return badDir();
        const focus = await port.linkFocusDir(workspaceSlugOf(slug), dir);
        surfaceChanged(log, "workspaces");
        return json(200, { dir: focus });
      }),
      unfocusWorkspaceDir: workspaces(async (port, request, { slug }) => {
        const dir = dirOf(await bodyOf(request));
        if (dir === undefined) return badDir();
        await port.unlinkFocusDir(workspaceSlugOf(slug), dir);
        surfaceChanged(log, "workspaces");
        return json(200, { dir });
      }),
    };
  },
} satisfies RouteFamily<typeof surfaceRoutes>;

export function arcOrdinals(arcs: readonly ArcSummary[]): Record<string, number> {
  const byCreation = [...arcs].sort(
    (left, right) =>
      left.created.localeCompare(right.created) || left.slug.localeCompare(right.slug),
  );
  return Object.fromEntries(byCreation.map((arc, ordinal) => [arc.slug, ordinal]));
}

interface Feeds {
  mcp: McpPort | undefined;
  arcs: ArcsPort | undefined;
}

function followFeeds(
  feeds: Feeds,
  streams: { add(close: () => void): () => void },
  announce: (kind: "mcp" | "arcs") => void,
): void {
  if (feeds.mcp !== undefined) streams.add(feeds.mcp.subscribe(() => announce("mcp")));
  if (feeds.arcs !== undefined) streams.add(feeds.arcs.subscribe(() => announce("arcs")));
}

async function statusOf(port: McpPort, name: string): Promise<McpServerStatus | undefined> {
  return (await port.status()).find((server) => server.name === name);
}

function slugOf(body: unknown): string | undefined {
  const slug = nonBlank(fieldsOf<{ slug: unknown }>(body)?.slug);
  return slug !== undefined && slugProblem(slug) === undefined ? slug : undefined;
}

function optionalSlugOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && slugProblem(value) === undefined ? value : undefined;
}

function workspaceSlugOf(param: string | undefined): string | undefined {
  return param === undefined || param === defaultWorkspaceWord ? undefined : param;
}

function botDraftOf(body: unknown): BotDraft | undefined {
  const fields = fieldsOf<{ slug: unknown; scope: unknown; purpose: unknown }>(body);
  const slug = nonBlank(fields?.slug);
  const scope = botScopes.find((known) => known === fields?.scope);
  const purpose = nonBlank(fields?.purpose);
  if (slug === undefined || slugProblem(slug) !== undefined || scope === undefined)
    return undefined;
  if (fields?.purpose !== undefined && purpose === undefined) return undefined;
  return { slug, scope, ...(purpose !== undefined && { purpose }) };
}

function dirOf(body: unknown): string | undefined {
  return nonBlank(fieldsOf<{ dir: unknown }>(body)?.dir);
}

function badSlug(): Response {
  return json(400, { error: "the body must be { slug } with a lowercase slug" });
}

function badDir(): Response {
  return json(400, { error: "the body must be { dir: string }" });
}
