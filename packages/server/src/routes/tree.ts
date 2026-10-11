import type { EventLog } from "../events.ts";
import type { EntryRefusal } from "../host.ts";
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

export type TreeChangeReason = "fork" | "label" | "leaf";

export interface TreeChange {
  reason: TreeChangeReason;
  entryId: string | null;
  forkedTo?: string;
}

const forkBody: JsonSchema = {
  type: "object",
  required: ["entryId"],
  properties: { entryId: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const labelBody: JsonSchema = {
  type: "object",
  required: ["entryId", "label"],
  properties: {
    entryId: { type: "string", minLength: 1 },
    label: { type: ["string", "null"], description: "`null` removes the label." },
  },
  additionalProperties: false,
};

const leafBody: JsonSchema = {
  type: "object",
  required: ["entryId"],
  properties: {
    entryId: {
      type: ["string", "null"],
      description: "`null` moves to the empty root, before the first entry.",
    },
  },
  additionalProperties: false,
};

const missingResponse = "No session has that id.";
const missingEntryResponse = "No session has that id, or no entry in it has that id.";

export const treeRoutes = [
  {
    method: "GET",
    path: "/sessions/{id}/entries",
    operationId: "readSessionEntries",
    summary:
      "The session's whole entry log as the engine stores it, for a client that draws the conversation tree itself. `entries` is every entry in file order, each with its `id` and `parentId`; `message` entries carry their message whole, and the rest (`compaction`, `branch_summary`, `label`, `session_info`, `model_change`, `thinking_level_change`, `effort_change`, `context_edit`, `binding`, `custom`, `custom_message`) carry their own fields. `labels` maps entry ids to the label in force, `leafId` is the entry the next message will follow, and `activePath` lists the ids from the root to that leaf. Folding the flat log into a tree is the client's job (parent links suffice).",
    authenticated: true,
    responses: {
      "200": "`{ sessionId, name?, leafId, entries, labels, activePath }`.",
      "404": missingResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/fork",
    operationId: "forkSession",
    summary:
      'Start a new session from one entry of this one: the path from the root to `entryId` is copied into a fresh session whose header records the file it was forked from as `parentSession`. This session is untouched. A `session.tree` envelope with `reason: "fork"` and `forkedTo` follows on this session.',
    authenticated: true,
    requestBody: forkBody,
    responses: {
      "201": "`{ sessionId }`: the new session, readable at GET /sessions/{sessionId}.",
      "400": "The body is not `{ entryId: string }`.",
      "404": missingEntryResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/label",
    operationId: "labelSessionEntry",
    summary:
      'Name an entry so a branch is easy to find again, or pass `null` to remove the name. The label is written to the session as its own entry, so it survives a restart. A `session.tree` envelope with `reason: "label"` follows.',
    authenticated: true,
    requestBody: labelBody,
    responses: {
      "200": "`{ entryId, label }`, `label` being `null` once removed.",
      "400": "The body is not `{ entryId: string, label: string | null }`.",
      "404": missingEntryResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/leaf",
    operationId: "moveSessionLeaf",
    summary:
      "Move the session's leaf to `entryId` (or to the empty root with `null`) without forking: the next prompt continues from there, as a new branch if the entry already has children. The session's agent is rebuilt over the shorter path, the same move POST /undo makes without putting files back. Needs an idle session. A `session.tree` envelope with `reason: \"leaf\"` and a `session.state` envelope follow.",
    authenticated: true,
    requestBody: leafBody,
    responses: {
      "200": "`{ leafId }`.",
      "400": "The body is not `{ entryId: string | null }`.",
      "404": missingEntryResponse,
      "409": "A turn is running; wait for it or abort it first.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const treeFamily = {
  routes: treeRoutes,
  handlers: ({ host, log }) => ({
    readSessionEntries: async (_request, { id }) => {
      const entries = await host.tree.entries(id ?? "");
      return entries === "missing" ? missingSession() : json(200, entries);
    },
    forkSession: async (request, { id }) => {
      const entryId = nonBlank(fieldsOf<{ entryId: unknown }>(await bodyOf(request))?.entryId);
      if (entryId === undefined) {
        return json(400, { error: "the body must be { entryId: string }" });
      }
      const outcome = await host.tree.fork(id ?? "", entryId);
      if (typeof outcome === "string") return refused(outcome);
      treeChanged(log, id ?? "", { reason: "fork", entryId, forkedTo: outcome.sessionId });
      return json(201, outcome);
    },
    labelSessionEntry: async (request, { id }) => {
      const labelling = labellingOf(await bodyOf(request));
      if (labelling === undefined) {
        return json(400, { error: "the body must be { entryId: string, label: string | null }" });
      }
      const outcome = await host.tree.label(id ?? "", labelling.entryId, labelling.label);
      if (typeof outcome === "string") return refused(outcome);
      treeChanged(log, id ?? "", { reason: "label", entryId: labelling.entryId });
      return json(200, outcome);
    },
    moveSessionLeaf: async (request, { id }) => {
      const entryId = leafTargetOf(await bodyOf(request));
      if (entryId === undefined) {
        return json(400, { error: "the body must be { entryId: string | null }" });
      }
      const outcome = await host.tree.moveLeaf(id ?? "", entryId);
      if (outcome === "busy") return json(409, { error: "a turn is running" });
      if (typeof outcome === "string") return refused(outcome);
      treeChanged(log, id ?? "", { reason: "leaf", entryId });
      return json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof treeRoutes>;

function treeChanged(log: EventLog, sessionId: string, change: TreeChange): void {
  log.record(sessionId, "session.tree", change);
}

function refused(outcome: EntryRefusal): Response {
  return outcome === "missing" ? missingSession() : json(404, { error: "no entry has that id" });
}

function labellingOf(body: unknown): { entryId: string; label: string | null } | undefined {
  const fields = fieldsOf<{ entryId: unknown; label: unknown }>(body);
  const entryId = nonBlank(fields?.entryId);
  if (entryId === undefined || fields === undefined || !("label" in fields)) return undefined;
  const label = fields.label === null ? null : nonBlank(fields.label);
  return label === undefined ? undefined : { entryId, label };
}

function leafTargetOf(body: unknown): string | null | undefined {
  const fields = fieldsOf<{ entryId: unknown }>(body);
  if (fields === undefined || !("entryId" in fields)) return undefined;
  return fields.entryId === null ? null : nonBlank(fields.entryId);
}
