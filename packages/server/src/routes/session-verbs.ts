import { type EffortLevel, effortLevels, isEffortLevel } from "@keywork/engine";
import type { ExportRequest } from "../host.ts";
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

const modelBody: JsonSchema = {
  type: "object",
  required: ["reference"],
  properties: { reference: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const thinkingBody: JsonSchema = {
  type: "object",
  required: ["on"],
  properties: { on: { type: "boolean" } },
  additionalProperties: false,
};

const effortBody: JsonSchema = {
  type: "object",
  required: ["level"],
  properties: { level: { type: ["string", "null"], enum: [...effortLevels, null] } },
  additionalProperties: false,
};

const compactBody: JsonSchema = {
  type: "object",
  properties: { focus: { type: "string" } },
  additionalProperties: false,
};

const exportBody: JsonSchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["path", "tree"], default: "path" },
    out: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const renameBody: JsonSchema = {
  type: "object",
  required: ["title"],
  properties: { title: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const turnRunning = "a turn is running";

export const sessionVerbRoutes = [
  {
    method: "POST",
    path: "/sessions/{id}/model",
    operationId: "setSessionModel",
    summary:
      "Switch the session to another model. `reference` is `provider/model` or a bare model name that one configured provider knows. The session keeps its history and queue; the change is recorded in the session file, and `session.state` announces it.",
    authenticated: true,
    requestBody: modelBody,
    responses: {
      "200": "The model now in force, as `{ model: { provider, model }, notice }`.",
      "400":
        "The body is not `{ reference }`, or the reference did not resolve: `failure.code` says why.",
      "404": "No session has that id.",
      "409": "A turn is running; finish or abort it first.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/thinking",
    operationId: "setSessionThinking",
    summary:
      "Ask the model to show its reasoning on the next turns (`on: true`) or to keep it hidden. Recorded in the session file; `session.state` announces it.",
    authenticated: true,
    requestBody: thinkingBody,
    responses: {
      "200": "The thinking switch now in force.",
      "400": "The body is not `{ on: boolean }`.",
      "404": "No session has that id.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/effort",
    operationId: "setSessionEffort",
    summary:
      "Set how much work each reply gets: one of `low`, `medium`, `high`, `xhigh`, `max`, or `null` to return to the provider's default. Recorded in the session file; `session.state` announces it.",
    authenticated: true,
    requestBody: effortBody,
    responses: {
      "200": "The effort level now in force, `null` when the provider decides.",
      "400": "The body is not `{ level }` with a known level or null.",
      "404": "No session has that id.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/compact",
    operationId: "compactSession",
    summary:
      "Fold the older part of the conversation into a summary so the context shrinks. `focus` tells the summarizer what to keep in view. The answer carries the compaction entry when one was written and the notices a terminal user would have read.",
    authenticated: true,
    requestBody: compactBody,
    responses: {
      "200": "`{ compacted, notices }`; `compacted` is null when there was nothing to fold.",
      "400": "The body is not `{ focus?: string }`.",
      "404": "No session has that id.",
      "409": "A turn is running; finish or abort it first.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/undo",
    operationId: "undoSessionPrompt",
    summary:
      "Take back the last prompt and its turn: the transcript rewinds to just before the prompt, files the turn changed are put back from the checkpoint taken before it, and the prompt text comes back so a client can offer it for editing. One undo stays staged until the next prompt or a redo; when no prompt is on the path but a file checkpoint is, only the files travel.",
    authenticated: true,
    responses: {
      "200": "`{ prompt: { entryId, text } | null, filesNote, undoable, redoable }`.",
      "404": "No session has that id, or there is nothing to undo.",
      "409": "A turn is running, or an undo is already staged.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/redo",
    operationId: "redoSessionPrompt",
    summary:
      "Bring back what the last undo took: the transcript and the files. Without a staged undo, redo travels one file checkpoint forward when there is one.",
    authenticated: true,
    responses: {
      "200": "`{ restored: true, undoable, redoable }`.",
      "404": "No session has that id, or there is nothing to redo.",
      "409": "A turn is running; finish or abort it first.",
    },
  },
  {
    method: "GET",
    path: "/sessions/{id}/context",
    operationId: "readSessionContext",
    summary:
      "How full the model's context is: `used` and `window` in tokens, `flushAt` and `compactAt` thresholds, `fullness` as a 0 to 1 share of the compaction point, `flushDue` and `compactionDue`, and `declared` when the window comes from the model's configuration rather than an assumption. Always `basis: \"estimated\"`: the count is derived from the conversation text.",
    authenticated: true,
    responses: { "200": "The context reading.", "404": "No session has that id." },
  },
  {
    method: "GET",
    path: "/sessions/{id}/cost",
    operationId: "readSessionCost",
    summary:
      "Tokens and spend for this session in this server process: `usage` and `rollup` summed over every model the session ran on, `basis` saying whether the figure was metered by the provider or estimated from list rates, the last `cacheMiss` when the provider reported one, and `models` with one row per model reference.",
    authenticated: true,
    responses: { "200": "The cost report.", "404": "No session has that id." },
  },
  {
    method: "POST",
    path: "/sessions/{id}/export",
    operationId: "exportSession",
    summary:
      "Render the session as a self-contained HTML page. `scope` is `path` (the active branch, the default) or `tree` (every branch). Without `out` the page is the response body; with `out` (a file or directory inside the workspace) the page is written there and its path returned.",
    authenticated: true,
    requestBody: exportBody,
    responses: {
      "200": "The HTML page, as `text/html`.",
      "201": "`{ file }`: the page was written to that path.",
      "400": "The body is not `{ scope?, out? }`.",
      "403": "`out` escapes the workspace scope.",
      "404": "No session has that id.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/rename",
    operationId: "renameSession",
    summary:
      "Give the session a title. A title set this way is kept: the automatic titler never replaces a name the session already has.",
    authenticated: true,
    requestBody: renameBody,
    responses: {
      "200": "The title now in force.",
      "400": "The body is not `{ title }` with a non-blank title.",
      "404": "No session has that id.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const sessionVerbFamily = {
  routes: sessionVerbRoutes,
  handlers: ({ host }) => ({
    setSessionModel: async (request, { id }) => {
      const reference = nonBlank(
        fieldsOf<{ reference: unknown }>(await bodyOf(request))?.reference,
      );
      if (reference === undefined)
        return json(400, { error: "the body must be { reference: string }" });
      const outcome = await host.setModel(id ?? "", reference);
      if (outcome === "missing") return missingSession();
      if (outcome === "busy") return json(409, { error: turnRunning });
      if (!outcome.ok)
        return json(400, { error: outcome.failure.message, failure: outcome.failure });
      return json(200, { model: outcome.model, notice: outcome.notice });
    },
    setSessionThinking: async (request, { id }) => {
      const on = fieldsOf<{ on: unknown }>(await bodyOf(request))?.on;
      if (typeof on !== "boolean") return json(400, { error: "the body must be { on: boolean }" });
      const outcome = await host.setThinking(id ?? "", on);
      return outcome === "missing" ? missingSession() : json(200, outcome);
    },
    setSessionEffort: async (request, { id }) => {
      const level = effortOf(await bodyOf(request));
      if (level === undefined) {
        return json(400, {
          error: `the body must be { level: ${effortLevels.map((word) => `"${word}"`).join(" | ")} | null }`,
        });
      }
      const outcome = await host.setEffort(id ?? "", level);
      return outcome === "missing" ? missingSession() : json(200, outcome);
    },
    compactSession: async (request, { id }) => {
      const body = await bodyOf(request);
      const fields = fieldsOf<{ focus: unknown }>(body ?? {});
      if (
        fields === undefined ||
        (fields.focus !== undefined && typeof fields.focus !== "string")
      ) {
        return json(400, { error: "the body must be { focus?: string }" });
      }
      const outcome = await host.compact(id ?? "", nonBlank(fields.focus));
      if (outcome === "missing") return missingSession();
      if (outcome === "busy") return json(409, { error: turnRunning });
      return json(200, outcome);
    },
    undoSessionPrompt: async (_request, { id }) => {
      const outcome = await host.undo(id ?? "");
      if (outcome === "missing") return missingSession();
      if (outcome === "busy") return json(409, { error: turnRunning });
      if (outcome === "staged") {
        return json(409, {
          error: "already undone · send a prompt to keep it, or redo to bring it back",
        });
      }
      if (outcome === "nothing") return json(404, { error: "nothing to undo" });
      return json(200, outcome);
    },
    redoSessionPrompt: async (_request, { id }) => {
      const outcome = await host.redo(id ?? "");
      if (outcome === "missing") return missingSession();
      if (outcome === "busy") return json(409, { error: turnRunning });
      if (outcome === "nothing") return json(404, { error: "nothing to redo" });
      return json(200, outcome);
    },
    readSessionContext: async (_request, { id }) => {
      const outcome = await host.context(id ?? "");
      return outcome === "missing" ? missingSession() : json(200, outcome);
    },
    readSessionCost: async (_request, { id }) => {
      const outcome = await host.cost(id ?? "");
      return outcome === "missing" ? missingSession() : json(200, outcome);
    },
    exportSession: async (request, { id }) => {
      const exportRequest = exportRequestOf(await bodyOf(request));
      if (exportRequest === undefined) {
        return json(400, { error: 'the body must be { scope?: "path" | "tree", out?: string }' });
      }
      const outcome = await host.export(id ?? "", exportRequest);
      if (outcome === "missing") return missingSession();
      if ("refused" in outcome) return json(403, { error: outcome.refused });
      if ("file" in outcome) return json(201, outcome);
      return new Response(outcome.html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    },
    renameSession: async (request, { id }) => {
      const title = nonBlank(fieldsOf<{ title: unknown }>(await bodyOf(request))?.title);
      if (title === undefined) return json(400, { error: "the body must be { title: string }" });
      const outcome = await host.rename(id ?? "", title.trim());
      return outcome === "missing" ? missingSession() : json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof sessionVerbRoutes>;

function effortOf(body: unknown): EffortLevel | null | undefined {
  const fields = fieldsOf<{ level: unknown }>(body);
  if (fields === undefined || !("level" in fields)) return undefined;
  const { level } = fields;
  if (level === null) return null;
  return typeof level === "string" && isEffortLevel(level) ? level : undefined;
}

function exportRequestOf(body: unknown): ExportRequest | undefined {
  const fields = fieldsOf<{ scope: unknown; out: unknown }>(body ?? {});
  if (fields === undefined) return undefined;
  const scope = fields.scope ?? "path";
  if (scope !== "path" && scope !== "tree") return undefined;
  if (fields.out === undefined) return { scope };
  const out = nonBlank(fields.out);
  return out === undefined ? undefined : { scope, out };
}
