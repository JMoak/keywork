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

const forgetBody: JsonSchema = {
  type: "object",
  required: ["entryId"],
  properties: {
    entryId: { type: "string", minLength: 1 },
    replacement: {
      type: "string",
      minLength: 1,
      description: "What the model sees instead. Absent, the entry leaves the model's context.",
    },
  },
  additionalProperties: false,
};

const unknownEntry = "no prompt or tool result on this session's path has that id";

export const forgetRoutes = [
  {
    method: "POST",
    path: "/sessions/{id}/forget",
    operationId: "forgetSessionEntry",
    summary:
      "Take one prompt or one tool result out of what the model sees, or rewrite it, while the transcript keeps the original: what the terminal's /forget does. `entryId` names a user prompt or a tool result message on the session's active path, with the ids `GET /sessions/{id}/entries` lists. Without `replacement` the model stops seeing it; with one, the model sees that text in its place. The edit is written to the session log as a `context_edit` entry, which becomes the leaf, and the session continues over the edited context. Needs an idle session. `session.state` and `session.tree` (`reason: \"leaf\"`, naming the edit) follow.",
    authenticated: true,
    requestBody: forgetBody,
    responses: {
      "200": "`{ edit }`: the `context_edit` entry written, with its `targetId` and `replacement`.",
      "400": "The body is not `{ entryId, replacement?: string }`.",
      "404": `No session has that id, or \`{ error: "${unknownEntry}" }\`.`,
      "409": "A turn is running; wait for it or abort it first.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const forgetFamily = {
  routes: forgetRoutes,
  handlers: ({ host, log }) => ({
    forgetSessionEntry: async (request, { id }) => {
      const target = forgetTargetOf(await bodyOf(request));
      if (target === undefined) {
        return json(400, { error: "the body must be { entryId: string, replacement?: string }" });
      }
      const outcome = await host.forget(id ?? "", target.entryId, target.replacement);
      if (outcome === "missing") return missingSession();
      if (outcome === "busy") return json(409, { error: "a turn is running" });
      if (outcome === "unknown-entry") return json(404, { error: unknownEntry });
      log.record(id ?? "", "session.tree", { reason: "leaf", entryId: outcome.edit.id });
      return json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof forgetRoutes>;

function forgetTargetOf(body: unknown): { entryId: string; replacement?: string } | undefined {
  const fields = fieldsOf<{ entryId: unknown; replacement: unknown }>(body);
  const entryId = nonBlank(fields?.entryId);
  if (entryId === undefined) return undefined;
  if (fields?.replacement === undefined) return { entryId };
  const replacement = nonBlank(fields.replacement);
  return replacement === undefined ? undefined : { entryId, replacement };
}
