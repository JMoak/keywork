import { surfaceChanged } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const quietBody: JsonSchema = {
  type: "object",
  required: ["on"],
  properties: { on: { type: "boolean" } },
  additionalProperties: false,
};

export const quietRoutes = [
  {
    method: "POST",
    path: "/sessions/{id}/quiet",
    operationId: "setSessionQuiet",
    summary:
      'Let a session run without a person at the keyboard for what a `session` answer already covers. While quiet is on, the gate grants a call itself when a `session` answer to its ask would record rules, none of them a blanket `<program> *` and no part of the command destructive (a delete, `git branch -D`, a force push, `git reset --hard`, `git clean`, a discarding checkout). Those rules join the session\'s grants and the decision reads `gate.permission` with `gate: "quiet"` and `scope: "session"`, so no client mistakes it for a person\'s answer; no `gate.ask` fires for it. Everything else still asks: `write` and `edit`, a call a grant could not remember, blanket and destructive commands, and the write-capable forms the trusted reads hold back. Turning quiet off revokes nothing it granted. The posture is written to the session log as a `quiet` entry, so a reopened session keeps it; `session.state` carries it as `quiet`, `GET /permissions` lists quiet sessions under `quiet`, and `surface.changed` with `kind: "permissions"` fires when it moves. `keywork run` and every other headless gate never go quiet.',
    authenticated: true,
    requestBody: quietBody,
    responses: {
      "200": "`{ quiet }`.",
      "400": "The body is not `{ on: boolean }`.",
      "404": "No session has that id.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const quietFamily = {
  routes: quietRoutes,
  handlers: ({ host, log }) => ({
    setSessionQuiet: async (request, { id }) => {
      const on = fieldsOf<{ on: unknown }>(await bodyOf(request))?.on;
      if (typeof on !== "boolean") return json(400, { error: "the body must be { on: boolean }" });
      const sessionId = id ?? "";
      const wasQuiet = (await host.permissions()).quiet.includes(sessionId);
      const outcome = await host.setQuiet(sessionId, on);
      if (outcome === "missing") return missingSession();
      if (wasQuiet !== on) surfaceChanged(log, "permissions");
      return json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof quietRoutes>;
