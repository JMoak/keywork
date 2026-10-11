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
    label: { type: ["string", "null"], minLength: 1 },
  },
  additionalProperties: false,
};

const leafBody: JsonSchema = {
  type: "object",
  required: ["entryId"],
  properties: { entryId: { type: ["string", "null"], minLength: 1 } },
  additionalProperties: false,
};

export const treeRoutes = [
  {
    method: "GET",
    path: "/sessions/{id}/entries",
    operationId: "readSessionEntries",
    summary:
      "The session's entry tree as its flat log: every entry with its `parentId`, the current `leafId`, `labels` by entry id, and `activePath` (entry ids from the root to the leaf). Fold the tree client-side by `parentId`; `message` entries carry their message whole.",
    authenticated: true,
    responses: { "200": "The entries.", "404": "No session has that id." },
  },
  {
    method: "POST",
    path: "/sessions/{id}/fork",
    operationId: "forkSession",
    summary:
      "Start a new session whose history is the path from the root to `entryId`. The new session records this one as its `parentSession`; this one is untouched.",
    authenticated: true,
    requestBody: forkBody,
    responses: {
      "201": "The new session's summary.",
      "400": "The body is not `{ entryId }`.",
      "404": "No session has that id, or no entry has that entryId.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/label",
    operationId: "labelEntry",
    summary: "Name an entry so the tree can show it; `label: null` clears the name.",
    authenticated: true,
    requestBody: labelBody,
    responses: {
      "200": "The entry's label as now recorded.",
      "400": "The body is not `{ entryId, label: string | null }`.",
      "404": "No session has that id, or no entry has that entryId.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/leaf",
    operationId: "moveLeaf",
    summary:
      "Move the session's active leaf to `entryId` (`null` for the empty root) without forking: the next prompt continues from there and the conversation is rebuilt over the shorter path. Files are not restored. Refused while a turn is running.",
    authenticated: true,
    requestBody: leafBody,
    responses: {
      "200": "The leaf now active.",
      "400": "The body is not `{ entryId: string | null }`.",
      "404": "No session has that id, or no entry has that entryId.",
      "409": "A turn is running.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const treeFamily = {
  routes: treeRoutes,
  handlers: ({ host }) => ({
    readSessionEntries: async (_request, { id }) => {
      const entries = await host.entries(id ?? "");
      return entries === undefined ? missingSession() : json(200, entries);
    },
    forkSession: async (request, { id }) => {
      const entryId = entryIdOf(await bodyOf(request));
      if (entryId === undefined)
        return json(400, { error: "the body must be { entryId: string }" });
      const outcome = await host.fork(id ?? "", entryId);
      if (outcome === "missing") return missingSession();
      if (outcome === "unknown-entry") return unknownEntry();
      return json(201, outcome);
    },
    labelEntry: async (request, { id }) => {
      const labelling = labellingOf(await bodyOf(request));
      if (labelling === undefined) {
        return json(400, { error: "the body must be { entryId: string, label: string | null }" });
      }
      const outcome = await host.label(id ?? "", labelling.entryId, labelling.label);
      if (outcome === "missing") return missingSession();
      if (outcome === "unknown-entry") return unknownEntry();
      return json(200, { entryId: labelling.entryId, label: labelling.label ?? null });
    },
    moveLeaf: async (request, { id }) => {
      const target = leafTargetOf(await bodyOf(request));
      if (target === undefined) {
        return json(400, { error: "the body must be { entryId: string | null }" });
      }
      const outcome = await host.moveLeaf(id ?? "", target);
      if (outcome === "missing") return missingSession();
      if (outcome === "unknown-entry") return unknownEntry();
      if (outcome === "busy") return json(409, { error: "a turn is running" });
      return json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof treeRoutes>;

function unknownEntry(): Response {
  return json(404, { error: "no entry has that entryId" });
}

function entryIdOf(body: unknown): string | undefined {
  return nonBlank(fieldsOf<{ entryId: unknown }>(body)?.entryId);
}

function labellingOf(body: unknown): { entryId: string; label: string | undefined } | undefined {
  const fields = fieldsOf<{ entryId: unknown; label: unknown }>(body);
  const entryId = nonBlank(fields?.entryId);
  if (entryId === undefined || fields === undefined || !("label" in fields)) return undefined;
  if (fields.label === null) return { entryId, label: undefined };
  const label = nonBlank(fields.label);
  return label === undefined ? undefined : { entryId, label };
}

function leafTargetOf(body: unknown): string | null | undefined {
  const fields = fieldsOf<{ entryId: unknown }>(body);
  if (fields === undefined || !("entryId" in fields)) return undefined;
  return fields.entryId === null ? null : nonBlank(fields.entryId);
}
