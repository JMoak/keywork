import { eventStreamResponse } from "../sse.ts";
import type { RouteFamily, RouteSpec } from "./family.ts";

export const eventRoutes = [
  {
    method: "GET",
    path: "/events",
    operationId: "streamEvents",
    summary:
      "Server-sent events: every bus envelope as `event: <type>` plus `data: <envelope json>`. Send `Last-Event-ID` to resume from a retained id (0 replays everything still retained); without it the stream starts live.",
    authenticated: true,
    responses: { "200": "An open text/event-stream." },
  },
] as const satisfies readonly RouteSpec[];

export const eventFamily = {
  routes: eventRoutes,
  handlers: (context) => ({
    streamEvents: async (request) => eventStreamResponse(context.log, request, context.streams),
  }),
} satisfies RouteFamily<typeof eventRoutes>;
