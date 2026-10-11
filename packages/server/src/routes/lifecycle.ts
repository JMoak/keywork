import type { EventLog } from "../events.ts";
import type { SessionLifecyclePort } from "../host.ts";
import { servedBy } from "./answers.ts";
import { json, missingSession, type RouteFamily, type RouteSpec } from "./family.ts";

export const lifecycleRoutes = [
  {
    method: "DELETE",
    path: "/sessions/{id}",
    operationId: "removeSession",
    summary:
      "Move a session to the trash: its log and spilled tool output leave the session directory together, so `GET /sessions` stops listing it at once, and `POST /trash/{id}/restore` brings it back whole. An open idle session is closed first; a session with a running turn is refused. Memory notes the session wrote stay (they carry its id as `origin_session`), and forks keep pointing at it: `GET /sessions/{fork}` then reports `forkedFrom.removed`. Fires `session.removed`.",
    authenticated: true,
    responses: {
      "200": "The removed session's summary.",
      "404": "No session has that id.",
      "409": "A turn is running.",
      "503": "This host serves no trash.",
    },
  },
  {
    method: "GET",
    path: "/trash",
    operationId: "listTrash",
    summary:
      "Sessions in the trash, newest first, summarized exactly as `GET /sessions` summarizes a live one.",
    authenticated: true,
    responses: { "200": "The trashed sessions.", "503": "This host serves no trash." },
  },
  {
    method: "POST",
    path: "/trash/{id}/restore",
    operationId: "restoreSession",
    summary:
      "Move a trashed session back into the session directory, log and spills together. It lists again at once. Fires `session.restored`.",
    authenticated: true,
    responses: {
      "201": "The restored session's summary.",
      "404": "Nothing in the trash has that id.",
      "503": "This host serves no trash.",
    },
  },
  {
    method: "DELETE",
    path: "/trash/{id}",
    operationId: "discardTrashedSession",
    summary: "Delete one trashed session for good. There is no undo.",
    authenticated: true,
    responses: {
      "200": "The session was deleted.",
      "404": "Nothing in the trash has that id.",
      "503": "This host serves no trash.",
    },
  },
  {
    method: "DELETE",
    path: "/trash",
    operationId: "purgeTrash",
    summary: "Empty the trash. `purged` counts the sessions deleted. There is no undo.",
    authenticated: true,
    responses: { "200": "The trash is empty.", "503": "This host serves no trash." },
  },
] as const satisfies readonly RouteSpec[];

export const lifecycleFamily = {
  routes: lifecycleRoutes,
  handlers: ({ host, log }) => {
    const trash = servedBy((): SessionLifecyclePort | undefined => host.lifecycle, "the trash");
    return {
      removeSession: trash(async (port, _request, { id }) => {
        const outcome = await port.remove(id ?? "");
        if (outcome === "missing") return missingSession();
        if (outcome === "busy") return json(409, { error: "a turn is running" });
        sessionRemoved(log, outcome.id);
        return json(200, outcome);
      }),
      listTrash: trash(async (port) => json(200, { sessions: await port.trash() })),
      restoreSession: trash(async (port, _request, { id }) => {
        const restored = await port.restore(id ?? "");
        if (restored === undefined) return nothingTrashed();
        sessionRestored(log, restored.id);
        return json(201, restored);
      }),
      discardTrashedSession: trash(async (port, _request, { id }) => {
        const discarded = await port.discard(id ?? "");
        return discarded === undefined
          ? nothingTrashed()
          : json(200, { sessionId: discarded.id, discarded: true });
      }),
      purgeTrash: trash(async (port) => json(200, { purged: await port.purge() })),
    };
  },
} satisfies RouteFamily<typeof lifecycleRoutes>;

export function sessionRemoved(log: EventLog, sessionId: string): void {
  log.record("", "session.removed", { sessionId });
}

export function sessionRestored(log: EventLog, sessionId: string): void {
  log.record("", "session.restored", { sessionId });
}

function nothingTrashed(): Response {
  return json(404, { error: "nothing in the trash has that id" });
}
