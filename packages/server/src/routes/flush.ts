import type { Refusal } from "../host.ts";
import { json, missingSession, type RouteFamily, type RouteSpec } from "./family.ts";

export const flushRoutes = [
  {
    method: "POST",
    path: "/sessions/{id}/flush",
    operationId: "flushSessionMemory",
    summary:
      "Run the memory flush now instead of waiting for the context to reach the flush line: the session's model is asked what in this conversation is worth keeping across sessions, and what it names goes to the daily log (the bound arc's, when there is one; lines about a bot's own craft go to that bot). The flush prompt and its reply join the conversation, exactly as with the flush the settler runs after a turn. `flushed` is how many messages that added, 0 when nothing ran, and `notices` says what happened in keywork's words. A workspace that is not trusted has inert memory, so nothing is flushed there. `session.settled` with `phase: \"requested\"` follows with the same `flushed` and `notices`, then a `session.state` envelope.",
    authenticated: true,
    responses: {
      "200": "`{ flushed, notices }`.",
      "404": "No session has that id.",
      "409": "A turn is running; wait for it or abort it first.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const flushFamily = {
  routes: flushRoutes,
  handlers: ({ host }) => ({
    flushSessionMemory: async (_request, { id }) => {
      const outcome = await host.flush(id ?? "");
      return typeof outcome === "string" ? refused(outcome) : json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof flushRoutes>;

function refused(outcome: Refusal): Response {
  return outcome === "missing" ? missingSession() : json(409, { error: "a turn is running" });
}
